import type {
  DraftInjectReport,
  ExtensionPendingTaskDto,
  FailedImageDetail,
  ImageUploadResult,
  LocalImageUploader,
  PlatformDraftAdapter,
} from '../types';
import { redactSensitiveText } from '../../shared/storage';
import {
  PUBLISHED_URL_PATTERNS,
  isValidZhihuQuestionUrl,
  validatePublicHttpsUrl,
  validatePublishedUrl,
} from '../../shared/url-validation';

export const ZHIHU_EDITOR_ENTRY_URL = 'https://zhuanlan.zhihu.com/write' as const;

export type ZhihuEditorMode = 'zhuanlan' | 'question';

export type SanitizedBodyContent = {
  html: string;
  plainText: string;
  buildFragment: (targetDoc: Document) => DocumentFragment;
};

const CAPTURE_BAR_HOST_SELECTOR = '#geomix-extension-capture-host';

export const ZHIHU_SELECTORS = {
  titleInputs: [
    '.WriteIndex-titleInput textarea',
    '.WriteIndex-titleInput input[type="text"]',
    '.WriteIndex-titleInput input:not([type])',
    '.PostEditor-titleInput textarea',
    '.PostEditor-titleInput input[type="text"]',
    '.PostEditor-titleInput input:not([type])',
    'textarea[placeholder*="请输入标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="请输入标题"]',
    'input[placeholder*="标题"]',
    '[data-testid="zhihu-title-input"]',
  ],
  questionBodyEditors: [
    '.AnswerForm .public-DraftEditor-content[contenteditable="true"]',
    '.QuestionAnswers-answerAdd .public-DraftEditor-content[contenteditable="true"]',
    '.WriteAnswer-editor .public-DraftEditor-content[contenteditable="true"]',
    '.AnswerForm .DraftEditor-root [contenteditable="true"]',
    '.QuestionAnswers-answerAdd [contenteditable="true"]',
    '.AnswerForm [role="textbox"][contenteditable="true"]',
    '.AnswerForm [contenteditable="true"]',
  ],
  zhuanlanBodyEditors: [
    '.PostEditor .public-DraftEditor-content[contenteditable="true"]',
    '.WriteIndex-editor .public-DraftEditor-content[contenteditable="true"]',
    '.public-DraftEditor-content[contenteditable="true"]',
    '.DraftEditor-root [contenteditable="true"]',
    '.RichText-editable[contenteditable="true"]',
    '[data-testid="zhihu-body-editor"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
  ],
  imageFileInputs: [
    '.WriteIndex-editor input[type="file"][accept*="image"]',
    '.PostEditor input[type="file"][accept*="image"]',
    '.AnswerForm input[type="file"][accept*="image"]',
    '.QuestionAnswers-answerAdd input[type="file"][accept*="image"]',
    'input.PostEditor-imageInput[type="file"]',
    'input.UploadPicture-input[type="file"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ],
  questionImageFileInputs: [
    '.AnswerForm input[type="file"][accept*="image"]',
    '.QuestionAnswers-answerAdd input[type="file"][accept*="image"]',
    '.WriteAnswer-editor input[type="file"][accept*="image"]',
    'input.UploadPicture-input[type="file"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ],
  signFlowContainers: [
    '.SignFlow',
    '.SignFlow-tabs',
    '.SignFlow-accountInput',
    '.SignFlowHomepage',
    '.SignContainer-content',
    '.Login-content',
    '[data-za-detail-view-path-module="SignFlow"]',
    'form.SignFlow',
  ],
  loginModalContainers: [
    '.Modal-wrapper',
    '.Modal-inner',
    '.Modal-content',
    '[role="dialog"]',
    '[aria-modal="true"]',
  ],
  loginModalInputs: [
    'input[name="username"]',
    'input[name="phoneNo"]',
    'input[name="digits"]',
    'input[type="password"]',
  ],
  loggedOutIndicators: [
    '.AppHeader-login',
    'a[href*="/signin"]',
    'a[href*="/login"]',
    '.SignFlow-submitButton',
  ],
  loggedInProfileIndicators: [
    '.AppHeader-profileAvatar',
    '.ColumnPageHeader-profile',
    'button[aria-label*="个人主页"]',
  ],
  loggedInShellIndicators: [
    '.AppHeader-profileAvatar',
    '.ColumnPageHeader-profile',
    'button[aria-label*="个人主页"]',
    '.WriteIndex-draftStatus',
    '.PostEditor',
    '.WriteIndex-titleInput',
    '.QuestionAnswers-answerAdd',
  ],
  questionPageMarkers: [
    '.AnswerForm',
    '.QuestionAnswers-answerAdd',
    '.WriteAnswer-editor',
    '.QuestionPage',
    '[data-za-detail-view-path-module="AnswerForm"]',
  ],
} as const;

const IMAGE_ACCEPT_PATTERN = /image\/|\*\/\*|\.(?:png|jpe?g|webp|gif|avif|bmp)\b/i;

const MAX_MARKDOWN_PAREN_DEPTH = 32;

const HARD_DROP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'noscript',
  'template',
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'track',
]);

const ALLOWED_SEMANTIC_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'code',
  'pre',
  'a',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'section',
  'figcaption',
  'sup',
  'sub',
]);

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'hr',
  'table',
  'tr',
  'div',
  'section',
  'figcaption',
]);

const ZHIHU_HOSTS: ReadonlySet<string> = new Set([
  'zhuanlan.zhihu.com',
  'www.zhihu.com',
  'passport.zhihu.com',
  'account.zhihu.com',
]);

