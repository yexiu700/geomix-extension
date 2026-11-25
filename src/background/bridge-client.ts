import type { z } from 'zod';
import {
  DEFAULT_PENDING_TASK_STATUSES,
  EXTENSION_BRIDGE_PATHS,
  ExtensionConfirmPublishedInputSchema,
  ExtensionConfirmPublishedResultSchema,
  ExtensionMeDtoSchema,
  ExtensionTasksPayloadSchema,
  ExtensionTasksQuerySchema,
  RawApiEnvelopeSchema,
  type ExtensionConfirmPublishedInput,
  type ExtensionConfirmPublishedResult,
  type ExtensionMeDto,
  type ExtensionPendingTaskDto,
  type ExtensionProviderKey,
  type ExtensionTasksQuery,
} from '../shared/bridge-contract';
import type { BridgeErrorKind, SerializedBridgeError } from '../shared/messages';
import { redactSensitiveText, validatePairingToken } from '../shared/storage';
import { isCanonicalPublishedUrl, normalizeGeoMixBaseUrl } from '../shared/url-validation';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TASK_ID_LENGTH = 128;

export type BridgeErrorOptions = {
  httpStatus?: number;
  apiCode?: number;
  reauthRequired?: boolean;
  cause?: unknown;
};

function sanitizeErrorCause(cause: unknown): Error | undefined {
  if (cause === undefined) {
    return undefined;
  }
  if (cause instanceof Error) {
    const sanitized = new Error(redactSensitiveText(cause.message));
    sanitized.name = redactSensitiveText(cause.name);
    delete sanitized.stack;
    return sanitized;
  }
  if (typeof cause === 'string') {
    const sanitized = new Error(redactSensitiveText(cause));
    delete sanitized.stack;
    return sanitized;
  }
  return undefined;
}

export class BridgeError extends Error {
  readonly kind: BridgeErrorKind;
  readonly httpStatus?: number;
  readonly apiCode?: number;
  readonly reauthRequired: boolean;

  constructor(kind: BridgeErrorKind, message: string, options?: BridgeErrorOptions) {
    const sanitizedCause = sanitizeErrorCause(options?.cause);
    super(
      redactSensitiveText(message),
      sanitizedCause !== undefined ? { cause: sanitizedCause } : undefined,
    );
    this.name = 'BridgeError';
    this.kind = kind;
    if (options?.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options?.apiCode !== undefined) {
      this.apiCode = options.apiCode;
    }
    this.reauthRequired =
      options?.reauthRequired ?? (kind === 'UNAUTHORIZED' || kind === 'NOT_PAIRED');
  }
}

export function serializeBridgeError(error: unknown): SerializedBridgeError {
  if (error instanceof BridgeError) {
    return {
      kind: error.kind,
      message: redactSensitiveText(error.message),
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.apiCode !== undefined ? { apiCode: error.apiCode } : {}),
      reauthRequired: error.reauthRequired,
    };
  }
  const rawMessage = error instanceof Error ? error.message : '未知错误';
  return {
    kind: 'NETWORK_ERROR',
    message: redactSensitiveText(rawMessage),
    reauthRequired: false,
  };
}

function mapHttpStatusToErrorKind(status: number): BridgeErrorKind | null {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return null;
}

function mapBusinessCodeToErrorKind(apiCode: number): BridgeErrorKind | null {
  if (apiCode === 401 || (apiCode >= 40100 && apiCode < 40200)) {
    return 'UNAUTHORIZED';
  }
  return null;
}

