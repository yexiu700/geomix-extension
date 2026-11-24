import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, registerAdapter, resetDefaultAdapters } from '../adapters/registry';
import type { DraftInjectReport, PlatformDraftAdapter } from '../adapters/types';
import type { ExtensionPendingTaskDto } from '../shared/bridge-contract';
import type {
  ExtensionResponseDataMap,
  ExtensionRuntimeRequest,
  MessageResponse,
} from '../shared/messages';
import type { PendingTabTask } from '../shared/storage';
import { PUBLISHED_URL_PATTERNS } from '../shared/url-validation';
import {
  createContentMessageHandler,
  createUrlCaptureCoordinator,
  installUrlWatcher,
} from './index';
import { getActiveCaptureBarHost, unmountCaptureBar } from './url-capture-bar';

const TEST_EXT_ID = 'geomix-test-extension-id';

const DEMO_TASK: ExtensionPendingTaskDto = {
  taskId: 'task_zhihu_1',
  articleId: 'art_1',
  brandId: 'brand_demo_1',
  brandName: '示例品牌甲',
  provider: 'ZHIHU_EXT',
  channelLabel: '知乎专栏',
  status: 'READY_TO_PUBLISH',
  variantTitle: '示例品牌甲知乎实测专栏',
  variantMarkdown: '# 标题\n正文',
  variantHtml: '<h1>标题</h1><p>正文</p>',
  targetUrlHint: null,
  mediaAssets: [],
  complianceChecklist: ['避免绝对化用语'],
  updatedAt: '2026-06-01T10:00:00.000Z',
};

const DEMO_PENDING_TAB_TASK: PendingTabTask = {
  tabId: 101,
  taskId: 'task_zhihu_1',
  articleId: 'art_1',
  brandId: 'brand_demo_1',
  brandName: '示例品牌甲',
  provider: 'ZHIHU_EXT',
  variantTitle: '示例品牌甲知乎实测专栏',
  complianceChecklist: ['避免绝对化用语'],
};

function makeAdapter(overrides?: Partial<PlatformDraftAdapter>): PlatformDraftAdapter {
  return {
    provider: 'ZHIHU_EXT',
    displayName: '知乎',
    editorEntryUrl: 'https://zhuanlan.zhihu.com/write',
    publishedUrlPatterns: PUBLISHED_URL_PATTERNS.ZHIHU_EXT,
    isLoggedInEditor: () => true,
    injectDraft: async (): Promise<DraftInjectReport> => ({
      ok: true,
      stage: 'INJECTED',
      uploadedImages: 0,
      failedImages: 0,
      message: '已写入草稿箱',
    }),
    extractPublishedUrl: (url) => url.href,
    ...overrides,
  };
}

function invokeHandler(
  handler: ReturnType<typeof createContentMessageHandler>,
  message: unknown,
  sender: chrome.runtime.MessageSender = { id: TEST_EXT_ID },
): Promise<{ handled: boolean; response?: unknown }> {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (resp: unknown) => {
      responded = true;
      resolve({ handled: true, response: resp });
    };
    const isAsync = handler(message, sender, sendResponse);
    if (!isAsync && !responded) {
      resolve({ handled: false });
    }
  });
}

