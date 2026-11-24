import { z } from 'zod';
import {
  DraftInjectReportSchema,
  ExtensionMeDtoSchema,
  ExtensionProviderKeySchema,
  type ExtensionMeDto,
  type ExtensionPendingTaskDto,
} from './bridge-contract';
import { normalizeGeoMixBaseUrl } from './url-validation';

export const PAIRING_STORAGE_KEY = 'geomix.pairing.v1' as const;
export const TAB_TASKS_STORAGE_KEY = 'geomix.tabTasks.v1' as const;
export const PAIRING_TOKEN_PREFIX = 'gmext_' as const;
export const MAX_PAIRING_TOKEN_LENGTH = 512;

const GMEXT_TOKEN_PATTERN = /^gmext_[A-Za-z0-9._-]{8,}$/;

export type ChromeStorageAreaLike = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export type StoredPairingState = {
  baseUrl: string;
  token: string;
  me: ExtensionMeDto;
  pairedAt: string;
};

export type PublicPairingState = {
  baseUrl: string;
  me: ExtensionMeDto;
  pairedAt: string;
};

export type TokenValidationResult = { ok: true; token: string } | { ok: false; reason: string };

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function resolveLocalStorageArea(storageArea?: ChromeStorageAreaLike): ChromeStorageAreaLike {
  if (storageArea) {
    return storageArea;
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return chrome.storage.local;
  }
  throw new Error('扩展本地安全存储不可用');
}

export function validatePairingToken(rawToken: string): TokenValidationResult {
  if (typeof rawToken !== 'string') {
    return { ok: false, reason: '配对 Token 必须为字符串' };
  }
  if (rawToken.length > MAX_PAIRING_TOKEN_LENGTH) {
    return { ok: false, reason: `配对 Token 长度不能超过 ${MAX_PAIRING_TOKEN_LENGTH} 字符` };
  }
  if (hasControlChar(rawToken)) {
    return { ok: false, reason: '配对 Token 包含非法控制字符' };
  }

  const token = rawToken.trim();
  if (!token.startsWith(PAIRING_TOKEN_PREFIX)) {
    return { ok: false, reason: '配对 Token 必须以 gmext_ 开头' };
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: '配对 Token 不能包含空白字符' };
  }
  if (!GMEXT_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: '配对 Token 格式无效，请粘贴完整的 gmext_ 专用配对 Token' };
  }

  return { ok: true, token };
}

export function isValidGmextToken(rawToken: string): boolean {
  return validatePairingToken(rawToken).ok;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+(?:\[REDACTED\]|[^\s"'`<>)}\]]+)/gi, 'Bearer [REDACTED]')
    .replace(/gmext_(?:\[REDACTED\]|[^\s"'`<>)}\]]+)/gi, 'gmext_[REDACTED]');
}

export async function savePairing(
  input: {
    baseUrl: string;
    token: string;
    me: ExtensionMeDto;
    pairedAt?: string;
  },
  storageArea?: ChromeStorageAreaLike,
): Promise<StoredPairingState> {
  const baseResult = normalizeGeoMixBaseUrl(input.baseUrl);
  if (!baseResult.ok) {
    throw new Error(baseResult.reason);
  }

  const tokenResult = validatePairingToken(input.token);
  if (!tokenResult.ok) {
    throw new Error(tokenResult.reason);
  }

  const meResult = ExtensionMeDtoSchema.safeParse(input.me);
  if (!meResult.success) {
    throw new Error('账号配对信息不符合协议格式');
  }

  const pairedAt =
    typeof input.pairedAt === 'string' && input.pairedAt.trim().length > 0
      ? input.pairedAt.trim()
      : new Date().toISOString();

  const record: StoredPairingState = {
    baseUrl: baseResult.normalizedUrl,
    token: tokenResult.token,
    me: meResult.data,
    pairedAt,
  };

  const area = resolveLocalStorageArea(storageArea);
  await area.set({ [PAIRING_STORAGE_KEY]: record });
  return record;
}

export async function getPairing(
  storageArea?: ChromeStorageAreaLike,
): Promise<StoredPairingState | null> {
  const area = resolveLocalStorageArea(storageArea);
  const rawMap = await area.get(PAIRING_STORAGE_KEY);
  const raw = rawMap[PAIRING_STORAGE_KEY];

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.baseUrl !== 'string' ||
    typeof candidate.token !== 'string' ||
    typeof candidate.pairedAt !== 'string' ||
    candidate.pairedAt.trim().length === 0
  ) {
    return null;
  }

  const baseResult = normalizeGeoMixBaseUrl(candidate.baseUrl);
  if (!baseResult.ok) {
    return null;
  }

  const tokenResult = validatePairingToken(candidate.token);
  if (!tokenResult.ok) {
    return null;
  }

  const meResult = ExtensionMeDtoSchema.safeParse(candidate.me);
  if (!meResult.success) {
    return null;
  }

  return {
    baseUrl: baseResult.normalizedUrl,
    token: tokenResult.token,
    me: meResult.data,
    pairedAt: candidate.pairedAt.trim(),
  };
}

export async function getPublicPairing(
  storageArea?: ChromeStorageAreaLike,
): Promise<PublicPairingState | null> {
  const pairing = await getPairing(storageArea);
  if (!pairing) {
    return null;
  }
  return {
    baseUrl: pairing.baseUrl,
    me: pairing.me,
    pairedAt: pairing.pairedAt,
  };
}

export async function clearPairing(storageArea?: ChromeStorageAreaLike): Promise<void> {
  const area = resolveLocalStorageArea(storageArea);
  await area.remove(PAIRING_STORAGE_KEY);
}

export const PendingTabTaskSchema = z.object({
  tabId: z.number().int().positive(),
  taskId: z.string().min(1),
  articleId: z.string().min(1),
  brandId: z.string().min(1),
  brandName: z.string().min(1),
  provider: ExtensionProviderKeySchema,
  variantTitle: z.string().min(1),
  complianceChecklist: z.array(z.string()),
  injectedAt: z.string().min(1).optional(),
  lastInjectReport: DraftInjectReportSchema.optional(),
});

export type PendingTabTask = z.infer<typeof PendingTabTaskSchema>;
export type PendingTabTaskMap = Record<string, PendingTabTask>;

const POSITIVE_INT_KEY_PATTERN = /^[1-9]\d*$/;
const sessionStorageLocks = new WeakMap<ChromeStorageAreaLike, Promise<void>>();

function resolveSessionStorageArea(storageArea?: ChromeStorageAreaLike): ChromeStorageAreaLike {
  if (storageArea) {
    return storageArea;
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    return chrome.storage.session;
  }
  throw new Error('扩展会话存储不可用');
}

async function withSessionLock<T>(
  area: ChromeStorageAreaLike,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionStorageLocks.get(area) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current);
  sessionStorageLocks.set(area, chained);

  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent?.();
    if (sessionStorageLocks.get(area) === chained) {
      sessionStorageLocks.delete(area);
    }
  }
}

async function readSanitizedTabTaskMap(area: ChromeStorageAreaLike): Promise<PendingTabTaskMap> {
  const rawMap = await area.get(TAB_TASKS_STORAGE_KEY);
  const raw = rawMap[TAB_TASKS_STORAGE_KEY];
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const sanitized: PendingTabTaskMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!POSITIVE_INT_KEY_PATTERN.test(key)) {
      continue;
    }
    const parsed = PendingTabTaskSchema.safeParse(value);
    if (!parsed.success) {
      continue;
    }
    if (String(parsed.data.tabId) !== key) {
      continue;
    }
    sanitized[key] = parsed.data;
  }

  return sanitized;
}

