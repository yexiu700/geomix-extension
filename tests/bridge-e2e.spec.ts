import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDefaultAdapters } from '../src/adapters/registry';
import {
  createSmzdmEditorDocument,
  createSmzdmTaskFixture,
  SMZDM_EDITOR_DRAFT_URL,
  SMZDM_EDITOR_URL,
  SMZDM_PUBLISHED_DIRTY_URL,
  SMZDM_PUBLISHED_URL,
} from '../src/adapters/smzdm/fixtures';
import {
  createDemoToutiaoTask,
  createToutiaoEditorDocument,
  TOUTIAO_DEMO_ARTICLE_ID,
  TOUTIAO_EDITOR_QUERY_URL,
  TOUTIAO_EDITOR_URL,
} from '../src/adapters/toutiao/fixtures';
import {
  createZhihuDemoTask,
  createZhihuZhuanlanEditorFixture,
  ZHIHU_DEMO_URLS,
  type PasteCaptureRecord,
  type ReactControlledValueTracker,
} from '../src/adapters/zhihu/fixtures';
import {
  createBridgeClient,
  deriveConfirmPublishedIdempotencyKey,
} from '../src/background/bridge-client';
import type { ChromeScriptingApiLike, ChromeTabsApiLike } from '../src/background/dispatch';
import {
  createBackgroundMessageHandler,
  createTabRemovedHandler,
  createTabUpdatedHandler,
} from '../src/background/index';
import { createLocalImageUploader } from '../src/content/image-uploader';
import {
  createContentMessageHandler,
  createUrlCaptureCoordinator,
  type UrlCaptureCoordinator,
} from '../src/content/index';
import {
  CAPTURE_BAR_HOST_ID,
  getActiveCaptureBarHost,
  getActiveCaptureBarMode,
  unmountCaptureBar,
} from '../src/content/url-capture-bar';
import { App } from '../src/popup/App';
import {
  DEFAULT_RETEST_MILESTONES,
  type ExtensionConfirmPublishedResult,
  type ExtensionMeDto,
  type ExtensionPendingTaskDto,
  type ExtensionProviderKey,
} from '../src/shared/bridge-contract';
import type {
  BackgroundToContentRequest,
  ContentToBackgroundRequest,
  ExtensionResponseDataMap,
  MessageResponse,
  PopupRuntimeRequest,
  PushDraftTaskResponseData,
} from '../src/shared/messages';
import {
  getPairing,
  getPendingTabTask,
  listPendingTabTasks,
  PAIRING_STORAGE_KEY,
  TAB_TASKS_STORAGE_KEY,
} from '../src/shared/storage';
import { isCanonicalPublishedUrl } from '../src/shared/url-validation';

const DEMO_BASE_URL = 'https://geo.example.com';
const DEMO_TOKEN = 'gmext_demo_e2e_token_2026';
const DEMO_EXTENSION_VERSION = '0.1.0';
const TEST_EXT_ID = 'geomix-test-extension-id';

// Valid minimal raster magic-byte headers (satisfies media-fetcher raster MIME & non-markup checks)
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

type RecordedBridgeRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

type PublishRecordEntry = {
  publishRecordId: string;
  taskId: string;
  publishedUrl: string;
  idempotencyKey: string;
};

function createJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readHeadersMap(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function createMockBridgeServer() {
  let validToken = DEMO_TOKEN;
  let tokenRevoked = false;

  const me: ExtensionMeDto = {
    nickname: 'DemoOperator',
    tokenLabel: 'E2E 验收令牌',
    tokenPrefix: 'gmext_demo',
    expiresAt: '2026-12-31T23:59:59.000Z',
    brands: [
      {
        brandId: 'brand_demo_1',
        brandName: 'DemoBrand',
        brandMarketId: 'cn_mainland',
        localBrandName: '示例品牌甲',
      },
      {
        brandId: 'brand_demo_2',
        brandName: 'DemoBrandBeta',
        brandMarketId: 'cn_mainland',
        localBrandName: '示例品牌乙',
      },
    ],
  };

  const zhihuTask = createZhihuDemoTask({
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
  });
  const toutiaoTask = createDemoToutiaoTask({
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
  });
  const smzdmTask = createSmzdmTaskFixture({
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
  });

  const tasks = new Map<string, ExtensionPendingTaskDto>([
    [zhihuTask.taskId, structuredClone(zhihuTask)],
    [toutiaoTask.taskId, structuredClone(toutiaoTask)],
    [smzdmTask.taskId, structuredClone(smzdmTask)],
  ]);

  const confirmByIdempotencyKey = new Map<string, ExtensionConfirmPublishedResult>();
  const publishRecords: PublishRecordEntry[] = [];
  const mediaFailures = new Map<string, { status: number; reason?: string }>();
  const requests: RecordedBridgeRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = readHeadersMap(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const parsedUrl = new URL(requestUrl);

    // 1. Mock anti-hotlink CDN media assets
    if (parsedUrl.origin === 'https://cdn.example.com') {
      const failure = mediaFailures.get(requestUrl);
      if (failure) {
        const failedRes = new Response(failure.reason ?? 'Forbidden', { status: failure.status });
        Object.defineProperty(failedRes, 'url', { value: requestUrl, configurable: true });
        return failedRes;
      }

      const isWebp = parsedUrl.pathname.toLowerCase().endsWith('.webp');
      const mediaRes = new Response(isWebp ? WEBP_BYTES : PNG_BYTES, {
        status: 200,
        headers: {
          'Content-Type': isWebp ? 'image/webp' : 'image/png',
        },
      });
      Object.defineProperty(mediaRes, 'url', { value: requestUrl, configurable: true });
      return mediaRes;
    }

    // 2. GeoMix Bridge v1 API
    if (parsedUrl.origin !== DEMO_BASE_URL) {
      return createJsonResponse(404, { code: 40400, msg: 'Unknown mock origin', data: null });
    }

    requests.push({ method, url: requestUrl, headers, body });

    if (tokenRevoked || headers['authorization'] !== `Bearer ${validToken}`) {
      return createJsonResponse(401, {
        code: 40100,
        msg: '配对 Token 已吊销或失效',
        data: null,
      });
    }

    if (!headers['x-geomix-extension-version']) {
      return createJsonResponse(400, {
        code: 40000,
        msg: 'Missing X-GeoMix-Extension-Version header',
        data: null,
      });
    }

    // GET /api/v2/extension/me
    if (method === 'GET' && parsedUrl.pathname === '/api/v2/extension/me') {
      return createJsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: structuredClone(me),
      });
    }

    // GET /api/v2/extension/tasks
    if (method === 'GET' && parsedUrl.pathname === '/api/v2/extension/tasks') {
      const statusParam = parsedUrl.searchParams.get('status');
      const brandIdParam = parsedUrl.searchParams.get('brandId');
      const providerParam = parsedUrl.searchParams.get('provider');
      const allowedStatuses = statusParam
        ? new Set(statusParam.split(',').map((s) => s.trim()))
        : null;

      const filtered = [...tasks.values()]
        .filter((t) => (!allowedStatuses ? true : allowedStatuses.has(t.status)))
        .filter((t) => (!brandIdParam ? true : t.brandId === brandIdParam))
        .filter((t) => (!providerParam ? true : t.provider === providerParam))
        .map((t) => structuredClone(t));

      return createJsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: filtered,
      });
    }

    // POST /api/v2/extension/tasks/:taskId/confirm-published
    const confirmMatch = /^\/api\/v2\/extension\/tasks\/([^/]+)\/confirm-published$/.exec(
      parsedUrl.pathname,
    );
    if (method === 'POST' && confirmMatch) {
      const taskId = decodeURIComponent(confirmMatch[1] ?? '');
      const task = tasks.get(taskId);
      if (!task) {
        return createJsonResponse(404, { code: 40404, msg: 'Task not found', data: null });
      }

      const idempotencyKey = headers['idempotency-key']?.trim();
      if (!idempotencyKey) {
        return createJsonResponse(400, {
          code: 40002,
          msg: 'Missing Idempotency-Key header',
          data: null,
        });
      }

      let parsedBody: { publishedUrl?: unknown; publishedAt?: unknown };
      try {
        parsedBody = JSON.parse(body ?? '{}') as { publishedUrl?: unknown; publishedAt?: unknown };
      } catch {
        return createJsonResponse(400, { code: 40000, msg: 'Invalid JSON body', data: null });
      }

      if (
        typeof parsedBody.publishedUrl !== 'string' ||
        !isCanonicalPublishedUrl(parsedBody.publishedUrl, task.provider)
      ) {
        return createJsonResponse(400, {
          code: 40001,
          msg: 'invalid publishedUrl',
          data: null,
        });
      }

      const existing = confirmByIdempotencyKey.get(idempotencyKey);
      if (existing) {
        return createJsonResponse(200, {
          code: 0,
          msg: 'ok',
          data: structuredClone(existing),
        });
      }

      const publishRecordId = `pub_demo_${publishRecords.length + 1}`;
      const result: ExtensionConfirmPublishedResult = {
        taskId,
        status: 'PUBLISHED',
        publishRecordId,
        publishedUrl: parsedBody.publishedUrl,
        crawlProbeQueued: true,
        retestMilestones: [...DEFAULT_RETEST_MILESTONES],
      };

      confirmByIdempotencyKey.set(idempotencyKey, result);
      publishRecords.push({
        publishRecordId,
        taskId,
        publishedUrl: parsedBody.publishedUrl,
        idempotencyKey,
      });
      task.status = 'PUBLISHED';

      return createJsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: structuredClone(result),
      });
    }

    return createJsonResponse(404, { code: 40400, msg: 'Not Found', data: null });
  };

  return {
    me,
    zhihuTask,
    toutiaoTask,
    smzdmTask,
    tasks,
    requests,
    publishRecords,
    mediaFailures,
    fetchImpl,
    revokeToken() {
      tokenRevoked = true;
    },
    restoreToken(nextToken?: string) {
      tokenRevoked = false;
      if (nextToken) {
        validToken = nextToken;
      }
    },
  };
}

type SimulatedTab = {
  id: number;
  provider: ExtensionProviderKey;
  url: string;
  active: boolean;
  status: 'complete';
  coordinator: UrlCaptureCoordinator;
  contentHandler: ReturnType<typeof createContentMessageHandler>;
  publishClickSpy: ReturnType<typeof vi.fn>;
  saveDraftClickSpy: ReturnType<typeof vi.fn>;
  uploadedFiles: File[];
  pastedFiles: File[];
  reactTitleTracker?: ReactControlledValueTracker;
  pasteRecords?: PasteCaptureRecord[];
};

function detectProviderFromUrl(url: string): ExtensionProviderKey {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('zhihu.com')) {
    return 'ZHIHU_EXT';
  }
  if (parsed.hostname.endsWith('toutiao.com')) {
    return 'TOUTIAO_EXT';
  }
  if (parsed.hostname.endsWith('smzdm.com')) {
    return 'SMZDM_EXT';
  }
  throw new Error(`Unsupported platform test URL: ${url}`);
}

