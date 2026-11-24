import { redactSensitiveText } from '../../shared/storage';
import {
  PUBLISHED_URL_PATTERNS,
  validatePublicHttpsUrl,
  validatePublishedUrl,
} from '../../shared/url-validation';
import type {
  DraftInjectReport,
  ExtensionPendingTaskDto,
  FailedImageDetail,
  ImageUploadResult,
  LocalImageUploader,
  PlatformDraftAdapter,
} from '../types';

export const SMZDM_EDITOR_ENTRY_URL = 'https://post.smzdm.com/tougao/' as const;

export const SMZDM_PUBLISHED_URL_PATTERNS: readonly RegExp[] = PUBLISHED_URL_PATTERNS.SMZDM_EXT;

export const SMZDM_OPERATOR_REMINDERS: readonly string[] = [
  '请在什么值得买编辑器中人工核对并插入对应的商品卡片（确认型号、价格与购买链接）。',
  '请在发布前人工核对文末合规披露声明（含利益相关说明、体验来源与实测条件），确认无误后再手动提交。',
] as const;

const SMZDM_EDITOR_PATH_PATTERN = /^\/tougao(?:\/.*)?$/;
const LOGIN_PATH_SEGMENT_PATTERN = /\/(?:user\/)?(?:login|signin|passport|oauth|auth)(?:\/|$)/i;

const HIDDEN_UTILITY_CLASSES: ReadonlySet<string> = new Set([
  'hidden',
  'hide',
  'is-hidden',
  'd-none',
  'sr-only',
]);

const LOGIN_GATE_ELEMENT_SELECTOR = [
  '.smzdm-login-modal',
  '[data-smzdm-login]:not([data-smzdm-login="false"])',
  '[data-auth-state="logged-out"]',
  '.login-modal',
  '#login-modal',
  '.z-login-dialog',
  '#J_login_popup',
  '.login-dialog',
  '.login-popup',
  '.passport-login',
  '.zhiyou-login',
  'form[action*="login"]',
  'form[action*="zhiyou.smzdm.com"]',
  'form[action*="passport.smzdm.com"]',
  'form.login-form',
  '.login-form',
  'input[type="password"]',
].join(', ');

const LOGIN_PROMPT_CONTAINER_SELECTOR = [
  '[role="dialog"]',
  '.modal',
  '.dialog',
  '.auth-tip',
  '.login-tip',
  '.login-prompt',
  '.unlogged-tip',
  '.login-gate',
  '.smzdm-login-gate',
].join(', ');

const LOGIN_PROMPT_KEYWORDS = [
  '请先登录',
  '登录后投稿',
  '登录后发布',
  '登录后继续',
  '账号登录',
  '扫码登录',
  '立即登录',
] as const;

const LOGGED_IN_SHELL_SELECTOR = [
  '.smzdm-creator-header',
  '.creator-user-name',
  '.z-header-user',
  '.user-avatar',
  '[data-smzdm-user]',
  '[data-auth-state="logged-in"]',
  '[data-logged-in="true"]',
  '[data-smzdm-editor]',
  '.smzdm-editor',
  '.tougao-editor',
  '.tougao-container',
].join(', ');

const TITLE_INPUT_SELECTORS = [
  'input[data-smzdm-title]',
  'textarea[data-smzdm-title]',
  'input[name="title"]',
  'textarea[name="title"]',
  'input#title',
  'textarea#title',
  'input.title-input',
  'input.post-title-input',
  'input.z-title-input',
  'textarea.title-input',
  'textarea.post-title-textarea',
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  '[data-smzdm-title][contenteditable="true"]',
  '[data-smzdm-title][contenteditable=""]',
  '[role="textbox"][aria-label*="标题"]',
] as const;

const FORBIDDEN_TITLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'hidden',
  'file',
  'checkbox',
  'radio',
  'password',
  'submit',
  'button',
]);

const BODY_EDITOR_SELECTORS = [
  '[data-smzdm-editor-body][contenteditable="true"]',
  '[data-smzdm-editor-body][contenteditable=""]',
  '.smzdm-editor-content[contenteditable="true"]',
  '.smzdm-editor-content[contenteditable=""]',
  '.tougao-editor-content[contenteditable="true"]',
  '.tougao-editor-content[contenteditable=""]',
  '.editor-content[contenteditable="true"]',
  '.editor-content[contenteditable=""]',
  '.ProseMirror[contenteditable="true"]',
  '.ProseMirror[contenteditable=""]',
  '.ql-editor[contenteditable="true"]',
  '.ql-editor[contenteditable=""]',
  '.w-e-text[contenteditable="true"]',
  '.w-e-text[contenteditable=""]',
  '.edui-body-container[contenteditable="true"]',
  '.edui-body-container[contenteditable=""]',
  '[role="textbox"][contenteditable="true"]',
  '[role="textbox"][contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  'textarea[data-smzdm-editor-body]',
  'textarea[name="content"]',
  'textarea.editor-body',
  'textarea[placeholder*="正文"]',
  'textarea[placeholder*="内容"]',
] as const;

const IMAGE_FILE_INPUT_SELECTORS = [
  'input[type="file"][data-smzdm-image-upload]',
  'input[type="file"][accept*="image"]',
  'input[type="file"][name*="image"]',
  'input[type="file"][name*="img"]',
  'input[type="file"][name*="pic"]',
  'input[type="file"]',
] as const;

const IMAGE_ACCEPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

const DROP_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'svg',
  'math',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'portal',
  'frame',
  'frameset',
  'head',
  'title',
  // Media tags are stripped so zero third-party external hotlinks slip into the editor DOM.
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'track',
  'canvas',
]);

const ALLOWED_HTML_TAGS: ReadonlySet<string> = new Set([
  // Parameter comparison tables
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  // Measured-data and structural blocks
  'section',
  'article',
  'aside',
  'div',
  'figure',
  'figcaption',
  'pre',
  'code',
  'blockquote',
  'dl',
  'dt',
  'dd',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  // Safe inline semantics
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'sup',
  'sub',
  'span',
  'small',
  'time',
  'a',
]);

const FORBIDDEN_DATA_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-src',
  'data-original',
  'data-url',
  'data-href',
  'data-srcset',
  'data-background',
]);

const ALLOWED_CELL_SCOPES: ReadonlySet<string> = new Set(['col', 'row', 'colgroup', 'rowgroup']);
const ALLOWED_CELL_ALIGNS: ReadonlySet<string> = new Set(['left', 'center', 'right', 'justify']);
const ALLOWED_CELL_VALIGNS: ReadonlySet<string> = new Set(['top', 'middle', 'bottom']);
const ALLOWED_OL_TYPES: ReadonlySet<string> = new Set(['1', 'a', 'A', 'i', 'I']);

const SAFE_CLASS_TOKEN_PATTERN = /^[a-zA-Z0-9_-]+$/;
const FORBIDDEN_CLASS_TOKEN_PATTERN =
  /(?:login|auth|passport|zhiyou|logged-out|smzdm-editor|smzdm-title)/i;
const SAFE_DATA_ATTR_NAME_PATTERN = /^data-[a-z0-9-]+$/;
const FORBIDDEN_DATA_ATTR_TOKEN_PATTERN =
  /(?:^|-)(?:src|srcset|url|href|uri|img|image|pic|photo|thumb|poster|bg|background|origin|original|lazy|actualsrc|file|link|login|auth|passport|zhiyou|logged|smzdm-login|smzdm-title|smzdm-editor)(?:-|$)/i;
const POSITIVE_SPAN_PATTERN = /^(?:[1-9]\d?|100)$/;
const INTEGER_PATTERN = /^-?\d+$/;
const UNSAFE_DATA_VALUE_SCHEME_PATTERN = /(?:javascript|vbscript|data|blob|file|https?|ftp)\s*:/i;
const PROTOCOL_RELATIVE_URL_PATTERN = /(?:^|[\s"'(=])\/\//;

const FORBIDDEN_PUBLISH_CN_KEYWORDS = [
  '提交',
  '审核',
  '发布',
  '发表',
  '上线',
  '推送',
  '投稿',
  '送审',
  '预览并发布',
  '删除',
  '清空',
  '作废',
] as const;

const FORBIDDEN_PUBLISH_EN_PATTERN =
  /(?:publish|submit|audit|review|release|approve|delete|remove|discard)/i;

const INVISIBLE_AND_WHITESPACE_PATTERN = /[\s\p{Cf}]+/gu;

const DRAFT_SAVE_ALLOWLIST_LABELS: ReadonlySet<string> = new Set([
  '保存草稿',
  '存草稿',
  '暂存草稿',
  '保存为草稿',
  '存入草稿箱',
  '保存草稿箱',
]);

const SAFE_DRAFT_ANCHOR_HREF_PATTERN = /^#(?:[a-zA-Z0-9_-]*)?$/;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const ALLOWED_ROLE_BUTTON_TAGS: ReadonlySet<string> = new Set([
  'DIV',
  'SPAN',
  'LI',
  'P',
  'I',
  'EM',
  'STRONG',
  'B',
]);

const FORM_SUBMIT_OVERRIDE_ATTRS = [
  'formaction',
  'formmethod',
  'formtarget',
  'formenctype',
  'formnovalidate',
] as const;

const INLINE_POINTER_HANDLER_ATTRS: ReadonlySet<string> = new Set([
  'onclick',
  'onmousedown',
  'onmouseup',
  'onpointerdown',
  'onpointerup',
  'ondblclick',
  'onauxclick',
]);

const INTERACTIVE_ANCESTOR_ROLES: ReadonlySet<string> = new Set(['button', 'link', 'menuitem']);

