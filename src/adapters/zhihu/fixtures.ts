import { vi, type Mock } from 'vitest';
import type { ExtensionPendingTaskDto } from '../types';

export const ZHIHU_DEMO_URLS = {
  zhuanlanWrite: 'https://zhuanlan.zhihu.com/write',
  zhuanlanDraftEdit: 'https://zhuanlan.zhihu.com/p/123456/edit',
  questionPage: 'https://www.zhihu.com/question/987654321',
  questionWritePage: 'https://www.zhihu.com/question/987654321/write',
  signinPage: 'https://www.zhihu.com/signin?next=%2Fwrite',
  publishedArticle: 'https://zhuanlan.zhihu.com/p/123456789',
  publishedArticleWithQuery:
    'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo&share_code=secret#comments',
  publishedArticleSubView: 'https://zhuanlan.zhihu.com/p/123456789/voters',
  publishedAnswer: 'https://www.zhihu.com/question/987654321/answer/1122334455',
  publishedAnswerWithQuery:
    'https://www.zhihu.com/question/987654321/answer/1122334455/?utm_id=demo#top',
  publishedAnswerSubView: 'https://www.zhihu.com/question/987654321/answer/1122334455/comments',
  publishedAnswerEdit: 'https://www.zhihu.com/question/987654321/answer/1122334455/edit',
} as const;

export type ReactControlledValueTracker = {
  getReactState: () => string;
  getReactOnChangeCount: () => number;
  wasDirectAssignmentUsed: () => boolean;
  getDispatchedEvents: () => Array<{ type: string; bubbles: boolean }>;
};

export type PasteCaptureRecord = {
  html: string;
  plain: string;
  files: File[];
  bubbles: boolean;
  cancelable: boolean;
};

export type PublishClickSpy = Mock<() => void>;

export function createZhihuDemoTask(
  overrides?: Partial<ExtensionPendingTaskDto>,
): ExtensionPendingTaskDto {
  return {
    taskId: 'task_zhihu_demo_1',
    articleId: 'art_demo_1',
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
    provider: 'ZHIHU_EXT',
    channelLabel: '知乎专栏',
    status: 'READY_TO_PUBLISH',
    variantTitle: '示例品牌甲 2026 实测深度解析：结构化指标对比与场景建议',
    variantMarkdown: [
      '## 核心测试结论',
      '',
      '示例品牌甲在连续稳定性与响应速度两项指标上均保持均衡表现。',
      '',
      '- 指标一：连续运行 120 分钟无明显波动',
      '- 指标二：多场景切换延迟控制在合理区间',
      '',
      '> 注：所有数据均来自脱敏示例实验环境。',
    ].join('\n'),
    variantHtml: [
      '<h2>核心测试结论</h2>',
      '<p>示例品牌甲在连续稳定性与响应速度两项指标上均保持均衡表现。</p>',
      '<ul><li>指标一：连续运行 120 分钟无明显波动</li><li>指标二：多场景切换延迟控制在合理区间</li></ul>',
      '<blockquote><p>注：所有数据均来自脱敏示例实验环境。</p></blockquote>',
    ].join(''),
    targetUrlHint: null,
    mediaAssets: [
      {
        url: 'https://cdn.example.com/assets/demo-chart-1.png',
        alt: '核心指标对比图',
        mime: 'image/png',
      },
      {
        url: 'https://cdn.example.com/assets/demo-chart-2.webp',
        alt: '场景实测数据图',
        mime: 'image/webp',
      },
    ],
    complianceChecklist: ['避免绝对化用语', '标注测试环境与样本范围'],
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function parseFixtureDocument(html: string, mountToGlobalDocument = false): Document {
  if (mountToGlobalDocument) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    return document;
  }
  return new DOMParser().parseFromString(html, 'text/html');
}

export function attachReactValueTracker(
  element: HTMLTextAreaElement | HTMLInputElement,
): ReactControlledValueTracker {
  const isTextArea = element.tagName.toUpperCase() === 'TEXTAREA';
  const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeDesc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!nativeDesc?.get || !nativeDesc?.set) {
    throw new Error('Missing native value descriptor in jsdom environment');
  }

  let trackedValue = nativeDesc.get.call(element) as string;
  let reactState = trackedValue;
  let reactOnChangeCount = 0;
  let directAssignmentUsed = false;
  const dispatchedEvents: Array<{ type: string; bubbles: boolean }> = [];

  Object.defineProperty(element, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return nativeDesc.get!.call(this) as string;
    },
    set(nextValue: string) {
      directAssignmentUsed = true;
      trackedValue = String(nextValue);
      nativeDesc.set!.call(this, nextValue);
    },
  });

  const handleInputOrChange = (event: Event): void => {
    dispatchedEvents.push({ type: event.type, bubbles: event.bubbles });
    const currentNativeValue = nativeDesc.get!.call(element) as string;
    if (currentNativeValue !== trackedValue) {
      trackedValue = currentNativeValue;
      reactState = currentNativeValue;
      reactOnChangeCount += 1;
    }
  };

  element.addEventListener('input', handleInputOrChange);
  element.addEventListener('change', handleInputOrChange);

  return {
    getReactState: () => reactState,
    getReactOnChangeCount: () => reactOnChangeCount,
    wasDirectAssignmentUsed: () => directAssignmentUsed,
    getDispatchedEvents: () => [...dispatchedEvents],
  };
}

