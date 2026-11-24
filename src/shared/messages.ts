import type {
  DraftInjectReport,
  DraftInjectStage,
  ExtensionConfirmPublishedResult,
  ExtensionPendingTaskDto,
  ExtensionProviderKey,
  ExtensionTasksQuery,
} from './bridge-contract';
import { redactSensitiveText, type PendingTabTask, type PublicPairingState } from './storage';

export type BridgeErrorKind =
  | 'INVALID_BASE_URL'
  | 'INVALID_TOKEN'
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'SCHEMA_VALIDATION'
  | 'NOT_PAIRED'
  | 'INVALID_REQUEST'
  | 'NOT_IMPLEMENTED'
  | 'TAB_DISPATCH_ERROR';

export type SerializedBridgeError = {
  kind: BridgeErrorKind;
  message: string;
  httpStatus?: number;
  apiCode?: number;
  reauthRequired: boolean;
};

export type MessageResponse<T> =
  { ok: true; data: T } | { ok: false; error: SerializedBridgeError };

export type PairingStatusData = { paired: false } | ({ paired: true } & PublicPairingState);

export type PushDraftTaskResponseData = {
  taskId: string;
  accepted: boolean;
  stage: DraftInjectStage | 'NOT_IMPLEMENTED';
  tabId?: number;
  draftUrl?: string;
  message: string;
  stub?: boolean;
  report?: DraftInjectReport;
};

export type MediaFetchErrorCode =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'REDIRECT_LIMIT'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_MIME'
  | 'HTTP_ERROR'
  | 'EMPTY_BODY'
  | 'NETWORK_ERROR';

export type FetchMediaAssetSuccess = {
  ok: true;
  url: string;
  alt: string;
  base64: string;
  mime: string;
  filename: string;
  byteLength: number;
};

export type FetchMediaAssetFailure = {
  ok: false;
  url: string;
  alt: string;
  reason: string;
  code: MediaFetchErrorCode;
};

export type FetchMediaAssetResult = FetchMediaAssetSuccess | FetchMediaAssetFailure;

export type GetPendingTabTaskResponseData = {
  task: PendingTabTask | null;
};

// Plane 1: Popup -> Background Service Worker
export type UnbindAccountMessage = {
  type: 'UNBIND_ACCOUNT';
  preservePendingTabTasks?: boolean;
};

export type PopupRuntimeRequest =
  | { type: 'PAIR_ACCOUNT'; payload: { baseUrl: string; token: string } }
  | { type: 'GET_PAIRING_STATUS' }
  | UnbindAccountMessage
  | { type: 'FETCH_PENDING_TASKS'; payload?: ExtensionTasksQuery }
  | { type: 'PUSH_DRAFT_TASK'; payload: { task: ExtensionPendingTaskDto } };

// Plane 2: Content Script -> Background Service Worker
export type ContentToBackgroundRequest =
  | { type: 'FETCH_MEDIA_ASSET'; payload: { url: string; alt: string; mime?: string } }
  | { type: 'GET_PENDING_TAB_TASK' }
  | {
      type: 'CONFIRM_PUBLISHED_URL';
      payload: {
        taskId: string;
        publishedUrl: string;
        publishedAt?: string;
      };
    };

export type ExtensionRuntimeRequest = PopupRuntimeRequest | ContentToBackgroundRequest;

export type ExtensionResponseDataMap = {
  PAIR_ACCOUNT: PublicPairingState;
  GET_PAIRING_STATUS: PairingStatusData;
  UNBIND_ACCOUNT: { unbound: true };
  FETCH_PENDING_TASKS: { tasks: ExtensionPendingTaskDto[] };
  PUSH_DRAFT_TASK: PushDraftTaskResponseData;
  FETCH_MEDIA_ASSET: FetchMediaAssetResult;
  GET_PENDING_TAB_TASK: GetPendingTabTaskResponseData;
  CONFIRM_PUBLISHED_URL: ExtensionConfirmPublishedResult;
};

// Plane 3: Background Service Worker -> Content Script (via chrome.tabs.sendMessage)
export type ContentPingRequest = { type: 'PING_CONTENT' };
export type ContentPingResponseData = { ready: true; href: string };

export type InjectDraftRequest = {
  type: 'INJECT_DRAFT';
  payload: {
    task: ExtensionPendingTaskDto;
  };
};

export type TabUrlChangedRequest = {
  type: 'TAB_URL_CHANGED';
  payload?: {
    url?: string;
    taskId?: string;
    provider?: ExtensionProviderKey;
  };
};

