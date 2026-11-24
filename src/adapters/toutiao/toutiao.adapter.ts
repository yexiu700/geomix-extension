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

export const TOUTIAO_EDITOR_ENTRY_URL =
  'https://mp.toutiao.com/profile_v4/graphic/publish' as const;

const CAPTURE_BAR_HOST_ID = 'geomix-extension-capture-host';

const TOUTIAO_EDITOR_HOST = 'mp.toutiao.com';
const TOUTIAO_PUBLIC_HOST = 'www.toutiao.com';

const TOUTIAO_EDITOR_PATH_PATTERN =
  /^\/profile_v4\/graphic\/(?:publish|edit)(?:\/[a-zA-Z0-9_-]+)?\/?$/i;
const TOUTIAO_LOGIN_PATH_PATTERN =
  /(?:^|\/)(?:login|auth|signin|sign-in|passport|sso|oauth)(?:\/|$)/i;
const TOUTIAO_READER_ALIAS_PATH_PATTERN = /^\/(?:group\/(\d+)|a(\d+))\/?$/;
const TOUTIAO_PUBLIC_ARTICLE_ID_PATTERN =
  /^https:\/\/www\.toutiao\.com\/(?:article\/(\d+)|i(\d+))$/;
const ENCODED_PATH_SEPARATOR_PATTERN = /%2f|%5c/i;
const DOUBLE_ENCODED_DOT_PATTERN = /%252e/i;
const EDITOR_EXCLUSION_SELECTOR =
  '.ProseMirror, [contenteditable="true"], .publish-editor-title-inner';

const LOGIN_CONTAINER_SELECTORS = [
  '.login-modal',
  '.tt-login-modal',
  '.byte-login-modal',
  '.auth-login-container',
  '.passport-login-box',
  '.tt-passport-login',
  '[data-e2e="login-modal"]',
  '[data-e2e="login-panel"]',
  '[data-e2e="qrcode-login"]',
  '[data-testid="login-modal"]',
  '#login-dialog',
  '#passport-login',
  '.qrcode-login',
  '[class*="qrcode-login" i]',
  '[class*="login-qrcode" i]',
] as const;

const LOGIN_FORM_SELECTORS = [
  'form[action*="login" i]',
  'form[action*="auth" i]',
  'form[action*="passport" i]',
  'form[action*="sso" i]',
  'input[type="password"]',
] as const;

const DIALOG_OR_LOGIN_SCAN_SELECTORS = [
  '[role="dialog"]',
  '.byte-modal',
  '.arco-modal',
  '.semi-modal',
  '[class*="login" i]',
  '[id*="login" i]',
] as const;

const AUTH_DIALOG_TEXT_PATTERN =
  /(?:登录头条号|头条号登录|手机号登录|验证码登录|扫码登录|密码登录|账号登录|请先登录|登录后继续|立即登录)/;

const FULL_PAGE_LOGIN_TITLE_PATTERN =
  /(?:头条号登录|账号登录|登录\s*[-_|]?\s*(?:头条|字节)|passport)/i;

const FULL_PAGE_LOGIN_BODY_PATTERN =
  /(?:登录头条号|手机号登录|验证码登录|扫码登录|请先登录|登录后继续)/;

const TITLE_INPUT_SELECTORS = [
  '.publish-editor-title-inner textarea',
  '.publish-editor-title-inner input[type="text"]',
  '.publish-editor-title-inner input:not([type])',
  '[data-e2e="article-title"] textarea',
  '[data-e2e="article-title"] input',
  'textarea[data-e2e="article-title"]',
  'input[data-e2e="article-title"]',
  '.editor-title textarea',
  'textarea.editor-title',
  'input.editor-title',
  '.article-title-input textarea',
  '.article-title-input input',
  'textarea[placeholder*="标题"]',
  'input[placeholder*="标题"]:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])',
  'textarea[aria-label*="标题"]',
  'input[aria-label*="标题"]',
  '.publish-editor-title-inner [contenteditable="true"]',
  '[data-e2e="article-title"][contenteditable="true"]',
] as const;

const BODY_EDITOR_SELECTORS = [
  '.syl-editor-container [contenteditable="true"].ProseMirror',
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"].ProseMirror',
  '.syl-editor-container [contenteditable="true"]',
  '.publish-editor-content [contenteditable="true"]',
  '[data-e2e="article-editor"] [contenteditable="true"]',
  '[data-e2e="article-editor"][contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
] as const;

const IMAGE_FILE_INPUT_SELECTORS = [
  '.syl-editor-container input[type="file"][accept*="image" i]',
  '.publish-editor-content input[type="file"][accept*="image" i]',
  'input[type="file"][data-e2e*="image" i]',
  '[data-e2e*="image-upload" i] input[type="file"]',
  'input[type="file"][accept*="image" i]',
  'input[type="file"][accept*=".png" i]',
  'input[type="file"][accept*=".jpg" i]',
  'input[type="file"][accept*=".jpeg" i]',
  '.syl-editor-container input[type="file"]',
] as const;

