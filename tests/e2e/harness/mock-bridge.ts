import {
  SYNTHETIC_API_BASE_URL,
  SYNTHETIC_CDN_BASE_URL,
  SYNTHETIC_TOKEN,
  makeSyntheticMe,
  makeSyntheticTask,
  type ExtensionConfirmPublishedResult,
  type ExtensionMeDto,
  type ExtensionPendingTaskDto,
} from './contract-types.js';

export class UnmockedNetworkRequestError extends Error {
  constructor(public readonly url: string) {
    super(`Unmocked network request attempted: ${url}`);
    this.name = 'UnmockedNetworkRequestError';
  }
}

export class SsrfPolicyViolationError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`SSRF / Forbidden URL fetch attempted (${reason}): ${url}`);
    this.name = 'SsrfPolicyViolationError';
  }
}

export type BridgeEndpointKey = 'me' | 'tasks' | 'confirm-published';

export type BridgeFaultSpec =
  | { kind: 'http'; status: number; body?: unknown; headers?: Record<string, string>; contentType?: string }
  | { kind: 'invalid-json'; status?: number; rawBody: string }
  | { kind: 'network-error'; message?: string }
  | { kind: 'abort-error' };

export interface RecordedFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

export interface DeferredMediaHandle {
  url: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface MockBridgeOptions {
  baseUrl?: string;
  cdnBaseUrl?: string;
  validToken?: string;
  me?: ExtensionMeDto;
  tasks?: ExtensionPendingTaskDto[];
  tasksEnvelopeMode?: 'array' | 'items';
  deferConcurrentMedia?: boolean;
}

export interface MockBridgeController {
  readonly requests: RecordedFetchCall[];
  readonly bridgeRequests: RecordedFetchCall[];
  readonly mediaRequests: RecordedFetchCall[];
  readonly forbiddenFetchAttempts: Array<{ url: string; reason: string }>;
  readonly disallowedApiRoutes: string[];
  readonly publishRecords: ExtensionConfirmPublishedResult[];
  readonly deferredMedia: DeferredMediaHandle[];
  getInFlightMediaCount(): number;
  getMaxObservedMediaConcurrency(): number;
  resetMediaConcurrencyStats(): void;
  setTasks(tasks: ExtensionPendingTaskDto[]): void;
  setTasksEnvelopeMode(mode: 'array' | 'items'): void;
  setMe(me: ExtensionMeDto): void;
  revokeToken(token: string): void;
  addValidToken(token: string, me?: ExtensionMeDto): void;
  queueFault(endpoint: BridgeEndpointKey, fault: BridgeFaultSpec): void;
  setPersistentFault(endpoint: BridgeEndpointKey, fault: BridgeFaultSpec | null): void;
  releaseNextDeferredMedia(): boolean;
  releaseAllDeferredMedia(): void;
  restore(): void;
}

// Valid minimal image binary signatures
export function createMinimalPngBytes(
  extraPayload?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]);
  if (!extraPayload) {
    const out = new Uint8Array(new ArrayBuffer(128));
    out.set(signature, 0);
    return out;
  }
  const combined = new Uint8Array(
    new ArrayBuffer(signature.length + extraPayload.length),
  );
  combined.set(signature, 0);
  combined.set(extraPayload, signature.length);
  return combined;
}

export function createFullByteRangePngBytes(): Uint8Array<ArrayBuffer> {
  const allBytes = new Uint8Array(new ArrayBuffer(256));
  for (let i = 0; i < 256; i += 1) {
    allBytes[i] = i;
  }
  return createMinimalPngBytes(allBytes);
}

export function createMinimalJpegBytes(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(96));
  out.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

export function createMinimalWebpBytes(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(96));
  // RIFF....WEBP
  out.set([0x52, 0x49, 0x46, 0x46, 0x58, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 0);
  return out;
}

function isPrivateIpv4Octets(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    a >= 224 // multicast / reserved
  );
}

function isNonCanonicalNumericIpv4Authority(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    return false;
  }
  const authority = trimmed.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (!authority || authority.startsWith('[') || authority.includes('@')) {
    return false;
  }
  const rawHost = authority.replace(/:\d*$/, '').replace(/\.$/, '');
  if (!rawHost) {
    return false;
  }
  const labels = rawHost.split('.');
  if (labels.some((l) => l.length === 0)) {
    return false;
  }
  if (!labels.every((l) => /^(?:0x[\da-f]+|0[0-7]*|\d+)$/i.test(l))) {
    return false;
  }
  return !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(rawHost);
}

