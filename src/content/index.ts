import { getAdapterByProvider, getAdapterByUrl } from '../adapters/registry';
import type { LocalImageUploader, PlatformDraftAdapter } from '../adapters/types';
import {
  ExtensionPendingTaskDtoSchema,
  type DraftInjectReport,
  type ExtensionPendingTaskDto,
  type ExtensionProviderKey,
} from '../shared/bridge-contract';
import {
  isBackgroundToContentRequest,
  sendRuntimeMessage,
  type BackgroundToContentResponseDataMap,
  type MessageResponse,
  type TabUrlChangedResponseData,
} from '../shared/messages';
import { redactSensitiveText } from '../shared/storage';
import { validatePublishedUrl } from '../shared/url-validation';
import { createLocalImageUploader } from './image-uploader';
import {
  getActiveCaptureBarHost,
  getActiveCaptureBarMode,
  mountOperatorNoticeBar,
  mountUrlCaptureBar,
  unmountCaptureBar,
} from './url-capture-bar';

const CONTENT_INIT_KEY = '__geomixContentInitialized' as const;

type ContentRuntimeWindow = Window & {
  [CONTENT_INIT_KEY]?: boolean;
};

export type ContentRuntimeDeps = {
  doc?: Document;
  win?: Window;
  extensionId?: string;
  getCurrentUrl?: () => URL;
  resolveAdapter?: (provider: ExtensionProviderKey, url: URL) => PlatformDraftAdapter | undefined;
  uploader?: LocalImageUploader;
  sendMessage?: typeof sendRuntimeMessage;
};

export type UrlCaptureCoordinator = {
  evaluateCurrentUrl: () => Promise<TabUrlChangedResponseData>;
  handleInjectedReport: (task: ExtensionPendingTaskDto, report: DraftInjectReport) => void;
  reset: () => void;
};

function defaultResolveAdapter(
  provider: ExtensionProviderKey,
  url: URL,
): PlatformDraftAdapter | undefined {
  const byProvider = getAdapterByProvider(provider);
  if (byProvider) {
    return byProvider;
  }
  const byUrl = getAdapterByUrl(url);
  return byUrl?.provider === provider ? byUrl : undefined;
}

function resolveCurrentUrl(deps?: ContentRuntimeDeps): URL {
  if (deps?.getCurrentUrl) {
    return deps.getCurrentUrl();
  }
  const win = deps?.win ?? window;
  return new URL(win.location.href);
}

function canonicalizeOriginPathname(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function installUrlWatcher(onUrlChange: () => void, win: Window = window): () => void {
  const originalPushState = win.history.pushState;
  const originalReplaceState = win.history.replaceState;
  let cleanedUp = false;

  const notify = () => {
    if (!cleanedUp) {
      onUrlChange();
    }
  };

  win.history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    const result = originalPushState.apply(this, args);
    notify();
    return result;
  };

  win.history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History['replaceState']>
  ) {
    const result = originalReplaceState.apply(this, args);
    notify();
    return result;
  };

  win.addEventListener('popstate', notify);
  win.addEventListener('hashchange', notify);

  return () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    win.history.pushState = originalPushState;
    win.history.replaceState = originalReplaceState;
    win.removeEventListener('popstate', notify);
    win.removeEventListener('hashchange', notify);
  };
}

