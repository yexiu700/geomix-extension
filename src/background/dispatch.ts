import { getAdapterByProvider, PROVIDER_EDITOR_ENTRY_URLS } from '../adapters/registry';
import type { PlatformDraftAdapter } from '../adapters/types';
import {
  DraftInjectReportSchema,
  ExtensionPendingTaskDtoSchema,
  type DraftInjectReport,
  type ExtensionPendingTaskDto,
  type ExtensionProviderKey,
} from '../shared/bridge-contract';
import type {
  BackgroundToContentRequest,
  ContentPingResponseData,
  MessageResponse,
  PushDraftTaskResponseData,
} from '../shared/messages';
import {
  createPendingTabTaskFromDto,
  listPendingTabTasks,
  redactSensitiveText,
  setPendingTabTask,
  updatePendingTabTask,
  type ChromeStorageAreaLike,
} from '../shared/storage';
import { isAllowedPlatformSenderUrl, normalizeZhihuQuestionUrl } from '../shared/url-validation';

export { PROVIDER_EDITOR_ENTRY_URLS };

const DEFAULT_TAB_LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_PING_TIMEOUT_MS = 10_000;
const DEFAULT_PING_RETRY_INTERVAL_MS = 250;

export type ChromeTabsApiLike = Pick<
  typeof chrome.tabs,
  'query' | 'create' | 'update' | 'get' | 'sendMessage' | 'onUpdated' | 'onRemoved'
>;

export type ChromeScriptingApiLike = Pick<typeof chrome.scripting, 'executeScript'>;

export type DispatchDraftDeps = {
  tabsApi?: ChromeTabsApiLike;
  scriptingApi?: ChromeScriptingApiLike;
  sessionStorageArea?: ChromeStorageAreaLike;
  getAdapter?: (
    provider: ExtensionProviderKey,
  ) => Pick<PlatformDraftAdapter, 'editorEntryUrl'> | undefined;
  tabLoadTimeoutMs?: number;
  pingTimeoutMs?: number;
  pingRetryIntervalMs?: number;
  verifyStillAuthorized?: () => Promise<boolean>;
  now?: () => Date;
};

function resolveTabsApi(deps?: DispatchDraftDeps): ChromeTabsApiLike {
  if (deps?.tabsApi) {
    return deps.tabsApi;
  }
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    return chrome.tabs;
  }
  throw new Error('扩展标签页接口不可用');
}

function resolveScriptingApi(deps?: DispatchDraftDeps): ChromeScriptingApiLike | undefined {
  if (deps?.scriptingApi) {
    return deps.scriptingApi;
  }
  if (typeof chrome !== 'undefined' && typeof chrome.scripting?.executeScript === 'function') {
    return chrome.scripting;
  }
  return undefined;
}

export function resolveTaskEditorEntryUrl(
  task: ExtensionPendingTaskDto,
  getAdapter?: (
    provider: ExtensionProviderKey,
  ) => Pick<PlatformDraftAdapter, 'editorEntryUrl'> | undefined,
): string {
  if (task.provider === 'ZHIHU_EXT') {
    const zhihuQuestion = normalizeZhihuQuestionUrl(task.targetUrlHint);
    if (zhihuQuestion) {
      return zhihuQuestion;
    }
  }

  const lookup = getAdapter ?? getAdapterByProvider;
  const adapterEntry = lookup(task.provider)?.editorEntryUrl;
  if (adapterEntry && isAllowedPlatformSenderUrl(adapterEntry)) {
    return adapterEntry;
  }

  return PROVIDER_EDITOR_ENTRY_URLS[task.provider];
}

