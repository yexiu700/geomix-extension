import { useRef, useState, type FormEvent } from 'react';
import { isValidGmextToken, type PublicPairingState } from '../../shared/storage';
import { normalizeGeoMixBaseUrl } from '../../shared/url-validation';
import {
  callBackground,
  ensureOriginHostPermission,
  formatPairingErrorMessage,
  getExtensionVersion,
} from '../runtime';
import { BrandIcon } from './BrandIcon';

export type PairingViewProps = {
  notice?: { tone: 'info' | 'warn'; message: string } | null;
  onPaired: (pairing: PublicPairingState) => void;
};

export function PairingView({ notice, onPaired }: PairingViewProps) {
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const version = getExtensionVersion();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submittingRef.current || submitting) {
      return;
    }
    setErrorMessage(null);

    const rawUrl = baseUrlInput.trim();
    const rawToken = tokenInput.trim();

    if (!rawUrl) {
      setErrorMessage(
        '请输入有效的 HTTPS 公网 GeoMix 服务地址（如 https://geo.example.com），不支持 HTTP、本地或内网地址。',
      );
      return;
    }

    const urlCheck = normalizeGeoMixBaseUrl(rawUrl);
    if (!urlCheck.ok) {
      setErrorMessage(
        '请输入有效的 HTTPS 公网 GeoMix 服务地址（如 https://geo.example.com），不支持 HTTP、本地或内网地址。',
      );
      return;
    }

    if (!rawToken || !isValidGmextToken(rawToken)) {
      setErrorMessage('配对 Token 格式无效，请粘贴以 gmext_ 开头的专用配对 Token。');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const granted = await ensureOriginHostPermission(urlCheck.originPattern);
      if (!granted) {
        setErrorMessage(
          `未授予 ${urlCheck.origin} 的 HTTPS 访问权限。扩展仅按需请求您填写的 GeoMix 服务域名权限以拉取待发任务与回传文章链接，请点击「验证并配对」并在浏览器弹窗中选择「允许」后重试。`,
        );
        return;
      }

      const response = await callBackground({
        type: 'PAIR_ACCOUNT',
        payload: {
          baseUrl: urlCheck.normalizedUrl,
          token: rawToken,
        },
      });

      if (!response.ok) {
        setErrorMessage(formatPairingErrorMessage(response.error));
        return;
      }

      setTokenInput('');
      onPaired(response.data);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="gm-app">
      <section className="gm-card">
        <div className="gm-header-bar">
          <h1 className="gm-brand-title">
            <BrandIcon size={20} />
            <span>GeoMix 渠道草稿助手</span>
            <span className="gm-badge gm-badge-version">v{version}</span>
          </h1>
          <span className="gm-badge gm-badge-safe">仅写草稿箱</span>
        </div>
        <p className="gm-helper" style={{ marginTop: 6 }}>
          绑定 GeoMix 控制台配对 Token
          后，即可在本地已登录浏览器中一键写入知乎、今日头条、什么值得买草稿箱。
        </p>
      </section>

      {notice ? (
        <div
          role={notice.tone === 'warn' ? 'alert' : 'status'}
          className={`gm-banner ${notice.tone === 'warn' ? 'gm-banner-warn' : 'gm-banner-info'}`}
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      <section className="gm-card">
        <form className="gm-form" onSubmit={handleSubmit} noValidate>
          <div className="gm-field">
            <label htmlFor="geomix-base-url" className="gm-label">
              GeoMix 服务地址
            </label>
            <input
              id="geomix-base-url"
              type="url"
              className="gm-input"
              placeholder="https://geo.example.com"
              autoComplete="url"
              spellCheck={false}
              value={baseUrlInput}
              onChange={(event) => setBaseUrlInput(event.target.value)}
              disabled={submitting}
            />
            <p className="gm-helper">
              仅支持 HTTPS 公网地址（兼容私有部署实例），配对时将按需申请该域名访问权限。
            </p>
          </div>

          <div className="gm-field">
            <label htmlFor="geomix-token" className="gm-label">
              配对 Token（gmext_）
            </label>
            <input
              id="geomix-token"
              type="password"
              className="gm-input"
              placeholder="gmext_..."
              autoComplete="off"
              spellCheck={false}
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              disabled={submitting}
            />
            <p className="gm-helper">
              请在 GeoMix 控制台「品牌管理」或「账号设置」生成最小权限配对
              Token。凭证仅存于扩展本地安全存储。
            </p>
          </div>

          {errorMessage ? (
            <div role="alert" className="gm-banner gm-banner-danger">
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <button type="submit" className="gm-btn gm-btn-primary" disabled={submitting}>
            {submitting ? '正在验证...' : '验证并配对'}
          </button>
        </form>
      </section>
    </main>
  );
}