describe('content/index runtime & SPA URL capture coordinator', () => {
  afterEach(() => {
    resetDefaultAdapters();
    act(() => {
      unmountCaptureBar();
    });
  });

  it('responds to PING_CONTENT and rejects foreign, missing, or tab senders fail-closed', async () => {
    const handler = createContentMessageHandler({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/write'),
    });

    const okRes = await invokeHandler(handler, { type: 'PING_CONTENT' }, { id: TEST_EXT_ID });
    expect(okRes).toEqual({
      handled: true,
      response: {
        ok: true,
        data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' },
      },
    });

    expect(
      (await invokeHandler(handler, { type: 'PING_CONTENT' }, { id: 'foreign-ext' })).handled,
    ).toBe(false);
    expect((await invokeHandler(handler, { type: 'PING_CONTENT' }, {})).handled).toBe(false);
    expect(
      (
        await invokeHandler(
          handler,
          { type: 'PING_CONTENT' },
          { id: TEST_EXT_ID, tab: { id: 1 } as chrome.tabs.Tab },
        )
      ).handled,
    ).toBe(false);
  });

  it('handles INJECT_DRAFT across missing adapter, AUTH_REQUIRED, INJECTED, and PARTIAL_MEDIA_FAILED (mounting Mode B)', async () => {
    const handler = createContentMessageHandler({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/write'),
    });

    // 1) No adapter registered -> EDITOR_NOT_FOUND
    clearAdapters();
    const noAdapterRes = await invokeHandler(handler, {
      type: 'INJECT_DRAFT',
      payload: { task: DEMO_TASK },
    });
    expect(noAdapterRes.response).toMatchObject({
      ok: true,
      data: { ok: false, stage: 'EDITOR_NOT_FOUND' },
    });

    // 2) Not logged in -> AUTH_REQUIRED without calling injectDraft
    const injectSpy = vi.fn();
    registerAdapter(
      makeAdapter({
        isLoggedInEditor: () => false,
        injectDraft: injectSpy,
      }),
    );
    const authRes = await invokeHandler(handler, {
      type: 'INJECT_DRAFT',
      payload: { task: DEMO_TASK },
    });
    expect(authRes.response).toMatchObject({
      ok: true,
      data: { ok: false, stage: 'AUTH_REQUIRED' },
    });
    expect(injectSpy).not.toHaveBeenCalled();

    // 3) Clean INJECTED (0 failed images, no reminders) -> does NOT mount notice bar
    registerAdapter(makeAdapter());
    const injectedRes = await invokeHandler(handler, {
      type: 'INJECT_DRAFT',
      payload: { task: DEMO_TASK },
    });
    expect(injectedRes.response).toMatchObject({
      ok: true,
      data: { ok: true, stage: 'INJECTED' },
    });
    expect(getActiveCaptureBarHost()).toBeNull();

    // 4) PARTIAL_MEDIA_FAILED -> mounts Mode B Operator Notice bar in Shadow DOM
    registerAdapter(
      makeAdapter({
        injectDraft: async () => ({
          ok: false,
          stage: 'PARTIAL_MEDIA_FAILED',
          uploadedImages: 1,
          failedImages: 1,
          failedImageDetails: [
            { url: 'https://cdn.example.com/fail.png', alt: '失败配图', reason: '下载超时' },
          ],
          operatorReminders: ['请核对文末免责声明'],
          message: '正文已写入，1 张配图失败',
        }),
      }),
    );

    let partialRes!: Awaited<ReturnType<typeof invokeHandler>>;
    await act(async () => {
      partialRes = await invokeHandler(handler, {
        type: 'INJECT_DRAFT',
        payload: { task: DEMO_TASK },
      });
    });
    expect(partialRes.response).toMatchObject({
      ok: true,
      data: { stage: 'PARTIAL_MEDIA_FAILED', failedImages: 1 },
    });

    const host = getActiveCaptureBarHost();
    expect(host).not.toBeNull();
    const shadow = within(host!.shadowRoot as unknown as HTMLElement);
    expect(await shadow.findByText('GeoMix 草稿写入提醒')).toBeTruthy();
    expect(shadow.getByText(/失败配图：下载超时/)).toBeTruthy();
    expect(shadow.getByText('请核对文末免责声明')).toBeTruthy();
  });

  it('captures published URLs via SPA history watcher & TAB_URL_CHANGED, ignores orphan/draft tabs, deduplicates, and respects dismiss', async () => {
    let currentHref = 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#top';
    let currentPendingTask: PendingTabTask | null = null;

    const sendMessage = vi.fn(
      async <TReq extends ExtensionRuntimeRequest>(
        req: TReq,
      ): Promise<MessageResponse<ExtensionResponseDataMap[TReq['type']]>> => {
        if (req.type === 'GET_PENDING_TAB_TASK') {
          return {
            ok: true,
            data: { task: currentPendingTask },
          } as MessageResponse<ExtensionResponseDataMap[TReq['type']]>;
        }
        return {
          ok: true,
          data: {
            taskId: 'task_zhihu_1',
            status: 'PUBLISHED',
            publishRecordId: 'pub_demo_1',
            publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
            crawlProbeQueued: true,
            retestMilestones: [7, 14, 30],
          },
        } as MessageResponse<ExtensionResponseDataMap[TReq['type']]>;
      },
    );

    const coordinator = createUrlCaptureCoordinator({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL(currentHref),
      sendMessage,
    });
    const handler = createContentMessageHandler(
      {
        extensionId: TEST_EXT_ID,
        getCurrentUrl: () => new URL(currentHref),
        sendMessage,
      },
      coordinator,
    );

    // 1) Orphan tab (no PendingTabTask) -> NEVER mounts capture bar
    const orphanResult = await coordinator.evaluateCurrentUrl();
    expect(orphanResult).toEqual({ checked: true, matched: false });
    expect(getActiveCaptureBarHost()).toBeNull();

    // 2) Linked tab on draft/edit URL -> NEVER mounts capture bar
    currentPendingTask = DEMO_PENDING_TAB_TASK;
    currentHref = 'https://zhuanlan.zhihu.com/p/123456789/edit';
    const draftResult = await coordinator.evaluateCurrentUrl();
    expect(draftResult).toEqual({ checked: true, matched: false });
    expect(getActiveCaptureBarHost()).toBeNull();

    // 3) Linked tab navigates to published URL with query & hash -> mounts Mode A with canonical URL
    currentHref = 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#top';
    let pubResult!: Awaited<ReturnType<typeof invokeHandler>>;
    await act(async () => {
      pubResult = await invokeHandler(handler, {
        type: 'TAB_URL_CHANGED',
        payload: { url: 'https://zhuanlan.zhihu.com/p/123456789' },
      });
    });
    expect(pubResult.response).toEqual({
      ok: true,
      data: {
        checked: true,
        matched: true,
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      },
    });

    const host1 = getActiveCaptureBarHost();
    expect(host1).not.toBeNull();
    const shadow = within(host1!.shadowRoot as unknown as HTMLElement);
    expect(await shadow.findByTestId('geomix-captured-url')).toBeTruthy();
    expect(shadow.getByTestId('geomix-captured-url').textContent).toBe(
      'https://zhuanlan.zhihu.com/p/123456789',
    );

    // 4) Duplicate evaluation for same (taskId, canonicalUrl) keeps exact same host instance
    await coordinator.evaluateCurrentUrl();
    expect(getActiveCaptureBarHost()).toBe(host1);

    // 5) Dismissing prevents remount for same (taskId, canonicalUrl)
    fireEvent.click(shadow.getByRole('button', { name: '关闭' }));
    expect(getActiveCaptureBarHost()).toBeNull();

    await coordinator.evaluateCurrentUrl();
    expect(getActiveCaptureBarHost()).toBeNull();

    // 6) New canonical URL mounts fresh
    currentHref = 'https://zhuanlan.zhihu.com/p/999888777';
    await act(async () => {
      await coordinator.evaluateCurrentUrl();
    });
    await waitFor(() => {
      expect(getActiveCaptureBarHost()).not.toBeNull();
    });
  });

  it('still blocks invalid/draft URLs returned by a buggy adapter via mandatory validatePublishedUrl double-check', async () => {
    registerAdapter(
      makeAdapter({
        extractPublishedUrl: () => 'https://zhuanlan.zhihu.com/p/123456789/edit',
      }),
    );

    const coordinator = createUrlCaptureCoordinator({
      getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/p/123456789'),
      sendMessage: vi.fn(
        async () =>
          ({
            ok: true,
            data: { task: DEMO_PENDING_TAB_TASK },
          }) as MessageResponse<never>,
      ),
    });

    const result = await coordinator.evaluateCurrentUrl();
    expect(result).toEqual({ checked: true, matched: false });
    expect(getActiveCaptureBarHost()).toBeNull();
  });

  it('installs and cleanly restores SPA history.pushState, history.replaceState, popstate, and hashchange watchers', () => {
    const onUrlChange = vi.fn();
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;

    const cleanup = installUrlWatcher(onUrlChange, window);

    window.history.pushState({}, '', '/step-1');
    window.history.replaceState({}, '', '/step-2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(onUrlChange).toHaveBeenCalledTimes(4);

    cleanup();
    expect(window.history.pushState).toBe(origPush);
    expect(window.history.replaceState).toBe(origReplace);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(onUrlChange).toHaveBeenCalledTimes(4);
  });

  it('preserves confirmed green banner across same-article SPA hashchange/replaceState after session binding is cleared, and unmounts on navigating away', async () => {
    let currentHref = 'https://zhuanlan.zhihu.com/p/55667788';
    let currentPendingTask: PendingTabTask | null = DEMO_PENDING_TAB_TASK;

    const sendMessage = vi.fn(
      async <TReq extends ExtensionRuntimeRequest>(
        req: TReq,
      ): Promise<MessageResponse<ExtensionResponseDataMap[TReq['type']]>> => {
        if (req.type === 'GET_PENDING_TAB_TASK') {
          return {
            ok: true,
            data: { task: currentPendingTask },
          } as MessageResponse<ExtensionResponseDataMap[TReq['type']]>;
        }
        // Simulate SW clearing session binding immediately upon successful confirmation
        currentPendingTask = null;
        return {
          ok: true,
          data: {
            taskId: 'task_zhihu_1',
            status: 'PUBLISHED',
            publishRecordId: 'pub_demo_confirmed',
            publishedUrl: 'https://zhuanlan.zhihu.com/p/55667788',
            crawlProbeQueued: true,
            retestMilestones: [7, 14, 30],
          },
        } as MessageResponse<ExtensionResponseDataMap[TReq['type']]>;
      },
    );

    const coordinator = createUrlCaptureCoordinator({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL(currentHref),
      sendMessage,
    });

    await act(async () => {
      await coordinator.evaluateCurrentUrl();
    });

    const host = getActiveCaptureBarHost();
    expect(host).not.toBeNull();
    const shadow = within(host!.shadowRoot as unknown as HTMLElement);
    const confirmBtn = await shadow.findByRole('button', {
      name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(await shadow.findByText('已成功回传至 GeoMix！')).toBeTruthy();
    expect(currentPendingTask).toBeNull();

    // Simulate SPA hashchange / replaceState on the SAME published article
    currentHref = 'https://zhuanlan.zhihu.com/p/55667788?utm_source=spa#comments';
    const sameArticleRes = await coordinator.evaluateCurrentUrl();
    expect(sameArticleRes).toEqual({
      checked: true,
      matched: true,
      publishedUrl: 'https://zhuanlan.zhihu.com/p/55667788',
    });
    expect(getActiveCaptureBarHost()).toBe(host);
    expect(shadow.getByText('已成功回传至 GeoMix！')).toBeTruthy();

    // Navigating away to a different article MUST unmount the confirmed bar
    currentHref = 'https://zhuanlan.zhihu.com/p/99999999';
    let navAwayRes!: Awaited<ReturnType<typeof coordinator.evaluateCurrentUrl>>;
    await act(async () => {
      navAwayRes = await coordinator.evaluateCurrentUrl();
    });
    expect(navAwayRes).toEqual({ checked: true, matched: false });
    expect(getActiveCaptureBarHost()).toBeNull();
  });

  it('unmounts stale Mode B operator notice bar when a subsequent INJECT_DRAFT retry succeeds cleanly', async () => {
    const handler = createContentMessageHandler({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/write'),
    });

    registerAdapter(
      makeAdapter({
        injectDraft: async () => ({
          ok: false,
          stage: 'PARTIAL_MEDIA_FAILED',
          uploadedImages: 1,
          failedImages: 1,
          failedImageDetails: [
            { url: 'https://cdn.example.com/fail.png', alt: '失败图', reason: '下载超时' },
          ],
          message: '部分配图失败',
        }),
      }),
    );

    await act(async () => {
      await invokeHandler(handler, { type: 'INJECT_DRAFT', payload: { task: DEMO_TASK } });
    });
    expect(getActiveCaptureBarHost()).not.toBeNull();

    // Retry succeeds cleanly with 0 failed images and no operator reminders -> stale Mode B unmounted
    registerAdapter(makeAdapter());
    let retryRes!: Awaited<ReturnType<typeof invokeHandler>>;
    await act(async () => {
      retryRes = await invokeHandler(handler, {
        type: 'INJECT_DRAFT',
        payload: { task: DEMO_TASK },
      });
    });
    expect(retryRes.response).toMatchObject({
      ok: true,
      data: { ok: true, stage: 'INJECTED', failedImages: 0 },
    });
    expect(getActiveCaptureBarHost()).toBeNull();
  });

  it('handles throwing adapter.extractPublishedUrl and adapter.isLoggedInEditor gracefully without leaving sendResponse uncalled', async () => {
    registerAdapter(
      makeAdapter({
        isLoggedInEditor: () => {
          throw new Error('DOM exploded with gmext_demo_secret_token_42');
        },
        extractPublishedUrl: () => {
          throw new Error('extract boom');
        },
      }),
    );

    const coordinator = createUrlCaptureCoordinator({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/p/123456789'),
      sendMessage: vi.fn(
        async () =>
          ({
            ok: true,
            data: { task: DEMO_PENDING_TAB_TASK },
          }) as MessageResponse<never>,
      ),
    });

    const evalRes = await coordinator.evaluateCurrentUrl();
    expect(evalRes).toEqual({ checked: true, matched: false });

    const handler = createContentMessageHandler(
      {
        extensionId: TEST_EXT_ID,
        getCurrentUrl: () => new URL('https://zhuanlan.zhihu.com/write'),
      },
      coordinator,
    );
    const injectRes = await invokeHandler(handler, {
      type: 'INJECT_DRAFT',
      payload: { task: DEMO_TASK },
    });
    expect(injectRes.handled).toBe(true);
    expect(injectRes.response).toMatchObject({
      ok: true,
      data: { ok: false, stage: 'EDITOR_NOT_FOUND' },
    });
    const message = (injectRes.response as { data: { message: string } }).data.message;
    expect(message).not.toContain('gmext_demo_secret_token_42');
    expect(message).toContain('gmext_[REDACTED]');
  });

  it('preserves the capture bar on the same canonical article URL while CONFIRM_PUBLISHED_URL is in-flight and still unmounts on navigate-away (C2-03)', async () => {
    let currentHref = 'https://zhuanlan.zhihu.com/p/123456789';
    let hasPendingTask = true;
    let resolveConfirm!: (value: MessageResponse<never>) => void;

    const sendMessage = vi.fn(async (req: { type: string }) => {
      if (req.type === 'GET_PENDING_TAB_TASK') {
        return {
          ok: true as const,
          data: { task: hasPendingTask ? DEMO_PENDING_TAB_TASK : null },
        } as MessageResponse<never>;
      }
      if (req.type === 'CONFIRM_PUBLISHED_URL') {
        // Simulate SW deleting PendingTabTask before runtime response arrives back in content script
        hasPendingTask = false;
        return new Promise<MessageResponse<never>>((resolve) => {
          resolveConfirm = resolve;
        });
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    const coordinator = createUrlCaptureCoordinator({
      extensionId: TEST_EXT_ID,
      getCurrentUrl: () => new URL(currentHref),
      sendMessage,
    });

    await act(async () => {
      await coordinator.evaluateCurrentUrl();
    });
    const host = getActiveCaptureBarHost();
    expect(host).not.toBeNull();
    const confirmBtn = host?.shadowRoot?.querySelector(
      'button.gm-btn-primary',
    ) as HTMLButtonElement | null;
    expect(confirmBtn).not.toBeNull();

    // Start CONFIRM_PUBLISHED_URL (in-flight; SW has already cleared PendingTabTask)
    act(() => {
      confirmBtn?.click();
    });

    // Trigger concurrent evaluateCurrentUrl on same canonical URL (e.g., hashchange)
    currentHref = 'https://zhuanlan.zhihu.com/p/123456789#comments';
    let midFlightRes!: Awaited<ReturnType<typeof coordinator.evaluateCurrentUrl>>;
    await act(async () => {
      midFlightRes = await coordinator.evaluateCurrentUrl();
    });
    expect(midFlightRes).toEqual({
      checked: true,
      matched: true,
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });
    expect(getActiveCaptureBarHost()).not.toBeNull();

    // Resolve CONFIRM_PUBLISHED_URL -> green confirmed banner renders cleanly
    await act(async () => {
      resolveConfirm({
        ok: true,
        data: {
          taskId: DEMO_PENDING_TAB_TASK.taskId,
          status: 'PUBLISHED',
          publishRecordId: 'pub_demo_inflight',
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
          crawlProbeQueued: true,
          retestMilestones: [7, 14, 30],
        },
      } as unknown as MessageResponse<never>);
      await Promise.resolve();
    });
    expect(getActiveCaptureBarHost()?.shadowRoot?.textContent).toContain('T+1');

    // Navigating away to a different article still unmounts cleanly
    currentHref = 'https://zhuanlan.zhihu.com/p/99999999';
    let navAwayRes!: Awaited<ReturnType<typeof coordinator.evaluateCurrentUrl>>;
    await act(async () => {
      navAwayRes = await coordinator.evaluateCurrentUrl();
    });
    expect(navAwayRes).toEqual({ checked: true, matched: false });
    expect(getActiveCaptureBarHost()).toBeNull();
  });
});