function normalizeUrlForTabMatch(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') {
    return null;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

type InFlightTabClaim = {
  taskId: string;
  count: number;
};

type TabAllocationState = {
  lockTail: Promise<void>;
  inFlightTabClaims: Map<number, InFlightTabClaim>;
};

const tabAllocationStates = new WeakMap<object, TabAllocationState>();

function resolveTabAllocationKey(
  tabsApi: ChromeTabsApiLike,
  sessionStorageArea?: ChromeStorageAreaLike,
): object {
  if (sessionStorageArea) {
    return sessionStorageArea;
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    return chrome.storage.session;
  }
  return tabsApi;
}

function getTabAllocationState(key: object): TabAllocationState {
  let state = tabAllocationStates.get(key);
  if (!state) {
    state = {
      lockTail: Promise.resolve(),
      inFlightTabClaims: new Map<number, InFlightTabClaim>(),
    };
    tabAllocationStates.set(key, state);
  }
  return state;
}

async function withTabAllocationLock<T>(
  key: object,
  operation: (inFlightTabClaims: Map<number, InFlightTabClaim>) => Promise<T>,
): Promise<T> {
  const state = getTabAllocationState(key);
  const previous = state.lockTail;
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current);
  state.lockTail = chained;

  await previous;
  try {
    return await operation(state.inFlightTabClaims);
  } finally {
    releaseCurrent?.();
  }
}

function claimInFlightTab(
  inFlightTabClaims: Map<number, InFlightTabClaim>,
  tabId: number,
  taskId: string,
): void {
  const existing = inFlightTabClaims.get(tabId);
  if (existing && existing.taskId === taskId) {
    existing.count += 1;
  } else {
    inFlightTabClaims.set(tabId, { taskId, count: 1 });
  }
}

function releaseInFlightTabClaim(key: object, tabId: number, taskId: string): void {
  const state = tabAllocationStates.get(key);
  if (!state) {
    return;
  }
  const existing = state.inFlightTabClaims.get(tabId);
  if (existing && existing.taskId === taskId) {
    if (existing.count > 1) {
      existing.count -= 1;
    } else {
      state.inFlightTabClaims.delete(tabId);
    }
  }
}

async function openOrReuseEditorTab(
  targetUrl: string,
  taskId: string,
  tabsApi: ChromeTabsApiLike,
  allocationKey: object,
  sessionStorageArea?: ChromeStorageAreaLike,
): Promise<{ ok: true; tabId: number; reused: boolean } | { ok: false; message: string }> {
  const targetKey = normalizeUrlForTabMatch(targetUrl);
  if (!targetKey) {
    return { ok: false, message: '目标平台编辑页地址无效，无法调度草稿写入。' };
  }

  return withTabAllocationLock(allocationKey, async (inFlightTabClaims) => {
    const existingBindings = await listPendingTabTasks(sessionStorageArea);
    const boundToOtherTaskTabIds = new Set<number>();
    const boundToSameTaskTabIds = new Set<number>();

    for (const binding of existingBindings) {
      if (binding.taskId === taskId) {
        boundToSameTaskTabIds.add(binding.tabId);
      } else {
        boundToOtherTaskTabIds.add(binding.tabId);
      }
    }

    for (const [claimedTabId, claim] of inFlightTabClaims.entries()) {
      if (claim.taskId === taskId) {
        boundToSameTaskTabIds.add(claimedTabId);
      } else {
        boundToOtherTaskTabIds.add(claimedTabId);
      }
    }

    const originPattern = `${new URL(targetUrl).origin}/*`;
    let queriedTabs: chrome.tabs.Tab[] = [];
    try {
      queriedTabs = await tabsApi.query({ url: originPattern });
    } catch {
      try {
        queriedTabs = await tabsApi.query({});
      } catch {
        queriedTabs = [];
      }
    }

    const eligibleTabs = queriedTabs.filter((tab) => {
      if (typeof tab.id !== 'number' || !Number.isInteger(tab.id) || tab.id <= 0) {
        return false;
      }
      if (boundToOtherTaskTabIds.has(tab.id)) {
        return false;
      }
      if (typeof tab.url !== 'string') {
        return false;
      }
      return normalizeUrlForTabMatch(tab.url) === targetKey;
    });

    const sameTaskTabs = eligibleTabs.filter(
      (tab) => typeof tab.id === 'number' && boundToSameTaskTabIds.has(tab.id),
    );
    const reusable =
      sameTaskTabs.find((tab) => tab.active === true) ??
      sameTaskTabs[0] ??
      eligibleTabs.find((tab) => tab.active === true) ??
      eligibleTabs[0];

    if (reusable && typeof reusable.id === 'number') {
      try {
        await tabsApi.update(reusable.id, { active: true });
        claimInFlightTab(inFlightTabClaims, reusable.id, taskId);
        return { ok: true, tabId: reusable.id, reused: true };
      } catch {
        // Fall through to creating a fresh tab if the matched tab closed concurrently
      }
    }

    try {
      const created = await tabsApi.create({ url: targetUrl, active: true });
      if (typeof created?.id !== 'number' || !Number.isInteger(created.id) || created.id <= 0) {
        return { ok: false, message: '打开目标平台编辑页失败：未能获取有效标签页 ID。' };
      }
      claimInFlightTab(inFlightTabClaims, created.id, taskId);
      return { ok: true, tabId: created.id, reused: false };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '未知错误';
      return {
        ok: false,
        message: redactSensitiveText(`打开目标平台编辑页失败：${detail}`),
      };
    }
  });
}