const GFM_TABLE_DELIMITER_CELL_PATTERN = /^:?-{3,}:?$/;
const GFM_TABLE_DELIMITER_CELL_BROAD_PATTERN = /^:?-+:?$/;
const FENCED_CODE_START_PATTERN = /^(`{3,}|~{3,})(.*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const ATX_HEADING_BOUNDARY_PATTERN = /^#{1,6}(?:[ \t]|$)/;
const HORIZONTAL_RULE_PATTERN = /^(?:-{3,}|\*{3,}|_{3,})$/;
const THEMATIC_BREAK_OR_SETEXT_PATTERN =
  /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|=+|-+)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;
const UNORDERED_LIST_PATTERN = /^[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^\d+\.\s+(.+)$/;
const LIST_ITEM_BOUNDARY_PATTERN = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_BLOCK_OPENER_PATTERN =
  /^<(?:!--|!|\?|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/i;
const HTML_BLOCK_LINE_CLOSE_PATTERN = /(?:<\/[a-z][a-z0-9-]*\s*>|-->|\?>|]]>)/i;

function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += value[i] ?? '';
  }
  return out;
}

function hasLoginRedirectQuery(url: URL): boolean {
  const needLogin = (url.searchParams.get('need_login') ?? '').trim().toLowerCase();
  const loginFlag = (url.searchParams.get('login') ?? '').trim().toLowerCase();
  const action = (url.searchParams.get('action') ?? '').trim().toLowerCase();
  if (needLogin === '1' || needLogin === 'true' || loginFlag === '1' || loginFlag === 'true') {
    return true;
  }
  if (action === 'login' || action === 'signin') {
    return true;
  }

  for (const paramName of ['redirect', 'redirect_to', 'return_url']) {
    const paramValue = url.searchParams.get(paramName);
    if (
      paramValue &&
      /(?:login|signin|zhiyou\.smzdm\.com|passport\.smzdm\.com)/i.test(paramValue)
    ) {
      return true;
    }
  }
  return false;
}

function isSmzdmEditorUrl(url: URL): boolean {
  if (url.protocol !== 'https:') {
    return false;
  }
  if (url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.hostname.toLowerCase() !== 'post.smzdm.com') {
    return false;
  }
  if (!SMZDM_EDITOR_PATH_PATTERN.test(url.pathname)) {
    return false;
  }
  if (LOGIN_PATH_SEGMENT_PATTERN.test(url.pathname)) {
    return false;
  }
  if (hasLoginRedirectQuery(url)) {
    return false;
  }
  return true;
}

function isSmzdmLoginUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'zhiyou.smzdm.com' || host === 'passport.smzdm.com') {
    return true;
  }
  if (
    (host === 'smzdm.com' || host.endsWith('.smzdm.com')) &&
    LOGIN_PATH_SEGMENT_PATTERN.test(url.pathname)
  ) {
    return true;
  }
  if (host === 'post.smzdm.com' && hasLoginRedirectQuery(url)) {
    return true;
  }
  return false;
}

function getDocumentUrl(doc: Document): URL | null {
  const rawHref = doc.location?.href ?? doc.URL;
  if (!rawHref || rawHref === 'about:blank') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawHref);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') {
    return null;
  }
  return parsed;
}

function isElementVisible(el: Element): boolean {
  const view = el.ownerDocument?.defaultView ?? null;
  let node: Element | null = el;

  while (node) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const inlineStyle = (node as Partial<HTMLElement>).style;
    if (inlineStyle) {
      const inlineDisplay = (inlineStyle.display ?? '').trim().toLowerCase();
      const inlineVisibility = (inlineStyle.visibility ?? '').trim().toLowerCase();
      const inlineOpacity = (inlineStyle.opacity ?? '').trim();
      if (inlineDisplay === 'none' || inlineVisibility === 'hidden' || inlineOpacity === '0') {
        return false;
      }
    }

    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const computed = view.getComputedStyle(node);
        if (
          computed.display === 'none' ||
          computed.visibility === 'hidden' ||
          computed.opacity === '0'
        ) {
          return false;
        }
      } catch {
        // Ignore cross-realm or detached getComputedStyle failures in jsdom.
      }
    }

    for (const token of Array.from(node.classList)) {
      if (HIDDEN_UTILITY_CLASSES.has(token)) {
        return false;
      }
    }

    node = node.parentElement;
  }

  return true;
}

function isInsideEditableContent(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute('contenteditable')) {
      const value = (node.getAttribute('contenteditable') ?? '').trim().toLowerCase();
      if (value === '' || value === 'true' || value === 'plaintext-only') {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

function containsLoginPromptKeyword(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, '');
  return LOGIN_PROMPT_KEYWORDS.some((keyword) => text.includes(keyword));
}

function hasDisabledState(el: Element): boolean {
  const maybeDisabled = (el as Partial<HTMLButtonElement>).disabled;
  if (maybeDisabled === true) {
    return true;
  }
  if (el.hasAttribute('disabled')) {
    return true;
  }
  if (el.getAttribute('aria-disabled') === 'true') {
    return true;
  }
  try {
    if (el.matches(':disabled')) {
      return true;
    }
  } catch {
    // Ignore selector errors on detached/non-standard nodes.
  }
  if (el.closest('fieldset[disabled]') !== null) {
    return true;
  }
  if (el.closest('[inert]') !== null) {
    return true;
  }
  return false;
}

function isInsideVisibleLoginGate(el: Element): boolean {
  const gateContainer = el.closest(LOGIN_GATE_ELEMENT_SELECTOR);
  if (
    gateContainer !== null &&
    !isInsideEditableContent(gateContainer) &&
    isElementVisible(gateContainer)
  ) {
    return true;
  }

  let node: Element | null = el;
  while (node) {
    if (
      node.matches(LOGIN_PROMPT_CONTAINER_SELECTOR) &&
      !isInsideEditableContent(node) &&
      isElementVisible(node) &&
      containsLoginPromptKeyword(node)
    ) {
      return true;
    }
    node = node.parentElement;
  }

  return false;
}

function hasVisibleLoginGate(doc: Document): boolean {
  if (
    doc.body?.getAttribute('data-auth-state') === 'logged-out' ||
    doc.body?.getAttribute('data-logged-in') === 'false' ||
    doc.documentElement?.getAttribute('data-logged-in') === 'false'
  ) {
    return true;
  }

  for (const el of Array.from(doc.querySelectorAll(LOGIN_GATE_ELEMENT_SELECTOR))) {
    if (isInsideEditableContent(el)) {
      continue;
    }
    if (isElementVisible(el)) {
      return true;
    }
  }

  for (const container of Array.from(doc.querySelectorAll(LOGIN_PROMPT_CONTAINER_SELECTOR))) {
    if (isInsideEditableContent(container) || !isElementVisible(container)) {
      continue;
    }
    if (containsLoginPromptKeyword(container)) {
      return true;
    }
  }

  for (const loginLink of Array.from(
    doc.querySelectorAll('a[href*="zhiyou.smzdm.com/user/login"], a[href*="passport.smzdm.com"]'),
  )) {
    if (isInsideEditableContent(loginLink) || !isElementVisible(loginLink)) {
      continue;
    }
    const bodyText = (doc.body?.textContent ?? '').replace(/\s+/g, '');
    if (LOGIN_PROMPT_KEYWORDS.some((keyword) => bodyText.includes(keyword))) {
      return true;
    }
  }

  return false;
}

function findTitleInput(doc: Document): HTMLElement | null {
  for (const selector of TITLE_INPUT_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (!isElementVisible(el) || hasDisabledState(el) || isInsideVisibleLoginGate(el)) {
        continue;
      }
      if (el.tagName.toUpperCase() === 'INPUT') {
        const inputType = (el.getAttribute('type') ?? 'text').trim().toLowerCase();
        if (FORBIDDEN_TITLE_INPUT_TYPES.has(inputType)) {
          continue;
        }
      }
      return el as HTMLElement;
    }
  }
  return null;
}

function findBodyEditor(doc: Document, titleEl: HTMLElement | null): HTMLElement | null {
  for (const selector of BODY_EDITOR_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (el === titleEl) {
        continue;
      }
      if (titleEl && (el.contains(titleEl) || titleEl.contains(el))) {
        continue;
      }
      if (!isElementVisible(el) || hasDisabledState(el) || isInsideVisibleLoginGate(el)) {
        continue;
      }
      if (selector === '[contenteditable="true"]' || selector === '[contenteditable=""]') {
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        if (ariaLabel.includes('标题') || el.hasAttribute('data-smzdm-title')) {
          continue;
        }
      }
      return el as HTMLElement;
    }
  }
  return null;
}

function hasLoggedInShell(doc: Document): boolean {
  for (const marker of Array.from(doc.querySelectorAll(LOGGED_IN_SHELL_SELECTOR))) {
    if (isElementVisible(marker)) {
      return true;
    }
  }
  const titleInput = findTitleInput(doc);
  if (titleInput !== null) {
    return true;
  }
  return findBodyEditor(doc, null) !== null;
}

function isImageCompatibleAccept(accept: string | null): boolean {
  if (!accept || accept.trim().length === 0) {
    return true;
  }
  const tokens = accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some(
    (token) =>
      token === '*/*' ||
      token === 'image/*' ||
      token.startsWith('image/') ||
      IMAGE_ACCEPT_EXTENSIONS.has(token),
  );
}

function findImageFileInput(doc: Document): HTMLInputElement | null {
  for (const selector of IMAGE_FILE_INPUT_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (el.tagName.toUpperCase() !== 'INPUT') {
        continue;
      }
      const input = el as HTMLInputElement;
      if (hasDisabledState(input) || isInsideVisibleLoginGate(input)) {
        continue;
      }
      if (!isImageCompatibleAccept(input.getAttribute('accept'))) {
        continue;
      }
      return input;
    }
  }
  return null;
}

function dispatchInputAndChange(el: HTMLElement, insertedText?: string): void {
  const view = el.ownerDocument?.defaultView ?? null;
  const EventCtor = view && typeof view.Event === 'function' ? view.Event : Event;
  const InputEventCtor =
    view !== null
      ? typeof view.InputEvent === 'function'
        ? view.InputEvent
        : null
      : typeof InputEvent === 'function'
        ? InputEvent
        : null;

  let inputEvent: Event;
  if (InputEventCtor) {
    try {
      inputEvent = new InputEventCtor('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        ...(insertedText !== undefined ? { data: insertedText } : {}),
      });
    } catch {
      inputEvent = new EventCtor('input', { bubbles: true, cancelable: false });
    }
  } else {
    inputEvent = new EventCtor('input', { bubbles: true, cancelable: false });
  }

  el.dispatchEvent(inputEvent);
  el.dispatchEvent(new EventCtor('change', { bubbles: true, cancelable: false }));
}

function setNativeControlValue(el: HTMLElement, value: string): void {
  const view = el.ownerDocument?.defaultView ?? null;
  const tag = el.tagName.toUpperCase();

  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const ownProto = Object.getPrototypeOf(el) as object | null;
    const fallbackProto =
      tag === 'INPUT'
        ? (view?.HTMLInputElement?.prototype ??
          (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : undefined))
        : (view?.HTMLTextAreaElement?.prototype ??
          (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : undefined));
    const setter =
      (ownProto ? Object.getOwnPropertyDescriptor(ownProto, 'value')?.set : undefined) ??
      (fallbackProto ? Object.getOwnPropertyDescriptor(fallbackProto, 'value')?.set : undefined);
    if (setter) {
      try {
        setter.call(el, value);
      } catch {
        (el as HTMLInputElement | HTMLTextAreaElement).value = value;
      }
    } else {
      (el as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
  } else {
    el.textContent = value;
  }

  try {
    el.focus?.();
  } catch {
    // Ignore focus errors in detached/non-interactive documents.
  }

  dispatchInputAndChange(el, value);
}

function copySafeAttributes(source: Element, target: HTMLElement, tag: string): void {
  const rawClass = source.getAttribute('class');
  if (rawClass) {
    const safeTokens = rawClass
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          SAFE_CLASS_TOKEN_PATTERN.test(token) && !FORBIDDEN_CLASS_TOKEN_PATTERN.test(token),
      );
    if (safeTokens.length > 0) {
      target.setAttribute('class', safeTokens.join(' '));
    }
  }

  const rawTitle = source.getAttribute('title');
  if (rawTitle) {
    const cleanTitle = stripControlChars(rawTitle).trim();
    if (cleanTitle.length > 0) {
      target.setAttribute('title', cleanTitle);
    }
  }

  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    if (!name.startsWith('data-')) {
      continue;
    }
    if (
      !SAFE_DATA_ATTR_NAME_PATTERN.test(name) ||
      FORBIDDEN_DATA_ATTRIBUTES.has(name) ||
      FORBIDDEN_DATA_ATTR_TOKEN_PATTERN.test(name)
    ) {
      continue;
    }
    const cleanValue = stripControlChars(attr.value).trim();
    if (
      UNSAFE_DATA_VALUE_SCHEME_PATTERN.test(cleanValue) ||
      PROTOCOL_RELATIVE_URL_PATTERN.test(cleanValue)
    ) {
      continue;
    }
    target.setAttribute(name, cleanValue);
  }

  if (tag === 'td' || tag === 'th') {
    const colspan = (source.getAttribute('colspan') ?? '').trim();
    if (POSITIVE_SPAN_PATTERN.test(colspan)) {
      target.setAttribute('colspan', colspan);
    }
    const rowspan = (source.getAttribute('rowspan') ?? '').trim();
    if (POSITIVE_SPAN_PATTERN.test(rowspan)) {
      target.setAttribute('rowspan', rowspan);
    }
    const scope = (source.getAttribute('scope') ?? '').trim().toLowerCase();
    if (ALLOWED_CELL_SCOPES.has(scope)) {
      target.setAttribute('scope', scope);
    }
    const align = (source.getAttribute('align') ?? '').trim().toLowerCase();
    if (ALLOWED_CELL_ALIGNS.has(align)) {
      target.setAttribute('align', align);
    }
    const valign = (source.getAttribute('valign') ?? '').trim().toLowerCase();
    if (ALLOWED_CELL_VALIGNS.has(valign)) {
      target.setAttribute('valign', valign);
    }
  } else if (tag === 'col' || tag === 'colgroup') {
    const span = (source.getAttribute('span') ?? '').trim();
    if (POSITIVE_SPAN_PATTERN.test(span)) {
      target.setAttribute('span', span);
    }
  } else if (tag === 'table') {
    const summary = source.getAttribute('summary');
    if (summary) {
      const cleanSummary = stripControlChars(summary).trim();
      if (cleanSummary.length > 0) {
        target.setAttribute('summary', cleanSummary);
      }
    }
  } else if (tag === 'ol') {
    const start = (source.getAttribute('start') ?? '').trim();
    if (INTEGER_PATTERN.test(start)) {
      target.setAttribute('start', start);
    }
    const listType = (source.getAttribute('type') ?? '').trim();
    if (ALLOWED_OL_TYPES.has(listType)) {
      target.setAttribute('type', listType);
    }
  }
}

function sanitizeNodeInto(doc: Document, sourceNode: Node, parent: Node): void {
  if (sourceNode.nodeType === 3) {
    parent.appendChild(doc.createTextNode(sourceNode.nodeValue ?? ''));
    return;
  }

  if (sourceNode.nodeType !== 1) {
    return;
  }

  const sourceEl = sourceNode as Element;
  const tag = sourceEl.tagName.toLowerCase();

  if (DROP_SUBTREE_TAGS.has(tag)) {
    return;
  }

  if (!ALLOWED_HTML_TAGS.has(tag)) {
    for (const child of Array.from(sourceEl.childNodes)) {
      sanitizeNodeInto(doc, child, parent);
    }
    return;
  }

  if (tag === 'a') {
    const rawHref = sourceEl.getAttribute('href') ?? '';
    const hrefCheck = validatePublicHttpsUrl(rawHref);
    if (!hrefCheck.ok) {
      for (const child of Array.from(sourceEl.childNodes)) {
        sanitizeNodeInto(doc, child, parent);
      }
      return;
    }

    const anchor = doc.createElement('a');
    copySafeAttributes(sourceEl, anchor, tag);
    anchor.setAttribute('href', hrefCheck.normalizedUrl);
    anchor.setAttribute('rel', 'noopener noreferrer');
    for (const child of Array.from(sourceEl.childNodes)) {
      sanitizeNodeInto(doc, child, anchor);
    }
    parent.appendChild(anchor);
    return;
  }

  const cleanEl = doc.createElement(tag);
  copySafeAttributes(sourceEl, cleanEl, tag);
  for (const child of Array.from(sourceEl.childNodes)) {
    sanitizeNodeInto(doc, child, cleanEl);
  }

  if (
    tag === 'figure' &&
    cleanEl.children.length === 0 &&
    (cleanEl.textContent ?? '').trim().length === 0
  ) {
    return;
  }

  parent.appendChild(cleanEl);
}

export function sanitizeSmzdmHtmlToFragment(doc: Document, rawHtml: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  if (!rawHtml || rawHtml.trim().length === 0) {
    return fragment;
  }

  const sandboxDoc = doc.implementation.createHTMLDocument('');
  sandboxDoc.body.innerHTML = rawHtml;

  for (const child of Array.from(sandboxDoc.body.childNodes)) {
    sanitizeNodeInto(doc, child, fragment);
  }

  return fragment;
}

const CHAR_LT = 60; // '<'
const CHAR_GT = 62; // '>'
const CHAR_SLASH = 47; // '/'
const CHAR_EQ = 61; // '='
const CHAR_DQUOTE = 34; // '"'
const CHAR_SQUOTE = 39; // "'"
const CHAR_DASH = 45; // '-'
const CHAR_UNDERSCORE = 95; // '_'
const CHAR_DOT = 46; // '.'

const RAW_HTML_PAIRED_DROP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'svg',
  'object',
  'embed',
  'applet',
  'math',
  'noscript',
  'template',
  'form',
  'picture',
  'video',
  'audio',
  'canvas',
  'head',
  'title',
  'frameset',
  'textarea',
  'select',
  'option',
  'button',
  'portal',
]);

const RAW_HTML_VOID_DROP_TAGS: ReadonlySet<string> = new Set([
  'img',
  'source',
  'track',
  'input',
  'link',
  'meta',
  'base',
  'frame',
]);

const FORBIDDEN_RAW_HTML_ATTR_NAMES: ReadonlySet<string> = new Set([
  'style',
  'src',
  'srcset',
  'srcdoc',
  'poster',
  'background',
  'formaction',
  'href',
  'xlink:href',
  'action',
  'ping',
  'dynsrc',
  'lowsrc',
]);

const MAX_SANITIZE_CONVERGENCE_PASSES = 6;
const MAX_INLINE_MARKDOWN_DEPTH = 4;
const MAX_EMPHASIS_STACK_DEPTH = 64;
const MAX_URL_PAREN_DEPTH = 32;

type HtmlAttrCollectMode = 'none' | 'href-only' | 'all';

type ScannedHtmlAttr = {
  readonly name: string;
  readonly value: string;
  readonly rawSegment: string;
};

type ScannedHtmlTag = {
  readonly start: number;
  readonly end: number;
  readonly isClosing: boolean;
  readonly rawName: string;
  readonly lowerName: string;
  readonly selfClosing: boolean;
  readonly hasAttrs: boolean;
  readonly attrs: readonly ScannedHtmlAttr[];
};

type ClosingTagSpan = {
  readonly start: number;
  readonly end: number;
};

type HtmlScanContext = {
  readonly input: string;
  readonly len: number;
  readonly lastGtIndex: number;
  readonly lastDQuoteIndex: number;
  readonly lastSQuoteIndex: number;
  deadBeforeAttr: Uint8Array | null;
  deadUnquoted: Uint8Array | null;
  readonly noClosingTagAfter: Map<string, number>;
};

type HtmlPairsPassResult = {
  readonly output: string;
  readonly changed: boolean;
  readonly sawUnclosedDropOpen: boolean;
  readonly sawStrayDropClose: boolean;
  readonly sawOtherOpenTag: boolean;
};

type InlineScanIndex = {
  readonly bracketClose: Int32Array;
  readonly prefixBangBracket: Int32Array;
  readonly codeSpanEnd: Int32Array;
  readonly lastCloseParen: number;
  readonly lastGt: number;
  readonly lastDoubleQuote: number;
  readonly lastSingleQuote: number;
  readonly lastBacktick: number;
};

type ParsedParenDestination = {
  readonly url: string;
  readonly endIndex: number;
};

type AtomicInlineToken =
  | { readonly kind: 'text'; readonly raw: string }
  | {
      readonly kind: 'linked-image';
      readonly alt: string;
      readonly imageUrl: string;
      readonly linkUrl: string;
      readonly raw: string;
    }
  | {
      readonly kind: 'image';
      readonly alt: string;
      readonly imageUrl: string;
      readonly raw: string;
    }
  | {
      readonly kind: 'link';
      readonly label: string;
      readonly linkUrl: string;
      readonly raw: string;
    }
  | { readonly kind: 'code'; readonly content: string; readonly raw: string };

type InlineMarkdownNode =
  | AtomicInlineToken
  | { readonly kind: 'strong'; readonly children: readonly InlineMarkdownNode[] }
  | { readonly kind: 'em'; readonly children: readonly InlineMarkdownNode[] };

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isHtmlTagNameChar(code: number): boolean {
  return (
    isAsciiAlpha(code) ||
    (code >= 48 && code <= 57) ||
    code === CHAR_DASH ||
    code === CHAR_UNDERSCORE ||
    code === CHAR_DOT
  );
}

function isHtmlWhitespace(code: number): boolean {
  // WHATWG HTML5 §13.2.5 ASCII whitespace: TAB, LF, FF, CR, SPACE
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isMarkdownEscapable(code: number): boolean {
  // CommonMark §2.4 ASCII punctuation characters
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function createHtmlScanContext(input: string): HtmlScanContext {
  const lastGtIndex = input.lastIndexOf('>');
  return {
    input,
    len: input.length,
    lastGtIndex,
    lastDQuoteIndex: lastGtIndex === -1 ? -1 : input.lastIndexOf('"'),
    lastSQuoteIndex: lastGtIndex === -1 ? -1 : input.lastIndexOf("'"),
    deadBeforeAttr: null,
    deadUnquoted: null,
    noClosingTagAfter: new Map<string, number>(),
  };
}

function isForbiddenRawHtmlAttribute(attrName: string, attrValue: string): boolean {
  const lowerName = attrName.toLowerCase();
  if (
    lowerName.length >= 3 &&
    lowerName.startsWith('on') &&
    isAsciiAlpha(lowerName.charCodeAt(2))
  ) {
    return true;
  }
  if (FORBIDDEN_RAW_HTML_ATTR_NAMES.has(lowerName)) {
    return true;
  }
  if (lowerName.startsWith('data-')) {
    if (
      !SAFE_DATA_ATTR_NAME_PATTERN.test(lowerName) ||
      FORBIDDEN_DATA_ATTRIBUTES.has(lowerName) ||
      FORBIDDEN_DATA_ATTR_TOKEN_PATTERN.test(lowerName)
    ) {
      return true;
    }
    const cleanValue = stripControlChars(attrValue).trim();
    if (
      UNSAFE_DATA_VALUE_SCHEME_PATTERN.test(cleanValue) ||
      PROTOCOL_RELATIVE_URL_PATTERN.test(cleanValue)
    ) {
      return true;
    }
  }
  return false;
}

function markHtmlScanDead(
  ctx: HtmlScanContext,
  visitedBeforeAttr: readonly number[],
  visitedUnquotedRuns: readonly number[],
): null {
  if (visitedBeforeAttr.length > 0) {
    let dead = ctx.deadBeforeAttr;
    if (dead === null) {
      dead = new Uint8Array(ctx.len);
      ctx.deadBeforeAttr = dead;
    }
    for (let k = 0; k < visitedBeforeAttr.length; k += 1) {
      const idx = visitedBeforeAttr[k];
      if (idx !== undefined) {
        dead[idx] = 1;
      }
    }
  }
  if (visitedUnquotedRuns.length > 0) {
    let deadUq = ctx.deadUnquoted;
    if (deadUq === null) {
      deadUq = new Uint8Array(ctx.len);
      ctx.deadUnquoted = deadUq;
    }
    for (let k = 0; k < visitedUnquotedRuns.length; k += 2) {
      const runStart = visitedUnquotedRuns[k];
      const runEnd = visitedUnquotedRuns[k + 1];
      if (runStart !== undefined && runEnd !== undefined) {
        deadUq.fill(1, runStart, runEnd);
      }
    }
  }
  return null;
}

function scanHtmlTag(
  ctx: HtmlScanContext,
  start: number,
  attrMode: HtmlAttrCollectMode = 'all',
): ScannedHtmlTag | null {
  const { input, len, lastGtIndex } = ctx;
  if (lastGtIndex === -1 || start >= lastGtIndex) {
    return null;
  }
  if (input.charCodeAt(start) !== CHAR_LT) {
    return null;
  }

  let pos = start + 1;
  if (pos >= len) {
    return null;
  }

  let isClosing = false;
  if (input.charCodeAt(pos) === CHAR_SLASH) {
    isClosing = true;
    pos += 1;
    if (pos >= len) {
      return null;
    }
  }

  if (!isAsciiAlpha(input.charCodeAt(pos))) {
    return null;
  }

  const nameStart = pos;
  pos += 1;
  while (pos < len && isHtmlTagNameChar(input.charCodeAt(pos))) {
    pos += 1;
  }

  if (pos >= len) {
    return null;
  }

  const boundaryCode = input.charCodeAt(pos);
  if (boundaryCode !== CHAR_GT && boundaryCode !== CHAR_SLASH && !isHtmlWhitespace(boundaryCode)) {
    return null;
  }

  if (boundaryCode === CHAR_GT) {
    const rawName = input.slice(nameStart, pos);
    return {
      start,
      end: pos + 1,
      isClosing,
      rawName,
      lowerName: rawName.toLowerCase(),
      selfClosing: false,
      hasAttrs: false,
      attrs: [],
    };
  }

  if (ctx.deadBeforeAttr !== null && ctx.deadBeforeAttr[pos] === 1) {
    return null;
  }

  const rawName = input.slice(nameStart, pos);
  const lowerName = rawName.toLowerCase();
  const collectAllAttrs = attrMode === 'all' && !isClosing;
  const collectHrefOnly = attrMode === 'href-only' && !isClosing && lowerName === 'a';
  const attrs: ScannedHtmlAttr[] = [];
  const visitedBeforeAttr: number[] = [];
  const visitedUnquotedRuns: number[] = [];
  let hasAttrs = false;

  while (pos < len) {
    // BEFORE_ATTR_NAME (HTML5 §13.2.5.32)
    if (ctx.deadBeforeAttr !== null && ctx.deadBeforeAttr[pos] === 1) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }
    visitedBeforeAttr.push(pos);

    let lastWasSlash = false;
    while (pos < len) {
      const c = input.charCodeAt(pos);
      if (isHtmlWhitespace(c)) {
        lastWasSlash = false;
        pos += 1;
        continue;
      }
      if (c === CHAR_SLASH) {
        lastWasSlash = true;
        pos += 1;
        continue;
      }
      break;
    }

    if (pos >= len) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }

    if (ctx.deadBeforeAttr !== null && ctx.deadBeforeAttr[pos] === 1) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }
    visitedBeforeAttr.push(pos);

    const lead = input.charCodeAt(pos);
    if (lead === CHAR_GT) {
      return {
        start,
        end: pos + 1,
        isClosing,
        rawName,
        lowerName,
        selfClosing: lastWasSlash,
        hasAttrs,
        attrs,
      };
    }

    // ATTR_NAME (HTML5 §13.2.5.33): quotes inside attr names are literal, NEVER start quoted mode.
    // An unexpected leading '=' begins an attribute name starting with '=' (HTML5 §13.2.5.32).
    const attrNameStart = pos;
    if (lead === CHAR_EQ) {
      pos += 1;
    }
    while (pos < len) {
      const c = input.charCodeAt(pos);
      if (isHtmlWhitespace(c) || c === CHAR_SLASH || c === CHAR_EQ || c === CHAR_GT) {
        break;
      }
      pos += 1;
    }
    const attrNameEnd = pos;
    hasAttrs = true;

    // AFTER_ATTR_NAME (HTML5 §13.2.5.34)
    while (pos < len && isHtmlWhitespace(input.charCodeAt(pos))) {
      pos += 1;
    }

    if (pos >= len) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }

    if (input.charCodeAt(pos) !== CHAR_EQ) {
      if (collectAllAttrs) {
        const attrName = input.slice(attrNameStart, attrNameEnd);
        attrs.push({ name: attrName, value: '', rawSegment: attrName });
      }
      continue;
    }

    // Consume '=' -> BEFORE_ATTR_VALUE (HTML5 §13.2.5.35)
    pos += 1;
    while (pos < len && isHtmlWhitespace(input.charCodeAt(pos))) {
      pos += 1;
    }

    if (pos >= len) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }

    const valLead = input.charCodeAt(pos);
    if (valLead === CHAR_GT) {
      // Missing attribute value immediately before '>' closes tag (HTML5 §13.2.5.35)
      if (collectAllAttrs) {
        const attrName = input.slice(attrNameStart, attrNameEnd);
        attrs.push({ name: attrName, value: '', rawSegment: `${attrName}=""` });
      }
      return {
        start,
        end: pos + 1,
        isClosing,
        rawName,
        lowerName,
        selfClosing: false,
        hasAttrs,
        attrs,
      };
    }

    if (valLead === CHAR_DQUOTE || valLead === CHAR_SQUOTE) {
      // DOUBLE_QUOTED (§13.2.5.36) / SINGLE_QUOTED (§13.2.5.37)
      // Quotes ONLY enter quoted mode immediately after '=' + optional whitespace.
      const lastQuoteIdx = valLead === CHAR_DQUOTE ? ctx.lastDQuoteIndex : ctx.lastSQuoteIndex;
      if (pos >= lastQuoteIdx) {
        return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
      }
      const quoteChar = valLead === CHAR_DQUOTE ? '"' : "'";
      const valStart = pos + 1;
      const closeQuoteIdx = input.indexOf(quoteChar, valStart);
      if (closeQuoteIdx === -1) {
        return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
      }
      if (collectAllAttrs) {
        const attrName = input.slice(attrNameStart, attrNameEnd);
        const value = input.slice(valStart, closeQuoteIdx);
        attrs.push({
          name: attrName,
          value,
          rawSegment: `${attrName}=${quoteChar}${value}${quoteChar}`,
        });
      } else if (
        collectHrefOnly &&
        attrNameEnd - attrNameStart === 4 &&
        input.slice(attrNameStart, attrNameEnd).toLowerCase() === 'href'
      ) {
        attrs.push({
          name: 'href',
          value: input.slice(valStart, closeQuoteIdx),
          rawSegment: '',
        });
      }
      pos = closeQuoteIdx + 1;
      continue;
    }

    // UNQUOTED_VALUE (§13.2.5.38): quotes (' / ") and '/' are literal and NEVER swallow '>'.
    const deadUq = ctx.deadUnquoted;
    if (deadUq !== null && deadUq[pos] === 1) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }
    const valStart = pos;
    while (pos < len) {
      if (deadUq !== null && deadUq[pos] === 1) {
        if (pos > valStart) {
          visitedUnquotedRuns.push(valStart, pos);
        }
        return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
      }
      const c = input.charCodeAt(pos);
      if (isHtmlWhitespace(c) || c === CHAR_GT) {
        break;
      }
      pos += 1;
    }
    if (pos > valStart) {
      visitedUnquotedRuns.push(valStart, pos);
    }
    if (pos >= len) {
      return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
    }
    if (collectAllAttrs) {
      const attrName = input.slice(attrNameStart, attrNameEnd);
      const value = input.slice(valStart, pos);
      attrs.push({
        name: attrName,
        value,
        rawSegment: `${attrName}=${value}`,
      });
    } else if (
      collectHrefOnly &&
      attrNameEnd - attrNameStart === 4 &&
      input.slice(attrNameStart, attrNameEnd).toLowerCase() === 'href'
    ) {
      attrs.push({
        name: 'href',
        value: input.slice(valStart, pos),
        rawSegment: '',
      });
    }
  }

  return markHtmlScanDead(ctx, visitedBeforeAttr, visitedUnquotedRuns);
}

function findClosingTag(
  ctx: HtmlScanContext,
  fromPos: number,
  targetLowerName: string,
): ClosingTagSpan | null {
  const { input, len, lastGtIndex, noClosingTagAfter } = ctx;
  if (lastGtIndex === -1 || fromPos >= lastGtIndex) {
    return null;
  }
  const failedFrom = noClosingTagAfter.get(targetLowerName);
  if (failedFrom !== undefined && fromPos >= failedFrom) {
    return null;
  }

  const targetLen = targetLowerName.length;
  let searchPos = fromPos;
  while (searchPos < lastGtIndex) {
    const closeIdx = input.indexOf('</', searchPos);
    if (closeIdx === -1 || closeIdx >= lastGtIndex) {
      break;
    }
    const nameStart = closeIdx + 2;
    const nameEnd = nameStart + targetLen;
    if (nameEnd >= len || nameEnd > lastGtIndex) {
      break;
    }
    const boundary = input.charCodeAt(nameEnd);
    if (boundary !== CHAR_GT && boundary !== CHAR_SLASH && !isHtmlWhitespace(boundary)) {
      searchPos = closeIdx + 2;
      continue;
    }
    if (input.slice(nameStart, nameEnd).toLowerCase() !== targetLowerName) {
      searchPos = closeIdx + 2;
      continue;
    }
    const tag = scanHtmlTag(ctx, closeIdx, 'none');
    if (tag !== null && tag.isClosing && tag.lowerName === targetLowerName) {
      return { start: tag.start, end: tag.end };
    }
    searchPos = closeIdx + 2;
  }

  noClosingTagAfter.set(targetLowerName, fromPos);
  return null;
}

function scrubOpeningTag(
  input: string,
  tag: ScannedHtmlTag,
): { readonly text: string; readonly changed: boolean } {
  if (tag.attrs.length === 0) {
    return { text: input.slice(tag.start, tag.end), changed: false };
  }

  const kept: string[] = [];
  let droppedAny = false;
  for (let k = 0; k < tag.attrs.length; k += 1) {
    const attr = tag.attrs[k];
    if (!attr) {
      continue;
    }
    if (isForbiddenRawHtmlAttribute(attr.name, attr.value)) {
      droppedAny = true;
    } else {
      kept.push(attr.rawSegment);
    }
  }

  if (!droppedAny) {
    return { text: input.slice(tag.start, tag.end), changed: false };
  }

  const attrsPart = kept.length > 0 ? ` ${kept.join(' ')}` : '';
  const closePart = tag.selfClosing ? ' /' : '';
  return { text: `<${tag.rawName}${attrsPart}${closePart}>`, changed: true };
}

function sanitizeRawHtmlPairsVoidsAndAnchors(input: string): HtmlPairsPassResult {
  const ctx = createHtmlScanContext(input);
  if (ctx.lastGtIndex === -1) {
    return {
      output: input,
      changed: false,
      sawUnclosedDropOpen: false,
      sawStrayDropClose: false,
      sawOtherOpenTag: false,
    };
  }

  const parts: string[] = [];
  let lastEmit = 0;
  let cursor = 0;
  let changed = false;
  let sawUnclosedDropOpen = false;
  let sawStrayDropClose = false;
  let sawOtherOpenTag = false;

  while (cursor < ctx.len) {
    const ltIdx = input.indexOf('<', cursor);
    if (ltIdx === -1 || ltIdx >= ctx.lastGtIndex) {
      break;
    }

    const tag = scanHtmlTag(ctx, ltIdx, 'href-only');
    if (tag === null) {
      cursor = ltIdx + 1;
      continue;
    }

    // 1. Void drop tags (opening or closing): drop immediately
    if (RAW_HTML_VOID_DROP_TAGS.has(tag.lowerName)) {
      if (tag.start > lastEmit) {
        parts.push(input.slice(lastEmit, tag.start));
      }
      changed = true;
      cursor = tag.end;
      lastEmit = cursor;
      continue;
    }

    // 2. Paired drop tags
    if (RAW_HTML_PAIRED_DROP_TAGS.has(tag.lowerName)) {
      if (!tag.isClosing) {
        const closeTag = findClosingTag(ctx, tag.end, tag.lowerName);
        if (closeTag !== null) {
          if (tag.start > lastEmit) {
            parts.push(input.slice(lastEmit, tag.start));
          }
          changed = true;
          cursor = closeTag.end;
          lastEmit = cursor;
          continue;
        }
        sawUnclosedDropOpen = true;
      } else {
        sawStrayDropClose = true;
      }
      cursor = tag.end;
      continue;
    }

    // 3. Raw HTML anchor <a ...>...</a> -> Markdown link or plain text
    if (!tag.isClosing && tag.lowerName === 'a') {
      const closeTag = findClosingTag(ctx, tag.end, 'a');
      if (closeTag !== null) {
        if (tag.start > lastEmit) {
          parts.push(input.slice(lastEmit, tag.start));
        }
        const hrefAttr = tag.attrs.find((attr) => attr.name.toLowerCase() === 'href');
        const rawHref = hrefAttr?.value ?? '';
        const hrefCheck = validatePublicHttpsUrl(rawHref);
        const cleanInner = input.slice(tag.end, closeTag.start).replace(/\r?\n/g, ' ').trim();
        if (hrefCheck.ok && cleanInner.length > 0) {
          parts.push(`[${cleanInner}](${hrefCheck.normalizedUrl})`);
        } else if (cleanInner.length > 0) {
          parts.push(cleanInner);
        }
        changed = true;
        cursor = closeTag.end;
        lastEmit = cursor;
        continue;
      }
      // Unclosed <a>: defer to Phase 3c so `href` is scrubbed cleanly
      sawOtherOpenTag = true;
      cursor = tag.end;
      continue;
    }

    // 4. Other raw HTML tags
    if (!tag.isClosing && tag.hasAttrs) {
      sawOtherOpenTag = true;
    }
    cursor = tag.end;
  }

  if (!changed) {
    return {
      output: input,
      changed: false,
      sawUnclosedDropOpen,
      sawStrayDropClose,
      sawOtherOpenTag,
    };
  }

  if (lastEmit < ctx.len) {
    parts.push(input.slice(lastEmit));
  }

  return {
    output: parts.join(''),
    changed: true,
    sawUnclosedDropOpen,
    sawStrayDropClose,
    sawOtherOpenTag,
  };
}

function dropRemainingRawHtmlDropTags(
  input: string,
  mode: 'opening' | 'closing',
): { readonly output: string; readonly changed: boolean } {
  const ctx = createHtmlScanContext(input);
  if (ctx.lastGtIndex === -1) {
    return { output: input, changed: false };
  }

  const parts: string[] = [];
  let lastEmit = 0;
  let cursor = 0;
  let changed = false;

  while (cursor < ctx.len) {
    const ltIdx = input.indexOf('<', cursor);
    if (ltIdx === -1 || ltIdx >= ctx.lastGtIndex) {
      break;
    }

    const tag = scanHtmlTag(ctx, ltIdx, 'none');
    if (tag === null) {
      cursor = ltIdx + 1;
      continue;
    }

    const matchesMode = mode === 'opening' ? !tag.isClosing : tag.isClosing;
    if (matchesMode && DROP_SUBTREE_TAGS.has(tag.lowerName)) {
      if (tag.start > lastEmit) {
        parts.push(input.slice(lastEmit, tag.start));
      }
      changed = true;
      cursor = tag.end;
      lastEmit = cursor;
      continue;
    }

    cursor = tag.end;
  }

  if (!changed) {
    return { output: input, changed: false };
  }

  if (lastEmit < ctx.len) {
    parts.push(input.slice(lastEmit));
  }

  return { output: parts.join(''), changed: true };
}

function scrubRawHtmlOpeningTagAttributes(input: string): {
  readonly output: string;
  readonly changed: boolean;
} {
  const ctx = createHtmlScanContext(input);
  if (ctx.lastGtIndex === -1) {
    return { output: input, changed: false };
  }

  const parts: string[] = [];
  let lastEmit = 0;
  let cursor = 0;
  let changed = false;

  while (cursor < ctx.len) {
    const ltIdx = input.indexOf('<', cursor);
    if (ltIdx === -1 || ltIdx >= ctx.lastGtIndex) {
      break;
    }

    const tag = scanHtmlTag(ctx, ltIdx, 'all');
    if (tag === null) {
      cursor = ltIdx + 1;
      continue;
    }

    if (!tag.isClosing && tag.attrs.length > 0) {
      const scrubbed = scrubOpeningTag(input, tag);
      if (scrubbed.changed) {
        if (tag.start > lastEmit) {
          parts.push(input.slice(lastEmit, tag.start));
        }
        parts.push(scrubbed.text);
        changed = true;
        lastEmit = tag.end;
      }
    }
    cursor = tag.end;
  }

  if (!changed) {
    return { output: input, changed: false };
  }

  if (lastEmit < ctx.len) {
    parts.push(input.slice(lastEmit));
  }

  return { output: parts.join(''), changed: true };
}

function isAsciiBlankRange(text: string, start: number, end: number): boolean {
  for (let k = start; k < end; k += 1) {
    const c = text.charCodeAt(k);
    if (c !== 32 && c !== 9 && c !== 13) {
      return false;
    }
  }
  return true;
}

function parseBlockquotePrefix(
  text: string,
  lineStart: number,
  lineEnd: number,
  maxDepth = Number.POSITIVE_INFINITY,
): { quoteDepth: number; contentStart: number } {
  let pos = lineStart;
  let quoteDepth = 0;

  while (pos < lineEnd && quoteDepth < maxDepth) {
    let scan = pos;
    while (scan < lineEnd && scan - pos < 3 && text.charCodeAt(scan) === 32) {
      scan += 1;
    }
    if (scan < lineEnd && text.charCodeAt(scan) === 62) {
      quoteDepth += 1;
      pos = scan + 1;
      if (pos < lineEnd) {
        const after = text.charCodeAt(pos);
        if (after === 32 || after === 9) {
          pos += 1;
        }
      }
      continue;
    }
    break;
  }

  return { quoteDepth, contentStart: pos };
}

function isGfmTableDelimiterRow(trimmedLine: string): boolean {
  if (!trimmedLine.includes('|')) {
    return false;
  }
  for (let i = 0; i < trimmedLine.length; i += 1) {
    const ch = trimmedLine.charCodeAt(i);
    if (ch !== 45 && ch !== 58 && ch !== 124 && ch !== 32 && ch !== 9) {
      return false;
    }
  }
  const cells = splitMarkdownTableRow(trimmedLine);
  return (
    cells.length > 0 &&
    cells.every((cell) => GFM_TABLE_DELIMITER_CELL_BROAD_PATTERN.test(cell.trim()))
  );
}

function isGfmTableDelimiterPair(headerLine: string, nextLine: string): boolean {
  const headerTrimmed = headerLine.trim();
  const nextTrimmed = nextLine.trim();
  if (!headerTrimmed.includes('|') || !isGfmTableDelimiterRow(nextTrimmed)) {
    return false;
  }
  const headerCells = splitMarkdownTableRow(headerTrimmed);
  const separatorCells = splitMarkdownTableRow(nextTrimmed);
  return headerCells.length > 0 && headerCells.length === separatorCells.length;
}

function computeCodeSpanEnds(text: string): Int32Array {
  const len = text.length;
  const codeSpanEnd = new Int32Array(len);
  codeSpanEnd.fill(-1);

  if (!text.includes('`')) {
    return codeSpanEnd;
  }

  // Pass 1 (left-to-right, strict Θ(N)): collect contiguous backtick runs per block/cell.
  // runStarts[r] === -1 marks a CommonMark §4/§5 or GFM §4.10 block/table-cell boundary sentinel;
  // single soft-break '\n' within the same paragraph stays open per CommonMark §6.1.
  const runStarts: number[] = [];
  const runEnds: number[] = [];
  const runEscaped: number[] = [];

  const pushBoundarySentinel = (): void => {
    if (runStarts.length > 0 && runStarts[runStarts.length - 1] !== -1) {
      runStarts.push(-1);
      runEnds.push(-1);
      runEscaped.push(0);
    }
  };

  let inFence = false;
  let fenceChar = 0;
  let fenceLen = 0;
  let fenceQuoteDepth = 0;
  let currentQuoteDepth = 0;
  let inTable = false;
  let lineStart = 0;

  while (lineStart < len) {
    const nlIdx = text.indexOf('\n', lineStart);
    const lineEnd = nlIdx === -1 ? len : nlIdx;
    const effectiveLineEnd =
      lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const nextLineStart = nlIdx === -1 ? len : nlIdx + 1;

    if (inFence) {
      let fenceContentStart = lineStart;
      let fenceClosedByQuoteExit = false;

      if (fenceQuoteDepth > 0) {
        const prefix = parseBlockquotePrefix(text, lineStart, effectiveLineEnd, fenceQuoteDepth);
        if (prefix.quoteDepth < fenceQuoteDepth) {
          // Blockquote ended, terminating the nested fenced code block before this line.
          inFence = false;
          fenceChar = 0;
          fenceLen = 0;
          fenceQuoteDepth = 0;
          currentQuoteDepth = 0;
          inTable = false;
          pushBoundarySentinel();
          fenceClosedByQuoteExit = true;
        } else {
          fenceContentStart = prefix.contentStart;
        }
      }

      if (!fenceClosedByQuoteExit) {
        let fenceIndent = fenceContentStart;
        while (
          fenceIndent < effectiveLineEnd &&
          fenceIndent - fenceContentStart < 3 &&
          text.charCodeAt(fenceIndent) === 32
        ) {
          fenceIndent += 1;
        }
        if (fenceIndent < effectiveLineEnd && text.charCodeAt(fenceIndent) === fenceChar) {
          let fenceEnd = fenceIndent + 1;
          while (fenceEnd < effectiveLineEnd && text.charCodeAt(fenceEnd) === fenceChar) {
            fenceEnd += 1;
          }
          if (
            fenceEnd - fenceIndent >= fenceLen &&
            isAsciiBlankRange(text, fenceEnd, effectiveLineEnd)
          ) {
            inFence = false;
            fenceChar = 0;
            fenceLen = 0;
            fenceQuoteDepth = 0;
            inTable = false;
            pushBoundarySentinel();
            lineStart = nextLineStart;
            continue;
          }
        }
        // Lines inside fenced code blocks never pair backticks with surrounding blocks.
        lineStart = nextLineStart;
        continue;
      }
    }

    if (isAsciiBlankRange(text, lineStart, effectiveLineEnd)) {
      inTable = false;
      currentQuoteDepth = 0;
      pushBoundarySentinel();
      lineStart = nextLineStart;
      continue;
    }

    const { quoteDepth, contentStart } = parseBlockquotePrefix(text, lineStart, effectiveLineEnd);

    // Blank line inside a blockquote (e.g. a bare '>' line) isolates inner paragraphs.
    if (isAsciiBlankRange(text, contentStart, effectiveLineEnd)) {
      inTable = false;
      currentQuoteDepth = quoteDepth;
      pushBoundarySentinel();
      lineStart = nextLineStart;
      continue;
    }

    if (quoteDepth !== currentQuoteDepth) {
      inTable = false;
      pushBoundarySentinel();
      currentQuoteDepth = quoteDepth;
    }

    let indentPos = contentStart;
    while (
      indentPos < effectiveLineEnd &&
      indentPos - contentStart < 3 &&
      text.charCodeAt(indentPos) === 32
    ) {
      indentPos += 1;
    }
    const firstCh = indentPos < effectiveLineEnd ? text.charCodeAt(indentPos) : -1;

    // CommonMark §4.5 fenced code block opener (at most 3 spaces after blockquote prefix).
    if (firstCh === 96 || firstCh === 126) {
      let fenceEnd = indentPos + 1;
      while (fenceEnd < effectiveLineEnd && text.charCodeAt(fenceEnd) === firstCh) {
        fenceEnd += 1;
      }
      const count = fenceEnd - indentPos;
      if (count >= 3) {
        let validOpener = true;
        if (firstCh === 96) {
          for (let k = fenceEnd; k < effectiveLineEnd; k += 1) {
            if (text.charCodeAt(k) === 96) {
              validOpener = false;
              break;
            }
          }
        }
        if (validOpener) {
          inFence = true;
          fenceChar = firstCh;
          fenceLen = count;
          fenceQuoteDepth = quoteDepth;
          inTable = false;
          pushBoundarySentinel();
          lineStart = nextLineStart;
          continue;
        }
      }
    }

    const lineSlice = text.slice(indentPos, effectiveLineEnd);
    const trimmed = lineSlice.trim();

    // Classify CommonMark §4 / GFM §4.10 block boundaries (strict O(lineLen)).
    const isAtxHeading = firstCh === 35 && ATX_HEADING_BOUNDARY_PATTERN.test(lineSlice);
    const isThematicOrSetext =
      !isAtxHeading &&
      (HORIZONTAL_RULE_PATTERN.test(trimmed) || THEMATIC_BREAK_OR_SETEXT_PATTERN.test(trimmed));
    const isHtmlBlockOpen =
      !isAtxHeading &&
      !isThematicOrSetext &&
      firstCh === 60 &&
      HTML_BLOCK_OPENER_PATTERN.test(lineSlice);
    const isDelimiterContinuation =
      !isAtxHeading &&
      !isThematicOrSetext &&
      !isHtmlBlockOpen &&
      inTable &&
      isGfmTableDelimiterRow(trimmed);
    const isListItem =
      !isAtxHeading &&
      !isThematicOrSetext &&
      !isHtmlBlockOpen &&
      !isDelimiterContinuation &&
      LIST_ITEM_BOUNDARY_PATTERN.test(lineSlice);

    let isTableRow = false;
    if (!isAtxHeading && !isThematicOrSetext && !isHtmlBlockOpen && !isListItem) {
      if (isDelimiterContinuation) {
        isTableRow = true;
      } else if (lineSlice.includes('|')) {
        if (inTable || trimmed.startsWith('|')) {
          isTableRow = true;
        } else if (nextLineStart < len) {
          // Single-line lookahead (O(nextLineLen), visited at most once) for pipe-less GFM tables.
          const nextNlIdx = text.indexOf('\n', nextLineStart);
          const nextLineEnd = nextNlIdx === -1 ? len : nextNlIdx;
          const nextEffectiveEnd =
            nextLineEnd > nextLineStart && text.charCodeAt(nextLineEnd - 1) === 13
              ? nextLineEnd - 1
              : nextLineEnd;
          let nextContentSlice = '';
          if (quoteDepth > 0) {
            const nextPrefix = parseBlockquotePrefix(
              text,
              nextLineStart,
              nextEffectiveEnd,
              quoteDepth,
            );
            if (nextPrefix.quoteDepth === quoteDepth) {
              nextContentSlice = text.slice(nextPrefix.contentStart, nextEffectiveEnd);
            }
          } else {
            nextContentSlice = text.slice(nextLineStart, nextEffectiveEnd);
          }
          if (nextContentSlice.length > 0 && isGfmTableDelimiterPair(lineSlice, nextContentSlice)) {
            isTableRow = true;
          }
        }
      }
    }

    const isHtmlCloseLine =
      (isHtmlBlockOpen && HTML_BLOCK_LINE_CLOSE_PATTERN.test(lineSlice)) ||
      trimmed.startsWith('-->') ||
      trimmed.startsWith('?>') ||
      trimmed.startsWith(']]>');

    if (isTableRow) {
      inTable = true;
      pushBoundarySentinel();
    } else {
      if (inTable) {
        inTable = false;
      }
      if (isAtxHeading || isThematicOrSetext || isListItem || isHtmlBlockOpen) {
        pushBoundarySentinel();
      }
    }

    // Collect contiguous backtick runs; reset '\' count per line.
    // Inside GFM table rows, every unescaped '|' splits cells before inline parsing (GFM §4.10).
    let trailingBackslashes = 0;
    let p = contentStart;
    while (p < effectiveLineEnd) {
      const ch = text.charCodeAt(p);
      if (ch === 92) {
        trailingBackslashes += 1;
        p += 1;
        continue;
      }
      if (isTableRow && ch === 124 && (trailingBackslashes & 1) === 0) {
        pushBoundarySentinel();
        trailingBackslashes = 0;
        p += 1;
        continue;
      }
      if (ch === 96) {
        const start = p;
        let end = start + 1;
        while (end < effectiveLineEnd && text.charCodeAt(end) === 96) {
          end += 1;
        }
        runStarts.push(start);
        runEnds.push(end);
        runEscaped.push(trailingBackslashes & 1);
        trailingBackslashes = 0;
        p = end;
        continue;
      }
      trailingBackslashes = 0;
      p += 1;
    }

    if (isAtxHeading || isThematicOrSetext || isTableRow || isHtmlCloseLine) {
      pushBoundarySentinel();
    }

    lineStart = nextLineStart;
  }

  // Pass 2 (right-to-left, strict Θ(N)): match each opener with the nearest later same-length run
  // within the same block/table cell (clearing the map at every boundary sentinel).
  const nextRunEndByLen = new Map<number, number>();
  for (let r = runStarts.length - 1; r >= 0; r -= 1) {
    const start = runStarts[r];
    const end = runEnds[r];
    if (start === undefined || end === undefined) {
      continue;
    }
    if (start === -1) {
      nextRunEndByLen.clear();
      continue;
    }

    const runLen = end - start;
    const escaped = runEscaped[r] === 1;

    if (!escaped) {
      const matchEnd = nextRunEndByLen.get(runLen);
      if (matchEnd !== undefined) {
        codeSpanEnd[start] = matchEnd;
      }
    } else if (runLen >= 2) {
      // Outside a code span, the preceding '\' escapes only the first backtick;
      // [start + 1, end) is an unescaped opening run of length (runLen - 1).
      const matchEnd = nextRunEndByLen.get(runLen - 1);
      if (matchEnd !== undefined) {
        codeSpanEnd[start + 1] = matchEnd;
      }
    }

    // Always record the full run as a valid closer for earlier open code spans
    // (inside a code span, '\' is literal per CommonMark §6.1).
    nextRunEndByLen.set(runLen, end);
  }

  return codeSpanEnd;
}

