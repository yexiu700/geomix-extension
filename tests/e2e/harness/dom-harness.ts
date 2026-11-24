import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import type { ExtensionProviderKey } from './contract-types.js';

// ============================================================================
// ShadowRoot Capture Spy (works for BOTH mode: 'open' AND mode: 'closed')
// ============================================================================

interface CapturedShadowEntry {
  host: Element;
  root: ShadowRoot;
  mode: ShadowRootMode;
  ownerDocument: Document;
}

const capturedShadows: CapturedShadowEntry[] = [];
let shadowSpyInstalled = false;

export function installShadowRootSpy(): void {
  if (shadowSpyInstalled || typeof Element === 'undefined') {
    return;
  }
  const originalAttachShadow = Element.prototype.attachShadow;
  if (typeof originalAttachShadow !== 'function') {
    return;
  }
  Element.prototype.attachShadow = function patchedAttachShadow(
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const root = originalAttachShadow.call(this, init);
    capturedShadows.push({
      host: this,
      root,
      mode: init.mode,
      ownerDocument: this.ownerDocument,
    });
    return root;
  };
  shadowSpyInstalled = true;
}

export function clearCapturedShadowRoots(): void {
  capturedShadows.length = 0;
}

export function getCapturedShadowRoots(doc?: Document): CapturedShadowEntry[] {
  return capturedShadows.filter((entry) => {
    if (doc && entry.ownerDocument !== doc) {
      return false;
    }
    return entry.host.isConnected;
  });
}

export function findShadowHosts(doc: Document): Element[] {
  const hostSet = new Set<Element>();
  for (const entry of getCapturedShadowRoots(doc)) {
    hostSet.add(entry.host);
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (el.shadowRoot) {
      hostSet.add(el);
    }
  }
  return Array.from(hostSet);
}

export function getShadowRootForHost(host: Element): ShadowRoot | null {
  if (host.shadowRoot) {
    return host.shadowRoot;
  }
  const captured = capturedShadows.find((entry) => entry.host === host);
  return captured?.root ?? null;
}

export interface ShadowIsolationResult {
  shadowRoot: ShadowRoot;
  hasHostReset: boolean;
  lightDomContainsShadowText: boolean;
  styleCountInShadow: number;
}

export function assertShadowIsolation(
  doc: Document,
  host: Element,
  expectedTextInShadow?: string,
): ShadowIsolationResult {
  const shadowRoot = getShadowRootForHost(host);
  if (!shadowRoot) {
    throw new Error('Expected host element to have an attached ShadowRoot');
  }

  const styles = Array.from(shadowRoot.querySelectorAll('style'));
  const combinedCss = styles.map((s) => s.textContent ?? '').join('\n');
  const hasHostReset =
    /:host[\s\S]*all\s*:\s*initial/i.test(combinedCss) ||
    /all\s*:\s*initial/i.test(combinedCss);

  const shadowText = (shadowRoot.textContent ?? '').trim();
  const lightDomText = doc.body?.textContent ?? '';
  const probeText = expectedTextInShadow ?? shadowText.slice(0, 24).trim();
  const lightDomContainsShadowText =
    probeText.length > 0 && lightDomText.includes(probeText);

  return {
    shadowRoot,
    hasHostReset,
    lightDomContainsShadowText,
    styleCountInShadow: styles.length,
  };
}

// ============================================================================
// jsdom Polyfills: DataTransfer, FileList, ClipboardEvent, HTMLInputElement.files
// ============================================================================

class PolyfillFileList implements Iterable<File> {
  private readonly items: File[];
  [index: number]: File;

  constructor(files: File[] = []) {
    this.items = [...files];
    for (let i = 0; i < this.items.length; i += 1) {
      const f = this.items[i];
      if (f) {
        this[i] = f;
      }
    }
  }

  get length(): number {
    return this.items.length;
  }

  item(index: number): File | null {
    return this.items[index] ?? null;
  }

  [Symbol.iterator](): Iterator<File> {
    return this.items[Symbol.iterator]();
  }
}

interface PolyfillDataTransferItem {
  kind: 'file' | 'string';
  type: string;
  getAsFile: () => File | null;
  getAsString: (cb: (data: string) => void) => void;
}

