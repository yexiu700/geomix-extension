import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExtensionConfirmPublishedResult,
  ExtensionProviderKey,
  FailedImageDetail,
} from '../shared/bridge-contract';
import type { BridgeErrorKind, MessageResponse, SerializedBridgeError } from '../shared/messages';
import { redactSensitiveText, type PendingTabTask } from '../shared/storage';

export const CAPTURE_BAR_HOST_ID = 'geomix-extension-capture-host' as const;

const PROVIDER_BADGE_LABELS: Record<ExtensionProviderKey, string> = {
  ZHIHU_EXT: '知乎',
  TOUTIAO_EXT: '今日头条',
  SMZDM_EXT: '什么值得买',
};

const SHADOW_DOM_STYLES = `
:host {
  all: initial;
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #0f172a;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.gm-bar {
  width: 380px;
  max-width: calc(100vw - 32px);
  background: #ffffff;
  color: #0f172a;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.gm-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.gm-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.gm-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
  white-space: nowrap;
}

.gm-close-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 18px;
  line-height: 1;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gm-close-btn:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.gm-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gm-task-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  word-break: break-word;
}

.gm-brand-label {
  margin: 0;
  font-size: 12px;
  color: #475569;
}

.gm-url-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #1e293b;
  word-break: break-all;
}

.gm-banner {
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gm-banner-success {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
}

.gm-banner-warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}

.gm-banner-danger {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.gm-list {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gm-list-item {
  word-break: break-word;
}

.gm-url-preview {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: #475569;
  word-break: break-all;
}

.gm-footer-note {
  margin: 0;
  font-size: 12px;
  color: #475569;
}

.gm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gm-btn {
  appearance: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  padding: 9px 12px;
  cursor: pointer;
  width: 100%;
  border: 1px solid transparent;
  transition: background-color 0.15s ease;
}

.gm-btn-primary {
  background: #2563eb;
  color: #ffffff;
}

.gm-btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.gm-btn-primary:disabled {
  background: #93c5fd;
  cursor: not-allowed;
}

.gm-btn-secondary {
  background: #f1f5f9;
  color: #0f172a;
  border-color: #cbd5e1;
}

.gm-btn-secondary:hover {
  background: #e2e8f0;
}
`;

export type CaptureBarHandle = {
  host: HTMLDivElement;
  shadowRoot: ShadowRoot;
  unmount: () => void;
};

export type PublishedUrlCaptureBarProps = {
  task: PendingTabTask;
  publishedUrl: string;
  onConfirmPublished: (input: {
    taskId: string;
    publishedUrl: string;
  }) => Promise<MessageResponse<ExtensionConfirmPublishedResult>>;
  onConfirmed?: (result: ExtensionConfirmPublishedResult) => void;
  onDismiss?: () => void;
  doc?: Document;
};

export type OperatorNoticeBarProps = {
  provider: ExtensionProviderKey;
  variantTitle: string;
  uploadedImages: number;
  failedImages: number;
  failedImageDetails?: FailedImageDetail[];
  operatorReminders?: string[];
  message: string;
  onDismiss?: () => void;
  doc?: Document;
};

type ActiveBarRecord = {
  root: Root;
  host: HTMLDivElement;
  mode: 'capture' | 'notice';
};

const activeHandles = new WeakMap<Document, ActiveBarRecord>();

function formatSafeUrlPreview(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const cleaned = redactSensitiveText(`${parsed.origin}${parsed.pathname}`);
    return cleaned.length > 96 ? `${cleaned.slice(0, 93)}...` : cleaned;
  } catch {
    const redacted = redactSensitiveText(rawUrl);
    return redacted.length > 96 ? `${redacted.slice(0, 93)}...` : redacted;
  }
}