export function createPendingTabTaskFromDto(
  tabId: number,
  task: ExtensionPendingTaskDto,
): PendingTabTask {
  const parsed = PendingTabTaskSchema.safeParse({
    tabId,
    taskId: task.taskId,
    articleId: task.articleId,
    brandId: task.brandId,
    brandName: task.brandName,
    provider: task.provider,
    variantTitle: task.variantTitle,
    complianceChecklist: [...task.complianceChecklist],
  });
  if (!parsed.success) {
    throw new Error('标签页任务上下文不符合协议格式');
  }
  return parsed.data;
}

export async function setPendingTabTask(
  task: PendingTabTask,
  storageArea?: ChromeStorageAreaLike,
): Promise<PendingTabTask> {
  const parsed = PendingTabTaskSchema.safeParse(task);
  if (!parsed.success) {
    throw new Error('标签页任务上下文不符合协议格式');
  }

  const area = resolveSessionStorageArea(storageArea);
  return withSessionLock(area, async () => {
    const map = await readSanitizedTabTaskMap(area);
    map[String(parsed.data.tabId)] = parsed.data;
    await area.set({ [TAB_TASKS_STORAGE_KEY]: map });
    return parsed.data;
  });
}

export async function getPendingTabTask(
  tabId: number,
  storageArea?: ChromeStorageAreaLike,
): Promise<PendingTabTask | null> {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return null;
  }
  const area = resolveSessionStorageArea(storageArea);
  const map = await readSanitizedTabTaskMap(area);
  return map[String(tabId)] ?? null;
}

export async function updatePendingTabTask(
  tabId: number,
  patch: Partial<Omit<PendingTabTask, 'tabId'>>,
  storageArea?: ChromeStorageAreaLike,
): Promise<PendingTabTask | null> {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return null;
  }
  const area = resolveSessionStorageArea(storageArea);
  return withSessionLock(area, async () => {
    const map = await readSanitizedTabTaskMap(area);
    const key = String(tabId);
    const existing = map[key];
    if (!existing) {
      return null;
    }

    const parsed = PendingTabTaskSchema.safeParse({
      ...existing,
      ...patch,
      tabId,
    });
    if (!parsed.success) {
      throw new Error('标签页任务上下文更新内容不符合协议格式');
    }

    map[key] = parsed.data;
    await area.set({ [TAB_TASKS_STORAGE_KEY]: map });
    return parsed.data;
  });
}

export async function removePendingTabTask(
  tabId: number,
  storageArea?: ChromeStorageAreaLike,
): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return;
  }
  const area = resolveSessionStorageArea(storageArea);
  await withSessionLock(area, async () => {
    const map = await readSanitizedTabTaskMap(area);
    const key = String(tabId);
    if (!(key in map)) {
      return;
    }
    delete map[key];
    if (Object.keys(map).length === 0) {
      await area.remove(TAB_TASKS_STORAGE_KEY);
      return;
    }
    await area.set({ [TAB_TASKS_STORAGE_KEY]: map });
  });
}

export async function listPendingTabTasks(
  storageArea?: ChromeStorageAreaLike,
): Promise<PendingTabTask[]> {
  const area = resolveSessionStorageArea(storageArea);
  const map = await readSanitizedTabTaskMap(area);
  return Object.values(map);
}

export async function clearPendingTabTasks(storageArea?: ChromeStorageAreaLike): Promise<void> {
  const area = resolveSessionStorageArea(storageArea);
  await withSessionLock(area, async () => {
    await area.remove(TAB_TASKS_STORAGE_KEY);
  });
}