function buildInlineScanIndex(text: string): InlineScanIndex {
  const len = text.length;
  const bracketClose = new Int32Array(len);
  bracketClose.fill(-1);
  const prefixBangBracket = new Int32Array(len + 1);
  const codeSpanEnd = computeCodeSpanEnds(text);
  const openStack: number[] = [];

  const lastCloseParen = text.lastIndexOf(')');
  const lastGt = text.lastIndexOf('>');
  const lastDoubleQuote = text.lastIndexOf('"');
  const lastSingleQuote = text.lastIndexOf("'");
  const lastBacktick = text.lastIndexOf('`');

  const partialIndex: InlineScanIndex = {
    bracketClose,
    prefixBangBracket,
    codeSpanEnd,
    lastCloseParen,
    lastGt,
    lastDoubleQuote,
    lastSingleQuote,
    lastBacktick,
  };

  for (let i = 0; i < len; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 92 && i + 1 < len && isMarkdownEscapable(text.charCodeAt(i + 1))) {
      const prevCount = prefixBangBracket[i] ?? 0;
      prefixBangBracket[i + 1] = prevCount;
      i += 1;
      prefixBangBracket[i + 1] = prevCount;
      continue;
    }

    if (code === 96) {
      const closeEnd = codeSpanEnd[i] ?? -1;
      if (closeEnd !== -1) {
        // CommonMark §6.1: code spans take precedence over '[' / ']' and '![', so skip
        // openStack/bracketClose and keep prefixBangBracket flat across the span.
        const prevCount = prefixBangBracket[i] ?? 0;
        for (let k = i; k < closeEnd; k += 1) {
          prefixBangBracket[k + 1] = prevCount;
        }
        i = closeEnd - 1;
        continue;
      }

      // Unclosed backtick run: consume the entire contiguous run cleanly.
      const prevCount = prefixBangBracket[i] ?? 0;
      let runEnd = i + 1;
      while (runEnd < len && text.charCodeAt(runEnd) === 96) {
        runEnd += 1;
      }
      for (let k = i; k < runEnd; k += 1) {
        prefixBangBracket[k + 1] = prevCount;
      }
      i = runEnd - 1;
      continue;
    }

    const isBangBracket = code === 33 && i + 1 < len && text.charCodeAt(i + 1) === 91;
    prefixBangBracket[i + 1] = (prefixBangBracket[i] ?? 0) + (isBangBracket ? 1 : 0);

    if (code === 91) {
      openStack.push(i);
    } else if (code === 93) {
      const openIdx = openStack.pop();
      if (openIdx !== undefined) {
        bracketClose[openIdx] = i;
        // CommonMark §6.3: skip consumed ](...) destinations/titles immediately so literal
        // backticks or brackets inside a URL/title never blind subsequent inline tokens.
        if (i + 1 < len && text.charCodeAt(i + 1) === 40) {
          const allowEmpty =
            (openIdx > 0 && text.charCodeAt(openIdx - 1) === 33) ||
            (openIdx + 2 < i &&
              text.charCodeAt(openIdx + 1) === 33 &&
              text.charCodeAt(openIdx + 2) === 91);
          const dest = parseParenDestination(text, i + 1, partialIndex, allowEmpty);
          if (dest !== null) {
            const prevCount = prefixBangBracket[i + 1] ?? 0;
            for (let k = i + 1; k < dest.endIndex; k += 1) {
              prefixBangBracket[k + 1] = prevCount;
              codeSpanEnd[k] = -1;
            }
            i = dest.endIndex - 1;
            continue;
          }
        }
      }
    }
  }

  return partialIndex;
}