function defaultErrorMessageForKind(kind: BridgeErrorKind): string {
  switch (kind) {
    case 'UNAUTHORIZED':
      return '配对 Token 已失效或被吊销，请重新配对 GeoMix 账号。';
    case 'FORBIDDEN':
      return '当前租户或 Token 权限不足，请检查 GeoMix 控制台状态。';
    case 'BAD_REQUEST':
      return '请求参数或公网 URL 未通过服务端校验。';
    case 'NOT_FOUND':
      return '未找到对应的分发任务或接口路径。';
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍后再试。';
    case 'SERVER_ERROR':
      return 'GeoMix 服务端暂时不可用，请稍后重试。';
    case 'API_ERROR':
      return 'GeoMix 服务返回业务错误，请稍后重试。';
    case 'INVALID_RESPONSE':
      return 'GeoMix 服务返回了无法解析的响应内容。';
    case 'SCHEMA_VALIDATION':
      return '接口返回数据不符合 Bridge v1 协议格式。';
    case 'TIMEOUT':
      return '请求 GeoMix 服务超时，请检查网络后重试。';
    case 'NETWORK_ERROR':
      return '无法连接 GeoMix 服务，请检查实例地址或网络权限。';
    default:
      return '请求 GeoMix 服务失败，请稍后重试。';
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateTaskId(rawTaskId: string): string {
  if (typeof rawTaskId !== 'string' || hasControlChar(rawTaskId)) {
    throw new BridgeError('INVALID_INPUT', 'taskId 格式无效');
  }
  const taskId = rawTaskId.trim();
  if (
    taskId.length === 0 ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    taskId === '.' ||
    taskId === '..' ||
    taskId.includes('..') ||
    !SAFE_TASK_ID_PATTERN.test(taskId)
  ) {
    throw new BridgeError('INVALID_INPUT', 'taskId 格式无效');
  }
  return taskId;
}

function fallbackDeterministicHashHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch ^ ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export async function deriveConfirmPublishedIdempotencyKey(
  taskId: string,
  canonicalPublishedUrl: string,
): Promise<string> {
  const normalizedUrl = canonicalPublishedUrl.replace(/\/+$/, '');
  const payload = `confirm-published:v1:${taskId.trim()}:${normalizedUrl}`;

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle?.digest) {
    const bytes = new TextEncoder().encode(payload);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return `gmext-confirm-${hex.slice(0, 32)}`;
  }

  return `gmext-confirm-${fallbackDeterministicHashHex(payload)}`;
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

async function readResponseTextWithSignal(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      try {
        if (response.body && !response.body.locked) {
          void response.body.cancel().catch(() => {});
        }
      } catch {
        // Best-effort cancellation
      }
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    response.text().then(
      (text) => {
        signal.removeEventListener('abort', onAbort);
        resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export type BridgeClientOptions = {
  baseUrl: string;
  token: string;
  extensionVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ConfirmPublishedOptions = {
  provider?: ExtensionProviderKey;
  idempotencyKey?: string;
};

export class BridgeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #extensionVersion: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: BridgeClientOptions) {
    const baseResult = normalizeGeoMixBaseUrl(options.baseUrl);
    if (!baseResult.ok) {
      throw new BridgeError('INVALID_BASE_URL', baseResult.reason);
    }

    const tokenResult = validatePairingToken(options.token);
    if (!tokenResult.ok) {
      throw new BridgeError('INVALID_TOKEN', tokenResult.reason);
    }

    const version = options.extensionVersion.trim();
    if (version.length === 0 || hasControlChar(version)) {
      throw new BridgeError('INVALID_INPUT', '扩展版本号无效');
    }

    const fetchFn =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (typeof fetchFn !== 'function') {
      throw new BridgeError('NETWORK_ERROR', '当前运行环境不支持 fetch 网络请求');
    }

    this.#baseUrl = baseResult.normalizedUrl;
    this.#token = tokenResult.token;
    this.#extensionVersion = version;
    this.#fetch = fetchFn;
    this.#timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
  }

  async getMe(): Promise<ExtensionMeDto> {
    return this.#request({
      method: 'GET',
      path: EXTENSION_BRIDGE_PATHS.ME,
      dataSchema: ExtensionMeDtoSchema,
    });
  }

  async getTasks(query?: ExtensionTasksQuery): Promise<ExtensionPendingTaskDto[]> {
    const parsedQuery = ExtensionTasksQuerySchema.safeParse(query ?? {});
    if (!parsedQuery.success) {
      throw new BridgeError('INVALID_INPUT', '任务筛选参数格式无效');
    }

    const params = new URLSearchParams();
    if (parsedQuery.data.brandId) {
      params.set('brandId', parsedQuery.data.brandId);
    }
    if (parsedQuery.data.provider) {
      params.set('provider', parsedQuery.data.provider);
    }
    const statuses = parsedQuery.data.status ?? DEFAULT_PENDING_TASK_STATUSES;
    params.set('status', statuses.join(','));

    return this.#request({
      method: 'GET',
      path: `${EXTENSION_BRIDGE_PATHS.TASKS}?${params.toString()}`,
      dataSchema: ExtensionTasksPayloadSchema,
    });
  }

  async confirmPublished(
    taskId: string,
    input: ExtensionConfirmPublishedInput,
    options?: ConfirmPublishedOptions,
  ): Promise<ExtensionConfirmPublishedResult> {
    const validTaskId = validateTaskId(taskId);

    const parsedInput = ExtensionConfirmPublishedInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new BridgeError(
        'INVALID_INPUT',
        '公网文章 URL 必须为合法的 https:// 平台公网文章链接且不含 Query 参数',
      );
    }

    if (
      options?.provider !== undefined &&
      !isCanonicalPublishedUrl(parsedInput.data.publishedUrl, options.provider)
    ) {
      throw new BridgeError('INVALID_INPUT', '公网文章 URL 与目标平台白名单不匹配');
    }

    const parsedUrl = new URL(parsedInput.data.publishedUrl);
    const canonicalUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/+$/, '');
    const customKey = options?.idempotencyKey?.trim();
    const idempotencyKey =
      customKey && customKey.length > 0 && !hasControlChar(customKey)
        ? customKey
        : await deriveConfirmPublishedIdempotencyKey(validTaskId, canonicalUrl);

    const bodyPayload: ExtensionConfirmPublishedInput = {
      publishedUrl: canonicalUrl,
      ...(parsedInput.data.publishedAt !== undefined
        ? { publishedAt: parsedInput.data.publishedAt }
        : {}),
    };

    return this.#request({
      method: 'POST',
      path: EXTENSION_BRIDGE_PATHS.confirmPublished(validTaskId),
      dataSchema: ExtensionConfirmPublishedResultSchema,
      extraHeaders: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(bodyPayload),
    });
  }

  async #request<T>(params: {
    method: 'GET' | 'POST';
    path: string;
    dataSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
    extraHeaders?: Record<string, string>;
    body?: string;
  }): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    let rawText: string;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#token}`,
        'X-GeoMix-Extension-Version': this.#extensionVersion,
        Accept: 'application/json',
        ...(params.extraHeaders ?? {}),
      };

      try {
        const fetchFn = this.#fetch;
        response = await fetchFn(`${this.#baseUrl}${params.path}`, {
          method: params.method,
          headers,
          body: params.body,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
          throw new BridgeError('TIMEOUT', defaultErrorMessageForKind('TIMEOUT'), { cause: error });
        }
        throw new BridgeError('NETWORK_ERROR', defaultErrorMessageForKind('NETWORK_ERROR'), {
          cause: error,
        });
      }

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        try {
          if (response.body) {
            await response.body.cancel();
          }
        } catch {
          // Best-effort stream cleanup
        }
        throw new BridgeError('NETWORK_ERROR', 'GeoMix 服务返回了未受信任的重定向响应，已拦截。', {
          httpStatus: response.status,
        });
      }

      try {
        rawText = await readResponseTextWithSignal(response, controller.signal);
      } catch (error: unknown) {
        if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
          throw new BridgeError('TIMEOUT', defaultErrorMessageForKind('TIMEOUT'), { cause: error });
        }
        throw new BridgeError('INVALID_RESPONSE', defaultErrorMessageForKind('INVALID_RESPONSE'), {
          httpStatus: response.status,
          cause: error,
        });
      }
    } finally {
      clearTimeout(timer);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      const mappedKind = mapHttpStatusToErrorKind(response.status) ?? 'INVALID_RESPONSE';
      throw new BridgeError(mappedKind, defaultErrorMessageForKind(mappedKind), {
        httpStatus: response.status,
      });
    }

    const envelopeResult = RawApiEnvelopeSchema.safeParse(parsedJson);
    if (!envelopeResult.success) {
      const mappedKind = mapHttpStatusToErrorKind(response.status) ?? 'INVALID_RESPONSE';
      throw new BridgeError(mappedKind, defaultErrorMessageForKind(mappedKind), {
        httpStatus: response.status,
      });
    }

    const envelope = envelopeResult.data;
    if (!response.ok || envelope.code !== 0) {
      const mappedKind =
        mapHttpStatusToErrorKind(response.status) ??
        mapBusinessCodeToErrorKind(envelope.code) ??
        'API_ERROR';
      const serverMsg = envelope.msg.trim();
      const message = serverMsg.length > 0 ? serverMsg : defaultErrorMessageForKind(mappedKind);
      throw new BridgeError(mappedKind, message, {
        httpStatus: response.status,
        apiCode: envelope.code,
      });
    }

    if (envelope.data === null || envelope.data === undefined) {
      throw new BridgeError('SCHEMA_VALIDATION', '接口返回数据为空', {
        httpStatus: response.status,
        apiCode: envelope.code,
      });
    }

    const validatedData = params.dataSchema.safeParse(envelope.data);
    if (!validatedData.success) {
      throw new BridgeError('SCHEMA_VALIDATION', defaultErrorMessageForKind('SCHEMA_VALIDATION'), {
        httpStatus: response.status,
        apiCode: envelope.code,
      });
    }

    return validatedData.data;
  }
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  return new BridgeClient(options);
}
