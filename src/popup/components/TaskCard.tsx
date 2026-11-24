import type { ExtensionPendingTaskDto } from '../../shared/bridge-contract';
import type { PushDraftTaskResponseData, SerializedBridgeError } from '../../shared/messages';
import { redactSensitiveText } from '../../shared/storage';
import {
  formatDateTime,
  formatSafeUrlHintPreview,
  PROVIDER_DISPLAY_LABELS,
  TASK_STATUS_LABELS,
} from '../runtime';

export type DispatchFeedbackState =
  | { status: 'dispatching' }
  | { status: 'done'; result: PushDraftTaskResponseData }
  | { status: 'error'; error: SerializedBridgeError };

export type TaskCardProps = {
  task: ExtensionPendingTaskDto;
  feedback?: DispatchFeedbackState;
  onPushDraft: (task: ExtensionPendingTaskDto) => void;
};

function renderDispatchFeedback(feedback: DispatchFeedbackState | undefined) {
  if (!feedback) {
    return null;
  }

  if (feedback.status === 'dispatching') {
    return (
      <div role="status" aria-live="polite" className="gm-banner gm-banner-info">
        <span>正在调度草稿写入任务...</span>
      </div>
    );
  }

  if (feedback.status === 'error') {
    return (
      <div role="alert" className="gm-banner gm-banner-danger">
        <span>{feedback.error.message}</span>
      </div>
    );
  }

  const { result } = feedback;
  if (result.stage === 'NOT_IMPLEMENTED' || (result.stub && !result.report)) {
    return (
      <div role="status" aria-live="polite" className="gm-banner gm-banner-info">
        <span>{result.message}</span>
      </div>
    );
  }

  const report = result.report;
  const stage = report?.stage ?? result.stage;
  const message = report?.message ?? result.message;

  if (stage === 'INJECTED') {
    return (
      <div role="status" aria-live="polite" className="gm-banner gm-banner-success">
        <span>{message}</span>
        {report ? (
          <span>已转存 {report.uploadedImages} 张配图，请在编辑页人工审阅后手动操作。</span>
        ) : null}
        {report?.operatorReminders && report.operatorReminders.length > 0 ? (
          <ul className="gm-feedback-list">
            {report.operatorReminders.map((reminder, index) => (
              <li key={index}>{reminder}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (stage === 'PARTIAL_MEDIA_FAILED') {
    return (
      <div role="alert" className="gm-banner gm-banner-warn">
        <span>
          {message}
          {report
            ? `（成功 ${report.uploadedImages} 张，失败 ${report.failedImages} 张，请人工补传以下配图）`
            : ''}
        </span>
        {report?.failedImageDetails && report.failedImageDetails.length > 0 ? (
          <ul className="gm-feedback-list">
            {report.failedImageDetails.map((item, index) => (
              <li key={`${item.url}-${index}`}>
                {item.alt || (formatSafeUrlHintPreview(item.url) ?? redactSensitiveText(item.url))}
                ：{redactSensitiveText(item.reason)}
              </li>
            ))}
          </ul>
        ) : null}
        {report?.operatorReminders && report.operatorReminders.length > 0 ? (
          <ul className="gm-feedback-list">
            {report.operatorReminders.map((reminder, index) => (
              <li key={`reminder-${index}`}>{reminder}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (stage === 'AUTH_REQUIRED') {
    return (
      <div role="alert" className="gm-banner gm-banner-warn">
        <span>
          {message || '检测到目标平台尚未登录，请先在当前浏览器登录对应账号后重试写入草稿箱。'}
        </span>
      </div>
    );
  }

  return (
    <div role="alert" className="gm-banner gm-banner-danger">
      <span>{message || '未在目标页面定位到草稿编辑器，请确认页面加载完成后重试。'}</span>
    </div>
  );
}

export function TaskCard({ task, feedback, onPushDraft }: TaskCardProps) {
  const isDispatching = feedback?.status === 'dispatching';
  const safeTargetPreview = task.targetUrlHint
    ? formatSafeUrlHintPreview(task.targetUrlHint)
    : null;

  return (
    <article className="gm-card gm-task-card" data-testid={`task-card-${task.taskId}`}>
      <div className="gm-task-meta-top">
        <div className="gm-task-channel">
          <span className="gm-badge gm-badge-platform">
            {PROVIDER_DISPLAY_LABELS[task.provider]}
          </span>
          <span>{task.channelLabel}</span>
        </div>
        <span className="gm-badge gm-badge-status">{TASK_STATUS_LABELS[task.status]}</span>
      </div>

      <h3 className="gm-task-title">{task.variantTitle}</h3>

      <div className="gm-task-submeta">
        <span>品牌：{task.brandName}</span>
        <span>配图 {task.mediaAssets.length} 张</span>
        <span>更新于 {formatDateTime(task.updatedAt)}</span>
      </div>

      {safeTargetPreview ? (
        <div className="gm-target-hint">目标问题页：{safeTargetPreview}</div>
      ) : null}

      {task.complianceChecklist.length > 0 ? (
        <div className="gm-checklist" data-testid="compliance-checklist">
          <p className="gm-checklist-title">防封提示清单</p>
          <ul className="gm-checklist-list">
            {task.complianceChecklist.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        type="button"
        className="gm-btn gm-btn-primary"
        onClick={() => onPushDraft(task)}
        disabled={isDispatching}
      >
        {isDispatching ? '写入草稿箱中...' : '写入草稿箱'}
      </button>

      {renderDispatchFeedback(feedback)}
    </article>
  );
}
