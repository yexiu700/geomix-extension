import { vi } from 'vitest';
import type {
  ExtensionMediaAsset,
  ExtensionPendingTaskDto,
  FailedImageDetail,
} from '../../shared/bridge-contract';
import type { ImageUploadResult, ImageUploadTarget, LocalImageUploader } from '../types';

export const SMZDM_EDITOR_URL = 'https://post.smzdm.com/tougao/' as const;
export const SMZDM_EDITOR_DRAFT_URL = 'https://post.smzdm.com/tougao/?draft_id=demo_42' as const;
export const SMZDM_LOGIN_REDIRECT_URL =
  'https://zhiyou.smzdm.com/user/login/?redirect_to=https%3A%2F%2Fpost.smzdm.com%2Ftougao%2F' as const;
export const SMZDM_PUBLISHED_URL = 'https://post.smzdm.com/p/demo123abc' as const;
export const SMZDM_PUBLISHED_DIRTY_URL =
  'https://post.smzdm.com/p/demo123abc/?from=app&utm_source=demo&sid=fake#comments' as const;

export type SmzdmEditorFixtureOptions = {
  titleTag?: 'input' | 'textarea';
  editorVariant?: 'standard' | 'prosemirror' | 'ueditor' | 'textarea';
  draftButtonLabel?: string | null;
  draftButtonDisabled?: boolean;
  draftButtonAriaDisabled?: boolean;
  draftButtonHidden?: boolean;
  includeTrapButton?: boolean;
  trapButtonLabel?: string;
  includeSubmitReviewButton?: boolean;
  includePublishButton?: boolean;
  includeFileInput?: boolean;
  includeHiddenLoginModal?: boolean;
  initialBodyHtml?: string;
  documentUrl?: string;
};

export type SmzdmEditorFixture = {
  doc: Document;
  titleInput: HTMLInputElement | HTMLTextAreaElement;
  bodyEditor: HTMLElement;
  fileInput: HTMLInputElement | null;
  saveDraftButton: HTMLButtonElement | null;
  trapButton: HTMLButtonElement | null;
  submitReviewButton: HTMLButtonElement | null;
  publishButton: HTMLButtonElement | null;
};

function attachDocumentUrl(doc: Document, url: string): void {
  Object.defineProperty(doc, 'URL', {
    get: () => url,
    configurable: true,
  });
}