function mountEditorFixtureOnDocument(provider: ExtensionProviderKey, url: string) {
  unmountCaptureBar(document);
  const publishClickSpy = vi.fn();
  const saveDraftClickSpy = vi.fn();
  const uploadedFiles: File[] = [];
  const pastedFiles: File[] = [];
  let reactTitleTracker: ReactControlledValueTracker | undefined;
  let pasteRecords: PasteCaptureRecord[] | undefined;

  if (provider === 'ZHIHU_EXT') {
    const fixture = createZhihuZhuanlanEditorFixture({
      url,
      mountToGlobalDocument: true,
    });
    fixture.publishButton.addEventListener('click', publishClickSpy);
    fixture.publishArticleButton.addEventListener('click', publishClickSpy);
    fixture.submitButton.addEventListener('click', publishClickSpy);
    fixture.fileInput?.addEventListener('change', () => {
      if (fixture.fileInput?.files) {
        uploadedFiles.push(...Array.from(fixture.fileInput.files));
      }
    });
    fixture.editorElement.addEventListener('paste', (event: Event) => {
      const files = (event as ClipboardEvent).clipboardData?.files;
      if (files && files.length > 0) {
        pastedFiles.push(...Array.from(files));
      }
    });
    reactTitleTracker = fixture.reactTitleTracker;
    pasteRecords = fixture.pasteRecords;
  } else if (provider === 'TOUTIAO_EXT') {
    const fixtureDoc = createToutiaoEditorDocument({ url });
    document.head.innerHTML = fixtureDoc.head.innerHTML;
    document.body.innerHTML = fixtureDoc.body.innerHTML;

    const saveBtn = document.querySelector<HTMLButtonElement>('[data-testid="save-draft-btn"]');
    const previewPublishBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="preview-publish-btn"]',
    );
    const publishBtn = document.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]');
    const fileInput = document.querySelector<HTMLInputElement>(
      '[data-testid="body-image-file-input"]',
    );
    const editorEl = document.querySelector<HTMLElement>('.ProseMirror');

    saveBtn?.addEventListener('click', saveDraftClickSpy);
    previewPublishBtn?.addEventListener('click', publishClickSpy);
    publishBtn?.addEventListener('click', publishClickSpy);
    fileInput?.addEventListener('change', () => {
      if (fileInput.files) {
        uploadedFiles.push(...Array.from(fileInput.files));
      }
    });
    editorEl?.addEventListener('paste', (event: Event) => {
      const files = (event as ClipboardEvent).clipboardData?.files;
      if (files && files.length > 0) {
        pastedFiles.push(...Array.from(files));
      }
    });
  } else {
    const fixture = createSmzdmEditorDocument({ documentUrl: url });
    document.head.innerHTML = fixture.doc.head.innerHTML;
    document.body.innerHTML = fixture.doc.body.innerHTML;

    const saveBtn = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    const submitReviewBtn = document.querySelector<HTMLButtonElement>(
      '[data-action="submit-review"]',
    );
    const publishBtn = document.querySelector<HTMLButtonElement>('[data-action="publish"]');
    const fileInput = document.querySelector<HTMLInputElement>('[data-testid="smzdm-image-input"]');
    const editorEl = document.querySelector<HTMLElement>('[data-testid="smzdm-editor-body"]');

    saveBtn?.addEventListener('click', saveDraftClickSpy);
    submitReviewBtn?.addEventListener('click', publishClickSpy);
    publishBtn?.addEventListener('click', publishClickSpy);
    fileInput?.addEventListener('change', () => {
      if (fileInput.files) {
        uploadedFiles.push(...Array.from(fileInput.files));
      }
    });
    editorEl?.addEventListener('paste', (event: Event) => {
      const files = (event as ClipboardEvent).clipboardData?.files;
      if (files && files.length > 0) {
        pastedFiles.push(...Array.from(files));
      }
    });
  }

  return {
    publishClickSpy,
    saveDraftClickSpy,
    uploadedFiles,
    pastedFiles,
    reactTitleTracker,
    pasteRecords,
  };
}