const AUTH_PATH_PATTERN = /^\/(?:signin|signup|login|oauth|account\/unhuman)(?:\/|$)/i;
const ZHUANLAN_WRITE_PATH_PATTERN = /^\/write(?:\/|$)/;
const ZHUANLAN_EDIT_PATH_PATTERN = /^\/p\/\d+\/edit\/?$/;
const QUESTION_EDITOR_PATH_PATTERN = /^\/question\/\d+(?:\/write)?\/?$/;

const ALLOWED_PUBLISHED_SUBVIEWS: ReadonlySet<string> = new Set([
  'voters',
  'comments',
  'likes',
  'collectors',
]);
const ZHUANLAN_PUBLISHED_SUBVIEW_PATTERN = /^\/p\/(\d+)\/([a-z0-9_-]+)\/?$/i;
const ANSWER_PUBLISHED_SUBVIEW_PATTERN = /^\/question\/(\d+)\/answer\/(\d+)\/([a-z0-9_-]+)\/?$/i;

const LOGIN_MODAL_TEXT_PATTERN = /密码登录|验证码登录|登录\/注册|登录知乎|扫码登录|注册知乎/;
const LOGIN_CTA_TEXT_PATTERN = /^(?:登录|登录\/注册|注册|立即登录)$/;

function isInsideExcludedContainer(el: Element): boolean {
  return (
    el.closest(CAPTURE_BAR_HOST_SELECTOR) !== null ||
    el.closest('.SignFlow') !== null ||
    el.closest('[role="dialog"]') !== null
  );
}

function isHiddenElement(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  let current: Element | null = el;

  while (current) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return true;
    }

    const inlineStyle = (current as HTMLElement).style;
    if (inlineStyle) {
      const display = inlineStyle.display?.trim().toLowerCase();
      const visibility = inlineStyle.visibility?.trim().toLowerCase();
      if (display === 'none' || visibility === 'hidden') {
        return true;
      }
    }

    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const computed = view.getComputedStyle(current);
        if (computed.display === 'none' || computed.visibility === 'hidden') {
          return true;
        }
      } catch {
        // Ignore computed-style errors on detached or cross-realm elements
      }
    }

    current = current.parentElement;
  }

  return false;
}

function isStrictZhihuHttpsUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  const baseCheck = validatePublicHttpsUrl(url.href);
  return baseCheck.ok;
}

function classifyZhihuEditorRoute(url: URL): ZhihuEditorMode | null {
  if (!isStrictZhihuHttpsUrl(url)) {
    return null;
  }

  if (
    url.origin === 'https://zhuanlan.zhihu.com' &&
    (ZHUANLAN_WRITE_PATH_PATTERN.test(url.pathname) ||
      ZHUANLAN_EDIT_PATH_PATTERN.test(url.pathname))
  ) {
    return 'zhuanlan';
  }

  if (url.origin === 'https://www.zhihu.com' && QUESTION_EDITOR_PATH_PATTERN.test(url.pathname)) {
    return 'question';
  }

  return null;
}

function resolveZhihuDocumentUrl(doc: Document): URL | null {
  const rawHref = doc.defaultView?.location?.href || doc.URL;
  if (!rawHref || rawHref === 'about:blank') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawHref);
  } catch {
    return null;
  }

  if (!ZHIHU_HOSTS.has(parsed.hostname)) {
    return null;
  }

  return parsed;
}

function findTitleInput(doc: Document): HTMLTextAreaElement | HTMLInputElement | null {
  for (const selector of ZHIHU_SELECTORS.titleInputs) {
    const candidates = doc.querySelectorAll(selector);
    for (const candidate of candidates) {
      if (candidate.nodeType !== 1) {
        continue;
      }
      const tagName = candidate.tagName.toUpperCase();
      if (tagName !== 'TEXTAREA' && tagName !== 'INPUT') {
        continue;
      }
      const field = candidate as HTMLTextAreaElement | HTMLInputElement;
      if (tagName === 'INPUT') {
        const inputType = (field.getAttribute('type') ?? '').trim().toLowerCase();
        if (inputType !== '' && inputType !== 'text') {
          continue;
        }
      }
      if (field.disabled || field.readOnly) {
        continue;
      }
      if (field.closest('header, nav, .AppHeader, .SearchBar, [role="search"]') !== null) {
        continue;
      }
      if (isInsideExcludedContainer(field) || isHiddenElement(field)) {
        continue;
      }
      return field;
    }
  }

  return null;
}

function findBodyEditor(doc: Document, mode: ZhihuEditorMode): HTMLElement | null {
  const selectors =
    mode === 'question'
      ? [
          ...ZHIHU_SELECTORS.questionBodyEditors,
          '.public-DraftEditor-content[contenteditable="true"]',
          '.DraftEditor-root [contenteditable="true"]',
          '[data-testid="zhihu-body-editor"][contenteditable="true"]',
        ]
      : ZHIHU_SELECTORS.zhuanlanBodyEditors;

  for (const selector of selectors) {
    const candidates = doc.querySelectorAll(selector);
    for (const candidate of candidates) {
      if (candidate.nodeType !== 1) {
        continue;
      }
      if (candidate.getAttribute('contenteditable') !== 'true') {
        continue;
      }
      if (
        mode === 'question' &&
        (candidate.closest('.CommentEditor') !== null ||
          candidate.closest('.Comments-container') !== null ||
          candidate.closest('.CommentList') !== null)
      ) {
        continue;
      }
      if (isInsideExcludedContainer(candidate) || isHiddenElement(candidate)) {
        continue;
      }
      return candidate as HTMLElement;
    }
  }

  return null;
}