function parseBracketedSpan(text: string, openIdx: number, index: InlineScanIndex): number {
  if (openIdx < 0 || openIdx >= text.length || text.charCodeAt(openIdx) !== 91) {
    return -1;
  }
  return index.bracketClose[openIdx] ?? -1;
}

function containsBangBracket(
  index: InlineScanIndex,
  startInclusive: number,
  endExclusive: number,
): boolean {
  if (endExclusive - startInclusive < 2) {
    return false;
  }
  const endCount = index.prefixBangBracket[endExclusive - 1] ?? 0;
  const startCount = index.prefixBangBracket[startInclusive] ?? 0;
  return endCount - startCount > 0;
}

function parseParenDestination(
  text: string,
  openParenIdx: number,
  index: InlineScanIndex,
  allowEmpty: boolean,
): ParsedParenDestination | null {
  const len = text.length;
  if (
    openParenIdx < 0 ||
    openParenIdx >= len ||
    text.charCodeAt(openParenIdx) !== 40 ||
    openParenIdx >= index.lastCloseParen
  ) {
    return null;
  }

  let pos = openParenIdx + 1;
  while (pos < len && isAsciiWhitespace(text.charCodeAt(pos))) {
    pos += 1;
  }
  if (pos >= len) {
    return null;
  }

  if (text.charCodeAt(pos) === 41) {
    if (!allowEmpty) {
      return null;
    }
    return { url: '', endIndex: pos + 1 };
  }

  let rawUrl = '';
  if (text.charCodeAt(pos) === 60) {
    if (pos >= index.lastGt) {
      return null;
    }
    const urlStart = pos + 1;
    pos = urlStart;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 92 && pos + 1 < len && isMarkdownEscapable(text.charCodeAt(pos + 1))) {
        pos += 2;
        continue;
      }
      if (ch === 62) {
        break;
      }
      if (ch === 60 || ch === 10 || ch === 13) {
        return null;
      }
      pos += 1;
    }
    if (pos >= len || text.charCodeAt(pos) !== 62) {
      return null;
    }
    rawUrl = text.slice(urlStart, pos).trim();
    pos += 1;
  } else {
    const urlStart = pos;
    let parenDepth = 0;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (isAsciiWhitespace(ch)) {
        break;
      }
      if (ch === 92 && pos + 1 < len && isMarkdownEscapable(text.charCodeAt(pos + 1))) {
        pos += 2;
        continue;
      }
      if (ch === 60 || ch === 62) {
        return null;
      }
      if (ch === 40) {
        if (parenDepth >= MAX_URL_PAREN_DEPTH) {
          return null;
        }
        parenDepth += 1;
        pos += 1;
        continue;
      }
      if (ch === 41) {
        if (parenDepth === 0) {
          break;
        }
        parenDepth -= 1;
        pos += 1;
        continue;
      }
      pos += 1;
    }
    if (parenDepth !== 0 || pos === urlStart) {
      return null;
    }
    rawUrl = text.slice(urlStart, pos);
  }

  const wsStart = pos;
  while (pos < len && isAsciiWhitespace(text.charCodeAt(pos))) {
    pos += 1;
  }
  const hadWhitespaceAfterUrl = pos > wsStart;

  if (pos < len && hadWhitespaceAfterUrl) {
    const quoteCh = text.charCodeAt(pos);
    if (quoteCh === 34 || quoteCh === 39) {
      const lastQuote = quoteCh === 34 ? index.lastDoubleQuote : index.lastSingleQuote;
      if (pos >= lastQuote) {
        return null;
      }
      pos += 1;
      while (pos < len) {
        const ch = text.charCodeAt(pos);
        if (ch === 92 && pos + 1 < len) {
          pos += 2;
          continue;
        }
        if (ch === quoteCh) {
          break;
        }
        pos += 1;
      }
      if (pos >= len || text.charCodeAt(pos) !== quoteCh) {
        return null;
      }
      pos += 1;
      while (pos < len && isAsciiWhitespace(text.charCodeAt(pos))) {
        pos += 1;
      }
    } else if (quoteCh === 40) {
      // CommonMark §6.3 parenthesized title: (...) with no unescaped '(' inside
      if (pos >= index.lastCloseParen) {
        return null;
      }
      pos += 1;
      while (pos < len) {
        const ch = text.charCodeAt(pos);
        if (ch === 92 && pos + 1 < len) {
          pos += 2;
          continue;
        }
        if (ch === 40) {
          return null;
        }
        if (ch === 41) {
          break;
        }
        pos += 1;
      }
      if (pos >= len || text.charCodeAt(pos) !== 41) {
        return null;
      }
      pos += 1;
      while (pos < len && isAsciiWhitespace(text.charCodeAt(pos))) {
        pos += 1;
      }
    }
  }

  if (pos < len && text.charCodeAt(pos) === 41) {
    return { url: rawUrl, endIndex: pos + 1 };
  }
  return null;
}

