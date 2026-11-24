import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import type React from 'react';
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  ExtensionConfirmPublishedInput,
  ExtensionConfirmPublishedResult,
  ExtensionMeDto,
  ExtensionMediaAsset,
  ExtensionPendingTaskDto,
  ExtensionProviderKey,
  LocalImageUploader,
  ManifestV3Shape,
  PairingState,
  PendingTabTask,
  PlatformDraftAdapter,
  ZipEntryInfo,
} from './contract-types.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(currentDir, '../../..');

export type PublicSurfaceErrorCode =
  | 'MISSING_FILE'
  | 'LOAD_ERROR'
  | 'MISSING_CONTRACT_EXPORT'
  | 'INVALID_CONTRACT_SHAPE';

export class PublicSurfaceError extends Error {
  constructor(
    public readonly code: PublicSurfaceErrorCode,
    public readonly surfacePath: string,
    message: string,
  ) {
    super(`[PublicSurface:${code}] ${surfacePath}: ${message}`);
    this.name = 'PublicSurfaceError';
  }
}

export function resolveRepoPath(...segments: string[]): string {
  return path.resolve(REPO_ROOT, ...segments);
}

/**
 * Loads a real production module through Vitest's vite-node pipeline.
 * NEVER returns a fake/fallback implementation and NEVER skips.
 */
export async function loadPublicModule<T extends Record<string, unknown>>(
  repoRelPath: string,
): Promise<T> {
  const absPath = resolveRepoPath(repoRelPath);
  if (!fs.existsSync(absPath)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      repoRelPath,
      `Required public module file does not exist at ${absPath}`,
    );
  }
  try {
    return await vi.importActual<T>(absPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PublicSurfaceError(
      'LOAD_ERROR',
      repoRelPath,
      `Failed to import module: ${detail}`,
    );
  }
}

function listExportKeys(mod: Record<string, unknown>): string {
  return Object.keys(mod).sort().join(', ') || '(none)';
}

function findExport<T>(
  mod: Record<string, unknown>,
  surfacePath: string,
  candidateNames: readonly string[],
  predicate: (val: unknown) => val is T,
  label: string,
): T {
  for (const name of candidateNames) {
    const val = mod[name];
    if (predicate(val)) {
      return val;
    }
  }
  const lowerNames = new Set(candidateNames.map((n) => n.toLowerCase()));
  for (const [k, val] of Object.entries(mod)) {
    if (lowerNames.has(k.toLowerCase()) && predicate(val)) {
      return val;
    }
  }
  throw new PublicSurfaceError(
    'MISSING_CONTRACT_EXPORT',
    surfacePath,
    `Missing required ${label} export (checked [${candidateNames.join(', ')}]; actual exports: [${listExportKeys(mod)}])`,
  );
}

function isFunction(v: unknown): v is (...args: never[]) => unknown {
  return typeof v === 'function';
}

interface ZodLikeSchema {
  safeParse(input: unknown): {
    success: boolean;
    data?: unknown;
    error?: unknown;
  };
  parse(input: unknown): unknown;
}

function isZodSchema(v: unknown): v is ZodLikeSchema {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ZodLikeSchema).safeParse === 'function' &&
    typeof (v as ZodLikeSchema).parse === 'function'
  );
}

/**
 * Runtime errors that indicate a genuine production or harness contract bug
 * and MUST NEVER be swallowed into `null` or `{ ok: false }`.
 */
function isFatalRuntimeBug(err: unknown): boolean {
  return (
    err instanceof PublicSurfaceError ||
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError
  );
}

/**
 * Extracts top-level parameter tokens from a non-minified function's source
 * (Vite/Vitest preserves TS parameter names). Used only to disambiguate
 * optional trailing `storageArea?` vs positional arguments.
 */
function extractTopLevelParamTokens(fn: (...args: never[]) => unknown): string[] {
  const src = Function.prototype.toString
    .call(fn)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const openIdx = src.indexOf('(');
  if (openIdx === -1) {
    const arrowIdx = src.indexOf('=>');
    if (arrowIdx !== -1) {
      const single = src.slice(0, arrowIdx).replace(/^async\s+/, '').trim();
      return single ? [single] : [];
    }
    return [];
  }

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && ch === ')') {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return [];

  const inner = src.slice(openIdx + 1, closeIdx).trim();
  if (!inner) return [];

  const params: string[] = [];
  let cur = '';
  let nest = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === '(' || ch === '{' || ch === '[') nest += 1;
    else if (ch === ')' || ch === '}' || ch === ']') nest -= 1;
    if (ch === ',' && nest === 0) {
      params.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) params.push(cur.trim());
  return params.map((p) => p.split('=')[0]!.replace(/^\.\.\./, '').trim());
}

// ============================================================================
// 1. Manifest Config Loader (manifest.config.ts)
// ============================================================================

export interface LoadedManifestConfig {
  buildManifest: (version: string) => ManifestV3Shape;
}

export async function loadManifestConfig(): Promise<LoadedManifestConfig> {
  const surfacePath = 'manifest.config.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);
  const fn = findExport(
    mod,
    surfacePath,
    ['buildManifest', 'createManifest', 'default'],
    (v): v is (version: string) => ManifestV3Shape => typeof v === 'function',
    'buildManifest(version)',
  );
  return { buildManifest: fn };
}

// ============================================================================
// 2. Bridge v1 Contract Loader (src/shared/bridge-contract.ts)
// ============================================================================

export interface LoadedBridgeContract {
  meSchema: ZodLikeSchema;
  pendingTaskSchema: ZodLikeSchema;
  confirmPublishedInputSchema: ZodLikeSchema;
  confirmPublishedResultSchema: ZodLikeSchema;
  providerKeySchema: ZodLikeSchema;
  taskStatusSchema: ZodLikeSchema;
  createEnvelopeSchema: (dataSchema: ZodLikeSchema) => ZodLikeSchema;
  raw: Record<string, unknown>;
}

export async function loadBridgeContract(): Promise<LoadedBridgeContract> {
  const surfacePath = 'src/shared/bridge-contract.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const meSchema = findExport(
    mod,
    surfacePath,
    [
      'extensionMeDtoSchema',
      'ExtensionMeDtoSchema',
      'extensionMeSchema',
      'ExtensionMeSchema',
      'meDtoSchema',
    ],
    isZodSchema,
    'ExtensionMeDto Zod schema',
  );

  const pendingTaskSchema = findExport(
    mod,
    surfacePath,
    [
      'extensionPendingTaskDtoSchema',
      'ExtensionPendingTaskDtoSchema',
      'extensionPendingTaskSchema',
      'ExtensionPendingTaskSchema',
      'pendingTaskDtoSchema',
      'pendingTaskSchema',
    ],
    isZodSchema,
    'ExtensionPendingTaskDto Zod schema',
  );

  const confirmPublishedInputSchema = findExport(
    mod,
    surfacePath,
    [
      'extensionConfirmPublishedInputSchema',
      'ExtensionConfirmPublishedInputSchema',
      'confirmPublishedInputSchema',
      'ConfirmPublishedInputSchema',
    ],
    isZodSchema,
    'ExtensionConfirmPublishedInput Zod schema',
  );

  const confirmPublishedResultSchema = findExport(
    mod,
    surfacePath,
    [
      'extensionConfirmPublishedResultSchema',
      'ExtensionConfirmPublishedResultSchema',
      'confirmPublishedResultSchema',
      'ConfirmPublishedResultSchema',
    ],
    isZodSchema,
    'ExtensionConfirmPublishedResult Zod schema',
  );

  const providerKeySchema = findExport(
    mod,
    surfacePath,
    [
      'extensionProviderKeySchema',
      'ExtensionProviderKeySchema',
      'providerKeySchema',
      'ProviderKeySchema',
    ],
    isZodSchema,
    'ExtensionProviderKey Zod schema',
  );

  const taskStatusSchema = findExport(
    mod,
    surfacePath,
    [
      'extensionTaskStatusSchema',
      'ExtensionTaskStatusSchema',
      'taskStatusSchema',
      'TaskStatusSchema',
    ],
    isZodSchema,
    'ExtensionTaskStatus Zod schema',
  );

  const createEnvelopeSchema = findExport(
    mod,
    surfacePath,
    [
      'createApiEnvelopeSchema',
      'apiEnvelopeSchema',
      'ApiEnvelopeSchema',
      'makeApiEnvelopeSchema',
    ],
    (v): v is (dataSchema: ZodLikeSchema) => ZodLikeSchema =>
      typeof v === 'function',
    'ApiEnvelope schema factory',
  );

  return {
    meSchema,
    pendingTaskSchema,
    confirmPublishedInputSchema,
    confirmPublishedResultSchema,
    providerKeySchema,
    taskStatusSchema,
    createEnvelopeSchema,
    raw: mod,
  };
}

