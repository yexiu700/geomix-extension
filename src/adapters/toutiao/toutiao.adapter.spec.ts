import { act } from '@testing-library/react';
// @ts-expect-error jsdom ships without bundled TypeScript declarations
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAdapters, getAdapterByProvider, getAdapterByUrl, registerAdapter } from '../registry';
import type { ImageUploadResult, LocalImageUploader } from '../types';
import { createContentMessageHandler, createUrlCaptureCoordinator } from '../../content/index';
import {
  CAPTURE_BAR_HOST_ID,
  getActiveCaptureBarHost,
  getActiveCaptureBarMode,
  unmountCaptureBar,
} from '../../content/url-capture-bar';
import { DraftInjectReportSchema } from '../../shared/bridge-contract';
import { PUBLISHED_URL_PATTERNS, validatePublishedUrl } from '../../shared/url-validation';
import {
  TOUTIAO_DEMO_ARTICLE_ID,
  TOUTIAO_EDITOR_QUERY_URL,
  TOUTIAO_EDITOR_URL,
  TOUTIAO_LOGIN_REDIRECT_URL,
  TOUTIAO_SSO_LOGIN_URL,
  createDemoToutiaoTask,
  createToutiaoAdversarialButtonsDocument,
  createToutiaoBrokenEditorDocument,
  createToutiaoEditorDocument,
  createToutiaoLoginModalDocument,
  createToutiaoLoginRedirectDocument,
  createToutiaoPublishedDocument,
} from './fixtures';
import { TOUTIAO_EDITOR_ENTRY_URL, createToutiaoAdapter, toutiaoAdapter } from './toutiao.adapter';

function createMockUploader(
  result: ImageUploadResult = { uploadedImages: 2, failedImages: 0, failures: [] },
): {
  uploader: LocalImageUploader;
  uploadAll: ReturnType<typeof vi.fn<LocalImageUploader['uploadAll']>>;
} {
  const uploadAll = vi.fn<LocalImageUploader['uploadAll']>(async () => result);
  return {
    uploader: { uploadAll },
    uploadAll,
  };
}

