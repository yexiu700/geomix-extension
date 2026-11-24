import type { ExtensionProviderKey, ExtensionTaskStatus } from '../shared/bridge-contract';
import {
  sendRuntimeMessage,
  type ExtensionResponseDataMap,
  type ExtensionRuntimeRequest,
  type MessageResponse,
  type SerializedBridgeError,
} from '../shared/messages';
import { redactSensitiveText } from '../shared/storage';

export const PROVIDER_DISPLAY_LABELS: Record<ExtensionProviderKey, string> = {
  ZHIHU_EXT: '知乎',
  TOUTIAO_EXT: '今日头条',
  SMZDM_EXT: '什么值得买',
};

export const TASK_STATUS_LABELS: Record<ExtensionTaskStatus, string> = {
  DRAFT_VARIANT: '待写变体',
  READY_TO_PUBLISH: '待推草稿',
  DRAFT_PUSHED: '已推草稿',
  PUBLISHED: '已发布',
};

export function getExtensionVersion(): string {
  try {
    const version = chrome.runtime.getManifest?.().version;
    return version && version.trim().length > 0 ? version.trim() : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export function callBackground<TReq extends ExtensionRuntimeRequest>(
  request: TReq,
): Promise<MessageResponse<ExtensionResponseDataMap[TReq['type']]>> {
  return sendRuntimeMessage(request);
}

export async function ensureOriginHostPermission(originPattern: string): Promise<boolean> {
  try {
    const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
    if (alreadyGranted) {
      return true;
    }
    return await chrome.permissions.request({ origins: [originPattern] });
  } catch {
    return false;
  }
}

export function formatDateTime(raw: string): string {
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    return raw;
  }
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function formatSafeUrlHintPreview(rawHint: string): string | null {
  try {
    const parsed = new URL(rawHint);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return redactSensitiveText(`${parsed.host}${parsed.pathname}`);
  } catch {
    return null;
  }
}

export function formatPairingErrorMessage(error: SerializedBridgeError): string {
  if (error.kind === 'UNAUTHORIZED' || error.httpStatus === 401) {
    return '配对 Token 无效、已过期或已被吊销（401）。请前往 GeoMix 控制台重新生成新的 gmext_ Token 后再试。';
  }
  if (error.kind === 'FORBIDDEN' || error.httpStatus === 403) {
    return '当前账号或租户暂不可用（403），请检查 GeoMix 控制台权限状态。';
  }
  if (error.kind === 'RATE_LIMITED' || error.httpStatus === 429) {
    return '校验请求过于频繁（429），请稍后再试。';
  }
  if (error.kind === 'NETWORK_ERROR' || error.kind === 'TIMEOUT' || error.kind === 'SERVER_ERROR') {
    return '无法连接到 GeoMix 服务，请检查服务地址、网络状态或稍后重试。';
  }
  return redactSensitiveText(error.message || '配对验证失败，请稍后重试。');
}
