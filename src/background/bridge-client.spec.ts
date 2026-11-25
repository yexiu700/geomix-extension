import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMeDto, ExtensionPendingTaskDto } from '../shared/bridge-contract';
import {
  BridgeError,
  createBridgeClient,
  deriveConfirmPublishedIdempotencyKey,
  serializeBridgeError,
} from './bridge-client';

const DEMO_BASE_URL = 'https://geo.example.com';
const DEMO_TOKEN = 'gmext_demo_token_0001';

const DEMO_ME: ExtensionMeDto = {
  nickname: 'DemoOperator',
  tokenLabel: '测试设备',
  tokenPrefix: 'gmext_demo',
  expiresAt: '2026-12-31T23:59:59.000Z',
  brands: [
    {
      brandId: 'brand_demo_1',
      brandName: 'DemoBrand Alpha',
      brandMarketId: 'bm_cn_1',
      localBrandName: '示例品牌甲',
    },
  ],
};

const DEMO_TASK: ExtensionPendingTaskDto = {
  taskId: 'task_demo_1',
  articleId: 'article_demo_1',
  brandId: 'brand_demo_1',
  brandName: '示例品牌甲',
  provider: 'ZHIHU_EXT',
  channelLabel: '知乎专栏',
  status: 'READY_TO_PUBLISH',
  variantTitle: '示例品牌甲深度评测',
  variantMarkdown: '# 评测\n\n正文',
  variantHtml: '<h1>评测</h1><p>正文</p>',
  targetUrlHint: 'https://www.zhihu.com/question/123456',
  mediaAssets: [
    {
      url: 'https://cdn.example.com/assets/demo-1.png',
      alt: '主图',
      mime: 'image/png',
    },
  ],
  complianceChecklist: ['避免夸大宣传'],
  updatedAt: '2026-06-01T10:00:00.000Z',
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('bridge-client', () => {
  it('calls GET /api/v2/extension/me with required headers and unwraps ApiEnvelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }),
    );
    const client = createBridgeClient({
      baseUrl: `${DEMO_BASE_URL}/`,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: fetchMock,
    });

    const result = await client.getMe();
    expect(result).toEqual(DEMO_ME);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://geo.example.com/api/v2/extension/me');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${DEMO_TOKEN}`,
      'X-GeoMix-Extension-Version': '0.1.0',
      Accept: 'application/json',
    });
  });

  it('calls GET /api/v2/extension/tasks with default status, filters, and supports both array and { items }', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeJsonResponse({ code: 0, msg: 'ok', data: [DEMO_TASK] }))
      .mockResolvedValueOnce(
        makeJsonResponse({ code: 0, msg: 'ok', data: { items: [DEMO_TASK] } }),
      );

    const client = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: fetchMock,
    });

    const first = await client.getTasks();
    expect(first).toEqual([DEMO_TASK]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://geo.example.com/api/v2/extension/tasks?status=DRAFT_VARIANT%2CREADY_TO_PUBLISH',
    );

    const second = await client.getTasks({
      brandId: 'brand_demo_1',
      provider: 'ZHIHU_EXT',
      status: ['READY_TO_PUBLISH'],
    });
    expect(second).toEqual([DEMO_TASK]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://geo.example.com/api/v2/extension/tasks?brandId=brand_demo_1&provider=ZHIHU_EXT&status=READY_TO_PUBLISH',
    );
  });

  it('calls POST /api/v2/extension/tasks/:taskId/confirm-published with deterministic Idempotency-Key', async () => {
    const confirmData = {
      taskId: 'task_demo_1',
      status: 'PUBLISHED' as const,
      publishRecordId: 'pub_demo_1',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      makeJsonResponse({ code: 0, msg: 'ok', data: confirmData }),
    );
    const client = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: fetchMock,
    });

    const res1 = await client.confirmPublished(
      'task_demo_1',
      { publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/' },
      { provider: 'ZHIHU_EXT' },
    );
    const res2 = await client.confirmPublished(
      'task_demo_1',
      { publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
      { provider: 'ZHIHU_EXT' },
    );

    expect(res1).toEqual(confirmData);
    expect(res2).toEqual(confirmData);

    const headers1 = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const headers2 = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers1['Idempotency-Key']).toBe(headers2['Idempotency-Key']);
    expect(headers1['Idempotency-Key']).toMatch(/^gmext-confirm-[0-9a-f]+$/);
    expect(headers1['Content-Type']).toBe('application/json');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://geo.example.com/api/v2/extension/tasks/task_demo_1/confirm-published',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' }),
    );

    const otherKey = await deriveConfirmPublishedIdempotencyKey(
      'task_demo_2',
      'https://zhuanlan.zhihu.com/p/123456789',
    );
    expect(otherKey).not.toBe(headers1['Idempotency-Key']);
  });

  it('rejects draft, query-bearing, private, or provider-mismatched URLs before calling fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: fetchMock,
    });

    await expect(
      client.confirmPublished('task_demo_1', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/edit',
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });

    await expect(
      client.confirmPublished('task_demo_1', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo',
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });

    await expect(
      client.confirmPublished('task_demo_1', {
        publishedUrl: 'https://127.0.0.1/p/123456789',
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });

    await expect(
      client.confirmPublished(
        'task_demo_1',
        { publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
        { provider: 'TOUTIAO_EXT' },
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });

    const invalidConfirmInputs: Array<{ taskId: string; publishedUrl: string }> = [
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789?' },
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789#' },
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789?#' },
      { taskId: 'task_demo_1', publishedUrl: '  https://zhuanlan.zhihu.com/p/123456789  ' },
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/edit/%2e%2e' },
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/./' },
      { taskId: 'task_demo_1', publishedUrl: 'https://ZHUANLAN.ZHIHU.COM/p/123456789' },
      { taskId: 'task_demo_1', publishedUrl: 'https://zhuanlan.zhihu.com:443/p/123456789' },
      { taskId: '.', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
      { taskId: '..', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
      { taskId: 'task/1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
      { taskId: 'task?a=1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
      { taskId: 'task%2f1', publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
    ];

    for (const item of invalidConfirmInputs) {
      await expect(
        client.confirmPublished(item.taskId, { publishedUrl: item.publishedUrl }),
        `${item.taskId} :: ${item.publishedUrl}`,
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401/403/400/404/429/500/non-JSON/envelope/schema/network/timeout errors accurately', async () => {
    const cases: Array<{ response: Response; expectedKind: string; reauth?: boolean }> = [
      {
        response: makeJsonResponse({ code: 40100, msg: 'token expired', data: null }, 401),
        expectedKind: 'UNAUTHORIZED',
        reauth: true,
      },
      {
        response: makeJsonResponse({ code: 40300, msg: 'forbidden', data: null }, 403),
        expectedKind: 'FORBIDDEN',
      },
      {
        response: makeJsonResponse({ code: 40001, msg: 'bad url', data: null }, 400),
        expectedKind: 'BAD_REQUEST',
      },
      {
        response: makeJsonResponse({ code: 40400, msg: 'not found', data: null }, 404),
        expectedKind: 'NOT_FOUND',
      },
      {
        response: makeJsonResponse({ code: 42900, msg: 'rate limited', data: null }, 429),
        expectedKind: 'RATE_LIMITED',
      },
      {
        response: new Response('<html>502 Bad Gateway</html>', { status: 502 }),
        expectedKind: 'SERVER_ERROR',
      },
      {
        response: makeJsonResponse({ code: 40101, msg: 'token revoked', data: null }, 200),
        expectedKind: 'UNAUTHORIZED',
        reauth: true,
      },
      {
        response: makeJsonResponse({ code: 401, msg: 'unauthorized', data: null }, 200),
        expectedKind: 'UNAUTHORIZED',
        reauth: true,
      },
      {
        response: makeJsonResponse({ code: 50001, msg: 'business fail', data: null }, 200),
        expectedKind: 'API_ERROR',
      },
      {
        response: makeJsonResponse({ code: 0, msg: 'ok', data: null }, 200),
        expectedKind: 'SCHEMA_VALIDATION',
      },
      {
        response: makeJsonResponse({ code: 0, msg: 'ok', data: { nickname: '' } }, 200),
        expectedKind: 'SCHEMA_VALIDATION',
      },
    ];

    for (const testCase of cases) {
      const fetchMock = vi.fn<typeof fetch>(async () => testCase.response);
      const client = createBridgeClient({
        baseUrl: DEMO_BASE_URL,
        token: DEMO_TOKEN,
        extensionVersion: '0.1.0',
        fetchImpl: fetchMock,
      });

      await expect(client.getMe()).rejects.toMatchObject({
        kind: testCase.expectedKind,
        reauthRequired: testCase.reauth ?? false,
      });
    }

    const networkClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(networkClient.getMe()).rejects.toMatchObject({ kind: 'NETWORK_ERROR' });

    const abortClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }),
    });
    await expect(abortClient.getMe()).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('never leaks raw gmext_ token in BridgeError messages, serialized errors, or client JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      makeJsonResponse(
        {
          code: 40100,
          msg: `Invalid header Authorization: Bearer ${DEMO_TOKEN} (${DEMO_TOKEN})`,
          data: null,
        },
        401,
      ),
    );
    const client = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: fetchMock,
    });

    expect(JSON.stringify(client)).not.toContain(DEMO_TOKEN);

    let caught: unknown;
    try {
      await client.getMe();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BridgeError);
    const bridgeErr = caught as BridgeError;
    expect(bridgeErr.message).not.toContain(DEMO_TOKEN);
    const serialized = serializeBridgeError(bridgeErr);
    expect(JSON.stringify(serialized)).not.toContain(DEMO_TOKEN);
    expect(serialized.reauthRequired).toBe(true);
  });

  it('never leaks raw gmext_ token via BridgeError.cause when fetch or response.text() throws', async () => {
    const fetchRejectClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError(`Fetch failed with Authorization: Bearer ${DEMO_TOKEN}`);
      }),
    });

    let fetchErr: unknown;
    try {
      await fetchRejectClient.getMe();
    } catch (error) {
      fetchErr = error;
    }

    expect(fetchErr).toBeInstanceOf(BridgeError);
    const fetchBridgeErr = fetchErr as BridgeError;
    expect(fetchBridgeErr.kind).toBe('NETWORK_ERROR');
    expect(fetchBridgeErr.message).not.toContain(DEMO_TOKEN);
    expect(String(fetchBridgeErr.cause)).not.toContain(DEMO_TOKEN);
    expect((fetchBridgeErr.cause as Error | undefined)?.stack).toBeUndefined();

    const textRejectClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          ({
            ok: true,
            status: 200,
            text: async () => {
              throw new Error(`Stream interrupted for ${DEMO_TOKEN}`);
            },
          }) as unknown as Response,
      ),
    });

    let textErr: unknown;
    try {
      await textRejectClient.getMe();
    } catch (error) {
      textErr = error;
    }

    expect(textErr).toBeInstanceOf(BridgeError);
    const textBridgeErr = textErr as BridgeError;
    expect(textBridgeErr.kind).toBe('INVALID_RESPONSE');
    expect(String(textBridgeErr.cause)).not.toContain(DEMO_TOKEN);
    expect((textBridgeErr.cause as Error | undefined)?.stack).toBeUndefined();
  });

  it('enforces redirect: manual and rejects 3xx and opaqueredirect responses as NETWORK_ERROR (G9)', async () => {
    const redirectFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/internal' },
        }),
    );
    const redirectClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: redirectFetch,
    });

    await expect(redirectClient.getMe()).rejects.toMatchObject({
      kind: 'NETWORK_ERROR',
      httpStatus: 302,
    });
    expect(redirectFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');

    const opaqueClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          ({
            type: 'opaqueredirect',
            status: 0,
            ok: false,
            text: async () => '',
          }) as unknown as Response,
      ),
    });

    await expect(opaqueClient.getMe()).rejects.toMatchObject({
      kind: 'NETWORK_ERROR',
    });
  });

  it('keeps timeout active across response.text() and clamps Infinity/NaN timeoutMs safely (G9)', async () => {
    let observedSignal: AbortSignal | undefined;
    const slowBodyClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: '0.1.0',
      timeoutMs: 30,
      fetchImpl: vi.fn<typeof fetch>(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return {
          type: 'basic',
          ok: true,
          status: 200,
          text: () => new Promise<string>(() => {}),
        } as unknown as Response;
      }),
    });

    await expect(slowBodyClient.getMe()).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(observedSignal?.aborted).toBe(true);

    // Infinity and NaN timeoutMs must clamp to default instead of overflowing setTimeout to 0ms
    for (const nonFiniteTimeout of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const okClient = createBridgeClient({
        baseUrl: DEMO_BASE_URL,
        token: DEMO_TOKEN,
        extensionVersion: '0.1.0',
        timeoutMs: nonFiniteTimeout,
        fetchImpl: vi.fn<typeof fetch>(async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return makeJsonResponse({ code: 0, msg: 'ok', data: DEMO_ME });
        }),
      });
      await expect(okClient.getMe()).resolves.toEqual(DEMO_ME);
    }
  });

  it('binds globalThis.fetch to globalThis so Chrome ServiceWorker fetch never throws Illegal invocation', async () => {
    const originalFetch = globalThis.fetch;
    const strictNativeFetch = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
      }
      return Promise.resolve(makeJsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }));
    } as unknown as typeof fetch;

    globalThis.fetch = strictNativeFetch;
    try {
      const client = createBridgeClient({
        baseUrl: DEMO_BASE_URL,
        token: DEMO_TOKEN,
        extensionVersion: '0.1.0',
      });
      await expect(client.getMe()).resolves.toEqual(DEMO_ME);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