const COVER_UPLOADER_HINT_PATTERN = /(?:cover|封面|poster|thumbnail)/i;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const DISABLED_BUTTON_CLASSES = new Set([
  'disabled',
  'is-disabled',
  'byte-btn-disabled',
  'arco-btn-disabled',
]);

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

const INVISIBLE_AND_WHITESPACE_PATTERN = /[\s\p{Cf}]+/gu;

const SAFE_DRAFT_BUTTON_LABELS = new Set(['存草稿', '保存草稿', '存为草稿', '保存为草稿']);

// Fail-closed guard pattern used strictly to reject any non-draft action button.
const FORBIDDEN_PUBLISH_GUARD_PATTERN =
  /(?:发布|发表|提交|审核|预览|定时|群发|推送|上线|删除|清空|作废|publish|submit|audit|review|release|preview|schedule|approve|delete|remove|discard)/i;

const BLOCKED_SUBTREE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'audio',
  'video',
  'source',
  'canvas',
  'img',
  'picture',
]);

const ALLOWED_HTML_TAGS = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'div',
  'section',
  'article',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'sub',
  'sup',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'a',
]);

const BLOCK_TEXT_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'li',
  'tr',
  'hr',
]);

const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

type SanitizedRichContent = {
  fragment: DocumentFragment;
  html: string;
  plainText: string;
};

function hasRawPathTraversalSegment(pathname: string): boolean {
  return pathname.split(/[\\/]/).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function decodeSafePathVariants(pathname: string): string[] | null {
  if (
    ENCODED_PATH_SEPARATOR_PATTERN.test(pathname) ||
    DOUBLE_ENCODED_DOT_PATTERN.test(pathname) ||
    pathname.includes('\\') ||
    hasRawPathTraversalSegment(pathname)
  ) {
    return null;
  }

  const variants: string[] = [pathname];
  let current = pathname;

  for (let pass = 0; pass < 2; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }

    if (decoded === current) {
      break;
    }

    if (
      ENCODED_PATH_SEPARATOR_PATTERN.test(decoded) ||
      DOUBLE_ENCODED_DOT_PATTERN.test(decoded) ||
      decoded.includes('\\') ||
      hasRawPathTraversalSegment(decoded)
    ) {
      return null;
    }

    variants.push(decoded);
    current = decoded;
  }

  return variants;
}

function isToutiaoRelatedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'toutiao.com' ||
    lower.endsWith('.toutiao.com') ||
    lower === 'bytedance.com' ||
    lower.endsWith('.bytedance.com')
  );
}

function isToutiaoGraphicEditorUrl(url: URL): boolean {
  const baseCheck = validatePublicHttpsUrl(url.toString());
  if (!baseCheck.ok) {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.hostname.toLowerCase() !== TOUTIAO_EDITOR_HOST) {
    return false;
  }

  const hrefPath = url.href.slice(url.origin.length).split(/[?#]/)[0] ?? '';
  const pathnameVariants = decodeSafePathVariants(url.pathname);
  const hrefPathVariants = decodeSafePathVariants(hrefPath);
  if (!pathnameVariants || !hrefPathVariants) {
    return false;
  }

  const allVariants = new Set([...pathnameVariants, ...hrefPathVariants]);
  for (const variant of allVariants) {
    const normalizedVariant = variant.replace(/\/+$/, '');
    if (TOUTIAO_LOGIN_PATH_PATTERN.test(normalizedVariant)) {
      return false;
    }
    if (!TOUTIAO_EDITOR_PATH_PATTERN.test(normalizedVariant)) {
      return false;
    }
  }

  return true;
}

function isInsideCaptureHost(el: Element): boolean {
  return el.closest(`#${CAPTURE_BAR_HOST_ID}`) !== null;
}

function isZeroOpacity(rawOpacity: string): boolean {
  const trimmed = rawOpacity.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed === '0' || trimmed === '0%') {
    return true;
  }
  const numericPart = trimmed.endsWith('%') ? trimmed.slice(0, -1).trim() : trimmed;
  if (numericPart.length === 0) {
    return false;
  }
  const parsed = Number(numericPart);
  return Number.isFinite(parsed) && parsed === 0;
}

function isElementVisible(doc: Document, el: Element): boolean {
  let current: Element | null = el;
  const view = doc.defaultView;

  while (current !== null) {
    const ariaHidden = (current.getAttribute('aria-hidden') ?? '').trim().toLowerCase();
    if (current.hasAttribute('hidden') || ariaHidden === 'true') {
      return false;
    }

    const htmlEl = current as HTMLElement;
    const inlineStyle = htmlEl.style;
    if (inlineStyle) {
      const display = inlineStyle.display.trim().toLowerCase();
      const visibility = inlineStyle.visibility.trim().toLowerCase();
      const opacity = inlineStyle.opacity.trim();
      if (
        display === 'none' ||
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        isZeroOpacity(opacity)
      ) {
        return false;
      }
    }

    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const computed = view.getComputedStyle(current);
        const display = computed.display.trim().toLowerCase();
        const visibility = computed.visibility.trim().toLowerCase();
        const opacity = computed.opacity.trim();
        if (
          display === 'none' ||
          visibility === 'hidden' ||
          visibility === 'collapse' ||
          isZeroOpacity(opacity)
        ) {
          return false;
        }
      } catch {
        // Ignore computed-style errors on detached/foreign documents
      }
    }

    current = current.parentElement;
  }

  return true;
}