export function createSmzdmEditorDocument(
  options: SmzdmEditorFixtureOptions = {},
): SmzdmEditorFixture {
  const {
    titleTag = 'input',
    editorVariant = 'standard',
    draftButtonLabel = '保存草稿',
    draftButtonDisabled = false,
    draftButtonAriaDisabled = false,
    draftButtonHidden = false,
    includeTrapButton = false,
    trapButtonLabel = '保存并发布',
    includeSubmitReviewButton = true,
    includePublishButton = true,
    includeFileInput = true,
    includeHiddenLoginModal = false,
    initialBodyHtml = '',
    documentUrl,
  } = options;

  const doc = document.implementation.createHTMLDocument('什么值得买好文投稿');
  if (documentUrl) {
    attachDocumentUrl(doc, documentUrl);
  }

  const header = doc.createElement('header');
  header.className = 'smzdm-creator-header';
  const userName = doc.createElement('span');
  userName.className = 'creator-user-name';
  userName.textContent = '测试值友';
  header.appendChild(userName);
  doc.body.appendChild(header);

  const main = doc.createElement('main');
  main.className = 'tougao-container';
  main.setAttribute('data-smzdm-editor', 'true');

  let titleInput: HTMLInputElement | HTMLTextAreaElement;
  if (titleTag === 'textarea') {
    const textarea = doc.createElement('textarea');
    textarea.className = 'post-title-textarea';
    textarea.name = 'title';
    textarea.placeholder = '请输入好文标题';
    textarea.setAttribute('data-testid', 'smzdm-title-input');
    titleInput = textarea;
  } else {
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'post-title-input';
    input.name = 'title';
    input.placeholder = '请输入好文标题';
    input.setAttribute('data-testid', 'smzdm-title-input');
    titleInput = input;
  }
  main.appendChild(titleInput);

  let bodyEditor: HTMLElement;
  if (editorVariant === 'textarea') {
    const textarea = doc.createElement('textarea');
    textarea.className = 'editor-body';
    textarea.name = 'content';
    textarea.placeholder = '请输入好文正文内容';
    textarea.setAttribute('data-testid', 'smzdm-editor-body');
    if (initialBodyHtml) {
      textarea.value = initialBodyHtml;
    }
    bodyEditor = textarea;
  } else {
    const editorDiv = doc.createElement('div');
    editorDiv.setAttribute('contenteditable', 'true');
    editorDiv.setAttribute('data-testid', 'smzdm-editor-body');
    if (editorVariant === 'prosemirror') {
      editorDiv.className = 'ProseMirror';
      editorDiv.setAttribute('role', 'textbox');
    } else if (editorVariant === 'ueditor') {
      editorDiv.className = 'edui-body-container';
    } else {
      editorDiv.className = 'smzdm-editor-content';
      editorDiv.setAttribute('role', 'textbox');
    }
    if (initialBodyHtml) {
      editorDiv.innerHTML = initialBodyHtml;
    }
    bodyEditor = editorDiv;
  }
  main.appendChild(bodyEditor);

  let fileInput: HTMLInputElement | null = null;
  if (includeFileInput) {
    const uploadInput = doc.createElement('input');
    uploadInput.type = 'file';
    uploadInput.accept = 'image/*';
    uploadInput.className = 'smzdm-image-input';
    uploadInput.setAttribute('data-testid', 'smzdm-image-input');
    main.appendChild(uploadInput);
    fileInput = uploadInput;
  }

  const toolbar = doc.createElement('div');
  toolbar.className = 'tougao-action-toolbar';

  let saveDraftButton: HTMLButtonElement | null = null;
  if (draftButtonLabel !== null) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-save-draft';
    btn.setAttribute('data-action', 'save-draft');
    btn.textContent = draftButtonLabel;
    if (draftButtonDisabled) {
      btn.disabled = true;
    }
    if (draftButtonAriaDisabled) {
      btn.setAttribute('aria-disabled', 'true');
    }
    if (draftButtonHidden) {
      btn.hidden = true;
      btn.style.display = 'none';
    }
    toolbar.appendChild(btn);
    saveDraftButton = btn;
  }

  let trapButton: HTMLButtonElement | null = null;
  if (includeTrapButton) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-trap-publish';
    btn.setAttribute('data-action', 'save-and-publish');
    btn.textContent = trapButtonLabel;
    toolbar.appendChild(btn);
    trapButton = btn;
  }

  let submitReviewButton: HTMLButtonElement | null = null;
  if (includeSubmitReviewButton) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-submit-review';
    btn.setAttribute('data-action', 'submit-review');
    btn.textContent = '提交审核';
    toolbar.appendChild(btn);
    submitReviewButton = btn;
  }

  let publishButton: HTMLButtonElement | null = null;
  if (includePublishButton) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-publish';
    btn.setAttribute('data-action', 'publish');
    btn.textContent = '发布';
    toolbar.appendChild(btn);
    publishButton = btn;
  }

  main.appendChild(toolbar);
  doc.body.appendChild(main);

  if (includeHiddenLoginModal) {
    const modal = doc.createElement('div');
    modal.className = 'smzdm-login-modal';
    modal.setAttribute('role', 'dialog');
    modal.hidden = true;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    const heading = doc.createElement('h3');
    heading.textContent = '账号登录';
    const loginBtn = doc.createElement('button');
    loginBtn.type = 'button';
    loginBtn.textContent = '立即登录';
    modal.appendChild(heading);
    modal.appendChild(loginBtn);
    doc.body.appendChild(modal);
  }

  return {
    doc,
    titleInput,
    bodyEditor,
    fileInput,
    saveDraftButton,
    trapButton,
    submitReviewButton,
    publishButton,
  };
}

