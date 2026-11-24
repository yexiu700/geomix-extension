import type { PlatformDraftAdapter } from '../adapters/types';
import {
  ExtensionMediaAssetSchema,
  ExtensionPendingTaskDtoSchema,
  type ExtensionProviderKey,
} from '../shared/bridge-contract';
import {
  isContentToBackgroundRequest,
  isExtensionRuntimeRequest,
  isPopupRuntimeRequest,
  type BackgroundToContentRequest,
  type ExtensionResponseDataMap,
  type ExtensionRuntimeRequest,
  type MessageResponse,
} from '../shared/messages';
import {
  clearPairing,
  clearPendingTabTasks,
  getPairing,
  getPendingTabTask,
  getPublicPairing,
  listPendingTabTasks,
  removePendingTabTask,
  savePairing,
  type ChromeStorageAreaLike,
  type PendingTabTask,
} from '../shared/storage';
import { isAllowedPlatformSenderUrl, validatePublishedUrl } from '../shared/url-validation';
import { BridgeError, createBridgeClient, serializeBridgeError } from './bridge-client';
import { dispatchDraftTask, type ChromeScriptingApiLike, type ChromeTabsApiLike } from './dispatch';
import { createMediaFetcher, type MediaFetcher } from './media-fetcher';

export type BackgroundHandlerDeps = {
  storageArea?: ChromeStorageAreaLike;
  sessionStorageArea?: ChromeStorageAreaLike;
  tabsApi?: ChromeTabsApiLike;
  scriptingApi?: ChromeScriptingApiLike;
  fetchImpl?: typeof fetch;
  mediaFetcher?: MediaFetcher;
  dispatchDraftTaskFn?: typeof dispatchDraftTask;
  getAdapter?: (
    provider: ExtensionProviderKey,
  ) => Pick<PlatformDraftAdapter, 'editorEntryUrl'> | undefined;
  getExtensionVersion?: () => string;
  extensionId?: string;
};

function resolveExtensionVersion(deps?: BackgroundHandlerDeps): string {
  if (deps?.getExtensionVersion) {
    return deps.getExtensionVersion();
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
    const manifestVersion = chrome.runtime.getManifest().version;
    if (manifestVersion && manifestVersion.trim().length > 0) {
      return manifestVersion;
    }
  }
  return '0.1.0';
}

function resolveExpectedExtensionId(deps?: BackgroundHandlerDeps): string | undefined {
  if (deps?.extensionId !== undefined) {
    return deps.extensionId;
  }
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string') {
    return chrome.runtime.id;
  }
  return undefined;
}

function isTrustedExtensionPopupSender(
  sender: chrome.runtime.MessageSender,
  expectedId: string,
): boolean {
  if (sender.tab !== undefined) {
    return false;
  }
  if (sender.url !== undefined && !sender.url.startsWith(`chrome-extension://${expectedId}/`)) {
    return false;
  }
  return true;
}

function getTrustedContentSenderTabId(sender: chrome.runtime.MessageSender): number | null {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    return null;
  }
  if (sender.frameId !== undefined && sender.frameId !== 0) {
    return null;
  }
  const senderUrl = sender.url !== undefined ? sender.url : sender.tab?.url;
  if (!isAllowedPlatformSenderUrl(senderUrl)) {
    return null;
  }
  return tabId;
}

function isFailedUninjectedTask(task: PendingTabTask): boolean {
  return task.lastInjectReport?.ok === false && !task.injectedAt;
}

async function prunePendingTabTasksByAuthorizedBrands(
  authorizedBrandIds: ReadonlySet<string>,
  sessionStorageArea?: ChromeStorageAreaLike,
): Promise<void> {
  if (authorizedBrandIds.size === 0) {
    await clearPendingTabTasks(sessionStorageArea);
    return;
  }
  const existingTasks = await listPendingTabTasks(sessionStorageArea);
  for (const existing of existingTasks) {
    if (!authorizedBrandIds.has(existing.brandId)) {
      await removePendingTabTask(existing.tabId, sessionStorageArea);
    }
  }
}