function isEditableTitleCandidate(doc: Document, el: Element): el is HTMLElement {
  if (isInsideCaptureHost(el) || !isElementVisible(doc, el)) {
    return false;
  }

  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.disabled || field.readOnly) {
      return false;
    }
    if (el.hasAttribute('disabled') || el.hasAttribute('readonly')) {
      return false;
    }
    if ((el.getAttribute('aria-disabled') ?? '').trim().toLowerCase() === 'true') {
      return false;
    }
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') ?? 'text').trim().toLowerCase();
      if (
        type === 'hidden' ||
        type === 'file' ||
        type === 'checkbox' ||
        type === 'radio' ||
        type === 'password' ||
        type === 'submit' ||
        type === 'button'
      ) {
        return false;
      }
    }
    return true;
  }

  return el.getAttribute('contenteditable') === 'true';
}

function findTitleElement(doc: Document): HTMLElement | null {
  for (const selector of TITLE_INPUT_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const candidate of matches) {
      if (isEditableTitleCandidate(doc, candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function findBodyEditorElement(
  doc: Document,
  titleElement: HTMLElement | null,
): HTMLElement | null {
  for (const selector of BODY_EDITOR_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const candidate of matches) {
      if (candidate === titleElement) {
        continue;
      }
      if (isInsideCaptureHost(candidate) || !isElementVisible(doc, candidate)) {
        continue;
      }
      if (candidate.closest('.publish-editor-title-inner') !== null) {
        continue;
      }
      if (titleElement && (candidate.contains(titleElement) || titleElement.contains(candidate))) {
        continue;
      }
      if (
        candidate.closest(
          '.login-modal, .tt-login-modal, .byte-login-modal, .auth-login-container, .passport-login-box, form[action*="login" i]',
        ) !== null
      ) {
        continue;
      }
      return candidate as HTMLElement;
    }
  }
  return null;
}

function collectVisibleNonEditorText(doc: Document, root: Element): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.nodeValue?.trim();
      if (text) {
        parts.push(text);
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
      return;
    }
    if (el.id === CAPTURE_BAR_HOST_ID || !isElementVisible(doc, el)) {
      return;
    }
    if (el.matches(EDITOR_EXCLUSION_SELECTOR)) {
      return;
    }
    for (const child of el.childNodes) {
      walk(child);
    }
  };

  walk(root);
  return parts.join(' ');
}

function collectVisibleBodyText(doc: Document): string {
  const body = doc.body;
  if (!body) {
    return '';
  }
  return collectVisibleNonEditorText(doc, body);
}

function hasVisibleLoginGate(doc: Document): boolean {
  for (const selector of LOGIN_CONTAINER_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const el of matches) {
      if (!isInsideCaptureHost(el) && isElementVisible(doc, el)) {
        return true;
      }
    }
  }

  for (const selector of LOGIN_FORM_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const el of matches) {
      if (!isInsideCaptureHost(el) && isElementVisible(doc, el)) {
        return true;
      }
    }
  }

  for (const selector of DIALOG_OR_LOGIN_SCAN_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const el of matches) {
      if (isInsideCaptureHost(el) || !isElementVisible(doc, el)) {
        continue;
      }
      if (el.closest(EDITOR_EXCLUSION_SELECTOR) !== null) {
        continue;
      }
      if (el.querySelector(EDITOR_EXCLUSION_SELECTOR) !== null) {
        continue;
      }
      const visibleText = collectVisibleNonEditorText(doc, el);
      if (AUTH_DIALOG_TEXT_PATTERN.test(visibleText)) {
        return true;
      }
    }
  }

  const titleEl = findTitleElement(doc);
  const bodyEl = findBodyEditorElement(doc, titleEl);
  if (titleEl === null && bodyEl === null) {
    if (FULL_PAGE_LOGIN_TITLE_PATTERN.test(doc.title ?? '')) {
      return true;
    }
    const visibleBodyText = collectVisibleBodyText(doc);
    if (FULL_PAGE_LOGIN_BODY_PATTERN.test(visibleBodyText)) {
      return true;
    }
  }

  return false;
}

function dispatchInputEvent(
  doc: Document,
  target: HTMLElement,
  inputType: string,
  data: string | null,
): void {
  const view = doc.defaultView;
  const EventCtor = view?.Event ?? Event;
  const InputEventCtor =
    view && view !== (globalThis as unknown)
      ? view.InputEvent
      : (view?.InputEvent ?? (typeof InputEvent !== 'undefined' ? InputEvent : null));

  let event: Event;
  if (typeof InputEventCtor === 'function') {
    try {
      event = new InputEventCtor('input', {
        bubbles: true,
        cancelable: true,
        inputType,
        data,
      });
    } catch {
      event = new EventCtor('input', { bubbles: true, cancelable: true });
    }
  } else {
    event = new EventCtor('input', { bubbles: true, cancelable: true });
  }

  target.dispatchEvent(event);
}