function scanAtomicInlineMarkdown(text: string): AtomicInlineToken[] {
  const len = text.length;
  if (len === 0) {
    return [];
  }

  const index = buildInlineScanIndex(text);
  const tokens: AtomicInlineToken[] = [];
  let pos = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: 'text', raw: text.slice(textStart, end) });
    }
  };

  while (pos < len) {
    const ch = text.charCodeAt(pos);

    if (ch === 92 && pos + 1 < len && isMarkdownEscapable(text.charCodeAt(pos + 1))) {
      pos += 2;
      continue;
    }

    // 1. '[' -> Try linked image [![alt](img)](link) FIRST, then plain link [label](link)
    if (ch === 91) {
      if (pos + 2 < len && text.charCodeAt(pos + 1) === 33 && text.charCodeAt(pos + 2) === 91) {
        const altClose = parseBracketedSpan(text, pos + 2, index);
        if (
          altClose !== -1 &&
          !containsBangBracket(index, pos + 3, altClose) &&
          altClose + 1 < len &&
          text.charCodeAt(altClose + 1) === 40
        ) {
          const imgDest = parseParenDestination(text, altClose + 1, index, true);
          if (
            imgDest !== null &&
            imgDest.endIndex + 1 < len &&
            text.charCodeAt(imgDest.endIndex) === 93 &&
            text.charCodeAt(imgDest.endIndex + 1) === 40
          ) {
            const linkDest = parseParenDestination(text, imgDest.endIndex + 1, index, true);
            if (linkDest !== null) {
              flushText(pos);
              tokens.push({
                kind: 'linked-image',
                alt: text.slice(pos + 3, altClose),
                imageUrl: imgDest.url,
                linkUrl: linkDest.url,
                raw: text.slice(pos, linkDest.endIndex),
              });
              pos = linkDest.endIndex;
              textStart = pos;
              continue;
            }
          }
        }
      }

      const labelClose = parseBracketedSpan(text, pos, index);
      if (labelClose !== -1 && labelClose + 1 < len && text.charCodeAt(labelClose + 1) === 40) {
        const linkDest = parseParenDestination(text, labelClose + 1, index, false);
        if (linkDest !== null) {
          const hasBangBracket = containsBangBracket(index, pos + 1, labelClose);
          if (!hasBangBracket || !validatePublicHttpsUrl(linkDest.url).ok) {
            flushText(pos);
            tokens.push({
              kind: 'link',
              label: text.slice(pos + 1, labelClose),
              linkUrl: linkDest.url,
              raw: text.slice(pos, linkDest.endIndex),
            });
            pos = linkDest.endIndex;
            textStart = pos;
            continue;
          }
        }
      }
    }

    // 2. '!' -> Standalone image ![alt](imgDest)
    if (ch === 33 && pos + 1 < len && text.charCodeAt(pos + 1) === 91) {
      const altClose = parseBracketedSpan(text, pos + 1, index);
      if (altClose !== -1 && altClose + 1 < len && text.charCodeAt(altClose + 1) === 40) {
        const imgDest = parseParenDestination(text, altClose + 1, index, true);
        if (imgDest !== null) {
          flushText(pos);
          tokens.push({
            kind: 'image',
            alt: text.slice(pos + 2, altClose),
            imageUrl: imgDest.url,
            raw: text.slice(pos, imgDest.endIndex),
          });
          pos = imgDest.endIndex;
          textStart = pos;
          continue;
        }
      }
    }

    // 3. '`' -> CommonMark §6.1 inline code span (exact matching backtick run, block-isolated)
    if (ch === 96) {
      const closeEnd = index.codeSpanEnd[pos] ?? -1;
      if (closeEnd !== -1) {
        let tickEnd = pos + 1;
        while (tickEnd < closeEnd && text.charCodeAt(tickEnd) === 96) {
          tickEnd += 1;
        }
        const tickLen = tickEnd - pos;
        let content = text.slice(tickEnd, closeEnd - tickLen);
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32
        ) {
          let hasNonSpace = false;
          for (let k = 1; k < content.length - 1; k += 1) {
            if (content.charCodeAt(k) !== 32) {
              hasNonSpace = true;
              break;
            }
          }
          if (hasNonSpace) {
            content = content.slice(1, -1);
          }
        }
        flushText(pos);
        tokens.push({
          kind: 'code',
          content,
          raw: text.slice(pos, closeEnd),
        });
        pos = closeEnd;
        textStart = pos;
        continue;
      }

      // Unclosed backtick run: consume the entire contiguous run as plain text so inner backticks
      // cannot accidentally pair with a shorter run later on the same line.
      pos += 1;
      while (pos < len && text.charCodeAt(pos) === 96) {
        pos += 1;
      }
      continue;
    }

    pos += 1;
  }

  flushText(len);
  return tokens;
}