// ============================================================================
// 3. Storage Loader (src/shared/storage.ts)
// ============================================================================

export interface LoadedStorageModule {
  savePairing: (pairing: PairingState) => Promise<void>;
  getPairing: () => Promise<PairingState | null | undefined>;
  clearPairing: () => Promise<void>;
  setTabTask: (tabId: number, task: PendingTabTask) => Promise<void>;
  getTabTask: (tabId: number) => Promise<PendingTabTask | null | undefined>;
  updateTabTask: (
    tabId: number,
    patch: Partial<PendingTabTask>,
  ) => Promise<PendingTabTask | void | null | undefined>;
  removeTabTask: (tabId: number) => Promise<void>;
  raw: Record<string, unknown>;
}

export async function loadStorageModule(): Promise<LoadedStorageModule> {
  const surfacePath = 'src/shared/storage.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const savePairingRaw = findExport(
    mod,
    surfacePath,
    ['savePairing', 'setPairing', 'savePairingState', 'setPairingState', 'writePairing'],
    isFunction,
    'savePairing',
  ) as (pairing: PairingState) => Promise<void>;

  const getPairingRaw = findExport(
    mod,
    surfacePath,
    ['getPairing', 'loadPairing', 'getPairingState', 'readPairing'],
    isFunction,
    'getPairing',
  ) as () => Promise<PairingState | null | undefined>;

  const clearPairingRaw = findExport(
    mod,
    surfacePath,
    ['clearPairing', 'removePairing', 'clearPairingState', 'deletePairing'],
    isFunction,
    'clearPairing',
  ) as () => Promise<void>;

  const findOptionalFn = (names: readonly string[]) => {
    for (const n of names) {
      if (typeof mod[n] === 'function') {
        return mod[n] as (...args: unknown[]) => Promise<unknown>;
      }
    }
    return null;
  };

  const setTabTaskFn = findOptionalFn([
    'setTabTask',
    'setPendingTabTask',
    'saveTabTask',
    'savePendingTabTask',
    'bindTabTask',
    'putTabTask',
    'upsertTabTask',
  ]);
  const getTabTaskFn = findOptionalFn([
    'getTabTask',
    'getPendingTabTask',
    'loadTabTask',
    'readTabTask',
  ]);
  const updateTabTaskFn = findOptionalFn([
    'updateTabTask',
    'updatePendingTabTask',
    'patchTabTask',
    'mergeTabTask',
  ]);
  const removeTabTaskFn = findOptionalFn([
    'removeTabTask',
    'removePendingTabTask',
    'deleteTabTask',
    'clearTabTask',
    'unbindTabTask',
  ]);

  const requireSessionExport = (name: string): never => {
    throw new PublicSurfaceError(
      'MISSING_CONTRACT_EXPORT',
      surfacePath,
      `Missing required session storage export "${name}" (actual exports: [${listExportKeys(mod)}])`,
    );
  };

  type SetTabTaskCallStyle = 'task-only' | 'tabId-first';

  const resolveSetTabTaskCallStyle = (
    fn: (...args: unknown[]) => Promise<unknown>,
  ): SetTabTaskCallStyle => {
    if (fn.length === 1) {
      return 'task-only';
    }
    if (fn.length >= 3) {
      return 'tabId-first';
    }
    const params = extractTopLevelParamTokens(fn);
    const p0 = params[0] ?? '';
    const p1 = params[1] ?? '';
    if (/storage|area|store|opts|options/i.test(p1)) {
      return 'task-only';
    }
    if (
      p0.startsWith('{') ||
      /^(?:task|tabTask|pending|record|entry|input|payload|ctx|context)/i.test(p0)
    ) {
      return 'task-only';
    }
    if (
      /^(?:tabId|tab|id|key)$/i.test(p0) ||
      /^(?:task|tabTask|pending|record|entry|input|payload|ctx|context)/i.test(p1)
    ) {
      return 'tabId-first';
    }
    if (fn.length === 2) {
      throw new PublicSurfaceError(
        'INVALID_CONTRACT_SHAPE',
        surfacePath,
        `Cannot disambiguate 2-argument setTabTask signature (${params.join(', ')}) between (task, storageArea?) and (tabId, task)`,
      );
    }
    return 'tabId-first';
  };

  const setTabTaskStyle: SetTabTaskCallStyle | null = setTabTaskFn
    ? resolveSetTabTaskCallStyle(setTabTaskFn)
    : null;

  const invokeSetTabTask = async (
    tabId: number,
    task: PendingTabTask,
  ): Promise<void> => {
    if (!setTabTaskFn || !setTabTaskStyle) {
      requireSessionExport('setTabTask');
    }
    const normalized: PendingTabTask = { ...task, tabId };
    if (setTabTaskStyle === 'task-only') {
      await setTabTaskFn!(normalized);
    } else {
      await setTabTaskFn!(tabId, normalized);
    }
  };

  return {
    savePairing: savePairingRaw,
    getPairing: getPairingRaw,
    clearPairing: clearPairingRaw,
    setTabTask: invokeSetTabTask,
    getTabTask: async (tabId: number) => {
      if (!getTabTaskFn) {
        requireSessionExport('getTabTask');
      }
      return (await getTabTaskFn!(tabId)) as PendingTabTask | null | undefined;
    },
    updateTabTask: async (tabId: number, patch: Partial<PendingTabTask>) => {
      if (updateTabTaskFn) {
        return (await updateTabTaskFn(tabId, patch)) as
          | PendingTabTask
          | void
          | null
          | undefined;
      }
      // Fallback ONLY if update is done via get + set on the real module
      if (!getTabTaskFn || !setTabTaskFn) {
        requireSessionExport('updateTabTask');
      }
      const existing = (await getTabTaskFn!(tabId)) as PendingTabTask | null | undefined;
      if (!existing) {
        return null;
      }
      const merged = { ...existing, ...patch, tabId };
      await invokeSetTabTask(tabId, merged);
      return merged;
    },
    removeTabTask: async (tabId: number) => {
      if (!removeTabTaskFn) {
        requireSessionExport('removeTabTask');
      }
      await removeTabTaskFn!(tabId);
    },
    raw: mod,
  };
}

// ============================================================================
// 4. URL Validation Loader (src/shared/url-validation.ts)
// ============================================================================

export interface LoadedUrlValidation {
  canonicalizePublishedUrl: (
    rawUrl: string,
    provider?: ExtensionProviderKey,
  ) => string | null;
  validateApiBaseUrl: (rawUrl: string) => string | null;
  validateMediaUrl: (rawUrl: string) => string | null;
  validateZhihuTargetUrlHint: (rawUrl: string) => string | null;
  raw: Record<string, unknown>;
}