function acceptsImageFiles(input: HTMLInputElement): boolean {
  const accept = (input.getAttribute('accept') ?? '').trim();
  if (accept.length === 0) {
    return true;
  }
  return IMAGE_ACCEPT_PATTERN.test(accept);
}

function findImageFileInput(doc: Document, mode: ZhihuEditorMode): HTMLInputElement | null {
  const selectors =
    mode === 'question' ? ZHIHU_SELECTORS.questionImageFileInputs : ZHIHU_SELECTORS.imageFileInputs;

  for (const selector of selectors) {
    const candidates = doc.querySelectorAll(selector);
    for (const candidate of candidates) {
      if (candidate.nodeType !== 1 || candidate.tagName.toUpperCase() !== 'INPUT') {
        continue;
      }
      const input = candidate as HTMLInputElement;
      if (input.disabled) {
        continue;
      }
      if (!acceptsImageFiles(input)) {
        continue;
      }
      if (isInsideExcludedContainer(input)) {
        continue;
      }
      if (
        mode === 'question' &&
        (input.closest('.CommentEditor') !== null ||
          input.closest('.Comments-container') !== null ||
          input.closest('.CommentList') !== null)
      ) {
        continue;
      }
      if (
        input.closest('.WriteIndex-titleImage') !== null ||
        input.closest('.TitleImage') !== null ||
        input.closest('.TitleImage-wrapper') !== null
      ) {
        continue;
      }
      return input;
    }
  }

  return null;
}

function hasVisibleSelector(
  doc: Document,
  selectors: readonly string[],
  excludeContainers = false,
): boolean {
  for (const selector of selectors) {
    const matches = doc.querySelectorAll(selector);
    for (const el of matches) {
      if (el.closest(CAPTURE_BAR_HOST_SELECTOR) !== null) {
        continue;
      }
      if (excludeContainers && isInsideExcludedContainer(el)) {
        continue;
      }
      if (!isHiddenElement(el)) {
        return true;
      }
    }
  }
  return false;
}

function hasLoggedInProfileIndicator(doc: Document): boolean {
  return hasVisibleSelector(doc, ZHIHU_SELECTORS.loggedInProfileIndicators, true);
}

function hasLoggedInIndicator(doc: Document): boolean {
  return hasVisibleSelector(doc, ZHIHU_SELECTORS.loggedInShellIndicators, true);
}

function hasVisibleSignFlowOrLoginModal(doc: Document): boolean {
  if (hasVisibleSelector(doc, ZHIHU_SELECTORS.signFlowContainers)) {
    return true;
  }

  for (const selector of ZHIHU_SELECTORS.loginModalContainers) {
    const modals = doc.querySelectorAll(selector);
    for (const modal of modals) {
      if (modal.closest(CAPTURE_BAR_HOST_SELECTOR) !== null || isHiddenElement(modal)) {
        continue;
      }
      for (const inputSel of ZHIHU_SELECTORS.loginModalInputs) {
        const input = modal.querySelector(inputSel);
        if (input && !isHiddenElement(input)) {
          return true;
        }
      }
      const modalText = (modal.textContent ?? '').trim();
      if (modalText.length > 0 && LOGIN_MODAL_TEXT_PATTERN.test(modalText)) {
        return true;
      }
    }
  }

  return false;
}

function hasVisibleLoggedOutHeaderCta(doc: Document): boolean {
  if (hasVisibleSelector(doc, ZHIHU_SELECTORS.loggedOutIndicators)) {
    return true;
  }

  const headerControls = doc.querySelectorAll(
    'header button, header a, .AppHeader-userInfo button, .AppHeader-userInfo a, .ColumnPageHeader-Button button, .ColumnPageHeader-Button a',
  );
  for (const control of headerControls) {
    if (control.closest(CAPTURE_BAR_HOST_SELECTOR) !== null || isHiddenElement(control)) {
      continue;
    }
    const label = (control.textContent ?? '').trim();
    if (LOGIN_CTA_TEXT_PATTERN.test(label)) {
      return true;
    }
  }

  return false;
}

function detectAuthWall(doc: Document, url: URL | null, mode: ZhihuEditorMode): boolean {
  if (url) {
    if (url.hostname === 'passport.zhihu.com' || url.hostname === 'account.zhihu.com') {
      return true;
    }
    if (
      (url.hostname === 'www.zhihu.com' || url.hostname === 'zhuanlan.zhihu.com') &&
      AUTH_PATH_PATTERN.test(url.pathname)
    ) {
      return true;
    }
  }

  if (hasVisibleSignFlowOrLoginModal(doc)) {
    return true;
  }

  const hasEditor = findBodyEditor(doc, mode) !== null;
  if (!hasEditor && !hasLoggedInProfileIndicator(doc) && hasVisibleLoggedOutHeaderCta(doc)) {
    return true;
  }

  return false;
}

function detectInjectMode(
  doc: Document,
  task: ExtensionPendingTaskDto,
  pageUrl: URL | null,
): ZhihuEditorMode {
  if (pageUrl) {
    const routeMode = classifyZhihuEditorRoute(pageUrl);
    if (routeMode) {
      return routeMode;
    }
    if (pageUrl.origin === 'https://zhuanlan.zhihu.com') {
      return 'zhuanlan';
    }
  }

  for (const selector of ZHIHU_SELECTORS.questionPageMarkers) {
    const marker = doc.querySelector(selector);
    if (marker && !isInsideExcludedContainer(marker)) {
      return 'question';
    }
  }

  if (isValidZhihuQuestionUrl(task.targetUrlHint) && findTitleInput(doc) === null) {
    return 'question';
  }

  return 'zhuanlan';
}