class PolyfillDataTransferItemList implements Iterable<PolyfillDataTransferItem> {
  private readonly list: PolyfillDataTransferItem[] = [];
  private readonly onFileAdded: (file: File) => void;
  private readonly onStringAdded: (data: string, type: string) => void;
  [index: number]: PolyfillDataTransferItem;

  constructor(
    onFileAdded: (file: File) => void,
    onStringAdded: (data: string, type: string) => void,
  ) {
    this.onFileAdded = onFileAdded;
    this.onStringAdded = onStringAdded;
  }

  get length(): number {
    return this.list.length;
  }

  add(data: File | string, type?: string): PolyfillDataTransferItem | null {
    if (typeof data === 'string') {
      const mime = type ?? 'text/plain';
      const item: PolyfillDataTransferItem = {
        kind: 'string',
        type: mime,
        getAsFile: () => null,
        getAsString: (cb) => cb(data),
      };
      this.list.push(item);
      this[this.list.length - 1] = item;
      this.onStringAdded(data, mime);
      return item;
    }

    const file = data;
    const item: PolyfillDataTransferItem = {
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      getAsString: () => undefined,
    };
    this.list.push(item);
    this[this.list.length - 1] = item;
    this.onFileAdded(file);
    return item;
  }

  clear(): void {
    this.list.length = 0;
  }

  remove(index: number): void {
    this.list.splice(index, 1);
  }

  [Symbol.iterator](): Iterator<PolyfillDataTransferItem> {
    return this.list[Symbol.iterator]();
  }
}

class PolyfillDataTransfer {
  private readonly fileStore: File[] = [];
  private readonly dataStore = new Map<string, string>();
  public dropEffect: 'none' | 'copy' | 'link' | 'move' = 'none';
  public effectAllowed:
    | 'none'
    | 'copy'
    | 'copyLink'
    | 'copyMove'
    | 'link'
    | 'linkMove'
    | 'move'
    | 'all'
    | 'uninitialized' = 'uninitialized';
  public readonly items: PolyfillDataTransferItemList;

  constructor() {
    this.items = new PolyfillDataTransferItemList(
      (file) => {
        this.fileStore.push(file);
      },
      (data, type) => {
        this.dataStore.set(type, data);
      },
    );
  }

  get files(): FileList {
    return new PolyfillFileList(this.fileStore) as unknown as FileList;
  }

  get types(): readonly string[] {
    const t = Array.from(this.dataStore.keys());
    if (this.fileStore.length > 0 && !t.includes('Files')) {
      t.push('Files');
    }
    return t;
  }

  setData(format: string, data: string): void {
    this.dataStore.set(format, data);
  }

  getData(format: string): string {
    return this.dataStore.get(format) ?? '';
  }

  clearData(format?: string): void {
    if (format) {
      this.dataStore.delete(format);
    } else {
      this.dataStore.clear();
    }
  }
}

class PolyfillClipboardEvent extends Event {
  public readonly clipboardData: DataTransfer | null;

  constructor(type: string, eventInitDict?: ClipboardEventInit) {
    super(type, eventInitDict);
    this.clipboardData =
      eventInitDict?.clipboardData ??
      (new PolyfillDataTransfer() as unknown as DataTransfer);
  }
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob bytes'));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
      } else {
        reject(new Error('FileReader did not return an ArrayBuffer'));
      }
    };
    reader.readAsArrayBuffer(blob);
  });
}

const inputFilesWeakMap = new WeakMap<HTMLInputElement, FileList>();
let polyfillsInstalled = false;