function interpretUrlValidatorReturn(val: unknown, fallbackUrl: string): string | null {
  if (val === null || val === undefined || val === false) {
    return null;
  }
  if (typeof val === 'string') {
    return val;
  }
  if (val === true) {
    return fallbackUrl;
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj['ok'] === false || obj['valid'] === false || obj['success'] === false) {
      return null;
    }
    const str =
      obj['url'] ??
      obj['canonicalUrl'] ??
      obj['normalizedUrl'] ??
      obj['cleanedUrl'] ??
      obj['normalized'] ??
      obj['value'] ??
      obj['data'];
    if (typeof str === 'string') {
      return str;
    }
    if (obj['ok'] === true || obj['valid'] === true) {
      return fallbackUrl;
    }
  }
  return null;
}

export async function loadUrlValidationModule(): Promise<LoadedUrlValidation> {
  const surfacePath = 'src/shared/url-validation.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const publishedFn = findExport(
    mod,
    surfacePath,
    [
      'canonicalizePublishedUrl',
      'normalizePublishedUrl',
      'validatePublishedUrl',
      'parsePublishedUrl',
      'sanitizePublishedUrl',
    ],
    isFunction,
    'published URL validator/canonicalizer',
  ) as (rawUrl: string, provider?: ExtensionProviderKey) => unknown;

  const baseUrlFn = findExport(
    mod,
    surfacePath,
    [
      'validateApiBaseUrl',
      'normalizeApiBaseUrl',
      'validateBaseUrl',
      'normalizeBaseUrl',
      'parseApiBaseUrl',
      'validateGeoMixBaseUrl',
      'normalizeGeoMixBaseUrl',
    ],
    isFunction,
    'API baseUrl validator',
  ) as (rawUrl: string) => unknown;

  const mediaUrlFn = findExport(
    mod,
    surfacePath,
    [
      'validateMediaAssetUrl',
      'validateMediaUrl',
      'validatePublicHttpsUrl',
      'isValidMediaUrl',
      'normalizeMediaUrl',
      'parseMediaUrl',
      'assertPublicHttpsUrl',
    ],
    isFunction,
    'media URL validator',
  ) as (rawUrl: string) => unknown;

  const detectPublishedFn = (() => {
    for (const name of [
      'detectProviderPublishedUrl',
      'detectPublishedUrl',
      'parseAnyPublishedUrl',
    ]) {
      if (typeof mod[name] === 'function') {
        return mod[name] as (rawUrl: string) => unknown;
      }
    }
    return null;
  })();

  const zhihuHintFn = (() => {
    for (const name of [
      'validateZhihuTargetUrlHint',
      'validateZhihuQuestionUrl',
      'normalizeZhihuQuestionUrl',
      'isValidZhihuQuestionUrl',
      'validateTargetUrlHint',
      'normalizeTargetUrlHint',
    ]) {
      if (typeof mod[name] === 'function') {
        return mod[name] as (rawUrl: string) => unknown;
      }
    }
    return null;
  })();

  const PROBE_URL = 'https://zhuanlan.zhihu.com/p/123';
  const PROBE_PROVIDER: ExtensionProviderKey = 'ZHIHU_EXT';
  const ALL_PROVIDERS: readonly ExtensionProviderKey[] = [
    'ZHIHU_EXT',
    'TOUTIAO_EXT',
    'SMZDM_EXT',
  ];

  const publishedRawFn = publishedFn as (...args: unknown[]) => unknown;

  const probeOrientation = (arg1: unknown, arg2: unknown): boolean => {
    try {
      const res = interpretUrlValidatorReturn(publishedRawFn(arg1, arg2), PROBE_URL);
      return res !== null && res.replace(/\/+$/, '') === PROBE_URL;
    } catch (err) {
      if (
        err instanceof PublicSurfaceError ||
        err instanceof ReferenceError ||
        err instanceof SyntaxError
      ) {
        throw err;
      }
      return false;
    }
  };

  let publishedArgOrder: 'provider-first' | 'url-first';
  if (probeOrientation(PROBE_PROVIDER, PROBE_URL)) {
    publishedArgOrder = 'provider-first';
  } else if (probeOrientation(PROBE_URL, PROBE_PROVIDER)) {
    publishedArgOrder = 'url-first';
  } else {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      `Published URL validator failed positive-control probe for both (provider, rawUrl) and (rawUrl, provider) using ${PROBE_URL}`,
    );
  }

  const callSafely = (fn: () => unknown, rawUrl: string): string | null => {
    try {
      return interpretUrlValidatorReturn(fn(), rawUrl);
    } catch (err) {
      if (isFatalRuntimeBug(err)) {
        throw err;
      }
      return null;
    }
  };

  return {
    canonicalizePublishedUrl: (rawUrl: string, provider?: ExtensionProviderKey) => {
      if (provider === undefined) {
        if (detectPublishedFn) {
          return callSafely(() => detectPublishedFn(rawUrl), rawUrl);
        }
        if (publishedArgOrder === 'url-first') {
          return callSafely(() => publishedRawFn(rawUrl), rawUrl);
        }
        for (const p of ALL_PROVIDERS) {
          const matched = callSafely(() => publishedRawFn(p, rawUrl), rawUrl);
          if (matched !== null) {
            return matched;
          }
        }
        return null;
      }
      return publishedArgOrder === 'provider-first'
        ? callSafely(() => publishedRawFn(provider, rawUrl), rawUrl)
        : callSafely(() => publishedRawFn(rawUrl, provider), rawUrl);
    },
    validateApiBaseUrl: (rawUrl: string) =>
      callSafely(() => baseUrlFn(rawUrl), rawUrl),
    validateMediaUrl: (rawUrl: string) =>
      callSafely(() => mediaUrlFn(rawUrl), rawUrl),
    validateZhihuTargetUrlHint: (rawUrl: string) => {
      if (!zhihuHintFn) {
        throw new PublicSurfaceError(
          'MISSING_CONTRACT_EXPORT',
          surfacePath,
          `Missing Zhihu targetUrlHint validator (actual exports: [${listExportKeys(mod)}])`,
        );
      }
      return callSafely(() => zhihuHintFn(rawUrl), rawUrl);
    },
    raw: mod,
  };
}

// ============================================================================
// 5. Internal Messages Loader (src/shared/messages.ts)
// ============================================================================

export interface LoadedMessagesModule {
  validateMessage: (raw: unknown) => { ok: boolean; data?: unknown };
  sendRuntimeMessage?: (request: unknown) => Promise<unknown>;
  raw: Record<string, unknown>;
}