export function attachDraftJsPasteHandler(editor: HTMLElement): PasteCaptureRecord[] {
  const records: PasteCaptureRecord[] = [];

  editor.addEventListener('paste', (event: Event) => {
    const clipboardEvent = event as ClipboardEvent;
    const dt = clipboardEvent.clipboardData;
    const html = dt?.getData('text/html') ?? '';
    const plain = dt?.getData('text/plain') ?? '';
    const files = dt?.files ? Array.from(dt.files) : [];

    records.push({
      html,
      plain,
      files,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
    });

    // Only simulate Draft.js rich-text paste consumption for text/html or text/plain payloads
    if (html.length > 0 || plain.length > 0) {
      event.preventDefault();
      const targetDoc = editor.ownerDocument;
      const contents = targetDoc.createElement('div');
      contents.setAttribute('data-contents', 'true');
      const block = targetDoc.createElement('div');
      block.setAttribute('data-block', 'true');

      if (html.length > 0) {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        for (const child of Array.from(parsed.body.childNodes)) {
          block.appendChild(targetDoc.importNode(child, true));
        }
      } else {
        block.textContent = plain;
      }

      contents.appendChild(block);
      editor.replaceChildren(contents);
    }
  });

  return records;
}

export type ZhuanlanEditorFixtureOptions = {
  url?: string;
  titleElementTag?: 'textarea' | 'input';
  simulateDraftJsPaste?: boolean;
  includeFileInput?: boolean;
  includeCoverFileInput?: boolean;
  includeNonImageFileInputs?: boolean;
  includeDraftStatus?: boolean;
  mountToGlobalDocument?: boolean;
};