type EmphasisStageItem =
  | { readonly kind: 'node'; readonly node: AtomicInlineToken }
  | { readonly kind: 'newline' }
  | { readonly kind: 'delim'; readonly delimKind: 'strong' | 'em'; readonly raw: string };

type OpenEmphasisFrame = {
  readonly kind: 'strong' | 'em';
  readonly outputIndex: number;
};

function isItemWhitespaceBoundary(
  item: EmphasisStageItem | undefined,
  side: 'prev' | 'next',
): boolean {
  if (item === undefined || item.kind === 'newline') {
    return true;
  }
  if (item.kind === 'delim') {
    return false;
  }
  if (item.node.kind !== 'text') {
    return false;
  }
  const raw = item.node.raw;
  if (raw.length === 0) {
    return true;
  }
  const code = side === 'prev' ? raw.charCodeAt(raw.length - 1) : raw.charCodeAt(0);
  return isAsciiWhitespace(code);
}

function coalesceAdjacentTextNodes(nodes: readonly InlineMarkdownNode[]): InlineMarkdownNode[] {
  const result: InlineMarkdownNode[] = [];
  let textRun: string[] | null = null;
  let singleText: string | null = null;

  const flushText = (): void => {
    if (textRun !== null) {
      result.push({ kind: 'text', raw: textRun.join('') });
      textRun = null;
    } else if (singleText !== null) {
      result.push({ kind: 'text', raw: singleText });
      singleText = null;
    }
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) {
      continue;
    }
    if (node.kind === 'text') {
      if (textRun !== null) {
        textRun.push(node.raw);
      } else if (singleText !== null) {
        textRun = [singleText, node.raw];
        singleText = null;
      } else {
        singleText = node.raw;
      }
    } else {
      flushText();
      result.push(node);
    }
  }

  flushText();
  return result;
}

function buildEmphasisTree(atomicTokens: readonly AtomicInlineToken[]): InlineMarkdownNode[] {
  const items: EmphasisStageItem[] = [];
  let sawDelim = false;

  for (let t = 0; t < atomicTokens.length; t += 1) {
    const token = atomicTokens[t];
    if (!token) {
      continue;
    }
    if (token.kind !== 'text') {
      items.push({ kind: 'node', node: token });
      continue;
    }

    const raw = token.raw;
    if (!raw.includes('*') && !raw.includes('\n')) {
      items.push({ kind: 'node', node: token });
      continue;
    }

    const rawLen = raw.length;
    let segStart = 0;
    let i = 0;

    const flushSegment = (end: number): void => {
      if (end > segStart) {
        items.push({ kind: 'node', node: { kind: 'text', raw: raw.slice(segStart, end) } });
      }
    };

    while (i < rawLen) {
      const code = raw.charCodeAt(i);
      if (code === 92 && i + 1 < rawLen && isMarkdownEscapable(raw.charCodeAt(i + 1))) {
        i += 2;
        continue;
      }
      if (code === 10) {
        flushSegment(i);
        items.push({ kind: 'newline' });
        i += 1;
        segStart = i;
        continue;
      }
      if (code === 42) {
        let runEnd = i + 1;
        while (runEnd < rawLen && raw.charCodeAt(runEnd) === 42) {
          runEnd += 1;
        }
        const runLen = runEnd - i;
        if (runLen === 1 || runLen === 2) {
          flushSegment(i);
          items.push({
            kind: 'delim',
            delimKind: runLen === 2 ? 'strong' : 'em',
            raw: runLen === 2 ? '**' : '*',
          });
          sawDelim = true;
          i = runEnd;
          segStart = i;
          continue;
        }
        // Ignore 3+ consecutive '*' runs in O(1) (keeps '***', '**'.repeat(3000), '*'.repeat(10000) linear)
        i = runEnd;
        continue;
      }
      i += 1;
    }

    flushSegment(rawLen);
  }

  if (!sawDelim) {
    return [...atomicTokens];
  }

  const output: InlineMarkdownNode[] = [];
  const openFrames: OpenEmphasisFrame[] = [];
  let openStrongCount = 0;
  let openEmCount = 0;

  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    if (!item) {
      continue;
    }
    if (item.kind === 'newline') {
      openFrames.length = 0;
      openStrongCount = 0;
      openEmCount = 0;
      output.push({ kind: 'text', raw: '\n' });
      continue;
    }
    if (item.kind === 'node') {
      output.push(item.node);
      continue;
    }

    const prevIsWs = isItemWhitespaceBoundary(items[idx - 1], 'prev');
    const nextIsWs = isItemWhitespaceBoundary(items[idx + 1], 'next');
    const canOpen = !nextIsWs;
    const canClose = !prevIsWs;
    const delimKind = item.delimKind;
    const matchingOpenCount = delimKind === 'strong' ? openStrongCount : openEmCount;

    if (canClose && matchingOpenCount > 0) {
      let matchIdx = openFrames.length - 1;
      while (matchIdx >= 0 && openFrames[matchIdx]?.kind !== delimKind) {
        matchIdx -= 1;
      }
      const matchFrame = matchIdx >= 0 ? openFrames[matchIdx] : undefined;
      if (matchFrame !== undefined && output.length > matchFrame.outputIndex + 1) {
        for (let k = openFrames.length - 1; k >= matchIdx; k -= 1) {
          if (openFrames[k]?.kind === 'strong') {
            openStrongCount -= 1;
          } else {
            openEmCount -= 1;
          }
        }
        openFrames.length = matchIdx;

        const children = coalesceAdjacentTextNodes(output.slice(matchFrame.outputIndex + 1));
        output.length = matchFrame.outputIndex;
        output.push({ kind: delimKind, children });
        continue;
      }
    }

    const openOutputIndex = output.length;
    output.push({ kind: 'text', raw: item.raw });
    if (canOpen && openFrames.length < MAX_EMPHASIS_STACK_DEPTH) {
      openFrames.push({ kind: delimKind, outputIndex: openOutputIndex });
      if (delimKind === 'strong') {
        openStrongCount += 1;
      } else {
        openEmCount += 1;
      }
    }
  }

  return coalesceAdjacentTextNodes(output);
}

function scanInlineMarkdown(text: string): InlineMarkdownNode[] {
  if (text.length === 0) {
    return [];
  }
  // Stage 1: CommonMark atomic precedence (linked-image, link, image, code) — NEVER split on '*'
  const atomicTokens = scanAtomicInlineMarkdown(text);
  // Stage 2: Strict O(N) emphasis tree over atomic tokens
  if (!text.includes('*')) {
    return atomicTokens;
  }
  return buildEmphasisTree(atomicTokens);
}

function renderInlineNodesForTextarea(
  nodes: readonly InlineMarkdownNode[],
  depth: number,
  initialLastCharWasBang: boolean,
): string {
  const parts: string[] = [];
  let lastCharWasBang = initialLastCharWasBang;

  const pushPart = (segment: string): void => {
    if (segment.length === 0) {
      return;
    }
    parts.push(segment);
    lastCharWasBang = segment.charCodeAt(segment.length - 1) === 33;
  };

  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        pushPart(node.raw);
        break;
      case 'linked-image': {
        const cleanAlt =
          depth < MAX_INLINE_MARKDOWN_DEPTH
            ? sanitizeInlineMarkdownForTextarea(node.alt, depth + 1).trim()
            : node.alt.trim();
        const hrefCheck = validatePublicHttpsUrl(node.linkUrl);
        if (hrefCheck.ok && cleanAlt.length > 0 && !lastCharWasBang) {
          pushPart(`[${cleanAlt}](${hrefCheck.normalizedUrl})`);
        }
        break;
      }
      case 'image':
        // Strip standalone Markdown image hotlinks completely.
        break;
      case 'link': {
        const cleanLabel =
          depth < MAX_INLINE_MARKDOWN_DEPTH
            ? sanitizeInlineMarkdownForTextarea(node.label, depth + 1)
            : node.label;
        const hrefCheck = validatePublicHttpsUrl(node.linkUrl);
        if (hrefCheck.ok) {
          if (cleanLabel.trim().length > 0 && !lastCharWasBang) {
            pushPart(`[${cleanLabel}](${hrefCheck.normalizedUrl})`);
          }
        } else if (cleanLabel.trim().length > 0) {
          pushPart(cleanLabel);
        }
        break;
      }
      case 'code':
        pushPart(node.raw);
        break;
      case 'strong': {
        const inner = renderInlineNodesForTextarea(node.children, depth, false);
        if (inner.trim().length > 0) {
          pushPart(`**${inner}**`);
        }
        break;
      }
      case 'em': {
        const inner = renderInlineNodesForTextarea(node.children, depth, false);
        if (inner.trim().length > 0) {
          pushPart(`*${inner}*`);
        }
        break;
      }
    }
  }

  return parts.join('');
}