async function waitForTabComplete(
  tabId: number,
  tabsApi: ChromeTabsApiLike,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: 'TAB_CLOSED' | 'TIMEOUT' }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      tabsApi.onUpdated?.removeListener(onUpdated);
      tabsApi.onRemoved?.removeListener(onRemoved);
    };

    const finish = (result: { ok: true } | { ok: false; reason: 'TAB_CLOSED' | 'TIMEOUT' }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish({ ok: true });
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        finish({ ok: false, reason: 'TAB_CLOSED' });
      }
    };

    tabsApi.onUpdated?.addListener(onUpdated);
    tabsApi.onRemoved?.addListener(onRemoved);

    timer = setTimeout(() => {
      finish({ ok: false, reason: 'TIMEOUT' });
    }, timeoutMs);

    void Promise.resolve()
      .then(() => tabsApi.get(tabId))
      .then((tab) => {
        if (!tab) {
          finish({ ok: false, reason: 'TAB_CLOSED' });
          return;
        }
        if (tab.status === 'complete' || tab.status === undefined) {
          finish({ ok: true });
        }
      })
      .catch(() => {
        finish({ ok: false, reason: 'TAB_CLOSED' });
      });
  });
}

function isPingReadyResponse(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<MessageResponse<ContentPingResponseData>>;
  if (candidate.ok !== true) {
    return false;
  }
  return Boolean(
    candidate.data &&
    typeof candidate.data === 'object' &&
    (candidate.data as Partial<ContentPingResponseData>).ready === true,
  );
}

async function waitForContentScriptReady(
  tabId: number,
  tabsApi: ChromeTabsApiLike,
  options: {
    scriptingApi?: ChromeScriptingApiLike;
    reused: boolean;
    timeoutMs: number;
    retryIntervalMs: number;
  },
): Promise<{ ok: true } | { ok: false; reason: 'TAB_CLOSED' | 'TIMEOUT' }> {
  let closed = false;
  let wakeClosed: (() => void) | null = null;

  const onRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) {
      closed = true;
      wakeClosed?.();
    }
  };

  tabsApi.onRemoved?.addListener(onRemoved);

  const sleepInterruptible = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (closed || ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wakeClosed = null;
        resolve();
      }, ms);
      wakeClosed = () => {
        clearTimeout(timer);
        wakeClosed = null;
        resolve();
      };
    });

  const deadline = Date.now() + options.timeoutMs;
  let attemptedFallbackInject = false;

  try {
    while (true) {
      if (closed) {
        return { ok: false, reason: 'TAB_CLOSED' };
      }

      try {
        const pingRequest: BackgroundToContentRequest = { type: 'PING_CONTENT' };
        const response: unknown = await tabsApi.sendMessage(tabId, pingRequest);
        if (isPingReadyResponse(response)) {
          return { ok: true };
        }
      } catch {
        if (options.reused && !attemptedFallbackInject && options.scriptingApi?.executeScript) {
          attemptedFallbackInject = true;
          try {
            await options.scriptingApi.executeScript({
              target: { tabId },
              files: ['content.js'],
            });
          } catch {
            // Continue polling until timeout
          }
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return closed ? { ok: false, reason: 'TAB_CLOSED' } : { ok: false, reason: 'TIMEOUT' };
      }

      await sleepInterruptible(Math.min(options.retryIntervalMs, remaining));
    }
  } finally {
    tabsApi.onRemoved?.removeListener(onRemoved);
  }
}