export function createBackgroundMessageHandler(deps?: BackgroundHandlerDeps) {
  const mediaFetcher = deps?.mediaFetcher ?? createMediaFetcher({ fetchImpl: deps?.fetchImpl });

  return async function handleMessage(
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender = {},
  ): Promise<MessageResponse<ExtensionResponseDataMap[ExtensionRuntimeRequest['type']]>> {
    const expectedId = resolveExpectedExtensionId(deps);
    if (!expectedId || sender.id !== expectedId) {
      return {
        ok: false,
        error: {
          kind: 'FORBIDDEN',
          message: '拒绝外部扩展来源的消息',
          reauthRequired: false,
        },
      };
    }

    if (!isExtensionRuntimeRequest(rawMessage)) {
      return {
        ok: false,
        error: {
          kind: 'INVALID_REQUEST',
          message: '不支持的内部消息类型',
          reauthRequired: false,
        },
      };
    }

    if (isPopupRuntimeRequest(rawMessage)) {
      if (!isTrustedExtensionPopupSender(sender, expectedId)) {
        return {
          ok: false,
          error: {
            kind: 'FORBIDDEN',
            message: '该操作仅限扩展控制台页面调用',
            reauthRequired: false,
          },
        };
      }
    } else if (isContentToBackgroundRequest(rawMessage)) {
      const trustedTabId = getTrustedContentSenderTabId(sender);
      if (trustedTabId === null) {
        return {
          ok: false,
          error: {
            kind: 'FORBIDDEN',
            message: '拒绝非授权平台页面或子框架的内部消息请求',
            reauthRequired: false,
          },
        };
      }
    }

    try {
      switch (rawMessage.type) {
        case 'PAIR_ACCOUNT': {
          const payload = rawMessage.payload;
          if (
            !payload ||
            typeof payload.baseUrl !== 'string' ||
            typeof payload.token !== 'string'
          ) {
            throw new BridgeError('INVALID_REQUEST', '配对请求缺少服务地址或 Token');
          }

          const client = createBridgeClient({
            baseUrl: payload.baseUrl,
            token: payload.token,
            extensionVersion: resolveExtensionVersion(deps),
            fetchImpl: deps?.fetchImpl,
          });

          const me = await client.getMe();
          const saved = await savePairing(
            {
              baseUrl: payload.baseUrl,
              token: payload.token,
              me,
            },
            deps?.storageArea,
          );

          const authorizedBrandIds = new Set(saved.me.brands.map((brand) => brand.brandId));
          await prunePendingTabTasksByAuthorizedBrands(
            authorizedBrandIds,
            deps?.sessionStorageArea,
          );

          return {
            ok: true,
            data: {
              baseUrl: saved.baseUrl,
              me: saved.me,
              pairedAt: saved.pairedAt,
            },
          };
        }

        case 'GET_PAIRING_STATUS': {
          const pairing = await getPublicPairing(deps?.storageArea);
          if (!pairing) {
            return {
              ok: true,
              data: { paired: false },
            };
          }
          return {
            ok: true,
            data: {
              paired: true,
              baseUrl: pairing.baseUrl,
              me: pairing.me,
              pairedAt: pairing.pairedAt,
            },
          };
        }

        case 'UNBIND_ACCOUNT': {
          await clearPairing(deps?.storageArea);
          if (rawMessage.preservePendingTabTasks !== true) {
            await clearPendingTabTasks(deps?.sessionStorageArea);
          }
          return {
            ok: true,
            data: { unbound: true },
          };
        }

        case 'FETCH_PENDING_TASKS': {
          const pairing = await getPairing(deps?.storageArea);
          if (!pairing) {
            throw new BridgeError('NOT_PAIRED', '尚未配对 GeoMix 账号，请先完成配对。');
          }

          const client = createBridgeClient({
            baseUrl: pairing.baseUrl,
            token: pairing.token,
            extensionVersion: resolveExtensionVersion(deps),
            fetchImpl: deps?.fetchImpl,
          });

          const tasks = await client.getTasks(rawMessage.payload);
          return {
            ok: true,
            data: { tasks },
          };
        }

        case 'PUSH_DRAFT_TASK': {
          const pairing = await getPairing(deps?.storageArea);
          if (!pairing) {
            throw new BridgeError('NOT_PAIRED', '尚未配对 GeoMix 账号，请先完成配对。');
          }

          const parsedTask = ExtensionPendingTaskDtoSchema.safeParse(rawMessage.payload?.task);
          if (!parsedTask.success) {
            throw new BridgeError('INVALID_REQUEST', '待写入草稿的任务数据格式无效');
          }

          const dispatcher = deps?.dispatchDraftTaskFn ?? dispatchDraftTask;
          const result = await dispatcher(parsedTask.data, {
            tabsApi: deps?.tabsApi,
            scriptingApi: deps?.scriptingApi,
            sessionStorageArea: deps?.sessionStorageArea,
            getAdapter: deps?.getAdapter,
            verifyStillAuthorized: async () => (await getPairing(deps?.storageArea)) !== null,
          });

          return {
            ok: true,
            data: result,
          };
        }

        case 'FETCH_MEDIA_ASSET': {
          const parsedAsset = ExtensionMediaAssetSchema.safeParse(rawMessage.payload);
          if (!parsedAsset.success) {
            throw new BridgeError('INVALID_REQUEST', '图片拉取请求参数格式无效');
          }

          const result = await mediaFetcher.fetchMediaAsset(parsedAsset.data);
          return {
            ok: true,
            data: result,
          };
        }

        case 'GET_PENDING_TAB_TASK': {
          const senderTabId = getTrustedContentSenderTabId(sender);
          if (senderTabId === null) {
            throw new BridgeError('FORBIDDEN', '拒绝非授权平台页面的任务查询请求');
          }
          const rawTask = await getPendingTabTask(senderTabId, deps?.sessionStorageArea);
          const task = rawTask && !isFailedUninjectedTask(rawTask) ? rawTask : null;
          return {
            ok: true,
            data: { task },
          };
        }

        case 'CONFIRM_PUBLISHED_URL': {
          const senderTabId = getTrustedContentSenderTabId(sender);
          if (senderTabId === null) {
            throw new BridgeError('FORBIDDEN', '拒绝非授权平台页面的公网链接回传请求');
          }

          const pairing = await getPairing(deps?.storageArea);
          if (!pairing) {
            throw new BridgeError('NOT_PAIRED', '尚未配对 GeoMix 账号，请先打开扩展弹窗完成配对。');
          }

          const payload = rawMessage.payload;
          if (
            !payload ||
            typeof payload.taskId !== 'string' ||
            payload.taskId.trim().length === 0 ||
            typeof payload.publishedUrl !== 'string' ||
            payload.publishedUrl.trim().length === 0 ||
            (payload.publishedAt !== undefined &&
              (typeof payload.publishedAt !== 'string' || payload.publishedAt.trim().length === 0))
          ) {
            throw new BridgeError('INVALID_REQUEST', '公网链接回传参数格式无效');
          }

          const pendingTask = await getPendingTabTask(senderTabId, deps?.sessionStorageArea);
          if (!pendingTask || isFailedUninjectedTask(pendingTask)) {
            throw new BridgeError('NOT_FOUND', '当前标签页没有待回传的分发任务');
          }
          if (pendingTask.taskId !== payload.taskId.trim()) {
            throw new BridgeError('FORBIDDEN', '任务标识与当前标签页绑定记录不匹配');
          }

          // Always derive authoritative provider from session PendingTabTask
          const urlCheck = validatePublishedUrl(pendingTask.provider, payload.publishedUrl);
          if (!urlCheck.ok) {
            throw new BridgeError('INVALID_INPUT', urlCheck.reason);
          }

          const client = createBridgeClient({
            baseUrl: pairing.baseUrl,
            token: pairing.token,
            extensionVersion: resolveExtensionVersion(deps),
            fetchImpl: deps?.fetchImpl,
          });

          const result = await client.confirmPublished(
            pendingTask.taskId,
            {
              publishedUrl: urlCheck.normalizedUrl,
              ...(payload.publishedAt !== undefined
                ? { publishedAt: payload.publishedAt.trim() }
                : {}),
            },
            { provider: pendingTask.provider },
          );

          await removePendingTabTask(senderTabId, deps?.sessionStorageArea);

          return {
            ok: true,
            data: result,
          };
        }
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: serializeBridgeError(error),
      };
    }
  };
}