function createExtensionE2EHarness(bridge: ReturnType<typeof createMockBridgeServer>) {
  let nextTabId = 101;
  const tabs = new Map<number, SimulatedTab>();
  const sentTabMessages: Array<{ tabId: number; message: BackgroundToContentRequest }> = [];

  const toChromeTab = (tab: SimulatedTab): chrome.tabs.Tab =>
    ({
      id: tab.id,
      url: tab.url,
      active: tab.active,
      status: tab.status,
      index: 0,
      pinned: false,
      highlighted: tab.active,
      windowId: 1,
      incognito: false,
      selected: tab.active,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      frozen: false,
    }) as chrome.tabs.Tab;

  const sendContentToBackground = async <T extends ContentToBackgroundRequest['type']>(
    tabId: number,
    message: Extract<ContentToBackgroundRequest, { type: T }>,
  ): Promise<MessageResponse<ExtensionResponseDataMap[T]>> => {
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new Error(`Simulated tab ${tabId} does not exist`);
    }
    const sender: chrome.runtime.MessageSender = {
      id: TEST_EXT_ID,
      frameId: 0,
      url: tab.url,
      tab: toChromeTab(tab),
    };
    return (await backgroundHandler(message, sender)) as MessageResponse<
      ExtensionResponseDataMap[T]
    >;
  };

  const tabsApi: ChromeTabsApiLike = {
    query: vi.fn(async () =>
      [...tabs.values()].map(toChromeTab),
    ) as unknown as ChromeTabsApiLike['query'],
    create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => {
      const url = createProperties.url ?? '';
      const tabId = nextTabId;
      nextTabId += 1;

      for (const existing of tabs.values()) {
        existing.active = false;
      }

      const provider = detectProviderFromUrl(url);
      const mounted = mountEditorFixtureOnDocument(provider, url);

      const contentSendMessage = async <T extends ContentToBackgroundRequest['type']>(
        message: Extract<ContentToBackgroundRequest, { type: T }>,
      ) => sendContentToBackground(tabId, message);

      const uploader = createLocalImageUploader({
        fetchMediaAsset: (asset) =>
          sendContentToBackground(tabId, {
            type: 'FETCH_MEDIA_ASSET',
            payload: asset,
          }),
      });

      const tabRef: SimulatedTab = {
        id: tabId,
        provider,
        url,
        active: true,
        status: 'complete',
        coordinator: null as unknown as UrlCaptureCoordinator,
        contentHandler: null as unknown as ReturnType<typeof createContentMessageHandler>,
        publishClickSpy: mounted.publishClickSpy,
        saveDraftClickSpy: mounted.saveDraftClickSpy,
        uploadedFiles: mounted.uploadedFiles,
        pastedFiles: mounted.pastedFiles,
        reactTitleTracker: mounted.reactTitleTracker,
        pasteRecords: mounted.pasteRecords,
      };

      const coordinator = createUrlCaptureCoordinator({
        doc: document,
        extensionId: TEST_EXT_ID,
        getCurrentUrl: () => new URL(tabRef.url),
        sendMessage:
          contentSendMessage as unknown as typeof import('../src/shared/messages').sendRuntimeMessage,
      });

      const contentHandler = createContentMessageHandler(
        {
          doc: document,
          extensionId: TEST_EXT_ID,
          getCurrentUrl: () => new URL(tabRef.url),
          uploader,
          sendMessage:
            contentSendMessage as unknown as typeof import('../src/shared/messages').sendRuntimeMessage,
        },
        coordinator,
      );

      tabRef.coordinator = coordinator;
      tabRef.contentHandler = contentHandler;
      tabs.set(tabId, tabRef);
      return toChromeTab(tabRef);
    }) as unknown as ChromeTabsApiLike['create'],
    update: vi.fn(async (tabId: number, updateProps: chrome.tabs.UpdateProperties) => {
      const tab = tabs.get(tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} not found`);
      }
      if (typeof updateProps.url === 'string') {
        tab.url = updateProps.url;
      }
      if (typeof updateProps.active === 'boolean') {
        tab.active = updateProps.active;
      }
      return toChromeTab(tab);
    }) as unknown as ChromeTabsApiLike['update'],
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.get(tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} not found`);
      }
      return toChromeTab(tab);
    }) as unknown as ChromeTabsApiLike['get'],
    sendMessage: vi.fn(async (tabId: number, message: BackgroundToContentRequest) => {
      sentTabMessages.push({ tabId, message });
      const tab = tabs.get(tabId);
      if (!tab) {
        throw new Error(`No receiving end for tab ${tabId}`);
      }
      return await new Promise<unknown>((resolve) => {
        tab.contentHandler(message, { id: TEST_EXT_ID }, (response) => {
          resolve(response);
        });
      });
    }) as unknown as ChromeTabsApiLike['sendMessage'],
    onUpdated: chrome.tabs.onUpdated,
    onRemoved: chrome.tabs.onRemoved,
  };

  const scriptingApi: ChromeScriptingApiLike = {
    executeScript: vi.fn(async () => []) as unknown as ChromeScriptingApiLike['executeScript'],
  };

  const buildSwHandlers = () => ({
    backgroundHandler: createBackgroundMessageHandler({
      fetchImpl: bridge.fetchImpl,
      tabsApi,
      scriptingApi,
      getExtensionVersion: () => DEMO_EXTENSION_VERSION,
      extensionId: TEST_EXT_ID,
    }),
    handleTabUpdated: createTabUpdatedHandler({ tabsApi }),
    handleTabRemoved: createTabRemovedHandler(),
  });

  let { backgroundHandler, handleTabUpdated, handleTabRemoved } = buildSwHandlers();

  const popupSender: chrome.runtime.MessageSender = {
    id: TEST_EXT_ID,
    url: `chrome-extension://${TEST_EXT_ID}/popup/index.html`,
  };

  // Wire chrome.runtime.sendMessage so React <App /> can talk directly to real backgroundHandler
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: unknown) =>
    backgroundHandler(message, popupSender)) as unknown as typeof chrome.runtime.sendMessage);

  return {
    tabs,
    sentTabMessages,
    async sendFromPopup<T extends PopupRuntimeRequest['type']>(
      request: Extract<PopupRuntimeRequest, { type: T }>,
    ): Promise<MessageResponse<ExtensionResponseDataMap[T]>> {
      return (await backgroundHandler(request, popupSender)) as MessageResponse<
        ExtensionResponseDataMap[T]
      >;
    },
    simulateSwRestart() {
      // Fresh Service Worker instances sharing ONLY persisted chrome.storage.local & chrome.storage.session
      const rebuilt = buildSwHandlers();
      backgroundHandler = rebuilt.backgroundHandler;
      handleTabUpdated = rebuilt.handleTabUpdated;
      handleTabRemoved = rebuilt.handleTabRemoved;
    },
    async navigateTab(tabId: number, nextUrl: string, options?: { renderArticleShell?: boolean }) {
      const tab = tabs.get(tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} not found`);
      }
      tab.url = nextUrl;
      if (options?.renderArticleShell) {
        const existingHost = document.getElementById(CAPTURE_BAR_HOST_ID);
        document.body.innerHTML = `<article class="published-article"><h1>已发布公网文章示例</h1><p>正文内容</p></article>`;
        if (existingHost) {
          document.body.appendChild(existingHost);
        }
      }
      await act(async () => {
        await handleTabUpdated(tabId, { url: nextUrl, status: 'complete' }, toChromeTab(tab));
      });
    },
    async closeTab(tabId: number) {
      tabs.delete(tabId);
      await handleTabRemoved(tabId);
    },
  };
}

describe('Mock Bridge E2E Integration Regression (F19)', () => {
  afterEach(() => {
    act(() => {
      unmountCaptureBar(document);
    });
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    resetDefaultAdapters();
  });

  it('Flow 1 & 2: pairs via GET /api/v2/extension/me without leaking token and fetches all 3 platform tasks with filters', async () => {
    const bridge = createMockBridgeServer();
    const harness = createExtensionE2EHarness(bridge);

    // Flow 1: Pair account
    const pairRes = await harness.sendFromPopup({
      type: 'PAIR_ACCOUNT',
      payload: {
        baseUrl: `${DEMO_BASE_URL}/`,
        token: DEMO_TOKEN,
      },
    });

    expect(pairRes.ok).toBe(true);
    if (!pairRes.ok) {
      throw new Error(pairRes.error.message);
    }
    expect(pairRes.data.baseUrl).toBe(DEMO_BASE_URL);
    expect(pairRes.data.me.nickname).toBe('DemoOperator');
    expect(pairRes.data.me.brands).toHaveLength(2);
    expect(JSON.stringify(pairRes)).not.toContain(DEMO_TOKEN);

    const meReq = bridge.requests.find((r) => r.url.endsWith('/api/v2/extension/me'));
    expect(meReq).toBeDefined();
    expect(meReq?.method).toBe('GET');
    expect(meReq?.headers['authorization']).toBe(`Bearer ${DEMO_TOKEN}`);
    expect(meReq?.headers['x-geomix-extension-version']).toBe(DEMO_EXTENSION_VERSION);
    expect(meReq?.headers['accept']).toBe('application/json');

    // Stored in chrome.storage.local only; status query never returns raw token
    const storedPairing = await getPairing();
    expect(storedPairing?.baseUrl).toBe(DEMO_BASE_URL);
    expect(storedPairing?.token).toBe(DEMO_TOKEN);

    const statusRes = await harness.sendFromPopup({ type: 'GET_PAIRING_STATUS' });
    expect(statusRes.ok).toBe(true);
    expect(JSON.stringify(statusRes)).not.toContain(DEMO_TOKEN);

    // Flow 2: Fetch pending tasks across all 3 platforms
    const tasksRes = await harness.sendFromPopup({ type: 'FETCH_PENDING_TASKS' });
    expect(tasksRes.ok).toBe(true);
    if (!tasksRes.ok) {
      throw new Error(tasksRes.error.message);
    }
    expect(tasksRes.data.tasks).toHaveLength(3);
    expect(tasksRes.data.tasks.map((t) => t.provider).sort()).toEqual([
      'SMZDM_EXT',
      'TOUTIAO_EXT',
      'ZHIHU_EXT',
    ]);
    for (const task of tasksRes.data.tasks) {
      expect(task.mediaAssets).toHaveLength(2);
      expect(task.complianceChecklist.length).toBeGreaterThan(0);
    }

    const tasksReq = bridge.requests.find((r) => r.url.includes('/api/v2/extension/tasks'));
    expect(tasksReq?.url).toBe(
      `${DEMO_BASE_URL}/api/v2/extension/tasks?status=DRAFT_VARIANT%2CREADY_TO_PUBLISH`,
    );
    expect(tasksReq?.headers['authorization']).toBe(`Bearer ${DEMO_TOKEN}`);
    expect(tasksReq?.headers['x-geomix-extension-version']).toBe(DEMO_EXTENSION_VERSION);

    // Verify query parameter forwarding for brandId & provider filters
    const filteredRes = await harness.sendFromPopup({
      type: 'FETCH_PENDING_TASKS',
      payload: {
        brandId: 'brand_demo_1',
        provider: 'SMZDM_EXT',
      },
    });
    expect(filteredRes.ok).toBe(true);
    if (!filteredRes.ok) {
      throw new Error(filteredRes.error.message);
    }
    expect(filteredRes.data.tasks).toHaveLength(1);
    expect(filteredRes.data.tasks[0]?.provider).toBe('SMZDM_EXT');
  });

  it('Flow 3 (Zhihu): injects draft with anti-hotlink relay, handles HTTP 403 partial-media failure via Mode B Shadow DOM notice, and never clicks publish', async () => {
    const bridge = createMockBridgeServer();
    const harness = createExtensionE2EHarness(bridge);

    const pairRes = await harness.sendFromPopup({
      type: 'PAIR_ACCOUNT',
      payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN },
    });
    expect(pairRes.ok).toBe(true);

    // 3a. Happy path with 2 anti-hotlink images (PNG + WebP)
    let pushRes!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      pushRes = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.zhihuTask },
      });
    });

    expect(pushRes.ok).toBe(true);
    if (!pushRes.ok) {
      throw new Error(pushRes.error.message);
    }
    expect(pushRes.data.stage).toBe('INJECTED');
    expect(pushRes.data.report?.ok).toBe(true);
    expect(pushRes.data.report?.uploadedImages).toBe(2);
    expect(pushRes.data.report?.failedImages).toBe(0);

    const zhihuTabId = pushRes.data.tabId;
    expect(zhihuTabId).toBeDefined();
    const zhihuTab = harness.tabs.get(zhihuTabId!);
    expect(zhihuTab?.url).toBe(ZHIHU_DEMO_URLS.zhuanlanWrite);
    expect(zhihuTab?.reactTitleTracker?.getReactState()).toBe(bridge.zhihuTask.variantTitle);
    expect(zhihuTab?.reactTitleTracker?.wasDirectAssignmentUsed()).toBe(false);
    expect(document.querySelector('.public-DraftEditor-content')?.textContent).toContain(
      '核心测试结论',
    );
    expect(document.querySelectorAll('.public-DraftEditor-content img')).toHaveLength(0);
    expect(zhihuTab?.uploadedFiles.map((f) => f.type)).toEqual(['image/png', 'image/webp']);
    expect(zhihuTab?.publishClickSpy).not.toHaveBeenCalled();
    expect(getActiveCaptureBarHost(document)).toBeNull();

    // Verify chrome.storage.session stores pending task binding with zero token leakage
    const pendingTask = await getPendingTabTask(zhihuTabId!);
    expect(pendingTask?.taskId).toBe(bridge.zhihuTask.taskId);
    expect(JSON.stringify(pendingTask)).not.toContain(DEMO_TOKEN);

    // 3b. HTTP 403 partial-media failure -> Mode B Shadow DOM operator notice
    bridge.mediaFailures.set('https://cdn.example.com/assets/demo-chart-2.webp', { status: 403 });
    const partialTask = createZhihuDemoTask({
      taskId: 'task_zhihu_partial_403',
      brandId: 'brand_demo_1',
      brandName: '示例品牌甲',
    });

    let partialRes!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      partialRes = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: partialTask },
      });
    });

    expect(partialRes.ok).toBe(true);
    if (!partialRes.ok) {
      throw new Error(partialRes.error.message);
    }
    expect(partialRes.data.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(partialRes.data.report?.ok).toBe(false);
    expect(partialRes.data.report?.uploadedImages).toBe(1);
    expect(partialRes.data.report?.failedImages).toBe(1);
    expect(partialRes.data.report?.failedImageDetails?.[0]?.alt).toBe('场景实测数据图');
    expect(partialRes.data.report?.failedImageDetails?.[0]?.reason).toContain('403');
    expect(document.querySelectorAll('.public-DraftEditor-content img')).toHaveLength(0);

    const partialTab = harness.tabs.get(partialRes.data.tabId!);
    expect(partialTab?.publishClickSpy).not.toHaveBeenCalled();

    const host = getActiveCaptureBarHost(document);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(getActiveCaptureBarMode(document)).toBe('notice');
    expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain('all: initial;');
    expect(host?.shadowRoot?.querySelectorAll('img')).toHaveLength(0);
    const failedList = host?.shadowRoot?.querySelector('[data-testid="geomix-failed-images-list"]');
    expect(failedList?.textContent).toContain('场景实测数据图');
    expect(failedList?.textContent).toContain('cdn.example.com/assets/demo-chart-2.webp');
    expect(host?.shadowRoot?.textContent).not.toContain(DEMO_TOKEN);
  });

  it('Flow 3, 4 & 5: completes full 3-platform lifecycle (Zhihu + Toutiao + SMZDM) across SW restart, draft rejection, Shadow DOM Mode A capture, and idempotent confirm-published', async () => {
    const bridge = createMockBridgeServer();
    const harness = createExtensionE2EHarness(bridge);

    const pairRes = await harness.sendFromPopup({
      type: 'PAIR_ACCOUNT',
      payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN },
    });
    expect(pairRes.ok).toBe(true);

    // =========================================================================
    // PLATFORM 1: ZHIHU_EXT
    // =========================================================================
    let zhihuPush!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      zhihuPush = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.zhihuTask },
      });
    });
    expect(zhihuPush.ok).toBe(true);
    if (!zhihuPush.ok) {
      throw new Error(zhihuPush.error.message);
    }
    const zhihuTabId = zhihuPush.data.tabId!;

    // Simulate MV3 Service Worker hibernation / restart before navigation!
    harness.simulateSwRestart();

    // Draft edit URL & cross-provider URL must be rejected
    await harness.navigateTab(zhihuTabId, ZHIHU_DEMO_URLS.zhuanlanDraftEdit);
    expect(getActiveCaptureBarHost(document)).toBeNull();
    await harness.navigateTab(zhihuTabId, SMZDM_PUBLISHED_URL);
    expect(getActiveCaptureBarHost(document)).toBeNull();

    // Navigate to dirty published Zhihu URL -> stripped canonical URL in Shadow DOM Mode A
    await harness.navigateTab(
      zhihuTabId,
      'https://zhuanlan.zhihu.com/p/123456789/?utm_source=demo&share_code=xyz#comments',
      { renderArticleShell: true },
    );

    const zhihuCanonicalUrl = 'https://zhuanlan.zhihu.com/p/123456789';
    const zhihuHost = getActiveCaptureBarHost(document);
    expect(zhihuHost).not.toBeNull();
    expect(getActiveCaptureBarMode(document)).toBe('capture');
    expect(zhihuHost?.shadowRoot?.querySelector('style')?.textContent).toContain(':host {');
    expect(zhihuHost?.shadowRoot?.querySelector('style')?.textContent).toContain('all: initial;');
    expect(document.head.querySelectorAll('style')).toHaveLength(0);

    const zhihuShadow = within(zhihuHost!.shadowRoot as unknown as HTMLElement);
    expect((await zhihuShadow.findByTestId('geomix-captured-url')).textContent).toBe(
      zhihuCanonicalUrl,
    );
    expect(zhihuHost?.shadowRoot?.textContent).not.toContain(DEMO_TOKEN);

    // Verify no button in Shadow DOM attempts platform publish
    for (const btn of Array.from(zhihuHost!.shadowRoot!.querySelectorAll('button'))) {
      expect(btn.textContent).not.toContain('发布');
    }

    // Flow 5: Synchronous double-click on CTA -> single POST confirm-published
    const zhihuConfirmBtn = await zhihuShadow.findByRole('button', {
      name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
    });
    await act(async () => {
      fireEvent.click(zhihuConfirmBtn);
      fireEvent.click(zhihuConfirmBtn);
    });

    await waitFor(() => {
      expect(zhihuHost?.shadowRoot?.textContent).toContain('已成功回传至 GeoMix！');
    });
    expect(zhihuHost?.shadowRoot?.textContent).toContain('pub_demo_1');
    expect(zhihuHost?.shadowRoot?.textContent).toContain('T+1 抓取探针已排队');
    expect(zhihuHost?.shadowRoot?.textContent).toContain('T+7 / T+14 / T+30 复测已预约');

    const zhihuConfirmReqs = bridge.requests.filter((r) =>
      r.url.endsWith(`/api/v2/extension/tasks/${bridge.zhihuTask.taskId}/confirm-published`),
    );
    expect(zhihuConfirmReqs).toHaveLength(1);
    const expectedZhihuKey = await deriveConfirmPublishedIdempotencyKey(
      bridge.zhihuTask.taskId,
      zhihuCanonicalUrl,
    );
    expect(zhihuConfirmReqs[0]?.headers['idempotency-key']).toBe(expectedZhihuKey);
    expect(zhihuConfirmReqs[0]?.headers['authorization']).toBe(`Bearer ${DEMO_TOKEN}`);
    expect(zhihuConfirmReqs[0]?.headers['x-geomix-extension-version']).toBe(DEMO_EXTENSION_VERSION);
    expect(JSON.parse(zhihuConfirmReqs[0]?.body ?? '{}')).toEqual({
      publishedUrl: zhihuCanonicalUrl,
    });

    // Session tab binding cleared on success; green confirmed banner survives same-article hash change
    expect(await getPendingTabTask(zhihuTabId)).toBeNull();
    await harness.navigateTab(zhihuTabId, `${zhihuCanonicalUrl}#comment-anchor`);
    expect(zhihuHost?.shadowRoot?.textContent).toContain('已成功回传至 GeoMix！');

    // Explicit network/SW retry idempotency: same taskId + URL (even with trailing slash) sends identical Idempotency-Key and produces ZERO duplicate records
    const directClient = createBridgeClient({
      baseUrl: DEMO_BASE_URL,
      token: DEMO_TOKEN,
      extensionVersion: DEMO_EXTENSION_VERSION,
      fetchImpl: bridge.fetchImpl,
    });
    const retryResult = await directClient.confirmPublished(bridge.zhihuTask.taskId, {
      publishedUrl: `${zhihuCanonicalUrl}/`,
    });
    expect(retryResult.publishRecordId).toBe('pub_demo_1');
    expect(retryResult.crawlProbeQueued).toBe(true);
    expect(retryResult.retestMilestones).toEqual([7, 14, 30]);
    expect(bridge.publishRecords).toHaveLength(1);

    // =========================================================================
    // PLATFORM 2: TOUTIAO_EXT
    // =========================================================================
    let toutiaoPush!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      toutiaoPush = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.toutiaoTask },
      });
    });
    expect(toutiaoPush.ok).toBe(true);
    if (!toutiaoPush.ok) {
      throw new Error(toutiaoPush.error.message);
    }
    expect(toutiaoPush.data.stage).toBe('INJECTED');
    expect(toutiaoPush.data.report?.uploadedImages).toBe(2);
    expect(toutiaoPush.data.report?.failedImages).toBe(0);

    const toutiaoTabId = toutiaoPush.data.tabId!;
    const toutiaoTab = harness.tabs.get(toutiaoTabId)!;
    expect(toutiaoTab.url).toBe(TOUTIAO_EDITOR_URL);
    expect(document.querySelector<HTMLTextAreaElement>('.editor-title')?.value).toBe(
      bridge.toutiaoTask.variantTitle,
    );
    expect(document.querySelector('.ProseMirror')?.textContent).toContain('实测核心结论');
    expect(document.querySelectorAll('.ProseMirror img')).toHaveLength(0);
    expect(toutiaoTab.uploadedFiles.map((f) => f.type)).toEqual(['image/png', 'image/webp']);
    // Safe draft save clicked once; publish & preview-publish clicked ZERO times
    expect(toutiaoTab.saveDraftClickSpy).toHaveBeenCalledTimes(1);
    expect(toutiaoTab.publishClickSpy).not.toHaveBeenCalled();

    // Draft query URL rejected -> dirty public article URL normalized & confirmed
    harness.simulateSwRestart();
    await harness.navigateTab(toutiaoTabId, TOUTIAO_EDITOR_QUERY_URL);
    expect(getActiveCaptureBarHost(document)).toBeNull();

    const toutiaoCanonicalUrl = `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`;
    await harness.navigateTab(
      toutiaoTabId,
      `${toutiaoCanonicalUrl}/?log_from=demo&utm_campaign=test#comment`,
      { renderArticleShell: true },
    );

    const toutiaoHost = getActiveCaptureBarHost(document);
    expect(toutiaoHost).not.toBeNull();
    expect(getActiveCaptureBarMode(document)).toBe('capture');
    const toutiaoShadow = within(toutiaoHost!.shadowRoot as unknown as HTMLElement);
    expect((await toutiaoShadow.findByTestId('geomix-captured-url')).textContent).toBe(
      toutiaoCanonicalUrl,
    );

    await act(async () => {
      fireEvent.click(
        await toutiaoShadow.findByRole('button', {
          name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
        }),
      );
    });
    await waitFor(() => {
      expect(toutiaoHost?.shadowRoot?.textContent).toContain('pub_demo_2');
    });
    expect(await getPendingTabTask(toutiaoTabId)).toBeNull();

    // =========================================================================
    // PLATFORM 3: SMZDM_EXT
    // =========================================================================
    let smzdmPush!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      smzdmPush = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.smzdmTask },
      });
    });
    expect(smzdmPush.ok).toBe(true);
    if (!smzdmPush.ok) {
      throw new Error(smzdmPush.error.message);
    }
    expect(smzdmPush.data.stage).toBe('INJECTED');
    expect(smzdmPush.data.report?.uploadedImages).toBe(2);
    expect(smzdmPush.data.report?.failedImages).toBe(0);
    expect(smzdmPush.data.report?.operatorReminders?.join(' ')).toContain('商品卡片');
    expect(smzdmPush.data.report?.operatorReminders?.join(' ')).toContain('合规披露声明');

    const smzdmTabId = smzdmPush.data.tabId!;
    const smzdmTab = harness.tabs.get(smzdmTabId)!;
    expect(smzdmTab.url).toBe(SMZDM_EDITOR_URL);

    // Parameter comparison table + measured-data block preserved; zero external <img>
    const smzdmEditor = document.querySelector<HTMLElement>('[data-testid="smzdm-editor-body"]');
    expect(smzdmEditor?.querySelector('table')).not.toBeNull();
    expect(smzdmEditor?.querySelector('thead')).not.toBeNull();
    expect(smzdmEditor?.querySelector('tbody')).not.toBeNull();
    expect(smzdmEditor?.innerHTML).toContain('12.5 小时');
    expect(smzdmEditor?.innerHTML).toContain('colspan="2"');
    expect(smzdmEditor?.querySelector('section.measured-data-section')).not.toBeNull();
    expect(smzdmEditor?.textContent).toContain('39.2℃');
    expect(smzdmEditor?.textContent).toContain('34 分钟');
    expect(smzdmEditor?.querySelectorAll('img')).toHaveLength(0);
    expect(smzdmTab.uploadedFiles.map((f) => f.type)).toEqual(['image/png', 'image/webp']);

    // Safe save-draft clicked once; submit-review & publish clicked ZERO times
    expect(smzdmTab.saveDraftClickSpy).toHaveBeenCalledTimes(1);
    expect(smzdmTab.publishClickSpy).not.toHaveBeenCalled();

    // SMZDM operator reminders automatically mount Shadow DOM Mode B notice
    const smzdmNoticeHost = getActiveCaptureBarHost(document);
    expect(smzdmNoticeHost).not.toBeNull();
    expect(getActiveCaptureBarMode(document)).toBe('notice');
    const remindersList = smzdmNoticeHost?.shadowRoot?.querySelector(
      '[data-testid="geomix-operator-reminders-list"]',
    );
    expect(remindersList?.textContent).toContain('商品卡片');
    expect(remindersList?.textContent).toContain('合规披露声明');

    // Draft query URL rejected (does NOT upgrade to Mode A capture bar)
    harness.simulateSwRestart();
    await harness.navigateTab(smzdmTabId, SMZDM_EDITOR_DRAFT_URL);
    expect(getActiveCaptureBarMode(document)).toBe('notice');

    // Navigate to dirty published SMZDM URL -> Mode A replaces Mode B cleanly (strictly 1 host)
    await harness.navigateTab(smzdmTabId, SMZDM_PUBLISHED_DIRTY_URL, {
      renderArticleShell: true,
    });
    expect(document.querySelectorAll(`#${CAPTURE_BAR_HOST_ID}`)).toHaveLength(1);
    expect(getActiveCaptureBarMode(document)).toBe('capture');

    const smzdmHost = getActiveCaptureBarHost(document)!;
    const smzdmShadow = within(smzdmHost.shadowRoot as unknown as HTMLElement);
    expect((await smzdmShadow.findByTestId('geomix-captured-url')).textContent).toBe(
      SMZDM_PUBLISHED_URL,
    );

    await act(async () => {
      fireEvent.click(
        await smzdmShadow.findByRole('button', {
          name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
        }),
      );
    });
    await waitFor(() => {
      expect(smzdmHost.shadowRoot?.textContent).toContain('pub_demo_3');
    });
    expect(await getPendingTabTask(smzdmTabId)).toBeNull();

    // All 3 platforms produced exactly 3 unique publish records with zero duplicates
    expect(bridge.publishRecords.map((r) => r.publishRecordId)).toEqual([
      'pub_demo_1',
      'pub_demo_2',
      'pub_demo_3',
    ]);
    expect(bridge.publishRecords.map((r) => r.publishedUrl)).toEqual([
      zhihuCanonicalUrl,
      toutiaoCanonicalUrl,
      SMZDM_PUBLISHED_URL,
    ]);
  });

  it('Flow 6: degrades gracefully on HTTP 401 token revocation (preserving session binding) and clears local + session storage on one-click unbind', async () => {
    const bridge = createMockBridgeServer();
    const harness = createExtensionE2EHarness(bridge);

    // Pair and inject a Zhihu draft so BOTH chrome.storage.local and chrome.storage.session are populated
    const pairRes = await harness.sendFromPopup({
      type: 'PAIR_ACCOUNT',
      payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN },
    });
    expect(pairRes.ok).toBe(true);

    let pushRes!: MessageResponse<PushDraftTaskResponseData>;
    await act(async () => {
      pushRes = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.zhihuTask },
      });
    });
    expect(pushRes.ok).toBe(true);
    if (!pushRes.ok) {
      throw new Error(pushRes.error.message);
    }
    const zhihuTabId = pushRes.data.tabId!;

    // Navigate to published Zhihu URL so Shadow DOM Mode A is active
    await harness.navigateTab(zhihuTabId, ZHIHU_DEMO_URLS.publishedArticle, {
      renderArticleShell: true,
    });
    expect(getActiveCaptureBarMode(document)).toBe('capture');

    // Revoke token on server (simulates token revocation / expiration -> HTTP 401)
    bridge.revokeToken();

    // 6a. Background FETCH_PENDING_TASKS returns structured 401 UNAUTHORIZED without leaking token
    const revokedTasksRes = await harness.sendFromPopup({ type: 'FETCH_PENDING_TASKS' });
    expect(revokedTasksRes.ok).toBe(false);
    if (revokedTasksRes.ok) {
      throw new Error('Expected HTTP 401 failure after token revocation');
    }
    expect(revokedTasksRes.error.kind).toBe('UNAUTHORIZED');
    expect(revokedTasksRes.error.httpStatus).toBe(401);
    expect(revokedTasksRes.error.reauthRequired).toBe(true);
    expect(JSON.stringify(revokedTasksRes)).not.toContain(DEMO_TOKEN);

    // 6b. Shadow DOM Mode A confirm click gets 401 alert AND preserves chrome.storage.session tab binding
    const captureHost = getActiveCaptureBarHost(document)!;
    const captureShadow = within(captureHost.shadowRoot as unknown as HTMLElement);
    await act(async () => {
      fireEvent.click(
        await captureShadow.findByRole('button', {
          name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
        }),
      );
    });

    const captureAlert = await captureShadow.findByRole('alert');
    expect(captureAlert.textContent).toContain('401');
    expect(captureAlert.textContent).not.toContain(DEMO_TOKEN);
    expect(await getPendingTabTask(zhihuTabId)).not.toBeNull();
    expect(await listPendingTabTasks()).toHaveLength(1);

    // 6c. Popup <App /> displays 401 re-pair alert:
    //     - Clicking "重新配对" immediately wipes chrome.storage.local token while preserving
    //       chrome.storage.session PendingTabTask so re-pairing with a rotated token recovers confirm.
    //     - Clicking explicit "解除绑定" immediately wipes BOTH chrome.storage.local AND chrome.storage.session.
    act(() => {
      unmountCaptureBar(document);
    });
    document.body.innerHTML = '';

    const popupView = render(createElement(App));
    const popupAlert = await screen.findByRole('alert');
    expect(popupAlert.textContent).toContain('401');
    expect(popupAlert.textContent).not.toContain(DEMO_TOKEN);

    // Click "重新配对" in the 401 banner -> local pairing cleared immediately, session binding preserved for 401 recovery
    const rePairBtn = screen.getByRole('button', { name: '重新配对' });
    fireEvent.click(rePairBtn);

    // Popup transitions back to pairing view
    await screen.findByRole('button', { name: '验证并配对' });
    expect(await getPairing()).toBeNull();
    const localAfterReauth = await chrome.storage.local.get(null);
    expect(localAfterReauth[PAIRING_STORAGE_KEY]).toBeUndefined();
    expect(await getPendingTabTask(zhihuTabId)).not.toBeNull();
    expect(await listPendingTabTasks()).toHaveLength(1);

    // Re-pair in Popup with a rotated token for the same account -> recovers & confirms published URL
    const rotatedToken = 'gmext_demo_e2e_rotated_2026';
    bridge.restoreToken(rotatedToken);
    (chrome.permissions.contains as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    fireEvent.change(screen.getByLabelText('GeoMix 服务地址'), {
      target: { value: DEMO_BASE_URL },
    });
    fireEvent.change(screen.getByLabelText('配对 Token（gmext_）'), {
      target: { value: rotatedToken },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    await screen.findByText('DemoOperator');
    expect(await getPendingTabTask(zhihuTabId)).not.toBeNull();

    // Retry confirm on the published tab using the preserved session binding & rotated token
    let recoveredConfirm!: Awaited<
      ReturnType<
        NonNullable<ReturnType<typeof harness.tabs.get>>['coordinator']['evaluateCurrentUrl']
      >
    >;
    await act(async () => {
      recoveredConfirm = await harness.tabs.get(zhihuTabId)!.coordinator.evaluateCurrentUrl();
    });
    expect(recoveredConfirm.matched).toBe(true);
    const recoveredHost = getActiveCaptureBarHost(document)!;
    const recoveredShadow = within(recoveredHost.shadowRoot as unknown as HTMLElement);
    await act(async () => {
      fireEvent.click(
        await recoveredShadow.findByRole('button', {
          name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
        }),
      );
    });
    await waitFor(() => {
      expect(recoveredHost.shadowRoot?.textContent).toContain('已成功回传至 GeoMix！');
    });
    expect(bridge.publishRecords).toHaveLength(1);
    expect(await getPendingTabTask(zhihuTabId)).toBeNull();

    // Push another task so chrome.storage.session is populated again, then test explicit "解除绑定" full wipe
    act(() => {
      unmountCaptureBar(document);
    });
    await act(async () => {
      const secondPush = await harness.sendFromPopup({
        type: 'PUSH_DRAFT_TASK',
        payload: { task: bridge.toutiaoTask },
      });
      expect(secondPush.ok).toBe(true);
    });
    expect(await listPendingTabTasks()).toHaveLength(1);

    // Click explicit "解除绑定" button in Popup AccountHeader -> wipes BOTH local and session storage
    popupView.unmount();
    render(createElement(App));
    const unbindBtn = await screen.findByRole('button', { name: '解除绑定' });
    fireEvent.click(unbindBtn);

    await screen.findByRole('button', { name: '验证并配对' });

    // Both chrome.storage.local (pairing) and chrome.storage.session (tab tasks) must be completely wiped
    expect(await getPairing()).toBeNull();
    expect(await listPendingTabTasks()).toEqual([]);
    const localDump = await chrome.storage.local.get(null);
    const sessionDump = await chrome.storage.session.get(null);
    expect(localDump[PAIRING_STORAGE_KEY]).toBeUndefined();
    expect(sessionDump[TAB_TASKS_STORAGE_KEY]).toBeUndefined();

    // Subsequent status & tasks calls confirm unbound state cleanly
    const postUnbindStatus = await harness.sendFromPopup({ type: 'GET_PAIRING_STATUS' });
    expect(postUnbindStatus).toEqual({ ok: true, data: { paired: false } });

    const postUnbindTasks = await harness.sendFromPopup({ type: 'FETCH_PENDING_TASKS' });
    expect(postUnbindTasks.ok).toBe(false);
    if (!postUnbindTasks.ok) {
      expect(postUnbindTasks.error.kind).toBe('NOT_PAIRED');
      expect(postUnbindTasks.error.reauthRequired).toBe(true);
    }
  });
});