export function createZhihuZhuanlanEditorFixture(options?: ZhuanlanEditorFixtureOptions) {
  const url = new URL(options?.url ?? ZHIHU_DEMO_URLS.zhuanlanWrite);
  const titleTag = options?.titleElementTag ?? 'textarea';
  const includeFileInput = options?.includeFileInput ?? true;
  const includeCoverFileInput = options?.includeCoverFileInput ?? true;
  const includeNonImageFileInputs = options?.includeNonImageFileInputs ?? false;
  const includeDraftStatus = options?.includeDraftStatus ?? true;

  const titleMarkup =
    titleTag === 'textarea'
      ? '<textarea class="Input" placeholder="请输入标题（最多 100 个字）" rows="1"></textarea>'
      : '<input type="text" class="Input" placeholder="请输入标题（最多 100 个字）" />';

  const coverFileInputMarkup = includeCoverFileInput
    ? '<div class="WriteIndex-titleImage"><input type="file" accept="image/*" class="TitleImage-input" style="display: none" /></div>'
    : '';

  const nonImageFileInputsMarkup = includeNonImageFileInputs
    ? '<input id="video-upload-input" type="file" accept="video/*" style="display: none" /><input id="doc-import-input" type="file" accept=".doc,.docx,.md" style="display: none" />'
    : '';

  const bodyFileInputMarkup = includeFileInput
    ? '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="PostEditor-imageInput" style="display: none" />'
    : '';

  const draftStatusMarkup = includeDraftStatus
    ? '<span class="WriteIndex-draftStatus">草稿自动保存</span>'
    : '';

  const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>写文章 - 知乎</title></head>
  <body>
    <header class="ColumnPageHeader">
      <div class="ColumnPageHeader-profile">
        <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
      </div>
      ${draftStatusMarkup}
      <div class="PublishPanel">
        <button type="button" class="Button PublishPanel-triggerButton Button--primary Button--blue">发布</button>
        <button type="button" class="Button PublishPanel-stepTwoButton Button--primary Button--blue">发布文章</button>
        <button type="submit" class="Button Button--primary">确认发布</button>
      </div>
    </header>
    <main class="WriteIndex-editor PostEditor">
      ${coverFileInputMarkup}
      <div class="WriteIndex-titleInput">
        ${titleMarkup}
      </div>
      <div class="PostEditor-wrapper">
        ${nonImageFileInputsMarkup}
        ${bodyFileInputMarkup}
        <div class="DraftEditor-root">
          <div class="public-DraftEditor-content" contenteditable="true" role="textbox" aria-label="正文编辑器">
            <div data-contents="true"><div data-block="true"><br data-text="true" /></div></div>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

  const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
  const titleInput = doc.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    '.WriteIndex-titleInput textarea, .WriteIndex-titleInput input',
  )!;
  const editorElement = doc.querySelector<HTMLElement>(
    '.public-DraftEditor-content[contenteditable="true"]',
  )!;
  const fileInput = doc.querySelector<HTMLInputElement>('input.PostEditor-imageInput');
  const coverFileInput = doc.querySelector<HTMLInputElement>('input.TitleImage-input');
  const publishButton = doc.querySelector<HTMLButtonElement>('.PublishPanel-triggerButton')!;
  const publishArticleButton = doc.querySelector<HTMLButtonElement>('.PublishPanel-stepTwoButton')!;
  const submitButton = doc.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const draftStatusEl = doc.querySelector<HTMLElement>('.WriteIndex-draftStatus');

  const publishClickSpy: PublishClickSpy = vi.fn();
  publishButton.addEventListener('click', publishClickSpy);
  publishArticleButton.addEventListener('click', publishClickSpy);
  submitButton.addEventListener('click', publishClickSpy);

  const reactTitleTracker = attachReactValueTracker(titleInput);
  const pasteRecords =
    options?.simulateDraftJsPaste === false ? [] : attachDraftJsPasteHandler(editorElement);

  return {
    doc,
    url,
    titleInput,
    editorElement,
    fileInput,
    coverFileInput,
    publishButton,
    publishArticleButton,
    submitButton,
    publishClickSpy,
    draftStatusEl,
    reactTitleTracker,
    pasteRecords,
  };
}

export type QuestionAnswerEditorFixtureOptions = {
  url?: string;
  simulateDraftJsPaste?: boolean;
  includeFileInput?: boolean;
  includeEditor?: boolean;
  includeCommentBoxDecoy?: boolean;
  includeCommentFileInputDecoy?: boolean;
  mountToGlobalDocument?: boolean;
};