function buildEditorNotFoundFailure(
  taskId: string,
  message: string,
  tabId?: number,
): PushDraftTaskResponseData {
  const safeMessage = redactSensitiveText(message);
  const report: DraftInjectReport = {
    ok: false,
    stage: 'EDITOR_NOT_FOUND',
    uploadedImages: 0,
    failedImages: 0,
    message: safeMessage,
  };
  return {
    taskId,
    accepted: false,
    stage: 'EDITOR_NOT_FOUND',
    ...(tabId !== undefined ? { tabId } : {}),
    message: safeMessage,
    report,
  };
}

function unwrapInjectDraftReport(rawResponse: unknown): DraftInjectReport {
  if (rawResponse !== null && rawResponse !== undefined && typeof rawResponse === 'object') {
    const envelope = rawResponse as Partial<MessageResponse<unknown>>;
    if (envelope.ok === true) {
      const parsed = DraftInjectReportSchema.safeParse(envelope.data);
      if (parsed.success) {
        return parsed.data;
      }
    } else if (
      envelope.ok === false &&
      envelope.error &&
      typeof envelope.error.message === 'string'
    ) {
      return {
        ok: false,
        stage: 'EDITOR_NOT_FOUND',
        uploadedImages: 0,
        failedImages: 0,
        message: redactSensitiveText(envelope.error.message),
      };
    }

    const directParsed = DraftInjectReportSchema.safeParse(rawResponse);
    if (directParsed.success) {
      return directParsed.data;
    }
  }

  return {
    ok: false,
    stage: 'EDITOR_NOT_FOUND',
    uploadedImages: 0,
    failedImages: 0,
    message: '编辑页注入返回了无效的报告格式，请刷新目标页面后重试。',
  };
}