export function createUrlCaptureCoordinator(deps?: ContentRuntimeDeps): UrlCaptureCoordinator {
  const doc = deps?.doc ?? document;
  const sendMessage = deps?.sendMessage ?? sendRuntimeMessage;
  const resolveAdapter = deps?.resolveAdapter ?? defaultResolveAdapter;

  let evalSeq = 0;
  let activeCaptureKey: string | null = null;
  let activeCaptureUrl: string | null = null;
  let inFlightConfirmKey: string | null = null;
  const dismissedKeys = new Set<string>();
  const confirmedKeys = new Set<string>();

  const unmountCaptureIfActive = () => {
    if (getActiveCaptureBarMode(doc) === 'capture') {
      unmountCaptureBar(doc);
    }
    activeCaptureKey = null;
    activeCaptureUrl = null;
  };

  const evaluateCurrentUrl = async (): Promise<TabUrlChangedResponseData> => {
    const seq = ++evalSeq;

    let response: Awaited<ReturnType<typeof sendMessage<{ type: 'GET_PENDING_TAB_TASK' }>>>;
    try {
      response = await sendMessage({ type: 'GET_PENDING_TAB_TASK' });
    } catch {
      return { checked: true, matched: false };
    }

    if (seq !== evalSeq) {
      return { checked: true, matched: false };
    }

    if (!response.ok || !response.data.task) {
      if (
        activeCaptureKey !== null &&
        activeCaptureUrl !== null &&
        (confirmedKeys.has(activeCaptureKey) || inFlightConfirmKey === activeCaptureKey) &&
        getActiveCaptureBarHost(doc) !== null &&
        getActiveCaptureBarMode(doc) === 'capture'
      ) {
        try {
          const currentUrl = resolveCurrentUrl(deps);
          const confirmedUrl = new URL(activeCaptureUrl);
          if (canonicalizeOriginPathname(currentUrl) === canonicalizeOriginPathname(confirmedUrl)) {
            return { checked: true, matched: true, publishedUrl: activeCaptureUrl };
          }
        } catch {
          // Fall through to unmount on URL parse error
        }
      }
      unmountCaptureIfActive();
      return { checked: true, matched: false };
    }

    const pendingTask = response.data.task;
    let currentUrl: URL;
    try {
      currentUrl = resolveCurrentUrl(deps);
    } catch {
      return { checked: true, matched: false };
    }

    const adapter = resolveAdapter(pendingTask.provider, currentUrl);
    let candidateUrl: string | null;
    if (adapter) {
      try {
        candidateUrl = adapter.extractPublishedUrl(currentUrl, doc);
      } catch {
        candidateUrl = null;
      }
    } else {
      candidateUrl = currentUrl.href;
    }

    if (!candidateUrl) {
      unmountCaptureIfActive();
      return { checked: true, matched: false };
    }

    // Mandatory allowlist double-check: provider first, rawUrl second
    const validated = validatePublishedUrl(pendingTask.provider, candidateUrl);
    if (!validated.ok) {
      unmountCaptureIfActive();
      return { checked: true, matched: false };
    }

    const canonicalUrl = validated.normalizedUrl;
    const captureKey = `${pendingTask.taskId}::${canonicalUrl}`;

    if (dismissedKeys.has(captureKey)) {
      return { checked: true, matched: true, publishedUrl: canonicalUrl };
    }

    if (
      (activeCaptureKey === captureKey || confirmedKeys.has(captureKey)) &&
      getActiveCaptureBarHost(doc) !== null &&
      getActiveCaptureBarMode(doc) === 'capture'
    ) {
      return { checked: true, matched: true, publishedUrl: canonicalUrl };
    }

    activeCaptureKey = captureKey;
    activeCaptureUrl = canonicalUrl;
    mountUrlCaptureBar({
      doc,
      task: pendingTask,
      publishedUrl: canonicalUrl,
      onConfirmPublished: async ({ taskId, publishedUrl }) => {
        inFlightConfirmKey = captureKey;
        try {
          const res = await sendMessage({
            type: 'CONFIRM_PUBLISHED_URL',
            payload: {
              taskId,
              publishedUrl,
            },
          });
          if (res.ok) {
            confirmedKeys.add(captureKey);
          }
          return res;
        } finally {
          if (inFlightConfirmKey === captureKey) {
            inFlightConfirmKey = null;
          }
        }
      },
      onConfirmed: () => {
        confirmedKeys.add(captureKey);
      },
      onDismiss: () => {
        dismissedKeys.add(captureKey);
        if (activeCaptureKey === captureKey) {
          activeCaptureKey = null;
          activeCaptureUrl = null;
        }
      },
    });

    return { checked: true, matched: true, publishedUrl: canonicalUrl };
  };

  const handleInjectedReport = (task: ExtensionPendingTaskDto, report: DraftInjectReport): void => {
    const hasFailedImages = report.failedImages > 0;
    const hasReminders = Boolean(report.operatorReminders && report.operatorReminders.length > 0);
    if (!hasFailedImages && !hasReminders) {
      if (getActiveCaptureBarMode(doc) === 'notice') {
        unmountCaptureBar(doc);
      }
      return;
    }

    activeCaptureKey = null;
    activeCaptureUrl = null;
    mountOperatorNoticeBar({
      doc,
      provider: task.provider,
      variantTitle: task.variantTitle,
      uploadedImages: report.uploadedImages,
      failedImages: report.failedImages,
      failedImageDetails: report.failedImageDetails,
      operatorReminders: report.operatorReminders,
      message: report.message,
    });
  };

  const reset = (): void => {
    evalSeq += 1;
    activeCaptureKey = null;
    activeCaptureUrl = null;
    inFlightConfirmKey = null;
    dismissedKeys.clear();
    confirmedKeys.clear();
    unmountCaptureBar(doc);
  };

  return {
    evaluateCurrentUrl,
    handleInjectedReport,
    reset,
  };
}

