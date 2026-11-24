/**
 * Spec-derived TypeScript contracts matching PROJECT.md § Interface Contracts verbatim.
 * Zero static imports from src/** — preserves strict opaque-box decoupling across M1–M7.
 */

export type ExtensionProviderKey = 'ZHIHU_EXT' | 'TOUTIAO_EXT' | 'SMZDM_EXT';

export type ExtensionTaskStatus =
  | 'DRAFT_VARIANT'
  | 'READY_TO_PUBLISH'
  | 'DRAFT_PUSHED'
  | 'PUBLISHED';

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ExtensionBrandDto {
  brandId: string;
  brandName: string;
  brandMarketId: string;
  localBrandName: string;
}

export interface ExtensionMeDto {
  nickname: string;
  tokenLabel: string;
  tokenPrefix: string;
  expiresAt: string;
  brands: ExtensionBrandDto[];
}

export interface ExtensionMediaAsset {
  url: string;
  alt: string;
  mime?: string;
}

export interface ExtensionPendingTaskDto {
  taskId: string;
  articleId: string;
  brandId: string;
  brandName: string;
  provider: ExtensionProviderKey;
  channelLabel: string;
  status: ExtensionTaskStatus;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  targetUrlHint: string | null;
  mediaAssets: ExtensionMediaAsset[];
  complianceChecklist: string[];
  updatedAt: string;
}

export interface ExtensionConfirmPublishedInput {
  publishedUrl: string;
  publishedAt?: string;
}

export interface ExtensionConfirmPublishedResult {
  taskId: string;
  status: 'PUBLISHED';
  publishRecordId: string;
  publishedUrl: string;
  crawlProbeQueued: boolean;
  retestMilestones: number[];
}

export interface FailedImageDetail {
  url: string;
  alt: string;
  reason: string;
}

export interface ImageUploadResult {
  uploadedImages: number;
  failedImages: number;
  failures: FailedImageDetail[];
}

export interface ImageUploadTarget {
  editorElement?: HTMLElement | null;
  fileInput?: HTMLInputElement | null;
}

export interface LocalImageUploader {
  uploadAll(
    assets: ExtensionMediaAsset[],
    target: ImageUploadTarget,
  ): Promise<ImageUploadResult>;
}

export type DraftInjectStage =
  | 'AUTH_REQUIRED'
  | 'EDITOR_NOT_FOUND'
  | 'INJECTED'
  | 'PARTIAL_MEDIA_FAILED';

export interface DraftInjectReport {
  ok: boolean;
  stage: DraftInjectStage;
  draftUrl?: string;
  uploadedImages: number;
  failedImages: number;
  failedImageDetails?: FailedImageDetail[];
  operatorReminders?: string[];
  message: string;
}

export interface PlatformDraftAdapter {
  readonly provider: ExtensionProviderKey;
  readonly displayName: string;
  readonly editorEntryUrl: string;
  readonly publishedUrlPatterns: readonly RegExp[];
  isLoggedInEditor(doc: Document, url: URL): boolean;
  injectDraft(
    doc: Document,
    task: ExtensionPendingTaskDto,
    uploader: LocalImageUploader,
  ): Promise<DraftInjectReport>;
  extractPublishedUrl(url: URL, doc: Document): string | null;
}

export interface PairingState {
  baseUrl: string;
  token: string;
  me: ExtensionMeDto;
  pairedAt: string;
}

export interface PendingTabTask {
  tabId: number;
  taskId: string;
  articleId: string;
  brandId: string;
  brandName: string;
  provider: ExtensionProviderKey;
  variantTitle: string;
  complianceChecklist: string[];
  injectedAt?: string;
  lastInjectReport?: DraftInjectReport;
}

export type TabTasksMap = Record<string, PendingTabTask>;

export interface ManifestV3Shape {
  manifest_version: number;
  name?: string;
  version?: string;
  description?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  action?: {
    default_popup?: string;
    default_icon?: Record<string, string>;
  };
  background?: {
    service_worker?: string;
    type?: string;
  };
  content_scripts?: Array<{
    matches?: string[];
    js?: string[];
    run_at?: string;
  }>;
  icons?: Record<string, string>;
  web_accessible_resources?: unknown[];
  content_security_policy?: unknown;
  externally_connectable?: unknown;
  [key: string]: unknown;
}