function isPrivateOrForbiddenHost(hostname: string): string | null {
  const isBracketedIpv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '0.0.0.0' ||
    lower === '::1' ||
    lower === '::' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.localdomain') ||
    lower.endsWith('.home.arpa') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.intranet')
  ) {
    return `forbidden host ${hostname}`;
  }

  if (isBracketedIpv6 || lower.includes(':')) {
    // Catch ALL IPv4-mapped IPv6 (both Node-normalized hex ::ffff:7f00:1 / ::ffff:a9fe:a9fe /
    // ::ffff:a00:1 / ::ffff:c0a8:101 / ::ffff:ac10:1 / ::ffff:0:0 and dotted ::ffff:127.0.0.1
    // or expanded 0:0:0:0:0:ffff:...)
    if (/^(?:0{0,4}:){0,5}:ffff:/i.test(lower)) {
      return `IPv4-mapped IPv6 ${hostname}`;
    }
    // Catch ULA (fc00::/7), Link-Local (fe80::/10), Site-Local (fec0::/10), Multicast (ff00::/8)
    if (/^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|fe[c-f][0-9a-f]|ff[0-9a-f]{2}):/i.test(lower)) {
      return `private/link-local IPv6 ${hostname}`;
    }
    if (lower.startsWith('::')) {
      return `reserved IPv6 ${hostname}`;
    }
    return null;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (isPrivateIpv4Octets(a, b)) {
      return `private/reserved IPv4 ${hostname}`;
    }
    return null;
  }

  // Single-label internal hostnames (e.g. "intranet", "metadata")
  if (!lower.includes('.')) {
    return `single-label host ${hostname}`;
  }

  return null;
}

function checkSsrfViolation(rawUrl: string): string | null {
  if (/^(javascript|file|data):/i.test(rawUrl.trim())) {
    return `forbidden scheme in ${rawUrl}`;
  }
  if (isNonCanonicalNumericIpv4Authority(rawUrl)) {
    return `non-canonical numeric IPv4 in ${rawUrl}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `invalid URL ${rawUrl}`;
  }
  if (parsed.protocol !== 'https:') {
    return `non-HTTPS protocol ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) {
    return 'embedded credentials in URL';
  }
  return isPrivateOrForbiddenHost(parsed.hostname);
}

function isAllowedPublicPublishedUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return false;
  }
  if (parsed.search || parsed.hash) {
    return false;
  }
  const clean = `${parsed.origin}${parsed.pathname}`;
  return (
    /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?$/.test(clean) ||
    /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+\/?$/.test(clean) ||
    /^https:\/\/www\.toutiao\.com\/article\/\d+\/?$/.test(clean) ||
    /^https:\/\/www\.toutiao\.com\/i\d+\/?$/.test(clean) ||
    /^https:\/\/post\.smzdm\.com\/p\/[a-zA-Z0-9]+\/?$/.test(clean)
  );
}

function normalizeHeaders(headersInit?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headersInit) {
    return result;
  }
  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      result[key.toLowerCase()] = value;
    }
  } else {
    for (const [key, value] of Object.entries(headersInit)) {
      if (value !== undefined) {
        result[key.toLowerCase()] = String(value);
      }
    }
  }
  return result;
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function makeChunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        const nextChunk = chunks[idx];
        idx += 1;
        if (nextChunk) {
          controller.enqueue(nextChunk);
        }
      } else {
        controller.close();
      }
    },
  });
}