export async function loadMessagesModule(): Promise<LoadedMessagesModule> {
  const surfacePath = 'src/shared/messages.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const sendRuntimeMessage =
    typeof mod['sendRuntimeMessage'] === 'function'
      ? (mod['sendRuntimeMessage'] as (request: unknown) => Promise<unknown>)
      : undefined;

  for (const name of [
    'runtimeMessageSchema',
    'RuntimeMessageSchema',
    'extensionMessageSchema',
    'ExtensionMessageSchema',
    'messageSchema',
    'MessageSchema',
    'ExtensionRuntimeRequestSchema',
    'extensionRuntimeRequestSchema',
  ]) {
    if (isZodSchema(mod[name])) {
      const schema = mod[name] as ZodLikeSchema;
      return {
        validateMessage: (raw: unknown) => {
          const parsed = schema.safeParse(raw);
          return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
        },
        sendRuntimeMessage,
        raw: mod,
      };
    }
  }

  const guardNames = [
    'parseRuntimeMessage',
    'validateRuntimeMessage',
    'parseExtensionRuntimeRequest',
    'isExtensionRuntimeRequest',
    'isPopupRuntimeRequest',
    'isContentToBackgroundRequest',
    'isBackgroundToContentRequest',
    'isRuntimeRequest',
    'isRuntimeMessage',
    'parseExtensionMessage',
    'isExtensionMessage',
    'isValidMessage',
    'isContentToBackgroundMessage',
    'isContentRuntimeRequest',
    'isBackgroundToContentMessage',
    'isContentScriptMessage',
  ];

  const matchedGuards: Array<(raw: unknown) => unknown> = [];
  for (const name of guardNames) {
    if (typeof mod[name] === 'function') {
      matchedGuards.push(mod[name] as (raw: unknown) => unknown);
    }
  }

  if (matchedGuards.length > 0) {
    return {
      validateMessage: (raw: unknown) => {
        for (const fn of matchedGuards) {
          try {
            const res = fn(raw);
            if (res === true) {
              return { ok: true, data: raw };
            }
            if (res && typeof res === 'object') {
              const obj = res as Record<string, unknown>;
              if (obj['success'] === true) {
                return { ok: true, data: obj['data'] };
              }
              if (obj['ok'] === true) {
                return { ok: true, data: obj['data'] ?? obj['value'] };
              }
              if (typeof obj['success'] !== 'boolean' && typeof obj['ok'] !== 'boolean') {
                return { ok: true, data: res };
              }
            }
          } catch (err) {
            if (isFatalRuntimeBug(err)) {
              throw err;
            }
          }
        }
        return { ok: false };
      },
      sendRuntimeMessage,
      raw: mod,
    };
  }

  throw new PublicSurfaceError(
    'MISSING_CONTRACT_EXPORT',
    surfacePath,
    `Missing runtime message schema/guard export (actual exports: [${listExportKeys(mod)}])`,
  );
}

// ============================================================================
// 6. Bridge Client Loader (src/background/bridge-client.ts)
// ============================================================================

export interface BridgeClientConfig {
  baseUrl: string;
  token: string;
  extensionVersion?: string;
}

export interface BridgeClientHandle {
  getMe: () => Promise<ExtensionMeDto>;
  listTasks: (filters?: {
    brandId?: string;
    provider?: ExtensionProviderKey;
    status?: string;
  }) => Promise<ExtensionPendingTaskDto[]>;
  confirmPublished: (
    taskId: string,
    input: ExtensionConfirmPublishedInput,
    options?: { provider?: ExtensionProviderKey; idempotencyKey?: string },
  ) => Promise<ExtensionConfirmPublishedResult>;
}

export interface LoadedBridgeClientModule {
  createClient: (config: BridgeClientConfig) => BridgeClientHandle;
  raw: Record<string, unknown>;
}

export async function loadBridgeClientModule(): Promise<LoadedBridgeClientModule> {
  const surfacePath = 'src/background/bridge-client.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const factoryNames = [
    'createBridgeClient',
    'createExtensionBridgeClient',
    'BridgeClient',
    'ExtensionBridgeClient',
  ];

  const resolveHandleMethods = (instance: Record<string, unknown>): BridgeClientHandle => {
    const getMeFn = (instance['getMe'] ?? instance['fetchMe'] ?? instance['me']) as
      | (() => Promise<ExtensionMeDto>)
      | undefined;
    const listTasksFn = (instance['listTasks'] ??
      instance['getTasks'] ??
      instance['fetchTasks'] ??
      instance['fetchPendingTasks'] ??
      instance['getPendingTasks']) as
      | ((filters?: Record<string, unknown>) => Promise<ExtensionPendingTaskDto[]>)
      | undefined;
    const confirmFn = (instance['confirmPublished'] ??
      instance['confirmTaskPublished']) as
      | ((
          taskId: string,
          input: ExtensionConfirmPublishedInput,
          options?: { provider?: ExtensionProviderKey; idempotencyKey?: string },
        ) => Promise<ExtensionConfirmPublishedResult>)
      | undefined;

    if (!getMeFn || !listTasksFn || !confirmFn) {
      throw new PublicSurfaceError(
        'INVALID_CONTRACT_SHAPE',
        surfacePath,
        `Bridge client instance missing required methods (found: [${Object.keys(instance).join(', ')}])`,
      );
    }

    return {
      getMe: () => getMeFn.call(instance),
      listTasks: (filters) => listTasksFn.call(instance, filters),
      confirmPublished: (taskId, input, options) =>
        options !== undefined
          ? confirmFn.call(instance, taskId, input, options)
          : confirmFn.call(instance, taskId, input),
    };
  };

  for (const name of factoryNames) {
    const exp = mod[name];
    if (typeof exp === 'function') {
      return {
        createClient: (config: BridgeClientConfig) => {
          const opts = {
            baseUrl: config.baseUrl,
            token: config.token,
            extensionVersion: config.extensionVersion ?? '0.1.0',
            version: config.extensionVersion ?? '0.1.0',
          };
          let instance: unknown;
          try {
            instance = (exp as (c: typeof opts) => unknown)(opts);
          } catch {
            const Ctor = exp as new (c: typeof opts) => unknown;
            instance = new Ctor(opts);
          }
          return resolveHandleMethods(instance as Record<string, unknown>);
        },
        raw: mod,
      };
    }
  }

  // Standalone function exports (getMe(config), listTasks(config, filters), confirmPublished(config, taskId, input, options?))
  const standaloneGetMe = (mod['getMe'] ?? mod['fetchMe']) as
    | ((cfg: BridgeClientConfig) => Promise<ExtensionMeDto>)
    | undefined;
  const standaloneListTasks = (mod['listTasks'] ??
    mod['getTasks'] ??
    mod['fetchTasks']) as
    | ((
        cfg: BridgeClientConfig,
        filters?: Record<string, unknown>,
      ) => Promise<ExtensionPendingTaskDto[]>)
    | undefined;
  const standaloneConfirm = (mod['confirmPublished'] ??
    mod['confirmTaskPublished']) as
    | ((
        cfg: BridgeClientConfig,
        taskId: string,
        input: ExtensionConfirmPublishedInput,
        options?: { provider?: ExtensionProviderKey; idempotencyKey?: string },
      ) => Promise<ExtensionConfirmPublishedResult>)
    | undefined;

  if (standaloneGetMe && standaloneListTasks && standaloneConfirm) {
    return {
      createClient: (config: BridgeClientConfig) => ({
        getMe: () => standaloneGetMe(config),
        listTasks: (filters) => standaloneListTasks(config, filters),
        confirmPublished: (taskId, input, options) =>
          options !== undefined
            ? standaloneConfirm(config, taskId, input, options)
            : standaloneConfirm(config, taskId, input),
      }),
      raw: mod,
    };
  }

  throw new PublicSurfaceError(
    'MISSING_CONTRACT_EXPORT',
    surfacePath,
    `Missing Bridge v1 client factory/class/functions (actual exports: [${listExportKeys(mod)}])`,
  );
}

// ============================================================================
// 7. Dispatch, Media Fetcher & SW Entrypoint Loaders
// ============================================================================

export async function loadDispatchModule(): Promise<Record<string, unknown>> {
  return loadPublicModule<Record<string, unknown>>('src/background/dispatch.ts');
}

export async function loadMediaFetcherModule(): Promise<Record<string, unknown>> {
  return loadPublicModule<Record<string, unknown>>(
    'src/background/media-fetcher.ts',
  );
}

export async function bootBackgroundServiceWorker(): Promise<
  Record<string, unknown>
> {
  vi.resetModules();
  return loadPublicModule<Record<string, unknown>>('src/background/index.ts');
}

// ============================================================================
// 8. Popup App, Content Runtime, Image Uploader & Shadow DOM Bar Loaders
// ============================================================================

export async function loadPopupApp(): Promise<React.ComponentType> {
  const surfacePath = 'src/popup/App.tsx';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);
  return findExport(
    mod,
    surfacePath,
    ['App', 'default'],
    (v): v is React.ComponentType => typeof v === 'function',
    'React App component',
  );
}