function resolveNativeValueSetter(
  element: HTMLTextAreaElement | HTMLInputElement,
): ((this: HTMLTextAreaElement | HTMLInputElement, value: string) => void) | undefined {
  let currentProto: unknown = Object.getPrototypeOf(element);
  while (currentProto !== null && currentProto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(currentProto, 'value');
    if (typeof descriptor?.set === 'function') {
      return descriptor.set;
    }
    currentProto = Object.getPrototypeOf(currentProto);
  }

  const win = element.ownerDocument.defaultView;
  const isTextArea = element.tagName.toUpperCase() === 'TEXTAREA';
  const fallbackProto = isTextArea
    ? (win?.HTMLTextAreaElement?.prototype ?? globalThis.HTMLTextAreaElement?.prototype)
    : (win?.HTMLInputElement?.prototype ?? globalThis.HTMLInputElement?.prototype);

  if (fallbackProto) {
    const descriptor = Object.getOwnPropertyDescriptor(fallbackProto, 'value');
    if (typeof descriptor?.set === 'function') {
      return descriptor.set;
    }
  }

  return undefined;
}

function setReactControlledValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): void {
  const win = element.ownerDocument.defaultView;
  const nativeSetter = resolveNativeValueSetter(element);
  if (typeof nativeSetter === 'function') {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }

  try {
    element.focus();
  } catch {
    // Ignore focus errors in detached or headless documents
  }

  const InputEventCtor =
    win?.InputEvent ?? (typeof InputEvent !== 'undefined' ? InputEvent : undefined);
  const EventCtor = win?.Event ?? Event;

  let inputEvent: Event;
  if (typeof InputEventCtor === 'function') {
    try {
      inputEvent = new InputEventCtor('input', {
        bubbles: true,
        cancelable: false,
        data: value,
        inputType: 'insertText',
      });
    } catch {
      inputEvent = new EventCtor('input', { bubbles: true });
    }
  } else {
    inputEvent = new EventCtor('input', { bubbles: true });
  }

  element.dispatchEvent(inputEvent);
  element.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

function sanitizeNodeInto(source: Node, targetParent: Node, targetDoc: Document): void {
  if (source.nodeType === 3) {
    const text = source.textContent ?? '';
    if (text.length > 0) {
      targetParent.appendChild(targetDoc.createTextNode(text));
    }
    return;
  }

  if (source.nodeType !== 1) {
    return;
  }

  const el = source as Element;
  const tag = el.tagName.toLowerCase();

  if (HARD_DROP_TAGS.has(tag)) {
    return;
  }

  if (tag === 'a') {
    const rawHref = el.getAttribute('href')?.trim() ?? '';
    const hrefCheck = rawHref.length > 0 ? validatePublicHttpsUrl(rawHref) : null;
    if (hrefCheck?.ok) {
      const anchor = targetDoc.createElement('a');
      anchor.setAttribute('href', hrefCheck.normalizedUrl);
      anchor.setAttribute('rel', 'noopener noreferrer');
      for (const child of Array.from(el.childNodes)) {
        sanitizeNodeInto(child, anchor, targetDoc);
      }
      targetParent.appendChild(anchor);
    } else {
      for (const child of Array.from(el.childNodes)) {
        sanitizeNodeInto(child, targetParent, targetDoc);
      }
    }
    return;
  }

  if (ALLOWED_SEMANTIC_TAGS.has(tag)) {
    const cleanEl = targetDoc.createElement(tag);
    if (tag === 'td' || tag === 'th') {
      const colspan = el.getAttribute('colspan')?.trim();
      if (colspan && /^\d+$/.test(colspan)) {
        const parsed = Number(colspan);
        if (parsed >= 1 && parsed <= 20) {
          cleanEl.setAttribute('colspan', String(parsed));
        }
      }
      const rowspan = el.getAttribute('rowspan')?.trim();
      if (rowspan && /^\d+$/.test(rowspan)) {
        const parsed = Number(rowspan);
        if (parsed >= 1 && parsed <= 20) {
          cleanEl.setAttribute('rowspan', String(parsed));
        }
      }
    }
    for (const child of Array.from(el.childNodes)) {
      sanitizeNodeInto(child, cleanEl, targetDoc);
    }
    targetParent.appendChild(cleanEl);
    return;
  }

  for (const child of Array.from(el.childNodes)) {
    sanitizeNodeInto(child, targetParent, targetDoc);
  }
}

function extractPlainTextFromNodes(nodes: Iterable<Node>): string {
  const parts: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? '';
      if (text.length > 0) {
        parts.push(text);
      }
      return;
    }

    if (node.nodeType !== 1) {
      return;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br' || tag === 'hr') {
      parts.push('\n');
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock && parts.length > 0 && !parts[parts.length - 1]?.endsWith('\n')) {
      parts.push('\n');
    }

    for (const child of Array.from(el.childNodes)) {
      visit(child);
    }

    if (isBlock && !parts[parts.length - 1]?.endsWith('\n')) {
      parts.push('\n');
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return parts
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSanitizedContentFromContainer(container: HTMLElement): SanitizedBodyContent {
  const html = container.innerHTML;
  const plainText = extractPlainTextFromNodes(Array.from(container.childNodes));

  return {
    html,
    plainText,
    buildFragment: (targetDoc: Document): DocumentFragment => {
      const fragment = targetDoc.createDocumentFragment();
      for (const child of Array.from(container.childNodes)) {
        fragment.appendChild(targetDoc.importNode(child, true));
      }
      return fragment;
    },
  };
}

export function sanitizeZhihuHtml(rawHtml: string, doc: Document): SanitizedBodyContent {
  const inertDoc = doc.implementation.createHTMLDocument('');
  const template = inertDoc.createElement('template');
  template.innerHTML = rawHtml;

  const container = inertDoc.createElement('div');
  for (const child of Array.from(template.content.childNodes)) {
    sanitizeNodeInto(child, container, inertDoc);
  }

  return buildSanitizedContentFromContainer(container);
}

function buildBracketMatches(text: string): Map<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      stack.push(i);
    } else if (ch === ']' && stack.length > 0) {
      const openIndex = stack.pop();
      if (openIndex !== undefined) {
        matches.set(openIndex, i);
      }
    }
  }

  return matches;
}

function isMarkdownSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function parseMarkdownDestination(
  text: string,
  openParenIndex: number,
): { href: string; closeIndex: number } | null {
  if (text[openParenIndex] !== '(') {
    return null;
  }

  let i = openParenIndex + 1;
  while (i < text.length && isMarkdownSpace(text[i])) {
    i += 1;
  }

  if (i >= text.length) {
    return null;
  }

  if (text[i] === ')') {
    return { href: '', closeIndex: i };
  }

  let href = '';

  if (text[i] === '<') {
    const start = i + 1;
    i += 1;
    let closedAngle = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '>') {
        href = text.slice(start, i).trim();
        closedAngle = true;
        i += 1;
        break;
      }
      if (ch === '<' || ch === '\n' || ch === '\r') {
        return null;
      }
      i += 1;
    }
    if (!closedAngle) {
      return null;
    }
  } else {
    const start = i;
    let parenDepth = 0;
    let closedAtParen = false;

    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
        if (parenDepth > MAX_MARKDOWN_PAREN_DEPTH) {
          return null;
        }
        i += 1;
        continue;
      }
      if (ch === ')') {
        if (parenDepth === 0) {
          href = text.slice(start, i).trim();
          closedAtParen = true;
          break;
        }
        parenDepth -= 1;
        i += 1;
        continue;
      }
      if (isMarkdownSpace(ch)) {
        if (parenDepth !== 0) {
          return null;
        }
        href = text.slice(start, i).trim();
        break;
      }
      i += 1;
    }

    if (closedAtParen) {
      return { href, closeIndex: i };
    }
    if (i >= text.length || parenDepth !== 0) {
      return null;
    }
  }

  const wsStart = i;
  while (i < text.length && isMarkdownSpace(text[i])) {
    i += 1;
  }

  if (i >= text.length) {
    return null;
  }

  if (text[i] === ')') {
    return { href, closeIndex: i };
  }

  if (i === wsStart) {
    return null;
  }

  const titleOpen = text[i];
  if (titleOpen === '"' || titleOpen === "'") {
    i += 1;
    let closedQuote = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === titleOpen) {
        closedQuote = true;
        i += 1;
        break;
      }
      i += 1;
    }
    if (!closedQuote) {
      return null;
    }
  } else if (titleOpen === '(') {
    i += 1;
    let titleParenDepth = 0;
    let closedTitle = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '(') {
        titleParenDepth += 1;
        if (titleParenDepth > MAX_MARKDOWN_PAREN_DEPTH) {
          return null;
        }
      } else if (ch === ')') {
        if (titleParenDepth === 0) {
          closedTitle = true;
          i += 1;
          break;
        }
        titleParenDepth -= 1;
      }
      i += 1;
    }
    if (!closedTitle) {
      return null;
    }
  } else {
    return null;
  }

  while (i < text.length && isMarkdownSpace(text[i])) {
    i += 1;
  }

  if (i < text.length && text[i] === ')') {
    return { href, closeIndex: i };
  }

  return null;
}

function stripMarkdownImages(text: string): string {
  if (!text.includes('![')) {
    return text;
  }

  const bracketMatches = buildBracketMatches(text);
  let result = '';
  let textStart = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === '!' && text[i + 1] === '[') {
      const closeBracket = bracketMatches.get(i + 1);
      if (closeBracket !== undefined && text[closeBracket + 1] === '(') {
        const dest = parseMarkdownDestination(text, closeBracket + 1);
        if (dest !== null) {
          if (i > textStart) {
            result += text.slice(textStart, i);
          }
          i = dest.closeIndex + 1;
          textStart = i;
          continue;
        }
      }
    }
    i += 1;
  }

  if (textStart === 0) {
    return text;
  }
  if (textStart < text.length) {
    result += text.slice(textStart);
  }
  return result;
}