export async function dispatchDraftTask(
  task: ExtensionPendingTaskDto,
  deps?: DispatchDraftDeps,
): Promise<PushDraftTaskResponseData> {
  const parsedTask = ExtensionPendingTaskDtoSchema.safeParse(task);
  if (!parsedTask.success) {
    return buildEditorNotFoundFailure(
      typeof (task as { taskId?: unknown })?.taskId === 'string'
        ? (task as { taskId: string }).taskId
        : 'unknown',
      '待写入草稿的任务数据格式无效',
    );
  }

  const validTask = parsedTask.data;
  const tabsApi = resolveTabsApi(deps);
  const scriptingApi = resolveScriptingApi(deps);
  const targetUrl = resolveTaskEditorEntryUrl(validTask, deps?.getAdapter);

  const allocationKey = resolveTabAllocationKey(tabsApi, deps?.sessionStorageArea);
  const tabResult = await openOrReuseEditorTab(
    targetUrl,
    validTask.taskId,
    tabsApi,
    allocationKey,
    deps?.sessionStorageArea,
  );
  if (!tabResult.ok) {
    return buildEditorNotFoundFailure(validTask.taskId, tabResult.message);
  }

  const { tabId, reused } = tabResult;
  const loadTimeoutMs =
    typeof deps?.tabLoadTimeoutMs === 'number' &&
    Number.isFinite(deps.tabLoadTimeoutMs) &&
    deps.tabLoadTimeoutMs > 0
      ? deps.tabLoadTimeoutMs
      : DEFAULT_TAB_LOAD_TIMEOUT_MS;
  const pingTimeoutMs =
    typeof deps?.pingTimeoutMs === 'number' &&
    Number.isFinite(deps.pingTimeoutMs) &&
    deps.pingTimeoutMs > 0
      ? deps.pingTimeoutMs
      : DEFAULT_PING_TIMEOUT_MS;
  const pingRetryIntervalMs =
    typeof deps?.pingRetryIntervalMs === 'number' &&
    Number.isFinite(deps.pingRetryIntervalMs) &&
    deps.pingRetryIntervalMs > 0
      ? deps.pingRetryIntervalMs
      : DEFAULT_PING_RETRY_INTERVAL_MS;

  let tabClosed = false;
  const onTabRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) {
      tabClosed = true;
    }
  };
  tabsApi.onRemoved?.addListener(onTabRemoved);

  try {
    const loadResult = await waitForTabComplete(tabId, tabsApi, loadTimeoutMs);
    if (!loadResult.ok) {
      return buildEditorNotFoundFailure(
        validTask.taskId,
        loadResult.reason === 'TAB_CLOSED'
          ? '目标平台编辑页已关闭，请重新写入草稿箱。'
          : '等待目标平台编辑页加载超时，请确认页面可访问后重试。',
        tabId,
      );
    }

    const readyResult = await waitForContentScriptReady(tabId, tabsApi, {
      scriptingApi,
      reused,
      timeoutMs: pingTimeoutMs,
      retryIntervalMs: pingRetryIntervalMs,
    });
    if (!readyResult.ok) {
      return buildEditorNotFoundFailure(
        validTask.taskId,
        readyResult.reason === 'TAB_CLOSED'
          ? '目标平台编辑页已关闭，请重新写入草稿箱。'
          : '目标平台编辑页注入脚本未就绪，请刷新编辑页后重试。',
        tabId,
      );
    }

    // Re-verify tab liveness, origin, and pairing authorization right before persisting
    // chrome.storage.session state to close tab-close and concurrent-unbind TOCTOU windows.
    let liveTab: chrome.tabs.Tab | undefined;
    try {
      liveTab = await tabsApi.get(tabId);
    } catch {
      liveTab = undefined;
    }
    if (tabClosed || !liveTab) {
      return buildEditorNotFoundFailure(
        validTask.taskId,
        '目标平台编辑页已关闭，请重新写入草稿箱。',
        tabId,
      );
    }
    if (
      typeof liveTab.url === 'string' &&
      liveTab.url.length > 0 &&
      !isAllowedPlatformSenderUrl(liveTab.url)
    ) {
      return buildEditorNotFoundFailure(
        validTask.taskId,
        '目标标签页已离开受支持的内容平台，请重新写入草稿箱。',
        tabId,
      );
    }

    if (deps?.verifyStillAuthorized) {
      const stillAuthorized = await deps.verifyStillAuthorized();
      if (!stillAuthorized) {
        return buildEditorNotFoundFailure(validTask.taskId, '账号已解绑，已取消草稿写入。', tabId);
      }
    }
    if (tabClosed) {
      return buildEditorNotFoundFailure(
        validTask.taskId,
        '目标平台编辑页已关闭，请重新写入草稿箱。',
        tabId,
      );
    }

    // Persist tab <-> task binding in chrome.storage.session BEFORE dispatching INJECT_DRAFT
    // so MV3 Service Worker hibernation or restart never loses the association.
    const pendingRecord = createPendingTabTaskFromDto(tabId, validTask);
    await setPendingTabTask(pendingRecord, deps?.sessionStorageArea);

    let rawReport: unknown;
    try {
      const injectRequest: BackgroundToContentRequest = {
        type: 'INJECT_DRAFT',
        payload: { task: validTask },
      };
      rawReport = await tabsApi.sendMessage(tabId, injectRequest);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '向编辑页派发草稿失败';
      const report: DraftInjectReport = {
        ok: false,
        stage: 'EDITOR_NOT_FOUND',
        uploadedImages: 0,
        failedImages: 0,
        message: redactSensitiveText(`向编辑页派发草稿失败：${detail}`),
      };
      await updatePendingTabTask(tabId, { lastInjectReport: report }, deps?.sessionStorageArea);
      return {
        taskId: validTask.taskId,
        accepted: false,
        stage: report.stage,
        tabId,
        message: report.message,
        report,
      };
    }

    const report = unwrapInjectDraftReport(rawReport);
    const accepted = report.stage === 'INJECTED' || report.stage === 'PARTIAL_MEDIA_FAILED';

    await updatePendingTabTask(
      tabId,
      {
        ...(accepted ? { injectedAt: (deps?.now?.() ?? new Date()).toISOString() } : {}),
        lastInjectReport: report,
      },
      deps?.sessionStorageArea,
    );

    return {
      taskId: validTask.taskId,
      accepted,
      stage: report.stage,
      tabId,
      ...(report.draftUrl ? { draftUrl: report.draftUrl } : {}),
      message: report.message,
      report,
    };
  } finally {
    tabsApi.onRemoved?.removeListener(onTabRemoved);
    releaseInFlightTabClaim(allocationKey, tabId, validTask.taskId);
  }
}