export function clearContentScriptWindowFlags(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const winRecord = window as unknown as Record<string, unknown>;
  for (const key of Object.keys(window)) {
    if (key.startsWith('__geomix')) {
      try {
        delete winRecord[key];
      } catch {
        // ignore non-configurable host properties
      }
    }
  }
}

export async function bootContentScript(): Promise<Record<string, unknown>> {
  clearContentScriptWindowFlags();
  vi.resetModules();
  return loadPublicModule<Record<string, unknown>>('src/content/index.ts');
}

export interface LoadedImageUploaderModule {
  createUploader: () => LocalImageUploader;
  raw: Record<string, unknown>;
}

export async function loadImageUploaderModule(): Promise<LoadedImageUploaderModule> {
  const surfacePath = 'src/content/image-uploader.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const isUploader = (v: unknown): v is LocalImageUploader =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as LocalImageUploader).uploadAll === 'function';

  for (const name of [
    'localImageUploader',
    'imageUploader',
    'defaultImageUploader',
    'default',
  ]) {
    if (isUploader(mod[name])) {
      const instance = mod[name] as LocalImageUploader;
      return { createUploader: () => instance, raw: mod };
    }
  }

  for (const name of [
    'createLocalImageUploader',
    'createImageUploader',
    'ContentLocalImageUploader',
    'ExtensionLocalImageUploader',
    'LocalImageUploaderImpl',
    'default',
  ]) {
    const exp = mod[name];
    if (typeof exp === 'function') {
      return {
        createUploader: () => {
          let obj: unknown;
          try {
            obj = (exp as () => unknown)();
          } catch {
            const Ctor = exp as new () => unknown;
            obj = new Ctor();
          }
          if (!isUploader(obj)) {
            throw new PublicSurfaceError(
              'INVALID_CONTRACT_SHAPE',
              surfacePath,
              `Export "${name}" did not return an object implementing uploadAll()`,
            );
          }
          return obj;
        },
        raw: mod,
      };
    }
  }

  throw new PublicSurfaceError(
    'MISSING_CONTRACT_EXPORT',
    surfacePath,
    `Missing LocalImageUploader factory/class/instance (actual exports: [${listExportKeys(mod)}])`,
  );
}

export async function loadUrlCaptureBarModule(): Promise<Record<string, unknown>> {
  return loadPublicModule<Record<string, unknown>>(
    'src/content/url-capture-bar.tsx',
  );
}

// ============================================================================
// 9. Adapter Types, Registry & 3 Platform Adapters
// ============================================================================

export async function loadAdapterTypesModule(): Promise<Record<string, unknown>> {
  return loadPublicModule<Record<string, unknown>>('src/adapters/types.ts');
}

export function assertValidPlatformAdapter(
  candidate: unknown,
  surfacePath: string,
  expectedProvider?: ExtensionProviderKey,
): PlatformDraftAdapter {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      'Adapter export is not an object',
    );
  }
  const a = candidate as Record<string, unknown>;
  const validProviders: ExtensionProviderKey[] = [
    'ZHIHU_EXT',
    'TOUTIAO_EXT',
    'SMZDM_EXT',
  ];
  if (
    typeof a['provider'] !== 'string' ||
    !validProviders.includes(a['provider'] as ExtensionProviderKey)
  ) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      `Invalid adapter.provider: ${String(a['provider'])}`,
    );
  }
  if (expectedProvider && a['provider'] !== expectedProvider) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      `Expected adapter.provider === "${expectedProvider}", got "${String(a['provider'])}"`,
    );
  }
  if (typeof a['displayName'] !== 'string' || a['displayName'].length === 0) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      'adapter.displayName must be a non-empty string',
    );
  }
  if (
    typeof a['editorEntryUrl'] !== 'string' ||
    !a['editorEntryUrl'].startsWith('https://')
  ) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      `adapter.editorEntryUrl must be an HTTPS string, got ${String(a['editorEntryUrl'])}`,
    );
  }
  if (
    !Array.isArray(a['publishedUrlPatterns']) ||
    a['publishedUrlPatterns'].length === 0 ||
    !a['publishedUrlPatterns'].every((p) => p instanceof RegExp)
  ) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      'adapter.publishedUrlPatterns must be a non-empty RegExp[]',
    );
  }
  for (const methodName of [
    'isLoggedInEditor',
    'injectDraft',
    'extractPublishedUrl',
  ]) {
    if (typeof a[methodName] !== 'function') {
      throw new PublicSurfaceError(
        'INVALID_CONTRACT_SHAPE',
        surfacePath,
        `adapter.${methodName} must be a function`,
      );
    }
  }
  return candidate as PlatformDraftAdapter;
}

export interface LoadedAdapterRegistry {
  getByProvider: (
    provider: ExtensionProviderKey,
  ) => PlatformDraftAdapter | null | undefined;
  getByUrl: (url: URL | string) => PlatformDraftAdapter | null | undefined;
  listAll: () => readonly PlatformDraftAdapter[];
  raw: Record<string, unknown>;
}

export async function loadAdapterRegistryModule(): Promise<LoadedAdapterRegistry> {
  const surfacePath = 'src/adapters/registry.ts';
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const byProviderFn = findExport(
    mod,
    surfacePath,
    [
      'getAdapterByProvider',
      'getAdapter',
      'resolveAdapterByProvider',
      'findAdapterByProvider',
      'getPlatformAdapter',
    ],
    isFunction,
    'getAdapterByProvider',
  ) as (provider: ExtensionProviderKey) => PlatformDraftAdapter | null | undefined;

  const byUrlFn = findExport(
    mod,
    surfacePath,
    [
      'getAdapterByUrl',
      'findAdapterByUrl',
      'resolveAdapterByUrl',
      'matchAdapterByUrl',
      'findAdapterForUrl',
      'getAdapterForUrl',
    ],
    isFunction,
    'getAdapterByUrl',
  ) as (url: URL | string) => PlatformDraftAdapter | null | undefined;

  const listAllFn = (() => {
    for (const name of [
      'listAdapters',
      'getAllAdapters',
      'getRegisteredAdapters',
      'getAdapters',
    ]) {
      if (typeof mod[name] === 'function') {
        return mod[name] as () => readonly PlatformDraftAdapter[];
      }
    }
    for (const name of ['ADAPTERS', 'adapters', 'PLATFORM_ADAPTERS']) {
      if (Array.isArray(mod[name])) {
        return () => mod[name] as readonly PlatformDraftAdapter[];
      }
    }
    throw new PublicSurfaceError(
      'MISSING_CONTRACT_EXPORT',
      surfacePath,
      `Missing listAdapters/ADAPTERS export (actual exports: [${listExportKeys(mod)}])`,
    );
  })();

  return {
    getByProvider: byProviderFn,
    getByUrl: (urlInput: URL | string) => {
      const asUrl = typeof urlInput === 'string' ? new URL(urlInput) : urlInput;
      try {
        return byUrlFn(asUrl);
      } catch {
        return byUrlFn(asUrl.toString());
      }
    },
    listAll: listAllFn,
    raw: mod,
  };
}

