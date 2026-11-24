import type {
  ExtensionBrand,
  ExtensionPendingTaskDto,
  ExtensionProviderKey,
} from '../../shared/bridge-contract';
import type { SerializedBridgeError } from '../../shared/messages';
import { PROVIDER_DISPLAY_LABELS } from '../runtime';
import { TaskCard, type DispatchFeedbackState } from './TaskCard';

export type TaskQueueViewProps = {
  brands: ExtensionBrand[];
  tasks: ExtensionPendingTaskDto[];
  selectedBrandId: string;
  selectedProvider: ExtensionProviderKey | '';
  loading: boolean;
  unbinding?: boolean;
  error: SerializedBridgeError | null;
  dispatchFeedback: Record<string, DispatchFeedbackState>;
  onSelectBrand: (brandId: string) => void;
  onSelectProvider: (provider: ExtensionProviderKey | '') => void;
  onRefresh: () => void;
  onReauth: () => void;
  onPushDraft: (task: ExtensionPendingTaskDto) => void;
};

export function TaskQueueView({
  brands,
  tasks,
  selectedBrandId,
  selectedProvider,
  loading,
  unbinding,
  error,
  dispatchFeedback,
  onSelectBrand,
  onSelectProvider,
  onRefresh,
  onReauth,
  onPushDraft,
}: TaskQueueViewProps) {
  const visibleTasks = tasks.filter((task) => {
    if (selectedBrandId && task.brandId !== selectedBrandId) {
      return false;
    }
    if (selectedProvider && task.provider !== selectedProvider) {
      return false;
    }
    return true;
  });

  const isUnauthorized =
    error !== null &&
    (error.reauthRequired || error.kind === 'UNAUTHORIZED' || error.httpStatus === 401);

  return (
    <section className="gm-task-list" aria-label="待发任务队列">
      <div className="gm-card gm-filters">
        <div className="gm-field">
          <label htmlFor="filter-brand" className="gm-label">
            品牌
          </label>
          <select
            id="filter-brand"
            aria-label="筛选品牌"
            className="gm-select"
            value={selectedBrandId}
            onChange={(event) => onSelectBrand(event.target.value)}
          >
            <option value="">全部品牌</option>
            {brands.map((brand) => {
              const label =
                brand.localBrandName && brand.localBrandName !== brand.brandName
                  ? `${brand.localBrandName} (${brand.brandName})`
                  : brand.localBrandName || brand.brandName;
              return (
                <option key={brand.brandId} value={brand.brandId}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>

        <div className="gm-field">
          <label htmlFor="filter-platform" className="gm-label">
            平台
          </label>
          <select
            id="filter-platform"
            aria-label="筛选平台"
            className="gm-select"
            value={selectedProvider}
            onChange={(event) => onSelectProvider(event.target.value as ExtensionProviderKey | '')}
          >
            <option value="">全部平台</option>
            <option value="ZHIHU_EXT">{PROVIDER_DISPLAY_LABELS.ZHIHU_EXT}</option>
            <option value="TOUTIAO_EXT">{PROVIDER_DISPLAY_LABELS.TOUTIAO_EXT}</option>
            <option value="SMZDM_EXT">{PROVIDER_DISPLAY_LABELS.SMZDM_EXT}</option>
          </select>
        </div>

        <button
          type="button"
          className="gm-btn gm-btn-secondary gm-btn-sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? '刷新中...' : '刷新队列'}
        </button>
      </div>

      {isUnauthorized ? (
        <div role="alert" className="gm-banner gm-banner-danger">
          <span>配对 Token 已失效或已被吊销（401），无法拉取任务队列。请重新配对后继续使用。</span>
          <div className="gm-banner-actions">
            <button
              type="button"
              className="gm-btn gm-btn-primary gm-btn-sm"
              onClick={onReauth}
              disabled={Boolean(unbinding)}
            >
              重新配对
            </button>
          </div>
        </div>
      ) : error ? (
        <div role="alert" className="gm-banner gm-banner-danger">
          <span>{error.message}</span>
          <div className="gm-banner-actions">
            <button
              type="button"
              className="gm-btn gm-btn-secondary gm-btn-sm"
              onClick={onRefresh}
              disabled={loading}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}

      {loading && visibleTasks.length === 0 ? (
        <div role="status" aria-live="polite" className="gm-card gm-empty">
          <span>正在加载待发任务队列...</span>
        </div>
      ) : !loading && !error && visibleTasks.length === 0 ? (
        <div className="gm-card gm-empty">
          <p className="gm-empty-title">当前筛选条件下暂无待发任务</p>
          <p className="gm-helper">请先在 GeoMix 控制台生成 L2 渠道变体，或切换品牌/平台筛选。</p>
          <button type="button" className="gm-btn gm-btn-secondary gm-btn-sm" onClick={onRefresh}>
            刷新队列
          </button>
        </div>
      ) : (
        visibleTasks.map((task) => (
          <TaskCard
            key={task.taskId}
            task={task}
            feedback={dispatchFeedback[task.taskId]}
            onPushDraft={onPushDraft}
          />
        ))
      )}
    </section>
  );
}