export type TabUrlChangedResponseData = {
  checked: true;
  matched: boolean;
  publishedUrl?: string;
};

export type BackgroundToContentRequest =
  ContentPingRequest | InjectDraftRequest | TabUrlChangedRequest;

export type BackgroundToContentResponseDataMap = {
  PING_CONTENT: ContentPingResponseData;
  INJECT_DRAFT: DraftInjectReport;
  TAB_URL_CHANGED: TabUrlChangedResponseData;
};

const POPUP_RUNTIME_MESSAGE_TYPES = new Set<PopupRuntimeRequest['type']>([
  'PAIR_ACCOUNT',
  'GET_PAIRING_STATUS',
  'UNBIND_ACCOUNT',
  'FETCH_PENDING_TASKS',
  'PUSH_DRAFT_TASK',
]);

const CONTENT_TO_BACKGROUND_MESSAGE_TYPES = new Set<ContentToBackgroundRequest['type']>([
  'FETCH_MEDIA_ASSET',
  'GET_PENDING_TAB_TASK',
  'CONFIRM_PUBLISHED_URL',
]);

const BACKGROUND_TO_CONTENT_MESSAGE_TYPES = new Set<BackgroundToContentRequest['type']>([
  'PING_CONTENT',
  'INJECT_DRAFT',
  'TAB_URL_CHANGED',
]);

function extractMessageType(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (!Object.hasOwn(value, 'type')) {
    return null;
  }
  const candidate = value as { type?: unknown };
  return typeof candidate.type === 'string' ? candidate.type : null;
}

export function isPopupRuntimeRequest(value: unknown): value is PopupRuntimeRequest {
  const type = extractMessageType(value);
  return type !== null && POPUP_RUNTIME_MESSAGE_TYPES.has(type as PopupRuntimeRequest['type']);
}

export function isContentToBackgroundRequest(value: unknown): value is ContentToBackgroundRequest {
  const type = extractMessageType(value);
  return (
    type !== null &&
    CONTENT_TO_BACKGROUND_MESSAGE_TYPES.has(type as ContentToBackgroundRequest['type'])
  );
}

export function isExtensionRuntimeRequest(value: unknown): value is ExtensionRuntimeRequest {
  return isPopupRuntimeRequest(value) || isContentToBackgroundRequest(value);
}

export function isBackgroundToContentRequest(value: unknown): value is BackgroundToContentRequest {
  const type = extractMessageType(value);
  return (
    type !== null &&
    BACKGROUND_TO_CONTENT_MESSAGE_TYPES.has(type as BackgroundToContentRequest['type'])
  );
}

export async function sendRuntimeMessage<TReq extends ExtensionRuntimeRequest>(
  request: TReq,
): Promise<MessageResponse<ExtensionResponseDataMap[TReq['type']]>> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as
      MessageResponse<ExtensionResponseDataMap[TReq['type']]> | undefined;

    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      return {
        ok: false,
        error: {
          kind: 'INVALID_RESPONSE',
          message: '扩展后台服务未返回有效响应，请重试。',
          reauthRequired: false,
        },
      };
    }

    return response;
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : '与扩展后台通信失败，请稍后重试。';
    return {
      ok: false,
      error: {
        kind: 'NETWORK_ERROR',
        message: redactSensitiveText(rawMessage),
        reauthRequired: false,
      },
    };
  }
}

export async function sendTabMessage<TReq extends BackgroundToContentRequest>(
  tabId: number,
  request: TReq,
  tabsApi?: Pick<typeof chrome.tabs, 'sendMessage'>,
): Promise<MessageResponse<BackgroundToContentResponseDataMap[TReq['type']]>> {
  const api = tabsApi ?? (typeof chrome !== 'undefined' ? chrome.tabs : undefined);
  if (!api?.sendMessage) {
    return {
      ok: false,
      error: {
        kind: 'TAB_DISPATCH_ERROR',
        message: '扩展标签页通信接口不可用。',
        reauthRequired: false,
      },
    };
  }

  try {
    const response = (await api.sendMessage(tabId, request)) as
      MessageResponse<BackgroundToContentResponseDataMap[TReq['type']]> | undefined;

    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      return {
        ok: false,
        error: {
          kind: 'INVALID_RESPONSE',
          message: '目标标签页未返回有效响应。',
          reauthRequired: false,
        },
      };
    }

    return response;
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : '向目标标签页发送消息失败。';
    return {
      ok: false,
      error: {
        kind: 'TAB_DISPATCH_ERROR',
        message: redactSensitiveText(rawMessage),
        reauthRequired: false,
      },
    };
  }
}