export async function loadPlatformAdapter(
  provider: ExtensionProviderKey,
): Promise<PlatformDraftAdapter> {
  const pathByProvider: Record<ExtensionProviderKey, string> = {
    ZHIHU_EXT: 'src/adapters/zhihu/zhihu.adapter.ts',
    TOUTIAO_EXT: 'src/adapters/toutiao/toutiao.adapter.ts',
    SMZDM_EXT: 'src/adapters/smzdm/smzdm.adapter.ts',
  };
  const surfacePath = pathByProvider[provider];
  const mod = await loadPublicModule<Record<string, unknown>>(surfacePath);

  const candidates = [
    'zhihuAdapter',
    'zhihuDraftAdapter',
    'ZhihuAdapter',
    'ZhihuDraftAdapter',
    'toutiaoAdapter',
    'toutiaoDraftAdapter',
    'ToutiaoAdapter',
    'ToutiaoDraftAdapter',
    'smzdmAdapter',
    'smzdmDraftAdapter',
    'SmzdmAdapter',
    'SmzdmDraftAdapter',
    'adapter',
    'default',
    'createZhihuAdapter',
    'createToutiaoAdapter',
    'createSmzdmAdapter',
  ];

  for (const name of candidates) {
    const exp = mod[name];
    if (exp && typeof exp === 'object' && 'provider' in exp) {
      return assertValidPlatformAdapter(exp, surfacePath, provider);
    }
    if (typeof exp === 'function') {
      let built: unknown;
      try {
        built = (exp as () => unknown)();
      } catch (err) {
        if (err instanceof PublicSurfaceError) {
          throw err;
        }
        const Ctor = exp as new () => unknown;
        built = new Ctor();
      }
      if (built && typeof built === 'object' && 'provider' in built) {
        return assertValidPlatformAdapter(built, surfacePath, provider);
      }
    }
  }

  for (const val of Object.values(mod)) {
    if (val && typeof val === 'object' && 'provider' in val) {
      return assertValidPlatformAdapter(val, surfacePath, provider);
    }
  }

  throw new PublicSurfaceError(
    'MISSING_CONTRACT_EXPORT',
    surfacePath,
    `No PlatformDraftAdapter export found for ${provider} (actual exports: [${listExportKeys(mod)}])`,
  );
}

// ============================================================================
// 10. Build Artifacts, Docs, Source Scanner & Pure-Node ZIP Inspector
// ============================================================================

export function readDistManifest(): ManifestV3Shape {
  const rel = 'dist/manifest.json';
  const abs = resolveRepoPath(rel);
  if (!fs.existsSync(abs)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      rel,
      `dist/manifest.json not found — run "pnpm build" first`,
    );
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8')) as ManifestV3Shape;
}

export function readDistBundle(name: 'content.js' | 'background.js'): string {
  const rel = `dist/${name}`;
  const abs = resolveRepoPath(rel);
  if (!fs.existsSync(abs)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      rel,
      `${rel} not found — run "pnpm build" first`,
    );
  }
  return fs.readFileSync(abs, 'utf8');
}

export function readQaChecklistDoc(): string {
  const rel = 'docs/发布与真机验收清单.md';
  const abs = resolveRepoPath(rel);
  if (!fs.existsSync(abs)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      rel,
      `QA checklist document missing at ${abs}`,
    );
  }
  return fs.readFileSync(abs, 'utf8');
}

export function listFilesRecursive(dirRelPath: string): string[] {
  const rootAbs = resolveRepoPath(dirRelPath);
  if (!fs.existsSync(rootAbs)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      dirRelPath,
      `Directory does not exist: ${rootAbs}`,
    );
  }
  const results: string[] = [];
  const walk = (currentAbs: string): void => {
    for (const entry of fs.readdirSync(currentAbs, { withFileTypes: true })) {
      const full = path.join(currentAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(path.relative(rootAbs, full).split(path.sep).join('/'));
      }
    }
  };
  walk(rootAbs);
  return results.sort();
}

export interface ScannedSourceFile {
  relPath: string;
  content: string;
}

/**
 * Scans production source files under dirRelPath, excluding unit tests and fixtures.
 */
export function scanSourceFiles(
  dirRelPath: string,
  options: { includeTests?: boolean } = {},
): ScannedSourceFile[] {
  const all = listFilesRecursive(dirRelPath);
  const files: ScannedSourceFile[] = [];
  for (const subPath of all) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(subPath)) {
      continue;
    }
    if (!options.includeTests) {
      if (
        /\.(spec|test)\.(ts|tsx|js)$/.test(subPath) ||
        /(^|\/)fixtures\.(ts|tsx|js)$/.test(subPath) ||
        /(^|\/)test\//.test(subPath)
      ) {
        continue;
      }
    }
    const abs = resolveRepoPath(dirRelPath, subPath);
    files.push({
      relPath: `${dirRelPath}/${subPath}`,
      content: fs.readFileSync(abs, 'utf8'),
    });
  }
  return files;
}

/**
 * Zero-dependency pure-Node ZIP Central Directory parser.
 */
export function listZipEntries(zipBuffer: Buffer): ZipEntryInfo[] {
  if (zipBuffer.length < 22 || zipBuffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Invalid ZIP buffer: missing PKZip local header magic 50 4B 03 04');
  }

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP buffer: EOCD record not found');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntryInfo[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at offset ${cursor}`);
    }
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const fileNameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const name = zipBuffer.toString('utf8', cursor + 46, cursor + 46 + fileNameLen);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

export function readZipEntryBuffer(zipBuffer: Buffer, entryName: string): Buffer {
  const entries = listZipEntries(zipBuffer);
  const entry = entries.find((e) => e.name === entryName);
  if (!entry) {
    throw new Error(`ZIP entry not found: ${entryName}`);
  }
  const lh = entry.localHeaderOffset;
  if (zipBuffer.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`Invalid local file header for ${entryName}`);
  }
  const fnLen = zipBuffer.readUInt16LE(lh + 26);
  const extraLen = zipBuffer.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + fnLen + extraLen;
  const compressed = zipBuffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressed);
  }
  throw new Error(
    `Unsupported ZIP compression method ${entry.compressionMethod} for ${entryName}`,
  );
}

export function readZipEntryText(zipBuffer: Buffer, entryName: string): string {
  return readZipEntryBuffer(zipBuffer, entryName).toString('utf8');
}

export interface RunPackResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  zipBuffer: Buffer | null;
  entries: ZipEntryInfo[];
}

/**
 * Executes scripts/pack.mjs safely in an isolated temp output path and cleans up in finally.
 */