export function createSmzdmLoginModalDocument(options?: {
  variant?: 'modal-over-editor' | 'gate-page' | 'login-form';
  documentUrl?: string;
}): {
  doc: Document;
  publishButton: HTMLButtonElement | null;
  submitReviewButton: HTMLButtonElement | null;
} {
  const variant = options?.variant ?? 'modal-over-editor';

  if (variant === 'modal-over-editor') {
    const base = createSmzdmEditorDocument({
      ...(options?.documentUrl ? { documentUrl: options.documentUrl } : {}),
    });
    const modal = base.doc.createElement('div');
    modal.className = 'smzdm-login-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = base.doc.createElement('h2');
    title.textContent = '请先登录什么值得买账号';
    modal.appendChild(title);

    const form = base.doc.createElement('form');
    form.className = 'login-form';
    const pwd = base.doc.createElement('input');
    pwd.type = 'password';
    pwd.name = 'password';
    const submitBtn = base.doc.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = '立即登录';
    form.appendChild(pwd);
    form.appendChild(submitBtn);
    modal.appendChild(form);
    base.doc.body.appendChild(modal);

    return {
      doc: base.doc,
      publishButton: base.publishButton,
      submitReviewButton: base.submitReviewButton,
    };
  }

  const doc = document.implementation.createHTMLDocument('账号登录 - 什么值得买');
  if (options?.documentUrl) {
    attachDocumentUrl(doc, options.documentUrl);
  }

  if (variant === 'gate-page') {
    const gate = doc.createElement('section');
    gate.className = 'login-gate';
    const tip = doc.createElement('p');
    tip.textContent = '登录后发布好文';
    const link = doc.createElement('a');
    link.href = 'https://zhiyou.smzdm.com/user/login/';
    link.textContent = '去登录';
    gate.appendChild(tip);
    gate.appendChild(link);
    doc.body.appendChild(gate);
    return { doc, publishButton: null, submitReviewButton: null };
  }

  const form = doc.createElement('form');
  form.className = 'zhiyou-login';
  form.action = 'https://zhiyou.smzdm.com/user/login/';
  const userInput = doc.createElement('input');
  userInput.type = 'text';
  userInput.name = 'username';
  const pwdInput = doc.createElement('input');
  pwdInput.type = 'password';
  pwdInput.name = 'password';
  const submit = doc.createElement('button');
  submit.type = 'submit';
  submit.textContent = '登录';
  form.appendChild(userInput);
  form.appendChild(pwdInput);
  form.appendChild(submit);
  doc.body.appendChild(form);

  return { doc, publishButton: null, submitReviewButton: null };
}

export function createSmzdmMissingEditorDocument(options?: {
  missing?: 'both' | 'title' | 'body';
}): {
  doc: Document;
  submitReviewButton: HTMLButtonElement | null;
  publishButton: HTMLButtonElement | null;
} {
  const missing = options?.missing ?? 'both';
  const doc = document.implementation.createHTMLDocument('什么值得买好文投稿');

  const header = doc.createElement('header');
  header.className = 'smzdm-creator-header';
  const userName = doc.createElement('span');
  userName.className = 'creator-user-name';
  userName.textContent = '测试值友';
  header.appendChild(userName);
  doc.body.appendChild(header);

  const main = doc.createElement('main');
  main.className = 'tougao-container';

  if (missing === 'both') {
    const skeleton = doc.createElement('div');
    skeleton.className = 'editor-skeleton';
    skeleton.textContent = '加载中...';
    main.appendChild(skeleton);
  } else if (missing === 'title') {
    const editorDiv = doc.createElement('div');
    editorDiv.className = 'smzdm-editor-content';
    editorDiv.setAttribute('contenteditable', 'true');
    editorDiv.setAttribute('role', 'textbox');
    editorDiv.textContent = '既有草稿占位文本';
    main.appendChild(editorDiv);
  } else {
    const titleInput = doc.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'post-title-input';
    titleInput.name = 'title';
    titleInput.value = '原始标题占位';
    main.appendChild(titleInput);
  }

  const toolbar = doc.createElement('div');
  toolbar.className = 'tougao-action-toolbar';

  const submitReviewButton = doc.createElement('button');
  submitReviewButton.type = 'button';
  submitReviewButton.className = 'btn-submit-review';
  submitReviewButton.setAttribute('data-action', 'submit-review');
  submitReviewButton.textContent = '提交审核';
  toolbar.appendChild(submitReviewButton);

  const publishButton = doc.createElement('button');
  publishButton.type = 'button';
  publishButton.className = 'btn-publish';
  publishButton.setAttribute('data-action', 'publish');
  publishButton.textContent = '发布';
  toolbar.appendChild(publishButton);

  main.appendChild(toolbar);
  doc.body.appendChild(main);

  return { doc, submitReviewButton, publishButton };
}

export function createSmzdmPublishedDocument(options?: {
  slug?: string;
  title?: string;
  canonicalUrl?: string;
}): { doc: Document } {
  const slug = options?.slug ?? 'demo123abc';
  const title = options?.title ?? 'DemoBrand Model-A1 与 Model-B2 横向实测对比';
  const canonicalUrl = options?.canonicalUrl ?? `https://post.smzdm.com/p/${slug}/`;

  const doc = document.implementation.createHTMLDocument(title);

  const canonical = doc.createElement('link');
  canonical.setAttribute('rel', 'canonical');
  canonical.setAttribute('href', canonicalUrl);
  doc.head.appendChild(canonical);

  const ogUrl = doc.createElement('meta');
  ogUrl.setAttribute('property', 'og:url');
  ogUrl.setAttribute('content', canonicalUrl);
  doc.head.appendChild(ogUrl);

  const article = doc.createElement('article');
  article.className = 'smzdm-article-detail';
  const h1 = doc.createElement('h1');
  h1.textContent = title;
  const body = doc.createElement('div');
  body.className = 'article-body';
  body.textContent = '示例实测好文正文内容。';
  article.appendChild(h1);
  article.appendChild(body);
  doc.body.appendChild(article);

  return { doc };
}