function sanitizeInlineMarkdownForTextarea(text: string, depth = 0): string {
  if (text.length === 0) {
    return '';
  }

  const nodes = scanInlineMarkdown(text);
  return renderInlineNodesForTextarea(nodes, depth, false);
}

export function sanitizeMarkdownForTextarea(markdown: string): string {
  if (!markdown || markdown.trim().length === 0) {
    return '';
  }

  let current = markdown.replace(/\r\n?/g, '\n');
  let converged = false;

  for (let pass = 0; pass < MAX_SANITIZE_CONVERGENCE_PASSES; pass += 1) {
    let next = current;

    // Phase 1 (HTML FIRST): paired drop tags, void drop tags, and <a> -> Markdown link conversion
    let htmlMeta: HtmlPairsPassResult | null = null;
    if (next.includes('<')) {
      htmlMeta = sanitizeRawHtmlPairsVoidsAndAnchors(next);
      next = htmlMeta.output;
    }

    // Phase 2 (Markdown SECOND): O(N) linear stripping of linked/standalone images & unsafe links
    if (next.includes('[')) {
      next = sanitizeInlineMarkdownForTextarea(next);
    }

    if (next !== current) {
      current = next;
      continue;
    }

    // Phase 3 (only after Phase 1 + Phase 2 reach local fixed point):
    // 3a. Drop unclosed opening drop tags FIRST, then re-enter outer loop
    if (htmlMeta !== null && htmlMeta.sawUnclosedDropOpen) {
      const strippedOpen = dropRemainingRawHtmlDropTags(current, 'opening');
      if (strippedOpen.changed) {
        current = strippedOpen.output;
        continue;
      }
    }

    // 3b. Drop stray closing drop tags, then re-enter outer loop
    if (htmlMeta !== null && htmlMeta.sawStrayDropClose) {
      const strippedClose = dropRemainingRawHtmlDropTags(current, 'closing');
      if (strippedClose.changed) {
        current = strippedClose.output;
        continue;
      }
    }

    // 3c. Scrub forbidden attributes on remaining raw HTML opening tags, then re-enter outer loop if modified
    if (htmlMeta !== null && htmlMeta.sawOtherOpenTag) {
      const scrubbed = scrubRawHtmlOpeningTagAttributes(current);
      if (scrubbed.changed) {
        current = scrubbed.output;
        continue;
      }
    }

    converged = true;
    break;
  }

  // Defensive post-cap safety sweep for pathologically >6-layer nested obfuscation
  if (!converged) {
    if (current.includes('<')) {
      current = sanitizeRawHtmlPairsVoidsAndAnchors(current).output;
      current = dropRemainingRawHtmlDropTags(current, 'opening').output;
      current = dropRemainingRawHtmlDropTags(current, 'closing').output;
      current = scrubRawHtmlOpeningTagAttributes(current).output;
    }
    if (current.includes('[')) {
      current = sanitizeInlineMarkdownForTextarea(current);
    }
  }

  return current.replace(/\n{3,}/g, '\n\n').trim();
}

function appendInlineNodes(
  doc: Document,
  container: Node,
  nodes: readonly InlineMarkdownNode[],
  depth: number,
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        container.appendChild(doc.createTextNode(node.raw));
        break;
      case 'linked-image': {
        // Strip image hotlink completely; emit safe link only if linkUrl is valid HTTPS and alt is non-empty.
        const altText = node.alt.trim();
        const hrefCheck = validatePublicHttpsUrl(node.linkUrl);
        if (hrefCheck.ok && altText.length > 0) {
          const anchor = doc.createElement('a');
          anchor.setAttribute('href', hrefCheck.normalizedUrl);
          anchor.setAttribute('rel', 'noopener noreferrer');
          anchor.textContent = altText;
          container.appendChild(anchor);
        }
        break;
      }
      case 'image':
        // Strip standalone markdown external image hotlinks completely.
        break;
      case 'link': {
        const hrefCheck = validatePublicHttpsUrl(node.linkUrl);
        if (hrefCheck.ok) {
          if (node.label.trim().length > 0) {
            const anchor = doc.createElement('a');
            anchor.setAttribute('href', hrefCheck.normalizedUrl);
            anchor.setAttribute('rel', 'noopener noreferrer');
            anchor.textContent = node.label;
            container.appendChild(anchor);
          }
        } else if (node.label.trim().length > 0) {
          if (depth < MAX_INLINE_MARKDOWN_DEPTH) {
            appendInlineMarkdown(doc, container, node.label, depth + 1);
          } else {
            container.appendChild(doc.createTextNode(node.label));
          }
        }
        break;
      }
      case 'code': {
        const codeEl = doc.createElement('code');
        codeEl.textContent = node.content;
        container.appendChild(codeEl);
        break;
      }
      case 'strong': {
        const strongEl = doc.createElement('strong');
        appendInlineNodes(doc, strongEl, node.children, depth);
        if (
          strongEl.childNodes.length > 0 &&
          ((strongEl.textContent ?? '').trim().length > 0 || strongEl.children.length > 0)
        ) {
          container.appendChild(strongEl);
        }
        break;
      }
      case 'em': {
        const emEl = doc.createElement('em');
        appendInlineNodes(doc, emEl, node.children, depth);
        if (
          emEl.childNodes.length > 0 &&
          ((emEl.textContent ?? '').trim().length > 0 || emEl.children.length > 0)
        ) {
          container.appendChild(emEl);
        }
        break;
      }
    }
  }
}

function appendInlineMarkdown(doc: Document, container: Node, text: string, depth = 0): void {
  if (text.length === 0) {
    return;
  }

  const nodes = scanInlineMarkdown(text);
  appendInlineNodes(doc, container, nodes, depth);
}

function splitMarkdownTableRow(rawLine: string): string[] {
  let trimmed = rawLine.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? '';
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(separatorLine: string): Array<'left' | 'center' | 'right' | null> {
  return splitMarkdownTableRow(separatorLine).map((cell) => {
    const trimmed = cell.trim();
    const startsColon = trimmed.startsWith(':');
    const endsColon = trimmed.endsWith(':');
    if (startsColon && endsColon) {
      return 'center';
    }
    if (endsColon) {
      return 'right';
    }
    if (startsColon) {
      return 'left';
    }
    return null;
  });
}

function isGfmTableStart(lines: readonly string[], index: number): boolean {
  const headerLine = (lines[index] ?? '').trim();
  const nextLine = lines[index + 1];
  if (nextLine === undefined) {
    return false;
  }
  const separatorLine = nextLine.trim();
  if (!headerLine.includes('|') || !separatorLine.includes('|')) {
    return false;
  }

  const headerCells = splitMarkdownTableRow(headerLine);
  const separatorCells = splitMarkdownTableRow(separatorLine);
  if (headerCells.length === 0 || headerCells.length !== separatorCells.length) {
    return false;
  }

  return separatorCells.every((cell) => GFM_TABLE_DELIMITER_CELL_PATTERN.test(cell.trim()));
}

function isBlockBoundaryLine(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (
    FENCED_CODE_START_PATTERN.test(trimmed) ||
    HEADING_PATTERN.test(trimmed) ||
    HORIZONTAL_RULE_PATTERN.test(trimmed) ||
    BLOCKQUOTE_PATTERN.test(trimmed) ||
    UNORDERED_LIST_PATTERN.test(trimmed) ||
    ORDERED_LIST_PATTERN.test(trimmed)
  ) {
    return true;
  }
  if (isGfmTableStart(lines, index)) {
    return true;
  }
  return false;
}

export function renderMarkdownToFragment(doc: Document, markdown: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  if (!markdown || markdown.trim().length === 0) {
    return fragment;
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i] ?? '';
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    const fenceMatch = FENCED_CODE_START_PATTERN.exec(trimmed);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '```';
      const fenceChar = fence[0] ?? '`';
      const fenceLen = fence.length;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i] ?? '';
        const candidateTrimmed = candidate.trim();
        if (
          candidateTrimmed.length >= fenceLen &&
          candidateTrimmed.split('').every((ch) => ch === fenceChar)
        ) {
          i += 1;
          break;
        }
        codeLines.push(candidate);
        i += 1;
      }
      const pre = doc.createElement('pre');
      pre.setAttribute('class', 'measured-data-block');
      const code = doc.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      fragment.appendChild(pre);
      continue;
    }

    if (isGfmTableStart(lines, i)) {
      const nextLine = lines[i + 1] ?? '';
      const headers = splitMarkdownTableRow(trimmed);
      const alignments = parseTableAlignments(nextLine.trim());
      i += 2;

      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const headerRow = doc.createElement('tr');
      headers.forEach((cellText, colIdx) => {
        const th = doc.createElement('th');
        const align = alignments[colIdx];
        if (align) {
          th.setAttribute('align', align);
        }
        appendInlineMarkdown(doc, th, cellText);
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      while (i < lines.length) {
        const rowLine = (lines[i] ?? '').trim();
        if (rowLine.length === 0 || !rowLine.includes('|') || isBlockBoundaryLine(lines, i)) {
          break;
        }
        const cells = splitMarkdownTableRow(rowLine);
        const tr = doc.createElement('tr');
        const colCount = headers.length;
        for (let colIdx = 0; colIdx < colCount; colIdx += 1) {
          const td = doc.createElement('td');
          const align = alignments[colIdx];
          if (align) {
            td.setAttribute('align', align);
          }
          appendInlineMarkdown(doc, td, cells[colIdx] ?? '');
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      fragment.appendChild(table);
      continue;
    }

    const headingMatch = HEADING_PATTERN.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, (headingMatch[1] ?? '#').length));
      const headingEl = doc.createElement(`h${level}`);
      appendInlineMarkdown(doc, headingEl, (headingMatch[2] ?? '').trim());
      fragment.appendChild(headingEl);
      i += 1;
      continue;
    }

    if (HORIZONTAL_RULE_PATTERN.test(trimmed)) {
      fragment.appendChild(doc.createElement('hr'));
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_PATTERN.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qMatch = BLOCKQUOTE_PATTERN.exec((lines[i] ?? '').trim());
        if (!qMatch) {
          break;
        }
        quoteLines.push((qMatch[1] ?? '').trim());
        i += 1;
      }
      const blockquote = doc.createElement('blockquote');
      const p = doc.createElement('p');
      appendInlineMarkdown(doc, p, quoteLines.filter((line) => line.length > 0).join(' '));
      blockquote.appendChild(p);
      fragment.appendChild(blockquote);
      continue;
    }

    if (UNORDERED_LIST_PATTERN.test(trimmed)) {
      const ul = doc.createElement('ul');
      while (i < lines.length) {
        const liMatch = UNORDERED_LIST_PATTERN.exec((lines[i] ?? '').trim());
        if (!liMatch) {
          break;
        }
        const li = doc.createElement('li');
        appendInlineMarkdown(doc, li, (liMatch[1] ?? '').trim());
        ul.appendChild(li);
        i += 1;
      }
      fragment.appendChild(ul);
      continue;
    }

    if (ORDERED_LIST_PATTERN.test(trimmed)) {
      const ol = doc.createElement('ol');
      while (i < lines.length) {
        const liMatch = ORDERED_LIST_PATTERN.exec((lines[i] ?? '').trim());
        if (!liMatch) {
          break;
        }
        const li = doc.createElement('li');
        appendInlineMarkdown(doc, li, (liMatch[1] ?? '').trim());
        ol.appendChild(li);
        i += 1;
      }
      fragment.appendChild(ol);
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length && !isBlockBoundaryLine(lines, i)) {
      paragraphLines.push((lines[i] ?? '').trim());
      i += 1;
    }
    const paragraphText = paragraphLines.join(' ').trim();
    if (paragraphText.length > 0) {
      const p = doc.createElement('p');
      appendInlineMarkdown(doc, p, paragraphText);
      if ((p.textContent ?? '').trim().length > 0 || p.children.length > 0) {
        fragment.appendChild(p);
      }
    }
  }

  return fragment;
}

function hasMeaningfulContent(fragment: DocumentFragment): boolean {
  if ((fragment.textContent ?? '').trim().length > 0) {
    return true;
  }
  return fragment.querySelector('table, hr, pre') !== null;
}

function matchesForbiddenPublishToken(value: string): boolean {
  if (!value) {
    return false;
  }
  if (
    FORBIDDEN_PUBLISH_CN_KEYWORDS.some((keyword) => value.includes(keyword)) ||
    FORBIDDEN_PUBLISH_EN_PATTERN.test(value)
  ) {
    return true;
  }
  const normalized = value.replace(INVISIBLE_AND_WHITESPACE_PATTERN, '');
  if (normalized.length === 0 || normalized === value) {
    return false;
  }
  if (FORBIDDEN_PUBLISH_CN_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return true;
  }
  return FORBIDDEN_PUBLISH_EN_PATTERN.test(normalized);
}

function hasFormSubmitOverrideAttr(node: Element): boolean {
  return FORM_SUBMIT_OVERRIDE_ATTRS.some((attr) => node.hasAttribute(attr));
}

function elementHasForbiddenPublishMetadata(node: Element): boolean {
  if (matchesForbiddenPublishToken(node.textContent ?? '')) {
    return true;
  }
  for (const attr of Array.from(node.attributes)) {
    if (matchesForbiddenPublishToken(attr.name) || matchesForbiddenPublishToken(attr.value)) {
      return true;
    }
  }
  for (const handlerProp of INLINE_POINTER_HANDLER_ATTRS) {
    const domHandler = (node as unknown as Record<string, unknown>)[handlerProp];
    if (typeof domHandler === 'function' && matchesForbiddenPublishToken(domHandler.name)) {
      return true;
    }
  }
  return false;
}

function isInteractiveAncestor(node: Element): boolean {
  const tag = node.tagName.toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'AREA') {
    return true;
  }
  const role = (node.getAttribute('role') ?? '').trim().toLowerCase();
  return INTERACTIVE_ANCESTOR_ROLES.has(role);
}

