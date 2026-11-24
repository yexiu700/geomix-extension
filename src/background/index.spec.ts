import { describe, expect, it, vi } from 'vitest';
import type {
  DraftInjectReport,
  ExtensionConfirmPublishedResult,
  ExtensionMeDto,
  ExtensionPendingTaskDto,
} from '../shared/bridge-contract';
import {
  createPendingTabTaskFromDto,
  getPairing,
  getPendingTabTask,
  setPendingTabTask,
} from '../shared/storage';
import {
  createBackgroundMessageHandler,
  createTabRemovedHandler,
  createTabUpdatedHandler,
} from './index';

const DEMO_BASE_URL = 'https://geo.example.com';
const DEMO_TOKEN = 'gmext_demo_token_0001';
const TEST_EXT_ID = 'geomix-test-extension-id';

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
  variantTitle: '示例知乎专栏文章标题',
  variantMarkdown: '# 标题\n\n正文',
  variantHtml: '<h1>标题</h1><p>正文</p>',
  targetUrlHint: null,
  mediaAssets: [],
  complianceChecklist: ['请人工核对合规用语'],
  updatedAt: '2026-06-01T10:00:00.000Z',
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('background message router & MV3 tab lifecycle', () => {
  it('handles PAIR_ACCOUNT, GET_PAIRING_STATUS, FETCH_PENDING_TASKS, live PUSH_DRAFT_TASK, and UNBIND_ACCOUNT (clearing both local & session storage)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: [DEMO_TASK] }));

    const liveReport: DraftInjectReport = {
      ok: true,
      stage: 'INJECTED',
      draftUrl: 'https://zhuanlan.zhihu.com/p/777/edit',
      uploadedImages: 1,
      failedImages: 0,
      message: '已写入知乎专栏草稿箱',
    };

    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_tabId, req: unknown) => {
      const msg = req as { type?: string };
      if (msg.type === 'PING_CONTENT') {
        return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
      }
      if (msg.type === 'INJECT_DRAFT') {
        return { ok: true, data: liveReport };
      }
      return { ok: false };
    });

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      getExtensionVersion: () => '0.1.0',
      extensionId: TEST_EXT_ID,
    });

    const popupSender = {
      id: TEST_EXT_ID,
      url: `chrome-extension://${TEST_EXT_ID}/src/popup/index.html`,
    } as chrome.runtime.MessageSender;

    const initialStatus = await handle({ type: 'GET_PAIRING_STATUS' }, popupSender);
    expect(initialStatus).toEqual({ ok: true, data: { paired: false } });

    const pairResult = await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );
    expect(pairResult.ok).toBe(true);
    expect(JSON.stringify(pairResult)).not.toContain(DEMO_TOKEN);

    const stored = await getPairing();
    expect(stored?.token).toBe(DEMO_TOKEN);

    const pairedStatus = await handle({ type: 'GET_PAIRING_STATUS' }, popupSender);
    expect(pairedStatus.ok).toBe(true);
    expect(JSON.stringify(pairedStatus)).not.toContain(DEMO_TOKEN);

    const tasksRes = await handle(
      { type: 'FETCH_PENDING_TASKS', payload: { brandId: 'brand_demo_1' } },
      popupSender,
    );
    expect(tasksRes).toEqual({ ok: true, data: { tasks: [DEMO_TASK] } });

    const pushRes = await handle(
      { type: 'PUSH_DRAFT_TASK', payload: { task: DEMO_TASK } },
      popupSender,
    );
    expect(pushRes.ok).toBe(true);
    if (pushRes.ok) {
      expect(pushRes.data).toMatchObject({
        taskId: 'task_demo_1',
        accepted: true,
        stage: 'INJECTED',
        tabId: 101,
        draftUrl: 'https://zhuanlan.zhihu.com/p/777/edit',
        report: liveReport,
      });
    }
    expect(await getPendingTabTask(101)).not.toBeNull();

    const unbindRes = await handle({ type: 'UNBIND_ACCOUNT' }, popupSender);
    expect(unbindRes).toEqual({ ok: true, data: { unbound: true } });
    expect(await getPairing()).toBeNull();
    expect(await getPendingTabTask(101)).toBeNull();
  });

  it('enforces fail-closed sender authorization matrix for both Popup-only and Content-only actions', async () => {
    const handle = createBackgroundMessageHandler({
      extensionId: TEST_EXT_ID,
    });

    // Popup-only rejected from content script tab
    const contentSender = {
      id: TEST_EXT_ID,
      tab: { id: 42, url: 'https://zhuanlan.zhihu.com/write' },
      url: 'https://zhuanlan.zhihu.com/write',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    const fromContent = await handle({ type: 'GET_PAIRING_STATUS' }, contentSender);
    expect(fromContent).toEqual({
      ok: false,
      error: {
        kind: 'FORBIDDEN',
        message: '该操作仅限扩展控制台页面调用',
        reauthRequired: false,
      },
    });

    // Popup-only rejected from foreign or missing extension id
    const foreignSender = { id: 'foreign-extension-id' } as chrome.runtime.MessageSender;
    expect(await handle({ type: 'GET_PAIRING_STATUS' }, foreignSender)).toMatchObject({
      ok: false,
      error: { kind: 'FORBIDDEN', message: '拒绝外部扩展来源的消息' },
    });
    expect(await handle({ type: 'GET_PAIRING_STATUS' }, {})).toMatchObject({
      ok: false,
      error: { kind: 'FORBIDDEN', message: '拒绝外部扩展来源的消息' },
    });
    expect(
      await handle({ type: 'UNBIND_ACCOUNT' }, {
        origin: 'https://evil.example.com',
        url: 'https://evil.example.com/attack.html',
      } as chrome.runtime.MessageSender),
    ).toMatchObject({
      ok: false,
      error: { kind: 'FORBIDDEN', message: '拒绝外部扩展来源的消息' },
    });

    // Content-only actions rejected from popup (no sender.tab), disallowed origin, subframe, or mismatched sender.url
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;
    for (const msg of [
      { type: 'GET_PENDING_TAB_TASK' },
      {
        type: 'FETCH_MEDIA_ASSET',
        payload: { url: 'https://cdn.example.com/a.png', alt: 'a' },
      },
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: 'task_demo_1',
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456',
        },
      },
    ]) {
      expect(await handle(msg, popupSender)).toMatchObject({
        ok: false,
        error: { kind: 'FORBIDDEN' },
      });

      // Disallowed origin
      expect(
        await handle(msg, {
          id: TEST_EXT_ID,
          tab: { id: 50, url: 'https://evil.example.com/page' },
          url: 'https://evil.example.com/page',
          frameId: 0,
        } as chrome.runtime.MessageSender),
      ).toMatchObject({
        ok: false,
        error: { kind: 'FORBIDDEN' },
      });

      // Subframe (frameId !== 0) rejected even on allowed origin
      expect(
        await handle(msg, {
          id: TEST_EXT_ID,
          tab: { id: 50, url: 'https://www.zhihu.com/question/123' },
          url: 'https://www.zhihu.com/question/123',
          frameId: 1,
        } as chrome.runtime.MessageSender),
      ).toMatchObject({
        ok: false,
        error: { kind: 'FORBIDDEN' },
      });

      // Malicious sender.url must NOT fall back to sender.tab.url
      expect(
        await handle(msg, {
          id: TEST_EXT_ID,
          tab: { id: 50, url: 'https://www.zhihu.com/question/123' },
          url: 'https://evil.example.com/iframe',
          frameId: 0,
        } as chrome.runtime.MessageSender),
      ).toMatchObject({
        ok: false,
        error: { kind: 'FORBIDDEN' },
      });

      // Non-default port & HTTP rejected
      expect(
        await handle(msg, {
          id: TEST_EXT_ID,
          tab: { id: 50, url: 'https://www.zhihu.com:8443/question/123' },
          frameId: 0,
        } as chrome.runtime.MessageSender),
      ).toMatchObject({
        ok: false,
        error: { kind: 'FORBIDDEN' },
      });
    }

    // Unknown message rejected
    expect(await handle({ type: 'UNKNOWN_MESSAGE' }, popupSender)).toMatchObject({
      ok: false,
      error: { kind: 'INVALID_REQUEST' },
    });
  });

  it('caps concurrent FETCH_MEDIA_ASSET messages at <= 2 through shared handler-scoped mediaFetcher', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      const res = new Response(PNG_BYTES.slice().buffer, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
      Object.defineProperty(res, 'url', { value: String(input), configurable: true });
      return res;
    });

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });

    const zhihuSender = {
      id: TEST_EXT_ID,
      tab: { id: 60, url: 'https://zhuanlan.zhihu.com/write' },
      url: 'https://zhuanlan.zhihu.com/write',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((idx) =>
        handle(
          {
            type: 'FETCH_MEDIA_ASSET',
            payload: { url: `https://cdn.example.com/img-${idx}.png`, alt: `图 ${idx}` },
          },
          zhihuSender,
        ),
      ),
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(
      responses.every((res) => res.ok && 'data' in res && (res.data as { ok: boolean }).ok),
    ).toBe(true);
  });

  it('survives MV3 SW restart via chrome.storage.session: tabs.onUpdated -> GET_PENDING_TAB_TASK -> CONFIRM_PUBLISHED_URL -> cleanup', async () => {
    const confirmResult: ExtensionConfirmPublishedResult = {
      taskId: DEMO_TASK.taskId,
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_999',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: confirmResult }));

    // Instance A pairs account & binds tab 88 in chrome.storage.session
    const handleA = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;
    await handleA(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );
    await setPendingTabTask(createPendingTabTaskFromDto(88, DEMO_TASK));

    // Simulate SW hibernation/restart: fresh handler Instance B + fresh onUpdated handler
    const handleB = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const onUpdated = createTabUpdatedHandler();

    // Same-provider draft/edit URL sends TAB_URL_CHANGED WITHOUT payload.url so content script can re-evaluate & unmount stale capture bars (G6)
    await onUpdated(88, { url: 'https://zhuanlan.zhihu.com/p/123456789/edit' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(88, {
      type: 'TAB_URL_CHANGED',
      payload: {
        taskId: DEMO_TASK.taskId,
        provider: 'ZHIHU_EXT',
      },
    });
    expect(
      (
        vi.mocked(chrome.tabs.sendMessage).mock.calls[0]?.[1] as {
          payload?: Record<string, unknown>;
        }
      )?.payload,
    ).not.toHaveProperty('url');

    vi.mocked(chrome.tabs.sendMessage).mockClear();

    // Same-provider published sub-view (/comments) also notifies content script without payload.url so adapter can inspect canonical metadata
    await onUpdated(88, { url: 'https://zhuanlan.zhihu.com/p/123456789/comments' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(88, {
      type: 'TAB_URL_CHANGED',
      payload: {
        taskId: DEMO_TASK.taskId,
        provider: 'ZHIHU_EXT',
      },
    });

    vi.mocked(chrome.tabs.sendMessage).mockClear();

    // Cross-provider & off-platform URLs must NOT trigger TAB_URL_CHANGED
    await onUpdated(88, { url: 'https://post.smzdm.com/p/aB12cD' });
    await onUpdated(88, { url: 'https://evil.example.com/p/123456789' });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();

    // Valid published URL triggers TAB_URL_CHANGED with canonicalized URL
    await onUpdated(88, {
      url: 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#top',
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(88, {
      type: 'TAB_URL_CHANGED',
      payload: {
        url: 'https://zhuanlan.zhihu.com/p/123456789',
        taskId: DEMO_TASK.taskId,
        provider: 'ZHIHU_EXT',
      },
    });

    const contentSender = {
      id: TEST_EXT_ID,
      tab: { id: 88, url: 'https://zhuanlan.zhihu.com/p/123456789' },
      url: 'https://zhuanlan.zhihu.com/p/123456789',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    // GET_PENDING_TAB_TASK restores binding without leaking gmext_ token
    const pendingRes = await handleB({ type: 'GET_PENDING_TAB_TASK' }, contentSender);
    expect(pendingRes.ok).toBe(true);
    expect(JSON.stringify(pendingRes)).not.toContain(DEMO_TOKEN);
    if (pendingRes.ok) {
      expect(pendingRes.data).toMatchObject({
        task: { tabId: 88, taskId: DEMO_TASK.taskId, provider: 'ZHIHU_EXT' },
      });
    }

    // Mismatched taskId rejected
    const wrongTaskRes = await handleB(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: 'wrong_task_id',
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        },
      },
      contentSender,
    );
    expect(wrongTaskRes).toMatchObject({ ok: false, error: { kind: 'FORBIDDEN' } });

    // Edit URL rejected even if manually crafted
    const editUrlRes = await handleB(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/edit',
        },
      },
      contentSender,
    );
    expect(editUrlRes).toMatchObject({ ok: false, error: { kind: 'INVALID_INPUT' } });

    // Valid confirm-published succeeds with Idempotency-Key and clears tab binding
    const confirmRes = await handleB(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo',
        },
      },
      contentSender,
    );
    expect(confirmRes).toEqual({ ok: true, data: confirmResult });
    expect(JSON.stringify(confirmRes)).not.toContain(DEMO_TOKEN);
    expect(await getPendingTabTask(88)).toBeNull();

    // Verify Idempotency-Key header was sent to confirm-published
    const confirmFetchCall = fetchMock.mock.calls[1];
    expect(String(confirmFetchCall?.[0])).toBe(
      `${DEMO_BASE_URL}/api/v2/extension/tasks/${DEMO_TASK.taskId}/confirm-published`,
    );
    const confirmHeaders = confirmFetchCall?.[1]?.headers as Record<string, string>;
    expect(confirmHeaders['Idempotency-Key']).toMatch(/^gmext-confirm-/);
    expect(confirmHeaders.Authorization).toBe(`Bearer ${DEMO_TOKEN}`);
  });

  it('preserves session binding on CONFIRM_PUBLISHED_URL 401 failure (reauthRequired) and cleans up on tabs.onRemoved', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 40100, msg: 'revoked', data: null }, 401));

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;

    await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );
    await setPendingTabTask(createPendingTabTaskFromDto(99, DEMO_TASK));

    const contentSender = {
      id: TEST_EXT_ID,
      tab: { id: 99, url: 'https://zhuanlan.zhihu.com/p/123456789' },
      url: 'https://zhuanlan.zhihu.com/p/123456789',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    const failedConfirm = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        },
      },
      contentSender,
    );
    expect(failedConfirm).toMatchObject({
      ok: false,
      error: { kind: 'UNAUTHORIZED', httpStatus: 401, reauthRequired: true },
    });
    expect(JSON.stringify(failedConfirm)).not.toContain(DEMO_TOKEN);

    // Binding preserved so operator can re-pair and retry
    expect(await getPendingTabTask(99)).not.toBeNull();

    // Closing the tab cleans up the session binding
    const onRemoved = createTabRemovedHandler();
    await onRemoved(99);
    expect(await getPendingTabTask(99)).toBeNull();
  });

  it('returns NOT_PAIRED when fetching tasks before pairing and reauthRequired on 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 40100, msg: 'revoked', data: null }, 401));

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;

    const notPaired = await handle({ type: 'FETCH_PENDING_TASKS' }, popupSender);
    expect(notPaired).toMatchObject({
      ok: false,
      error: { kind: 'NOT_PAIRED', reauthRequired: true },
    });

    await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );

    const revoked = await handle({ type: 'FETCH_PENDING_TASKS' }, popupSender);
    expect(revoked).toMatchObject({
      ok: false,
      error: { kind: 'UNAUTHORIZED', httpStatus: 401, reauthRequired: true },
    });
  });

  it('preserves PendingTabTask on 401 re-pair UNBIND_ACCOUNT (preservePendingTabTasks: true), allows rotated-token confirm, and still wipes everything on explicit UNBIND_ACCOUNT', async () => {
    const rotatedToken = 'gmext_demo_token_rotated_0002';
    const confirmResult: ExtensionConfirmPublishedResult = {
      taskId: DEMO_TASK.taskId,
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_reauth_1',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/889900',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 40100, msg: 'revoked', data: null }, 401))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: confirmResult }));

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;
    const contentSender = {
      id: TEST_EXT_ID,
      tab: { id: 120, url: 'https://zhuanlan.zhihu.com/p/889900' },
      url: 'https://zhuanlan.zhihu.com/p/889900',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    // 1. Initial pair + active tab binding
    await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );
    await setPendingTabTask(createPendingTabTaskFromDto(120, DEMO_TASK));

    // 2. Confirm hits 401 -> binding preserved
    const firstConfirm = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: { taskId: DEMO_TASK.taskId, publishedUrl: 'https://zhuanlan.zhihu.com/p/889900' },
      },
      contentSender,
    );
    expect(firstConfirm).toMatchObject({
      ok: false,
      error: { kind: 'UNAUTHORIZED', httpStatus: 401, reauthRequired: true },
    });
    expect(await getPendingTabTask(120)).not.toBeNull();

    // 3. Popup 401 re-pair clears local token immediately while preserving session PendingTabTask
    const reauthUnbind = await handle(
      { type: 'UNBIND_ACCOUNT', preservePendingTabTasks: true },
      popupSender,
    );
    expect(reauthUnbind).toEqual({ ok: true, data: { unbound: true } });
    expect(await getPairing()).toBeNull();
    expect(await getPendingTabTask(120)).toMatchObject({
      tabId: 120,
      taskId: DEMO_TASK.taskId,
      brandId: DEMO_TASK.brandId,
    });

    // 4. Re-pair with rotated token for the same brand -> preserves binding and confirms successfully
    const rePair = await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: rotatedToken } },
      popupSender,
    );
    expect(rePair.ok).toBe(true);
    expect(await getPendingTabTask(120)).not.toBeNull();

    const retryConfirm = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: { taskId: DEMO_TASK.taskId, publishedUrl: 'https://zhuanlan.zhihu.com/p/889900' },
      },
      contentSender,
    );
    expect(retryConfirm).toEqual({ ok: true, data: confirmResult });
    expect(await getPendingTabTask(120)).toBeNull();

    const retryHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe(`Bearer ${rotatedToken}`);

    // 5. Explicit logout (default / preservePendingTabTasks: false) wipes BOTH local & session storage
    await setPendingTabTask(createPendingTabTaskFromDto(121, DEMO_TASK));
    const explicitUnbind = await handle(
      { type: 'UNBIND_ACCOUNT', preservePendingTabTasks: false },
      popupSender,
    );
    expect(explicitUnbind).toEqual({ ok: true, data: { unbound: true } });
    expect(await getPairing()).toBeNull();
    expect(await getPendingTabTask(121)).toBeNull();
  });

  it('prunes stale cross-account PendingTabTasks on PAIR_ACCOUNT when newly paired me.brands differs or is empty', async () => {
    const accountBMe: ExtensionMeDto = {
      nickname: 'OtherOperator',
      tokenLabel: '其他账号设备',
      tokenPrefix: 'gmext_demo',
      expiresAt: '2026-12-31T23:59:59.000Z',
      brands: [
        {
          brandId: 'brand_other_9',
          brandName: 'OtherBrand',
          brandMarketId: 'bm_cn_9',
          localBrandName: '其他品牌',
        },
      ],
    };
    const emptyBrandsMe: ExtensionMeDto = {
      ...accountBMe,
      brands: [],
    };

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: accountBMe }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: emptyBrandsMe }));

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;

    // Seed two tabs: one for brand_demo_1 (account A), one for brand_other_9 (account B)
    await setPendingTabTask(createPendingTabTaskFromDto(201, DEMO_TASK));
    await setPendingTabTask(
      createPendingTabTaskFromDto(202, {
        ...DEMO_TASK,
        taskId: 'task_other_9',
        brandId: 'brand_other_9',
        brandName: '其他品牌',
      }),
    );

    // Pairing account B prunes tab 201 (unauthorized brand) while keeping tab 202 (authorized brand)
    const pairB = await handle(
      {
        type: 'PAIR_ACCOUNT',
        payload: { baseUrl: DEMO_BASE_URL, token: 'gmext_demo_other_account_1' },
      },
      popupSender,
    );
    expect(pairB.ok).toBe(true);
    expect(await getPendingTabTask(201)).toBeNull();
    expect(await getPendingTabTask(202)).toMatchObject({
      tabId: 202,
      taskId: 'task_other_9',
      brandId: 'brand_other_9',
    });

    // Pairing an account with empty me.brands prunes ALL remaining pending tab tasks
    const pairEmpty = await handle(
      {
        type: 'PAIR_ACCOUNT',
        payload: { baseUrl: DEMO_BASE_URL, token: 'gmext_demo_empty_brands_2' },
      },
      popupSender,
    );
    expect(pairEmpty.ok).toBe(true);
    expect(await getPendingTabTask(202)).toBeNull();
  });

  it('suppresses phantom capture/confirm for failed un-injected PendingTabTasks (AUTH_REQUIRED / EDITOR_NOT_FOUND) while allowing PARTIAL_MEDIA_FAILED and subsequent successful retry', async () => {
    const confirmResult: ExtensionConfirmPublishedResult = {
      taskId: DEMO_TASK.taskId,
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_after_retry',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: confirmResult }));

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      extensionId: TEST_EXT_ID,
    });
    const onUpdated = createTabUpdatedHandler();
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;

    await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );

    // 1. Failed un-injected AUTH_REQUIRED record (lastInjectReport.ok === false, injectedAt === undefined)
    await setPendingTabTask({
      ...createPendingTabTaskFromDto(150, DEMO_TASK),
      lastInjectReport: {
        ok: false,
        stage: 'AUTH_REQUIRED',
        uploadedImages: 0,
        failedImages: 0,
        message: '未登录知乎',
      },
    });

    const contentSender150 = {
      id: TEST_EXT_ID,
      tab: { id: 150, url: 'https://zhuanlan.zhihu.com/p/99887766' },
      url: 'https://zhuanlan.zhihu.com/p/99887766',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    await onUpdated(150, { url: 'https://zhuanlan.zhihu.com/p/99887766' });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();

    const getTaskFailed = await handle({ type: 'GET_PENDING_TAB_TASK' }, contentSender150);
    expect(getTaskFailed).toEqual({ ok: true, data: { task: null } });

    const confirmFailed = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766',
        },
      },
      contentSender150,
    );
    expect(confirmFailed).toMatchObject({ ok: false, error: { kind: 'NOT_FOUND' } });

    // 2. PARTIAL_MEDIA_FAILED has lastInjectReport.ok === false BUT injectedAt is set -> MUST still capture
    await setPendingTabTask({
      ...createPendingTabTaskFromDto(151, DEMO_TASK),
      injectedAt: '2026-06-01T12:00:00.000Z',
      lastInjectReport: {
        ok: false,
        stage: 'PARTIAL_MEDIA_FAILED',
        uploadedImages: 1,
        failedImages: 1,
        message: '部分配图失败',
      },
    });
    const contentSender151 = {
      id: TEST_EXT_ID,
      tab: { id: 151, url: 'https://zhuanlan.zhihu.com/p/554433' },
      url: 'https://zhuanlan.zhihu.com/p/554433',
      frameId: 0,
    } as chrome.runtime.MessageSender;
    const partialGet = await handle({ type: 'GET_PENDING_TAB_TASK' }, contentSender151);
    expect(partialGet).toMatchObject({
      ok: true,
      data: { task: { tabId: 151, taskId: DEMO_TASK.taskId } },
    });

    // 3. Subsequent successful retry on Tab 150 (INJECTED + injectedAt set) restores capture & confirm
    await setPendingTabTask({
      ...createPendingTabTaskFromDto(150, DEMO_TASK),
      injectedAt: '2026-06-01T12:05:00.000Z',
      lastInjectReport: {
        ok: true,
        stage: 'INJECTED',
        uploadedImages: 0,
        failedImages: 0,
        message: '已写入草稿箱',
      },
    });

    await onUpdated(150, { url: 'https://zhuanlan.zhihu.com/p/99887766' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(150, {
      type: 'TAB_URL_CHANGED',
      payload: {
        url: 'https://zhuanlan.zhihu.com/p/99887766',
        taskId: DEMO_TASK.taskId,
        provider: 'ZHIHU_EXT',
      },
    });

    const getTaskRetry = await handle({ type: 'GET_PENDING_TAB_TASK' }, contentSender150);
    expect(getTaskRetry).toMatchObject({
      ok: true,
      data: { task: { tabId: 150, taskId: DEMO_TASK.taskId } },
    });

    const confirmRetry = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/99887766',
        },
      },
      contentSender150,
    );
    expect(confirmRetry).toEqual({ ok: true, data: confirmResult });
  });

  it('returns NOT_PAIRED with reauthRequired=true on unpaired CONFIRM_PUBLISHED_URL with or without PendingTabTask (G5)', async () => {
    const handle = createBackgroundMessageHandler({
      extensionId: TEST_EXT_ID,
    });
    const contentSender = {
      id: TEST_EXT_ID,
      tab: { id: 160, url: 'https://zhuanlan.zhihu.com/p/123456789' },
      url: 'https://zhuanlan.zhihu.com/p/123456789',
      frameId: 0,
    } as chrome.runtime.MessageSender;

    // 1. Unpaired & no PendingTabTask
    const resNoTask = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: DEMO_TASK.taskId,
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        },
      },
      contentSender,
    );
    expect(resNoTask).toMatchObject({
      ok: false,
      error: { kind: 'NOT_PAIRED', reauthRequired: true },
    });

    // 2. Unpaired & PendingTabTask exists (even with mismatched taskId)
    await setPendingTabTask(createPendingTabTaskFromDto(160, DEMO_TASK));
    const resWithTask = await handle(
      {
        type: 'CONFIRM_PUBLISHED_URL',
        payload: {
          taskId: 'different_task_id',
          publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        },
      },
      contentSender,
    );
    expect(resWithTask).toMatchObject({
      ok: false,
      error: { kind: 'NOT_PAIRED', reauthRequired: true },
    });
  });

  it('forwards same-provider Toutiao /group/ alias without payload.url while keeping cross-provider origins silent (G6)', async () => {
    const toutiaoTask: ExtensionPendingTaskDto = {
      ...DEMO_TASK,
      taskId: 'task_toutiao_alias_1',
      provider: 'TOUTIAO_EXT',
      channelLabel: '今日头条',
    };
    await setPendingTabTask(createPendingTabTaskFromDto(170, toutiaoTask));

    const onUpdated = createTabUpdatedHandler();
    await onUpdated(170, { url: 'https://www.toutiao.com/group/7123456789012345678/' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(170, {
      type: 'TAB_URL_CHANGED',
      payload: {
        taskId: toutiaoTask.taskId,
        provider: 'TOUTIAO_EXT',
      },
    });

    vi.mocked(chrome.tabs.sendMessage).mockClear();
    await onUpdated(170, { url: 'https://zhuanlan.zhihu.com/p/123456789' });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('aborts PUSH_DRAFT_TASK without persisting PendingTabTask or sending INJECT_DRAFT if UNBIND_ACCOUNT runs concurrently (G7)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: DEMO_ME }));

    let resolvePing!: (value: unknown) => void;
    let markPingStarted!: () => void;
    const pingStarted = new Promise<void>((resolve) => {
      markPingStarted = resolve;
    });

    const sentTypes: string[] = [];
    const tabsApi = {
      query: vi.fn(async () => [
        {
          id: 180,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
      ]),
      create: vi.fn(),
      update: vi.fn(async () => ({
        id: 180,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      get: vi.fn(async () => ({
        id: 180,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      sendMessage: vi.fn(async (_tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        sentTypes.push(msg.type ?? 'unknown');
        if (msg.type === 'PING_CONTENT') {
          markPingStarted();
          return new Promise<unknown>((res) => {
            resolvePing = res;
          });
        }
        throw new Error('INJECT_DRAFT must not be called after UNBIND_ACCOUNT');
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as NonNullable<Parameters<typeof createBackgroundMessageHandler>[0]>['tabsApi'];

    const handle = createBackgroundMessageHandler({
      fetchImpl: fetchMock,
      tabsApi,
      extensionId: TEST_EXT_ID,
    });
    const popupSender = { id: TEST_EXT_ID } as chrome.runtime.MessageSender;

    await handle(
      { type: 'PAIR_ACCOUNT', payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN } },
      popupSender,
    );

    const pushPromise = handle(
      { type: 'PUSH_DRAFT_TASK', payload: { task: DEMO_TASK } },
      popupSender,
    );

    await pingStarted;

    // Concurrent explicit unbind while PUSH_DRAFT_TASK is waiting on PING_CONTENT
    const unbindRes = await handle({ type: 'UNBIND_ACCOUNT' }, popupSender);
    expect(unbindRes).toEqual({ ok: true, data: { unbound: true } });

    resolvePing({ ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } });

    const pushRes = await pushPromise;
    expect(pushRes).toMatchObject({
      ok: true,
      data: {
        taskId: DEMO_TASK.taskId,
        accepted: false,
        stage: 'EDITOR_NOT_FOUND',
      },
    });
    expect(await getPendingTabTask(180)).toBeNull();
    expect(sentTypes).toEqual(['PING_CONTENT']);
  });
});