const VALID_BRIDGE_ERROR_KINDS: ReadonlySet<BridgeErrorKind> = new Set<BridgeErrorKind>([
  'INVALID_BASE_URL',
  'INVALID_TOKEN',
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BAD_REQUEST',
  'NOT_FOUND',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'API_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'SCHEMA_VALIDATION',
  'NOT_PAIRED',
  'INVALID_REQUEST',
  'NOT_IMPLEMENTED',
  'TAB_DISPATCH_ERROR',
]);

function normalizeThrownConfirmError(error: unknown): SerializedBridgeError {
  const fallbackMessage = '回传失败，请检查网络后重试。';
  const record =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const rawMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : typeof record?.message === 'string' && record.message.trim().length > 0
        ? record.message
        : fallbackMessage;

  const rawKind = typeof record?.kind === 'string' ? record.kind : '';
  const kind: BridgeErrorKind = VALID_BRIDGE_ERROR_KINDS.has(rawKind as BridgeErrorKind)
    ? (rawKind as BridgeErrorKind)
    : 'NETWORK_ERROR';

  const httpStatus =
    typeof record?.httpStatus === 'number' && Number.isFinite(record.httpStatus)
      ? record.httpStatus
      : typeof record?.status === 'number' && Number.isFinite(record.status)
        ? record.status
        : undefined;

  const apiCode =
    typeof record?.apiCode === 'number' && Number.isFinite(record.apiCode)
      ? record.apiCode
      : undefined;

  const reauthRequired =
    typeof record?.reauthRequired === 'boolean'
      ? record.reauthRequired
      : kind === 'UNAUTHORIZED' || kind === 'NOT_PAIRED' || httpStatus === 401;

  return {
    kind,
    message: redactSensitiveText(rawMessage),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(apiCode !== undefined ? { apiCode } : {}),
    reauthRequired,
  };
}