function ancestorHasForbiddenInlineHandler(node: Element): boolean {
  let hasPointerHandler = false;
  for (const attr of Array.from(node.attributes)) {
    const lowerName = attr.name.toLowerCase();
    if (INLINE_POINTER_HANDLER_ATTRS.has(lowerName)) {
      hasPointerHandler = true;
      if (matchesForbiddenPublishToken(attr.value)) {
        return true;
      }
    }
  }

  for (const handlerProp of INLINE_POINTER_HANDLER_ATTRS) {
    const domHandler = (node as unknown as Record<string, unknown>)[handlerProp];
    if (typeof domHandler === 'function') {
      hasPointerHandler = true;
      if (matchesForbiddenPublishToken(domHandler.name)) {
        return true;
      }
    }
  }

  if (hasPointerHandler) {
    for (const attr of Array.from(node.attributes)) {
      if (matchesForbiddenPublishToken(attr.name) || matchesForbiddenPublishToken(attr.value)) {
        return true;
      }
    }
  }

  return false;
}

function subtreeHasForbiddenPublishMetadata(node: Element): boolean {
  if (elementHasForbiddenPublishMetadata(node)) {
    return true;
  }

  for (const descendant of Array.from(node.querySelectorAll('*'))) {
    if (elementHasForbiddenPublishMetadata(descendant)) {
      return true;
    }
  }

  return false;
}

function hasForbiddenPublishMetadata(el: Element): boolean {
  if (subtreeHasForbiddenPublishMetadata(el)) {
    return true;
  }

  let ancestor = el.parentElement;
  while (ancestor) {
    if (
      (isInteractiveAncestor(ancestor) && subtreeHasForbiddenPublishMetadata(ancestor)) ||
      ancestorHasForbiddenInlineHandler(ancestor)
    ) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

export function findDraftSaveButton(doc: Document): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll('button, [role="button"], a, input[type="button"]'),
  );

  for (const el of candidates) {
    // Layer 1: Namespace, tag allowlist, editable-exclusion, form-submission, label-activation, navigation & visibility gate
    if (el.namespaceURI !== null && el.namespaceURI !== HTML_NAMESPACE) {
      continue;
    }
    if (
      isInsideEditableContent(el) ||
      !isElementVisible(el) ||
      hasDisabledState(el) ||
      isInsideVisibleLoginGate(el)
    ) {
      continue;
    }

    const tagName = el.tagName.toUpperCase();
    const rawTypeAttr = (el.getAttribute('type') ?? '').trim().toLowerCase();
    if (rawTypeAttr === 'submit' || rawTypeAttr === 'reset' || rawTypeAttr === 'image') {
      continue;
    }
    if (tagName === 'INPUT') {
      if (rawTypeAttr !== 'button') {
        continue;
      }
    } else if (tagName !== 'BUTTON' && tagName !== 'A' && !ALLOWED_ROLE_BUTTON_TAGS.has(tagName)) {
      continue;
    }
    if (hasFormSubmitOverrideAttr(el) || el.hasAttribute('form')) {
      continue;
    }

    let enclosingButton = el.closest('button');
    let blockedByButton = false;
    while (enclosingButton) {
      if (
        enclosingButton !== el ||
        hasDisabledState(enclosingButton) ||
        hasFormSubmitOverrideAttr(enclosingButton) ||
        enclosingButton.hasAttribute('form')
      ) {
        blockedByButton = true;
        break;
      }
      const btnTypeAttr = (enclosingButton.getAttribute('type') ?? '').trim().toLowerCase();
      if (btnTypeAttr === 'submit' || btnTypeAttr === 'reset') {
        blockedByButton = true;
        break;
      }
      const isFormAssociated =
        enclosingButton.closest('form') !== null ||
        enclosingButton.form !== null ||
        enclosingButton.hasAttribute('form');
      if (isFormAssociated && btnTypeAttr !== 'button') {
        blockedByButton = true;
        break;
      }
      enclosingButton = enclosingButton.parentElement?.closest('button') ?? null;
    }
    if (blockedByButton) {
      continue;
    }

    let enclosingLabel = el.closest('label');
    let blockedByLabel = false;
    while (enclosingLabel) {
      if (subtreeHasForbiddenPublishMetadata(enclosingLabel)) {
        blockedByLabel = true;
        break;
      }

      const labelControl = (enclosingLabel as HTMLLabelElement).control ?? null;
      if (labelControl !== null && labelControl !== el) {
        blockedByLabel = true;
        break;
      }

      const forId = (enclosingLabel.getAttribute('for') ?? '').trim();
      if (forId.length > 0) {
        const forTarget = doc.getElementById(forId);
        if ((forTarget !== null && forTarget !== el) || el.id !== forId) {
          blockedByLabel = true;
          break;
        }
      }

      const labelControls = Array.from(
        enclosingLabel.querySelectorAll('input, button, select, textarea'),
      );
      if (labelControls.some((ctrl) => ctrl !== el)) {
        blockedByLabel = true;
        break;
      }

      enclosingLabel = enclosingLabel.parentElement?.closest('label') ?? null;
    }
    if (blockedByLabel) {
      continue;
    }

    let enclosingAnchor = el.closest('a');
    let blockedByAnchor = false;
    while (enclosingAnchor) {
      if (enclosingAnchor.hasAttribute('xlink:href') || enclosingAnchor.hasAttribute('download')) {
        blockedByAnchor = true;
        break;
      }
      const targetAttr = (enclosingAnchor.getAttribute('target') ?? '').trim().toLowerCase();
      if (targetAttr.length > 0 && targetAttr !== '_self') {
        blockedByAnchor = true;
        break;
      }
      const rawHref = enclosingAnchor.getAttribute('href');
      if (rawHref !== null) {
        const trimmedHref = rawHref.trim();
        if (!SAFE_DRAFT_ANCHOR_HREF_PATTERN.test(trimmedHref)) {
          blockedByAnchor = true;
          break;
        }
      }
      enclosingAnchor = enclosingAnchor.parentElement?.closest('a') ?? null;
    }
    if (blockedByAnchor) {
      continue;
    }

    // Layer 1b: Unconditional interactive-ancestor & nested interactive-descendant exclusion
    // (starts at el.parentElement so top-level <a href="#">保存草稿</a> stays intact while nested interactive traps are rejected)
    let interactiveParent = el.parentElement;
    let blockedByInteractiveAncestor = false;
    while (interactiveParent) {
      if (isInteractiveAncestor(interactiveParent)) {
        blockedByInteractiveAncestor = true;
        break;
      }
      interactiveParent = interactiveParent.parentElement;
    }
    if (
      blockedByInteractiveAncestor ||
      Array.from(el.querySelectorAll('*')).some((desc) => isInteractiveAncestor(desc))
    ) {
      continue;
    }

    // Layer 2: Hard publish/submit/audit/destructive denylist across self, descendants, interactive ancestors & inline-handler ancestors
    if (hasForbiddenPublishMetadata(el)) {
      continue;
    }

    // Layer 3: Strict exact normalized draft-save label allowlist
    const rawLabel =
      (el.textContent ?? '').trim() ||
      (el.getAttribute('value') ?? '').trim() ||
      (el.getAttribute('aria-label') ?? '').trim();
    const normalizedLabel = rawLabel.replace(/\s+/g, '');
    if (DRAFT_SAVE_ALLOWLIST_LABELS.has(normalizedLabel)) {
      return el as HTMLElement;
    }
  }

  return null;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeFailedDetails(
  rawFailures: unknown[],
  mediaAssets: ExtensionPendingTaskDto['mediaAssets'],
  effectiveFailedImages: number,
): FailedImageDetail[] {
  const normalized: FailedImageDetail[] = [];
  for (const item of rawFailures) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const rawUrl = typeof candidate.url === 'string' ? candidate.url : 'unknown-media-url';
    const rawAlt = typeof candidate.alt === 'string' ? candidate.alt : '';
    const rawReason =
      typeof candidate.reason === 'string' && candidate.reason.trim().length > 0
        ? candidate.reason
        : '图片上传至什么值得买失败';
    normalized.push({
      url: redactSensitiveText(rawUrl).trim() || 'unknown-media-url',
      alt: redactSensitiveText(rawAlt).trim(),
      reason: redactSensitiveText(rawReason).trim() || '图片上传至什么值得买失败',
    });
  }

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackAssets = mediaAssets.slice(0, Math.max(1, effectiveFailedImages));
  if (fallbackAssets.length > 0) {
    return fallbackAssets.map((asset) => ({
      url: redactSensitiveText(asset.url).trim() || 'unknown-media-url',
      alt: redactSensitiveText(asset.alt).trim(),
      reason: '图片上传至什么值得买失败',
    }));
  }

  return [
    {
      url: 'unknown-media-url',
      alt: '',
      reason: '图片上传至什么值得买失败',
    },
  ];
}

export function createSmzdmAdapter(): PlatformDraftAdapter {
  return {
    provider: 'SMZDM_EXT',
    displayName: '什么值得买',
    editorEntryUrl: SMZDM_EDITOR_ENTRY_URL,
    publishedUrlPatterns: SMZDM_PUBLISHED_URL_PATTERNS,

    isLoggedInEditor(doc: Document, url: URL): boolean {
      if (!isSmzdmEditorUrl(url)) {
        return false;
      }
      if (hasVisibleLoginGate(doc)) {
        return false;
      }
      return hasLoggedInShell(doc);
    },

    async injectDraft(
      doc: Document,
      task: ExtensionPendingTaskDto,
      uploader: LocalImageUploader,
    ): Promise<DraftInjectReport> {
      if (task.provider !== 'SMZDM_EXT') {
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message: '任务渠道与什么值得买草稿适配器不匹配，无法注入草稿。',
        };
      }

      const docUrl = getDocumentUrl(doc);
      if ((docUrl !== null && isSmzdmLoginUrl(docUrl)) || hasVisibleLoginGate(doc)) {
        return {
          ok: false,
          stage: 'AUTH_REQUIRED',
          uploadedImages: 0,
          failedImages: 0,
          message: '未检测到什么值得买登录态，请先在当前浏览器登录账号后再写入草稿箱。',
        };
      }

      const titleInput = findTitleInput(doc);
      const bodyEditor = findBodyEditor(doc, titleInput);
      if (!titleInput || !bodyEditor) {
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message: '未找到什么值得买投稿编辑器的标题或正文输入区，请确认页面已完全加载。',
        };
      }

      // 1. Inject title via cross-realm safe native setter + bubbling events
      setNativeControlValue(titleInput, task.variantTitle);

      // 2. Sanitize HTML (preserving tables & measured-data blocks, stripping scripts & external imgs)
      //    with pure-DOM Markdown fallback when variantHtml is empty or sanitizes to empty.
      const sanitizedHtmlFragment = sanitizeSmzdmHtmlToFragment(doc, task.variantHtml);

      if (bodyEditor.tagName.toUpperCase() === 'TEXTAREA') {
        const sanitizedMarkdown = sanitizeMarkdownForTextarea(task.variantMarkdown);
        const fallbackText = sanitizedMarkdown || (sanitizedHtmlFragment.textContent ?? '').trim();
        setNativeControlValue(bodyEditor, fallbackText);
      } else {
        const contentFragment =
          !hasMeaningfulContent(sanitizedHtmlFragment) && task.variantMarkdown.trim().length > 0
            ? renderMarkdownToFragment(doc, task.variantMarkdown)
            : sanitizedHtmlFragment;
        bodyEditor.replaceChildren(contentFragment);
        try {
          bodyEditor.focus?.();
        } catch {
          // Ignore focus errors in detached/non-interactive documents.
        }
        dispatchInputAndChange(bodyEditor);
      }

      // 3. Delegate ALL media assets through LocalImageUploader (zero external hotlink fallback)
      const fileInput = findImageFileInput(doc);
      let uploadResult: ImageUploadResult = {
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      };
      if (task.mediaAssets.length > 0) {
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

      // 4. Draft-only redline: optionally trigger ONLY an unambiguous draft-save button outside bodyEditor
      const draftButton = findDraftSaveButton(doc);
      let draftButtonClicked = false;
      if (draftButton && !bodyEditor.contains(draftButton)) {
        draftButton.click();
        draftButtonClicked = true;
      }

      const draftUrl =
        docUrl !== null && isSmzdmEditorUrl(docUrl)
          ? `${docUrl.origin}${docUrl.pathname}`
          : undefined;
      const operatorReminders = [...SMZDM_OPERATOR_REMINDERS];

      const rawResult =
        uploadResult && typeof uploadResult === 'object'
          ? (uploadResult as Partial<ImageUploadResult>)
          : {};
      const rawFailures: unknown[] = Array.isArray(rawResult.failures) ? rawResult.failures : [];
      const uploadedImages = toNonNegativeInt(rawResult.uploadedImages);
      const reportedFailedImages = toNonNegativeInt(rawResult.failedImages);
      const effectiveFailedImages = Math.max(reportedFailedImages, rawFailures.length);

      if (effectiveFailedImages > 0) {
        const normalizedFailures = normalizeFailedDetails(
          rawFailures,
          task.mediaAssets,
          effectiveFailedImages,
        );
        return {
          ok: false,
          stage: 'PARTIAL_MEDIA_FAILED',
          ...(draftUrl ? { draftUrl } : {}),
          uploadedImages,
          failedImages: effectiveFailedImages,
          failedImageDetails: normalizedFailures,
          operatorReminders,
          message: `正文已写入什么值得买草稿区，已转存 ${uploadedImages} 张配图，有 ${effectiveFailedImages} 张配图上传失败请人工补传；同时请人工核对商品卡片与合规披露声明。`,
        };
      }

      const successMessage = draftButtonClicked
        ? `已写入什么值得买草稿箱（已触发保存草稿，转存 ${uploadedImages} 张配图）。请人工核对商品卡片与合规披露声明后再手动操作。`
        : `已写入什么值得买草稿编辑区（转存 ${uploadedImages} 张配图，仅保留草稿态）。请人工核对商品卡片与合规披露声明后再手动保存或提交。`;

      return {
        ok: true,
        stage: 'INJECTED',
        ...(draftUrl ? { draftUrl } : {}),
        uploadedImages,
        failedImages: 0,
        operatorReminders,
        message: successMessage,
      };
    },

    extractPublishedUrl(url: URL, _doc: Document): string | null {
      const result = validatePublishedUrl('SMZDM_EXT', url.href);
      return result.ok ? result.normalizedUrl : null;
    },
  };
}

export const smzdmAdapter: PlatformDraftAdapter = createSmzdmAdapter();