export interface ZipEntryInfo {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

// ============================================================================
// Strictly Sanitized Synthetic Constants (RFC 2606 / Zero Leakage Policy)
// ============================================================================

export const PAIRING_STORAGE_KEY = 'geomix.pairing.v1';
export const TAB_TASKS_STORAGE_KEY = 'geomix.tabTasks.v1';

export const EXPECTED_MANIFEST_PERMISSIONS = [
  'activeTab',
  'scripting',
  'storage',
  'tabs',
] as const;

export const EXPECTED_HOST_PERMISSIONS = [
  'https://mp.toutiao.com/*',
  'https://post.smzdm.com/*',
  'https://www.toutiao.com/*',
  'https://www.zhihu.com/*',
  'https://zhuanlan.zhihu.com/*',
] as const;

export const EXPECTED_OPTIONAL_HOST_PERMISSIONS = ['https://*/*'] as const;

export const FORBIDDEN_PERMISSIONS = [
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'debugger',
  'history',
  'sidePanel',
  'management',
  'nativeMessaging',
  'clipboardRead',
  'clipboardWrite',
  'declarativeNetRequest',
] as const;

export const SYNTHETIC_API_BASE_URL = 'https://geo.example.com';
export const SYNTHETIC_SECONDARY_API_URL = 'https://staging-geo.example.org';
export const SYNTHETIC_CDN_BASE_URL = 'https://cdn.example.com';

export const SYNTHETIC_TOKEN = 'gmext_demo_0123456789abcdef0123456789abcdef';
export const SYNTHETIC_REVOKED_TOKEN =
  'gmext_demo_revoked_000000000000000000000000';
export const SYNTHETIC_RENEWED_TOKEN =
  'gmext_demo_renewed_fedcba9876543210fedcba98';
export const SYNTHETIC_SENTINEL_TOKEN =
  'gmext_sentinel_secret_9876543210abcdef';

export const SYNTHETIC_BRAND_ALPHA: ExtensionBrandDto = {
  brandId: 'brand_demo_cn_01',
  brandName: 'DemoBrandAlpha',
  brandMarketId: 'bm_demo_cn_01',
  localBrandName: '示例品牌A',
};

export const SYNTHETIC_BRAND_BETA: ExtensionBrandDto = {
  brandId: 'brand_demo_cn_02',
  brandName: 'DemoBrandBeta',
  brandMarketId: 'bm_demo_cn_02',
  localBrandName: '示例品牌B',
};

export function makeSyntheticMe(
  overrides: Partial<ExtensionMeDto> = {},
): ExtensionMeDto {
  return {
    nickname: 'DemoOperator',
    tokenLabel: 'Demo Extension Key',
    tokenPrefix: 'gmext_demo_',
    expiresAt: '2027-01-01T00:00:00.000Z',
    brands: [SYNTHETIC_BRAND_ALPHA, SYNTHETIC_BRAND_BETA],
    ...overrides,
  };
}

export function makeSyntheticPairing(
  overrides: Partial<PairingState> = {},
): PairingState {
  return {
    baseUrl: SYNTHETIC_API_BASE_URL,
    token: SYNTHETIC_TOKEN,
    me: makeSyntheticMe(),
    pairedAt: '2026-11-24T04:00:00.000Z',
    ...overrides,
  };
}

export function makeSyntheticTask(
  provider: ExtensionProviderKey,
  overrides: Partial<ExtensionPendingTaskDto> = {},
): ExtensionPendingTaskDto {
  const defaultsByProvider: Record<
    ExtensionProviderKey,
    Omit<ExtensionPendingTaskDto, 'provider'>
  > = {
    ZHIHU_EXT: {
      taskId: 'task_demo_zhihu_01',
      articleId: 'art_demo_zhihu_01',
      brandId: SYNTHETIC_BRAND_ALPHA.brandId,
      brandName: SYNTHETIC_BRAND_ALPHA.brandName,
      channelLabel: '知乎专栏',
      status: 'READY_TO_PUBLISH',
      variantTitle: '示例品牌A 深度实测报告（知乎专栏版）',
      variantMarkdown:
        '# 示例品牌A 深度实测报告\n\n核心实测数据与对比说明。',
      variantHtml:
        '<h2>示例品牌A 核心实测结论</h2><p>通过标准测试环境采集 12 小时连续续航数据。</p><ul><li>功耗降低 18%</li><li>温控稳定在 39℃ 以内</li></ul>',
      targetUrlHint: null,
      mediaAssets: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '知乎主实测图',
          mime: 'image/png',
        },
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`,
          alt: '知乎细节对比图',
          mime: 'image/jpeg',
        },
      ],
      complianceChecklist: ['核对数据来源与测试环境', '确认不含绝对化用语'],
      updatedAt: '2026-11-24T04:10:00.000Z',
    },
    TOUTIAO_EXT: {
      taskId: 'task_demo_toutiao_01',
      articleId: 'art_demo_toutiao_01',
      brandId: SYNTHETIC_BRAND_BETA.brandId,
      brandName: SYNTHETIC_BRAND_BETA.brandName,
      channelLabel: '今日头条图文',
      status: 'DRAFT_VARIANT',
      variantTitle: '示例品牌B 选购避坑与实测参数解析',
      variantMarkdown: '# 示例品牌B 选购解析\n\n适合日常高频使用场景。',
      variantHtml:
        '<h2>三大核心选购维度</h2><p>结合实际场景拆解关键性能指标。</p><p><strong>结论：</strong>综合性价比表现均衡。</p>',
      targetUrlHint: null,
      mediaAssets: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '头条首图',
          mime: 'image/png',
        },
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-3.webp`,
          alt: '头条场景图',
          mime: 'image/webp',
        },
      ],
      complianceChecklist: ['人工复核封面与首图清晰度', '勿含夸大宣传词汇'],
      updatedAt: '2026-11-24T04:12:00.000Z',
    },
    SMZDM_EXT: {
      taskId: 'task_demo_smzdm_01',
      articleId: 'art_demo_smzdm_01',
      brandId: SYNTHETIC_BRAND_ALPHA.brandId,
      brandName: SYNTHETIC_BRAND_ALPHA.brandName,
      channelLabel: '什么值得买好文',
      status: 'READY_TO_PUBLISH',
      variantTitle: '示例品牌A 横向对比评测：参数与实测数据一览',
      variantMarkdown:
        '| 参数 | 型号A | 型号B |\n|---|---|---|\n| 续航 | 12小时 | 9小时 |',
      variantHtml:
        '<h2>参数对比总览</h2><table><thead><tr><th>参数</th><th>型号A</th><th>型号B</th></tr></thead><tbody><tr><td>续航</td><td>12小时</td><td>9小时</td></tr><tr><td>重量</td><td>185g</td><td>210g</td></tr><tr><td>噪声</td><td>32dB</td><td>38dB</td></tr></tbody></table><blockquote>实测环境温度 25℃，连续运行 3 轮取均值。</blockquote><ul><li>实测充电时间：42 分钟</li><li>待机损耗：每小时 0.4%</li></ul>',
      targetUrlHint: null,
      mediaAssets: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '参数实拍图',
          mime: 'image/png',
        },
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`,
          alt: '实验室读数图',
          mime: 'image/jpeg',
        },
      ],
      complianceChecklist: [
        '人工核对商品卡片链接',
        '确认已勾选或补充合规披露声明',
      ],
      updatedAt: '2026-11-24T04:15:00.000Z',
    },
  };

  return {
    provider,
    ...defaultsByProvider[provider],
    ...overrides,
  };
}

export function makeSyntheticPendingTabTask(
  tabId: number,
  task: ExtensionPendingTaskDto,
  overrides: Partial<PendingTabTask> = {},
): PendingTabTask {
  return {
    tabId,
    taskId: task.taskId,
    articleId: task.articleId,
    brandId: task.brandId,
    brandName: task.brandName,
    provider: task.provider,
    variantTitle: task.variantTitle,
    complianceChecklist: [...task.complianceChecklist],
    ...overrides,
  };
}