export function createMockBridgeServer(
  options: MockBridgeOptions = {},
): MockBridgeController {
  const baseOrigin = new URL(options.baseUrl ?? SYNTHETIC_API_BASE_URL).origin;
  const cdnOrigin = new URL(options.cdnBaseUrl ?? SYNTHETIC_CDN_BASE_URL).origin;

  const validTokens = new Map<string, ExtensionMeDto>();
  validTokens.set(
    options.validToken ?? SYNTHETIC_TOKEN,
    options.me ?? makeSyntheticMe(),
  );

  let tasks: ExtensionPendingTaskDto[] = options.tasks ?? [
    makeSyntheticTask('ZHIHU_EXT'),
    makeSyntheticTask('TOUTIAO_EXT'),
    makeSyntheticTask('SMZDM_EXT'),
  ];
  let tasksEnvelopeMode: 'array' | 'items' = options.tasksEnvelopeMode ?? 'array';
  const deferConcurrentMedia = options.deferConcurrentMedia ?? false;

  const faultQueues = new Map<BridgeEndpointKey, BridgeFaultSpec[]>();
  const persistentFaults = new Map<BridgeEndpointKey, BridgeFaultSpec | null>();
  const idempotencyCache = new Map<string, ExtensionConfirmPublishedResult>();
  let publishRecordSeq = 1;

  const requests: RecordedFetchCall[] = [];
  const bridgeRequests: RecordedFetchCall[] = [];
  const mediaRequests: RecordedFetchCall[] = [];
  const forbiddenFetchAttempts: Array<{ url: string; reason: string }> = [];
  const disallowedApiRoutes: string[] = [];
  const publishRecords: ExtensionConfirmPublishedResult[] = [];
  const deferredMedia: DeferredMediaHandle[] = [];

  let inFlightMediaCount = 0;
  let maxObservedMediaConcurrency = 0;

  const previousFetch = globalThis.fetch;

  const applyFault = (endpoint: BridgeEndpointKey): Response | null => {
    const queue = faultQueues.get(endpoint);
    const fault =
      queue && queue.length > 0
        ? queue.shift() ?? null
        : (persistentFaults.get(endpoint) ?? null);
    if (!fault) {
      return null;
    }
    if (fault.kind === 'network-error') {
      throw new TypeError(fault.message ?? 'Failed to fetch');
    }
    if (fault.kind === 'abort-error') {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    if (fault.kind === 'invalid-json') {
      return new Response(fault.rawBody, {
        status: fault.status ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    const contentType = fault.contentType ?? 'application/json; charset=utf-8';
    const serialized =
      typeof fault.body === 'string'
        ? fault.body
        : JSON.stringify(
            fault.body ?? { code: fault.status * 100, msg: `HTTP ${fault.status}`, data: null },
          );
    return new Response(serialized, {
      status: fault.status,
      headers: {
        'content-type': contentType,
        ...(fault.headers ?? {}),
      },
    });
  };

  const handleMediaRequest = async (
    parsed: URL,
    headers: Record<string, string>,
    signal?: AbortSignal | null,
  ): Promise<Response> => {
    const name = parsed.pathname.split('/').pop() ?? '';

    inFlightMediaCount += 1;
    if (inFlightMediaCount > maxObservedMediaConcurrency) {
      maxObservedMediaConcurrency = inFlightMediaCount;
    }

    const decrement = (): void => {
      inFlightMediaCount = Math.max(0, inFlightMediaCount - 1);
    };

    try {
      if (name === 'slow-timeout.png') {
        await new Promise<void>((_, reject) => {
          const onAbort = (): void => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }

      if (deferConcurrentMedia && /^concurrent-\d+\.png$/i.test(name)) {
        await new Promise<void>((resolve, reject) => {
          deferredMedia.push({
            url: parsed.toString(),
            resolve,
            reject,
          });
        });
        const bytes = createMinimalPngBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.byteLength),
          },
        });
      }

      if (name === 'anti-hotlink.png') {
        if (headers['referer']) {
          return new Response('Hotlink Forbidden', { status: 403 });
        }
        const bytes = createMinimalPngBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.byteLength),
          },
        });
      }

      if (name === 'oversize-header.png') {
        return new Response(new Uint8Array(64), {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(10 * 1024 * 1024 + 1),
          },
        });
      }

      if (name === 'exact-10mb.png') {
        const exactBytes = new Uint8Array(10 * 1024 * 1024);
        exactBytes.set(createMinimalPngBytes().subarray(0, 8), 0);
        return new Response(exactBytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(exactBytes.byteLength),
          },
        });
      }

      if (name === 'oversize-stream.png' || name === 'oversize-spoofed-header.png') {
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < 11; i += 1) {
          chunks.push(new Uint8Array(1024 * 1024));
        }
        const respHeaders: Record<string, string> = { 'content-type': 'image/png' };
        if (name === 'oversize-spoofed-header.png') {
          respHeaders['content-length'] = '1024';
        }
        return new Response(makeChunkedStream(chunks), {
          status: 200,
          headers: respHeaders,
        });
      }

      if (name === 'streamed-valid.jpg') {
        const c1 = new Uint8Array(1024);
        c1.set(createMinimalJpegBytes().subarray(0, 10), 0);
        const c2 = new Uint8Array(2048);
        const c3 = new Uint8Array(1024);
        return new Response(makeChunkedStream([c1, c2, c3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }

      if (name === 'octet-stream.webp') {
        const bytes = createMinimalWebpBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.byteLength),
          },
        });
      }

      if (name === 'html-wall.png') {
        return new Response('<html><body>Please sign in</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (name === 'redirect-http.png' || name === 'redirect-private.png') {
        const resp = new Response(createMinimalPngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
        Object.defineProperty(resp, 'url', {
          value:
            name === 'redirect-http.png'
              ? 'http://cdn.example.com/media/a.png'
              : 'https://127.0.0.1/media/a.png',
        });
        return resp;
      }

      if (name === 'forbidden-403.png') {
        return new Response('Forbidden', { status: 403 });
      }
      if (name === 'missing-404.png') {
        return new Response('Not Found', { status: 404 });
      }
      if (name === 'error-500.png') {
        return new Response('Server Error', { status: 500 });
      }

      if (name === 'full-bytes.png') {
        const bytes = createFullByteRangePngBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.byteLength),
          },
        });
      }

      if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        const bytes = createMinimalJpegBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(bytes.byteLength),
          },
        });
      }
      if (name.endsWith('.webp')) {
        const bytes = createMinimalWebpBytes();
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/webp',
            'content-length': String(bytes.byteLength),
          },
        });
      }

      const bytes = createMinimalPngBytes();
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(bytes.byteLength),
        },
      });
    } finally {
      decrement();
    }
  };

  const mockedFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const ssrfReason = checkSsrfViolation(rawUrl);
    if (ssrfReason) {
      forbiddenFetchAttempts.push({ url: rawUrl, reason: ssrfReason });
      throw new SsrfPolicyViolationError(rawUrl, ssrfReason);
    }

    const parsed = new URL(rawUrl);
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : null;

    const record: RecordedFetchCall = {
      url: rawUrl,
      method,
      headers,
      bodyText,
    };
    requests.push(record);

    // Media CDN origin
    if (parsed.origin === cdnOrigin) {
      mediaRequests.push(record);
      return handleMediaRequest(parsed, headers, init?.signal);
    }

    // Bridge v1 API origin
    if (parsed.origin !== baseOrigin) {
      throw new UnmockedNetworkRequestError(rawUrl);
    }

    bridgeRequests.push(record);

    const authHeader = headers['authorization'] ?? '';
    const bearerMatch = /^Bearer\s+(\S+)$/.exec(authHeader);
    const token = bearerMatch?.[1] ?? '';

    const checkAuth = (): ExtensionMeDto | Response => {
      if (!token || !validTokens.has(token)) {
        return jsonResponse(
          { code: 40101, msg: 'Token invalid or revoked', data: null },
          401,
        );
      }
      return validTokens.get(token)!;
    };

    // Route 1: GET /api/v2/extension/me
    if (parsed.pathname === '/api/v2/extension/me' && method === 'GET') {
      const faultResp = applyFault('me');
      if (faultResp) {
        return faultResp;
      }
      const auth = checkAuth();
      if (auth instanceof Response) {
        return auth;
      }
      return jsonResponse({ code: 0, msg: 'ok', data: structuredClone(auth) }, 200);
    }

    // Route 2: GET /api/v2/extension/tasks
    if (parsed.pathname === '/api/v2/extension/tasks' && method === 'GET') {
      const faultResp = applyFault('tasks');
      if (faultResp) {
        return faultResp;
      }
      const auth = checkAuth();
      if (auth instanceof Response) {
        return auth;
      }
      const brandId = parsed.searchParams.get('brandId');
      const provider = parsed.searchParams.get('provider');
      const statusParam = parsed.searchParams.get('status');
      const statuses = statusParam
        ? statusParam.split(',').map((s) => s.trim()).filter(Boolean)
        : null;

      const filtered = tasks.filter((t) => {
        if (brandId && t.brandId !== brandId) {
          return false;
        }
        if (provider && t.provider !== provider) {
          return false;
        }
        if (statuses && statuses.length > 0 && !statuses.includes(t.status)) {
          return false;
        }
        return true;
      });

      const payloadData =
        tasksEnvelopeMode === 'items'
          ? { items: structuredClone(filtered) }
          : structuredClone(filtered);
      return jsonResponse({ code: 0, msg: 'ok', data: payloadData }, 200);
    }

    // Route 3: POST /api/v2/extension/tasks/:taskId/confirm-published
    const confirmMatch =
      /^\/api\/v2\/extension\/tasks\/([^/]+)\/confirm-published$/.exec(
        parsed.pathname,
      );
    if (confirmMatch && method === 'POST') {
      const faultResp = applyFault('confirm-published');
      if (faultResp) {
        return faultResp;
      }
      const auth = checkAuth();
      if (auth instanceof Response) {
        return auth;
      }
      const taskId = decodeURIComponent(confirmMatch[1] ?? '');
      const idemKey = headers['idempotency-key'] ?? '';
      if (!idemKey) {
        return jsonResponse(
          { code: 40001, msg: 'Missing Idempotency-Key header', data: null },
          400,
        );
      }

      let parsedBody: { publishedUrl?: string; publishedAt?: string };
      try {
        parsedBody = JSON.parse(bodyText ?? '{}') as {
          publishedUrl?: string;
          publishedAt?: string;
        };
      } catch {
        return jsonResponse(
          { code: 40002, msg: 'Invalid JSON body', data: null },
          400,
        );
      }

      const publishedUrl = parsedBody.publishedUrl ?? '';
      if (!isAllowedPublicPublishedUrl(publishedUrl)) {
        return jsonResponse(
          {
            code: 40003,
            msg: 'publishedUrl rejected by public article allowlist',
            data: null,
          },
          400,
        );
      }

      const cacheKey = `${taskId}::${idemKey}`;
      const existing = idempotencyCache.get(cacheKey);
      if (existing) {
        return jsonResponse({ code: 0, msg: 'ok', data: structuredClone(existing) }, 200);
      }

      const created: ExtensionConfirmPublishedResult = {
        taskId,
        status: 'PUBLISHED',
        publishRecordId: `pub_demo_${String(publishRecordSeq++).padStart(4, '0')}`,
        publishedUrl,
        crawlProbeQueued: true,
        retestMilestones: [7, 14, 30],
      };
      idempotencyCache.set(cacheKey, created);
      publishRecords.push(created);

      // Update task status in memory if seeded
      tasks = tasks.map((t) =>
        t.taskId === taskId ? { ...t, status: 'PUBLISHED' } : t,
      );

      return jsonResponse({ code: 0, msg: 'ok', data: structuredClone(created) }, 200);
    }

    // Any other route on the Bridge origin is outside the 3 thin endpoints!
    disallowedApiRoutes.push(`${method} ${parsed.pathname}`);
    return jsonResponse(
      { code: 40400, msg: `Disallowed Bridge endpoint: ${parsed.pathname}`, data: null },
      404,
    );
  };

  Object.defineProperty(globalThis, 'fetch', {
    value: mockedFetch,
    writable: true,
    configurable: true,
  });

  return {
    requests,
    bridgeRequests,
    mediaRequests,
    forbiddenFetchAttempts,
    disallowedApiRoutes,
    publishRecords,
    deferredMedia,

    getInFlightMediaCount() {
      return inFlightMediaCount;
    },

    getMaxObservedMediaConcurrency() {
      return maxObservedMediaConcurrency;
    },

    resetMediaConcurrencyStats() {
      inFlightMediaCount = 0;
      maxObservedMediaConcurrency = 0;
    },

    setTasks(nextTasks: ExtensionPendingTaskDto[]) {
      tasks = structuredClone(nextTasks);
    },

    setTasksEnvelopeMode(mode: 'array' | 'items') {
      tasksEnvelopeMode = mode;
    },

    setMe(me: ExtensionMeDto) {
      for (const k of validTokens.keys()) {
        validTokens.set(k, structuredClone(me));
      }
    },

    revokeToken(token: string) {
      validTokens.delete(token);
    },

    addValidToken(token: string, me?: ExtensionMeDto) {
      validTokens.set(token, structuredClone(me ?? options.me ?? makeSyntheticMe()));
    },

    queueFault(endpoint: BridgeEndpointKey, fault: BridgeFaultSpec) {
      const q = faultQueues.get(endpoint) ?? [];
      q.push(fault);
      faultQueues.set(endpoint, q);
    },

    setPersistentFault(endpoint: BridgeEndpointKey, fault: BridgeFaultSpec | null) {
      persistentFaults.set(endpoint, fault);
    },

    releaseNextDeferredMedia(): boolean {
      const next = deferredMedia.shift();
      if (!next) {
        return false;
      }
      next.resolve();
      return true;
    },

    releaseAllDeferredMedia() {
      while (deferredMedia.length > 0) {
        const next = deferredMedia.shift();
        next?.resolve();
      }
    },

    restore() {
      Object.defineProperty(globalThis, 'fetch', {
        value: previousFetch,
        writable: true,
        configurable: true,
      });
    },
  };
}
