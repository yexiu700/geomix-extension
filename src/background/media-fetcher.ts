import type { ExtensionMediaAsset } from '../shared/bridge-contract';
import type { FetchMediaAssetResult, MediaFetchErrorCode } from '../shared/messages';
import { redactSensitiveText } from '../shared/storage';
import { validateMediaAssetUrl } from '../shared/url-validation';

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_MEDIA_TIMEOUT_MS = 15_000;
export const MAX_MEDIA_CONCURRENCY = 2;
export const MAX_MEDIA_REDIRECTS = 3;

const BASE64_CHUNK_SIZE = 0x4000; // 16 KiB per chunk to avoid call-stack limits
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export const ALLOWED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};

export class ConcurrencySemaphore {
  readonly #maxConcurrency: number;
  #inFlight = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number = MAX_MEDIA_CONCURRENCY) {
    const normalized = Number.isFinite(limit) ? Math.floor(limit) : MAX_MEDIA_CONCURRENCY;
    this.#maxConcurrency = Math.max(1, Math.min(MAX_MEDIA_CONCURRENCY, normalized));
  }

  getInFlightCount(): number {
    return this.#inFlight;
  }

  async acquire(): Promise<() => void> {
    if (this.#inFlight < this.#maxConcurrency) {
      this.#inFlight += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
      // Slot ownership was transferred directly by release(); do not increment #inFlight again.
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.#queue.shift();
      if (next) {
        next();
      } else {
        this.#inFlight -= 1;
      }
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export type MediaFetcherOptions = {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  maxConcurrency?: number;
  semaphore?: ConcurrencySemaphore;
};

export type FetchMediaAssetOptions = MediaFetcherOptions & {
  index?: number;
};

export type MediaFetcher = {
  fetchMediaAsset: (
    asset: ExtensionMediaAsset,
    options?: Pick<FetchMediaAssetOptions, 'index'>,
  ) => Promise<FetchMediaAssetResult>;
  fetchMediaAssets: (assets: ExtensionMediaAsset[]) => Promise<FetchMediaAssetResult[]>;
  getInFlightCount: () => number;
};

const defaultMediaSemaphore = new ConcurrencySemaphore(MAX_MEDIA_CONCURRENCY);

function normalizeMime(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const base = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (base.length === 0) {
    return null;
  }
  if (base === 'image/jpg') {
    return 'image/jpeg';
  }
  return base;
}

function isOctetStreamMime(mime: string | null): boolean {
  return mime === 'application/octet-stream' || mime === 'binary/octet-stream';
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) {
    return '';
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i]!);
  }
  return out;
}

function sniffRasterImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6) {
    const header6 = asciiAt(bytes, 0, 6);
    if (header6 === 'GIF87a' || header6 === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (
    bytes.length >= 14 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x4d &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0
  ) {
    const pixelDataOffset =
      (bytes[10]! | (bytes[11]! << 8) | (bytes[12]! << 16) | (bytes[13]! << 24)) >>> 0;
    if (pixelDataOffset >= 14) {
      return 'image/bmp';
    }
  }
  if (bytes.length >= 12 && asciiAt(bytes, 4, 4) === 'ftyp') {
    const majorBrand = asciiAt(bytes, 8, 4);
    if (majorBrand === 'avif' || majorBrand === 'avis') {
      return 'image/avif';
    }
    const maxScan = Math.min(bytes.length, 64);
    for (let offset = 16; offset + 4 <= maxScan; offset += 4) {
      const brand = asciiAt(bytes, offset, 4);
      if (brand === 'avif' || brand === 'avis') {
        return 'image/avif';
      }
    }
  }
  return null;
}

function looksLikeMarkupPayload(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  const end = Math.min(bytes.length, start + 256);
  let text = '';
  for (let i = start; i < end; i += 1) {
    text += String.fromCharCode(bytes[i]!);
  }
  const trimmed = text.trimStart().toLowerCase();
  return (
    trimmed.startsWith('<svg') ||
    trimmed.startsWith('<?xml') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html')
  );
}

function classifyUrlValidationFailure(rawUrl: string): MediaFetchErrorCode {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return 'INVALID_URL';
  }
  try {
    new URL(rawUrl.trim());
    return 'SSRF_BLOCKED';
  } catch {
    return 'INVALID_URL';
  }
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const slice = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(parts.join(''));
}