function appendInlineMarkdown(text: string, parent: Node, targetDoc: Document): void {
  const strippedImages = stripMarkdownImages(text);
  if (!strippedImages.includes('[')) {
    if (strippedImages.length > 0) {
      parent.appendChild(targetDoc.createTextNode(strippedImages));
    }
    return;
  }

  const bracketMatches = buildBracketMatches(strippedImages);
  let textStart = 0;
  let i = 0;

  const flushText = (endIndex: number): void => {
    if (endIndex > textStart) {
      parent.appendChild(targetDoc.createTextNode(strippedImages.slice(textStart, endIndex)));
    }
  };

  while (i < strippedImages.length) {
    if (strippedImages[i] === '[') {
      const closeBracket = bracketMatches.get(i);
      if (closeBracket !== undefined && strippedImages[closeBracket + 1] === '(') {
        const dest = parseMarkdownDestination(strippedImages, closeBracket + 1);
        if (dest !== null) {
          flushText(i);
          const label = strippedImages.slice(i + 1, closeBracket);
          if (label.length > 0) {
            const hrefCheck = dest.href.length > 0 ? validatePublicHttpsUrl(dest.href) : null;
            if (hrefCheck?.ok) {
              const anchor = targetDoc.createElement('a');
              anchor.setAttribute('href', hrefCheck.normalizedUrl);
              anchor.setAttribute('rel', 'noopener noreferrer');
              anchor.textContent = label;
              parent.appendChild(anchor);
            } else {
              parent.appendChild(targetDoc.createTextNode(label));
            }
          }
          i = dest.closeIndex + 1;
          textStart = i;
          continue;
        }
      }
    }
    i += 1;
  }

  flushText(strippedImages.length);
}

function buildSanitizedMarkdown(markdown: string, doc: Document): SanitizedBodyContent {
  const inertDoc = doc.implementation.createHTMLDocument('');
  const container = inertDoc.createElement('div');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let currentList: HTMLUListElement | HTMLOListElement | null = null;
  let paragraphBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) {
      return;
    }
    const merged = paragraphBuffer.join(' ').trim();
    paragraphBuffer = [];
    if (merged.length === 0) {
      return;
    }
    const p = inertDoc.createElement('p');
    appendInlineMarkdown(merged, p, inertDoc);
    if ((p.textContent ?? '').trim().length > 0) {
      container.appendChild(p);
    }
  };

  const closeList = (): void => {
    currentList = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      closeList();
      continue;
    }

    const withoutImages = stripMarkdownImages(trimmed).trim();
    if (withoutImages.length === 0) {
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(withoutImages)) {
      flushParagraph();
      closeList();
      container.appendChild(inertDoc.createElement('hr'));
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(withoutImages);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1]?.length ?? 2;
      const heading = inertDoc.createElement(`h${level}`);
      appendInlineMarkdown(headingMatch[2] ?? '', heading, inertDoc);
      if ((heading.textContent ?? '').trim().length > 0) {
        container.appendChild(heading);
      }
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(withoutImages);
    if (quoteMatch) {
      flushParagraph();
      closeList();
      const blockquote = inertDoc.createElement('blockquote');
      const p = inertDoc.createElement('p');
      appendInlineMarkdown(quoteMatch[1] ?? '', p, inertDoc);
      if ((p.textContent ?? '').trim().length > 0) {
        blockquote.appendChild(p);
        container.appendChild(blockquote);
      }
      continue;
    }

    const ulMatch = /^[-*+]\s+(.+)$/.exec(withoutImages);
    if (ulMatch) {
      flushParagraph();
      if (!currentList || currentList.tagName.toLowerCase() !== 'ul') {
        currentList = inertDoc.createElement('ul');
        container.appendChild(currentList);
      }
      const li = inertDoc.createElement('li');
      appendInlineMarkdown(ulMatch[1] ?? '', li, inertDoc);
      if ((li.textContent ?? '').trim().length > 0) {
        currentList.appendChild(li);
      }
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(withoutImages);
    if (olMatch) {
      flushParagraph();
      if (!currentList || currentList.tagName.toLowerCase() !== 'ol') {
        currentList = inertDoc.createElement('ol');
        container.appendChild(currentList);
      }
      const li = inertDoc.createElement('li');
      appendInlineMarkdown(olMatch[1] ?? '', li, inertDoc);
      if ((li.textContent ?? '').trim().length > 0) {
        currentList.appendChild(li);
      }
      continue;
    }

    closeList();
    paragraphBuffer.push(withoutImages);
  }

  flushParagraph();

  return buildSanitizedContentFromContainer(container);
}

function prepareBodyContent(task: ExtensionPendingTaskDto, doc: Document): SanitizedBodyContent {
  if (task.variantHtml.trim().length > 0) {
    const fromHtml = sanitizeZhihuHtml(task.variantHtml, doc);
    if (fromHtml.plainText.length > 0) {
      return fromHtml;
    }
    if (task.variantMarkdown.trim().length > 0) {
      return buildSanitizedMarkdown(task.variantMarkdown, doc);
    }
    return fromHtml;
  }

  return buildSanitizedMarkdown(task.variantMarkdown, doc);
}