const DEFAULT_SMZDM_VARIANT_HTML = [
  '<h2>一、核心参数对比表</h2>',
  '<table class="param-compare-table" summary="DemoBrand 双机型实测参数对比">',
  '  <caption>DemoBrand Model-A1 vs Model-B2 参数与实测对比</caption>',
  '  <colgroup><col span="1" /><col span="1" /><col span="1" /></colgroup>',
  '  <thead>',
  '    <tr>',
  '      <th scope="col" align="left">对比维度</th>',
  '      <th scope="col" align="center">DemoBrand Model-A1</th>',
  '      <th scope="col" align="center">DemoBrand Model-B2</th>',
  '    </tr>',
  '  </thead>',
  '  <tbody>',
  '    <tr>',
  '      <td>实测续航</td>',
  '      <td align="center">12.5 小时</td>',
  '      <td align="center">10.2 小时</td>',
  '    </tr>',
  '    <tr>',
  '      <td>满载噪音</td>',
  '      <td align="center">38.4 dB</td>',
  '      <td align="center">42.1 dB</td>',
  '    </tr>',
  '    <tr>',
  '      <td>机身重量</td>',
  '      <td colspan="2" align="center">均控制在 1.35 kg 以内</td>',
  '    </tr>',
  '  </tbody>',
  '</table>',
  '<section class="measured-data-section" data-block="measured-data" data-env="25c-lab">',
  '  <h2>二、实测数据块</h2>',
  '  <blockquote>测试环境：25℃ 恒温室内，连续高负载运行 60 分钟记录机身表面温度与快充耗时。</blockquote>',
  '  <ul>',
  '    <li>Model-A1 连续满载最高表面温度：<strong>39.2℃</strong></li>',
  '    <li>Model-A1 0%-80% 实测快充耗时：<strong>34 分钟</strong></li>',
  '  </ul>',
  '  <pre class="measured-data-raw"><code>BENCHMARK_SUMMARY: Model-A1 temp=39.2℃ charge=34min noise=38.4dB</code></pre>',
  '</section>',
  '<p>合规披露声明：本文样机为自费购入体验，具体价格以站内实时商品卡片为准。</p>',
].join('\n');

const DEFAULT_SMZDM_VARIANT_MARKDOWN = [
  '## 一、核心参数对比表',
  '',
  '| 对比维度 | DemoBrand Model-A1 | DemoBrand Model-B2 |',
  '| :--- | :---: | ---: |',
  '| 实测续航 | 12.5 小时 | 10.2 小时 |',
  '| 满载噪音 | 38.4 dB | 42.1 dB |',
  '| 机身重量 | 1.28 kg | 1.35 kg |',
  '',
  '## 二、实测数据块',
  '',
  '> 测试环境：25℃ 恒温室内，连续高负载运行 60 分钟记录温升与快充表现。',
  '',
  '- Model-A1 连续满载最高表面温度：**39.2℃**',
  '- Model-A1 0%-80% 实测快充耗时：**34 分钟**',
  '',
  '```text',
  'BENCHMARK_SUMMARY: Model-A1 temp=39.2℃ charge=34min noise=38.4dB',
  '```',
  '',
  '![禁止外链图](https://cdn.example.com/smzdm/markdown-hotlink.png)',
  '参考链接：[站内评测归档](https://post.smzdm.com/p/demo123abc)',
].join('\n');