export function deriveSafeMediaFilename(url: URL, mime: string, index?: number): string {
  const ext = MIME_TO_EXTENSION[mime] ?? '.png';
  const fallbackBase = index !== undefined ? `geomix-image-${index + 1}` : 'geomix-image';

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const rawSegment = segments[segments.length - 1] ?? '';
  let decoded = rawSegment;
  if (rawSegment.length > 0) {
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      decoded = rawSegment;
    }
  }

  const decodedParts = decoded
    .split(/[/\\]+/)
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
  const candidate = decodedParts[decodedParts.length - 1] ?? '';

  let sanitized = '';
  for (let i = 0; i < candidate.length; i += 1) {
    const code = candidate.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    sanitized += candidate[i]!;
  }

  sanitized = sanitized
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/\.\.+/g, '-')
    .replace(/[\s-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '');

  const baseName =
    sanitized.length > 0 && !sanitized.includes('..') && !sanitized.startsWith('.')
      ? sanitized
      : fallbackBase;
  return `${baseName}${ext}`;
}

async function cancelBodySafely(response: Response): Promise<void> {
  try {
    if (response.body) {
      await response.body.cancel();
    }
  } catch {
    // Best-effort cancellation
  }
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: 'TOO_LARGE' }> {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await raceWithAbort(reader.read(), controller.signal);
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          return { ok: false, code: 'TOO_LARGE' };
        }
        chunks.push(value);
      }
    } catch (error: unknown) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors on cancelled streams
      }
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: merged };
  }

  const buffer = await raceWithAbort(response.arrayBuffer(), controller.signal);
  if (buffer.byteLength > maxBytes) {
    controller.abort();
    return { ok: false, code: 'TOO_LARGE' };
  }
  return { ok: true, bytes: new Uint8Array(buffer) };
}

function buildFailure(
  asset: ExtensionMediaAsset,
  code: MediaFetchErrorCode,
  reason: string,
): FetchMediaAssetResult {
  return {
    ok: false,
    url: asset.url,
    alt: asset.alt,
    code,
    reason: redactSensitiveText(reason),
  };
}

async function fetchSingleAssetUnthrottled(
  asset: ExtensionMediaAsset,
  options: FetchMediaAssetOptions,
): Promise<FetchMediaAssetResult> {
  const maxBytes =
    typeof options.maxBytes === 'number' &&
    Number.isFinite(options.maxBytes) &&
    options.maxBytes > 0
      ? options.maxBytes
      : MAX_MEDIA_BYTES;
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_MEDIA_TIMEOUT_MS;
  const maxRedirects =
    typeof options.maxRedirects === 'number' &&
    Number.isFinite(options.maxRedirects) &&
    options.maxRedirects >= 0
      ? Math.floor(options.maxRedirects)
      : MAX_MEDIA_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    return buildFailure(asset, 'NETWORK_ERROR', '当前运行环境不支持图片网络拉取');
  }

  const initialUrlCheck = validateMediaAssetUrl(asset.url);
  if (!initialUrlCheck.ok) {
    return buildFailure(asset, classifyUrlValidationFailure(asset.url), initialUrlCheck.reason);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let currentUrl = initialUrlCheck.normalizedUrl;
    let currentParsedUrl = initialUrlCheck.url;
    let finalResponse: Response | null = null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await raceWithAbort(
        fetchImpl(currentUrl, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'manual',
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (response.type === 'opaqueredirect') {
        await cancelBodySafely(response);
        return buildFailure(asset, 'SSRF_BLOCKED', '检测到无法校验目标的重定向响应，已拦截');
      }

      if (REDIRECT_STATUS_CODES.has(response.status)) {
        await cancelBodySafely(response);
        if (hop >= maxRedirects) {
          return buildFailure(asset, 'REDIRECT_LIMIT', `图片重定向次数超过 ${maxRedirects} 次上限`);
        }
        const location = response.headers.get('location')?.trim();
        if (!location) {
          return buildFailure(asset, 'SSRF_BLOCKED', '重定向响应缺少有效 Location 地址');
        }
        let resolvedRedirectUrl: string;
        try {
          resolvedRedirectUrl = new URL(location, currentUrl).toString();
        } catch {
          return buildFailure(asset, 'SSRF_BLOCKED', '重定向目标地址格式无效');
        }
        const redirectCheck = validateMediaAssetUrl(resolvedRedirectUrl);
        if (!redirectCheck.ok) {
          return buildFailure(
            asset,
            'SSRF_BLOCKED',
            `重定向目标地址不安全：${redirectCheck.reason}`,
          );
        }
        currentUrl = redirectCheck.normalizedUrl;
        currentParsedUrl = redirectCheck.url;
        continue;
      }

      finalResponse = response;
      break;
    }

    if (!finalResponse) {
      return buildFailure(asset, 'REDIRECT_LIMIT', `图片重定向次数超过 ${maxRedirects} 次上限`);
    }

    if (typeof finalResponse.url === 'string' && finalResponse.url.trim().length > 0) {
      const finalUrlCheck = validateMediaAssetUrl(finalResponse.url);
      if (!finalUrlCheck.ok) {
        await cancelBodySafely(finalResponse);
        return buildFailure(
          asset,
          'SSRF_BLOCKED',
          `响应最终地址未通过安全校验：${finalUrlCheck.reason}`,
        );
      }
      currentParsedUrl = finalUrlCheck.url;
    }

    if (!finalResponse.ok) {
      await cancelBodySafely(finalResponse);
      return buildFailure(asset, 'HTTP_ERROR', `图片下载失败（HTTP ${finalResponse.status}）`);
    }

    const headerMime = normalizeMime(finalResponse.headers.get('content-type'));

    if (headerMime !== null && !isOctetStreamMime(headerMime)) {
      if (!ALLOWED_IMAGE_MIME_TYPES.has(headerMime)) {
        await cancelBodySafely(finalResponse);
        return buildFailure(asset, 'UNSUPPORTED_MIME', `不支持的图片 MIME 类型：${headerMime}`);
      }
    } else {
      const hintMime = normalizeMime(asset.mime);
      if (hintMime !== null && !ALLOWED_IMAGE_MIME_TYPES.has(hintMime)) {
        await cancelBodySafely(finalResponse);
        return buildFailure(asset, 'UNSUPPORTED_MIME', `不支持的图片 MIME 类型：${hintMime}`);
      }
    }

    const rawContentLength = finalResponse.headers.get('content-length')?.trim();
    if (rawContentLength && /^\d+$/.test(rawContentLength)) {
      const declaredBytes = Number(rawContentLength);
      if (!Number.isFinite(declaredBytes) || declaredBytes > maxBytes) {
        await cancelBodySafely(finalResponse);
        return buildFailure(asset, 'TOO_LARGE', '图片体积超过 10MB 上限');
      }
    }

    const bodyResult = await readResponseBytesWithLimit(finalResponse, maxBytes, controller);
    if (!bodyResult.ok) {
      return buildFailure(asset, 'TOO_LARGE', '图片体积超过 10MB 上限');
    }

    const { bytes } = bodyResult;
    if (bytes.byteLength === 0) {
      return buildFailure(asset, 'EMPTY_BODY', '图片内容为空');
    }

    if (looksLikeMarkupPayload(bytes)) {
      return buildFailure(asset, 'UNSUPPORTED_MIME', '检测到非图片标记内容，已拒绝上传');
    }

    const sniffedMime = sniffRasterImageMime(bytes);
    if (sniffedMime === null) {
      return buildFailure(asset, 'UNSUPPORTED_MIME', '无法识别为受支持的栅格图片格式');
    }
    const resolvedMime = sniffedMime;

    const filename = deriveSafeMediaFilename(currentParsedUrl, resolvedMime, options.index);
    const base64 = uint8ArrayToBase64(bytes);

    return {
      ok: true,
      url: asset.url,
      alt: asset.alt,
      base64,
      mime: resolvedMime,
      filename,
      byteLength: bytes.byteLength,
    };
  } catch (error: unknown) {
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      return buildFailure(asset, 'TIMEOUT', '图片下载超时（超过 15 秒）');
    }
    const message = error instanceof Error ? error.message : '图片下载发生网络错误';
    return buildFailure(asset, 'NETWORK_ERROR', message);
  } finally {
    clearTimeout(timer);
  }
}

