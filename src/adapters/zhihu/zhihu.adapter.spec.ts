import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, getAdapterByProvider, getAdapterByUrl, registerAdapter } from '../registry';
import type { ImageUploadResult, LocalImageUploader } from '../types';
import { createLocalImageUploader } from '../../content/image-uploader';
import { createContentMessageHandler } from '../../content/index';
import { getActiveCaptureBarHost, unmountCaptureBar } from '../../content/url-capture-bar';
import { DraftInjectReportSchema } from '../../shared/bridge-contract';
import { isCanonicalPublishedUrl, validatePublishedUrl } from '../../shared/url-validation';
import {
  ZHIHU_DEMO_URLS,
  createZhihuBrokenLayoutFixture,
  createZhihuDemoTask,
  createZhihuLoggedOutFixture,
  createZhihuPublishedPageFixture,
  createZhihuQuestionAnswerEditorFixture,
  createZhihuZhuanlanEditorFixture,
} from './fixtures';
import { createZhihuAdapter, sanitizeZhihuHtml, zhihuAdapter } from './zhihu.adapter';

const TEST_EXT_ID = 'geomix-zhihu-test-ext-id';
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function makeMockUploader(result?: Partial<ImageUploadResult>): LocalImageUploader {
  return {
    uploadAll: vi.fn(async (assets) => ({
      uploadedImages: result?.uploadedImages ?? assets.length,
      failedImages: result?.failedImages ?? 0,
      failures: result?.failures ?? [],
    })),
  };
}

function invokeContentHandler(
  handler: ReturnType<typeof createContentMessageHandler>,
  message: unknown,
  sender: chrome.runtime.MessageSender = { id: TEST_EXT_ID },
): Promise<{ handled: boolean; response?: unknown }> {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (resp: unknown) => {
      responded = true;
      resolve({ handled: true, response: resp });
    };
    const isAsync = handler(message, sender, sendResponse);
    if (!isAsync && !responded) {
      resolve({ handled: false });
    }
  });
}