function injectTitle(doc: Document, titleElement: HTMLElement, title: string): void {
  titleElement.focus();

  const tag = titleElement.tagName.toUpperCase();
  const view = doc.defaultView;
  const EventCtor = view?.Event ?? Event;

  if (tag === 'TEXTAREA') {
    const proto = (view?.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(titleElement, title);
    } else {
      (titleElement as HTMLTextAreaElement).value = title;
    }
  } else if (tag === 'INPUT') {
    const proto = (view?.HTMLInputElement ?? HTMLInputElement).prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(titleElement, title);
    } else {
      (titleElement as HTMLInputElement).value = title;
    }
  } else {
    titleElement.textContent = title;
  }

  dispatchInputEvent(doc, titleElement, 'insertText', title);
  titleElement.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeSafeLinkUrl(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const check = validatePublicHttpsUrl(trimmed);
  return check.ok ? check.normalizedUrl : null;
}

function applyInlineEmphasis(input: string): string {
  return input
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderInlineMarkdown(rawLine: string): string {
  // Remove inline markdown image syntax ![alt](url) to comply with the anti-hotlink redline.
  const withoutImages = rawLine.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '');
  let html = escapeHtml(withoutImages);

  let placeholderPrefix = '\uE000GMX';
  while (html.includes(placeholderPrefix)) {
    placeholderPrefix += 'X';
  }
  const placeholders: string[] = [];
  const stash = (fragment: string): string => {
    const idx = placeholders.push(fragment) - 1;
    return `${placeholderPrefix}${idx}\uE001`;
  };

  // Extract inline code spans first so `*` and link syntax inside backticks are preserved verbatim.
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => stash(`<code>${code}</code>`));

  // Resolve Markdown links before emphasis so `*` inside URLs is never mangled into <em>.
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, rawUrl: string) => {
    const decodedUrl = rawUrl.replace(/&amp;/g, '&');
    const safeUrl = sanitizeSafeLinkUrl(decodedUrl);
    const formattedLabel = applyInlineEmphasis(label);
    if (!safeUrl) {
      return formattedLabel;
    }
    return stash(
      `<a href="${escapeHtml(safeUrl)}" rel="noopener noreferrer">${formattedLabel}</a>`,
    );
  });

  html = applyInlineEmphasis(html);

  for (let i = placeholders.length - 1; i >= 0; i -= 1) {
    const token = `${placeholderPrefix}${i}\uE001`;
    const replacement = placeholders[i] ?? '';
    html = html.split(token).join(replacement);
  }

  return html;
}

function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inCodeBlock = false;
  const codeLines: string[] = [];

  const closeList = (): void => {
    if (inList) {
      blocks.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      closeList();
      if (inCodeBlock) {
        blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines.length = 0;
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (trimmed.length === 0) {
      closeList();
      continue;
    }

    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      closeList();
      blocks.push('<hr>');
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1]?.length ?? 2;
      const content = renderInlineMarkdown(headingMatch[2] ?? '');
      blocks.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      closeList();
      blocks.push(`<blockquote><p>${renderInlineMarkdown(quoteMatch[1] ?? '')}</p></blockquote>`);
      continue;
    }

    const ulMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        blocks.push('<ul>');
        inList = 'ul';
      }
      blocks.push(`<li>${renderInlineMarkdown(ulMatch[1] ?? '')}</li>`);
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        blocks.push('<ol>');
        inList = 'ol';
      }
      blocks.push(`<li>${renderInlineMarkdown(olMatch[1] ?? '')}</li>`);
      continue;
    }

    closeList();
    const paragraphHtml = renderInlineMarkdown(trimmed);
    if (paragraphHtml.trim().length > 0) {
      blocks.push(`<p>${paragraphHtml}</p>`);
    }
  }

  closeList();
  if (inCodeBlock && codeLines.length > 0) {
    blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return blocks.join('');
}