export function installDomPolyfills(targetWindow?: Window & typeof globalThis): void {
  const win =
    targetWindow ??
    (typeof window !== 'undefined'
      ? (window as unknown as Window & typeof globalThis)
      : undefined);

  if (!win) {
    return;
  }

  if (typeof win.DataTransfer === 'undefined') {
    Object.defineProperty(win, 'DataTransfer', {
      value: PolyfillDataTransfer,
      writable: true,
      configurable: true,
    });
  }
  if (typeof globalThis.DataTransfer === 'undefined') {
    Object.defineProperty(globalThis, 'DataTransfer', {
      value: PolyfillDataTransfer,
      writable: true,
      configurable: true,
    });
  }

  if (typeof win.ClipboardEvent === 'undefined') {
    Object.defineProperty(win, 'ClipboardEvent', {
      value: PolyfillClipboardEvent,
      writable: true,
      configurable: true,
    });
  }
  if (typeof globalThis.ClipboardEvent === 'undefined') {
    Object.defineProperty(globalThis, 'ClipboardEvent', {
      value: PolyfillClipboardEvent,
      writable: true,
      configurable: true,
    });
  }

  if (!polyfillsInstalled || targetWindow) {
    const proto = win.HTMLInputElement?.prototype;
    if (proto) {
      const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'files');
      Object.defineProperty(proto, 'files', {
        configurable: true,
        enumerable: true,
        get(this: HTMLInputElement): FileList | null {
          const custom = inputFilesWeakMap.get(this);
          if (custom) {
            return custom;
          }
          return originalDescriptor?.get
            ? (originalDescriptor.get.call(this) as FileList | null)
            : (new PolyfillFileList([]) as unknown as FileList);
        },
        set(this: HTMLInputElement, value: FileList | null): void {
          if (value === null) {
            inputFilesWeakMap.delete(this);
            return;
          }
          try {
            if (originalDescriptor?.set) {
              originalDescriptor.set.call(this, value);
              inputFilesWeakMap.delete(this);
              return;
            }
          } catch {
            // jsdom rejects PolyfillFileList in native setter; store in WeakMap
          }
          inputFilesWeakMap.set(this, value);
        },
      });
    }
    if (!targetWindow) {
      polyfillsInstalled = true;
    }
  }
}

// ============================================================================
// SPA Navigation & Cross-Origin Document Helpers
// ============================================================================

export function navigateSpa(
  url: string,
  mode: 'pushState' | 'replaceState' | 'popstate' = 'pushState',
): void {
  if (mode === 'pushState') {
    window.history.pushState({}, '', url);
    return;
  }
  if (mode === 'replaceState') {
    window.history.replaceState({}, '', url);
    return;
  }
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}

export function setGlobalPageUrl(url: string): void {
  const target = new URL(url);
  if (window.location.origin === target.origin) {
    window.history.replaceState({}, '', `${target.pathname}${target.search}${target.hash}`);
    return;
  }
  // Cross-origin update in jsdom via location descriptor override if needed
  const jsdomEnv = (globalThis as unknown as { jsdom?: { reconfigure?: (opts: { url: string }) => void } }).jsdom;
  if (jsdomEnv?.reconfigure) {
    jsdomEnv.reconfigure({ url: target.toString() });
    return;
  }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: target,
  });
}

export function createIsolatedPlatformDocument(
  html: string,
  url: string,
): { doc: Document; url: URL; dom: JSDOM } {
  const dom = new JSDOM(html, { url });
  installDomPolyfills(dom.window as unknown as Window & typeof globalThis);
  return {
    doc: dom.window.document,
    url: new URL(url),
    dom,
  };
}