export function createContentMessageHandler(
  deps?: ContentRuntimeDeps,
  existingCoordinator?: UrlCaptureCoordinator,
) {
  const doc = deps?.doc ?? document;
  const resolveAdapter = deps?.resolveAdapter ?? defaultResolveAdapter;
  const uploader = deps?.uploader ?? createLocalImageUploader();
  const coordinator = existingCoordinator ?? createUrlCaptureCoordinator(deps);

  return function handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (
      response: MessageResponse<
        BackgroundToContentResponseDataMap[keyof BackgroundToContentResponseDataMap]
      >,
    ) => void,
  ): boolean {
    const expectedId =
      deps?.extensionId ?? (typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined);

    // Fail-closed: accept messages strictly from our own extension background SW (no sender.tab)
    if (!expectedId || sender.id !== expectedId || sender.tab !== undefined) {
      return false;
    }

    if (!isBackgroundToContentRequest(message)) {
      return false;
    }

    if (message.type === 'PING_CONTENT') {
      const currentUrl = resolveCurrentUrl(deps);
      sendResponse({
        ok: true,
        data: {
          ready: true,
          href: currentUrl.href,
        },
      });
      return false;
    }

    if (message.type === 'TAB_URL_CHANGED') {
      void coordinator
        .evaluateCurrentUrl()
        .then((result) => {
          sendResponse({ ok: true, data: result });
        })
        .catch(() => {
          sendResponse({
            ok: true,
            data: { checked: true, matched: false },
          });
        });
      return true;
    }

    if (message.type === 'INJECT_DRAFT') {
      const parsedTask = ExtensionPendingTaskDtoSchema.safeParse(message.payload?.task);
      if (!parsedTask.success) {
        sendResponse({
          ok: false,
          error: {
            kind: 'INVALID_REQUEST',
            message: '草稿任务格式无效',
            reauthRequired: false,
          },
        });
        return false;
      }

      const task = parsedTask.data;
      void (async () => {
        let currentUrl: URL;
        try {
          currentUrl = resolveCurrentUrl(deps);
        } catch {
          sendResponse({
            ok: true,
            data: {
              ok: false,
              stage: 'EDITOR_NOT_FOUND',
              uploadedImages: 0,
              failedImages: 0,
              message: '无法解析当前页面地址，暂无法自动注入草稿。',
            },
          });
          return;
        }

        const adapter = resolveAdapter(task.provider, currentUrl);
        if (!adapter) {
          sendResponse({
            ok: true,
            data: {
              ok: false,
              stage: 'EDITOR_NOT_FOUND',
              uploadedImages: 0,
              failedImages: 0,
              message: '当前平台草稿适配器尚未注册，暂无法自动注入草稿。',
            },
          });
          return;
        }

        try {
          if (!adapter.isLoggedInEditor(doc, currentUrl)) {
            sendResponse({
              ok: true,
              data: {
                ok: false,
                stage: 'AUTH_REQUIRED',
                uploadedImages: 0,
                failedImages: 0,
                message: '检测到目标平台尚未登录或未处于编辑页，请先登录平台账号后重试。',
              },
            });
            return;
          }

          const report = await adapter.injectDraft(doc, task, uploader);
          coordinator.handleInjectedReport(task, report);
          sendResponse({ ok: true, data: report });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : '草稿写入过程发生异常';
          sendResponse({
            ok: true,
            data: {
              ok: false,
              stage: 'EDITOR_NOT_FOUND',
              uploadedImages: 0,
              failedImages: 0,
              message: redactSensitiveText(`草稿写入失败：${detail}`),
            },
          });
        }
      })();
      return true;
    }

    return false;
  };
}

export function initContentRuntime(deps?: ContentRuntimeDeps): () => void {
  const win = deps?.win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return () => {};
  }

  const runtimeWindow = win as ContentRuntimeWindow;
  if (runtimeWindow[CONTENT_INIT_KEY]) {
    return () => {};
  }
  runtimeWindow[CONTENT_INIT_KEY] = true;

  const coordinator = createUrlCaptureCoordinator(deps);
  const messageListener = createContentMessageHandler(deps, coordinator);

  chrome.runtime.onMessage.addListener(messageListener);

  const stopUrlWatcher = installUrlWatcher(() => {
    void coordinator.evaluateCurrentUrl().catch(() => {});
  }, win);

  // Trigger initial evaluation to capture post-publish full-page redirects
  void coordinator.evaluateCurrentUrl().catch(() => {});

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stopUrlWatcher();
    chrome.runtime.onMessage.removeListener(messageListener);
    coordinator.reset();
    runtimeWindow[CONTENT_INIT_KEY] = false;
  };
}

initContentRuntime();