export function runPackScript(options: {
  distDir?: string;
  expectFailure?: boolean;
} = {}): RunPackResult {
  const scriptRel = 'scripts/pack.mjs';
  const scriptAbs = resolveRepoPath(scriptRel);
  if (!fs.existsSync(scriptAbs)) {
    throw new PublicSurfaceError(
      'MISSING_FILE',
      scriptRel,
      `CWS packager script missing at ${scriptAbs}`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geomix-e2e-pack-'));
  const outZip = path.join(tmpDir, 'geomix-extension-e2e.zip');

  // Snapshot any existing .zip files in repo root / release / dist before running
  const findRepoZips = (): Set<string> => {
    const found = new Set<string>();
    for (const dir of [REPO_ROOT, path.join(REPO_ROOT, 'release'), path.join(REPO_ROOT, 'dist')]) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.zip')) {
          found.add(path.join(dir, name));
        }
      }
    }
    return found;
  };
  const preExistingZips = findRepoZips();

  try {
    const args: string[] = [scriptAbs, '--out', outZip];
    if (options.distDir) {
      args.push('--dist', options.distDir);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PACK_OUT: outZip,
      OUTPUT_ZIP: outZip,
      ...(options.distDir ? { DIST_DIR: options.distDir, PACK_DIST: options.distDir } : {}),
    };

    try {
      const stdout = execFileSync(process.execPath, args, {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Locate generated zip: either our requested outZip or a newly created zip
      let producedZipPath: string | null = fs.existsSync(outZip) ? outZip : null;
      if (!producedZipPath) {
        const postZips = findRepoZips();
        for (const z of postZips) {
          if (!preExistingZips.has(z)) {
            producedZipPath = z;
            break;
          }
        }
      }

      if (!producedZipPath) {
        throw new Error(
          `scripts/pack.mjs exited 0 but no .zip artifact was found (stdout: ${stdout})`,
        );
      }
      const zipBuffer = fs.readFileSync(producedZipPath);
      const entries = listZipEntries(zipBuffer);

      // Clean up if pack.mjs wrote inside the repo despite --out
      if (producedZipPath !== outZip && !preExistingZips.has(producedZipPath)) {
        fs.rmSync(producedZipPath, { force: true });
      }

      return {
        exitCode: 0,
        stdout,
        stderr: '',
        zipBuffer,
        entries,
      };
    } catch (err) {
      const execErr = err as {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      if (options.expectFailure) {
        return {
          exitCode: execErr.status ?? 1,
          stdout: String(execErr.stdout ?? ''),
          stderr: String(execErr.stderr ?? execErr.message ?? ''),
          zipBuffer: null,
          entries: [],
        };
      }
      throw new PublicSurfaceError(
        'LOAD_ERROR',
        scriptRel,
        `scripts/pack.mjs failed (exit ${execErr.status ?? 1}): ${String(execErr.stderr ?? execErr.message ?? '')}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Guarantee zero newly created zips remain in repo
    for (const z of findRepoZips()) {
      if (!preExistingZips.has(z)) {
        fs.rmSync(z, { force: true });
      }
    }
  }
}

export function extractAssetFilenameFromResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '';
  }
  const r = result as Record<string, unknown>;
  return String(r['filename'] ?? r['fileName'] ?? r['name'] ?? '');
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

export function createSimpleMockUploader(
  impl: (
    assets: ExtensionMediaAsset[],
    target: { editorElement?: HTMLElement | null; fileInput?: HTMLInputElement | null },
  ) => Promise<{
    uploadedImages: number;
    failedImages: number;
    failures: Array<{ url: string; alt: string; reason: string }>;
  }>,
): LocalImageUploader {
  return {
    uploadAll: impl,
  };
}

// ============================================================================
// 11. Typed Contract Invokers for Media Fetcher, Dispatcher & Capture Bar
// ============================================================================

export interface NormalizedMediaFetchOutcome {
  ok: boolean;
  mime?: string;
  byteLength?: number;
  filename?: string;
  bytes?: Uint8Array;
  base64?: string;
  reason?: string;
}

function normalizeMediaOutcome(raw: unknown): NormalizedMediaFetchOutcome {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'Empty media fetch outcome' };
  }
  const obj = raw as Record<string, unknown>;
  const inner =
    obj['data'] && typeof obj['data'] === 'object'
      ? (obj['data'] as Record<string, unknown>)
      : obj;

  const isExplicitFailure = obj['ok'] === false || obj['success'] === false;
  if (isExplicitFailure) {
    return {
      ok: false,
      reason: String(
        obj['reason'] ?? obj['error'] ?? obj['message'] ?? 'Media fetch failed',
      ),
    };
  }

  let bytes: Uint8Array | undefined;
  let base64: string | undefined;
  if (inner['bytes'] instanceof Uint8Array) {
    bytes = inner['bytes'];
  } else if (inner['buffer'] instanceof ArrayBuffer) {
    bytes = new Uint8Array(inner['buffer']);
  } else if (inner['arrayBuffer'] instanceof ArrayBuffer) {
    bytes = new Uint8Array(inner['arrayBuffer']);
  } else if (typeof inner['base64'] === 'string') {
    base64 = inner['base64'];
    bytes = decodeBase64ToBytes(base64);
  } else if (typeof inner['dataBase64'] === 'string') {
    base64 = inner['dataBase64'];
    bytes = decodeBase64ToBytes(base64);
  }

  const byteLength =
    typeof inner['byteLength'] === 'number'
      ? inner['byteLength']
      : typeof inner['size'] === 'number'
        ? inner['size']
        : bytes?.byteLength;

  return {
    ok: true,
    mime:
      typeof inner['mime'] === 'string'
        ? inner['mime']
        : typeof inner['mimeType'] === 'string'
          ? inner['mimeType']
          : typeof inner['contentType'] === 'string'
            ? inner['contentType']
            : undefined,
    byteLength,
    filename: extractAssetFilenameFromResult(inner),
    bytes,
    base64,
  };
}

export async function invokeMediaFetcherSingle(
  asset: ExtensionMediaAsset,
): Promise<NormalizedMediaFetchOutcome> {
  const surfacePath = 'src/background/media-fetcher.ts';
  const mod = await loadMediaFetcherModule();
  const singleFn = findExport(
    mod,
    surfacePath,
    [
      'fetchMediaAsset',
      'fetchMedia',
      'fetchImageAsset',
      'relayMediaAsset',
      'downloadMediaAsset',
    ],
    isFunction,
    'fetchMediaAsset(asset)',
  ) as (input: unknown) => Promise<unknown>;

  const firstParam = extractTopLevelParamTokens(singleFn)[0] ?? '';
  const arg: unknown = /^(?:url|rawUrl|src|imageUrl|assetUrl)$/i.test(firstParam)
    ? asset.url
    : asset;

  try {
    const res = await singleFn(arg);
    return normalizeMediaOutcome(res);
  } catch (err) {
    if (isFatalRuntimeBug(err)) {
      throw err;
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function invokeMediaFetcherBatch(
  assets: ExtensionMediaAsset[],
): Promise<NormalizedMediaFetchOutcome[]> {
  const surfacePath = 'src/background/media-fetcher.ts';
  const mod = await loadMediaFetcherModule();
  for (const name of [
    'fetchMediaAssets',
    'fetchMediaBatch',
    'fetchAllMediaAssets',
    'fetchImages',
  ]) {
    if (typeof mod[name] === 'function') {
      const batchFn = mod[name] as (list: ExtensionMediaAsset[]) => Promise<unknown[]>;
      const results = await batchFn(assets);
      return results.map((r) => normalizeMediaOutcome(r));
    }
  }
  // If only single-asset fetcher exists, invoke concurrently through Promise.all so
  // any internal semaphore/limiter in media-fetcher.ts is exercised genuinely.
  return Promise.all(assets.map((asset) => invokeMediaFetcherSingle(asset)));
}

export function normalizeInjectReportResponse(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const top = raw as Record<string, unknown>;

  if (
    top['ok'] === false &&
    top['error'] &&
    typeof top['error'] === 'object' &&
    !('stage' in top)
  ) {
    const errObj = top['error'] as Record<string, unknown>;
    return {
      ...top,
      ok: false,
      message:
        typeof errObj['message'] === 'string'
          ? errObj['message']
          : String(top['message'] ?? ''),
    };
  }

  const payload =
    top['data'] && typeof top['data'] === 'object' && !Array.isArray(top['data'])
      ? (top['data'] as Record<string, unknown>)
      : top;

  if (
    payload['report'] &&
    typeof payload['report'] === 'object' &&
    !Array.isArray(payload['report'])
  ) {
    const report = payload['report'] as Record<string, unknown>;
    return {
      ...payload,
      ...report,
    };
  }

  if (typeof payload['ok'] !== 'boolean' && typeof payload['accepted'] === 'boolean') {
    return {
      ...payload,
      ok: payload['accepted'],
    };
  }

  return payload;
}

function isEnvelopeShapeRejection(raw: unknown): boolean {
  if (raw === undefined || raw === null) {
    return true;
  }
  if (typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['ok'] !== false) {
    return false;
  }
  const err = obj['error'];
  if (err && typeof err === 'object') {
    const kind = (err as Record<string, unknown>)['kind'];
    return kind === 'INVALID_REQUEST';
  }
  return false;
}

/**
 * Sends INJECT_DRAFT to a content-script tab, supporting both the
 * `{ type, payload: { task } }` convention (matching M1 messages.ts) and
 * flat `{ type, task }`, and normalizing `{ ok, data }` / `{ report }` envelopes.
 * Returns `undefined` if the content script ignores the message (e.g., M1 stub).
 */
export async function sendInjectDraftToTab(
  env: { sendToTab: (tabId: number, message: unknown) => Promise<unknown> },
  tabId: number,
  task: ExtensionPendingTaskDto,
): Promise<Record<string, unknown> | undefined> {
  const first = await env.sendToTab(tabId, {
    type: 'INJECT_DRAFT',
    payload: { task },
  });
  if (!isEnvelopeShapeRejection(first)) {
    return normalizeInjectReportResponse(first);
  }
  const second = await env.sendToTab(tabId, {
    type: 'INJECT_DRAFT',
    task,
  });
  return normalizeInjectReportResponse(second ?? first);
}

export async function invokeDispatcher(
  task: ExtensionPendingTaskDto,
): Promise<Record<string, unknown>> {
  const surfacePath = 'src/background/dispatch.ts';
  const mod = await loadDispatchModule();
  const dispatchFn = findExport(
    mod,
    surfacePath,
    [
      'dispatchDraftTask',
      'dispatchTask',
      'dispatchDraft',
      'pushDraftToTab',
      'pushTaskToDraft',
    ],
    isFunction,
    'dispatchDraftTask(task)',
  ) as (input: ExtensionPendingTaskDto) => Promise<unknown>;

  const raw = await dispatchFn(task);
  const normalized = normalizeInjectReportResponse(raw);
  if (!normalized) {
    throw new PublicSurfaceError(
      'INVALID_CONTRACT_SHAPE',
      surfacePath,
      `dispatchDraftTask returned invalid non-object outcome: ${String(raw)}`,
    );
  }
  return normalized;
}

export interface CaptureBarMountInput {
  publishedUrl: string;
  task: PendingTabTask;
  onConfirm?: (publishedUrl: string) => Promise<ExtensionConfirmPublishedResult>;
  onDismiss?: () => void;
  doc?: Document;
}

export interface PartialNoticeMountInput {
  failedImages: Array<{ url: string; alt: string; reason: string }>;
  taskTitle?: string;
  onDismiss?: () => void;
  doc?: Document;
}

export interface CaptureBarControllerHandle {
  mountPublishedBar: (input: CaptureBarMountInput) => { unmount: () => void };
  mountPartialMediaNotice: (
    input: PartialNoticeMountInput,
  ) => { unmount: () => void };
  unmountAll: () => void;
  raw: Record<string, unknown>;
}

export async function loadUrlCaptureBarController(): Promise<CaptureBarControllerHandle> {
  const surfacePath = 'src/content/url-capture-bar.tsx';
  const mod = await loadUrlCaptureBarModule();

  const mountBarFn = (() => {
    for (const name of [
      'mountUrlCaptureBar',
      'showUrlCaptureBar',
      'renderUrlCaptureBar',
      'mountCaptureBar',
    ]) {
      if (typeof mod[name] === 'function') {
        return mod[name] as (opts: Record<string, unknown>) => unknown;
      }
    }
    return null;
  })();

  const mountNoticeMatch = (() => {
    for (const name of [
      'mountPartialMediaNotice',
      'mountOperatorNoticeBar',
      'showPartialMediaNotice',
      'mountMediaFailureNotice',
      'showMediaFailureNotice',
    ]) {
      if (typeof mod[name] === 'function') {
        return {
          name,
          fn: mod[name] as (opts: Record<string, unknown>) => unknown,
        };
      }
    }
    return null;
  })();

  const unmountFn = (() => {
    for (const name of [
      'unmountUrlCaptureBar',
      'removeUrlCaptureBar',
      'destroyUrlCaptureBar',
      'unmountCaptureBar',
    ]) {
      if (typeof mod[name] === 'function') {
        return mod[name] as (doc?: Document) => void;
      }
    }
    return null;
  })();

  if (!mountBarFn) {
    throw new PublicSurfaceError(
      'MISSING_CONTRACT_EXPORT',
      surfacePath,
      `Missing mountUrlCaptureBar controller export (actual exports: [${listExportKeys(mod)}])`,
    );
  }

  const runUnmount = (ret: unknown, targetDoc?: Document): void => {
    act(() => {
      if (typeof ret === 'function') {
        (ret as () => void)();
      } else if (
        ret &&
        typeof ret === 'object' &&
        typeof (ret as { unmount?: () => void }).unmount === 'function'
      ) {
        (ret as { unmount: () => void }).unmount();
      } else if (unmountFn) {
        unmountFn(targetDoc);
      }
    });
  };

  return {
    mountPublishedBar: (input: CaptureBarMountInput) => {
      const targetDoc = input.doc ?? document;
      const onConfirmPublished = input.onConfirm
        ? async (req: { taskId: string; publishedUrl: string }) => {
            try {
              const data = await input.onConfirm!(req.publishedUrl);
              return { ok: true as const, data };
            } catch (err) {
              const errObj = err as {
                kind?: string;
                status?: number;
                httpStatus?: number;
                reauthRequired?: boolean;
              };
              const msg = err instanceof Error ? err.message : String(err);
              const status =
                typeof errObj?.httpStatus === 'number'
                  ? errObj.httpStatus
                  : typeof errObj?.status === 'number'
                    ? errObj.status
                    : undefined;
              const kind =
                typeof errObj?.kind === 'string'
                  ? errObj.kind
                  : status === 401 || /401|UNAUTHORIZED|失效|过期/i.test(msg)
                    ? 'UNAUTHORIZED'
                    : 'NETWORK_ERROR';
              return {
                ok: false as const,
                error: {
                  kind,
                  status,
                  httpStatus: status,
                  message: msg,
                  reauthRequired:
                    Boolean(errObj?.reauthRequired) ||
                    kind === 'UNAUTHORIZED' ||
                    status === 401,
                },
              };
            }
          }
        : undefined;

      let ret: unknown;
      act(() => {
        ret = mountBarFn({
          mode: 'published',
          publishedUrl: input.publishedUrl,
          url: input.publishedUrl,
          task: input.task,
          taskId: input.task.taskId,
          variantTitle: input.task.variantTitle,
          title: input.task.variantTitle,
          provider: input.task.provider,
          onConfirm: input.onConfirm,
          onConfirmPublished,
          onDismiss: input.onDismiss,
          doc: targetDoc,
          document: targetDoc,
        });
      });
      return {
        unmount: () => runUnmount(ret, targetDoc),
      };
    },
    mountPartialMediaNotice: (input: PartialNoticeMountInput) => {
      const targetDoc = input.doc ?? document;
      const fn = mountNoticeMatch?.fn ?? mountBarFn;
      const isOperatorNotice = mountNoticeMatch?.name === 'mountOperatorNoticeBar';
      let ret: unknown;
      act(() => {
        ret = fn(
          isOperatorNotice
            ? {
                provider: 'ZHIHU_EXT',
                variantTitle: input.taskTitle ?? '草稿配图提醒',
                uploadedImages: 0,
                failedImages: input.failedImages.length,
                failedImageDetails: input.failedImages,
                message: '部分图片转存失败，请手动上传',
                onDismiss: input.onDismiss,
                doc: targetDoc,
                document: targetDoc,
              }
            : {
                mode: 'partial-media',
                failedImages: input.failedImages,
                failedImageDetails: input.failedImages,
                taskTitle: input.taskTitle ?? '草稿配图提醒',
                variantTitle: input.taskTitle ?? '草稿配图提醒',
                onDismiss: input.onDismiss,
                doc: targetDoc,
                document: targetDoc,
              },
        );
      });
      return {
        unmount: () => runUnmount(ret, targetDoc),
      };
    },
    unmountAll: () => {
      act(() => {
        unmountFn?.();
      });
    },
    raw: mod,
  };
}