export function injectHostileCss(doc: Document): HTMLStyleElement {
  const style = doc.createElement('style');
  style.setAttribute('data-e2e-hostile-css', 'true');
  style.textContent = `
    * {
      display: none !important;
      color: transparent !important;
      font-size: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  doc.head.appendChild(style);
  return style;
}

// ============================================================================
// Independent Sanitized Platform Editor DOM Fixtures (Zero imports from src/)
// ============================================================================

export interface PlatformFixtureSpies {
  publishButtonClicks: ReturnType<typeof vi.fn>;
  publishButtonLabelsClicked: string[];
  publishButtonsWatched: number;
  draftButtonClicks: ReturnType<typeof vi.fn>;
  pastedHtml: string[];
  pastedText: string[];
  pastedFiles: File[];
  uploadedInputFiles: File[];
  titleEvents: string[];
}

export interface PlatformFixture {
  doc: Document;
  url: URL;
  spies: PlatformFixtureSpies;
  dom: JSDOM;
}

const FORBIDDEN_PUBLISH_BUTTON_LABELS = [
  '发布',
  '发布文章',
  '发布回答',
  '预览并发布',
  '确认发布',
  '提交审核',
  '立即发布',
] as const;

const SAFE_DRAFT_BUTTON_LABELS = ['草稿', '存草稿', '保存草稿'] as const;

export function attachFixtureSpies(doc: Document): PlatformFixtureSpies {
  const spies: PlatformFixtureSpies = {
    publishButtonClicks: vi.fn(),
    publishButtonLabelsClicked: [],
    publishButtonsWatched: 0,
    draftButtonClicks: vi.fn(),
    pastedHtml: [],
    pastedText: [],
    pastedFiles: [],
    uploadedInputFiles: [],
    titleEvents: [],
  };

  for (const btn of Array.from(doc.querySelectorAll('button, [role="button"]'))) {
    const label = (btn.textContent ?? '').trim();
    if (
      FORBIDDEN_PUBLISH_BUTTON_LABELS.some(
        (forbidden) => label === forbidden || label.includes(forbidden),
      )
    ) {
      spies.publishButtonsWatched += 1;
      btn.addEventListener('click', () => {
        spies.publishButtonLabelsClicked.push(label);
        spies.publishButtonClicks(label);
      });
    } else if (
      SAFE_DRAFT_BUTTON_LABELS.some((safe) => label.includes(safe))
    ) {
      btn.addEventListener('click', () => {
        spies.draftButtonClicks(label);
      });
    }
  }

  for (const input of Array.from(
    doc.querySelectorAll('textarea, input[type="text"], input:not([type])'),
  )) {
    input.addEventListener('input', () => spies.titleEvents.push('input'));
    input.addEventListener('change', () => spies.titleEvents.push('change'));
  }

  for (const editor of Array.from(
    doc.querySelectorAll('[contenteditable="true"]'),
  )) {
    editor.addEventListener('paste', (rawEvent) => {
      const event = rawEvent as ClipboardEvent;
      const html = event.clipboardData?.getData('text/html') ?? '';
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (html) {
        spies.pastedHtml.push(html);
      }
      if (text) {
        spies.pastedText.push(text);
      }
      const files = event.clipboardData?.files;
      if (files) {
        for (let i = 0; i < files.length; i += 1) {
          const f = files.item(i);
          if (f) {
            spies.pastedFiles.push(f);
          }
        }
      }
    });
  }

  for (const fileInput of Array.from(
    doc.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  )) {
    const captureFiles = (): void => {
      const files = fileInput.files;
      if (!files) {
        return;
      }
      for (let i = 0; i < files.length; i += 1) {
        const f = files.item(i);
        if (f) {
          spies.uploadedInputFiles.push(f);
        }
      }
    };
    fileInput.addEventListener('change', captureFiles);
  }

  return spies;
}

export function createZhihuColumnFixture(): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <head><title>写文章 - 知乎</title></head>
    <body>
      <header class="ColumnPageHeader">
        <div class="Avatar" data-user="demo-operator">DemoOperator</div>
        <button type="button" class="WriteIndex-draftBtn">保存草稿</button>
        <button type="button" class="PublishPanel-triggerButton">发布</button>
        <button type="button" class="PublishPanel-confirmBtn">发布文章</button>
      </header>
      <main class="WriteIndexLayout-main">
        <textarea class="Input WriteIndex-titleInput" placeholder="请输入标题（最多 100 个字）"></textarea>
        <div class="PostEditor-wrapper">
          <div class="public-DraftEditor-content" contenteditable="true" role="textbox" aria-label="正文编辑器"></div>
          <input type="file" accept="image/*" class="WriteIndex-imageInput" />
        </div>
      </main>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    'https://zhuanlan.zhihu.com/write',
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createZhihuQuestionAnswerFixture(
  questionId = '987654321',
): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <head><title>示例问题 - 知乎</title></head>
    <body>
      <header class="AppHeader">
        <div class="AppHeader-profile">DemoOperator</div>
      </header>
      <main class="QuestionPage">
        <h1 class="QuestionHeader-title">示例品牌深度对比如何选择？</h1>
        <section class="AnswerForm">
          <div class="RichText-editor public-DraftEditor-content" contenteditable="true" role="textbox" aria-label="写回答"></div>
          <input type="file" accept="image/*" class="AnswerForm-imageInput" />
          <div class="AnswerForm-footer">
            <button type="button" class="AnswerForm-draftBtn">存草稿</button>
            <button type="button" class="AnswerForm-submit">发布回答</button>
          </div>
        </section>
      </main>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    `https://www.zhihu.com/question/${questionId}`,
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createZhihuLoggedOutFixture(
  variant: 'signin-redirect' | 'login-modal' = 'signin-redirect',
): PlatformFixture {
  const urlStr =
    variant === 'signin-redirect'
      ? 'https://www.zhihu.com/signin?next=%2Fwrite'
      : 'https://zhuanlan.zhihu.com/write';
  const html =
    variant === 'signin-redirect'
      ? `<!doctype html><html><body><div class="SignFlow"><h1>登录知乎</h1><form class="SignFlow-form"><input name="username" /><button type="submit">登录</button></form></div></body></html>`
      : `<!doctype html><html><body><div class="Modal-wrapper SignFlow"><h2>登录知乎以继续写文章</h2><button type="button">立即登录</button></div></body></html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(html, urlStr);
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createToutiaoEditorFixture(): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <head><title>头条号 - 发表文章</title></head>
    <body>
      <header class="mp-header">
        <span class="mp-user-name">DemoOperator</span>
      </header>
      <main class="publish-editor">
        <div class="editor-title-wrapper">
          <textarea class="publish-title-input" placeholder="请输入文章标题（2～30个字）"></textarea>
        </div>
        <div class="syl-editor-container">
          <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="头条正文"></div>
          <input type="file" accept="image/*" class="byte-upload-input" />
        </div>
        <footer class="publish-footer">
          <button type="button" class="publish-btn-draft">存草稿</button>
          <button type="button" class="publish-btn-preview">预览并发布</button>
          <button type="button" class="publish-btn-submit">发布</button>
          <button type="button" class="publish-btn-confirm">确认发布</button>
        </footer>
      </main>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    'https://mp.toutiao.com/profile_v4/graphic/publish',
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createToutiaoLoggedOutFixture(): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <body>
      <div class="login-page auth-container">
        <h1>登录头条号</h1>
        <form class="login-form"><input name="mobile" /><button type="submit">登录</button></form>
      </div>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    'https://mp.toutiao.com/auth/page/login',
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createSmzdmEditorFixture(): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <head><title>社区投稿 - 什么值得买</title></head>
    <body>
      <header class="smzdm-header">
        <span class="user-nickname">DemoOperator</span>
      </header>
      <main class="tougao-editor-page">
        <input type="text" class="tougao-title-input" placeholder="请输入文章标题" />
        <div class="ueditor-body smzdm-rich-editor" contenteditable="true" role="textbox" aria-label="好文正文"></div>
        <input type="file" accept="image/*" class="smzdm-image-upload" />
        <div class="tougao-actions">
          <button type="button" class="btn-save-draft">保存草稿</button>
          <button type="button" class="btn-submit-review">提交审核</button>
          <button type="button" class="btn-publish">发布</button>
          <button type="button" class="btn-publish-now">立即发布</button>
        </div>
      </main>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    'https://post.smzdm.com/tougao/',
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createSmzdmLoggedOutFixture(): PlatformFixture {
  const html = `<!doctype html>
  <html lang="zh-CN">
    <body>
      <div class="zhiyou-login-box">
        <h1>登录什么值得买</h1>
        <form><input name="account" /><button type="submit">登录</button></form>
      </div>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    'https://zhiyou.smzdm.com/user/login/',
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}

export function createBrokenEditorFixture(
  platform: ExtensionProviderKey,
): PlatformFixture {
  const urlByPlatform: Record<ExtensionProviderKey, string> = {
    ZHIHU_EXT: 'https://zhuanlan.zhihu.com/write',
    TOUTIAO_EXT: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    SMZDM_EXT: 'https://post.smzdm.com/tougao/',
  };
  const html = `<!doctype html>
  <html lang="zh-CN">
    <body>
      <header class="logged-in-shell"><span class="Avatar">DemoOperator</span></header>
      <main class="empty-shell"><p>编辑器加载中...</p></main>
    </body>
  </html>`;
  const { doc, url, dom } = createIsolatedPlatformDocument(
    html,
    urlByPlatform[platform],
  );
  return { doc, url, dom, spies: attachFixtureSpies(doc) };
}