export function createSmzdmTaskFixture(
  overrides: Partial<ExtensionPendingTaskDto> = {},
): ExtensionPendingTaskDto {
  return {
    taskId: 'task_smzdm_demo_1',
    articleId: 'art_demo_smzdm_1',
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
    provider: 'SMZDM_EXT',
    channelLabel: '什么值得买好文',
    status: 'READY_TO_PUBLISH',
    variantTitle: 'DemoBrand Model-A1 与 Model-B2 实测对比：参数与续航全解析',
    variantMarkdown: DEFAULT_SMZDM_VARIANT_MARKDOWN,
    variantHtml: DEFAULT_SMZDM_VARIANT_HTML,
    targetUrlHint: null,
    mediaAssets: [
      {
        url: 'https://cdn.example.com/smzdm/demo-cover.png',
        alt: 'DemoBrand 实测外观对比图',
        mime: 'image/png',
      },
      {
        url: 'https://cdn.example.com/smzdm/demo-chart.webp',
        alt: '续航与噪音实测曲线图',
        mime: 'image/webp',
      },
    ],
    complianceChecklist: [
      '核对文中提及型号的站内商品卡片',
      '确认已添加客观利益披露声明',
      '复核实测参数，避免绝对化用语',
    ],
    updatedAt: '2026-11-24T06:00:00.000Z',
    ...overrides,
  };
}

export function createSmzdmUnsafeHtmlTaskFixture(): ExtensionPendingTaskDto {
  const unsafeHtml = [
    '<script>window.__xss = true;</script>',
    '<style>body { display: none; }</style>',
    '<iframe src="https://evil.example.com/embed"></iframe>',
    '<svg onload="alert(1)"><script>alert(2)</script></svg>',
    '<figure><img src="https://cdn.example.com/hotlink-blocked.png" alt="外链图" onerror="alert(3)" /></figure>',
    '<table id="clobber-id" style="color:red" onclick="alert(4)">',
    '  <thead><tr><th onmouseover="alert(5)">参数</th><th>Model-A1</th></tr></thead>',
    '  <tbody><tr><td>实测续航</td><td>12.5 小时</td></tr></tbody>',
    '</table>',
    '<section data-block="measured-data" data-src="https://evil.example.com/leak.png">',
    '  <p>实测数据块：连续满载最高表面温度 39.2℃，快充耗时 34 分钟。</p>',
    '</section>',
    '<p><a href="javascript:alert(6)">危险脚本链接</a></p>',
    '<p><a href="data:text/html,<script>alert(7)</script>">危险数据链接</a></p>',
    '<p><a href="https://post.smzdm.com/p/demo123abc">合规参考链接</a></p>',
  ].join('\n');

  return createSmzdmTaskFixture({
    taskId: 'task_smzdm_demo_xss',
    variantHtml: unsafeHtml,
    mediaAssets: [],
  });
}

export function createSmzdmMarkdownFallbackTaskFixture(): ExtensionPendingTaskDto {
  return createSmzdmTaskFixture({
    taskId: 'task_smzdm_demo_md',
    variantHtml: '   \n  ',
    variantMarkdown: DEFAULT_SMZDM_VARIANT_MARKDOWN,
    mediaAssets: [],
  });
}

export function createMockSmzdmUploader(behavior: 'success' | 'partial' | 'all-fail' = 'success'): {
  uploader: LocalImageUploader;
  uploadAllSpy: ReturnType<
    typeof vi.fn<
      (assets: ExtensionMediaAsset[], target: ImageUploadTarget) => Promise<ImageUploadResult>
    >
  >;
  receivedTargets: ImageUploadTarget[];
  receivedAssets: ExtensionMediaAsset[][];
} {
  const receivedTargets: ImageUploadTarget[] = [];
  const receivedAssets: ExtensionMediaAsset[][] = [];

  const uploadAllSpy = vi.fn<
    (assets: ExtensionMediaAsset[], target: ImageUploadTarget) => Promise<ImageUploadResult>
  >(async (assets, target) => {
    receivedTargets.push(target);
    receivedAssets.push(assets);

    if (assets.length === 0) {
      return { uploadedImages: 0, failedImages: 0, failures: [] };
    }

    if (behavior === 'success') {
      return { uploadedImages: assets.length, failedImages: 0, failures: [] };
    }

    if (behavior === 'partial') {
      const failures: FailedImageDetail[] = assets.slice(1).map((asset) => ({
        url: asset.url,
        alt: asset.alt,
        reason: '图片拉取超时 (15s)',
      }));
      return {
        uploadedImages: 1,
        failedImages: failures.length,
        failures,
      };
    }

    const failures: FailedImageDetail[] = assets.map((asset) => ({
      url: asset.url,
      alt: asset.alt,
      reason: '图片体积超过 10MB 上限',
    }));
    return {
      uploadedImages: 0,
      failedImages: failures.length,
      failures,
    };
  });

  return {
    uploader: {
      uploadAll: uploadAllSpy,
    },
    uploadAllSpy,
    receivedTargets,
    receivedAssets,
  };
}