const PROVIDER_ALLOWED_ORIGINS: Record<ExtensionProviderKey, ReadonlySet<string>> = {
  ZHIHU_EXT: new Set(['https://zhuanlan.zhihu.com', 'https://www.zhihu.com']),
  TOUTIAO_EXT: new Set(['https://mp.toutiao.com', 'https://www.toutiao.com']),
  SMZDM_EXT: new Set(['https://post.smzdm.com']),
};

export function createTabUpdatedHandler(deps?: {
  sessionStorageArea?: ChromeStorageAreaLike;
  tabsApi?: Pick<typeof chrome.tabs, 'sendMessage'>;
}) {
  return async function handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.OnUpdatedInfo,
    tab?: chrome.tabs.Tab,
  ): Promise<void> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
      return;
    }

    const candidateUrl =
      typeof changeInfo.url === 'string' && changeInfo.url.length > 0
        ? changeInfo.url
        : changeInfo.status === 'complete' && typeof tab?.url === 'string' && tab.url.length > 0
          ? tab.url
          : null;

    if (!candidateUrl) {
      return;
    }

    // Read fresh from chrome.storage.session so tab tracking survives MV3 SW restarts
    const pendingTask = await getPendingTabTask(tabId, deps?.sessionStorageArea);
    if (!pendingTask || isFailedUninjectedTask(pendingTask)) {
      return;
    }

    const urlCheck = validatePublishedUrl(pendingTask.provider, candidateUrl);
    let message: BackgroundToContentRequest | null = null;
    if (urlCheck.ok) {
      message = {
        type: 'TAB_URL_CHANGED',
        payload: {
          url: urlCheck.normalizedUrl,
          taskId: pendingTask.taskId,
          provider: pendingTask.provider,
        },
      };
    } else if (isAllowedPlatformSenderUrl(candidateUrl)) {
      const origin = new URL(candidateUrl).origin;
      if (PROVIDER_ALLOWED_ORIGINS[pendingTask.provider].has(origin)) {
        message = {
          type: 'TAB_URL_CHANGED',
          payload: {
            taskId: pendingTask.taskId,
            provider: pendingTask.provider,
          },
        };
      }
    }

    if (!message) {
      return;
    }

    const tabsApi = deps?.tabsApi ?? (typeof chrome !== 'undefined' ? chrome.tabs : undefined);
    if (!tabsApi?.sendMessage) {
      return;
    }

    try {
      await tabsApi.sendMessage(tabId, message);
    } catch {
      // Swallow harmless receiving-end errors during navigation transitions
    }
  };
}

export function createTabRemovedHandler(deps?: { sessionStorageArea?: ChromeStorageAreaLike }) {
  return async function handleTabRemoved(tabId: number): Promise<void> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
      return;
    }
    try {
      await removePendingTabTask(tabId, deps?.sessionStorageArea);
    } catch {
      // Best-effort cleanup when a tab closes
    }
  };
}

export function registerBackgroundListeners(): void {
  if (typeof chrome === 'undefined') {
    return;
  }

  if (chrome.runtime?.onMessage) {
    const handleMessage = createBackgroundMessageHandler();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void handleMessage(message, sender)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: serializeBridgeError(error),
          });
        });
      return true;
    });
  }

  if (chrome.tabs?.onUpdated) {
    const handleTabUpdated = createTabUpdatedHandler();
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      void handleTabUpdated(tabId, changeInfo, tab);
    });
  }

  if (chrome.tabs?.onRemoved) {
    const handleTabRemoved = createTabRemovedHandler();
    chrome.tabs.onRemoved.addListener((tabId) => {
      void handleTabRemoved(tabId);
    });
  }
}

registerBackgroundListeners();
