import type { PublicPairingState } from '../../shared/storage';
import { formatDateTime, formatHostLabel, getExtensionVersion } from '../runtime';
import { BrandIcon } from './BrandIcon';

export type AccountHeaderProps = {
  pairing: PublicPairingState;
  unbinding: boolean;
  onUnbind: () => void;
};

export function AccountHeader({ pairing, unbinding, onUnbind }: AccountHeaderProps) {
  const { me, baseUrl } = pairing;
  const version = getExtensionVersion();
  const tokenSummary = me.tokenLabel ? `${me.tokenLabel} · ${me.tokenPrefix}` : me.tokenPrefix;

  return (
    <header className="gm-card">
      <div className="gm-header-bar">
        <h1 className="gm-brand-title">
          <BrandIcon size={20} />
          <span>GeoMix 渠道草稿助手</span>
          <span className="gm-badge gm-badge-version">v{version}</span>
        </h1>
        <span className="gm-badge gm-badge-safe">仅写草稿箱</span>
      </div>

      <div className="gm-account-meta">
        <div className="gm-account-row">
          <span className="gm-account-name">{me.nickname}</span>
          <button
            type="button"
            className="gm-btn gm-btn-danger-ghost"
            onClick={onUnbind}
            disabled={unbinding}
          >
            {unbinding ? '解绑中...' : '解除绑定'}
          </button>
        </div>

        <div className="gm-account-row">
          <span>凭证：{tokenSummary}</span>
          <span>实例：{formatHostLabel(baseUrl)}</span>
        </div>

        <div className="gm-account-row">
          <span>到期时间：{formatDateTime(me.expiresAt)}</span>
        </div>
      </div>

      <div className="gm-brands-strip" aria-label="已授权 CN 品牌">
        {me.brands.length > 0 ? (
          me.brands.map((brand) => (
            <span key={brand.brandId} className="gm-brand-pill">
              {brand.localBrandName || brand.brandName}
            </span>
          ))
        ) : (
          <span className="gm-helper">暂无已启用 CN 品牌</span>
        )}
      </div>
    </header>
  );
}