function injectBodyIntoDraftEditor(
  doc: Document,
  bodyEditor: HTMLElement,
  content: SanitizedBodyContent,
): void {
  try {
    bodyEditor.focus();
  } catch {
    // Ignore focus errors in detached/headless documents
  }

  try {
    const selection = doc.getSelection?.();
    if (selection && typeof doc.createRange === 'function') {
      const range = doc.createRange();
      range.selectNodeContents(bodyEditor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {
    // Ignore selection errors in jsdom or disconnected DOM trees
  }

  const beforeHtml = bodyEditor.innerHTML;
  const beforeText = (bodyEditor.textContent ?? '').trim();

  const win = doc.defaultView;
  const DataTransferCtor = win?.DataTransfer ?? DataTransfer;
  const dt = new DataTransferCtor();
  dt.setData('text/html', content.html);
  dt.setData('text/plain', content.plainText);

  const ClipboardEventCtor =
    win?.ClipboardEvent ?? (typeof ClipboardEvent !== 'undefined' ? ClipboardEvent : undefined);
  const EventCtor = win?.Event ?? Event;

  const pasteEvent =
    typeof ClipboardEventCtor === 'function'
      ? new ClipboardEventCtor('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        })
      : new EventCtor('paste', { bubbles: true, cancelable: true });

  if ((pasteEvent as ClipboardEvent).clipboardData !== dt) {
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: dt,
      configurable: true,
    });
  }

  bodyEditor.dispatchEvent(pasteEvent);

  const afterHtml = bodyEditor.innerHTML;
  const afterText = (bodyEditor.textContent ?? '').trim();
  const pasteConsumed =
    pasteEvent.defaultPrevented || afterHtml !== beforeHtml || afterText !== beforeText;

  if (!pasteConsumed) {
    bodyEditor.replaceChildren(content.buildFragment(doc));

    const InputEventCtor =
      win?.InputEvent ?? (typeof InputEvent !== 'undefined' ? InputEvent : undefined);
    let inputEvent: Event;
    if (typeof InputEventCtor === 'function') {
      try {
        inputEvent = new InputEventCtor('input', {
          bubbles: true,
          cancelable: false,
          inputType: 'insertFromPaste',
          data: content.plainText,
        });
      } catch {
        inputEvent = new EventCtor('input', { bubbles: true });
      }
    } else {
      inputEvent = new EventCtor('input', { bubbles: true });
    }

    bodyEditor.dispatchEvent(inputEvent);
  }
}

function buildValidDraftUrl(pageUrl: URL | null): string | undefined {
  if (!pageUrl) {
    return undefined;
  }
  if (classifyZhihuEditorRoute(pageUrl) === null) {
    return undefined;
  }
  const normalizedPath = pageUrl.pathname.replace(/\/+$/, '') || '/';
  return `${pageUrl.origin}${normalizedPath}`;
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeFailedDetails(
  rawFailures: unknown[],
  mediaAssets: ExtensionPendingTaskDto['mediaAssets'],
  effectiveFailedImages: number,
): FailedImageDetail[] {
  const normalizedFromRaw: FailedImageDetail[] = [];

  for (const rawItem of rawFailures) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const rawUrl = typeof item.url === 'string' ? item.url : '';
    const rawAlt = typeof item.alt === 'string' ? item.alt : '';
    const rawReason = typeof item.reason === 'string' ? item.reason : '';

    normalizedFromRaw.push({
      url: redactSensitiveText(rawUrl).trim() || 'unknown-media-url',
      alt: redactSensitiveText(rawAlt).trim(),
      reason: redactSensitiveText(rawReason).trim() || '图片转存失败',
    });
  }

  if (normalizedFromRaw.length > 0) {
    return normalizedFromRaw;
  }

  const fallbackAssets = mediaAssets.slice(0, Math.max(1, effectiveFailedImages));
  if (fallbackAssets.length > 0) {
    return fallbackAssets.map((asset) => ({
      url: redactSensitiveText(asset.url).trim() || 'unknown-media-url',
      alt: redactSensitiveText(asset.alt).trim(),
      reason: '图片上传至知乎图床失败',
    }));
  }

  return [
    {
      url: 'unknown-media-url',
      alt: '',
      reason: '图片上传至知乎图床失败',
    },
  ];
}

function resolveExpectedCanonicalSubViewUrl(url: URL): string | null {
  if (!isStrictZhihuHttpsUrl(url)) {
    return null;
  }
  if (url.pathname.includes('//') || url.pathname.includes('%')) {
    return null;
  }

  if (url.origin === 'https://zhuanlan.zhihu.com') {
    const match = ZHUANLAN_PUBLISHED_SUBVIEW_PATTERN.exec(url.pathname);
    if (!match) {
      return null;
    }
    const articleId = match[1];
    const subView = match[2];
    if (!articleId || !subView || !ALLOWED_PUBLISHED_SUBVIEWS.has(subView.toLowerCase())) {
      return null;
    }
    return `https://zhuanlan.zhihu.com/p/${articleId}`;
  }

  if (url.origin === 'https://www.zhihu.com') {
    const match = ANSWER_PUBLISHED_SUBVIEW_PATTERN.exec(url.pathname);
    if (!match) {
      return null;
    }
    const questionId = match[1];
    const answerId = match[2];
    const subView = match[3];
    if (
      !questionId ||
      !answerId ||
      !subView ||
      !ALLOWED_PUBLISHED_SUBVIEWS.has(subView.toLowerCase())
    ) {
      return null;
    }
    return `https://www.zhihu.com/question/${questionId}/answer/${answerId}`;
  }

  return null;
}

export function createZhihuAdapter(): PlatformDraftAdapter {
  return {
    provider: 'ZHIHU_EXT',
    displayName: '知乎',
    editorEntryUrl: ZHIHU_EDITOR_ENTRY_URL,
    publishedUrlPatterns: PUBLISHED_URL_PATTERNS.ZHIHU_EXT,

    isLoggedInEditor(doc: Document, url: URL): boolean {
      const mode = classifyZhihuEditorRoute(url);
      if (mode === null) {
        return false;
      }

      if (detectAuthWall(doc, url, mode)) {
        return false;
      }

      return findBodyEditor(doc, mode) !== null || hasLoggedInIndicator(doc);
    },

    async injectDraft(
      doc: Document,
      task: ExtensionPendingTaskDto,
      uploader: LocalImageUploader,
    ): Promise<DraftInjectReport> {
      if (task.provider !== 'ZHIHU_EXT') {
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message: '任务渠道与知乎草稿适配器不匹配，无法注入草稿。',
        };
      }

      const pageUrl = resolveZhihuDocumentUrl(doc);
      const mode = detectInjectMode(doc, task, pageUrl);

      if (detectAuthWall(doc, pageUrl, mode)) {
        return {
          ok: false,
          stage: 'AUTH_REQUIRED',
          uploadedImages: 0,
          failedImages: 0,
          message: '检测到知乎尚未登录，请先在当前浏览器登录知乎账号后重试写入草稿箱。',
        };
      }

      const bodyEditor = findBodyEditor(doc, mode);
      if (!bodyEditor) {
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message:
            mode === 'question'
              ? '未在知乎问题页定位到已展开的回答编辑框，请先在页面展开回答编辑器后重试。'
              : '未在知乎专栏页面定位到正文编辑器，请等待页面加载完成后重试。',
        };
      }

      let titleInput: HTMLTextAreaElement | HTMLInputElement | null = null;
      if (mode === 'zhuanlan') {
        titleInput = findTitleInput(doc);
        if (!titleInput) {
          return {
            ok: false,
            stage: 'EDITOR_NOT_FOUND',
            uploadedImages: 0,
            failedImages: 0,
            message: '未在知乎专栏页面定位到标题输入框，请等待页面加载完成后重试。',
          };
        }
      }

      if (titleInput) {
        setReactControlledValue(titleInput, task.variantTitle);
      }

      const bodyContent = prepareBodyContent(task, doc);
      injectBodyIntoDraftEditor(doc, bodyEditor, bodyContent);

      let uploadResult: ImageUploadResult = {
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      };

      if (task.mediaAssets.length > 0) {
        const fileInput = findImageFileInput(doc, mode);
        try {
          uploadResult = await uploader.uploadAll(task.mediaAssets, {
            editorElement: bodyEditor,
            fileInput,
          });
        } catch (error: unknown) {
          const rawReason =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : '图片转存过程中发生异常';
          const safeReason = redactSensitiveText(rawReason).trim() || '图片转存过程中发生异常';
          uploadResult = {
            uploadedImages: 0,
            failedImages: task.mediaAssets.length,
            failures: task.mediaAssets.map((asset) => ({
              url: redactSensitiveText(asset.url).trim() || 'unknown-media-url',
              alt: redactSensitiveText(asset.alt).trim(),
              reason: safeReason,
            })),
          };
        }
      }

      const rawResult =
        uploadResult && typeof uploadResult === 'object'
          ? (uploadResult as Partial<ImageUploadResult>)
          : {};
      const rawFailures: unknown[] = Array.isArray(rawResult.failures) ? rawResult.failures : [];
      const uploadedImages = toNonNegativeInt(rawResult.uploadedImages);
      const reportedFailedImages = toNonNegativeInt(rawResult.failedImages);
      const effectiveFailedImages = Math.max(reportedFailedImages, rawFailures.length);

      const draftUrl = buildValidDraftUrl(pageUrl);

      if (effectiveFailedImages > 0) {
        const normalizedFailures = normalizeFailedDetails(
          rawFailures,
          task.mediaAssets,
          effectiveFailedImages,
        );

        const failedLabels = normalizedFailures.map(
          (item, index) => item.alt.trim() || `第 ${index + 1} 张配图`,
        );
        const failedSummary = failedLabels.join('、');

        return {
          ok: false,
          stage: 'PARTIAL_MEDIA_FAILED',
          ...(draftUrl ? { draftUrl } : {}),
          uploadedImages,
          failedImages: effectiveFailedImages,
          failedImageDetails: normalizedFailures,
          operatorReminders: [
            `以下配图未能自动转存至知乎原生图床，请手动补传：${failedSummary}`,
            '知乎编辑器会自动保存草稿，请补全配图并人工审阅排版后再手动发布。',
          ],
          message: `正文已写入知乎草稿区，但有 ${effectiveFailedImages} 张配图上传失败（${failedSummary}），请人工补传后再发布。`,
        };
      }

      return {
        ok: true,
        stage: 'INJECTED',
        ...(draftUrl ? { draftUrl } : {}),
        uploadedImages,
        failedImages: 0,
        message:
          mode === 'question'
            ? '已将内容写入知乎问题回答草稿区（自动保存草稿态），请人工审阅后手动发布。'
            : '已将标题与正文写入知乎专栏草稿箱（自动保存草稿态），请人工审阅后手动发布。',
      };
    },

    extractPublishedUrl(url: URL, doc: Document): string | null {
      const direct = validatePublishedUrl('ZHIHU_EXT', url.href);
      if (direct.ok) {
        return direct.normalizedUrl;
      }

      const expectedCanonicalUrl = resolveExpectedCanonicalSubViewUrl(url);
      if (!expectedCanonicalUrl) {
        return null;
      }

      const canonicalHref = doc
        .querySelector('link[rel="canonical"]')
        ?.getAttribute('href')
        ?.trim();
      if (!canonicalHref) {
        return null;
      }

      const canonicalCheck = validatePublishedUrl('ZHIHU_EXT', canonicalHref);
      if (!canonicalCheck.ok || canonicalCheck.normalizedUrl !== expectedCanonicalUrl) {
        return null;
      }

      return canonicalCheck.normalizedUrl;
    },
  };
}

export const zhihuAdapter: PlatformDraftAdapter = createZhihuAdapter();