export function createMediaFetcher(options?: MediaFetcherOptions): MediaFetcher {
  const semaphore =
    options?.semaphore ??
    new ConcurrencySemaphore(options?.maxConcurrency ?? MAX_MEDIA_CONCURRENCY);

  const runAsset = (
    asset: ExtensionMediaAsset,
    extra?: Pick<FetchMediaAssetOptions, 'index'>,
  ): Promise<FetchMediaAssetResult> => {
    return semaphore.run(() =>
      fetchSingleAssetUnthrottled(asset, {
        ...options,
        index: extra?.index,
      }),
    );
  };

  return {
    fetchMediaAsset: runAsset,
    fetchMediaAssets: (assets: ExtensionMediaAsset[]) =>
      Promise.all(assets.map((asset, index) => runAsset(asset, { index }))),
    getInFlightCount: () => semaphore.getInFlightCount(),
  };
}

export async function fetchMediaAsset(
  asset: ExtensionMediaAsset,
  options?: FetchMediaAssetOptions,
): Promise<FetchMediaAssetResult> {
  const semaphore = options?.semaphore ?? defaultMediaSemaphore;
  return semaphore.run(() => fetchSingleAssetUnthrottled(asset, options ?? {}));
}

export async function fetchMediaAssets(
  assets: ExtensionMediaAsset[],
  options?: FetchMediaAssetOptions,
): Promise<FetchMediaAssetResult[]> {
  const semaphore = options?.semaphore ?? defaultMediaSemaphore;
  return Promise.all(
    assets.map((asset, index) =>
      semaphore.run(() =>
        fetchSingleAssetUnthrottled(asset, {
          ...options,
          index,
        }),
      ),
    ),
  );
}