function extractPlainTextFromFragment(fragment: DocumentFragment): string {
  const chunks: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      chunks.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      chunks.push('\n');
      return;
    }
    const isBlock = BLOCK_TEXT_TAGS.has(tag);
    if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1]?.endsWith('\n')) {
      chunks.push('\n');
    }
    for (const child of el.childNodes) {
      walk(child);
    }
    if (isBlock && chunks.length > 0 && !chunks[chunks.length - 1]?.endsWith('\n')) {
      chunks.push('\n');
    }
  };

  for (const child of fragment.childNodes) {
    walk(child);
  }

  return chunks
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeRichHtml(doc: Document, rawHtml: string): SanitizedRichContent {
  const template = doc.createElement('template');
  template.innerHTML = rawHtml;

  const sanitizeNode = (node: Node, targetParent: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      const value = node.nodeValue ?? '';
      if (value.length > 0) {
        targetParent.appendChild(doc.createTextNode(value));
      }
      return;
    }

    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }

    const sourceEl = node as Element;
    const tag = sourceEl.tagName.toLowerCase();

    if (BLOCKED_SUBTREE_TAGS.has(tag)) {
      return;
    }

    if (!ALLOWED_HTML_TAGS.has(tag)) {
      for (const child of sourceEl.childNodes) {
        sanitizeNode(child, targetParent);
      }
      return;
    }

    const cleanEl = doc.createElement(tag);

    if (tag === 'a') {
      const safeHref = sanitizeSafeLinkUrl(sourceEl.getAttribute('href') ?? '');
      if (safeHref) {
        cleanEl.setAttribute('href', safeHref);
        cleanEl.setAttribute('rel', 'noopener noreferrer');
      }
      const titleAttr = sourceEl.getAttribute('title')?.trim();
      if (titleAttr) {
        cleanEl.setAttribute('title', titleAttr);
      }
    } else if (tag === 'th' || tag === 'td') {
      const colspan = sourceEl.getAttribute('colspan')?.trim() ?? '';
      if (POSITIVE_INT_PATTERN.test(colspan)) {
        cleanEl.setAttribute('colspan', colspan);
      }
      const rowspan = sourceEl.getAttribute('rowspan')?.trim() ?? '';
      if (POSITIVE_INT_PATTERN.test(rowspan)) {
        cleanEl.setAttribute('rowspan', rowspan);
      }
    }

    for (const child of sourceEl.childNodes) {
      sanitizeNode(child, cleanEl);
    }

    targetParent.appendChild(cleanEl);
  };

  const fragment = doc.createDocumentFragment();
  for (const child of template.content.childNodes) {
    sanitizeNode(child, fragment);
  }

  const serializer = doc.createElement('div');
  serializer.appendChild(fragment.cloneNode(true));
  const html = serializer.innerHTML;
  const plainText = extractPlainTextFromFragment(fragment);

  return {
    fragment,
    html,
    plainText,
  };
}

function injectBodyContent(
  doc: Document,
  editorElement: HTMLElement,
  sanitized: SanitizedRichContent,
): void {
  editorElement.focus();

  const beforeHtml = editorElement.innerHTML;
  const beforeText = (editorElement.textContent ?? '').trim();

  const view = doc.defaultView;
  const DataTransferCtor = view?.DataTransfer ?? DataTransfer;
  const EventCtor = view?.Event ?? Event;
  const ClipboardEventCtor =
    view && view !== (globalThis as unknown)
      ? view.ClipboardEvent
      : (view?.ClipboardEvent ??
        (typeof ClipboardEvent !== 'undefined' ? ClipboardEvent : undefined));

  const dt = new DataTransferCtor();
  dt.setData('text/html', sanitized.html);
  dt.setData('text/plain', sanitized.plainText);

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

  // ProseMirror commonly calls event.preventDefault() when handling paste; ignore boolean return.
  editorElement.dispatchEvent(pasteEvent);

  const afterHtml = editorElement.innerHTML;
  const afterText = (editorElement.textContent ?? '').trim();
  const domMutated = afterHtml !== beforeHtml || afterText !== beforeText;
  const normalizedBeforeText = beforeText.replace(/\s+/g, '');
  const normalizedSanitizedText = sanitized.plainText.replace(/\s+/g, '');
  const alreadySyncedViaPreventDefault =
    pasteEvent.defaultPrevented &&
    normalizedBeforeText.length > 0 &&
    normalizedBeforeText === normalizedSanitizedText;

  if (!domMutated && !alreadySyncedViaPreventDefault) {
    editorElement.replaceChildren(sanitized.fragment.cloneNode(true));
    dispatchInputEvent(doc, editorElement, 'insertFromPaste', sanitized.plainText);
  }
}