export function createZhihuQuestionAnswerEditorFixture(
  options?: QuestionAnswerEditorFixtureOptions,
) {
  const url = new URL(options?.url ?? ZHIHU_DEMO_URLS.questionPage);
  const includeFileInput = options?.includeFileInput ?? true;
  const includeEditor = options?.includeEditor ?? true;
  const includeCommentBoxDecoy = options?.includeCommentBoxDecoy ?? false;
  const includeCommentFileInputDecoy = options?.includeCommentFileInputDecoy ?? false;

  const editorMarkup = includeEditor
    ? `<div class="AnswerForm">
        ${includeFileInput ? '<input type="file" accept="image/*" class="UploadPicture-input" style="display: none" />' : ''}
        <div class="DraftEditor-root">
          <div class="public-DraftEditor-content" contenteditable="true" role="textbox" aria-label="回答编辑器">
            <div data-contents="true"><div data-block="true"><br data-text="true" /></div></div>
          </div>
        </div>
        <button type="button" class="Button AnswerForm-submit Button--primary Button--blue">发布回答</button>
      </div>`
    : '<button type="button" class="Button QuestionHeader-writeButton">写回答</button>';

  const commentDecoyMarkup =
    includeCommentBoxDecoy || includeCommentFileInputDecoy
      ? `<div class="CommentEditor">
          ${includeCommentFileInputDecoy ? '<input type="file" accept="image/*" class="CommentImage-input" style="display: none" />' : ''}
          ${includeCommentBoxDecoy ? '<div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div>' : ''}
        </div>`
      : '';

  const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>示例问题 - 知乎</title></head>
  <body>
    <header class="AppHeader">
      <input type="search" class="SearchBar-input" placeholder="搜索你感兴趣的内容" value="" />
      <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    </header>
    <main class="QuestionPage">
      <h1 class="QuestionHeader-title">示例问题：如何评估国产方案的实测表现？</h1>
      <section class="QuestionAnswers-answerAdd">
        ${editorMarkup}
      </section>
      ${commentDecoyMarkup}
    </main>
  </body>
</html>`;

  const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
  const searchInput = doc.querySelector<HTMLInputElement>('.SearchBar-input')!;
  const editorElement = doc.querySelector<HTMLElement>(
    '.AnswerForm .public-DraftEditor-content[contenteditable="true"]',
  );
  const fileInput = doc.querySelector<HTMLInputElement>('.AnswerForm input[type="file"]');
  const publishAnswerButton = doc.querySelector<HTMLButtonElement>('.AnswerForm-submit');

  const publishClickSpy: PublishClickSpy = vi.fn();
  if (publishAnswerButton) {
    publishAnswerButton.addEventListener('click', publishClickSpy);
  }

  const pasteRecords =
    editorElement && options?.simulateDraftJsPaste !== false
      ? attachDraftJsPasteHandler(editorElement)
      : [];

  return {
    doc,
    url,
    searchInput,
    editorElement,
    fileInput,
    publishAnswerButton,
    publishClickSpy,
    pasteRecords,
  };
}

export type LoggedOutFixtureVariant =
  | 'signin-page'
  | 'login-modal-only'
  | 'login-modal-overlay-editor'
  | 'logged-out-header'
  | 'hidden-login-modal-with-editor';

export function createZhihuLoggedOutFixture(
  variant: LoggedOutFixtureVariant,
  options?: { mountToGlobalDocument?: boolean; hideViaCssClass?: boolean },
) {
  const publishClickSpy: PublishClickSpy = vi.fn();

  if (variant === 'signin-page') {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>登录 - 知乎</title></head>
  <body>
    <main class="SignFlowHomepage">
      <div class="SignContainer-content">
        <form class="SignFlow">
          <div class="SignFlow-tabs">密码登录 / 验证码登录</div>
          <input name="username" type="text" placeholder="手机号或邮箱" />
          <input type="password" placeholder="密码" />
          <button type="submit" class="SignFlow-submitButton">登录</button>
        </form>
      </div>
    </main>
  </body>
</html>`;
    const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
    return {
      doc,
      url: new URL(ZHIHU_DEMO_URLS.signinPage),
      publishClickSpy,
    };
  }

  if (variant === 'login-modal-only') {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>写文章 - 知乎</title></head>
  <body>
    <div class="Modal-wrapper" role="dialog" aria-modal="true">
      <div class="Modal-inner">
        <div class="SignContainer-content">
          <form class="SignFlow">
            <p>登录知乎，发现更多可信赖的解答</p>
            <input name="phoneNo" type="text" placeholder="手机号" />
            <button type="submit" class="SignFlow-submitButton">登录/注册</button>
          </form>
        </div>
      </div>
    </div>
  </body>
</html>`;
    const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
    return {
      doc,
      url: new URL(ZHIHU_DEMO_URLS.zhuanlanWrite),
      publishClickSpy,
    };
  }

  if (variant === 'logged-out-header') {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>写文章 - 知乎</title></head>
  <body>
    <header class="AppHeader">
      <div class="AppHeader-userInfo">
        <a class="AppHeader-login" href="/signin">登录</a>
        <button type="button">注册</button>
      </div>
    </header>
    <main class="WriteIndex-empty">请先登录后开始创作</main>
  </body>
</html>`;
    const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
    return {
      doc,
      url: new URL(ZHIHU_DEMO_URLS.zhuanlanWrite),
      publishClickSpy,
    };
  }

  if (variant === 'login-modal-overlay-editor') {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>写文章 - 知乎</title></head>
  <body>
    <header class="ColumnPageHeader">
      <button type="button" class="PublishPanel-triggerButton">发布</button>
    </header>
    <main class="WriteIndex-editor PostEditor">
      <div class="WriteIndex-titleInput">
        <textarea placeholder="请输入标题（最多 100 个字）"></textarea>
      </div>
      <div class="DraftEditor-root">
        <div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div>
      </div>
    </main>
    <div class="Modal-wrapper" role="dialog" aria-modal="true">
      <div class="SignFlow">
        <p>请先登录知乎</p>
        <input name="username" type="text" />
      </div>
    </div>
  </body>
</html>`;
    const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
    const publishBtn = doc.querySelector<HTMLButtonElement>('.PublishPanel-triggerButton');
    publishBtn?.addEventListener('click', publishClickSpy);
    return {
      doc,
      url: new URL(ZHIHU_DEMO_URLS.zhuanlanWrite),
      titleInput: doc.querySelector<HTMLTextAreaElement>('.WriteIndex-titleInput textarea')!,
      editorElement: doc.querySelector<HTMLElement>('.public-DraftEditor-content')!,
      publishClickSpy,
    };
  }

  // hidden-login-modal-with-editor
  const styleBlock = options?.hideViaCssClass
    ? '<style>.SignFlow-hidden { display: none; }</style>'
    : '';
  const modalAttrs = options?.hideViaCssClass
    ? 'class="Modal-wrapper SignFlow-hidden"'
    : 'class="Modal-wrapper" hidden style="display: none"';

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>写文章 - 知乎</title>
    ${styleBlock}
  </head>
  <body>
    <header class="ColumnPageHeader">
      <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    </header>
    <main class="WriteIndex-editor PostEditor">
      <div class="WriteIndex-titleInput">
        <textarea placeholder="请输入标题（最多 100 个字）"></textarea>
      </div>
      <div class="DraftEditor-root">
        <div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div>
      </div>
    </main>
    <div ${modalAttrs}>
      <div class="SignFlow">
        <input name="username" type="text" />
      </div>
    </div>
  </body>
</html>`;

  const doc = parseFixtureDocument(html, options?.mountToGlobalDocument ?? false);
  return {
    doc,
    url: new URL(ZHIHU_DEMO_URLS.zhuanlanWrite),
    publishClickSpy,
  };
}

