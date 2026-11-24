export const ALLOWED_PERMISSIONS = ['storage', 'tabs', 'activeTab', 'scripting'] as const;

export const PLATFORM_HOST_PERMISSIONS = [
  'https://zhuanlan.zhihu.com/*',
  'https://www.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://www.toutiao.com/*',
  'https://post.smzdm.com/*',
] as const;

export const OPTIONAL_HOST_PERMISSIONS = ['https://*/*'] as const;

export const EXTENSION_ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
} as const;

export function buildManifest(version: string): chrome.runtime.ManifestV3 {
  const normalizedVersion = version.trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(normalizedVersion)) {
    throw new Error(`Invalid extension manifest version: "${version}"`);
  }

  return {
    manifest_version: 3,
    name: 'GeoMix 渠道草稿助手',
    short_name: 'GeoMix',
    version: normalizedVersion,
    description:
      '将 GeoMix L2 渠道变体在本地已登录浏览器中一键写入知乎、今日头条、什么值得买草稿箱，并在人工发布后回传公网 URL。',
    icons: { ...EXTENSION_ICONS },
    permissions: [...ALLOWED_PERMISSIONS],
    host_permissions: [...PLATFORM_HOST_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    action: {
      default_title: 'GeoMix 渠道草稿助手',
      default_popup: 'popup/index.html',
      default_icon: { ...EXTENSION_ICONS },
    },
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    content_scripts: [
      {
        matches: [...PLATFORM_HOST_PERMISSIONS],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
  };
}