function isCoverFileInput(input: HTMLInputElement): boolean {
  const attrs = [
    input.id,
    input.name,
    input.className,
    input.getAttribute('aria-label') ?? '',
    input.getAttribute('data-e2e') ?? '',
    input.getAttribute('data-testid') ?? '',
  ].join(' ');
  if (COVER_UPLOADER_HINT_PATTERN.test(attrs)) {
    return true;
  }

  let ancestor: Element | null = input.parentElement;
  while (ancestor !== null) {
    const ancestorTag = ancestor.tagName.toUpperCase();
    if (ancestorTag === 'BODY' || ancestorTag === 'HTML') {
      break;
    }
    const ancestorMeta = [
      ancestor.id,
      typeof ancestor.className === 'string' ? ancestor.className : '',
      ancestor.getAttribute('data-e2e') ?? '',
      ancestor.getAttribute('data-testid') ?? '',
      ancestor.getAttribute('aria-label') ?? '',
    ].join(' ');
    if (COVER_UPLOADER_HINT_PATTERN.test(ancestorMeta)) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function isEligibleImageFileInput(el: Element): el is HTMLInputElement {
  if (el.tagName.toUpperCase() !== 'INPUT') {
    return false;
  }
  const input = el as HTMLInputElement;
  if ((input.getAttribute('type') ?? '').trim().toLowerCase() !== 'file') {
    return false;
  }
  if (input.disabled || input.hasAttribute('disabled') || isInsideCaptureHost(input)) {
    return false;
  }
  if (isCoverFileInput(input)) {
    return false;
  }

  const accept = (input.getAttribute('accept') ?? '').trim().toLowerCase();
  if (accept.length > 0) {
    const tokens = accept
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const hasImage = tokens.some(
      (token) =>
        token.startsWith('image/') ||
        token === '.png' ||
        token === '.jpg' ||
        token === '.jpeg' ||
        token === '.webp' ||
        token === '.gif' ||
        token === '.avif' ||
        token === '.bmp' ||
        token === '.jfif',
    );
    const hasWildcard = tokens.some((token) => token === '*' || token === '*/*');
    if (!hasImage && !hasWildcard) {
      return false;
    }
  }

  return true;
}

function findImageFileInput(doc: Document): HTMLInputElement | null {
  for (const selector of IMAGE_FILE_INPUT_SELECTORS) {
    const matches = doc.querySelectorAll(selector);
    for (const candidate of matches) {
      if (isEligibleImageFileInput(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeButtonLabel(rawText: string): string {
  return rawText.replace(INVISIBLE_AND_WHITESPACE_PATTERN, '');
}

function isInsideEditableContent(el: Element): boolean {
  let node: Element | null = el;
  while (node !== null) {
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

function hasDisabledState(el: Element): boolean {
  const maybeDisabled = (el as Partial<HTMLButtonElement>).disabled;
  if (maybeDisabled === true || el.hasAttribute('disabled')) {
    return true;
  }
  const ariaDisabled = (el.getAttribute('aria-disabled') ?? '').trim().toLowerCase();
  if (ariaDisabled === 'true') {
    return true;
  }
  try {
    if (el.matches(':disabled')) {
      return true;
    }
  } catch {
    // Ignore selector errors on detached/non-standard nodes.
  }
  if (el.closest('fieldset[disabled]') !== null || el.closest('[inert]') !== null) {
    return true;
  }
  for (const cls of el.classList) {
    if (DISABLED_BUTTON_CLASSES.has(cls.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function hasFormSubmitOverrideAttr(node: Element): boolean {
  return FORM_SUBMIT_OVERRIDE_ATTRS.some((attr) => node.hasAttribute(attr));
}

function matchesForbiddenPublishToken(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (FORBIDDEN_PUBLISH_GUARD_PATTERN.test(value)) {
    return true;
  }
  const normalized = normalizeButtonLabel(value);
  return normalized.length > 0 && FORBIDDEN_PUBLISH_GUARD_PATTERN.test(normalized);
}

function elementHasForbiddenActionMetadata(node: Element): boolean {
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

function subtreeHasForbiddenActionMetadata(node: Element): boolean {
  if (elementHasForbiddenActionMetadata(node)) {
    return true;
  }
  for (const descendant of Array.from(node.querySelectorAll('*'))) {
    if (elementHasForbiddenActionMetadata(descendant)) {
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

function hasForbiddenActionMetadata(el: Element): boolean {
  if (subtreeHasForbiddenActionMetadata(el)) {
    return true;
  }

  let ancestor = el.parentElement;
  while (ancestor !== null) {
    if (
      (isInteractiveAncestor(ancestor) && subtreeHasForbiddenActionMetadata(ancestor)) ||
      ancestorHasForbiddenInlineHandler(ancestor)
    ) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }

  return false;
}

function isSafeDraftSaveButton(doc: Document, el: Element): el is HTMLElement {
  // Layer 1: Namespace, editable/capture exclusion, visibility, disabled, tag allowlist,
  // anchor/button/label/form/interactive-ancestor gates
  if (el.namespaceURI !== null && el.namespaceURI !== HTML_NAMESPACE) {
    return false;
  }
  if (
    isInsideCaptureHost(el) ||
    isInsideEditableContent(el) ||
    !isElementVisible(doc, el) ||
    hasDisabledState(el)
  ) {
    return false;
  }

  const tag = el.tagName.toUpperCase();
  if (tag === 'A' || el.closest('a') !== null) {
    return false;
  }
  if (
    tag !== 'BUTTON' &&
    !(
      el.getAttribute('role')?.trim().toLowerCase() === 'button' &&
      ALLOWED_ROLE_BUTTON_TAGS.has(tag)
    )
  ) {
    return false;
  }

  const typeAttr = el.getAttribute('type')?.trim().toLowerCase() ?? '';
  if (typeAttr === 'submit' || typeAttr === 'reset' || typeAttr === 'image') {
    return false;
  }
  if (el.hasAttribute('form') || hasFormSubmitOverrideAttr(el)) {
    return false;
  }

  let enclosingButton: HTMLButtonElement | null = el.closest('button');
  while (enclosingButton !== null) {
    if (
      enclosingButton !== el ||
      hasDisabledState(enclosingButton) ||
      enclosingButton.hasAttribute('form') ||
      hasFormSubmitOverrideAttr(enclosingButton)
    ) {
      return false;
    }
    const btnTypeAttr = (enclosingButton.getAttribute('type') ?? '').trim().toLowerCase();
    if (btnTypeAttr === 'submit' || btnTypeAttr === 'reset') {
      return false;
    }
    const isFormAssociated =
      enclosingButton.closest('form') !== null || enclosingButton.form !== null;
    if (isFormAssociated && btnTypeAttr !== 'button') {
      return false;
    }
    enclosingButton = enclosingButton.parentElement?.closest('button') ?? null;
  }

  let enclosingLabel: HTMLLabelElement | null = el.closest('label');
  while (enclosingLabel !== null) {
    if (subtreeHasForbiddenActionMetadata(enclosingLabel)) {
      return false;
    }

    const labelControl = enclosingLabel.control ?? null;
    if (labelControl !== null && labelControl !== el) {
      return false;
    }

    const forId = (enclosingLabel.getAttribute('for') ?? '').trim();
    if (forId.length > 0) {
      const forTarget = doc.getElementById(forId);
      if ((forTarget !== null && forTarget !== el) || el.id !== forId) {
        return false;
      }
    }

    const labelControls = Array.from(
      enclosingLabel.querySelectorAll('input, button, select, textarea'),
    );
    if (labelControls.some((ctrl) => ctrl !== el)) {
      return false;
    }

    enclosingLabel = enclosingLabel.parentElement?.closest('label') ?? null;
  }

  let interactiveParent = el.parentElement;
  while (interactiveParent !== null) {
    if (isInteractiveAncestor(interactiveParent)) {
      return false;
    }
    interactiveParent = interactiveParent.parentElement;
  }
  if (Array.from(el.querySelectorAll('*')).some((desc) => isInteractiveAncestor(desc))) {
    return false;
  }

  // Layer 2: Hard publish/submit/audit/destructive denylist across self, descendants,
  // interactive ancestors & inline-handler ancestors
  if (hasForbiddenActionMetadata(el)) {
    return false;
  }

  // Layer 3: Strict exact normalized draft-save label allowlist
  // Always inspect textContent (never innerText) so hidden child spans cannot mask forbidden text.
  const normalizedLabel = normalizeButtonLabel(el.textContent ?? '');
  if (!SAFE_DRAFT_BUTTON_LABELS.has(normalizedLabel)) {
    return false;
  }

  return true;
}

function findSafeDraftSaveButton(doc: Document): HTMLElement | null {
  const candidates = doc.querySelectorAll('button, [role="button"]');
  for (const candidate of candidates) {
    if (isSafeDraftSaveButton(doc, candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseCandidateDocUrl(raw: string | undefined | null): URL | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'about:blank') {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveDocumentUrl(doc: Document): URL | null {
  const candidates = [
    parseCandidateDocUrl(doc.location?.href),
    parseCandidateDocUrl(doc.URL),
  ].filter((parsed): parsed is URL => parsed !== null);

  if (candidates.length === 0) {
    return null;
  }

  const httpsToutiao = candidates.find(
    (parsed) => parsed.protocol === 'https:' && isToutiaoRelatedHost(parsed.hostname),
  );
  if (httpsToutiao) {
    return httpsToutiao;
  }

  const anyToutiao = candidates.find((parsed) => isToutiaoRelatedHost(parsed.hostname));
  if (anyToutiao) {
    return anyToutiao;
  }

  return candidates[0] ?? null;
}

function resolveCurrentDraftUrl(doc: Document): string | undefined {
  const parsed = resolveDocumentUrl(doc);
  if (!parsed || !isToutiaoGraphicEditorUrl(parsed)) {
    return undefined;
  }
  return `${parsed.origin}${parsed.pathname}`;
}

function hasNonEditorToutiaoDocUrl(doc: Document): boolean {
  const parsed = resolveDocumentUrl(doc);
  if (!parsed || !isToutiaoRelatedHost(parsed.hostname)) {
    return false;
  }
  return !isToutiaoGraphicEditorUrl(parsed);
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
        : '图片上传至今日头条失败';
    normalized.push({
      url: redactSensitiveText(rawUrl).trim() || 'unknown-media-url',
      alt: redactSensitiveText(rawAlt).trim(),
      reason: redactSensitiveText(rawReason).trim() || '图片上传至今日头条失败',
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
      reason: '图片上传至今日头条失败',
    }));
  }

  return [
    {
      url: 'unknown-media-url',
      alt: '',
      reason: '图片上传至今日头条失败',
    },
  ];
}

export function createToutiaoAdapter(): PlatformDraftAdapter {
  return {
    provider: 'TOUTIAO_EXT',
    displayName: '今日头条',
    editorEntryUrl: TOUTIAO_EDITOR_ENTRY_URL,
    publishedUrlPatterns: PUBLISHED_URL_PATTERNS.TOUTIAO_EXT,

    isLoggedInEditor(doc: Document, url: URL): boolean {
      if (!isToutiaoGraphicEditorUrl(url)) {
        return false;
      }
      return !hasVisibleLoginGate(doc);
    },

    async injectDraft(
      doc: Document,
      task: ExtensionPendingTaskDto,
      uploader: LocalImageUploader,
    ): Promise<DraftInjectReport> {
      if (task.provider !== 'TOUTIAO_EXT') {
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message: '任务渠道与今日头条草稿适配器不匹配，无法注入草稿。',
        };
      }

      if (hasVisibleLoginGate(doc) || hasNonEditorToutiaoDocUrl(doc)) {
        return {
          ok: false,
          stage: 'AUTH_REQUIRED',
          uploadedImages: 0,
          failedImages: 0,
          message: '检测到今日头条头条号尚未登录或处于登录拦截页，请先登录后重试。',
        };
      }

      const titleElement = findTitleElement(doc);
      const editorElement = findBodyEditorElement(doc, titleElement);

      if (!titleElement || !editorElement) {
        const missingPart =
          !titleElement && !editorElement
            ? '标题输入框与正文富文本编辑器'
            : !titleElement
              ? '标题输入框'
              : '正文富文本编辑器';
        return {
          ok: false,
          stage: 'EDITOR_NOT_FOUND',
          uploadedImages: 0,
          failedImages: 0,
          message: `未在当前今日头条编辑页找到${missingPart}，请确认页面已加载完成后重试。`,
        };
      }

      injectTitle(doc, titleElement, task.variantTitle.trim());

      const rawBodyHtml =
        task.variantHtml.trim().length > 0
          ? task.variantHtml
          : markdownToSafeHtml(task.variantMarkdown);
      const sanitizedBody = sanitizeRichHtml(doc, rawBodyHtml);
      injectBodyContent(doc, editorElement, sanitizedBody);

      const fileInput = findImageFileInput(doc);
      let uploadResult: ImageUploadResult = {
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      };
      if (task.mediaAssets.length > 0) {
        try {
          uploadResult = await uploader.uploadAll(task.mediaAssets, {
            editorElement,
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

      const safeDraftButton = findSafeDraftSaveButton(doc);
      let draftButtonClicked = false;
      if (safeDraftButton && !editorElement.contains(safeDraftButton)) {
        safeDraftButton.click();
        draftButtonClicked = true;
      }

      const draftUrl = resolveCurrentDraftUrl(doc);
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
          message: draftButtonClicked
            ? `今日头条草稿正文已写入并触发存草稿，但有 ${effectiveFailedImages} 张配图转存失败，请在编辑器中人工补传后手动发布。`
            : `今日头条草稿正文已写入，但有 ${effectiveFailedImages} 张配图转存失败，请在编辑器中人工补传并确认后手动发布。`,
        };
      }

      return {
        ok: true,
        stage: 'INJECTED',
        ...(draftUrl ? { draftUrl } : {}),
        uploadedImages,
        failedImages: 0,
        message: draftButtonClicked
          ? '已将内容写入今日头条草稿箱并触发存草稿，请人工核验排版与合规项后手动发布。'
          : '已将内容写入今日头条草稿编辑器，请人工核验排版与合规项后手动保存或发布。',
      };
    },

    extractPublishedUrl(url: URL, doc: Document): string | null {
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== TOUTIAO_PUBLIC_HOST ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== ''
      ) {
        return null;
      }

      const direct = validatePublishedUrl('TOUTIAO_EXT', url.href);
      if (direct.ok) {
        return direct.normalizedUrl;
      }

      const hrefPath = url.href.slice(url.origin.length).split(/[?#]/)[0] ?? '';
      if (
        decodeSafePathVariants(url.pathname) === null ||
        decodeSafePathVariants(hrefPath) === null
      ) {
        return null;
      }

      const aliasMatch = TOUTIAO_READER_ALIAS_PATH_PATTERN.exec(url.pathname);
      const expectedAliasId = aliasMatch?.[1] ?? aliasMatch?.[2] ?? null;
      if (!expectedAliasId) {
        return null;
      }

      const candidates = [
        doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
        doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
      ];

      for (const rawCandidate of candidates) {
        const trimmed = rawCandidate?.trim() ?? '';
        if (trimmed.length === 0) {
          continue;
        }
        const resolved =
          trimmed.startsWith('/') && !trimmed.startsWith('//')
            ? `https://${TOUTIAO_PUBLIC_HOST}${trimmed}`
            : trimmed;
        const validated = validatePublishedUrl('TOUTIAO_EXT', resolved);
        if (!validated.ok) {
          continue;
        }
        const idMatch = TOUTIAO_PUBLIC_ARTICLE_ID_PATTERN.exec(validated.normalizedUrl);
        const candidateId = idMatch?.[1] ?? idMatch?.[2] ?? null;
        if (candidateId === expectedAliasId) {
          return validated.normalizedUrl;
        }
      }

      return null;
    },
  };
}

export const toutiaoAdapter: PlatformDraftAdapter = createToutiaoAdapter();