describe('Zhihu PlatformDraftAdapter (ZHIHU_EXT)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAdapters();
    act(() => {
      unmountCaptureBar(document);
    });
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  describe('Group A — Contract Metadata, lastIndex Safety & Registry Integration', () => {
    it('exposes matching singleton and factory metadata for ZHIHU_EXT', () => {
      const created = createZhihuAdapter();

      for (const adapter of [zhihuAdapter, created]) {
        expect(adapter.provider).toBe('ZHIHU_EXT');
        expect(adapter.displayName).toBe('知乎');
        expect(adapter.editorEntryUrl).toBe('https://zhuanlan.zhihu.com/write');
        expect(adapter.publishedUrlPatterns).toHaveLength(2);
      }
    });

    it('uses stateless publishedUrlPatterns without global or sticky flags', () => {
      for (const pattern of zhihuAdapter.publishedUrlPatterns) {
        expect(pattern.global).toBe(false);
        expect(pattern.sticky).toBe(false);
      }

      for (let i = 0; i < 5; i += 1) {
        expect(
          zhihuAdapter.publishedUrlPatterns.some((p) => p.test(ZHIHU_DEMO_URLS.publishedArticle)),
        ).toBe(true);
        expect(
          zhihuAdapter.publishedUrlPatterns.some((p) => p.test(ZHIHU_DEMO_URLS.publishedAnswer)),
        ).toBe(true);
      }
    });

    it('integrates cleanly with adapter registry across editor and published Zhihu routes', () => {
      registerAdapter(zhihuAdapter);

      expect(getAdapterByProvider('ZHIHU_EXT')).toBe(zhihuAdapter);
      expect(getAdapterByUrl(new URL(ZHIHU_DEMO_URLS.zhuanlanWrite))).toBe(zhihuAdapter);
      expect(getAdapterByUrl(new URL(ZHIHU_DEMO_URLS.zhuanlanDraftEdit))).toBe(zhihuAdapter);
      expect(getAdapterByUrl(new URL(ZHIHU_DEMO_URLS.questionPage))).toBe(zhihuAdapter);
      expect(getAdapterByUrl(new URL(ZHIHU_DEMO_URLS.publishedArticle))).toBe(zhihuAdapter);
      expect(getAdapterByUrl(new URL(ZHIHU_DEMO_URLS.publishedAnswer))).toBe(zhihuAdapter);

      expect(getAdapterByUrl(new URL('https://evil.example.com/write'))).toBeUndefined();
      expect(getAdapterByUrl(new URL('http://zhuanlan.zhihu.com/write'))).toBeUndefined();
    });
  });

  describe('Group B — isLoggedInEditor(doc, url) Detection', () => {
    it('returns true on logged-in Zhuanlan /write and /p/:id/edit fixtures', () => {
      const writeFixture = createZhihuZhuanlanEditorFixture();
      expect(zhihuAdapter.isLoggedInEditor(writeFixture.doc, writeFixture.url)).toBe(true);

      const editFixture = createZhihuZhuanlanEditorFixture({
        url: ZHIHU_DEMO_URLS.zhuanlanDraftEdit,
      });
      expect(zhihuAdapter.isLoggedInEditor(editFixture.doc, editFixture.url)).toBe(true);
    });

    it('returns true on logged-in Question /question/:id and /question/:id/write fixtures', () => {
      const openQuestion = createZhihuQuestionAnswerEditorFixture();
      expect(zhihuAdapter.isLoggedInEditor(openQuestion.doc, openQuestion.url)).toBe(true);

      const questionWrite = createZhihuQuestionAnswerEditorFixture({
        url: ZHIHU_DEMO_URLS.questionWritePage,
      });
      expect(zhihuAdapter.isLoggedInEditor(questionWrite.doc, questionWrite.url)).toBe(true);

      // Logged-in collapsed answer page still has logged-in avatar so content runtime reaches EDITOR_NOT_FOUND
      const collapsedQuestion = createZhihuQuestionAnswerEditorFixture({ includeEditor: false });
      expect(zhihuAdapter.isLoggedInEditor(collapsedQuestion.doc, collapsedQuestion.url)).toBe(
        true,
      );
    });

    it('returns false on /signin, login-modal-only, logged-out header, and SignFlow overlay over editor', () => {
      const signin = createZhihuLoggedOutFixture('signin-page');
      expect(zhihuAdapter.isLoggedInEditor(signin.doc, signin.url)).toBe(false);

      const modalOnly = createZhihuLoggedOutFixture('login-modal-only');
      expect(zhihuAdapter.isLoggedInEditor(modalOnly.doc, modalOnly.url)).toBe(false);

      const loggedOutHeader = createZhihuLoggedOutFixture('logged-out-header');
      expect(zhihuAdapter.isLoggedInEditor(loggedOutHeader.doc, loggedOutHeader.url)).toBe(false);

      const overlay = createZhihuLoggedOutFixture('login-modal-overlay-editor');
      expect(zhihuAdapter.isLoggedInEditor(overlay.doc, overlay.url)).toBe(false);

      const blankDoc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
      expect(zhihuAdapter.isLoggedInEditor(blankDoc, new URL(ZHIHU_DEMO_URLS.zhuanlanWrite))).toBe(
        false,
      );
    });

    it('returns true when .SignFlow modal is hidden via attributes/inline style or CSS getComputedStyle', () => {
      const hiddenAttr = createZhihuLoggedOutFixture('hidden-login-modal-with-editor');
      expect(zhihuAdapter.isLoggedInEditor(hiddenAttr.doc, hiddenAttr.url)).toBe(true);

      const hiddenCss = createZhihuLoggedOutFixture('hidden-login-modal-with-editor', {
        mountToGlobalDocument: true,
        hideViaCssClass: true,
      });
      expect(zhihuAdapter.isLoggedInEditor(hiddenCss.doc, hiddenCss.url)).toBe(true);
    });

    it('returns false on non-editor, published, non-HTTPS, custom-port, credentialed, or foreign URLs', () => {
      const fixture = createZhihuZhuanlanEditorFixture();
      const rejectedUrls = [
        ZHIHU_DEMO_URLS.publishedArticle,
        ZHIHU_DEMO_URLS.publishedAnswer,
        'http://zhuanlan.zhihu.com/write',
        'https://zhuanlan.zhihu.com:8443/write',
        'https://user:pass@zhuanlan.zhihu.com/write',
        'https://evil.example.com/write',
        'https://www.zhihu.com/signin',
      ];

      for (const rawUrl of rejectedUrls) {
        expect(zhihuAdapter.isLoggedInEditor(fixture.doc, new URL(rawUrl))).toBe(false);
      }
    });
  });

  describe('Group C — injectDraft Zhuanlan Column Mode (/write & /p/:id/edit)', () => {
    it('sets React-controlled <textarea> title via native prototype setter with bubbling input & change events', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: true });
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(fixture.reactTitleTracker.wasDirectAssignmentUsed()).toBe(false);
      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.reactTitleTracker.getReactState()).toBe(task.variantTitle);
      expect(fixture.reactTitleTracker.getReactOnChangeCount()).toBeGreaterThanOrEqual(1);

      const events = fixture.reactTitleTracker.getDispatchedEvents();
      expect(events.some((e) => e.type === 'input' && e.bubbles)).toBe(true);
      expect(events.some((e) => e.type === 'change' && e.bubbles)).toBe(true);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.operatorReminders).toBeUndefined();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
    });

    it('supports fallback <input> title element with React prototype setter', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({
        titleElementTag: 'input',
        includeFileInput: false,
      });
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(fixture.reactTitleTracker.wasDirectAssignmentUsed()).toBe(false);
      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.reactTitleTracker.getReactState()).toBe(task.variantTitle);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
    });

    it('dispatches Draft.js ClipboardEvent paste and avoids double-insertion when paste is consumed', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: true });
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(fixture.pasteRecords).toHaveLength(1);
      expect(fixture.pasteRecords[0]?.bubbles).toBe(true);
      expect(fixture.pasteRecords[0]?.cancelable).toBe(true);
      expect(fixture.pasteRecords[0]?.html).toContain('<h2>核心测试结论</h2>');
      expect(fixture.pasteRecords[0]?.plain).toContain('核心测试结论');

      const occurrences =
        (fixture.editorElement.textContent ?? '').split('核心测试结论').length - 1;
      expect(occurrences).toBe(1);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('falls back to sanitized DOM replacement + bubbling input when paste is not consumed', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const inputSpy = vi.fn();
      fixture.editorElement.addEventListener('input', inputSpy);

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(fixture.editorElement.querySelector('h2')?.textContent).toBe('核心测试结论');
      const occurrences =
        (fixture.editorElement.textContent ?? '').split('核心测试结论').length - 1;
      expect(occurrences).toBe(1);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
    });

    it('injects cleanly on /p/:id/edit draft edit route without clicking publish', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({
        url: ZHIHU_DEMO_URLS.zhuanlanDraftEdit,
        simulateDraftJsPaste: true,
      });
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.editorElement.textContent).toContain('核心测试结论');
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
    });

    it('falls back to variantMarkdown when variantHtml is empty/whitespace and strips markdown images', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      const task = createZhihuDemoTask({
        variantHtml: '   \n\t  ',
        variantMarkdown: [
          '## Markdown 回退标题',
          '',
          '![外部配图](https://cdn.example.com/hotlink-md.png)',
          '',
          '正文段落包含 [示例文档](https://geo.example.com/guide) 与 [危险链接](javascript:alert(1))。',
          '',
          '- 列表项甲',
          '- 列表项乙',
        ].join('\n'),
        mediaAssets: [],
      });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.editorElement.querySelector('h2')?.textContent).toBe('Markdown 回退标题');
      expect(fixture.editorElement.querySelectorAll('li')).toHaveLength(2);
      expect(fixture.editorElement.querySelectorAll('img')).toHaveLength(0);
      expect(fixture.editorElement.innerHTML).not.toContain('hotlink-md.png');
      expect(fixture.editorElement.innerHTML).not.toContain('javascript:');
      expect(fixture.editorElement.querySelector('a')?.getAttribute('href')).toBe(
        'https://geo.example.com/guide',
      );
      expect(fixture.editorElement.textContent).toContain('危险链接');
    });

    it('falls back to variantMarkdown when variantHtml sanitizes to empty structural wrappers', async () => {
      const emptyWrapperCases = [
        '<p><img src="https://cdn.example.com/a.png" /></p>',
        '<p>   </p>',
        '<div><script>alert(1)</script></div>',
      ];

      for (const variantHtml of emptyWrapperCases) {
        const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
        const task = createZhihuDemoTask({
          variantHtml,
          variantMarkdown: '## 回退标题\n\nReal fallback markdown paragraph',
          mediaAssets: [],
        });

        const report = await zhihuAdapter.injectDraft(fixture.doc, task, makeMockUploader());

        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        expect(fixture.editorElement.querySelectorAll('img')).toHaveLength(0);
        expect(fixture.editorElement.querySelectorAll('script')).toHaveLength(0);
        expect(fixture.editorElement.querySelector('h2')?.textContent).toBe('回退标题');
        expect(fixture.editorElement.textContent).toContain('Real fallback markdown paragraph');
      }
    });

    it('parses balanced-delimiter Markdown images and links in linear time without fragment or URL leaks', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      const task = createZhihuDemoTask({
        variantHtml: '',
        variantMarkdown: [
          '![alt with text](https://cdn.example.com/a(1).png "title")',
          '',
          'Start ![alt [1]](https://cdn.example.com/a.png) End',
          '',
          'See [Wiki](https://en.example.org/wiki/Test_(2026)) now',
          '',
          'Click [here](javascript:alert(1)) please',
          '',
          '[Doc](https://geo.example.com/doc "Title (v2)")',
          '',
          'Raw <script>alert(1)</script> and <img src=x onerror=alert(1)> stay text',
        ].join('\n'),
        mediaAssets: [],
      });

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, makeMockUploader());

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.editorElement.querySelectorAll('img')).toHaveLength(0);
      expect(fixture.editorElement.querySelectorAll('script')).toHaveLength(0);

      const html = fixture.editorElement.innerHTML;
      const text = fixture.editorElement.textContent ?? '';
      expect(html).not.toContain('.png "title")');
      expect(html).not.toContain('cdn.example.com');
      expect(html).not.toContain('javascript:');
      expect(text).toContain('Start');
      expect(text).toContain('End');
      expect(text).toContain('Click here please');
      expect(text).not.toContain('here)');
      expect(text).toContain('Raw <script>alert(1)</script>');

      const anchors = Array.from(fixture.editorElement.querySelectorAll('a'));
      expect(anchors).toHaveLength(2);
      expect(anchors[0]?.getAttribute('href')).toBe('https://en.example.org/wiki/Test_(2026)');
      expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(anchors[0]?.textContent).toBe('Wiki');
      expect(text).not.toContain('Wiki)');

      expect(anchors[1]?.getAttribute('href')).toBe('https://geo.example.com/doc');
      expect(anchors[1]?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(anchors[1]?.textContent).toBe('Doc');

      // Linear-time resilience on adversarial unmatched delimiters
      const stressFixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      const stressTask = createZhihuDemoTask({
        variantHtml: '',
        variantMarkdown: `${'![a]('.repeat(1500)} ${'['.repeat(2000)} tail`,
        mediaAssets: [],
      });
      const stressReport = await zhihuAdapter.injectDraft(
        stressFixture.doc,
        stressTask,
        makeMockUploader(),
      );
      expect(stressReport.ok).toBe(true);
      expect(stressFixture.editorElement.textContent).toContain('tail');
    });

    it('sets React-controlled title cleanly when doc.defaultView is null and globalThis.HTMLTextAreaElement is unavailable', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ mountToGlobalDocument: false });
      expect(fixture.doc.defaultView).toBeNull();

      const task = createZhihuDemoTask({ mediaAssets: [] });
      const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLTextAreaElement');

      Object.defineProperty(globalThis, 'HTMLTextAreaElement', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      try {
        const report = await zhihuAdapter.injectDraft(fixture.doc, task, makeMockUploader());

        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        expect(fixture.reactTitleTracker.wasDirectAssignmentUsed()).toBe(false);
        expect(fixture.titleInput.value).toBe(task.variantTitle);
        expect(fixture.reactTitleTracker.getReactState()).toBe(task.variantTitle);
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'HTMLTextAreaElement', originalDescriptor);
        }
      }
    });
  });

  describe('Group D — injectDraft Question Answer Mode (/question/:id)', () => {
    it('injects answer body without requiring title input, leaves search bar untouched, and never clicks 发布回答', async () => {
      const fixture = createZhihuQuestionAnswerEditorFixture({ simulateDraftJsPaste: true });
      const task = createZhihuDemoTask({
        channelLabel: '知乎问答',
        targetUrlHint: ZHIHU_DEMO_URLS.questionPage,
      });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBe(2);
      expect(report.failedImages).toBe(0);
      expect(fixture.searchInput.value).toBe('');
      expect(fixture.pasteRecords).toHaveLength(1);
      expect(fixture.editorElement?.textContent).toContain('核心测试结论');
      expect(uploader.uploadAll).toHaveBeenCalledWith(task.mediaAssets, {
        editorElement: fixture.editorElement,
        fileInput: fixture.fileInput,
      });
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('returns EDITOR_NOT_FOUND when answer editor is collapsed even if a comment box decoy exists', async () => {
      const fixture = createZhihuQuestionAnswerEditorFixture({
        includeEditor: false,
        includeCommentBoxDecoy: true,
      });
      const task = createZhihuDemoTask({
        targetUrlHint: ZHIHU_DEMO_URLS.questionPage,
      });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(false);
      expect(report.stage).toBe('EDITOR_NOT_FOUND');
      expect(uploader.uploadAll).not.toHaveBeenCalled();
      expect(
        fixture.doc.querySelector('.CommentEditor [contenteditable="true"]')?.textContent,
      ).toBe('');
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });
  });

  describe('Group E — Security & Anti-Hotlink Adversarial Edge Cases', () => {
    it('strips XSS tags, event handlers, and javascript: links in both paste HTML and static DOM fallback', async () => {
      const maliciousHtml = [
        '<script>window.__xss=1</script>',
        '<iframe src="https://evil.example.com"></iframe>',
        '<svg onload="alert(1)"></svg>',
        '<style>body{display:none}</style>',
        '<p onclick="alert(1)" style="color:red">合法段落</p>',
        '<a href="javascript:alert(1)">危险链接</a>',
        '<a href="https://geo.example.com/doc" onclick="alert(2)">合法链接</a>',
      ].join('');

      const sanitized = sanitizeZhihuHtml(maliciousHtml, document);
      expect(sanitized.html).not.toMatch(
        /<script|<iframe|<svg|<style|onclick|onload|onerror|javascript:/i,
      );
      expect(sanitized.html).toContain('合法段落');
      expect(sanitized.html).toContain('https://geo.example.com/doc');
      expect(sanitized.html).toContain('危险链接');

      // Verify paste path
      const pasteFixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: true });
      const task = createZhihuDemoTask({ variantHtml: maliciousHtml, mediaAssets: [] });
      await zhihuAdapter.injectDraft(pasteFixture.doc, task, makeMockUploader());
      expect(pasteFixture.pasteRecords[0]?.html).not.toMatch(
        /<script|<iframe|<svg|<style|onclick|onload|onerror|javascript:/i,
      );
      expect(pasteFixture.pasteRecords[0]?.html).toContain('https://geo.example.com/doc');

      // Verify static fallback path
      const fallbackFixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      await zhihuAdapter.injectDraft(fallbackFixture.doc, task, makeMockUploader());
      expect(fallbackFixture.editorElement.innerHTML).not.toMatch(
        /<script|<iframe|<svg|<style|onclick|onload|onerror|javascript:/i,
      );
      expect(fallbackFixture.editorElement.textContent).toContain('合法段落');
      expect(fallbackFixture.editorElement.querySelector('a')?.getAttribute('href')).toBe(
        'https://geo.example.com/doc',
      );
    });

    it('strips external <img> tags from variantHtml in both paste and fallback paths while still relaying mediaAssets', async () => {
      const hotlinkHtml = [
        '<p>正文前段</p>',
        '<figure><img src="https://cdn.example.com/hotlink.png" alt="外链图" onerror="alert(1)" /><figcaption>图注说明</figcaption></figure>',
        '<picture><source srcset="https://cdn.example.com/hotlink.webp" /><img src="https://cdn.example.com/hotlink2.png" /></picture>',
      ].join('');

      const task = createZhihuDemoTask({ variantHtml: hotlinkHtml });

      const pasteFixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: true });
      const uploader1 = makeMockUploader();
      await zhihuAdapter.injectDraft(pasteFixture.doc, task, uploader1);

      expect(pasteFixture.pasteRecords[0]?.html).not.toContain('<img');
      expect(pasteFixture.pasteRecords[0]?.html).not.toContain('hotlink.png');
      expect(pasteFixture.pasteRecords[0]?.html).toContain('图注说明');
      expect(pasteFixture.editorElement.querySelectorAll('img')).toHaveLength(0);
      expect(uploader1.uploadAll).toHaveBeenCalledTimes(1);

      const fallbackFixture = createZhihuZhuanlanEditorFixture({ simulateDraftJsPaste: false });
      const uploader2 = makeMockUploader();
      await zhihuAdapter.injectDraft(fallbackFixture.doc, task, uploader2);

      expect(fallbackFixture.editorElement.querySelectorAll('img')).toHaveLength(0);
      expect(fallbackFixture.editorElement.innerHTML).not.toContain('hotlink.png');
      expect(uploader2.uploadAll).toHaveBeenCalledTimes(1);
    });

    it('never reads document.cookie during detection, injection, or URL extraction', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({ mountToGlobalDocument: true });
      const cookieSpy = vi.spyOn(Document.prototype, 'cookie', 'get');

      try {
        const task = createZhihuDemoTask({ mediaAssets: [] });
        zhihuAdapter.isLoggedInEditor(fixture.doc, fixture.url);
        await zhihuAdapter.injectDraft(fixture.doc, task, makeMockUploader());
        zhihuAdapter.extractPublishedUrl(new URL(ZHIHU_DEMO_URLS.publishedArticle), fixture.doc);

        expect(cookieSpy).not.toHaveBeenCalled();
      } finally {
        cookieSpy.mockRestore();
      }
    });
  });

  describe('Group F — Image Upload Relay & Failure Degradation', () => {
    it('relays mediaAssets via real createLocalImageUploader to body fileInput (avoiding cover input)', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({
        includeFileInput: true,
        includeCoverFileInput: true,
      });
      const task = createZhihuDemoTask();

      const bodyChangeEvents: number[] = [];
      fixture.fileInput?.addEventListener('change', () => {
        bodyChangeEvents.push(fixture.fileInput?.files?.length ?? 0);
      });
      const coverChangeSpy = vi.fn();
      fixture.coverFileInput?.addEventListener('change', coverChangeSpy);

      const realUploader = createLocalImageUploader({
        fetchMediaAsset: vi.fn(async (asset) => ({
          ok: true as const,
          data: {
            ok: true as const,
            url: asset.url,
            alt: asset.alt,
            mime: 'image/png',
            filename: `${asset.alt}.png`,
            byteLength: 68,
            base64: TINY_PNG_BASE64,
          },
        })),
      });

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, realUploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBe(2);
      expect(report.failedImages).toBe(0);
      expect(report.operatorReminders).toBeUndefined();
      expect(bodyChangeEvents).toEqual([1, 1]);
      expect(coverChangeSpy).not.toHaveBeenCalled();
      expect(fixture.fileInput?.files?.item(0)).toBeInstanceOf(File);
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('falls back to editorElement paste upload when body fileInput is absent', async () => {
      const fixture = createZhihuZhuanlanEditorFixture({
        includeFileInput: false,
        includeCoverFileInput: true,
        simulateDraftJsPaste: true,
      });
      const task = createZhihuDemoTask({
        mediaAssets: [
          {
            url: 'https://cdn.example.com/assets/paste-only.png',
            alt: '粘贴上传测试图',
            mime: 'image/png',
          },
        ],
      });

      const realUploader = createLocalImageUploader({
        fetchMediaAsset: vi.fn(async (asset) => ({
          ok: true as const,
          data: {
            ok: true as const,
            url: asset.url,
            alt: asset.alt,
            mime: 'image/png',
            filename: 'paste-only.png',
            byteLength: 68,
            base64: TINY_PNG_BASE64,
          },
        })),
      });

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, realUploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(0);

      const filePasteRecord = fixture.pasteRecords.find((record) => record.files.length > 0);
      expect(filePasteRecord?.files[0]).toBeInstanceOf(File);
      expect(filePasteRecord?.files[0]?.type).toBe('image/png');
    });

    it('skips uploader when task has zero mediaAssets', async () => {
      const fixture = createZhihuZhuanlanEditorFixture();
      const task = createZhihuDemoTask({ mediaAssets: [] });
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(uploader.uploadAll).not.toHaveBeenCalled();
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
    });

    it('degrades to PARTIAL_MEDIA_FAILED on partial failure without inserting external image URLs', async () => {
      const fixture = createZhihuZhuanlanEditorFixture();
      const task = createZhihuDemoTask();
      const uploader = makeMockUploader({
        uploadedImages: 1,
        failedImages: 1,
        failures: [
          {
            url: 'https://cdn.example.com/assets/demo-chart-2.webp',
            alt: '场景实测数据图',
            reason: '图片下载超时（15s）',
          },
        ],
      });

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(1);
      expect(report.failedImageDetails).toHaveLength(1);
      expect(report.failedImageDetails?.[0]?.alt).toBe('场景实测数据图');
      expect(report.operatorReminders?.length).toBeGreaterThanOrEqual(1);
      expect(report.message).toContain('场景实测数据图');

      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.editorElement.textContent).toContain('核心测试结论');
      expect(fixture.editorElement.querySelectorAll('img')).toHaveLength(0);
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('degrades to PARTIAL_MEDIA_FAILED when all media assets fail while preserving injected draft text', async () => {
      const fixture = createZhihuZhuanlanEditorFixture();
      const task = createZhihuDemoTask();
      const uploader = makeMockUploader({
        uploadedImages: 0,
        failedImages: 2,
        failures: [
          {
            url: 'https://cdn.example.com/assets/demo-chart-1.png',
            alt: '核心指标对比图',
            reason: 'HTTP 403',
          },
          {
            url: 'https://cdn.example.com/assets/demo-chart-2.webp',
            alt: '场景实测数据图',
            reason: 'HTTP 404',
          },
        ],
      });

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(2);
      expect(report.failedImageDetails).toHaveLength(2);
      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.editorElement.textContent).toContain('核心测试结论');
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('catches unexpected uploader exceptions and redacts sensitive gmext_ tokens', async () => {
      const fixture = createZhihuZhuanlanEditorFixture();
      const task = createZhihuDemoTask();
      const throwingUploader: LocalImageUploader = {
        uploadAll: vi.fn(async () => {
          throw new Error('上游代理拒绝: Bearer gmext_demo_secret_token_999');
        }),
      };

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, throwingUploader);

      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(2);
      expect(JSON.stringify(report)).not.toContain('gmext_demo_secret_token_999');
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('redacts raw gmext_ tokens inside alt across failedImageDetails, operatorReminders, and message', async () => {
      const secretToken = 'gmext_demo_secret_token_999';

      // Case 1: uploader returns failure whose alt/url/reason all contain raw token
      const fixture1 = createZhihuZhuanlanEditorFixture();
      const task1 = createZhihuDemoTask();
      const uploader1 = makeMockUploader({
        uploadedImages: 1,
        failedImages: 1,
        failures: [
          {
            url: `https://cdn.example.com/a.png?token=${secretToken}`,
            alt: `图表 ${secretToken}`,
            reason: `401 invalid ${secretToken}`,
          },
        ],
      });

      const report1 = await zhihuAdapter.injectDraft(fixture1.doc, task1, uploader1);
      expect(report1.ok).toBe(false);
      expect(report1.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(JSON.stringify(report1)).not.toContain(secretToken);
      expect(report1.failedImageDetails?.[0]?.alt).not.toContain(secretToken);
      expect(report1.failedImageDetails?.[0]?.url).not.toContain(secretToken);
      expect(report1.failedImageDetails?.[0]?.reason).not.toContain(secretToken);
      expect(report1.operatorReminders?.join(' ')).not.toContain(secretToken);
      expect(report1.message).not.toContain(secretToken);
      expect(DraftInjectReportSchema.safeParse(report1).success).toBe(true);

      // Case 2: uploader throws when mediaAsset.alt contains raw token
      const fixture2 = createZhihuZhuanlanEditorFixture();
      const task2 = createZhihuDemoTask({
        mediaAssets: [
          {
            url: `https://cdn.example.com/b.png?auth=${secretToken}`,
            alt: `机密图 ${secretToken}`,
            mime: 'image/png',
          },
        ],
      });
      const throwingUploader: LocalImageUploader = {
        uploadAll: vi.fn(async () => {
          throw new Error(`network fail ${secretToken}`);
        }),
      };

      const report2 = await zhihuAdapter.injectDraft(fixture2.doc, task2, throwingUploader);
      expect(report2.ok).toBe(false);
      expect(report2.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(JSON.stringify(report2)).not.toContain(secretToken);
      expect(DraftInjectReportSchema.safeParse(report2).success).toBe(true);
    });

    it('coerces malformed or mismatched LocalImageUploader outputs into schema-valid reports without dropping failures', async () => {
      const task = createZhihuDemoTask();

      // 1) Negative uploadedImages -> clamped to 0
      const f1 = createZhihuZhuanlanEditorFixture();
      const r1 = await zhihuAdapter.injectDraft(
        f1.doc,
        task,
        makeMockUploader({ uploadedImages: -1, failedImages: 0, failures: [] }),
      );
      expect(r1.ok).toBe(true);
      expect(r1.stage).toBe('INJECTED');
      expect(r1.uploadedImages).toBe(0);
      expect(r1.failedImages).toBe(0);
      expect(DraftInjectReportSchema.safeParse(r1).success).toBe(true);

      // 2) Float failedImages with empty failures -> floored to 1, PARTIAL_MEDIA_FAILED, non-empty failedImageDetails
      const f2 = createZhihuZhuanlanEditorFixture();
      const r2 = await zhihuAdapter.injectDraft(
        f2.doc,
        task,
        makeMockUploader({ uploadedImages: 0, failedImages: 1.5, failures: [] }),
      );
      expect(r2.ok).toBe(false);
      expect(r2.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(r2.uploadedImages).toBe(0);
      expect(r2.failedImages).toBe(1);
      expect(r2.failedImageDetails?.length).toBeGreaterThanOrEqual(1);
      expect(DraftInjectReportSchema.safeParse(r2).success).toBe(true);

      // 3) NaN counts -> coerced to 0
      const f3 = createZhihuZhuanlanEditorFixture();
      const r3 = await zhihuAdapter.injectDraft(
        f3.doc,
        task,
        makeMockUploader({ uploadedImages: Number.NaN, failedImages: Number.NaN, failures: [] }),
      );
      expect(r3.ok).toBe(true);
      expect(r3.stage).toBe('INJECTED');
      expect(r3.uploadedImages).toBe(0);
      expect(r3.failedImages).toBe(0);
      expect(DraftInjectReportSchema.safeParse(r3).success).toBe(true);

      // 4) Mismatched failedImages: 0 with non-empty failures -> preserves failure as PARTIAL_MEDIA_FAILED
      const f4 = createZhihuZhuanlanEditorFixture();
      const r4 = await zhihuAdapter.injectDraft(
        f4.doc,
        task,
        makeMockUploader({
          uploadedImages: 1,
          failedImages: 0,
          failures: [
            {
              url: 'https://cdn.example.com/assets/demo-chart-2.webp',
              alt: '场景实测数据图',
              reason: 'timeout',
            },
          ],
        }),
      );
      expect(r4.ok).toBe(false);
      expect(r4.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(r4.uploadedImages).toBe(1);
      expect(r4.failedImages).toBe(1);
      expect(r4.failedImageDetails).toHaveLength(1);
      expect(DraftInjectReportSchema.safeParse(r4).success).toBe(true);
    });

    it('skips non-image file inputs (video/* and .doc,.docx,.md) and Question .CommentEditor file inputs so image relay falls back cleanly', async () => {
      // Zhuanlan: cover input + video/* + .doc,.docx,.md, NO body image input -> fileInput: null
      const zhuanlanFixture = createZhihuZhuanlanEditorFixture({
        includeFileInput: false,
        includeCoverFileInput: true,
        includeNonImageFileInputs: true,
      });
      const zhuanlanUploader = makeMockUploader();
      const zhuanlanTask = createZhihuDemoTask();

      await zhihuAdapter.injectDraft(zhuanlanFixture.doc, zhuanlanTask, zhuanlanUploader);
      expect(zhuanlanUploader.uploadAll).toHaveBeenCalledWith(zhuanlanTask.mediaAssets, {
        editorElement: zhuanlanFixture.editorElement,
        fileInput: null,
      });

      // Question: NO AnswerForm fileInput, but .CommentEditor has image fileInput -> fileInput: null
      const questionFixture = createZhihuQuestionAnswerEditorFixture({
        includeFileInput: false,
        includeEditor: true,
        includeCommentFileInputDecoy: true,
      });
      const questionUploader = makeMockUploader();
      const questionTask = createZhihuDemoTask({
        targetUrlHint: ZHIHU_DEMO_URLS.questionPage,
      });

      await zhihuAdapter.injectDraft(questionFixture.doc, questionTask, questionUploader);
      expect(questionUploader.uploadAll).toHaveBeenCalledWith(questionTask.mediaAssets, {
        editorElement: questionFixture.editorElement,
        fileInput: null,
      });
    });
  });

  describe('Group G — Auth & Broken-Layout Failure Modes + Content Runtime Integration', () => {
    it('returns AUTH_REQUIRED on SignFlow overlay without touching editor, uploader, or publish button', async () => {
      const fixture = createZhihuLoggedOutFixture('login-modal-overlay-editor');
      const task = createZhihuDemoTask();
      const uploader = makeMockUploader();

      const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(false);
      expect(report.stage).toBe('AUTH_REQUIRED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
      expect(fixture.titleInput?.value).toBe('');
      expect(fixture.editorElement?.textContent).toBe('');
      expect(uploader.uploadAll).not.toHaveBeenCalled();
      expect(fixture.publishClickSpy).not.toHaveBeenCalled();
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
    });

    it('returns EDITOR_NOT_FOUND on broken logged-in layouts without calling uploader', async () => {
      const variants = ['missing-all', 'missing-body', 'missing-title-zhuanlan'] as const;
      const task = createZhihuDemoTask();

      for (const variant of variants) {
        const fixture = createZhihuBrokenLayoutFixture(variant);
        const uploader = makeMockUploader();
        const report = await zhihuAdapter.injectDraft(fixture.doc, task, uploader);

        expect(report.ok).toBe(false);
        expect(report.stage).toBe('EDITOR_NOT_FOUND');
        expect(uploader.uploadAll).not.toHaveBeenCalled();
        expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      }
    });

    it('never hijacks header search inputs or non-text inputs when Zhuanlan title input is missing', async () => {
      const task = createZhihuDemoTask({ mediaAssets: [] });

      // 1) <header class="AppHeader"><input type="search" placeholder="搜索文章标题或话题" /></header>
      const searchDoc = new DOMParser().parseFromString(
        `<!doctype html><html><body>
          <header class="AppHeader">
            <input type="search" id="top-search" placeholder="搜索文章标题或话题" />
            <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
          </header>
          <main class="WriteIndex-editor">
            <div class="DraftEditor-root">
              <div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div>
            </div>
          </main>
        </body></html>`,
        'text/html',
      );
      const searchReport = await zhihuAdapter.injectDraft(searchDoc, task, makeMockUploader());
      expect(searchReport.ok).toBe(false);
      expect(searchReport.stage).toBe('EDITOR_NOT_FOUND');
      expect(searchDoc.querySelector<HTMLInputElement>('#top-search')?.value).toBe('');

      // 2) .SearchBar <input type="text" placeholder="搜索你感兴趣的内容或标题" />
      const textSearchDoc = new DOMParser().parseFromString(
        `<!doctype html><html><body>
          <header class="AppHeader">
            <div class="SearchBar" role="search">
              <input type="text" id="header-search" placeholder="搜索你感兴趣的内容或标题" />
            </div>
            <img class="AppHeader-profileAvatar" alt="测试作者" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
          </header>
          <main class="WriteIndex-editor">
            <input type="email" id="email-decoy" placeholder="请输入标题邮箱" />
            <div class="DraftEditor-root">
              <div class="public-DraftEditor-content" contenteditable="true" role="textbox"></div>
            </div>
          </main>
        </body></html>`,
        'text/html',
      );
      const textSearchReport = await zhihuAdapter.injectDraft(
        textSearchDoc,
        task,
        makeMockUploader(),
      );
      expect(textSearchReport.ok).toBe(false);
      expect(textSearchReport.stage).toBe('EDITOR_NOT_FOUND');
      expect(textSearchDoc.querySelector<HTMLInputElement>('#header-search')?.value).toBe('');
      expect(textSearchDoc.querySelector<HTMLInputElement>('#email-decoy')?.value).toBe('');
    });

    it('integrates with createContentMessageHandler for EDITOR_NOT_FOUND, AUTH_REQUIRED, Mode B notice, and clean INJECTED', async () => {
      registerAdapter(zhihuAdapter);
      const task = createZhihuDemoTask();

      // 1) Logged-in broken layout -> EDITOR_NOT_FOUND (not misclassified as AUTH_REQUIRED)
      const broken = createZhihuBrokenLayoutFixture('missing-body');
      const brokenHandler = createContentMessageHandler({
        extensionId: TEST_EXT_ID,
        doc: broken.doc,
        getCurrentUrl: () => broken.url,
        uploader: makeMockUploader(),
      });
      const brokenRes = await invokeContentHandler(brokenHandler, {
        type: 'INJECT_DRAFT',
        payload: { task },
      });
      expect(brokenRes.handled).toBe(true);
      expect((brokenRes.response as { data: { stage: string } }).data.stage).toBe(
        'EDITOR_NOT_FOUND',
      );

      // 2) Logged-out SignFlow overlay -> AUTH_REQUIRED
      const overlay = createZhihuLoggedOutFixture('login-modal-overlay-editor');
      const overlayHandler = createContentMessageHandler({
        extensionId: TEST_EXT_ID,
        doc: overlay.doc,
        getCurrentUrl: () => overlay.url,
        uploader: makeMockUploader(),
      });
      const overlayRes = await invokeContentHandler(overlayHandler, {
        type: 'INJECT_DRAFT',
        payload: { task },
      });
      expect((overlayRes.response as { data: { stage: string } }).data.stage).toBe('AUTH_REQUIRED');

      // 3) Partial media failure -> mounts Shadow DOM Mode B notice bar with failed image details
      const partialFixture = createZhihuZhuanlanEditorFixture({ mountToGlobalDocument: true });
      const partialHandler = createContentMessageHandler({
        extensionId: TEST_EXT_ID,
        doc: partialFixture.doc,
        getCurrentUrl: () => partialFixture.url,
        uploader: makeMockUploader({
          uploadedImages: 1,
          failedImages: 1,
          failures: [
            {
              url: 'https://cdn.example.com/assets/demo-chart-2.webp',
              alt: '场景实测数据图',
              reason: 'HTTP 403 防盗链拒绝',
            },
          ],
        }),
      });
      let partialRes: { handled: boolean; response?: unknown } = { handled: false };
      await act(async () => {
        partialRes = await invokeContentHandler(partialHandler, {
          type: 'INJECT_DRAFT',
          payload: { task },
        });
      });
      expect((partialRes.response as { data: { stage: string } }).data.stage).toBe(
        'PARTIAL_MEDIA_FAILED',
      );
      const host = getActiveCaptureBarHost(partialFixture.doc);
      expect(host).not.toBeNull();
      expect(host?.shadowRoot?.textContent).toContain('场景实测数据图');
      expect(host?.shadowRoot?.textContent).toContain('HTTP 403 防盗链拒绝');

      // 4) Clean INJECTED -> unmounts stale notice bar and does NOT mount Mode B bar
      const cleanHandler = createContentMessageHandler({
        extensionId: TEST_EXT_ID,
        doc: partialFixture.doc,
        getCurrentUrl: () => partialFixture.url,
        uploader: makeMockUploader({ uploadedImages: 2, failedImages: 0, failures: [] }),
      });
      await act(async () => {
        await invokeContentHandler(cleanHandler, {
          type: 'INJECT_DRAFT',
          payload: { task },
        });
      });
      expect(getActiveCaptureBarHost(partialFixture.doc)).toBeNull();
    });
  });

  describe('Group H — extractPublishedUrl(url, doc) Allowlist & Adversarial Cases', () => {
    it('extracts and normalizes Zhuanlan published article URLs stripping query, hash, and trailing slash', () => {
      const withQuery = createZhihuPublishedPageFixture({
        pageUrl: ZHIHU_DEMO_URLS.publishedArticleWithQuery,
      });
      const result1 = zhihuAdapter.extractPublishedUrl(withQuery.url, withQuery.doc);
      expect(result1).toBe(ZHIHU_DEMO_URLS.publishedArticle);
      expect(isCanonicalPublishedUrl(result1!, 'ZHIHU_EXT')).toBe(true);
      expect(validatePublishedUrl('ZHIHU_EXT', result1!).ok).toBe(true);

      const withTrailingSlash = createZhihuPublishedPageFixture({
        pageUrl: `${ZHIHU_DEMO_URLS.publishedArticle}/`,
      });
      const result2 = zhihuAdapter.extractPublishedUrl(
        withTrailingSlash.url,
        withTrailingSlash.doc,
      );
      expect(result2).toBe(ZHIHU_DEMO_URLS.publishedArticle);
    });

    it('extracts and normalizes Zhihu published question answer URLs stripping query, hash, and trailing slash', () => {
      const answer = createZhihuPublishedPageFixture({
        pageUrl: ZHIHU_DEMO_URLS.publishedAnswerWithQuery,
      });
      const result = zhihuAdapter.extractPublishedUrl(answer.url, answer.doc);
      expect(result).toBe(ZHIHU_DEMO_URLS.publishedAnswer);
      expect(isCanonicalPublishedUrl(result!, 'ZHIHU_EXT')).toBe(true);
      expect(validatePublishedUrl('ZHIHU_EXT', result!).ok).toBe(true);
    });

    it('uses same-origin valid <link rel="canonical"> fallback on published sub-views', () => {
      const articleSubView = createZhihuPublishedPageFixture({
        pageUrl: ZHIHU_DEMO_URLS.publishedArticleSubView,
        canonicalHref: `${ZHIHU_DEMO_URLS.publishedArticle}?ref=canonical#top`,
      });
      const res1 = zhihuAdapter.extractPublishedUrl(articleSubView.url, articleSubView.doc);
      expect(res1).toBe(ZHIHU_DEMO_URLS.publishedArticle);
      expect(isCanonicalPublishedUrl(res1!, 'ZHIHU_EXT')).toBe(true);

      const answerSubView = createZhihuPublishedPageFixture({
        pageUrl: ZHIHU_DEMO_URLS.publishedAnswerSubView,
        canonicalHref: `${ZHIHU_DEMO_URLS.publishedAnswer}/?ref=canonical`,
      });
      const res2 = zhihuAdapter.extractPublishedUrl(answerSubView.url, answerSubView.doc);
      expect(res2).toBe(ZHIHU_DEMO_URLS.publishedAnswer);
      expect(isCanonicalPublishedUrl(res2!, 'ZHIHU_EXT')).toBe(true);
    });

    it('ignores malicious or cross-origin <link rel="canonical"> values', () => {
      const maliciousCanonicals = [
        'http://127.0.0.1/p/1',
        'https://evil.example.com/p/1',
        'https://zhuanlan.zhihu.com/p/123/edit',
        'javascript:alert(1)',
        'https://zhuanlan.zhihu.com:8443/p/123456789',
        'https://user:pass@zhuanlan.zhihu.com/p/123456789',
        'https://zhuanlan.zhihu.com/p/123456789/edit/%2e%2e',
        // Cross-origin canonical (www.zhihu.com on zhuanlan.zhihu.com)
        ZHIHU_DEMO_URLS.publishedAnswer,
      ];

      for (const badCanonical of maliciousCanonicals) {
        // On a valid published URL, direct URL check succeeds and ignores malicious canonical
        const published = createZhihuPublishedPageFixture({
          pageUrl: ZHIHU_DEMO_URLS.publishedArticle,
          canonicalHref: badCanonical,
        });
        expect(zhihuAdapter.extractPublishedUrl(published.url, published.doc)).toBe(
          ZHIHU_DEMO_URLS.publishedArticle,
        );

        // On a non-direct sub-view, malicious canonical is rejected -> null
        const subView = createZhihuPublishedPageFixture({
          pageUrl: ZHIHU_DEMO_URLS.publishedArticleSubView,
          canonicalHref: badCanonical,
        });
        expect(zhihuAdapter.extractPublishedUrl(subView.url, subView.doc)).toBeNull();
      }
    });

    it('never allows draft, edit, auth, or bare question routes to be spoofed via <link rel="canonical">', () => {
      const blockedCases: Array<{ pageUrl: string; canonicalHref: string }> = [
        {
          pageUrl: ZHIHU_DEMO_URLS.zhuanlanDraftEdit,
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: ZHIHU_DEMO_URLS.zhuanlanWrite,
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: ZHIHU_DEMO_URLS.questionPage,
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        {
          pageUrl: ZHIHU_DEMO_URLS.questionWritePage,
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        {
          pageUrl: ZHIHU_DEMO_URLS.signinPage,
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        // Answer /edit route must never fall back to canonical
        {
          pageUrl: ZHIHU_DEMO_URLS.publishedAnswerEdit,
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        // Draft / preview / non-published routes
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/123456789/draft',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/123456789/preview',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/123456789/..',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/drafts',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://www.zhihu.com/',
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        {
          pageUrl: 'https://www.zhihu.com/question/987654321/answers/created',
          canonicalHref: ZHIHU_DEMO_URLS.publishedAnswer,
        },
        // Double-slash and percent-encoded path bypasses
        {
          pageUrl: 'https://zhuanlan.zhihu.com//write',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com//p/123456789/edit',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/123456789//voters',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/%77rite',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/123456789/%65dit',
          canonicalHref: ZHIHU_DEMO_URLS.publishedArticle,
        },
        // Cross-article and cross-answer exact ID spoofing on allowed sub-views
        {
          pageUrl: 'https://zhuanlan.zhihu.com/p/111/voters',
          canonicalHref: 'https://zhuanlan.zhihu.com/p/999',
        },
        {
          pageUrl: 'https://www.zhihu.com/question/100/answer/200/comments',
          canonicalHref: 'https://www.zhihu.com/question/999/answer/888',
        },
      ];

      for (const testCase of blockedCases) {
        const fixture = createZhihuPublishedPageFixture(testCase);
        expect(zhihuAdapter.extractPublishedUrl(fixture.url, fixture.doc)).toBeNull();
      }
    });

    it('rejects draft, non-HTTPS, custom-port, private-IP, cross-provider, and path-traversal URLs', () => {
      const emptyDoc = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
      const rejectedUrls = [
        ZHIHU_DEMO_URLS.zhuanlanWrite,
        ZHIHU_DEMO_URLS.zhuanlanDraftEdit,
        ZHIHU_DEMO_URLS.questionPage,
        'http://zhuanlan.zhihu.com/p/123456789',
        'https://zhuanlan.zhihu.com:8443/p/123456789',
        'https://127.0.0.1/p/123456789',
        'https://evil.example.com/p/123456789',
        'https://www.toutiao.com/article/7123456789012345678',
        'https://post.smzdm.com/p/a1b2c3d4',
        'https://zhuanlan.zhihu.com/p/123456789/comments',
        'https://zhuanlan.zhihu.com/p/not-a-number',
        'https://www.zhihu.com/question/987654321/answer/not-a-number',
      ];

      for (const rawUrl of rejectedUrls) {
        expect(zhihuAdapter.extractPublishedUrl(new URL(rawUrl), emptyDoc)).toBeNull();
      }

      // Raw string path traversal is also rejected before URL normalization
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit/%2e%2e').ok,
      ).toBe(false);
    });
  });

  it('rejects direct injectDraft calls with mismatched task.provider without mutating DOM (C2-05)', async () => {
    const fixture = createZhihuZhuanlanEditorFixture();
    const wrongTask = {
      ...createZhihuDemoTask(),
      provider: 'TOUTIAO_EXT' as const,
    };
    const uploader = makeMockUploader();

    const report = await zhihuAdapter.injectDraft(fixture.doc, wrongTask, uploader);
    expect(report).toMatchObject({
      ok: false,
      stage: 'EDITOR_NOT_FOUND',
      uploadedImages: 0,
      failedImages: 0,
    });
    expect(fixture.titleInput.value).toBe('');
  });
});