export type BrokenLayoutFixtureVariant = 'missing-all' | 'missing-body' | 'missing-title-zhuanlan';

export function createZhihuBrokenLayoutFixture(variant: BrokenLayoutFixtureVariant) {
  let mainContent = '<div class="EmptyShell">编辑器容器已变更</div>';
  if (variant === 'missing-body') {
    mainContent =
      '<div class="WriteIndex-titleInput"><textarea placeholder="请输入标题（最多 100 个字）"></textarea></div>';
  } else if (variant === 'missing-title-zhuanlan') {
    mainContent =
      '<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div></div>';
  }

  const html = `<!doctype html>
<html lang="zh-CN">
  <head><title>写文章 - 知乎</title></head>
  <body>
    <header class="ColumnPageHeader">
      <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
      <span class="WriteIndex-draftStatus">草稿自动保存</span>
    </header>
    <main class="WriteIndex-editor">${mainContent}</main>
  </body>
</html>`;

  const doc = parseFixtureDocument(html);
  return {
    doc,
    url: new URL(ZHIHU_DEMO_URLS.zhuanlanWrite),
  };
}

export function createZhihuPublishedPageFixture(options: {
  pageUrl: string;
  canonicalHref?: string;
  ogUrl?: string;
}) {
  const canonicalTag = options.canonicalHref
    ? `<link rel="canonical" href="${options.canonicalHref}" />`
    : '';
  const ogTag = options.ogUrl ? `<meta property="og:url" content="${options.ogUrl}" />` : '';

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>示例文章 - 知乎</title>
    ${canonicalTag}
    ${ogTag}
  </head>
  <body>
    <article class="Post-Main">
      <h1>示例品牌甲 2026 实测深度解析</h1>
      <div class="RichText">示例已发布正文内容。</div>
    </article>
  </body>
</html>`;

  const doc = parseFixtureDocument(html);
  return {
    doc,
    url: new URL(options.pageUrl),
  };
}
