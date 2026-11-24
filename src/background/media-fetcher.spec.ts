import { describe, expect, it, vi } from 'vitest';
import {
  ConcurrencySemaphore,
  createMediaFetcher,
  deriveSafeMediaFilename,
  fetchMediaAsset,
  fetchMediaAssets,
  MAX_MEDIA_BYTES,
  uint8ArrayToBase64,
} from './media-fetcher';

const PNG_MAGIC_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const JPEG_MAGIC_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeByteResponse(
  bytes: Uint8Array,
  init?: { status?: number; headers?: Record<string, string>; url?: string },
): Response {
  const response = new Response(bytes.slice().buffer, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
  if (init?.url) {
    Object.defineProperty(response, 'url', { value: init.url, configurable: true });
  }
  return response;
}

describe('background/media-fetcher', () => {
  it('fetches public HTTPS image with credentials: omit and redirect: manual, returning sanitized filename and exact Base64', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeByteResponse(PNG_MAGIC_BYTES, {
        headers: {
          'content-type': 'image/png; charset=binary',
          'content-length': String(PNG_MAGIC_BYTES.byteLength),
        },
        url: 'https://cdn.example.com/uploads/demo%20photo.jpeg?w=800',
      }),
    );

    const result = await fetchMediaAsset(
      { url: 'https://cdn.example.com/uploads/demo%20photo.jpeg?w=800', alt: '实测图一' },
      { fetchImpl: fetchMock, semaphore: new ConcurrencySemaphore(2) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example.com/uploads/demo%20photo.jpeg?w=800',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
      }),
    );

    expect(result).toEqual({
      ok: true,
      url: 'https://cdn.example.com/uploads/demo%20photo.jpeg?w=800',
      alt: '实测图一',
      base64: uint8ArrayToBase64(PNG_MAGIC_BYTES),
      mime: 'image/png',
      filename: 'demo-photo.png',
      byteLength: PNG_MAGIC_BYTES.byteLength,
    });
  });

  it('encodes multi-chunk binary buffers to Base64 without stack overflow and derives safe filenames', () => {
    const large = new Uint8Array(128 * 1024);
    for (let i = 0; i < large.length; i += 1) {
      large[i] = i & 0xff;
    }
    const encoded = uint8ArrayToBase64(large);
    expect(encoded.length).toBeGreaterThan(100_000);
    expect(atob(encoded).charCodeAt(12345)).toBe(12345 & 0xff);

    expect(
      deriveSafeMediaFilename(
        new URL('https://cdn.example.com/..secret/..bad:name?.jpg'),
        'image/webp',
        2,
      ),
    ).toBe('bad-name.webp');
    expect(deriveSafeMediaFilename(new URL('https://cdn.example.com/'), 'image/jpeg', 0)).toBe(
      'geomix-image-1.jpg',
    );
  });

  it('blocks SSRF targets: non-HTTPS, loopback, RFC1918, metadata IP, IPv6 private, credentials, and .local', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const blockedUrls = [
      'http://cdn.example.com/img.png',
      'https://127.0.0.1/img.png',
      'https://10.0.0.1/img.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/img.png',
      'https://[fc00::1]/img.png',
      'https://user:pass@cdn.example.com/img.png',
      'https://nas.local/img.png',
    ];

    for (const url of blockedUrls) {
      const res = await fetchMediaAsset(
        { url, alt: 'blocked' },
        { fetchImpl: fetchMock, semaphore: new ConcurrencySemaphore(2) },
      );
      expect(res.ok, url).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('SSRF_BLOCKED');
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows valid HTTPS public redirects up to 3 hops and blocks unsafe redirects, redirect loops, opaqueredirect, and unsafe response.url', async () => {
    const validRedirectFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: '/hop-2.png' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://assets.example.com/final.png' },
        }),
      )
      .mockResolvedValueOnce(
        makeByteResponse(PNG_MAGIC_BYTES, {
          headers: { 'content-type': 'image/png' },
          url: 'https://assets.example.com/final.png',
        }),
      );

    const okRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/start.png', alt: 'redirect-ok' },
      { fetchImpl: validRedirectFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(okRes.ok).toBe(true);
    expect(validRedirectFetch).toHaveBeenCalledTimes(3);

    // Redirect to private IP blocked
    const ssrfRedirectFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret.png' } }),
      );
    const ssrfRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/start.png', alt: 'redirect-ssrf' },
      { fetchImpl: ssrfRedirectFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(ssrfRes).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });

    // > 3 redirects blocked
    const loopFetch = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/next.png' },
        }),
    );
    const loopRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/start.png', alt: 'redirect-loop' },
      { fetchImpl: loopFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(loopRes).toMatchObject({ ok: false, code: 'REDIRECT_LIMIT' });
    expect(loopFetch).toHaveBeenCalledTimes(4);

    // opaqueredirect blocked fail-closed
    const opaqueResponse = new Response(null, { status: 200 });
    Object.defineProperty(opaqueResponse, 'type', { value: 'opaqueredirect', configurable: true });
    const opaqueFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(opaqueResponse);
    const opaqueRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/opaque.png', alt: 'opaque' },
      { fetchImpl: opaqueFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(opaqueRes).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });

    // Defense-in-depth unsafe response.url
    const unsafeFinalFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeByteResponse(PNG_MAGIC_BYTES, {
        headers: { 'content-type': 'image/png' },
        url: 'http://127.0.0.1/evil.png',
      }),
    );
    const unsafeFinalRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/sneaky.png', alt: 'sneaky' },
      { fetchImpl: unsafeFinalFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(unsafeFinalRes).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });
  });

  it('enforces size limits via Content-Length pre-check, streamed reader overflow cancellation, arrayBuffer fallback, and empty body rejection', async () => {
    expect(MAX_MEDIA_BYTES).toBe(10 * 1024 * 1024);

    // 1) Content-Length header exceeds limit -> rejected before reading stream
    const cancelSpy = vi.fn(async () => {});
    const oversizedHeaderRes = {
      ok: true,
      status: 200,
      type: 'basic',
      url: 'https://cdn.example.com/huge.png',
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': String(1024 + 1),
      }),
      body: {
        cancel: cancelSpy,
        getReader: vi.fn(),
      },
    } as unknown as Response;

    const headerRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/huge.png', alt: 'huge' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(oversizedHeaderRes),
        maxBytes: 1024,
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(headerRes).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(cancelSpy).toHaveBeenCalled();

    // 2) Spoofed small Content-Length with streamed body exceeding limit -> cancels reader & aborts signal
    let capturedSignal: AbortSignal | undefined;
    const streamCancelSpy = vi.fn(async () => {});
    let chunkCount = 0;
    const spoofedStreamRes = {
      ok: true,
      status: 200,
      type: 'basic',
      url: 'https://cdn.example.com/spoofed.png',
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': '100',
      }),
      body: {
        getReader: () => ({
          read: vi.fn(async () => {
            chunkCount += 1;
            if (chunkCount <= 3) {
              return { done: false, value: new Uint8Array(600) };
            }
            return { done: true, value: undefined };
          }),
          cancel: streamCancelSpy,
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response;

    const streamRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/spoofed.png', alt: 'spoofed' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
          capturedSignal = init?.signal ?? undefined;
          return spoofedStreamRes;
        }),
        maxBytes: 1024,
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(streamRes).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(streamCancelSpy).toHaveBeenCalled();
    expect(capturedSignal?.aborted).toBe(true);

    // 3) arrayBuffer() fallback exceeds limit
    const fallbackRes = {
      ok: true,
      status: 200,
      type: 'basic',
      url: 'https://cdn.example.com/fallback.png',
      headers: new Headers({ 'content-type': 'image/png' }),
      body: null,
      arrayBuffer: async () => new Uint8Array(2048).buffer,
    } as unknown as Response;

    const abRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/fallback.png', alt: 'fallback' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(fallbackRes),
        maxBytes: 1024,
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(abRes).toMatchObject({ ok: false, code: 'TOO_LARGE' });

    // 4) Empty body rejected
    const emptyRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/empty.png', alt: 'empty' },
      {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            makeByteResponse(new Uint8Array(0), { headers: { 'content-type': 'image/png' } }),
          ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(emptyRes).toMatchObject({ ok: false, code: 'EMPTY_BODY' });
  });

  it('enforces MIME allowlist, rejects SVG/HTML even when asset.mime claims image/png, and sniffs octet-stream magic bytes', async () => {
    // Reject image/svg+xml even if asset.mime claims image/png
    const svgRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/icon.svg', alt: 'svg', mime: 'image/png' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(new TextEncoder().encode('<svg/>'), {
            headers: { 'content-type': 'image/svg+xml' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(svgRes).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });

    // Normalize image/jpg -> image/jpeg
    const jpgRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/photo.jpg', alt: 'jpg' },
      {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            makeByteResponse(JPEG_MAGIC_BYTES, { headers: { 'content-type': 'image/jpg' } }),
          ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(jpgRes).toMatchObject({ ok: true, mime: 'image/jpeg', filename: 'photo.jpg' });

    // Sniff raster magic bytes when Content-Type is application/octet-stream
    const sniffedRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/raw-asset', alt: 'sniff' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(JPEG_MAGIC_BYTES, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(sniffedRes).toMatchObject({ ok: true, mime: 'image/jpeg', filename: 'raw-asset.jpg' });

    // Reject octet-stream with non-image bytes
    const garbageRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/raw-html', alt: 'html' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(new TextEncoder().encode('<html>hello</html>'), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(garbageRes).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });
  });

  it('aborts slow fetches on timeout and redacts sensitive tokens in error reasons', async () => {
    const slowFetch = vi.fn<typeof fetch>().mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const timeoutRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/slow.png', alt: 'slow' },
      { fetchImpl: slowFetch, timeoutMs: 25, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(timeoutRes).toMatchObject({ ok: false, code: 'TIMEOUT' });

    const errorFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('proxy failed with Bearer gmext_demo_secret_token_999'));
    const errorRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/fail.png', alt: 'fail' },
      { fetchImpl: errorFetch, semaphore: new ConcurrencySemaphore(2) },
    );
    expect(errorRes.ok).toBe(false);
    if (!errorRes.ok) {
      expect(errorRes.reason).not.toContain('gmext_demo_secret_token_999');
      expect(errorRes.reason).toContain('Bearer [REDACTED]');
    }
  });

  it('enforces concurrency <= 2 across both fetchMediaAssets batch and simultaneous fetchMediaAsset calls while preserving order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const controlledFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return makeByteResponse(PNG_MAGIC_BYTES, {
        headers: { 'content-type': 'image/png' },
        url: String(input),
      });
    });

    const assets = Array.from({ length: 6 }, (_, i) => ({
      url: `https://cdn.example.com/img-${i}.png`,
      alt: `图 ${i}`,
    }));

    const batchResults = await fetchMediaAssets(assets, {
      fetchImpl: controlledFetch,
      semaphore: new ConcurrencySemaphore(2),
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(batchResults).toHaveLength(6);
    expect(batchResults.map((r) => r.alt)).toEqual([
      '图 0',
      '图 1',
      '图 2',
      '图 3',
      '图 4',
      '图 5',
    ]);

    // Also verify createMediaFetcher caps concurrent single calls even if maxConcurrency > 2 is requested
    inFlight = 0;
    maxInFlight = 0;
    const fetcher = createMediaFetcher({ fetchImpl: controlledFetch, maxConcurrency: 10 });
    const concurrentResults = await Promise.all(
      assets.slice(0, 5).map((asset) => fetcher.fetchMediaAsset(asset)),
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetcher.getInFlightCount()).toBe(0);
    expect(concurrentResults.every((r) => r.ok)).toBe(true);
  });

  it('prevents ConcurrencySemaphore slot-stealing / permit-barging under both direct acquire() and createMediaFetcher wakeup races', async () => {
    // 1) Direct ConcurrencySemaphore(2) slot-stealing race
    const sem = new ConcurrencySemaphore(2);
    let activeHolders = 0;
    let peakHolders = 0;
    const order: string[] = [];

    const r1 = await sem.acquire();
    activeHolders += 1;
    peakHolders = Math.max(peakHolders, activeHolders);
    expect(sem.getInFlightCount()).toBe(1);

    const r2 = await sem.acquire();
    activeHolders += 1;
    peakHolders = Math.max(peakHolders, activeHolders);
    expect(sem.getInFlightCount()).toBe(2);

    const p3 = sem.acquire().then((release) => {
      activeHolders += 1;
      peakHolders = Math.max(peakHolders, activeHolders);
      order.push('p3');
      expect(sem.getInFlightCount()).toBeLessThanOrEqual(2);
      return release;
    });

    // Release r1 while p3 is queued, then synchronously call acquire() for p4 before p3's microtask runs
    activeHolders -= 1;
    r1();
    r1(); // idempotent double-release must not corrupt count
    expect(sem.getInFlightCount()).toBe(2);

    const p4 = sem.acquire().then((release) => {
      activeHolders += 1;
      peakHolders = Math.max(peakHolders, activeHolders);
      order.push('p4');
      expect(sem.getInFlightCount()).toBeLessThanOrEqual(2);
      return release;
    });

    const r3 = await p3;
    expect(sem.getInFlightCount()).toBe(2);
    expect(peakHolders).toBeLessThanOrEqual(2);
    expect(order).toEqual(['p3']);

    activeHolders -= 1;
    r2();
    const r4 = await p4;
    expect(sem.getInFlightCount()).toBe(2);
    expect(peakHolders).toBeLessThanOrEqual(2);
    expect(order).toEqual(['p3', 'p4']);

    activeHolders -= 1;
    r3();
    expect(sem.getInFlightCount()).toBe(1);
    activeHolders -= 1;
    r4();
    expect(sem.getInFlightCount()).toBe(0);

    // 2) End-to-end createMediaFetcher().fetchMediaAsset() microtask wakeup race
    let liveInFlight = 0;
    let peakLiveInFlight = 0;
    const resolvers: Array<() => void> = [];

    const deferredFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      liveInFlight += 1;
      peakLiveInFlight = Math.max(peakLiveInFlight, liveInFlight);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      liveInFlight -= 1;
      return makeByteResponse(PNG_MAGIC_BYTES, {
        headers: { 'content-type': 'image/png' },
        url: String(input),
      });
    });

    const fetcher = createMediaFetcher({ fetchImpl: deferredFetch, maxConcurrency: 2 });
    const req1 = fetcher.fetchMediaAsset({ url: 'https://cdn.example.com/r1.png', alt: 'r1' });
    const req2 = fetcher.fetchMediaAsset({ url: 'https://cdn.example.com/r2.png', alt: 'r2' });
    const req3 = fetcher.fetchMediaAsset({ url: 'https://cdn.example.com/r3.png', alt: 'r3' });

    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });

    // Resolve req1 so its finally releases the permit while req3 is queued, and immediately fire req4
    resolvers[0]!();
    const req4 = fetcher.fetchMediaAsset({ url: 'https://cdn.example.com/r4.png', alt: 'r4' });

    await req1;
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(3);
    });
    expect(peakLiveInFlight).toBeLessThanOrEqual(2);
    expect(fetcher.getInFlightCount()).toBeLessThanOrEqual(2);

    resolvers[1]!();
    await req2;
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(4);
    });
    expect(peakLiveInFlight).toBeLessThanOrEqual(2);

    resolvers[2]!();
    resolvers[3]!();
    const [res3, res4] = await Promise.all([req3, req4]);
    expect(res3.ok).toBe(true);
    expect(res4.ok).toBe(true);
    expect(peakLiveInFlight).toBeLessThanOrEqual(2);
    expect(fetcher.getInFlightCount()).toBe(0);
  });

  it('blocks MIME bypass on octet-stream/missing Content-Type even with raster asset.mime and rejects SVG/HTML polyglots', async () => {
    // 1) application/octet-stream + asset.mime: 'image/png' with HTML payload -> UNSUPPORTED_MIME
    const octetHtmlRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/evil.bin', alt: 'html', mime: 'image/png' },
      {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            makeByteResponse(
              new TextEncoder().encode('<!doctype html><html><script>alert(1)</script></html>'),
              { headers: { 'content-type': 'application/octet-stream' } },
            ),
          ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(octetHtmlRes).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });

    // 1b) application/octet-stream + asset.mime: 'image/png' with SVG payload -> UNSUPPORTED_MIME
    const octetSvgRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/evil-svg.bin', alt: 'svg', mime: 'image/png' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(new TextEncoder().encode('<svg onload="alert(1)"></svg>'), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(octetSvgRes).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });

    // 2) Missing Content-Type + asset.mime: 'image/png' with SVG payload -> UNSUPPORTED_MIME
    const missingCtSvgRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/no-ct', alt: 'svg-no-ct', mime: 'image/png' },
      {
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            makeByteResponse(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
          ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(missingCtSvgRes).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });

    // 3) application/octet-stream + asset.mime: 'image/png' with real JPEG bytes -> sniffed image/jpeg
    const octetJpegRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/real.bin', alt: 'real-jpg', mime: 'image/png' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(JPEG_MAGIC_BYTES, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(octetJpegRes).toMatchObject({ ok: true, mime: 'image/jpeg', filename: 'real.jpg' });

    // 4) Content-Type: image/png with <svg ...> payload (defense-in-depth polyglot block)
    const pngSvgPolyglot = await fetchMediaAsset(
      { url: 'https://cdn.example.com/polyglot.png', alt: 'polyglot' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(
            new TextEncoder().encode('  \n<SVG xmlns="http://www.w3.org/2000/svg"/>'),
            {
              headers: { 'content-type': 'image/png' },
            },
          ),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(pngSvgPolyglot).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });

    // 4b) Content-Type: image/png with UTF-8 BOM + <!DOCTYPE html>
    const bomHtmlBytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('  <!DOCTYPE html><html></html>'),
    ]);
    const bomHtmlPolyglot = await fetchMediaAsset(
      { url: 'https://cdn.example.com/bom.png', alt: 'bom' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(bomHtmlBytes, {
            headers: { 'content-type': 'image/png' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(bomHtmlPolyglot).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });
  });

  it('cancels stalled Slowloris ReadableStream reader on streaming timeout and clamps non-finite numeric options', async () => {
    let capturedSignal: AbortSignal | undefined;
    let streamCancelled = false;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const slowlorisFetch = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      capturedSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PNG_MAGIC_BYTES);
        },
        pull() {
          return new Promise<void>(() => {
            // Intentionally never resolves to simulate Slowloris stall
          });
        },
        cancel() {
          streamCancelled = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const timeoutRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/slowloris.png', alt: 'slowloris' },
      {
        fetchImpl: slowlorisFetch,
        timeoutMs: 30,
        semaphore: new ConcurrencySemaphore(2),
      },
    );

    expect(timeoutRes).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(capturedSignal?.aborted).toBe(true);
    expect(streamCancelled).toBe(true);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();

    // Verify Infinity / NaN options cannot disable maxBytes or maxRedirects
    const hugeHeaderRes = {
      ok: true,
      status: 200,
      type: 'basic',
      url: 'https://cdn.example.com/huge-inf.png',
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': String(MAX_MEDIA_BYTES + 1),
      }),
      body: { cancel: vi.fn(async () => {}) },
    } as unknown as Response;

    const clampedRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/huge-inf.png', alt: 'huge-inf' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(hugeHeaderRes),
        maxBytes: Number.POSITIVE_INFINITY,
        timeoutMs: Number.NaN,
        maxRedirects: Number.POSITIVE_INFINITY,
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(clampedRes).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('sanitizes percent-encoded path traversal and multi-dot filenames without dotfiles or double dots', () => {
    const cases: Array<{ url: string; mime: string; index?: number; expected: string }> = [
      {
        url: 'https://cdn.example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        mime: 'image/png',
        expected: 'passwd.png',
      },
      {
        url: 'https://cdn.example.com/%2e%2e%2f%2e%2e',
        mime: 'image/png',
        index: 0,
        expected: 'geomix-image-1.png',
      },
      {
        url: 'https://cdn.example.com/%2e%2e%2f%2e%2e%2fsecret.png',
        mime: 'image/png',
        expected: 'secret.png',
      },
      {
        url: 'https://cdn.example.com/a..b',
        mime: 'image/png',
        expected: 'a.png',
      },
    ];

    for (const testCase of cases) {
      const name = deriveSafeMediaFilename(new URL(testCase.url), testCase.mime, testCase.index);
      expect(name, testCase.url).toBe(testCase.expected);
      expect(name.startsWith('.'), name).toBe(false);
      expect(name.includes('..'), name).toBe(false);
    }
  });

  it('produces exact RFC 4648 Base64 for empty, padding boundaries, all 256 byte values (0x00..0xFF), and multi-chunk buffers', () => {
    // Empty buffer
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe('');

    // 1 / 2 / 3 / 4-byte padding boundaries (ASCII & high-bit 0x80..0xFF bytes)
    const boundaryInputs: Uint8Array[] = [
      new Uint8Array([0x4d]),
      new Uint8Array([0x4d, 0x61]),
      new Uint8Array([0x4d, 0x61, 0x6e]),
      new Uint8Array([0x4d, 0x61, 0x6e, 0x21]),
      new Uint8Array([0x80]),
      new Uint8Array([0x80, 0x9f]),
      new Uint8Array([0x80, 0x9f, 0xff]),
      new Uint8Array([0x00, 0x80, 0x9f, 0xff]),
    ];
    for (const sample of boundaryInputs) {
      expect(uint8ArrayToBase64(sample)).toBe(Buffer.from(sample).toString('base64'));
    }

    // All 256 byte values (0x00..0xFF) — catches any windows-1252 0x80..0x9F corruption
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      allBytes[i] = i;
    }
    const allBytesEncoded = uint8ArrayToBase64(allBytes);
    expect(allBytesEncoded).toBe(Buffer.from(allBytes).toString('base64'));
    const decodedAllBytes = Buffer.from(allBytesEncoded, 'base64');
    expect(decodedAllBytes.length).toBe(256);
    for (let i = 0x80; i <= 0x9f; i += 1) {
      expect(decodedAllBytes[i]).toBe(i);
    }

    // Multi-chunk buffer (> 0x4000 bytes: 3 chunks + 7 trailing bytes) and non-zero byteOffset view
    const multiChunk = new Uint8Array(0x4000 * 3 + 7);
    for (let i = 0; i < multiChunk.length; i += 1) {
      multiChunk[i] = (i * 31 + 17) & 0xff;
    }
    expect(uint8ArrayToBase64(multiChunk)).toBe(Buffer.from(multiChunk).toString('base64'));

    const offsetView = multiChunk.subarray(13, multiChunk.length - 5);
    expect(uint8ArrayToBase64(offsetView)).toBe(Buffer.from(offsetView).toString('base64'));
  });

  it('encodes an exact 10 MiB payload quickly with exact RFC 4648 parity', () => {
    const tenMiB = new Uint8Array(MAX_MEDIA_BYTES);
    // Seed a repeating 256-byte pattern covering all 0x00..0xFF values via fast fill/set
    const pattern = new Uint8Array(4096);
    for (let i = 0; i < pattern.length; i += 1) {
      pattern[i] = i & 0xff;
    }
    for (let offset = 0; offset < tenMiB.length; offset += pattern.length) {
      tenMiB.set(pattern, offset);
    }
    // Place PNG magic header at start and distinct bytes at end
    tenMiB.set(PNG_MAGIC_BYTES, 0);
    tenMiB[tenMiB.length - 3] = 0x80;
    tenMiB[tenMiB.length - 2] = 0x9f;
    tenMiB[tenMiB.length - 1] = 0xff;

    const startMs = performance.now();
    const encoded = uint8ArrayToBase64(tenMiB);
    const elapsedMs = performance.now() - startMs;

    const expected = Buffer.from(tenMiB).toString('base64');
    expect(encoded.length).toBe(expected.length);
    expect(encoded).toBe(expected);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('unconditionally sniffs raster magic bytes even when Content-Type spoofs image/* and validates strict 14-byte BMP headers (G2)', async () => {
    const spoofedPayloads: Array<{ label: string; contentType: string; bytes: Uint8Array }> = [
      {
        label: 'script-tag-as-png',
        contentType: 'image/png',
        bytes: new TextEncoder().encode('<script>alert(1)</script>'),
      },
      {
        label: 'html-comment-svg-as-png',
        contentType: 'image/png',
        bytes: new TextEncoder().encode(
          '<!-- comment --><svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      },
      {
        label: 'javascript-as-jpeg',
        contentType: 'image/jpeg',
        bytes: new TextEncoder().encode('export default function exploit() { return 1; }'),
      },
      {
        label: 'pdf-as-png',
        contentType: 'image/png',
        bytes: new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj'),
      },
      {
        label: 'bm-script-as-octet-stream',
        contentType: 'application/octet-stream',
        bytes: new TextEncoder().encode('BM<script>alert(1)</script>'),
      },
      {
        label: 'bm-script-as-bmp',
        contentType: 'image/bmp',
        bytes: new TextEncoder().encode('BM<script>alert(1)</script>'),
      },
      {
        label: 'bmp-bad-pixel-offset',
        contentType: 'image/bmp',
        bytes: new Uint8Array([
          0x42, 0x4d, 0x1e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00,
        ]),
      },
    ];

    for (const item of spoofedPayloads) {
      const res = await fetchMediaAsset(
        { url: `https://cdn.example.com/${item.label}.png`, alt: item.label },
        {
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
            makeByteResponse(item.bytes, {
              headers: { 'content-type': item.contentType },
            }),
          ),
          semaphore: new ConcurrencySemaphore(2),
        },
      );
      expect(res, item.label).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });
    }

    // Valid 14-byte BITMAPFILEHEADER (reserved bytes = 0, pixel offset = 14) succeeds as image/bmp
    const validBmp = new Uint8Array([
      0x42,
      0x4d, // 'BM'
      0x12,
      0x00,
      0x00,
      0x00, // file size = 18
      0x00,
      0x00,
      0x00,
      0x00, // reserved1 + reserved2 = 0
      0x0e,
      0x00,
      0x00,
      0x00, // pixel data offset = 14
      0x01,
      0x02,
      0x03,
      0x04,
    ]);
    const validBmpRes = await fetchMediaAsset(
      { url: 'https://cdn.example.com/valid-sample.bmp', alt: 'valid-bmp' },
      {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
          makeByteResponse(validBmp, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
        semaphore: new ConcurrencySemaphore(2),
      },
    );
    expect(validBmpRes).toMatchObject({
      ok: true,
      mime: 'image/bmp',
      filename: 'valid-sample.bmp',
      byteLength: validBmp.byteLength,
    });
  });
});
