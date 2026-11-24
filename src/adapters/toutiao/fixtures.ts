import type { ExtensionPendingTaskDto } from '../types';

export const TOUTIAO_EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';
export const TOUTIAO_EDITOR_QUERY_URL =
  'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=demo_draft_001&from=creator';
export const TOUTIAO_LOGIN_REDIRECT_URL =
  'https://mp.toutiao.com/auth/page/login?redirect_url=https%3A%2F%2Fmp.toutiao.com%2Fprofile_v4%2Fgraphic%2Fpublish';
export const TOUTIAO_SSO_LOGIN_URL = 'https://sso.toutiao.com/login/';
export const TOUTIAO_DEMO_ARTICLE_ID = '7312345678901234567';

export type ToutiaoEditorFixtureOptions = {
  url?: string;
  titleControl?: 'textarea' | 'input' | 'contenteditable';
  includeFileInput?: boolean;
  hideFileInput?: boolean;
  includeCoverAndVideoInputs?: boolean;
  includeDraftButton?: boolean;
  draftButtonLabel?: string;
  draftButtonTag?: 'button' | 'role-button';
  disableDraftButton?: boolean;
  initialBodyHtml?: string;
};

export function createDemoToutiaoTask(
  overrides: Partial<ExtensionPendingTaskDto> = {},
): ExtensionPendingTaskDto {
  return {
    taskId: 'task_toutiao_demo_1',
    articleId: 'art_toutiao_demo_1',
    brandId: 'brand_demo_toutiao',
    brandName: 'DemoBrand 示例品牌',
    provider: 'TOUTIAO_EXT',
    channelLabel: '今日头条图文',
    status: 'READY_TO_PUBLISH',
    variantTitle: 'DemoBrand 2026 选购实测避坑指南',
    variantMarkdown: [
      '## 实测核心结论',
      '',
      '本文基于公开参数与实验室模拟数据整理，帮助消费者快速了解 **DemoBrand** 的选购要点。',
      '',
      '- 指标 A：连续运行稳定性表现均衡',
      '- 指标 B：日常维护成本清晰透明',
      '',
      '> 温馨提示：购买前请结合个人使用场景核对规格。',
    ].join('\n'),
    variantHtml: [
      '<h2>实测核心结论</h2>',
      '<p>本文基于公开参数与实验室模拟数据整理，帮助消费者快速了解 <strong>DemoBrand</strong> 的选购要点。</p>',
      '<ul><li>指标 A：连续运行稳定性表现均衡</li><li>指标 B：日常维护成本清晰透明</li></ul>',
      '<blockquote><p>温馨提示：购买前请结合个人使用场景核对规格。</p></blockquote>',
    ].join(''),
    targetUrlHint: null,
    mediaAssets: [
      {
        url: 'https://cdn.example.com/assets/toutiao-demo-1.png',
        alt: '实测外观对比图',
        mime: 'image/png',
      },
      {
        url: 'https://cdn.example.com/assets/toutiao-demo-2.webp',
        alt: '参数拆解示意图',
        mime: 'image/webp',
      },
    ],
    complianceChecklist: ['避免绝对化宣传用语', '确认配图无第三方水印'],
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function createHtmlDocument(
  title: string,
  bodyHtml: string,
  headHtml = '',
  docUrl?: string,
): Document {
  const doc = document.implementation.createHTMLDocument(title);
  if (headHtml) {
    doc.head.innerHTML = headHtml;
  }
  doc.body.innerHTML = bodyHtml;

  if (docUrl) {
    Object.defineProperty(doc, 'URL', {
      value: docUrl,
      configurable: true,
    });
  }

  return doc;
}

export function createToutiaoEditorDocument(options: ToutiaoEditorFixtureOptions = {}): Document {
  const {
    url = TOUTIAO_EDITOR_URL,
    titleControl = 'textarea',
    includeFileInput = true,
    hideFileInput = true,
    includeCoverAndVideoInputs = false,
    includeDraftButton = true,
    draftButtonLabel = '存草稿',
    draftButtonTag = 'button',
    disableDraftButton = false,
    initialBodyHtml = '<p><br></p>',
  } = options;

  let titleMarkup: string;
  if (titleControl === 'input') {
    titleMarkup =
      '<input type="text" class="editor-title" placeholder="请输入文章标题（2～30个字）" />';
  } else if (titleControl === 'contenteditable') {
    titleMarkup =
      '<div class="title-editable" data-e2e="article-title" contenteditable="true"></div>';
  } else {
    titleMarkup =
      '<textarea class="editor-title" placeholder="请输入文章标题（2～30个字）"></textarea>';
  }

  const coverAndVideoMarkup = includeCoverAndVideoInputs
    ? `
      <div class="article-cover-uploader" data-e2e="cover-upload">
        <input type="file" accept="image/*" class="cover-input" data-testid="cover-file-input" />
      </div>
      <div class="syl-video-uploader">
        <input type="file" accept="video/mp4,video/*" class="video-input" data-testid="video-file-input" />
      </div>
      <div class="syl-disabled-uploader">
        <input type="file" accept="image/*" disabled data-testid="disabled-file-input" />
      </div>
    `
    : '';

  const fileInputStyle = hideFileInput ? ' style="display: none;"' : '';
  const fileInputMarkup = includeFileInput
    ? `<input type="file" accept="image/png,image/jpeg,image/webp" class="syl-image-upload-input" data-testid="body-image-file-input"${fileInputStyle} />`
    : '';

  let draftButtonMarkup = '';
  if (includeDraftButton) {
    if (draftButtonTag === 'role-button') {
      draftButtonMarkup = `<span role="button" class="byte-btn byte-btn-default draft-action-btn" data-testid="save-draft-btn"${disableDraftButton ? ' aria-disabled="true"' : ''}>${draftButtonLabel}</span>`;
    } else {
      draftButtonMarkup = `<button type="button" class="byte-btn byte-btn-default draft-action-btn" data-testid="save-draft-btn"${disableDraftButton ? ' disabled' : ''}>${draftButtonLabel}</button>`;
    }
  }

  const bodyHtml = `
    <header class="byte-header" data-e2e="creator-header">
      <span class="creator-name">示例创作者账号</span>
    </header>
    <main class="publish-editor-wrapper">
      <div class="publish-editor-title-inner">
        ${titleMarkup}
      </div>
      ${coverAndVideoMarkup}
      <div class="syl-editor-container">
        <div class="syl-toolbar">
          ${fileInputMarkup}
        </div>
        <div class="ProseMirror syl-editor-content" contenteditable="true" role="textbox">${initialBodyHtml}</div>
      </div>
      <footer class="editor-action-footer">
        ${draftButtonMarkup}
        <button type="button" class="byte-btn byte-btn-default" data-testid="draft-box-btn">草稿箱</button>
        <button type="button" class="byte-btn byte-btn-primary" data-testid="preview-publish-btn">预览并发布</button>
        <button type="button" class="byte-btn byte-btn-primary" data-testid="publish-btn">发布</button>
      </footer>
    </main>
  `;

  return createHtmlDocument('头条号 - 图文创作', bodyHtml, '', url);
}

export function createToutiaoAdversarialButtonsDocument(): Document {
  const bodyHtml = `
    <header class="byte-header" data-e2e="creator-header">
      <span class="creator-name">示例创作者账号</span>
    </header>
    <main class="publish-editor-wrapper">
      <div class="publish-editor-title-inner">
        <textarea class="editor-title" placeholder="请输入文章标题（2～30个字）"></textarea>
      </div>
      <div class="syl-editor-container">
        <input type="file" accept="image/*" style="display: none;" />
        <div class="ProseMirror syl-editor-content" contenteditable="true" role="textbox"><p><br></p></div>
      </div>
      <footer class="editor-action-footer" data-testid="adversarial-footer">
        <button type="button" data-trap="compound-1">存草稿并发布</button>
        <button type="button" data-trap="compound-2">保存草稿后发布</button>
        <button type="button" data-trap="compound-3">存草稿并提交审核</button>
        <button type="button" data-trap="preview-publish">预览并发布</button>
        <button type="button" data-trap="direct-publish">立即发布</button>
        <button type="button" data-trap="schedule-publish">定时发布</button>
        <button type="button" data-trap="submit-review">提交审核</button>
        <button type="button" data-trap="delete-draft">删除草稿</button>
        <button type="button" data-trap="draft-box">草稿箱</button>
        <button type="button" data-trap="aria-trap" aria-label="预览并发布">存草稿</button>
        <button type="button" data-trap="title-trap" title="发布文章">存草稿</button>
        <button type="button" data-trap="data-e2e-trap" data-e2e="publish-btn">存草稿</button>
        <button type="button" data-trap="class-trap" class="publish-btn">存草稿</button>
        <button type="button" data-trap="id-trap" id="submit-article-btn">存草稿</button>
        <button type="button" data-trap="name-trap" name="releaseAction">存草稿</button>
        <button type="button" data-trap="hidden-span-trap">存草稿<span style="display: none">并发布</span></button>
        <form action="/mock-submit">
          <button data-trap="implicit-form-submit">存草稿</button>
        </form>
        <form id="pub-form" action="https://mp.toutiao.com/publish"></form>
        <button form="pub-form" data-trap="external-form-submit">存草稿</button>
        <button type="button" form="pub-form" data-trap="external-form-explicit-type">存草稿</button>
        <button type="button" formaction="https://mp.toutiao.com/publish" data-trap="formaction-publish">存草稿</button>
        <a href="https://mp.toutiao.com/publish" data-trap="anchor-wrapping-button">
          <button type="button" data-trap="button-inside-anchor">存草稿</button>
        </a>
        <a href="https://mp.toutiao.com/publish" data-trap="anchor-wrapping-role-button">
          <span role="button" data-trap="role-button-inside-anchor">存草稿</span>
        </a>
        <fieldset disabled>
          <button type="button" data-trap="fieldset-disabled-draft">存草稿</button>
        </fieldset>
        <button type="submit" data-trap="explicit-submit">存草稿</button>
        <button type="button" disabled data-trap="disabled-draft">存草稿</button>
        <button type="button" aria-disabled="true" data-trap="aria-disabled-draft">存草稿</button>
        <button type="button" aria-disabled="TRUE" data-trap="aria-disabled-uppercase">存草稿</button>
        <button type="button" style="display: none" data-trap="hidden-draft">存草稿</button>
        <button type="button" aria-label="发&#x200b;布" data-trap="zwsp-aria-trap">存草稿</button>
        <button type="button" aria-label="预 览 并 发 布" data-trap="spaced-aria-trap">存草稿</button>
        <button type="button" data-action="pub&#x200b;lish" data-trap="zwsp-data-trap">存草稿</button>
        <button type="button" title="预&#x200b;览并发布" data-trap="zwsp-title-trap">存草稿</button>
        <a role="button" href="https://mp.toutiao.com/mock-nav" data-trap="anchor-role-button">存草稿</a>
      </footer>
    </main>
  `;

  return createHtmlDocument('头条号 - 图文创作', bodyHtml, '', TOUTIAO_EDITOR_URL);
}

export function createToutiaoLoginRedirectDocument(url = TOUTIAO_LOGIN_REDIRECT_URL): Document {
  const bodyHtml = `
    <main class="auth-login-container">
      <h1>登录头条号</h1>
      <form action="/auth/page/login" method="post">
        <input type="text" name="mobile" placeholder="请输入手机号" />
        <input type="password" name="password" placeholder="请输入密码" />
        <button type="submit">立即登录</button>
      </form>
    </main>
  `;
  return createHtmlDocument('头条号登录 - 示例', bodyHtml, '', url);
}

export function createToutiaoLoginModalDocument(options: { hidden?: boolean } = {}): Document {
  const doc = createToutiaoEditorDocument({ url: TOUTIAO_EDITOR_URL });
  const modal = doc.createElement('div');
  modal.className = 'byte-login-modal';
  modal.setAttribute('role', 'dialog');
  if (options.hidden) {
    modal.setAttribute('aria-hidden', 'true');
    modal.style.display = 'none';
  }
  modal.innerHTML = `
    <div class="qrcode-login">
      <h2>扫码登录头条号</h2>
      <p>请先登录后继续编辑内容</p>
    </div>
  `;
  doc.body.appendChild(modal);
  return doc;
}

export function createToutiaoBrokenEditorDocument(missing: 'title' | 'body' | 'both'): Document {
  const titleMarkup =
    missing === 'title' || missing === 'both'
      ? ''
      : '<textarea class="editor-title" placeholder="请输入文章标题"></textarea>';
  const bodyMarkup =
    missing === 'body' || missing === 'both'
      ? ''
      : '<div class="ProseMirror syl-editor-content" contenteditable="true" role="textbox"><p><br></p></div>';

  const bodyHtml = `
    <header class="byte-header" data-e2e="creator-header">
      <span class="creator-name">示例创作者账号</span>
    </header>
    <main class="publish-editor-wrapper">
      <div class="publish-editor-title-inner">${titleMarkup}</div>
      <div class="syl-editor-container">${bodyMarkup}</div>
      <footer class="editor-action-footer">
        <button type="button" data-testid="save-draft-btn">存草稿</button>
        <button type="button" data-testid="publish-btn">发布</button>
      </footer>
    </main>
  `;
  return createHtmlDocument('头条号 - 图文创作', bodyHtml, '', TOUTIAO_EDITOR_URL);
}

export function createToutiaoPublishedDocument(
  options: { canonicalHref?: string; ogUrl?: string } = {},
): Document {
  const headParts: string[] = [];
  if (options.canonicalHref) {
    headParts.push(`<link rel="canonical" href="${options.canonicalHref}" />`);
  }
  if (options.ogUrl) {
    headParts.push(`<meta property="og:url" content="${options.ogUrl}" />`);
  }
  const bodyHtml = `
    <article class="article-content">
      <h1>DemoBrand 2026 选购实测避坑指南</h1>
      <p>正文展示区域</p>
    </article>
  `;
  return createHtmlDocument(
    'DemoBrand 2026 选购实测避坑指南 - 今日头条',
    bodyHtml,
    headParts.join('\n'),
  );
}