describe('Toutiao Adapter (TOUTIAO_EXT)', () => {
  afterEach(() => {
    clearAdapters();
    unmountCaptureBar(document);
  });

  describe('metadata & factory contract', () => {
    it('exposes exact metadata and independent factory instances', () => {
      const created = createToutiaoAdapter();
      expect(created).not.toBe(toutiaoAdapter);
      expect(toutiaoAdapter.provider).toBe('TOUTIAO_EXT');
      expect(toutiaoAdapter.displayName).toBe('今日头条');
      expect(toutiaoAdapter.editorEntryUrl).toBe(TOUTIAO_EDITOR_ENTRY_URL);
      expect(toutiaoAdapter.editorEntryUrl).toBe(
        'https://mp.toutiao.com/profile_v4/graphic/publish',
      );
      expect(toutiaoAdapter.publishedUrlPatterns).toEqual(PUBLISHED_URL_PATTERNS.TOUTIAO_EXT);
      expect(created.provider).toBe('TOUTIAO_EXT');
      expect(created.editorEntryUrl).toBe(TOUTIAO_EDITOR_ENTRY_URL);
    });
  });

  describe('isLoggedInEditor', () => {
    it('returns true for authenticated mp.toutiao.com graphic publish and edit URLs', () => {
      const editorDoc = createToutiaoEditorDocument();
      expect(toutiaoAdapter.isLoggedInEditor(editorDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);
      expect(toutiaoAdapter.isLoggedInEditor(editorDoc, new URL(`${TOUTIAO_EDITOR_URL}/`))).toBe(
        true,
      );
      expect(toutiaoAdapter.isLoggedInEditor(editorDoc, new URL(TOUTIAO_EDITOR_QUERY_URL))).toBe(
        true,
      );
      expect(
        toutiaoAdapter.isLoggedInEditor(
          editorDoc,
          new URL('https://mp.toutiao.com/profile_v4/graphic/edit?pgc_id=demo_1'),
        ),
      ).toBe(true);
      expect(
        toutiaoAdapter.isLoggedInEditor(
          editorDoc,
          new URL(`https://mp.toutiao.com/profile_v4/graphic/edit/${TOUTIAO_DEMO_ARTICLE_ID}`),
        ),
      ).toBe(true);
    });

    it('returns true when a login modal exists in DOM but is hidden (including aria-hidden="TRUE" and opacity: 0%)', () => {
      const doc = createToutiaoLoginModalDocument({ hidden: true });
      expect(toutiaoAdapter.isLoggedInEditor(doc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);

      const upperAriaDoc = createToutiaoEditorDocument();
      const upperModal = upperAriaDoc.createElement('div');
      upperModal.className = 'byte-login-modal';
      upperModal.setAttribute('aria-hidden', 'TRUE');
      upperModal.textContent = '扫码登录头条号';
      upperAriaDoc.body.appendChild(upperModal);
      expect(toutiaoAdapter.isLoggedInEditor(upperAriaDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);

      const zeroPctOpacityDoc = createToutiaoEditorDocument();
      const opacityModal = zeroPctOpacityDoc.createElement('div');
      opacityModal.className = 'byte-login-modal';
      opacityModal.setAttribute('style', 'opacity: 0%');
      opacityModal.textContent = '扫码登录头条号';
      zeroPctOpacityDoc.body.appendChild(opacityModal);
      expect(toutiaoAdapter.isLoggedInEditor(zeroPctOpacityDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(
        true,
      );
    });

    it('returns true on authenticated editor URL with broken DOM so injectDraft reports EDITOR_NOT_FOUND', () => {
      const brokenDoc = createToutiaoBrokenEditorDocument('both');
      expect(toutiaoAdapter.isLoggedInEditor(brokenDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);
    });

    it('does not false-positive when article prose mentions login phrases inside ProseMirror or inside an ancestor wrapper containing "login"', async () => {
      const doc = createToutiaoEditorDocument({
        initialBodyHtml:
          '<p>本教程讨论用户如何处理扫码登录、手机号登录与头条号登录流程体验优化。</p>',
      });
      const wrapper = doc.querySelector('main.publish-editor-wrapper')!;
      wrapper.classList.add('is-login');

      expect(toutiaoAdapter.isLoggedInEditor(doc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);

      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });
      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
    });

    it('does not false-positive when a visible non-login dialog contains hidden login text', () => {
      const doc = createToutiaoEditorDocument();
      const settingsModal = doc.createElement('div');
      settingsModal.setAttribute('role', 'dialog');
      settingsModal.className = 'byte-modal';
      settingsModal.innerHTML = '<h3>文章排版设置</h3><span style="display:none">扫码登录</span>';
      doc.body.appendChild(settingsModal);

      expect(toutiaoAdapter.isLoggedInEditor(doc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);
    });

    it('ignores elements inside the extension Shadow DOM capture host', () => {
      const doc = createToutiaoEditorDocument();
      const captureHost = doc.createElement('div');
      captureHost.id = CAPTURE_BAR_HOST_ID;
      captureHost.innerHTML = '<div class="login-modal"><p>登录头条号</p></div>';
      doc.body.appendChild(captureHost);

      expect(toutiaoAdapter.isLoggedInEditor(doc, new URL(TOUTIAO_EDITOR_URL))).toBe(true);
    });

    it('returns false on login redirects, SSO hosts, encoded traversal/slash bypasses, arbitrary subpaths, public article URLs, and invalid origins', () => {
      const editorDoc = createToutiaoEditorDocument();
      const loginDoc = createToutiaoLoginRedirectDocument();

      const rejectedUrls = [
        TOUTIAO_LOGIN_REDIRECT_URL,
        TOUTIAO_SSO_LOGIN_URL,
        'https://passport.toutiao.com/login/',
        'https://passport.bytedance.com/auth',
        `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`,
        'http://mp.toutiao.com/profile_v4/graphic/publish',
        'https://mp.toutiao.com:8443/profile_v4/graphic/publish',
        'https://user:pass@mp.toutiao.com/profile_v4/graphic/publish',
        'https://mp.toutiao.com/profile_v4/graphic/publish/%2e%2e/auth/login',
        'https://mp.toutiao.com/profile_v4/graphic/publish/..%2f..%2fauth%2flogin',
        'https://mp.toutiao.com/profile_v4/graphic/publish/..%2Fauth%2Flogin',
        'https://mp.toutiao.com/profile_v4/graphic/publish/%252e%252e/publish',
        'https://mp.toutiao.com/profile_v4/graphic/publish/anything/arbitrary',
        'https://mp.toutiao.com/profile_v4/graphic/publish/%6c%6f%67%69%6e',
        'https://mp.toutiao.com/profile_v4/graphic/articles',
        'https://mp.toutiao.com.evil.example.com/profile_v4/graphic/publish',
      ];

      for (const rawUrl of rejectedUrls) {
        expect(
          toutiaoAdapter.isLoggedInEditor(editorDoc, new URL(rawUrl)),
          `Expected URL "${rawUrl}" to be rejected`,
        ).toBe(false);
      }
      expect(toutiaoAdapter.isLoggedInEditor(loginDoc, new URL(TOUTIAO_LOGIN_REDIRECT_URL))).toBe(
        false,
      );
    });

    it('returns false when visible login modal, QR login, password form, or full-page login wall is shown', () => {
      const modalDoc = createToutiaoLoginModalDocument({ hidden: false });
      expect(toutiaoAdapter.isLoggedInEditor(modalDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(false);

      const fullLoginDoc = createToutiaoLoginRedirectDocument(TOUTIAO_EDITOR_URL);
      expect(toutiaoAdapter.isLoggedInEditor(fullLoginDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(
        false,
      );

      const textOnlyWallDoc = document.implementation.createHTMLDocument('头条号登录');
      textOnlyWallDoc.body.innerHTML = '<main><h1>请先登录后继续创作</h1></main>';
      expect(toutiaoAdapter.isLoggedInEditor(textOnlyWallDoc, new URL(TOUTIAO_EDITOR_URL))).toBe(
        false,
      );
    });
  });

  describe('injectDraft guards (provider mismatch, AUTH_REQUIRED, EDITOR_NOT_FOUND)', () => {
    it('fails cleanly without DOM mutation when task.provider is not TOUTIAO_EXT', async () => {
      const doc = createToutiaoEditorDocument();
      const task = createDemoToutiaoTask({ provider: 'ZHIHU_EXT' });
      const { uploader, uploadAll } = createMockUploader();
      const draftBtn = doc.querySelector<HTMLButtonElement>('[data-testid="save-draft-btn"]')!;
      const publishBtn = doc.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]')!;
      const draftClickSpy = vi.fn();
      const publishClickSpy = vi.fn();
      draftBtn.addEventListener('click', draftClickSpy);
      publishBtn.addEventListener('click', publishClickSpy);

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('EDITOR_NOT_FOUND');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
      expect(uploadAll).not.toHaveBeenCalled();
      expect(draftClickSpy).not.toHaveBeenCalled();
      expect(publishClickSpy).not.toHaveBeenCalled();
    });

    it('returns AUTH_REQUIRED when visible login modal or login doc.URL is detected', async () => {
      const modalDoc = createToutiaoLoginModalDocument({ hidden: false });
      const task = createDemoToutiaoTask();
      const { uploader, uploadAll } = createMockUploader();
      const titleInput = modalDoc.querySelector<HTMLTextAreaElement>('textarea.editor-title')!;
      const draftBtn = modalDoc.querySelector<HTMLButtonElement>('[data-testid="save-draft-btn"]')!;
      const draftSpy = vi.fn();
      draftBtn.addEventListener('click', draftSpy);

      const modalReport = await toutiaoAdapter.injectDraft(modalDoc, task, uploader);
      expect(DraftInjectReportSchema.safeParse(modalReport).success).toBe(true);
      expect(modalReport.ok).toBe(false);
      expect(modalReport.stage).toBe('AUTH_REQUIRED');
      expect(modalReport.uploadedImages).toBe(0);
      expect(modalReport.failedImages).toBe(0);
      expect(titleInput.value).toBe('');
      expect(uploadAll).not.toHaveBeenCalled();
      expect(draftSpy).not.toHaveBeenCalled();

      const loginUrlDoc = createToutiaoEditorDocument({ url: TOUTIAO_LOGIN_REDIRECT_URL });
      const urlReport = await toutiaoAdapter.injectDraft(loginUrlDoc, task, uploader);
      expect(DraftInjectReportSchema.safeParse(urlReport).success).toBe(true);
      expect(urlReport.ok).toBe(false);
      expect(urlReport.stage).toBe('AUTH_REQUIRED');
      expect(uploadAll).not.toHaveBeenCalled();

      const ssoDoc = createToutiaoEditorDocument({ url: TOUTIAO_SSO_LOGIN_URL });
      const ssoReport = await toutiaoAdapter.injectDraft(ssoDoc, task, uploader);
      expect(ssoReport.stage).toBe('AUTH_REQUIRED');
    });

    it.each(['title', 'body', 'both'] as const)(
      'returns EDITOR_NOT_FOUND when %s editor element is missing',
      async (missing) => {
        const doc = createToutiaoBrokenEditorDocument(missing);
        const task = createDemoToutiaoTask();
        const { uploader, uploadAll } = createMockUploader();
        const draftBtn = doc.querySelector<HTMLButtonElement>('[data-testid="save-draft-btn"]')!;
        const publishBtn = doc.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]')!;
        const draftSpy = vi.fn();
        const publishSpy = vi.fn();
        draftBtn.addEventListener('click', draftSpy);
        publishBtn.addEventListener('click', publishSpy);

        const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

        expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.stage).toBe('EDITOR_NOT_FOUND');
        expect(report.uploadedImages).toBe(0);
        expect(report.failedImages).toBe(0);
        expect(uploadAll).not.toHaveBeenCalled();
        expect(draftSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('injectDraft happy paths (ProseMirror paste, jsdom fallback, Markdown, media relay)', () => {
    it('injects title & sanitized HTML via live ProseMirror paste listener, relays images via hidden body input, clicks only 存草稿, and never clicks publish buttons', async () => {
      const doc = createToutiaoEditorDocument({
        includeCoverAndVideoInputs: true,
        hideFileInput: true,
      });
      const task = createDemoToutiaoTask();
      const { uploader, uploadAll } = createMockUploader({
        uploadedImages: 2,
        failedImages: 0,
        failures: [],
      });

      const titleEl = doc.querySelector<HTMLTextAreaElement>('textarea.editor-title')!;
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;
      const bodyFileInput = doc.querySelector<HTMLInputElement>(
        '[data-testid="body-image-file-input"]',
      )!;
      const saveDraftBtn = doc.querySelector<HTMLButtonElement>('[data-testid="save-draft-btn"]')!;
      const draftBoxBtn = doc.querySelector<HTMLButtonElement>('[data-testid="draft-box-btn"]')!;
      const previewPublishBtn = doc.querySelector<HTMLButtonElement>(
        '[data-testid="preview-publish-btn"]',
      )!;
      const publishBtn = doc.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]')!;

      const titleEvents: string[] = [];
      titleEl.addEventListener('input', () => titleEvents.push('input'));
      titleEl.addEventListener('change', () => titleEvents.push('change'));

      let pastedHtml = '';
      let pastedPlain = '';
      const pasteListener = vi.fn((event: Event) => {
        const clipboardEvent = event as ClipboardEvent;
        clipboardEvent.preventDefault();
        pastedHtml = clipboardEvent.clipboardData?.getData('text/html') ?? '';
        pastedPlain = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
        // Simulate ProseMirror accepting clipboard paste with its own wrapper marker
        editorEl.innerHTML = `<div data-pm-handled="true">${pastedHtml}</div>`;
      });
      editorEl.addEventListener('paste', pasteListener);

      const saveDraftSpy = vi.fn();
      const draftBoxSpy = vi.fn();
      const previewPublishSpy = vi.fn();
      const publishSpy = vi.fn();
      saveDraftBtn.addEventListener('click', saveDraftSpy);
      draftBoxBtn.addEventListener('click', draftBoxSpy);
      previewPublishBtn.addEventListener('click', previewPublishSpy);
      publishBtn.addEventListener('click', publishSpy);

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.draftUrl).toBe(TOUTIAO_EDITOR_URL);
      expect(report.uploadedImages).toBe(2);
      expect(report.failedImages).toBe(0);
      expect(report.failedImageDetails).toBeUndefined();
      expect(report.operatorReminders).toBeUndefined();

      expect(titleEl.value).toBe(task.variantTitle);
      expect(titleEvents).toEqual(['input', 'change']);

      expect(pasteListener).toHaveBeenCalledTimes(1);
      expect(pastedHtml).toContain('<h2>实测核心结论</h2>');
      expect(pastedPlain).toContain('实测核心结论');
      // Verify adapter did NOT overwrite live ProseMirror DOM after preventDefault
      expect(editorEl.querySelector('[data-pm-handled="true"]')).not.toBeNull();

      expect(uploadAll).toHaveBeenCalledTimes(1);
      expect(uploadAll).toHaveBeenCalledWith(task.mediaAssets, {
        editorElement: editorEl,
        fileInput: bodyFileInput,
      });

      expect(saveDraftSpy).toHaveBeenCalledTimes(1);
      expect(draftBoxSpy).toHaveBeenCalledTimes(0);
      expect(previewPublishSpy).toHaveBeenCalledTimes(0);
      expect(publishSpy).toHaveBeenCalledTimes(0);
    });

    it('falls back to idempotent DOM insertion in jsdom without paste listener, supports Markdown fallback, paste-only image relay, and missing draft button', async () => {
      const doc = createToutiaoEditorDocument({
        url: '',
        titleControl: 'input',
        includeFileInput: false,
        includeDraftButton: false,
      });
      const task = createDemoToutiaoTask({
        variantHtml: '   ',
        variantMarkdown: [
          '## Markdown 标题',
          '',
          '正文包含 **加粗** 与安全链接 [示例文档](https://docs.example.com/guide) 及被拦截脚本 <script>alert(1)</script>',
          '![外部热链图](https://cdn.example.com/hotlink-md.png)',
          '',
          '- 列表项 1',
          '- 列表项 2',
        ].join('\n'),
        mediaAssets: [
          {
            url: 'https://cdn.example.com/assets/toutiao-demo-1.png',
            alt: '配图一',
            mime: 'image/png',
          },
        ],
      });
      const { uploader, uploadAll } = createMockUploader({
        uploadedImages: 1,
        failedImages: 0,
        failures: [],
      });

      const titleEl = doc.querySelector<HTMLInputElement>('input.editor-title')!;
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;
      const publishBtn = doc.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]')!;
      const previewPublishBtn = doc.querySelector<HTMLButtonElement>(
        '[data-testid="preview-publish-btn"]',
      )!;
      const bodyInputSpy = vi.fn();
      const publishSpy = vi.fn();
      const previewPublishSpy = vi.fn();
      editorEl.addEventListener('input', bodyInputSpy);
      publishBtn.addEventListener('click', publishSpy);
      previewPublishBtn.addEventListener('click', previewPublishSpy);

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.draftUrl).toBeUndefined();
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(0);

      expect(titleEl.value).toBe(task.variantTitle);
      expect(bodyInputSpy).toHaveBeenCalledTimes(1);
      expect(editorEl.querySelector('h2')?.textContent).toBe('Markdown 标题');
      expect(editorEl.querySelector('strong')?.textContent).toBe('加粗');
      expect(editorEl.querySelector('a')?.getAttribute('href')).toBe(
        'https://docs.example.com/guide',
      );
      expect(editorEl.querySelectorAll('li')).toHaveLength(2);
      expect(editorEl.querySelector('script')).toBeNull();
      expect(editorEl.querySelector('img')).toBeNull();

      // Re-injecting idempotently should not duplicate content
      const htmlAfterFirstRun = editorEl.innerHTML;
      await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(editorEl.innerHTML).toBe(htmlAfterFirstRun);

      expect(uploadAll).toHaveBeenCalledWith(task.mediaAssets, {
        editorElement: editorEl,
        fileInput: null,
      });
      expect(publishSpy).toHaveBeenCalledTimes(0);
      expect(previewPublishSpy).toHaveBeenCalledTimes(0);
    });

    it('supports contenteditable title fallback, role="button" draft save, and empty mediaAssets', async () => {
      const doc = createToutiaoEditorDocument({
        titleControl: 'contenteditable',
        draftButtonTag: 'role-button',
        draftButtonLabel: ' 保存草稿 ',
      });
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader, uploadAll } = createMockUploader({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      });

      const titleEl = doc.querySelector<HTMLElement>('[data-e2e="article-title"]')!;
      const saveDraftBtn = doc.querySelector<HTMLElement>('[data-testid="save-draft-btn"]')!;
      const saveDraftSpy = vi.fn();
      saveDraftBtn.addEventListener('click', saveDraftSpy);

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
      expect(titleEl.textContent).toBe(task.variantTitle);
      expect(uploadAll).not.toHaveBeenCalled();
      expect(saveDraftSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves live ProseMirror DOM wrapper when re-injecting the same multi-block task twice', async () => {
      const doc = createToutiaoEditorDocument({ includeDraftButton: false });
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;

      const pasteListener = vi.fn((event: Event) => {
        const clipboardEvent = event as ClipboardEvent;
        clipboardEvent.preventDefault();
        const html = clipboardEvent.clipboardData?.getData('text/html') ?? '';
        editorEl.innerHTML = `<div data-pm-handled="true">${html}</div>`;
      });
      editorEl.addEventListener('paste', pasteListener);

      const firstReport = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(firstReport.ok).toBe(true);
      expect(editorEl.querySelector('[data-pm-handled="true"]')).not.toBeNull();

      const secondReport = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(secondReport.ok).toBe(true);
      expect(pasteListener).toHaveBeenCalledTimes(2);
      expect(editorEl.querySelector('[data-pm-handled="true"]')).not.toBeNull();
    });

    it('skips deeply nested cover file inputs (5+ levels) and non-image attachment inputs inside .syl-editor-container', async () => {
      const coverDoc = createToutiaoEditorDocument({ includeFileInput: false });
      const deepCover = coverDoc.createElement('div');
      deepCover.className = 'article-cover';
      deepCover.innerHTML =
        '<div class="l1"><div class="l2"><div class="l3"><div class="l4"><input type="file" accept="image/*" data-testid="deep-cover-upload" /></div></div></div></div>';
      coverDoc.querySelector('main.publish-editor-wrapper')!.appendChild(deepCover);

      const task = createDemoToutiaoTask();
      const { uploader: coverUploader, uploadAll: coverUploadAll } = createMockUploader();
      const coverEditorEl = coverDoc.querySelector<HTMLElement>('.ProseMirror')!;

      await toutiaoAdapter.injectDraft(coverDoc, task, coverUploader);
      expect(coverUploadAll).toHaveBeenCalledWith(task.mediaAssets, {
        editorElement: coverEditorEl,
        fileInput: null,
      });

      const docAttachmentDoc = createToutiaoEditorDocument({ includeFileInput: false });
      const toolbar = docAttachmentDoc.querySelector('.syl-toolbar')!;
      toolbar.innerHTML = [
        '<input type="file" accept=".pdf,.doc,.docx" data-testid="doc-attachment-input" />',
        '<input type="file" accept="application/pdf" data-testid="pdf-attachment-input" />',
      ].join('');

      const { uploader: docUploader, uploadAll: docUploadAll } = createMockUploader();
      const docEditorEl = docAttachmentDoc.querySelector<HTMLElement>('.ProseMirror')!;

      await toutiaoAdapter.injectDraft(docAttachmentDoc, task, docUploader);
      expect(docUploadAll).toHaveBeenCalledWith(task.mediaAssets, {
        editorElement: docEditorEl,
        fileInput: null,
      });
    });

    it('preserves asterisks inside Markdown inline code spans and link URLs', async () => {
      const doc = createToutiaoEditorDocument({ includeDraftButton: false });
      const task = createDemoToutiaoTask({
        variantHtml: '',
        variantMarkdown:
          '行内代码 `a*b*c` 与含星号链接 [参考文档](https://docs.example.com/a*b*c) 以及 *强调文本*',
        mediaAssets: [],
      });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(report.ok).toBe(true);

      const codeEl = editorEl.querySelector('code');
      expect(codeEl?.textContent).toBe('a*b*c');
      expect(codeEl?.querySelector('em')).toBeNull();

      const linkEl = editorEl.querySelector('a');
      expect(linkEl?.textContent).toBe('参考文档');
      expect(linkEl?.getAttribute('href')).toBe('https://docs.example.com/a*b*c');

      expect(editorEl.querySelector('em')?.textContent).toBe('强调文本');
    });

    it('strips query parameters and hash fragments from draftUrl and unifies doc.location?.href with doc.URL', async () => {
      const doc = createToutiaoEditorDocument({
        url: 'https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=123&token=demo_sensitive_param#draft',
      });
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.draftUrl).toBe('https://mp.toutiao.com/profile_v4/graphic/publish');

      // When doc.URL stays about:blank but doc.location.href points to login page, AUTH_REQUIRED must fire
      const rawLocationLoginDoc = createToutiaoEditorDocument({ url: '' });
      const locationLoginDoc = new Proxy(rawLocationLoginDoc, {
        get(target, prop, receiver) {
          if (prop === 'location') {
            return { href: TOUTIAO_LOGIN_REDIRECT_URL };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const locationLoginReport = await toutiaoAdapter.injectDraft(
        locationLoginDoc,
        task,
        uploader,
      );
      expect(DraftInjectReportSchema.safeParse(locationLoginReport).success).toBe(true);
      expect(locationLoginReport.ok).toBe(false);
      expect(locationLoginReport.stage).toBe('AUTH_REQUIRED');

      // When doc.location.href is http://localhost/ but doc.URL is the Toutiao editor URL, draftUrl resolves cleanly
      const rawLocalhostDoc = createToutiaoEditorDocument({
        url: 'https://mp.toutiao.com/profile_v4/graphic/edit?pgc_id=999',
      });
      const localhostLocationDoc = new Proxy(rawLocalhostDoc, {
        get(target, prop, receiver) {
          if (prop === 'location') {
            return { href: 'http://localhost/' };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const localhostReport = await toutiaoAdapter.injectDraft(
        localhostLocationDoc,
        task,
        uploader,
      );
      expect(localhostReport.ok).toBe(true);
      expect(localhostReport.draftUrl).toBe('https://mp.toutiao.com/profile_v4/graphic/edit');
    });
  });

  describe('XSS & anti-hotlink HTML sanitization', () => {
    it('strips scripts, iframes, SVGs, external img/picture tags, event handlers, inline styles, and unsafe links in both clipboard and DOM', async () => {
      const doc = createToutiaoEditorDocument();
      const maliciousHtml = [
        '<h2 onclick="steal()">安全标题</h2>',
        '<script>window.__xss = true;</script>',
        '<style>body { display: none; }</style>',
        '<iframe src="https://evil.example.com/frame"></iframe>',
        '<svg onload="alert(1)"><script>alert(2)</script></svg>',
        '<figure><img src="https://cdn.example.com/hotlink.png" onerror="alert(1)" alt="热链图" /><figcaption>图注保留文本</figcaption></figure>',
        '<picture><source srcset="https://cdn.example.com/pic.webp" /><img src="https://cdn.example.com/pic.jpg" /></picture>',
        '<p style="background:url(javascript:alert(1))" data-track="1">安全正文段落</p>',
        '<a href="javascript:alert(1)" onclick="steal()">危险链接</a>',
        '<a href="data:text/html,<script>alert(1)</script>">Data 链接</a>',
        '<a href="https://docs.example.com/report?id=1" title="参考报告" target="_blank">合法链接</a>',
        '<table><tbody><tr><td colspan="2" rowspan="1" style="color:red">表格单元</td><td colspan="0">非法跨列</td></tr></tbody></table>',
        '<form action="https://evil.example.com"><input type="text" value="trap" /><button>提交</button></form>',
      ].join('');

      const task = createDemoToutiaoTask({
        variantHtml: maliciousHtml,
        mediaAssets: [],
      });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;

      let clipboardHtml = '';
      editorEl.addEventListener('paste', (event) => {
        clipboardHtml = (event as ClipboardEvent).clipboardData?.getData('text/html') ?? '';
        // Leave DOM unmutated so fallback DOM insertion also runs and gets verified
      });

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
      expect(report.ok).toBe(true);

      for (const html of [clipboardHtml, editorEl.innerHTML]) {
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<style/i);
        expect(html).not.toMatch(/<iframe/i);
        expect(html).not.toMatch(/<svg/i);
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/<picture/i);
        expect(html).not.toMatch(/<form/i);
        expect(html).not.toMatch(/javascript:/i);
        expect(html).not.toMatch(/onerror|onclick|onload/i);
        expect(html).not.toMatch(/style=/i);
        expect(html).not.toContain('cdn.example.com/hotlink.png');
      }

      expect(editorEl.querySelector('h2')?.textContent).toBe('安全标题');
      expect(editorEl.textContent).toContain('安全正文段落');
      expect(editorEl.textContent).toContain('图注保留文本');

      const links = Array.from(editorEl.querySelectorAll('a'));
      expect(links).toHaveLength(3);
      expect(links[0]?.getAttribute('href')).toBeNull();
      expect(links[1]?.getAttribute('href')).toBeNull();
      expect(links[2]?.getAttribute('href')).toBe('https://docs.example.com/report?id=1');
      expect(links[2]?.getAttribute('title')).toBe('参考报告');
      expect(links[2]?.getAttribute('target')).toBeNull();

      const cells = Array.from(editorEl.querySelectorAll('td'));
      expect(cells[0]?.getAttribute('colspan')).toBe('2');
      expect(cells[0]?.getAttribute('rowspan')).toBe('1');
      expect(cells[0]?.getAttribute('style')).toBeNull();
      expect(cells[1]?.getAttribute('colspan')).toBeNull();
    });
  });

  describe('PARTIAL_MEDIA_FAILED degradation', () => {
    it('returns ok:false and PARTIAL_MEDIA_FAILED with failedImageDetails on partial upload failure without hotlink fallback or publish click', async () => {
      const doc = createToutiaoEditorDocument();
      const task = createDemoToutiaoTask();
      const failureDetail = {
        url: 'https://cdn.example.com/assets/toutiao-demo-2.webp',
        alt: '参数拆解示意图',
        reason: '下载超时',
      };
      const { uploader } = createMockUploader({
        uploadedImages: 1,
        failedImages: 1,
        failures: [failureDetail],
      });

      const titleEl = doc.querySelector<HTMLTextAreaElement>('textarea.editor-title')!;
      const editorEl = doc.querySelector<HTMLElement>('.ProseMirror')!;
      const publishBtn = doc.querySelector<HTMLButtonElement>('[data-testid="publish-btn"]')!;
      const previewBtn = doc.querySelector<HTMLButtonElement>(
        '[data-testid="preview-publish-btn"]',
      )!;
      const publishSpy = vi.fn();
      const previewSpy = vi.fn();
      publishBtn.addEventListener('click', publishSpy);
      previewBtn.addEventListener('click', previewSpy);

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.draftUrl).toBe(TOUTIAO_EDITOR_URL);
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(1);
      expect(report.failedImageDetails).toEqual([failureDetail]);

      expect(titleEl.value).toBe(task.variantTitle);
      expect(editorEl.textContent).toContain('实测核心结论');
      expect(editorEl.querySelector('img')).toBeNull();
      expect(editorEl.innerHTML).not.toContain('cdn.example.com');
      expect(publishSpy).toHaveBeenCalledTimes(0);
      expect(previewSpy).toHaveBeenCalledTimes(0);
    });

    it('returns PARTIAL_MEDIA_FAILED when all media uploads fail', async () => {
      const doc = createToutiaoEditorDocument();
      const task = createDemoToutiaoTask();
      const failures = task.mediaAssets.map((asset) => ({
        url: asset.url,
        alt: asset.alt,
        reason: '网络不可达',
      }));
      const { uploader } = createMockUploader({
        uploadedImages: 0,
        failedImages: 2,
        failures,
      });

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(2);
      expect(report.failedImageDetails).toEqual(failures);
    });

    it('reports PARTIAL_MEDIA_FAILED when uploader returns failedImages: 0 with non-empty failures array', async () => {
      const doc = createToutiaoEditorDocument();
      const task = createDemoToutiaoTask();
      const failureDetail = {
        url: 'https://cdn.example.com/assets/toutiao-demo-2.webp',
        alt: '参数拆解示意图',
        reason: '上传响应异常',
      };
      const { uploader } = createMockUploader({
        uploadedImages: 1,
        failedImages: 0,
        failures: [failureDetail],
      });

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(1);
      expect(report.failedImageDetails).toEqual([failureDetail]);
    });
  });

  describe('draft-only security redline (adversarial trap buttons)', () => {
    it('never clicks any publish, compound, deceptive-attribute, obfuscated-metadata, hidden-span, form/formaction, anchor-wrapped, disabled, or hidden trap button', async () => {
      const doc = createToutiaoAdversarialButtonsDocument();
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });

      const trapControls = Array.from(doc.querySelectorAll<HTMLElement>('[data-trap]'));
      expect(trapControls.length).toBeGreaterThanOrEqual(30);

      const spies = trapControls.map((control) => {
        const spy = vi.fn();
        control.addEventListener('click', spy);
        return {
          trap: control.getAttribute('data-trap'),
          spy,
        };
      });

      const report = await toutiaoAdapter.injectDraft(doc, task, uploader);

      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');

      for (const { trap, spy } of spies) {
        expect(spy, `Trap control "${trap}" must never be clicked`).toHaveBeenCalledTimes(0);
      }
    });

    it('blocks all 7 hostile DOM publish traps, contenteditable decoys, and zero-width obfuscated attributes with zero publish clicks (B1 regression)', async () => {
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const { uploader } = createMockUploader({ uploadedImages: 0, failedImages: 0, failures: [] });

      const trapScenarios: Array<{
        name: string;
        mount: (doc: Document) => {
          trapTargets: Element[];
          forms?: HTMLFormElement[];
        };
      }> = [
        {
          name: 'Trap 1: direct publish buttons (发布文章 / 预览并发布 / 立即发布 / 提交审核 / data-testid="publish")',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML = [
              '<button type="button" class="trap">发布文章</button>',
              '<button type="button" class="trap">预览并发布</button>',
              '<button type="button" class="trap">立即发布</button>',
              '<button type="button" class="trap">提交审核</button>',
              '<button type="button" data-testid="publish" class="trap">存草稿</button>',
            ].join('');
            doc.body.appendChild(box);
            return { trapTargets: Array.from(box.querySelectorAll('.trap')) };
          },
        },
        {
          name: 'Trap 2: nested <span role="button">存草稿</span> inside <button data-testid="publish">',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML = [
              '<button type="button" data-testid="publish" class="trap"><span role="button">存草稿</span></button>',
              '<button type="button" class="trap">确认操作<span role="button">存草稿</span></button>',
            ].join('');
            doc.body.appendChild(box);
            return { trapTargets: Array.from(box.querySelectorAll('.trap')) };
          },
        },
        {
          name: 'Trap 3: deceptive child <span data-testid="publish">存草稿</span> inside <button type="button">',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML =
              '<button type="button" class="trap"><span data-testid="publish">存草稿</span></button>';
            doc.body.appendChild(box);
            return { trapTargets: Array.from(box.querySelectorAll('.trap')) };
          },
        },
        {
          name: 'Trap 4: explicit <label for="real-pub-1"> and implicit <label> wrapping submit input',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML = [
              '<label for="real-pub-1"><span role="button">存草稿</span></label>',
              '<button id="real-pub-1" type="button" data-testid="publish" class="trap">立即发布</button>',
              '<form class="trap-form"><label><input type="submit" style="display:none" class="trap" /><span role="button">存草稿</span></label></form>',
            ].join('');
            doc.body.appendChild(box);
            return {
              trapTargets: Array.from(box.querySelectorAll('.trap')),
              forms: Array.from(box.querySelectorAll('form.trap-form')),
            };
          },
        },
        {
          name: 'Trap 5: <form><button type="submit" data-testid="publish"><span role="button">存草稿</span></button></form>',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML =
              '<form class="trap-form"><button type="submit" data-testid="publish" class="trap"><span role="button">存草稿</span></button></form>';
            doc.body.appendChild(box);
            return {
              trapTargets: Array.from(box.querySelectorAll('.trap')),
              forms: Array.from(box.querySelectorAll('form.trap-form')),
            };
          },
        },
        {
          name: 'Trap 6: inline pointer-handler ancestors (onclick / onmousedown / onpointerdown / JS-assigned onclick)',
          mount: (doc) => {
            const box = doc.createElement('div');
            box.innerHTML = [
              '<div onclick="publishArticle()" data-testid="publish" class="trap"><button type="button">存草稿</button></div>',
              '<div onmousedown="publishArticle()" class="trap"><button type="button">存草稿</button></div>',
              '<div onpointerdown="submitReview()" class="trap"><button type="button">存草稿</button></div>',
            ].join('');
            const jsWrap = doc.createElement('div');
            jsWrap.className = 'trap';
            jsWrap.onclick = function publishArticle() {
              // intentional named handler trap
            };
            const jsBtn = doc.createElement('button');
            jsBtn.type = 'button';
            jsBtn.textContent = '存草稿';
            jsWrap.appendChild(jsBtn);
            box.appendChild(jsWrap);
            doc.body.appendChild(box);
            return { trapTargets: Array.from(box.querySelectorAll('.trap')) };
          },
        },
        {
          name: 'Trap 7: zero-width and whitespace obfuscated CN/EN publish attributes (self + descendant)',
          mount: (doc) => {
            const box = doc.createElement('div');
            const variants: Array<() => HTMLElement> = [
              () => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'trap';
                btn.setAttribute('data-action', 'pub\u200Blish');
                btn.textContent = '存草稿';
                return btn;
              },
              () => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'trap';
                btn.setAttribute('data-action', 'sub\u200Dmit');
                btn.textContent = '存草稿';
                return btn;
              },
              () => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'trap';
                btn.setAttribute('data-action', '发\u200B布');
                btn.textContent = '存草稿';
                return btn;
              },
              () => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'trap';
                btn.setAttribute('aria-label', '立\u200B即\uFEFF发\u200D布');
                btn.textContent = '存草稿';
                return btn;
              },
              () => {
                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'trap';
                const inner = doc.createElement('span');
                inner.setAttribute('data-action', 'pub\u200Blish');
                inner.textContent = '存草稿';
                btn.appendChild(inner);
                return btn;
              },
            ];
            for (const createBtn of variants) {
              box.appendChild(createBtn());
            }
            doc.body.appendChild(box);
            return { trapTargets: Array.from(box.querySelectorAll('.trap')) };
          },
        },
        {
          name: 'Trap 8: decoy draft buttons inside [contenteditable="true"] and [contenteditable="plaintext-only"]',
          mount: (doc) => {
            const editor = doc.querySelector<HTMLElement>('.ProseMirror')!;
            const decoyBtn = doc.createElement('button');
            decoyBtn.type = 'button';
            decoyBtn.className = 'trap';
            decoyBtn.textContent = '存草稿';
            editor.appendChild(decoyBtn);

            const plainEditable = doc.createElement('div');
            plainEditable.setAttribute('contenteditable', 'plaintext-only');
            plainEditable.innerHTML =
              '<span role="button" class="trap">存草稿</span><button type="button" class="trap">保存草稿</button>';
            doc.body.appendChild(plainEditable);

            return {
              trapTargets: [decoyBtn, ...Array.from(plainEditable.querySelectorAll('.trap'))],
            };
          },
        },
      ];

      for (const scenario of trapScenarios) {
        const doc = createToutiaoEditorDocument({ includeDraftButton: false });
        const { trapTargets, forms = [] } = scenario.mount(doc);
        expect(trapTargets.length, scenario.name).toBeGreaterThan(0);

        let publishClicks = 0;
        for (const target of trapTargets) {
          target.addEventListener('click', () => {
            publishClicks += 1;
          });
        }
        for (const form of forms) {
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            publishClicks += 1;
          });
        }

        const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
        expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
        expect(report.ok, scenario.name).toBe(true);
        expect(report.stage, scenario.name).toBe('INJECTED');
        expect(publishClicks, `${scenario.name} must trigger 0 publish clicks`).toBe(0);
      }

      // Positive control: legitimate draft-save buttons (<button type="button"> and <div role="button">)
      // inside a benign wrapper (including analytics onclick) still trigger exactly once with 0 publish clicks
      const legitButtonDoc = createToutiaoEditorDocument({ includeDraftButton: false });
      const analyticsWrap = legitButtonDoc.createElement('div');
      analyticsWrap.setAttribute('onclick', 'trackAnalytics()');
      const legitDivRoleBtn = legitButtonDoc.createElement('div');
      legitDivRoleBtn.setAttribute('role', 'button');
      legitDivRoleBtn.textContent = '存草稿';
      analyticsWrap.appendChild(legitDivRoleBtn);
      legitButtonDoc.body.appendChild(analyticsWrap);

      let legitDraftClicks = 0;
      let legitPublishClicks = 0;
      legitDivRoleBtn.addEventListener('click', () => {
        legitDraftClicks += 1;
      });
      legitButtonDoc.querySelector('[data-testid="publish-btn"]')!.addEventListener('click', () => {
        legitPublishClicks += 1;
      });

      const legitReport = await toutiaoAdapter.injectDraft(legitButtonDoc, task, uploader);
      expect(legitReport.ok).toBe(true);
      expect(legitDraftClicks).toBe(1);
      expect(legitPublishClicks).toBe(0);
    });
  });

  describe('extractPublishedUrl (full 22-case matrix + relative/malicious canonical checks)', () => {
    it('normalizes valid /article/<digits> and /i<digits> public URLs', () => {
      const doc = createToutiaoPublishedDocument();

      // Case 1
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(
            `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/?log_from=demo&source=mp#comment`,
          ),
          doc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 2
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          doc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 3
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`),
          doc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 4
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}/`),
          doc,
        ),
      ).toBe(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 5
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}?tt_from=copy_link#share`),
          doc,
        ),
      ).toBe(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}`);
    });

    it('rejects mp.toutiao.com creator/draft URLs even when stale canonical/og:url tags exist in doc', () => {
      const staleCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/`,
        ogUrl: `https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}/`,
      });

      // Case 6
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL('https://mp.toutiao.com/profile_v4/graphic/publish'),
          staleCanonicalDoc,
        ),
      ).toBeNull();

      // Case 7
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL('https://mp.toutiao.com/profile_v4/graphic/articles'),
          staleCanonicalDoc,
        ),
      ).toBeNull();

      // Case 8
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL('https://mp.toutiao.com/profile_v4/graphic/drafts'),
          staleCanonicalDoc,
        ),
      ).toBeNull();
    });

    it('rejects non-HTTPS, edit paths, non-numeric IDs, encoded traversal, custom ports, credentials, loopback, untrusted hosts, cross-provider URLs, and root homepage', () => {
      const staleCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/`,
      });

      const rejectedUrls = [
        // Case 9: non-HTTPS
        'http://www.toutiao.com/article/12345',
        // Case 10: edit path (with stale canonical)
        'https://www.toutiao.com/article/12345/edit',
        // Case 11: non-numeric article ID (with stale canonical)
        'https://www.toutiao.com/article/abc',
        // Case 12: non-numeric /i ID
        'https://www.toutiao.com/iabc',
        // Case 13: path traversal preserved on URL object (double-encoded)
        'https://www.toutiao.com/article/12345/edit/%252e%252e',
        // Case 14: non-default port
        'https://www.toutiao.com:8443/article/12345',
        // Case 15: embedded credentials
        'https://user:pass@www.toutiao.com/article/12345',
        // Case 16: loopback IP
        'https://127.0.0.1/article/12345',
        // Case 17: untrusted hosts
        'https://evil.example.com/article/12345',
        'https://www.toutiao.com.evil.example.com/article/12345',
        // Case 18: cross-provider Zhihu URL
        'https://zhuanlan.zhihu.com/p/123456789',
        // Case 19: root homepage (even with canonical)
        'https://www.toutiao.com/',
      ];

      for (const rawUrl of rejectedUrls) {
        expect(
          toutiaoAdapter.extractPublishedUrl(new URL(rawUrl), staleCanonicalDoc),
          `Expected "${rawUrl}" to be rejected`,
        ).toBeNull();
      }

      // Raw string single-encoded / literal path traversal is blocked before WHATWG URL collapse
      expect(
        validatePublishedUrl('TOUTIAO_EXT', 'https://www.toutiao.com/article/12345/edit/%2e%2e').ok,
      ).toBe(false);
      const traversalCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: 'https://www.toutiao.com/article/12345/edit/%2e%2e',
        ogUrl: '/article/12345/edit/..',
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          traversalCanonicalDoc,
        ),
      ).toBeNull();
    });

    it('supports reader-alias (/group/<digits> and /a<digits>) canonical & og:url fallback and rejects malicious candidates', () => {
      // Case 20: /group/<digits> with absolute canonical
      const groupCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/?from=seo#top`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          groupCanonicalDoc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 21: /a<digits> with og:url fallback
      const aliasOgDoc = createToutiaoPublishedDocument({
        ogUrl: `https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}/`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/a${TOUTIAO_DEMO_ARTICLE_ID}/`),
          aliasOgDoc,
        ),
      ).toBe(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Relative single-slash canonical on reader alias
      const relativeCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: `/article/${TOUTIAO_DEMO_ARTICLE_ID}/?from=alias`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          relativeCanonicalDoc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);

      // Case 22: malicious canonical on reader alias
      const maliciousCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: `https://evil.example.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          maliciousCanonicalDoc,
        ),
      ).toBeNull();

      // Protocol-relative malicious canonical on reader alias
      const protocolRelativeDoc = createToutiaoPublishedDocument({
        canonicalHref: `//evil.example.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          protocolRelativeDoc,
        ),
      ).toBeNull();

      // Stale canonical with mismatched article ID on /group/<id>/ MUST return null
      const mismatchedCanonicalDoc = createToutiaoPublishedDocument({
        canonicalHref: 'https://www.toutiao.com/article/9999999999999999999/',
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          mismatchedCanonicalDoc,
        ),
      ).toBeNull();

      // Stale og:url with mismatched ID on /a<id>/ MUST return null
      const mismatchedOgDoc = createToutiaoPublishedDocument({
        ogUrl: 'https://www.toutiao.com/i9999999999999999999/',
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/a${TOUTIAO_DEMO_ARTICLE_ID}/`),
          mismatchedOgDoc,
        ),
      ).toBeNull();

      // Stale canonical falls through to matching og:url with identical ID
      const staleCanonicalMatchingOgDoc = createToutiaoPublishedDocument({
        canonicalHref: 'https://www.toutiao.com/article/9999999999999999999/',
        ogUrl: `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/`,
      });
      expect(
        toutiaoAdapter.extractPublishedUrl(
          new URL(`https://www.toutiao.com/group/${TOUTIAO_DEMO_ARTICLE_ID}/`),
          staleCanonicalMatchingOgDoc,
        ),
      ).toBe(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`);
    });
  });

  describe('registry & content runtime integration', () => {
    it('registers and resolves cleanly through adapter registry', () => {
      registerAdapter(toutiaoAdapter);

      expect(getAdapterByProvider('TOUTIAO_EXT')).toBe(toutiaoAdapter);
      expect(getAdapterByUrl(TOUTIAO_EDITOR_URL)).toBe(toutiaoAdapter);
      expect(getAdapterByUrl(TOUTIAO_EDITOR_QUERY_URL)).toBe(toutiaoAdapter);
      expect(getAdapterByUrl(`https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`)).toBe(
        toutiaoAdapter,
      );
      expect(getAdapterByUrl(`https://www.toutiao.com/i${TOUTIAO_DEMO_ARTICLE_ID}`)).toBe(
        toutiaoAdapter,
      );

      expect(
        getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/publish-other'),
      ).toBeUndefined();
      expect(getAdapterByUrl('http://www.toutiao.com/article/12345')).toBeUndefined();
      expect(getAdapterByUrl('https://evil.example.com/article/12345')).toBeUndefined();
    });

    it('integrates with content runtime for Mode B partial-media notice and Mode A URL capture bar', async () => {
      registerAdapter(toutiaoAdapter);
      const task = createDemoToutiaoTask();
      const editorDoc = createToutiaoEditorDocument();
      const failureDetail = {
        url: 'https://cdn.example.com/assets/toutiao-demo-2.webp',
        alt: '参数拆解示意图',
        reason: '图片拉取超时',
      };
      const { uploader } = createMockUploader({
        uploadedImages: 1,
        failedImages: 1,
        failures: [failureDetail],
      });

      let currentUrl = new URL(TOUTIAO_EDITOR_URL);
      const sendMessage = vi.fn(async (request: { type: string }) => {
        if (request.type === 'GET_PENDING_TAB_TASK') {
          return {
            ok: true as const,
            data: {
              task: {
                tabId: 101,
                taskId: task.taskId,
                articleId: task.articleId,
                brandId: task.brandId,
                brandName: task.brandName,
                provider: task.provider,
                variantTitle: task.variantTitle,
                complianceChecklist: task.complianceChecklist,
              },
            },
          };
        }
        return { ok: true as const, data: null };
      });

      const coordinator = createUrlCaptureCoordinator({
        doc: editorDoc,
        getCurrentUrl: () => currentUrl,
        sendMessage: sendMessage as never,
      });
      const handler = createContentMessageHandler(
        {
          doc: editorDoc,
          extensionId: 'geomix-test-extension-id',
          getCurrentUrl: () => currentUrl,
          uploader,
          sendMessage: sendMessage as never,
        },
        coordinator,
      );

      let injectResponse: unknown;
      await act(async () => {
        injectResponse = await new Promise<unknown>((resolve) => {
          const asyncFlag = handler(
            { type: 'INJECT_DRAFT', payload: { task } },
            { id: 'geomix-test-extension-id' },
            (res) => resolve(res),
          );
          expect(asyncFlag).toBe(true);
        });
      });

      expect(injectResponse).toMatchObject({
        ok: true,
        data: {
          ok: false,
          stage: 'PARTIAL_MEDIA_FAILED',
          uploadedImages: 1,
          failedImages: 1,
          failedImageDetails: [failureDetail],
        },
      });
      expect(getActiveCaptureBarHost(editorDoc)).not.toBeNull();
      expect(getActiveCaptureBarMode(editorDoc)).toBe('notice');

      // Now simulate manual publish redirecting to cleanable public article URL
      currentUrl = new URL(
        `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}/?log_from=demo#comment`,
      );
      let urlResponse: unknown;
      await act(async () => {
        urlResponse = await new Promise<unknown>((resolve) => {
          const asyncFlag = handler(
            { type: 'TAB_URL_CHANGED', payload: { url: currentUrl.href } },
            { id: 'geomix-test-extension-id' },
            (res) => resolve(res),
          );
          expect(asyncFlag).toBe(true);
        });
      });

      expect(urlResponse).toEqual({
        ok: true,
        data: {
          checked: true,
          matched: true,
          publishedUrl: `https://www.toutiao.com/article/${TOUTIAO_DEMO_ARTICLE_ID}`,
        },
      });
      expect(getActiveCaptureBarMode(editorDoc)).toBe('capture');
      act(() => {
        unmountCaptureBar(editorDoc);
      });
    });

    it('blocks Unicode Cf Bidi override/isolate/ALM/MVS publish traps while allowing legitimate draft-save button (C2-01)', async () => {
      const task = createDemoToutiaoTask({ mediaAssets: [] });
      const uploader: LocalImageUploader = {
        uploadAll: vi.fn(async () => ({ uploadedImages: 0, failedImages: 0, failures: [] })),
      };

      const cfTraps: Array<{ label: string; attr: string; value: string }> = [
        { label: 'RLO U+202E data-action', attr: 'data-action', value: 'pub\u202Elish' },
        { label: 'LRI U+2066 CN data-action', attr: 'data-action', value: '发\u2066布' },
        { label: 'RLO U+202E onclick', attr: 'onclick', value: 'submit\u202EPublish()' },
        { label: 'ALM U+061C data-testid', attr: 'data-testid', value: 'pub\u061Clish-btn' },
        { label: 'MVS U+180E data-action', attr: 'data-action', value: 'pub\u180Elish' },
      ];

      for (const trap of cfTraps) {
        const doc = createToutiaoEditorDocument({ includeDraftButton: false });
        const trapBtn = doc.createElement('button');
        trapBtn.type = 'button';
        trapBtn.setAttribute(trap.attr, trap.value);
        trapBtn.textContent = '存草稿';
        doc.body.appendChild(trapBtn);

        let publishClicks = 0;
        trapBtn.addEventListener('click', () => {
          publishClicks += 1;
        });

        const report = await toutiaoAdapter.injectDraft(doc, task, uploader);
        expect(report.ok, trap.label).toBe(true);
        expect(publishClicks, `${trap.label} must not be clicked`).toBe(0);
      }

      // Positive control: clean draft-save button still clicks once
      const cleanDoc = createToutiaoEditorDocument({ includeDraftButton: true });
      let draftClicks = 0;
      cleanDoc.querySelector('[data-testid="save-draft-btn"]')!.addEventListener('click', () => {
        draftClicks += 1;
      });
      const cleanReport = await toutiaoAdapter.injectDraft(cleanDoc, task, uploader);
      expect(cleanReport.ok).toBe(true);
      expect(draftClicks).toBe(1);
    });

    it('catches uploader.uploadAll throws, redacts tokens, preserves draft-save click, and enforces failures.length parity (C2-05)', async () => {
      const doc = createToutiaoEditorDocument({ includeDraftButton: true });
      let draftClicks = 0;
      doc.querySelector('[data-testid="save-draft-btn"]')!.addEventListener('click', () => {
        draftClicks += 1;
      });

      const task = createDemoToutiaoTask();
      const throwingUploader: LocalImageUploader = {
        uploadAll: vi.fn(async () => {
          throw new Error('upload boom Bearer gmext_demo_secret_toutiao_1');
        }),
      };

      const report = await toutiaoAdapter.injectDraft(doc, task, throwingUploader);
      expect(DraftInjectReportSchema.safeParse(report).success).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.failedImages).toBe(task.mediaAssets.length);
      expect(draftClicks).toBe(1);
      expect(JSON.stringify(report)).not.toContain('gmext_demo_secret_toutiao_1');
      expect(JSON.stringify(report)).toContain('Bearer [REDACTED]');
    });

    it('injects cleanly into cross-realm JSDOM documents and enforces public HTTPS + rel="noopener noreferrer" on body links (C2-06)', async () => {
      const foreignDom = new JSDOM(
        `<!doctype html><html><body>
          <textarea class="editor-title-input" placeholder="请输入文章标题"></textarea>
          <div class="ProseMirror" contenteditable="true" role="textbox"></div>
          <button type="button" data-testid="save-draft-btn">存草稿</button>
          <button type="button" data-testid="publish-btn">预览并发布</button>
        </body></html>`,
        { url: TOUTIAO_EDITOR_URL },
      ) as { window: { document: Document } };
      const foreignDoc = foreignDom.window.document;

      let draftClicks = 0;
      let publishClicks = 0;
      foreignDoc.querySelector('[data-testid="save-draft-btn"]')!.addEventListener('click', () => {
        draftClicks += 1;
      });
      foreignDoc.querySelector('[data-testid="publish-btn"]')!.addEventListener('click', () => {
        publishClicks += 1;
      });

      const task = createDemoToutiaoTask({
        mediaAssets: [],
        variantHtml: [
          '<p><a href="http://127.0.0.1:8080/admin">local</a></p>',
          '<p><a href="http://example.com/plain-http">httpLink</a></p>',
          '<p><a href="https://user:gmext_demo_secret@geo.example.com/x">cred</a></p>',
          '<p><a href="https://example.com/ok">ok</a></p>',
        ].join(''),
      });
      const uploader: LocalImageUploader = {
        uploadAll: vi.fn(async () => ({ uploadedImages: 0, failedImages: 0, failures: [] })),
      };

      const report = await toutiaoAdapter.injectDraft(foreignDoc, task, uploader);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(draftClicks).toBe(1);
      expect(publishClicks).toBe(0);

      const editor = foreignDoc.querySelector('.ProseMirror')!;
      const anchors = Array.from(editor.querySelectorAll('a'));
      const hrefs = anchors.map((a) => a.getAttribute('href'));
      expect(hrefs).not.toContain('http://127.0.0.1:8080/admin');
      expect(hrefs).not.toContain('http://example.com/plain-http');
      expect(editor.innerHTML).not.toContain('gmext_demo_secret');
      const safeAnchor = anchors.find((a) => a.getAttribute('href') === 'https://example.com/ok');
      expect(safeAnchor).toBeTruthy();
      expect(safeAnchor?.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });
});