function PublishedUrlCaptureCard({
  task,
  publishedUrl,
  onConfirmPublished,
  onConfirmed,
  onClose,
}: {
  task: PendingTabTask;
  publishedUrl: string;
  onConfirmPublished: PublishedUrlCaptureBarProps['onConfirmPublished'];
  onConfirmed?: (result: ExtensionConfirmPublishedResult) => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [confirmedResult, setConfirmedResult] = useState<ExtensionConfirmPublishedResult | null>(
    null,
  );
  const [errorState, setErrorState] = useState<SerializedBridgeError | null>(null);
  const submittingRef = useRef(false);
  const confirmedRef = useRef(false);

  async function handleConfirm(): Promise<void> {
    if (submittingRef.current || confirmedRef.current || submitting || confirmedResult !== null) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setErrorState(null);

    try {
      const response = await onConfirmPublished({
        taskId: task.taskId,
        publishedUrl,
      });

      if (!response.ok) {
        setErrorState({
          ...response.error,
          message: redactSensitiveText(response.error.message || '回传失败，请检查网络后重试。'),
        });
        return;
      }

      confirmedRef.current = true;
      setConfirmedResult(response.data);
      onConfirmed?.(response.data);
    } catch (error: unknown) {
      setErrorState(normalizeThrownConfirmError(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const isReauthError =
    errorState !== null &&
    (errorState.reauthRequired ||
      errorState.kind === 'UNAUTHORIZED' ||
      errorState.kind === 'NOT_PAIRED' ||
      errorState.httpStatus === 401);

  return (
    <section className="gm-bar" aria-label="GeoMix 公网链接回传浮条">
      <div className="gm-header">
        <div className="gm-title-group">
          <h2 className="gm-title">GeoMix 回传追踪</h2>
          <span className="gm-badge">{PROVIDER_BADGE_LABELS[task.provider]}</span>
        </div>
        <button type="button" className="gm-close-btn" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="gm-meta">
        <p className="gm-task-title">{task.variantTitle}</p>
        <p className="gm-brand-label">关联品牌：{task.brandName}</p>
      </div>

      <div className="gm-url-box" data-testid="geomix-captured-url">
        {publishedUrl}
      </div>

      {confirmedResult ? (
        <>
          <div role="status" aria-live="polite" className="gm-banner gm-banner-success">
            <strong>已成功回传至 GeoMix！</strong>
            <span>回传记录 ID：{confirmedResult.publishRecordId}</span>
            <span>
              {confirmedResult.crawlProbeQueued ? 'T+1 抓取探针已排队' : 'T+1 抓取探针待调度'}
            </span>
            <span>
              {confirmedResult.retestMilestones.map((day) => `T+${day}`).join(' / ')} 复测已预约
            </span>
          </div>
          <div className="gm-actions">
            <button type="button" className="gm-btn gm-btn-secondary" onClick={onClose}>
              完成并关闭
            </button>
          </div>
        </>
      ) : (
        <>
          {errorState ? (
            <div
              role="alert"
              className={`gm-banner ${isReauthError ? 'gm-banner-warn' : 'gm-banner-danger'}`}
            >
              <span>
                {isReauthError
                  ? '配对 Token 已失效或已被吊销（401），请点击浏览器右上角 GeoMix 扩展图标重新配对后，再点击下方按钮重试回传。'
                  : errorState.message}
              </span>
            </div>
          ) : null}

          <div className="gm-actions">
            <button
              type="button"
              className="gm-btn gm-btn-primary"
              disabled={submitting}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {submitting ? '正在回传至 GeoMix...' : '一键回传至 GeoMix 开启 T+7/14/30 追踪'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function OperatorNoticeCard({
  provider,
  variantTitle,
  uploadedImages,
  failedImages,
  failedImageDetails,
  operatorReminders,
  message,
  onClose,
}: {
  provider: ExtensionProviderKey;
  variantTitle: string;
  uploadedImages: number;
  failedImages: number;
  failedImageDetails?: FailedImageDetail[];
  operatorReminders?: string[];
  message: string;
  onClose: () => void;
}) {
  return (
    <section className="gm-bar" aria-label="GeoMix 草稿写入提醒浮条">
      <div className="gm-header">
        <div className="gm-title-group">
          <h2 className="gm-title">GeoMix 草稿写入提醒</h2>
          <span className="gm-badge">{PROVIDER_BADGE_LABELS[provider]}</span>
        </div>
        <button type="button" className="gm-close-btn" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="gm-meta">
        <p className="gm-task-title">{variantTitle}</p>
        <p className="gm-brand-label">{redactSensitiveText(message)}</p>
      </div>

      {failedImages > 0 ? (
        <div role="alert" className="gm-banner gm-banner-warn">
          <strong>
            已自动转存 {uploadedImages} 张配图，有 {failedImages}{' '}
            张配图上传失败，请手动补传以下图片：
          </strong>
          {failedImageDetails && failedImageDetails.length > 0 ? (
            <ul className="gm-list" data-testid="geomix-failed-images-list">
              {failedImageDetails.map((item, index) => (
                <li key={`${item.url}-${index}`} className="gm-list-item">
                  <span>
                    {item.alt || '未命名配图'}：{redactSensitiveText(item.reason)}
                  </span>
                  <span className="gm-url-preview">{formatSafeUrlPreview(item.url)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span>请检查原稿配图并在编辑器中手动上传缺失图片。</span>
          )}
        </div>
      ) : null}

      {operatorReminders && operatorReminders.length > 0 ? (
        <div role="status" aria-live="polite" className="gm-banner gm-banner-warn">
          <strong>人工核对提醒：</strong>
          <ul className="gm-list" data-testid="geomix-operator-reminders-list">
            {operatorReminders.map((reminder, index) => (
              <li key={index} className="gm-list-item">
                {redactSensitiveText(reminder)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="gm-footer-note">内容已写入草稿态，请人工审阅排版与合规项后手动操作。</p>

      <div className="gm-actions">
        <button type="button" className="gm-btn gm-btn-secondary" onClick={onClose}>
          我知道了
        </button>
      </div>
    </section>
  );
}

export function getActiveCaptureBarHost(doc: Document = document): HTMLDivElement | null {
  const existing = activeHandles.get(doc);
  if (existing && existing.host.isConnected) {
    return existing.host;
  }
  const byId = doc.getElementById(CAPTURE_BAR_HOST_ID);
  return byId instanceof HTMLDivElement ? byId : null;
}

export function unmountCaptureBar(doc: Document = document): void {
  const active = activeHandles.get(doc);
  if (active) {
    activeHandles.delete(doc);
    try {
      active.root.unmount();
    } catch {
      // Ignore unmount errors during page teardown
    }
    active.host.remove();
  }

  const orphan = doc.getElementById(CAPTURE_BAR_HOST_ID);
  if (orphan) {
    orphan.remove();
  }
}

export function getActiveCaptureBarMode(doc: Document = document): 'capture' | 'notice' | null {
  const active = activeHandles.get(doc);
  if (!active || !active.host.isConnected) {
    return null;
  }
  return active.mode;
}

function createShadowHost(
  doc: Document,
  mode: 'capture' | 'notice',
): {
  host: HTMLDivElement;
  shadowRoot: ShadowRoot;
  root: Root;
} {
  unmountCaptureBar(doc);

  const host = doc.createElement('div');
  host.id = CAPTURE_BAR_HOST_ID;
  host.setAttribute('data-geomix-extension', 'capture-bar');
  host.setAttribute('data-geomix-mode', mode);

  const container = doc.documentElement ?? doc.body;
  container.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const styleEl = doc.createElement('style');
  styleEl.textContent = SHADOW_DOM_STYLES.trim();
  shadowRoot.appendChild(styleEl);

  const mountPoint = doc.createElement('div');
  mountPoint.className = 'gm-shadow-mount';
  shadowRoot.appendChild(mountPoint);

  const root = createRoot(mountPoint);
  activeHandles.set(doc, { root, host, mode });

  return { host, shadowRoot, root };
}

export function mountUrlCaptureBar(props: PublishedUrlCaptureBarProps): CaptureBarHandle {
  const targetDoc = props.doc ?? document;
  const { host, shadowRoot, root } = createShadowHost(targetDoc, 'capture');

  const handleClose = () => {
    if (activeHandles.get(targetDoc)?.host === host) {
      unmountCaptureBar(targetDoc);
    }
    props.onDismiss?.();
  };

  flushSync(() => {
    root.render(
      <PublishedUrlCaptureCard
        task={props.task}
        publishedUrl={props.publishedUrl}
        onConfirmPublished={props.onConfirmPublished}
        onConfirmed={props.onConfirmed}
        onClose={handleClose}
      />,
    );
  });

  return {
    host,
    shadowRoot,
    unmount: () => {
      if (activeHandles.get(targetDoc)?.host === host) {
        unmountCaptureBar(targetDoc);
      }
    },
  };
}

export function mountOperatorNoticeBar(props: OperatorNoticeBarProps): CaptureBarHandle {
  const targetDoc = props.doc ?? document;
  const { host, shadowRoot, root } = createShadowHost(targetDoc, 'notice');

  const handleClose = () => {
    if (activeHandles.get(targetDoc)?.host === host) {
      unmountCaptureBar(targetDoc);
    }
    props.onDismiss?.();
  };

  flushSync(() => {
    root.render(
      <OperatorNoticeCard
        provider={props.provider}
        variantTitle={props.variantTitle}
        uploadedImages={props.uploadedImages}
        failedImages={props.failedImages}
        failedImageDetails={props.failedImageDetails}
        operatorReminders={props.operatorReminders}
        message={props.message}
        onClose={handleClose}
      />,
    );
  });

  return {
    host,
    shadowRoot,
    unmount: () => {
      if (activeHandles.get(targetDoc)?.host === host) {
        unmountCaptureBar(targetDoc);
      }
    },
  };
}
