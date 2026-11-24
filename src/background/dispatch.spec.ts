import { describe, expect, it, vi } from 'vitest';
import type { DraftInjectReport, ExtensionPendingTaskDto } from '../shared/bridge-contract';
import {
  createPendingTabTaskFromDto,
  getPendingTabTask,
  setPendingTabTask,
} from '../shared/storage';
import { dispatchDraftTask, resolveTaskEditorEntryUrl } from './dispatch';

function asMockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

const DEMO_ZHIHU_TASK: ExtensionPendingTaskDto = {
  taskId: 'task_zhihu_101',
  articleId: 'art_101',
  brandId: 'brand_demo_1',
  brandName: '示例品牌甲',
  provider: 'ZHIHU_EXT',
  channelLabel: '知乎专栏',
  status: 'READY_TO_PUBLISH',
  variantTitle: '示例知乎文章',
  variantMarkdown: '# 标题\n正文',
  variantHtml: '<h1>标题</h1><p>正文</p>',
  targetUrlHint: null,
  mediaAssets: [],
  complianceChecklist: ['人工核对合规项'],
  updatedAt: '2026-06-01T10:00:00.000Z',
};

describe('background/dispatch', () => {
  it('resolves editor entry URL using Zhihu question hint when valid, else adapter override or default', () => {
    expect(
      resolveTaskEditorEntryUrl({
        ...DEMO_ZHIHU_TASK,
        targetUrlHint: 'https://www.zhihu.com/question/987654321/?sort=created#top',
      }),
    ).toBe('https://www.zhihu.com/question/987654321');

    expect(
      resolveTaskEditorEntryUrl({
        ...DEMO_ZHIHU_TASK,
        targetUrlHint: 'https://evil.example.com/question/987654321',
      }),
    ).toBe('https://zhuanlan.zhihu.com/write');

    expect(
      resolveTaskEditorEntryUrl({
        ...DEMO_ZHIHU_TASK,
        provider: 'TOUTIAO_EXT',
        targetUrlHint: 'https://www.zhihu.com/question/987654321',
      }),
    ).toBe('https://mp.toutiao.com/profile_v4/graphic/publish');

    expect(
      resolveTaskEditorEntryUrl({ ...DEMO_ZHIHU_TASK, provider: 'SMZDM_EXT' }, () => ({
        editorEntryUrl: 'https://post.smzdm.com/tougao/new',
      })),
    ).toBe('https://post.smzdm.com/tougao/new');

    // Untrusted adapter entry URL falls back safely
    expect(
      resolveTaskEditorEntryUrl({ ...DEMO_ZHIHU_TASK, provider: 'SMZDM_EXT' }, () => ({
        editorEntryUrl: 'https://evil.example.com/tougao/',
      })),
    ).toBe('https://post.smzdm.com/tougao/');
  });

  it('reuses eligible unbound editor tab without hijacking reading tabs or tabs bound to other tasks', async () => {
    await setPendingTabTask(
      createPendingTabTaskFromDto(201, { ...DEMO_ZHIHU_TASK, taskId: 'other_task_999' }),
    );

    asMockFn(chrome.tabs.query).mockResolvedValueOnce([
      { id: 201, url: 'https://zhuanlan.zhihu.com/write', active: true } as chrome.tabs.Tab,
      { id: 202, url: 'https://zhuanlan.zhihu.com/p/123456', active: false } as chrome.tabs.Tab,
      {
        id: 203,
        url: 'https://zhuanlan.zhihu.com/write?draftId=5',
        active: false,
      } as chrome.tabs.Tab,
    ]);

    const injectedReport: DraftInjectReport = {
      ok: true,
      stage: 'INJECTED',
      draftUrl: 'https://zhuanlan.zhihu.com/p/555/edit',
      uploadedImages: 1,
      failedImages: 0,
      message: '已写入知乎草稿箱',
    };

    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_tabId, req: unknown) => {
      const msg = req as { type?: string };
      if (msg.type === 'PING_CONTENT') {
        return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
      }
      if (msg.type === 'INJECT_DRAFT') {
        return { ok: true, data: injectedReport };
      }
      return { ok: false };
    });

    const result = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      now: () => new Date('2026-06-01T12:00:00.000Z'),
    });

    expect(chrome.tabs.update).toHaveBeenCalledWith(203, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      taskId: 'task_zhihu_101',
      accepted: true,
      stage: 'INJECTED',
      tabId: 203,
      draftUrl: 'https://zhuanlan.zhihu.com/p/555/edit',
      report: injectedReport,
    });
    expect(result.stub).toBeUndefined();

    const stored = await getPendingTabTask(203);
    expect(stored?.taskId).toBe('task_zhihu_101');
    expect(stored?.injectedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(stored?.lastInjectReport).toEqual(injectedReport);
  });

  it('persists PendingTabTask in chrome.storage.session BEFORE sending INJECT_DRAFT and waits for tab load + PING_CONTENT', async () => {
    asMockFn(chrome.tabs.query).mockResolvedValueOnce([]);
    asMockFn(chrome.tabs.create).mockResolvedValueOnce({
      id: 305,
      url: 'https://zhuanlan.zhihu.com/write',
      status: 'loading',
      active: true,
    } as chrome.tabs.Tab);
    asMockFn(chrome.tabs.get).mockResolvedValueOnce({
      id: 305,
      status: 'loading',
    } as chrome.tabs.Tab);

    let pingAttempts = 0;
    let sessionRecordAtInjectTime: unknown = null;

    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (tabId, req: unknown) => {
      const msg = req as { type?: string };
      if (msg.type === 'PING_CONTENT') {
        pingAttempts += 1;
        if (pingAttempts < 2) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
      }
      if (msg.type === 'INJECT_DRAFT') {
        // Verify session storage ALREADY contains the binding when INJECT_DRAFT arrives!
        sessionRecordAtInjectTime = await getPendingTabTask(tabId);
        return {
          ok: true,
          data: {
            ok: true,
            stage: 'INJECTED',
            uploadedImages: 0,
            failedImages: 0,
            message: '已写入草稿箱',
          },
        };
      }
      return { ok: false };
    });

    const dispatchPromise = dispatchDraftTask(DEMO_ZHIHU_TASK, {
      pingRetryIntervalMs: 10,
      pingTimeoutMs: 500,
      tabLoadTimeoutMs: 500,
    });

    // Trigger tabs.onUpdated status=complete asynchronously
    await new Promise((resolve) => setTimeout(resolve, 15));
    const onUpdatedListeners = (
      chrome.tabs.onUpdated as unknown as { listeners: Set<(...args: unknown[]) => void> }
    ).listeners;
    for (const listener of onUpdatedListeners) {
      listener(305, { status: 'complete' }, { id: 305, status: 'complete' });
    }

    const result = await dispatchPromise;
    expect(result.accepted).toBe(true);
    expect(result.tabId).toBe(305);
    expect(pingAttempts).toBe(2);
    expect(sessionRecordAtInjectTime).toMatchObject({
      tabId: 305,
      taskId: 'task_zhihu_101',
      provider: 'ZHIHU_EXT',
    });
  });

  it('uses chrome.scripting.executeScript fallback on reused tab when initial PING_CONTENT fails', async () => {
    asMockFn(chrome.tabs.query).mockResolvedValueOnce([
      { id: 404, url: 'https://zhuanlan.zhihu.com/write', active: true } as chrome.tabs.Tab,
    ]);

    let injectedViaScripting = false;
    vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(async () => {
      injectedViaScripting = true;
      return [];
    });

    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (_tabId, req: unknown) => {
      const msg = req as { type?: string };
      if (msg.type === 'PING_CONTENT') {
        if (!injectedViaScripting) {
          throw new Error('Receiving end does not exist');
        }
        return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
      }
      return {
        ok: true,
        data: {
          ok: true,
          stage: 'INJECTED',
          uploadedImages: 0,
          failedImages: 0,
          message: 'ok',
        },
      };
    });

    const result = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      pingRetryIntervalMs: 10,
      pingTimeoutMs: 500,
    });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 404 },
      files: ['content.js'],
    });
    expect(result.accepted).toBe(true);
    expect(result.tabId).toBe(404);
  });

  it('handles tab closed mid-load and PING_CONTENT timeout cleanly', async () => {
    asMockFn(chrome.tabs.query).mockResolvedValueOnce([]);
    asMockFn(chrome.tabs.create).mockResolvedValueOnce({
      id: 501,
      url: 'https://zhuanlan.zhihu.com/write',
      status: 'loading',
    } as chrome.tabs.Tab);
    asMockFn(chrome.tabs.get).mockResolvedValueOnce({
      id: 501,
      status: 'loading',
    } as chrome.tabs.Tab);

    const closedPromise = dispatchDraftTask(DEMO_ZHIHU_TASK, {
      tabLoadTimeoutMs: 500,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const onRemovedListeners = (
      chrome.tabs.onRemoved as unknown as { listeners: Set<(...args: unknown[]) => void> }
    ).listeners;
    for (const listener of onRemovedListeners) {
      listener(501);
    }

    const closedResult = await closedPromise;
    expect(closedResult).toMatchObject({
      taskId: 'task_zhihu_101',
      accepted: false,
      stage: 'EDITOR_NOT_FOUND',
      tabId: 501,
    });
    expect(closedResult.message).toContain('已关闭');

    // Ping timeout
    asMockFn(chrome.tabs.query).mockResolvedValueOnce([]);
    asMockFn(chrome.tabs.create).mockResolvedValueOnce({
      id: 502,
      url: 'https://zhuanlan.zhihu.com/write',
      status: 'complete',
    } as chrome.tabs.Tab);
    asMockFn(chrome.tabs.get).mockResolvedValueOnce({
      id: 502,
      status: 'complete',
    } as chrome.tabs.Tab);
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error('Receiving end does not exist'));

    const timeoutResult = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      pingRetryIntervalMs: 10,
      pingTimeoutMs: 35,
    });
    expect(timeoutResult).toMatchObject({
      taskId: 'task_zhihu_101',
      accepted: false,
      stage: 'EDITOR_NOT_FOUND',
      tabId: 502,
    });
    expect(timeoutResult.message).toContain('未就绪');
  });

  it('Probe 1C: staggered concurrent same-platform multi-brand dispatch while first tab is still loading allocates strictly distinct tabs with zero session overwrite', async () => {
    const openTabs = new Map<number, chrome.tabs.Tab>();
    let nextTabId = 601;

    const updatedListeners = new Set<
      (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
    >();
    const removedListeners = new Set<(tabId: number) => void>();

    const tabsApi = {
      query: vi.fn(async () => Array.from(openTabs.values()).map((t) => ({ ...t }))),
      create: vi.fn(async (props: chrome.tabs.CreateProperties) => {
        const id = nextTabId++;
        const tab = {
          id,
          url: props.url,
          active: props.active ?? true,
          status: 'loading',
        } as chrome.tabs.Tab;
        openTabs.set(id, tab);

        // Simulate realistic 40ms editor page load delay before status becomes 'complete'
        setTimeout(() => {
          const current = openTabs.get(id);
          if (!current) {
            return;
          }
          current.status = 'complete';
          for (const listener of updatedListeners) {
            listener(id, { status: 'complete' }, { ...current });
          }
        }, 40);

        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
        const tab = openTabs.get(tabId);
        if (!tab) {
          throw new Error(`Tab ${tabId} not found`);
        }
        if (typeof props.active === 'boolean') {
          tab.active = props.active;
        }
        return { ...tab };
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = openTabs.get(tabId);
        if (!tab) {
          throw new Error(`Tab ${tabId} not found`);
        }
        return { ...tab };
      }),
      sendMessage: vi.fn(async (tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          return { ok: true, data: { ready: true, href: openTabs.get(tabId)?.url ?? '' } };
        }
        if (msg.type === 'INJECT_DRAFT') {
          return {
            ok: true,
            data: {
              ok: true,
              stage: 'INJECTED',
              uploadedImages: 0,
              failedImages: 0,
              message: '已写入草稿箱',
            },
          };
        }
        return { ok: false };
      }),
      onUpdated: {
        addListener: (
          fn: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
        ) => updatedListeners.add(fn),
        removeListener: (
          fn: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
        ) => updatedListeners.delete(fn),
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => removedListeners.add(fn),
        removeListener: (fn: (tabId: number) => void) => removedListeners.delete(fn),
      },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const taskBrandA: ExtensionPendingTaskDto = {
      ...DEMO_ZHIHU_TASK,
      taskId: 'task_stagger_a',
      brandId: 'brand_alpha',
      brandName: '示例品牌甲',
      variantTitle: '品牌甲知乎文章',
    };
    const taskBrandB: ExtensionPendingTaskDto = {
      ...DEMO_ZHIHU_TASK,
      taskId: 'task_stagger_b',
      brandId: 'brand_beta',
      brandName: '示例品牌乙',
      variantTitle: '品牌乙知乎文章',
    };

    const promiseA = dispatchDraftTask(taskBrandA, {
      tabsApi,
      tabLoadTimeoutMs: 1000,
      pingTimeoutMs: 500,
      pingRetryIntervalMs: 10,
    });

    // Stagger 5ms while Tab 601 is still loading and not yet written to chrome.storage.session
    await new Promise((resolve) => setTimeout(resolve, 5));

    const promiseB = dispatchDraftTask(taskBrandB, {
      tabsApi,
      tabLoadTimeoutMs: 1000,
      pingTimeoutMs: 500,
      pingRetryIntervalMs: 10,
    });

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA.accepted).toBe(true);
    expect(resultB.accepted).toBe(true);
    expect(resultA.tabId).toBe(601);
    expect(resultB.tabId).toBe(602);
    expect(resultA.tabId).not.toBe(resultB.tabId);

    // Session bindings for both brands remain distinct and intact
    expect(await getPendingTabTask(601)).toMatchObject({
      tabId: 601,
      taskId: 'task_stagger_a',
      brandId: 'brand_alpha',
    });
    expect(await getPendingTabTask(602)).toMatchObject({
      tabId: 602,
      taskId: 'task_stagger_b',
      brandId: 'brand_beta',
    });
  });

  it('Probe 1D: simultaneous Promise.all same-platform multi-brand dispatch with 1 idle editor tab reuses idle tab once and opens a distinct tab for the second brand', async () => {
    const openTabs = new Map<number, chrome.tabs.Tab>([
      [
        701,
        {
          id: 701,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
      ],
    ]);
    let nextTabId = 702;

    const updatedListeners = new Set<
      (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
    >();
    const removedListeners = new Set<(tabId: number) => void>();

    const tabsApi = {
      query: vi.fn(async () => {
        // Yield a microtask/tick to widen the TOCTOU window if unserialized
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Array.from(openTabs.values()).map((t) => ({ ...t }));
      }),
      create: vi.fn(async (props: chrome.tabs.CreateProperties) => {
        const id = nextTabId++;
        const tab = {
          id,
          url: props.url,
          active: props.active ?? true,
          status: 'complete',
        } as chrome.tabs.Tab;
        openTabs.set(id, tab);
        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
        const tab = openTabs.get(tabId);
        if (!tab) {
          throw new Error(`Tab ${tabId} not found`);
        }
        if (typeof props.active === 'boolean') {
          tab.active = props.active;
        }
        return { ...tab };
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = openTabs.get(tabId);
        if (!tab) {
          throw new Error(`Tab ${tabId} not found`);
        }
        return { ...tab };
      }),
      sendMessage: vi.fn(async (tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          return { ok: true, data: { ready: true, href: openTabs.get(tabId)?.url ?? '' } };
        }
        if (msg.type === 'INJECT_DRAFT') {
          return {
            ok: true,
            data: {
              ok: true,
              stage: 'INJECTED',
              uploadedImages: 0,
              failedImages: 0,
              message: '已写入草稿箱',
            },
          };
        }
        return { ok: false };
      }),
      onUpdated: {
        addListener: (
          fn: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
        ) => updatedListeners.add(fn),
        removeListener: (
          fn: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
        ) => updatedListeners.delete(fn),
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => removedListeners.add(fn),
        removeListener: (fn: (tabId: number) => void) => removedListeners.delete(fn),
      },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const taskBrandA: ExtensionPendingTaskDto = {
      ...DEMO_ZHIHU_TASK,
      taskId: 'task_simul_a',
      brandId: 'brand_alpha',
      brandName: '示例品牌甲',
    };
    const taskBrandB: ExtensionPendingTaskDto = {
      ...DEMO_ZHIHU_TASK,
      taskId: 'task_simul_b',
      brandId: 'brand_beta',
      brandName: '示例品牌乙',
    };

    const [resultA, resultB] = await Promise.all([
      dispatchDraftTask(taskBrandA, {
        tabsApi,
        tabLoadTimeoutMs: 1000,
        pingTimeoutMs: 500,
        pingRetryIntervalMs: 10,
      }),
      dispatchDraftTask(taskBrandB, {
        tabsApi,
        tabLoadTimeoutMs: 1000,
        pingTimeoutMs: 500,
        pingRetryIntervalMs: 10,
      }),
    ]);

    expect(resultA.accepted).toBe(true);
    expect(resultB.accepted).toBe(true);
    expect(resultA.tabId).toBe(701);
    expect(resultB.tabId).toBe(702);
    expect(resultA.tabId).not.toBe(resultB.tabId);

    expect(await getPendingTabTask(701)).toMatchObject({
      tabId: 701,
      taskId: 'task_simul_a',
      brandId: 'brand_alpha',
    });
    expect(await getPendingTabTask(702)).toMatchObject({
      tabId: 702,
      taskId: 'task_simul_b',
      brandId: 'brand_beta',
    });
  });

  it('releases in-flight tab claim cleanly when tab load or content readiness fails so the idle tab can be reused subsequently', async () => {
    const openTabs = new Map<number, chrome.tabs.Tab>([
      [
        801,
        {
          id: 801,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
      ],
    ]);

    let failPing = true;
    const tabsApi = {
      query: vi.fn(async () => Array.from(openTabs.values()).map((t) => ({ ...t }))),
      create: vi.fn(async () => {
        throw new Error('Should reuse tab 801 once claim is released');
      }),
      update: vi.fn(async (tabId: number) => ({ ...openTabs.get(tabId)! })),
      get: vi.fn(async (tabId: number) => ({ ...openTabs.get(tabId)! })),
      sendMessage: vi.fn(async (_tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          if (failPing) {
            throw new Error('Receiving end does not exist');
          }
          return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
        }
        return {
          ok: true,
          data: {
            ok: true,
            stage: 'INJECTED',
            uploadedImages: 0,
            failedImages: 0,
            message: 'ok',
          },
        };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const firstAttempt = await dispatchDraftTask(
      { ...DEMO_ZHIHU_TASK, taskId: 'task_claim_fail_a' },
      { tabsApi, pingRetryIntervalMs: 5, pingTimeoutMs: 20 },
    );
    expect(firstAttempt.accepted).toBe(false);
    expect(firstAttempt.tabId).toBe(801);

    // Claim for tab 801 must be released in finally, so a different task can reuse idle tab 801 cleanly
    failPing = false;
    const secondAttempt = await dispatchDraftTask(
      { ...DEMO_ZHIHU_TASK, taskId: 'task_claim_reuse_b' },
      { tabsApi, pingRetryIntervalMs: 5, pingTimeoutMs: 100 },
    );
    expect(secondAttempt.accepted).toBe(true);
    expect(secondAttempt.tabId).toBe(801);
  });

  it('does not persist a zombie PendingTabTask or send INJECT_DRAFT if tab closes right after PING_CONTENT (G7 Race A)', async () => {
    const removedListeners = new Set<(tabId: number) => void>();
    let tabAlive = true;

    const tabsApi = {
      query: vi.fn(async () => [
        {
          id: 901,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
      ]),
      create: vi.fn(async () => {
        throw new Error('Should reuse tab 901');
      }),
      update: vi.fn(async () => ({
        id: 901,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      get: vi.fn(async () => {
        if (!tabAlive) {
          throw new Error('No tab with id: 901');
        }
        return {
          id: 901,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab;
      }),
      sendMessage: vi.fn(async (_tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          // Simulate tab closing immediately as PING_CONTENT resolves
          tabAlive = false;
          for (const listener of removedListeners) {
            listener(901);
          }
          return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
        }
        throw new Error('INJECT_DRAFT must not be invoked on a closed tab');
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => removedListeners.add(fn),
        removeListener: (fn: (tabId: number) => void) => removedListeners.delete(fn),
      },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const result = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      tabsApi,
      tabLoadTimeoutMs: 500,
      pingTimeoutMs: 500,
      pingRetryIntervalMs: 10,
    });

    expect(result.accepted).toBe(false);
    expect(result.stage).toBe('EDITOR_NOT_FOUND');
    expect(await getPendingTabTask(901)).toBeNull();
    const sentTypes = (tabsApi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[1] as { type?: string })?.type,
    );
    expect(sentTypes).toEqual(['PING_CONTENT']);
  });

  it('prefers an inactive tab already bound to the same taskId over an active idle tab (G7)', async () => {
    await setPendingTabTask(createPendingTabTaskFromDto(911, DEMO_ZHIHU_TASK));

    const tabsApi = {
      query: vi.fn(async () => [
        {
          id: 912,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
        {
          id: 911,
          url: 'https://zhuanlan.zhihu.com/write',
          active: false,
          status: 'complete',
        } as chrome.tabs.Tab,
      ]),
      create: vi.fn(async () => {
        throw new Error('Should reuse existing same-taskId tab 911');
      }),
      update: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      sendMessage: vi.fn(async (_tabId: number, req: unknown) => {
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
        }
        return {
          ok: true,
          data: {
            ok: true,
            stage: 'INJECTED',
            uploadedImages: 0,
            failedImages: 0,
            message: 'ok',
          },
        };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const result = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      tabsApi,
      tabLoadTimeoutMs: 500,
      pingTimeoutMs: 500,
      pingRetryIntervalMs: 10,
    });

    expect(result.accepted).toBe(true);
    expect(result.tabId).toBe(911);
  });

  it('clamps non-finite Infinity/NaN dispatch timeouts safely to defaults (G7)', async () => {
    const tabsApi = {
      query: vi.fn(async () => [
        {
          id: 921,
          url: 'https://zhuanlan.zhihu.com/write',
          active: true,
          status: 'complete',
        } as chrome.tabs.Tab,
      ]),
      create: vi.fn(),
      update: vi.fn(async () => ({
        id: 921,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      get: vi.fn(async () => ({
        id: 921,
        url: 'https://zhuanlan.zhihu.com/write',
        active: true,
        status: 'complete',
      })),
      sendMessage: vi.fn(async (_tabId: number, req: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const msg = req as { type?: string };
        if (msg.type === 'PING_CONTENT') {
          return { ok: true, data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' } };
        }
        return {
          ok: true,
          data: {
            ok: true,
            stage: 'INJECTED',
            uploadedImages: 0,
            failedImages: 0,
            message: 'ok',
          },
        };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as Parameters<typeof dispatchDraftTask>[1] extends infer D
      ? D extends { tabsApi?: infer T }
        ? NonNullable<T>
        : never
      : never;

    const result = await dispatchDraftTask(DEMO_ZHIHU_TASK, {
      tabsApi,
      tabLoadTimeoutMs: Number.POSITIVE_INFINITY,
      pingTimeoutMs: Number.POSITIVE_INFINITY,
      pingRetryIntervalMs: Number.NaN,
    });

    expect(result.accepted).toBe(true);
    expect(result.tabId).toBe(921);
  });
});
