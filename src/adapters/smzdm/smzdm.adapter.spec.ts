import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalImageUploader } from '../../content/image-uploader';
import { DraftInjectReportSchema } from '../../shared/bridge-contract';
import { isCanonicalPublishedUrl, PUBLISHED_URL_PATTERNS } from '../../shared/url-validation';
import { clearAdapters, getAdapterByProvider, getAdapterByUrl, registerAdapter } from '../registry';
import {
  createMockSmzdmUploader,
  createSmzdmEditorDocument,
  createSmzdmLoginModalDocument,
  createSmzdmMarkdownFallbackTaskFixture,
  createSmzdmMissingEditorDocument,
  createSmzdmPublishedDocument,
  createSmzdmTaskFixture,
  createSmzdmUnsafeHtmlTaskFixture,
  SMZDM_EDITOR_DRAFT_URL,
  SMZDM_EDITOR_URL,
  SMZDM_LOGIN_REDIRECT_URL,
  SMZDM_PUBLISHED_DIRTY_URL,
  SMZDM_PUBLISHED_URL,
} from './fixtures';
import {
  createSmzdmAdapter,
  findDraftSaveButton,
  renderMarkdownToFragment,
  sanitizeMarkdownForTextarea,
  sanitizeSmzdmHtmlToFragment,
  SMZDM_EDITOR_ENTRY_URL,
  SMZDM_OPERATOR_REMINDERS,
  SMZDM_PUBLISHED_URL_PATTERNS,
  smzdmAdapter,
} from './smzdm.adapter';

// 1x1 transparent PNG encoded in Base64 for real LocalImageUploader integration tests.
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('smzdmAdapter (SMZDM_EXT)', () => {
  afterEach(() => {
    clearAdapters();
  });

  describe('1. Metadata, Factory & Registry Conformance', () => {
    it('exposes exact static metadata and stateless publishedUrlPatterns', () => {
      const created = createSmzdmAdapter();

      expect(smzdmAdapter.provider).toBe('SMZDM_EXT');
      expect(smzdmAdapter.displayName).toBe('什么值得买');
      expect(smzdmAdapter.editorEntryUrl).toBe('https://post.smzdm.com/tougao/');
      expect(SMZDM_EDITOR_ENTRY_URL).toBe('https://post.smzdm.com/tougao/');
      expect(smzdmAdapter.publishedUrlPatterns).toEqual(PUBLISHED_URL_PATTERNS.SMZDM_EXT);
      expect(SMZDM_PUBLISHED_URL_PATTERNS).toBe(PUBLISHED_URL_PATTERNS.SMZDM_EXT);

      expect(created.provider).toBe(smzdmAdapter.provider);
      expect(created.displayName).toBe(smzdmAdapter.displayName);
      expect(created.editorEntryUrl).toBe(smzdmAdapter.editorEntryUrl);
      expect(created.publishedUrlPatterns).toEqual(smzdmAdapter.publishedUrlPatterns);

      const pattern = smzdmAdapter.publishedUrlPatterns[0];
      expect(pattern).toBeDefined();
      expect(pattern?.flags).not.toContain('g');
      expect(pattern?.flags).not.toContain('y');
      expect(pattern?.test(SMZDM_PUBLISHED_URL)).toBe(true);
      expect(pattern?.test(SMZDM_PUBLISHED_URL)).toBe(true);
    });

    it('integrates cleanly with adapter registry for provider and URL lookup', () => {
      registerAdapter(smzdmAdapter);

      expect(getAdapterByProvider('SMZDM_EXT')).toBe(smzdmAdapter);
      expect(getAdapterByUrl(SMZDM_EDITOR_URL)).toBe(smzdmAdapter);
      expect(getAdapterByUrl(SMZDM_EDITOR_DRAFT_URL)).toBe(smzdmAdapter);
      expect(getAdapterByUrl(SMZDM_PUBLISHED_URL)).toBe(smzdmAdapter);
      expect(getAdapterByUrl(SMZDM_PUBLISHED_DIRTY_URL)).toBe(smzdmAdapter);
    });
  });

  describe('2. Login & Editor Detection (isLoggedInEditor)', () => {
    it('returns true on logged-in /tougao/ and /tougao/?draft_id=... across editor variants', () => {
      const standard = createSmzdmEditorDocument();
      const prosemirror = createSmzdmEditorDocument({ editorVariant: 'prosemirror' });
      const ueditor = createSmzdmEditorDocument({ editorVariant: 'ueditor' });
      const textareaTitle = createSmzdmEditorDocument({ titleTag: 'textarea' });

      expect(smzdmAdapter.isLoggedInEditor(standard.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
      expect(smzdmAdapter.isLoggedInEditor(standard.doc, new URL(SMZDM_EDITOR_DRAFT_URL))).toBe(
        true,
      );
      expect(smzdmAdapter.isLoggedInEditor(prosemirror.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
      expect(smzdmAdapter.isLoggedInEditor(ueditor.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
      expect(smzdmAdapter.isLoggedInEditor(textareaTitle.doc, new URL(SMZDM_EDITOR_URL))).toBe(
        true,
      );
    });

    it('returns true when a hidden login modal or data-smzdm-login="false" marker sits in DOM alongside the editor', () => {
      const fixture = createSmzdmEditorDocument({ includeHiddenLoginModal: true });
      const inertFlag = fixture.doc.createElement('div');
      inertFlag.setAttribute('data-smzdm-login', 'false');
      fixture.doc.body.appendChild(inertFlag);

      expect(smzdmAdapter.isLoggedInEditor(fixture.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
    });

    it('returns false when a visible login modal overlays the editor or on a logged-out gate page', () => {
      const modalOverEditor = createSmzdmLoginModalDocument({ variant: 'modal-over-editor' });
      const gatePage = createSmzdmLoginModalDocument({ variant: 'gate-page' });
      const loginForm = createSmzdmLoginModalDocument({ variant: 'login-form' });

      expect(smzdmAdapter.isLoggedInEditor(modalOverEditor.doc, new URL(SMZDM_EDITOR_URL))).toBe(
        false,
      );
      expect(smzdmAdapter.isLoggedInEditor(gatePage.doc, new URL(SMZDM_EDITOR_URL))).toBe(false);
      expect(smzdmAdapter.isLoggedInEditor(loginForm.doc, new URL(SMZDM_EDITOR_URL))).toBe(false);
    });

    it('returns false for login redirects, non-HTTPS, custom ports, published URLs, foreign hosts, and empty DOM', () => {
      const fixture = createSmzdmEditorDocument();
      const emptyDoc = document.implementation.createHTMLDocument('Empty');

      const invalidUrls = [
        SMZDM_LOGIN_REDIRECT_URL,
        'https://passport.smzdm.com/login',
        'https://post.smzdm.com/tougao/?need_login=1',
        'https://post.smzdm.com/tougao/?action=login',
        'https://post.smzdm.com/tougao/login',
        'http://post.smzdm.com/tougao/',
        'https://post.smzdm.com:8443/tougao/',
        'https://user:pass@post.smzdm.com/tougao/',
        SMZDM_PUBLISHED_URL,
        'https://evil.example.com/tougao/',
      ];

      for (const rawUrl of invalidUrls) {
        expect(smzdmAdapter.isLoggedInEditor(fixture.doc, new URL(rawUrl))).toBe(false);
      }

      expect(smzdmAdapter.isLoggedInEditor(emptyDoc, new URL(SMZDM_EDITOR_URL))).toBe(false);
    });

    it('returns true for logged-in shell missing editor controls so content runtime reaches EDITOR_NOT_FOUND', () => {
      const missingBoth = createSmzdmMissingEditorDocument({ missing: 'both' });

      expect(smzdmAdapter.isLoggedInEditor(missingBoth.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
    });
  });

  describe('3. Auth Short-Circuit & Missing Editor Handling (injectDraft)', () => {
    it('returns AUTH_REQUIRED without mutating DOM, calling uploader, or clicking buttons on login modal', async () => {
      const fixture = createSmzdmLoginModalDocument({ variant: 'modal-over-editor' });
      const task = createSmzdmTaskFixture();
      const { uploader, uploadAllSpy } = createMockSmzdmUploader('success');

      const publishSpy = fixture.publishButton ? vi.spyOn(fixture.publishButton, 'click') : null;
      const submitSpy = fixture.submitReviewButton
        ? vi.spyOn(fixture.submitReviewButton, 'click')
        : null;

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('AUTH_REQUIRED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
      expect(report.draftUrl).toBeUndefined();
      expect(report.failedImageDetails).toBeUndefined();
      expect(report.operatorReminders).toBeUndefined();
      expect(uploadAllSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it('returns AUTH_REQUIRED when doc.location is a SMZDM login redirect URL', async () => {
      const fixture = createSmzdmLoginModalDocument({
        variant: 'login-form',
        documentUrl: SMZDM_LOGIN_REDIRECT_URL,
      });
      const task = createSmzdmTaskFixture();
      const { uploader, uploadAllSpy } = createMockSmzdmUploader('success');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('AUTH_REQUIRED');
      expect(report.operatorReminders).toBeUndefined();
      expect(uploadAllSpy).not.toHaveBeenCalled();
    });

    it.each(['both', 'title', 'body'] as const)(
      'returns EDITOR_NOT_FOUND when editor DOM is missing (%s) without mutating partial controls',
      async (missing) => {
        const fixture = createSmzdmMissingEditorDocument({ missing });
        const task = createSmzdmTaskFixture();
        const { uploader, uploadAllSpy } = createMockSmzdmUploader('success');

        const publishSpy = fixture.publishButton ? vi.spyOn(fixture.publishButton, 'click') : null;
        const submitSpy = fixture.submitReviewButton
          ? vi.spyOn(fixture.submitReviewButton, 'click')
          : null;

        const existingTitle = fixture.doc.querySelector<HTMLInputElement>('input[name="title"]');
        const existingBody = fixture.doc.querySelector<HTMLElement>('[contenteditable="true"]');
        const titleBefore = existingTitle?.value;
        const bodyBefore = existingBody?.textContent;

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.ok).toBe(false);
        expect(report.stage).toBe('EDITOR_NOT_FOUND');
        expect(report.uploadedImages).toBe(0);
        expect(report.failedImages).toBe(0);
        expect(report.draftUrl).toBeUndefined();
        expect(report.failedImageDetails).toBeUndefined();
        expect(report.operatorReminders).toBeUndefined();
        expect(uploadAllSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
        expect(submitSpy).not.toHaveBeenCalled();

        if (existingTitle) {
          expect(existingTitle.value).toBe(titleBefore);
        }
        if (existingBody) {
          expect(existingBody.textContent).toBe(bodyBefore);
        }
      },
    );
  });

  describe('4. Title, Parameter Comparison Table & Measured-Data Block Injection', () => {
    it('injects title, comparison table, and measured-data block with bubbling events and normalized draftUrl', async () => {
      const fixture = createSmzdmEditorDocument({ documentUrl: SMZDM_EDITOR_DRAFT_URL });
      const task = createSmzdmTaskFixture();
      const { uploader } = createMockSmzdmUploader('success');

      const titleEvents: string[] = [];
      const bodyEvents: string[] = [];
      fixture.doc.body.addEventListener('input', (event) => {
        if (event.target === fixture.titleInput) {
          titleEvents.push('input');
        } else if (event.target === fixture.bodyEditor) {
          bodyEvents.push('input');
        }
      });
      fixture.doc.body.addEventListener('change', (event) => {
        if (event.target === fixture.titleInput) {
          titleEvents.push('change');
        } else if (event.target === fixture.bodyEditor) {
          bodyEvents.push('change');
        }
      });

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.draftUrl).toBe('https://post.smzdm.com/tougao/');
      expect(report.uploadedImages).toBe(2);
      expect(report.failedImages).toBe(0);

      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(titleEvents).toEqual(['input', 'change']);
      expect(bodyEvents).toEqual(['input', 'change']);

      const table = fixture.bodyEditor.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.querySelector('caption')?.textContent).toContain('DemoBrand Model-A1');
      expect(table?.querySelectorAll('thead th')).toHaveLength(3);
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(table?.textContent).toContain('12.5 小时');
      expect(table?.textContent).toContain('38.4 dB');
      expect(table?.querySelector('td[colspan="2"]')?.textContent).toContain('1.35 kg');

      const measuredSection = fixture.bodyEditor.querySelector('[data-block="measured-data"]');
      expect(measuredSection).not.toBeNull();
      expect(measuredSection?.querySelector('blockquote')?.textContent).toContain('25℃');
      expect(measuredSection?.querySelectorAll('ul li')).toHaveLength(2);
      expect(measuredSection?.textContent).toContain('39.2℃');
      expect(measuredSection?.textContent).toContain('34 分钟');
      expect(measuredSection?.querySelector('pre code')?.textContent).toContain(
        'BENCHMARK_SUMMARY',
      );
    });

    it('works cleanly on detached document (defaultView === null, location === null) and omits draftUrl', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      expect(fixture.doc.defaultView).toBeNull();
      expect(fixture.doc.location).toBeNull();

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.draftUrl).toBeUndefined();
      expect(fixture.titleInput.value).toBe(task.variantTitle);
      expect(fixture.bodyEditor.querySelector('table')).not.toBeNull();
    });

    it('supports <textarea> title and ProseMirror, UEditor, and textarea body variants', async () => {
      for (const editorVariant of ['prosemirror', 'ueditor', 'textarea'] as const) {
        const fixture = createSmzdmEditorDocument({
          titleTag: 'textarea',
          editorVariant,
        });
        const task = createSmzdmTaskFixture({ mediaAssets: [] });
        const { uploader } = createMockSmzdmUploader('success');

        const titleInputEvents: string[] = [];
        fixture.titleInput.addEventListener('input', () => titleInputEvents.push('input'));
        fixture.titleInput.addEventListener('change', () => titleInputEvents.push('change'));

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        expect(fixture.titleInput.value).toBe(task.variantTitle);
        expect(titleInputEvents).toEqual(['input', 'change']);

        if (editorVariant === 'textarea') {
          expect((fixture.bodyEditor as HTMLTextAreaElement).value).toContain('Model-A1');
        } else {
          expect(fixture.bodyEditor.querySelector('table')).not.toBeNull();
          expect(fixture.bodyEditor.textContent).toContain('39.2℃');
        }
      }
    });

    it('supports HTML5 bare contenteditable="" body and title editors and never clicks injected links inside them', async () => {
      const fixture = createSmzdmEditorDocument({ documentUrl: SMZDM_EDITOR_URL });
      fixture.bodyEditor.setAttribute('contenteditable', '');

      const task = createSmzdmTaskFixture({
        variantHtml:
          '<p>点击 <a href="https://evil.example.com/phish">保存草稿</a> 查看详情</p><table><tbody><tr><td>实测续航</td><td>12.5 小时</td></tr></tbody></table>',
        mediaAssets: [],
      });
      const { uploader } = createMockSmzdmUploader('success');

      const realDraftSpy = vi.spyOn(fixture.saveDraftButton!, 'click');
      let injectedLinkClicked = false;
      fixture.bodyEditor.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName.toUpperCase() === 'A') {
          injectedLinkClicked = true;
        }
      });

      expect(smzdmAdapter.isLoggedInEditor(fixture.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.bodyEditor.querySelector('table')).not.toBeNull();
      expect(injectedLinkClicked).toBe(false);
      expect(realDraftSpy).toHaveBeenCalledTimes(1);
      expect(findDraftSaveButton(fixture.doc)).toBe(fixture.saveDraftButton);

      // Also verify [data-smzdm-title][contenteditable=""] title discovery
      const bareTitleDoc = document.implementation.createHTMLDocument('BareTitle');
      const bareTitle = bareTitleDoc.createElement('div');
      bareTitle.setAttribute('data-smzdm-title', '');
      bareTitle.setAttribute('contenteditable', '');
      const bareBody = bareTitleDoc.createElement('div');
      bareBody.setAttribute('contenteditable', '');
      bareTitleDoc.body.appendChild(bareTitle);
      bareTitleDoc.body.appendChild(bareBody);

      const bareReport = await smzdmAdapter.injectDraft(bareTitleDoc, task, uploader);
      expect(bareReport.ok).toBe(true);
      expect(bareReport.stage).toBe('INJECTED');
      expect(bareTitle.textContent).toBe(task.variantTitle);
      expect(bareBody.querySelector('table')).not.toBeNull();
    });

    it('dispatches cross-realm ownerDocument.defaultView.Event cleanly under separate Window realms', async () => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      try {
        const iframeWin = iframe.contentWindow as (Window & typeof globalThis) | null;
        const iframeDoc = iframe.contentDocument;
        expect(iframeWin).not.toBeNull();
        expect(iframeDoc).not.toBeNull();
        if (!iframeWin || !iframeDoc) {
          return;
        }

        expect(iframeWin.Event).not.toBe(globalThis.Event);

        iframeDoc.body.innerHTML = [
          '<header class="smzdm-creator-header"><span class="creator-user-name">测试值友</span></header>',
          '<main class="tougao-container" data-smzdm-editor="true">',
          '  <input type="text" name="title" class="post-title-input" />',
          '  <div class="smzdm-editor-content" contenteditable="true" role="textbox"></div>',
          '  <button type="button" class="btn-save-draft">保存草稿</button>',
          '</main>',
        ].join('');

        const titleEl = iframeDoc.querySelector('input[name="title"]') as HTMLInputElement;
        const bodyEl = iframeDoc.querySelector('.smzdm-editor-content') as HTMLElement;
        const receivedEvents: Array<{
          target: string;
          type: string;
          isRealmEvent: boolean;
          isOuterEvent: boolean;
        }> = [];

        for (const [label, el] of [
          ['title', titleEl],
          ['body', bodyEl],
        ] as const) {
          el.addEventListener('input', (event) => {
            receivedEvents.push({
              target: label,
              type: 'input',
              isRealmEvent: event instanceof iframeWin.Event,
              isOuterEvent: event instanceof globalThis.Event,
            });
          });
          el.addEventListener('change', (event) => {
            receivedEvents.push({
              target: label,
              type: 'change',
              isRealmEvent: event instanceof iframeWin.Event,
              isOuterEvent: event instanceof globalThis.Event,
            });
          });
        }

        // Also exercise the EventCtor fallback when view.InputEvent is absent in the target realm
        Object.defineProperty(iframeWin, 'InputEvent', {
          value: undefined,
          configurable: true,
        });

        const task = createSmzdmTaskFixture({ mediaAssets: [] });
        const { uploader } = createMockSmzdmUploader('success');
        const report = await smzdmAdapter.injectDraft(iframeDoc, task, uploader);

        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        expect(titleEl.value).toBe(task.variantTitle);
        expect(bodyEl.querySelector('table')).not.toBeNull();
        expect(receivedEvents).toEqual([
          { target: 'title', type: 'input', isRealmEvent: true, isOuterEvent: false },
          { target: 'title', type: 'change', isRealmEvent: true, isOuterEvent: false },
          { target: 'body', type: 'input', isRealmEvent: true, isOuterEvent: false },
          { target: 'body', type: 'change', isRealmEvent: true, isOuterEvent: false },
        ]);
      } finally {
        iframe.remove();
      }
    });
  });

  describe('5. SMZDM Operator Reminders (Product Cards & Compliance Disclosure)', () => {
    it('always includes 商品卡片 and 合规披露声明 reminders on both INJECTED and PARTIAL_MEDIA_FAILED', async () => {
      const task = createSmzdmTaskFixture();

      const successFixture = createSmzdmEditorDocument();
      const successUploader = createMockSmzdmUploader('success');
      const successReport = await smzdmAdapter.injectDraft(
        successFixture.doc,
        task,
        successUploader.uploader,
      );

      const partialFixture = createSmzdmEditorDocument();
      const partialUploader = createMockSmzdmUploader('partial');
      const partialReport = await smzdmAdapter.injectDraft(
        partialFixture.doc,
        task,
        partialUploader.uploader,
      );

      for (const report of [successReport, partialReport]) {
        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.operatorReminders).toEqual([...SMZDM_OPERATOR_REMINDERS]);
        const joinedReminders = (report.operatorReminders ?? []).join(' ');
        expect(joinedReminders).toContain('商品卡片');
        expect(joinedReminders).toContain('合规披露声明');
        expect(report.message).toContain('商品卡片');
        expect(report.message).toContain('合规披露声明');
      }
    });
  });

  describe('6. HTML Sanitization, Hotlink Media Stripping & Markdown Fallback', () => {
    it('strips XSS payloads, unsafe attributes, bad links, and hotlink <img> while keeping tables and measured data', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmUnsafeHtmlTaskFixture();
      const { uploader } = createMockSmzdmUploader('success');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');

      // Zero dangerous tags or external hotlink media
      expect(fixture.bodyEditor.querySelector('script')).toBeNull();
      expect(fixture.bodyEditor.querySelector('style')).toBeNull();
      expect(fixture.bodyEditor.querySelector('iframe')).toBeNull();
      expect(fixture.bodyEditor.querySelector('svg')).toBeNull();
      expect(fixture.bodyEditor.querySelector('img')).toBeNull();
      expect(fixture.bodyEditor.querySelector('figure')).toBeNull();

      // Zero event handler, style, id, or forbidden data-src attributes
      for (const el of Array.from(fixture.bodyEditor.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
          expect(attr.name.toLowerCase()).not.toBe('style');
          expect(attr.name.toLowerCase()).not.toBe('id');
          expect(attr.name.toLowerCase()).not.toBe('data-src');
        }
      }

      // Unsafe links unwrapped (keeping visible text, removing href); safe HTTPS link kept with rel
      const anchors = Array.from(fixture.bodyEditor.querySelectorAll('a'));
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(anchors[0]?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(fixture.bodyEditor.textContent).toContain('危险脚本链接');
      expect(fixture.bodyEditor.textContent).toContain('危险数据链接');

      // Legitimate table and measured-data block preserved
      const table = fixture.bodyEditor.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.textContent).toContain('实测续航');
      expect(table?.textContent).toContain('12.5 小时');
      expect(fixture.bodyEditor.querySelector('[data-block="measured-data"]')).not.toBeNull();
      expect(fixture.bodyEditor.textContent).toContain('39.2℃');
    });

    it('falls back to pure-DOM Markdown rendering when variantHtml is blank or sanitizes to empty', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmMarkdownFallbackTaskFixture();
      const { uploader } = createMockSmzdmUploader('success');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');

      const table = fixture.bodyEditor.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll('thead th')).toHaveLength(3);
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(table?.querySelectorAll('thead th')[1]?.getAttribute('align')).toBe('center');
      expect(table?.querySelectorAll('thead th')[2]?.getAttribute('align')).toBe('right');
      expect(table?.textContent).toContain('12.5 小时');
      expect(fixture.bodyEditor.querySelector('blockquote')?.textContent).toContain('25℃');
      expect(fixture.bodyEditor.querySelectorAll('ul li')).toHaveLength(2);
      expect(
        fixture.bodyEditor.querySelector('pre.measured-data-block code')?.textContent,
      ).toContain('BENCHMARK_SUMMARY');
      expect(fixture.bodyEditor.querySelector('img')).toBeNull();
      expect(fixture.bodyEditor.querySelector('a')?.getAttribute('href')).toBe(
        'https://post.smzdm.com/p/demo123abc',
      );

      // Script-only variantHtml sanitizes to empty -> falls back to Markdown cleanly
      const scriptOnlyFixture = createSmzdmEditorDocument();
      const scriptOnlyTask = createSmzdmTaskFixture({
        variantHtml: '<script>window.__xss = 1;</script>',
        mediaAssets: [],
      });
      const scriptOnlyReport = await smzdmAdapter.injectDraft(
        scriptOnlyFixture.doc,
        scriptOnlyTask,
        uploader,
      );
      expect(scriptOnlyReport.ok).toBe(true);
      expect(scriptOnlyFixture.bodyEditor.querySelector('script')).toBeNull();
      expect(scriptOnlyFixture.bodyEditor.querySelector('table')).not.toBeNull();
    });

    it('handles empty variantHtml and empty variantMarkdown gracefully without throwing', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        variantMarkdown: '',
        mediaAssets: [],
      });
      const { uploader } = createMockSmzdmUploader('success');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(fixture.titleInput.value).toBe(task.variantTitle);
    });

    it('sanitizes HTML and renders Markdown fragments safely via direct helper exports', () => {
      const doc = document.implementation.createHTMLDocument('Helpers');
      const htmlFrag = sanitizeSmzdmHtmlToFragment(
        doc,
        '<custom-wrap><p>安全文本</p><img src="https://cdn.example.com/a.png" /></custom-wrap>',
      );
      expect(htmlFrag.querySelector('img')).toBeNull();
      expect(htmlFrag.querySelector('p')?.textContent).toBe('安全文本');

      const mdFrag = renderMarkdownToFragment(
        doc,
        '1. 第一步\n2. 第二步\n\n---\n\n<script>alert(1)</script> [非法链接](javascript:alert(2))',
      );
      expect(mdFrag.querySelectorAll('ol li')).toHaveLength(2);
      expect(mdFrag.querySelector('hr')).not.toBeNull();
      expect(mdFrag.querySelector('script')).toBeNull();
      expect(mdFrag.querySelector('a')).toBeNull();
      expect(mdFrag.textContent).toContain('<script>alert(1)</script>');
      expect(mdFrag.textContent).toContain('非法链接');
    });

    it('blocks data-* URL smuggling, auth-selector DOM poisoning, mixed-case tags, unsafe schemes, and malformed spans while keeping editor logged in', async () => {
      const fixture = createSmzdmEditorDocument();
      const { uploader } = createMockSmzdmUploader('success');
      const poisonedHtml = [
        '<ScRiPt>window.__xss2 = true;</ScRiPt>',
        '<ImG src="https://cdn.example.com/mixed-case.png" alt="bad" />',
        '<div class="measured-data-section smzdm-login-modal login-form"',
        '  data-block="measured-data"',
        '  data-lazy-src="https://evil.example.com/hotlink.png"',
        '  data-actualsrc="https://cdn.example.com/hotlink.png"',
        '  data-img="http://127.0.0.1/internal.png"',
        '  data-bg="//evil.example.com/bg.png"',
        '  data-uri="blob:https://post.smzdm.com/abc"',
        '  data-file="file:///etc/passwd"',
        '  data-custom="https://evil.example.com/leak.png"',
        '  data-auth-state="logged-out"',
        '  data-smzdm-login="true">',
        '  <p>实测数据安全保留</p>',
        '  <a href="vbscript:msgbox(1)">vb链接</a>',
        '  <a href="http://post.smzdm.com/p/demo123abc">非HTTPS链接</a>',
        '  <a href="https://127.0.0.1/internal">内网链接</a>',
        '</div>',
        '<table><tbody><tr>',
        '  <td colspan="0" rowspan="-1">异常跨度1</td>',
        '  <td colspan="9999" rowspan="101">异常跨度2</td>',
        '  <td colspan="2" rowspan="2">合法跨度</td>',
        '</tr></tbody></table>',
      ].join('\n');

      const task = createSmzdmTaskFixture({ variantHtml: poisonedHtml, mediaAssets: [] });
      const firstReport = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(firstReport.ok).toBe(true);
      expect(firstReport.stage).toBe('INJECTED');
      expect(fixture.bodyEditor.querySelector('script')).toBeNull();
      expect(fixture.bodyEditor.querySelector('img')).toBeNull();
      expect(fixture.bodyEditor.querySelector('a')).toBeNull();

      const block = fixture.bodyEditor.querySelector('[data-block="measured-data"]');
      expect(block).not.toBeNull();
      expect(block?.classList.contains('measured-data-section')).toBe(true);
      expect(block?.classList.contains('smzdm-login-modal')).toBe(false);
      expect(block?.classList.contains('login-form')).toBe(false);
      for (const forbiddenAttr of [
        'data-lazy-src',
        'data-actualsrc',
        'data-img',
        'data-bg',
        'data-uri',
        'data-file',
        'data-custom',
        'data-auth-state',
        'data-smzdm-login',
      ]) {
        expect(block?.hasAttribute(forbiddenAttr)).toBe(false);
      }

      const cells = Array.from(fixture.bodyEditor.querySelectorAll('td'));
      expect(cells[0]?.hasAttribute('colspan')).toBe(false);
      expect(cells[0]?.hasAttribute('rowspan')).toBe(false);
      expect(cells[1]?.hasAttribute('colspan')).toBe(false);
      expect(cells[1]?.hasAttribute('rowspan')).toBe(false);
      expect(cells[2]?.getAttribute('colspan')).toBe('2');
      expect(cells[2]?.getAttribute('rowspan')).toBe('2');

      // Subsequent login check and follow-up injectDraft MUST remain unaffected
      expect(smzdmAdapter.isLoggedInEditor(fixture.doc, new URL(SMZDM_EDITOR_URL))).toBe(true);
      const secondReport = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(secondReport.ok).toBe(true);
      expect(secondReport.stage).toBe('INJECTED');
    });

    it('sanitizes Markdown hotlinks, raw HTML, and unsafe links in <textarea> fallback while preserving GFM tables and measured-data blocks', async () => {
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const adversarialMarkdown = [
        '## 一、核心参数对比表',
        '',
        '| 对比维度 | Model-A1 | Model-B2 |',
        '| :--- | :---: | ---: |',
        '| 实测续航 | 12.5 小时 | 10.2 小时 |',
        '',
        '![禁止外链图](https://cdn.example.com/smzdm/markdown-hotlink.png)',
        '![带括号图](https://cdn.example.com/smzdm/photo_(1).png "说明")',
        '[![外链图链接](https://cdn.example.com/smzdm/linked.png)](https://post.smzdm.com/p/demo123abc)',
        '<img src="https://cdn.example.com/smzdm/raw.png" onerror="alert(1)" />',
        '<ScRiPt>window.__xss = 1;</ScRiPt>',
        '[危险脚本](javascript:alert(1))',
        '[内网链接](https://127.0.0.1/secret)',
        '[评测原文](https://post.smzdm.com/p/demo123abc "标题")',
        '',
        '```text',
        'BENCHMARK_SUMMARY: Model-A1 temp=39.2℃ charge=34min',
        '```',
      ].join('\n');

      const task = createSmzdmTaskFixture({
        variantMarkdown: adversarialMarkdown,
        mediaAssets: [],
      });

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      const value = (fixture.bodyEditor as HTMLTextAreaElement).value;

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(value).not.toContain('cdn.example.com');
      expect(value).not.toContain('markdown-hotlink.png');
      expect(value).not.toContain('<script');
      expect(value).not.toContain('<ScRiPt');
      expect(value).not.toContain('<img');
      expect(value).not.toContain('javascript:');
      expect(value).not.toContain('127.0.0.1');
      expect(value).toContain('| 对比维度 | Model-A1 | Model-B2 |');
      expect(value).toContain('BENCHMARK_SUMMARY: Model-A1 temp=39.2℃ charge=34min');
      expect(value).toContain('[外链图链接](https://post.smzdm.com/p/demo123abc)');
      expect(value).toContain('[评测原文](https://post.smzdm.com/p/demo123abc)');
      expect(value).toContain('危险脚本');

      // When variantMarkdown strips to empty, fallback uses sanitized HTML text content cleanly
      const imageOnlyFixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const imageOnlyTask = createSmzdmTaskFixture({
        variantHtml: '<p>安全回退正文</p><img src="https://cdn.example.com/blocked.png" />',
        variantMarkdown: '![禁止外链图](https://cdn.example.com/smzdm/markdown-hotlink.png)',
        mediaAssets: [],
      });
      expect(sanitizeMarkdownForTextarea(imageOnlyTask.variantMarkdown)).toBe('');
      await smzdmAdapter.injectDraft(imageOnlyFixture.doc, imageOnlyTask, uploader);
      expect((imageOnlyFixture.bodyEditor as HTMLTextAreaElement).value).toBe('安全回退正文');
    });

    it('handles Markdown GFM table parity, horizontal rules, linked images, nested parens, and titled links accurately', () => {
      const doc = document.implementation.createHTMLDocument('MarkdownEdgeCases');

      // 1. Pipe-containing prose followed by bare --- MUST render <p> + <hr>, NOT <table>
      const hrFrag = renderMarkdownToFragment(doc, 'Model-A1 | Model-B2 综合对比\n---\n下一段内容');
      expect(hrFrag.querySelector('table')).toBeNull();
      expect(hrFrag.querySelector('hr')).not.toBeNull();
      expect(hrFrag.querySelectorAll('p')).toHaveLength(2);
      expect(hrFrag.querySelectorAll('p')[0]?.textContent).toBe('Model-A1 | Model-B2 综合对比');
      expect(hrFrag.querySelectorAll('p')[1]?.textContent).toBe('下一段内容');

      // 2. Mismatched header vs separator column count MUST NOT render <table>
      const mismatchFrag = renderMarkdownToFragment(doc, '| A | B | C |\n| --- |\n| 1 | 2 | 3 |');
      expect(mismatchFrag.querySelector('table')).toBeNull();

      // 3. Valid table clamps overflowing body row cells to header count
      const clampFrag = renderMarkdownToFragment(
        doc,
        '| A | B |\n| --- | --- |\n| 1 | 2 | 3 | 4 |',
      );
      expect(clampFrag.querySelectorAll('thead th')).toHaveLength(2);
      expect(clampFrag.querySelectorAll('tbody td')).toHaveLength(2);

      // 4. Linked image NEVER leaks image URL into <a href>; nested parens & titles parse cleanly
      const inlineContainer = doc.createElement('div');
      inlineContainer.appendChild(
        renderMarkdownToFragment(
          doc,
          [
            '[![实测封面](https://cdn.example.com/hotlink.png)](https://post.smzdm.com/p/demo123abc)',
            '[![危险外链](https://cdn.example.com/hotlink2.png)](javascript:alert(1))',
            '[前缀 ![内嵌图](https://cdn.example.com/hotlink3.png)](https://post.smzdm.com/p/demo123abc)',
            '![带括号图](https://cdn.example.com/photo_(1).png "说明")',
            '[bad](javascript:alert(1))',
            '[评测原文](https://post.smzdm.com/p/demo123abc "标题")',
          ].join('\n\n'),
        ),
      );

      expect(inlineContainer.innerHTML).not.toContain('cdn.example.com');
      expect(inlineContainer.innerHTML).not.toContain('hotlink');
      expect(inlineContainer.innerHTML).not.toContain('.png)');
      expect(inlineContainer.querySelector('img')).toBeNull();

      const anchors = Array.from(inlineContainer.querySelectorAll('a'));
      expect(anchors).toHaveLength(2);
      expect(anchors[0]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(anchors[0]?.textContent).toBe('实测封面');
      expect(anchors[1]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(anchors[1]?.textContent).toBe('评测原文');

      const paragraphs = Array.from(inlineContainer.querySelectorAll('p'));
      const badParagraph = paragraphs.find((p) => (p.textContent ?? '').includes('bad'));
      expect(badParagraph?.textContent).toBe('bad');
    });

    it('never re-injects stripped <script> or <IMG> into <textarea> when variantHtml is empty or sanitizes to empty', async () => {
      const { uploader } = createMockSmzdmUploader('success');

      // Case A: empty variantHtml + hotlink/script-only variantMarkdown -> textarea.value === ''
      const fixtureA = createSmzdmEditorDocument({
        editorVariant: 'textarea',
        documentUrl: SMZDM_EDITOR_URL,
      });
      const taskA = createSmzdmTaskFixture({
        variantHtml: '',
        variantMarkdown:
          '![a](https://cdn.example.com/a.png)\n<script>alert(1)</script>\n<IMG SRC="https://cdn.example.com/x.png" onerror="alert(1)">',
        mediaAssets: [],
      });

      const reportA = await smzdmAdapter.injectDraft(fixtureA.doc, taskA, uploader);
      expect(reportA.ok).toBe(true);
      expect((fixtureA.bodyEditor as HTMLTextAreaElement).value).toBe('');

      // Case B: script+img-only variantHtml + raw <IMG>-only variantMarkdown -> textarea.value === ''
      const fixtureB = createSmzdmEditorDocument({
        editorVariant: 'textarea',
        documentUrl: SMZDM_EDITOR_URL,
      });
      const taskB = createSmzdmTaskFixture({
        variantHtml: '<script>evil()</script><img src="https://cdn.example.com/html.png">',
        variantMarkdown: '<IMG SRC="https://cdn.example.com/md.png" onerror="alert(1)">',
        mediaAssets: [],
      });

      const reportB = await smzdmAdapter.injectDraft(fixtureB.doc, taskB, uploader);
      expect(reportB.ok).toBe(true);
      expect((fixtureB.bodyEditor as HTMLTextAreaElement).value).toBe('');
    });

    it('neutralizes quoted->, slash-separated event handlers, nested paired <script>, style/data-src, and slash anchors in sanitizeMarkdownForTextarea while keeping safe prose and fenced online=true', () => {
      const input = [
        '前文 <img alt="a > b" src="https://cdn.example.com/gt.png" onerror="alert(1)"> 后文',
        '<div/onclick="alert(1)"/onerror="alert(2)">安全文本</div>',
        '<scr<script></script>ipt>alert(1)</script>',
        '<div style="background:url(https://cdn.example.com/bg.png)" data-src="https://cdn.example.com/ds.png" data-bg="//evil.example.com/bg.png">正文</div>',
        '<a/href="https://post.smzdm.com/p/demo123abc">好文链接</a>',
        '<a/href="javascript:alert(1)">恶意链接</a>',
        '普通文本 online=true 保留',
        '',
        '```text',
        'online=true',
        'BENCHMARK_SUMMARY: ok',
        '```',
      ].join('\n');

      const out = sanitizeMarkdownForTextarea(input);

      expect(out).not.toContain('cdn.example.com');
      expect(out).not.toContain('evil.example.com');
      expect(out).not.toContain('alert(1)');
      expect(out).not.toContain('alert(2)');
      expect(out).not.toContain('onclick');
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('style=');
      expect(out).not.toContain('data-src');
      expect(out).not.toContain('data-bg');
      expect(out).not.toContain('javascript:');
      expect(out).toContain('前文');
      expect(out).toContain('后文');
      expect(out).toContain('安全文本');
      expect(out).toContain('正文');
      expect(out).toContain('[好文链接](https://post.smzdm.com/p/demo123abc)');
      expect(out).toContain('恶意链接');
      expect(out).toContain('普通文本 online=true 保留');
      expect(out).toContain('```text\nonline=true\nBENCHMARK_SUMMARY: ok\n```');
    });

    it('strips CommonMark nested-bracket alt images and angle-bracket spaced URLs in both paths, and terminates GFM tbody on adjacent heading', () => {
      const doc = document.implementation.createHTMLDocument('CommonMarkAndGfmBoundary');
      const mdWithComplexImages = [
        '正文 ![photo [1]](https://cdn.example.com/nested-bracket.png) 结束',
        '前 ![alt](<https://cdn.example.com/my photo.png>) 后',
        '[![封面 [2]](<https://cdn.example.com/my cover.png>)](<https://post.smzdm.com/p/demo123abc>)',
      ].join('\n\n');

      const textareaOut = sanitizeMarkdownForTextarea(mdWithComplexImages);
      expect(textareaOut).not.toContain('cdn.example.com');
      expect(textareaOut).not.toContain('nested-bracket.png');
      expect(textareaOut).not.toContain('my photo.png');
      expect(textareaOut).not.toContain('my cover.png');
      expect(textareaOut).toContain('正文');
      expect(textareaOut).toContain('结束');
      expect(textareaOut).toContain('[封面 [2]](https://post.smzdm.com/p/demo123abc)');

      const domContainer = doc.createElement('div');
      domContainer.appendChild(renderMarkdownToFragment(doc, mdWithComplexImages));
      expect(domContainer.innerHTML).not.toContain('cdn.example.com');
      expect(domContainer.querySelector('img')).toBeNull();
      const anchors = Array.from(domContainer.querySelectorAll('a'));
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(anchors[0]?.textContent).toBe('封面 [2]');

      // GFM table immediately followed by heading containing '|' splits into <table> + <h2>
      const tableHeadingFrag = renderMarkdownToFragment(
        doc,
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n## 型号A | 型号B 总结',
      );
      expect(tableHeadingFrag.querySelectorAll('table tbody tr')).toHaveLength(1);
      const h2 = tableHeadingFrag.querySelector('h2');
      expect(h2).not.toBeNull();
      expect(h2?.textContent).toBe('型号A | 型号B 总结');
    });

    it('strips HTML5 tags with unquoted quotes and closing-tag attributes in sanitizeMarkdownForTextarea (B1 & P2.9a)', () => {
      const input = [
        `前文 <img src=https://cdn.example.com/a.png alt=don't> 中间 <img src=https://cdn.example.com/b.png alt=a"b> 后文`,
        `<script x=a'>alert(1)</script>`,
        `<div x=a' onclick=alert(1)>hi</div>`,
        `前文 <script>alert(1)</script foo="bar"> 后文`,
        `<div a="1"onclick="alert(1)">ok</div>`,
        `<div " onclick="alert(1)">ok2</div>`,
      ].join('\n');

      const out = sanitizeMarkdownForTextarea(input);

      expect(out).not.toContain('cdn.example.com');
      expect(out).not.toContain('a.png');
      expect(out).not.toContain('b.png');
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('</script');
      expect(out).not.toContain('alert(1)');
      expect(out).not.toContain('onclick');
      expect(out).not.toContain('foo=');
      expect(out).toContain('前文');
      expect(out).toContain('中间');
      expect(out).toContain('后文');
      expect(out).toContain('hi');
      expect(out).toContain('ok');
      expect(out).toContain('ok2');
    });

    it('blocks empty <a></a> split-tag <script> reconstruction via outer fixed-point convergence (B2)', () => {
      const input = [
        '前文 <scr<a href="javascript:alert(1)"></a>ipt>alert(1)</scr<a href="javascript:alert(1)"></a>ipt> 后文',
        '中段 <scr<a href="https://post.smzdm.com/p/demo123abc"></a>ipt>alert(2)</scr<a href="https://post.smzdm.com/p/demo123abc"></a>ipt> 结尾',
      ].join('\n');

      const out = sanitizeMarkdownForTextarea(input);

      expect(out).not.toContain('<script');
      expect(out).not.toContain('</script');
      expect(out).not.toContain('alert(1)');
      expect(out).not.toContain('alert(2)');
      expect(out).not.toContain('javascript:');
      expect(out).toContain('前文');
      expect(out).toContain('后文');
      expect(out).toContain('中段');
      expect(out).toContain('结尾');
    });

    it('blocks raw-HTML-to-Markdown step-order synthesis of external image hotlinks and javascript: links end-to-end in <textarea> (D1)', async () => {
      const fixture = createSmzdmEditorDocument({
        editorVariant: 'textarea',
        documentUrl: SMZDM_EDITOR_URL,
      });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: [
          '!<a href="https://cdn.example.com/leak1.png">图1</a>',
          '!<script></script>[图2](https://cdn.example.com/leak2.png)',
          '![图3](https://cdn.example.com/<img src=x>leak3.png)',
          '[点我](java<script></script>script:alert(1))',
        ].join('\n'),
      });

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      const value = (fixture.bodyEditor as HTMLTextAreaElement).value;

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(value).not.toContain('cdn.example.com');
      expect(value).not.toContain('leak1.png');
      expect(value).not.toContain('leak2.png');
      expect(value).not.toContain('leak3.png');
      expect(value).not.toContain('![');
      expect(value).not.toContain('javascript:');
      expect(value).not.toContain('alert(1)');
      expect(value).not.toContain('<script');
      expect(value).not.toContain('<img');
      expect(value).not.toContain('<a');
      expect(value).toContain('点我');

      // Direct cross-phase synthesis vectors (P2.8b, P2.8d, Markdown->HTML split, stray close bang-fusion, pure MD bang-fusion)
      const directVectors = [
        '!<img src=x>[alt](https://cdn.example.com/leak.png)',
        '![alt]<script></script>(https://cdn.example.com/leak.png)',
        '<scr![alt](https://cdn.example.com/x.png)ipt>alert(1)</script>',
        '!</script>[图](https://cdn.example.com/leak.png)',
        '!![a](https://cdn.example.com/a.png)[b](https://cdn.example.com/b.png)',
      ];
      for (const vector of directVectors) {
        const sanitized = sanitizeMarkdownForTextarea(vector);
        expect(sanitized).not.toContain('cdn.example.com');
        expect(sanitized).not.toContain('leak.png');
        expect(sanitized).not.toContain('![');
        expect(sanitized).not.toContain('<script');
        expect(sanitized).not.toContain('alert(1)');
      }
    });

    it('sanitizes nested-bracket unsafe links, bold/italic-wrapped images, and splits adjacent GFM tables cleanly (D3 & P4.5a)', async () => {
      const nestedLinksMd =
        '[click [1]](javascript:alert(1))\n[实测 [1]](https://post.smzdm.com/p/demo123abc)';

      // 1. Nested-bracket links in <textarea> (direct + end-to-end injectDraft)
      const textareaSanitized = sanitizeMarkdownForTextarea(nestedLinksMd);
      expect(textareaSanitized).not.toContain('javascript:');
      expect(textareaSanitized).not.toContain('alert(1)');
      expect(textareaSanitized).toContain('click [1]');
      expect(textareaSanitized).toContain('[实测 [1]](https://post.smzdm.com/p/demo123abc)');

      const textareaFixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const nestedTask = createSmzdmTaskFixture({
        variantHtml: '',
        variantMarkdown: nestedLinksMd,
        mediaAssets: [],
      });
      const textareaReport = await smzdmAdapter.injectDraft(
        textareaFixture.doc,
        nestedTask,
        uploader,
      );
      expect(textareaReport.ok).toBe(true);
      const injectedValue = (textareaFixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedValue).not.toContain('javascript:');
      expect(injectedValue).toContain('click [1]');
      expect(injectedValue).toContain('[实测 [1]](https://post.smzdm.com/p/demo123abc)');

      // 2. Nested-bracket links in renderMarkdownToFragment
      const doc = document.implementation.createHTMLDocument('Iter4MarkdownD3AndP45a');
      const linkContainer = doc.createElement('div');
      linkContainer.appendChild(renderMarkdownToFragment(doc, nestedLinksMd));
      const linkAnchors = Array.from(linkContainer.querySelectorAll('a'));
      expect(linkAnchors).toHaveLength(1);
      expect(linkAnchors[0]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(linkAnchors[0]?.textContent).toBe('实测 [1]');
      expect(linkContainer.innerHTML).not.toContain('javascript:');
      expect(linkContainer.textContent).toContain('click [1]');

      // 3. Bold/italic-wrapped images and deeply nested emphasis images in renderMarkdownToFragment & textarea
      const emphasisMd = [
        '前 **![alt](https://cdn.example.com/bold-img.png)** 中 *![alt](https://cdn.example.com/italic-img.png)* 后',
        '**实测结论 ![alt](https://cdn.example.com/mix.png) 推荐**',
        '**[危险](javascript:alert(1))** **[评测](https://post.smzdm.com/p/demo123abc)**',
        '**a *b **c *d **![x](https://cdn.example.com/deep.png)** d* c** b* a**',
      ].join('\n\n');

      const emphasisContainer = doc.createElement('div');
      emphasisContainer.appendChild(renderMarkdownToFragment(doc, emphasisMd));
      expect(emphasisContainer.innerHTML).not.toContain('cdn.example.com');
      expect(emphasisContainer.innerHTML).not.toContain('bold-img.png');
      expect(emphasisContainer.innerHTML).not.toContain('italic-img.png');
      expect(emphasisContainer.innerHTML).not.toContain('mix.png');
      expect(emphasisContainer.innerHTML).not.toContain('deep.png');
      expect(emphasisContainer.innerHTML).not.toContain('![alt]');
      expect(emphasisContainer.innerHTML).not.toContain('javascript:');
      expect(emphasisContainer.querySelector('img')).toBeNull();
      expect(emphasisContainer.textContent).toContain('前');
      expect(emphasisContainer.textContent).toContain('中');
      expect(emphasisContainer.textContent).toContain('后');
      expect(emphasisContainer.textContent).toContain('危险');

      const strongEls = Array.from(emphasisContainer.querySelectorAll('strong'));
      const conclusionStrong = strongEls.find((el) => (el.textContent ?? '').includes('实测结论'));
      expect(conclusionStrong?.textContent).toContain('推荐');
      const linkInsideStrong = strongEls.map((el) => el.querySelector('a')).find((a) => a !== null);
      expect(linkInsideStrong?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(linkInsideStrong?.textContent).toBe('评测');

      const emphasisTextareaOut = sanitizeMarkdownForTextarea(emphasisMd);
      expect(emphasisTextareaOut).not.toContain('cdn.example.com');
      expect(emphasisTextareaOut).not.toContain('javascript:');
      expect(emphasisTextareaOut).not.toContain('****');

      // 4. Two adjacent GFM tables without blank line (P4.5a)
      const adjacentTablesFrag = renderMarkdownToFragment(
        doc,
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n| C | D |\n| --- | --- |\n| 3 | 4 |',
      );
      const tables = Array.from(adjacentTablesFrag.querySelectorAll('table'));
      expect(tables).toHaveLength(2);
      expect(
        Array.from(tables[0]?.querySelectorAll('thead th') ?? []).map((th) => th.textContent),
      ).toEqual(['A', 'B']);
      expect(tables[0]?.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(
        Array.from(tables[0]?.querySelectorAll('tbody td') ?? []).map((td) => td.textContent),
      ).toEqual(['1', '2']);
      expect(
        Array.from(tables[1]?.querySelectorAll('thead th') ?? []).map((th) => th.textContent),
      ).toEqual(['C', 'D']);
      expect(tables[1]?.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(
        Array.from(tables[1]?.querySelectorAll('tbody td') ?? []).map((td) => td.textContent),
      ).toEqual(['3', '4']);
    });

    it('completes adversarial ReDoS payloads in linear time (< 150ms) for both sanitizeMarkdownForTextarea and renderMarkdownToFragment (B3 & D2)', () => {
      const doc = document.implementation.createHTMLDocument('PerfGuard');

      // Warmup briefly to eliminate cold JIT compilation variance across both scanners
      for (let w = 0; w < 3; w += 1) {
        sanitizeMarkdownForTextarea(
          '![w](https://cdn.example.com/w.png) <div onclick=x>w</div> <script></p > <a x=1 y="> <div/a=b<div/a=b y="><div onclick=1> *w*',
        );
        renderMarkdownToFragment(
          doc,
          '![w](https://cdn.example.com/w.png) **w** *w* [a](https://example.com)',
        );
      }

      const measureMs = (fn: () => void): number => {
        const start = performance.now();
        fn();
        return performance.now() - start;
      };

      const bothPayloads = [
        '![a](' + ' '.repeat(10000) + 'x',
        '[![a](https://cdn.example.com/a.png)](' + ' '.repeat(10000) + 'x',
        '![a['.repeat(3000),
        '[a['.repeat(3000),
      ];

      for (const payload of bothPayloads) {
        let textareaOut = '';
        const textareaElapsed = measureMs(() => {
          textareaOut = sanitizeMarkdownForTextarea(payload);
        });
        expect(textareaElapsed).toBeLessThan(1_000);
        expect(textareaOut).not.toContain('cdn.example.com');

        let domOut = '';
        const domElapsed = measureMs(() => {
          const frag = renderMarkdownToFragment(doc, payload);
          const wrap = doc.createElement('div');
          wrap.appendChild(frag);
          domOut = wrap.innerHTML;
        });
        expect(domElapsed).toBeLessThan(1_000);
        expect(domOut).not.toContain('cdn.example.com');
      }

      const rawHtmlPayloads = [
        '<a href="x" '.repeat(3000),
        '<img alt="a '.repeat(3000),
        '<div "'.repeat(3000),
        '<a x=1 '.repeat(3000) + 'y=">',
        '<script>'.repeat(3000),
      ];

      for (const payload of rawHtmlPayloads) {
        const elapsed = measureMs(() => {
          sanitizeMarkdownForTextarea(payload);
        });
        expect(elapsed).toBeLessThan(1_000);
      }

      // Iteration 5 linear-time regression guards (IB1 findClosingTag, D1 UNQUOTED_VALUE, emphasis runs)
      const iter5LinearHtmlPayloads = [
        '<script>' + '</p '.repeat(3000) + '>',
        '<a href="https://post.smzdm.com/p/demo123abc">' + '</span '.repeat(3000) + '>',
        '<a/x=1'.repeat(3000) + ' y=">',
        '<div/a=b'.repeat(3000) + ' y="><div onclick=1>',
        '</script/x=1'.repeat(3000) + ' y=">',
        '<img/src=1'.repeat(3000) + ' y=">',
      ];

      for (const payload of iter5LinearHtmlPayloads) {
        const elapsed = measureMs(() => {
          const out = sanitizeMarkdownForTextarea(payload);
          expect(out).not.toContain('onclick=');
        });
        expect(elapsed).toBeLessThan(1_000);
      }

      const iter5EmphasisPayloads = [
        '*'.repeat(10000),
        '**'.repeat(3000),
        '*a '.repeat(3000),
        '**a '.repeat(3000),
        '*a '.repeat(3000) + '[x](https://post.smzdm.com/p/demo123abc)',
      ];

      for (const payload of iter5EmphasisPayloads) {
        const taElapsed = measureMs(() => {
          sanitizeMarkdownForTextarea(payload);
        });
        expect(taElapsed).toBeLessThan(1_000);

        const domElapsed = measureMs(() => {
          renderMarkdownToFragment(doc, payload);
        });
        expect(domElapsed).toBeLessThan(1_000);
      }
    });

    it('rejects <scheme://...> autolinks as HTML tags so nested <script>/<img> inside angle-bracket image URLs are stripped while legitimate autolinks remain intact (D2)', async () => {
      const scriptInAngleImg =
        '![alt](<https://cdn.example.com/<script>alert(1)</script>my photo.png>)';
      const imgInAngleImg = '![alt](<https://cdn.example.com/<img src=x>my photo.png>)';
      const legitAutolink = '<https://cdn.example.com/a/src=1>';

      expect(sanitizeMarkdownForTextarea(scriptInAngleImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(imgInAngleImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(legitAutolink)).toBe(legitAutolink);

      // End-to-end <textarea> verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: [scriptInAngleImg, imgInAngleImg, '正文保留'].join('\n\n'),
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const value = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(value).not.toContain('<script');
      expect(value).not.toContain('<img');
      expect(value).not.toContain('cdn.example.com');
      expect(value).not.toContain('my photo.png');
      expect(value).toBe('正文保留');
    });

    it('enforces CommonMark atomic precedence so */** emphasis never splits images or javascript: links containing asterisks in both textarea and DOM paths (IB2 & D3c)', async () => {
      const doc = document.implementation.createHTMLDocument('AtomicEmphasisPrecedence');

      const starImgInEm = '*![a](https://cdn.example.com/a*b.png)*';
      const dblStarImgInStrong = '**![a](https://cdn.example.com/a**b.png)**';
      const starAltInEm = '*![a*b](https://cdn.example.com/a.png)*';
      const starJsLinkInEm = '*[click](javascript:alert(2*2))*';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      expect(sanitizeMarkdownForTextarea(starImgInEm)).toBe('');
      expect(sanitizeMarkdownForTextarea(dblStarImgInStrong)).toBe('');
      expect(sanitizeMarkdownForTextarea(starAltInEm)).toBe('');
      expect(sanitizeMarkdownForTextarea(starJsLinkInEm)).toBe('*click*');

      // 2. End-to-end <textarea> injectDraft assertions
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: [starImgInEm, dblStarImgInStrong, starAltInEm, starJsLinkInEm].join(
          '\n\n',
        ),
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const textareaVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(textareaVal).not.toContain('cdn.example.com');
      expect(textareaVal).not.toContain('javascript:');
      expect(textareaVal).not.toContain('![');
      expect(textareaVal).toBe('*click*');

      // 3. renderMarkdownToFragment DOM assertions
      const domWrap = doc.createElement('div');
      domWrap.appendChild(
        renderMarkdownToFragment(
          doc,
          [starImgInEm, dblStarImgInStrong, starAltInEm, starJsLinkInEm].join('\n\n'),
        ),
      );
      expect(domWrap.innerHTML).not.toContain('cdn.example.com');
      expect(domWrap.innerHTML).not.toContain('javascript:');
      expect(domWrap.querySelector('img')).toBeNull();
      expect(domWrap.querySelector('a')).toBeNull();
      const emEls = Array.from(domWrap.querySelectorAll('em'));
      expect(emEls).toHaveLength(1);
      expect(emEls[0]?.textContent).toBe('click');
      expect(domWrap.querySelectorAll('strong')).toHaveLength(0);
    });

    it('sanitizes CommonMark (...) titles, backslash escapes (\\"/\\\'/\\]), and unsafe ![ link labels in both textarea and DOM paths (IB3 & D3a-b)', async () => {
      const doc = document.implementation.createHTMLDocument('CommonMarkTitlesEscapesAndBangLink');

      const vectors = [
        '[click ![not-an-image]](javascript:alert(1))',
        '[click ![x]](https://127.0.0.1/secret)',
        '[click ![img](https://cdn.example.com/inner.png)](javascript:alert(1))',
        '![hotlink](https://cdn.example.com/a.png (title))',
        '[xss](javascript:alert(1) (title))',
        '[![alt](https://cdn.example.com/a.png (img-tip))](https://post.smzdm.com/p/demo123abc (link-tip))',
        '![alt](https://cdn.example.com/a.png "he said \\"hi\\"")',
        "![alt](https://cdn.example.com/a.png 'it\\'s ok')",
        '![alt \\]](https://cdn.example.com/esc-bracket.png)',
        '[click \\]](javascript:alert(1))',
        '[![alt \\]](https://cdn.example.com/a.png)](javascript:alert(1))',
      ];
      const combined = vectors.join('\n\n');

      // 1. Direct sanitizeMarkdownForTextarea assertions
      const textareaOut = sanitizeMarkdownForTextarea(combined);
      expect(textareaOut).not.toContain('cdn.example.com');
      expect(textareaOut).not.toContain('javascript:');
      expect(textareaOut).not.toContain('alert(1)');
      expect(textareaOut).not.toContain('127.0.0.1');
      expect(textareaOut).not.toContain('esc-bracket.png');
      expect(textareaOut).not.toContain('he said');
      expect(textareaOut).toContain('click ![not-an-image]');
      expect(textareaOut).toContain('click ![x]');
      expect(textareaOut).toContain('xss');
      expect(textareaOut).toContain('click \\]');
      expect(textareaOut).toContain('[alt](https://post.smzdm.com/p/demo123abc)');

      // 2. End-to-end <textarea> injectDraft verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('127.0.0.1');
      expect(injectedVal).toContain('[alt](https://post.smzdm.com/p/demo123abc)');

      // 3. renderMarkdownToFragment DOM assertions
      const domWrap = doc.createElement('div');
      domWrap.appendChild(renderMarkdownToFragment(doc, combined));
      expect(domWrap.innerHTML).not.toContain('cdn.example.com');
      expect(domWrap.innerHTML).not.toContain('javascript:');
      expect(domWrap.innerHTML).not.toContain('alert(1)');
      expect(domWrap.innerHTML).not.toContain('127.0.0.1');
      expect(domWrap.innerHTML).not.toContain('esc-bracket.png');
      expect(domWrap.querySelector('img')).toBeNull();

      const anchors = Array.from(domWrap.querySelectorAll('a'));
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.getAttribute('href')).toBe('https://post.smzdm.com/p/demo123abc');
      expect(anchors[0]?.textContent).toBe('alt');
    });

    it('skips CommonMark §6.1 inline code spans when pairing brackets and strips backtick-in-bracket images & javascript: links in strict Θ(N) time (I5-1)', async () => {
      const doc = document.implementation.createHTMLDocument('CodeSpanBracketPrecedence');

      const imgCloseBracket = '![`]`alt](https://cdn.example.com/a.png)';
      const imgOpenBracket = '![`[`alt](https://cdn.example.com/a.png)';
      const jsCloseBracket = '[click `]`](javascript:alert(1))';
      const jsOpenBracket = '[click `[`](javascript:alert(1))';
      const linkedImgCloseBracket =
        '[![`]`alt](https://cdn.example.com/a.png)](javascript:alert(1))';
      const multiTickImg = '![`` ] ``alt](https://cdn.example.com/a.png)';
      const multiTickJsLink = '[click `` ] ``](javascript:alert(1))';
      const backslashInCodeImg = '![`]\\`alt](https://cdn.example.com/a.png)';
      const escapedFirstTickImg = '![\\``]`alt](https://cdn.example.com/a.png)';
      const backtickInDestImg = '![alt](https://cdn.example.com/a`b)`';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      expect(sanitizeMarkdownForTextarea(imgCloseBracket)).toBe('');
      expect(sanitizeMarkdownForTextarea(imgOpenBracket)).toBe('');
      expect(sanitizeMarkdownForTextarea(jsCloseBracket)).toBe('click `]`');
      expect(sanitizeMarkdownForTextarea(jsOpenBracket)).toBe('click `[`');
      expect(sanitizeMarkdownForTextarea(linkedImgCloseBracket)).toBe('');
      expect(sanitizeMarkdownForTextarea(multiTickImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(multiTickJsLink)).toBe('click `` ] ``');
      expect(sanitizeMarkdownForTextarea(backslashInCodeImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(escapedFirstTickImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(backtickInDestImg)).toBe('`');

      // 2. End-to-end <textarea> injectDraft verification
      const combined = [
        imgCloseBracket,
        imgOpenBracket,
        jsCloseBracket,
        jsOpenBracket,
        linkedImgCloseBracket,
        multiTickImg,
      ].join('\n\n');

      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('![');
      expect(injectedVal).toContain('click `]`');
      expect(injectedVal).toContain('click `[`');

      // 3. renderMarkdownToFragment DOM assertions
      const domWrap = doc.createElement('div');
      domWrap.appendChild(renderMarkdownToFragment(doc, [combined, multiTickJsLink].join('\n\n')));
      expect(domWrap.innerHTML).not.toContain('cdn.example.com');
      expect(domWrap.innerHTML).not.toContain('javascript:');
      expect(domWrap.querySelector('img')).toBeNull();
      expect(domWrap.querySelector('a')).toBeNull();
      const codeTexts = Array.from(domWrap.querySelectorAll('code')).map((el) => el.textContent);
      expect(codeTexts).toEqual([']', '[', ']']);

      // 4. Strict Θ(N) performance guard on adversarial backtick runs (including distinct lengths 1..80)
      const distinctRuns = Array.from({ length: 80 }, (_, idx) => '`'.repeat(idx + 1)).join(' ');
      const unclosedPerfPayloads = ['`'.repeat(3000), distinctRuns];
      for (const payload of unclosedPerfPayloads) {
        const taStart = performance.now();
        sanitizeMarkdownForTextarea(`[x] ${payload}`);
        expect(performance.now() - taStart).toBeLessThan(1_000);

        const domStart = performance.now();
        renderMarkdownToFragment(doc, payload);
        expect(performance.now() - domStart).toBeLessThan(1_000);
      }

      const pairedBacktickPayload = '`a '.repeat(3000);
      const pairedTaStart = performance.now();
      sanitizeMarkdownForTextarea(`[x] ${pairedBacktickPayload}`);
      expect(performance.now() - pairedTaStart).toBeLessThan(1_000);

      // JSDOM allocates 1,500 <code> + 1,500 text nodes linearly (CI-safe ceiling 1,500ms)
      const pairedDomStart = performance.now();
      const pairedFrag = renderMarkdownToFragment(doc, pairedBacktickPayload);
      expect(performance.now() - pairedDomStart).toBeLessThan(1_500);
      expect(pairedFrag.querySelectorAll('code')).toHaveLength(1500);
    });

    it('supports CommonMark §6.3 32-level balanced parentheses in destinations so 5+ paren javascript: links and hotlink images are stripped in both paths (I5-2)', async () => {
      const doc = document.implementation.createHTMLDocument('BalancedParenDestinations');

      const js5 = '[click](javascript:alert(((((1))))))';
      const img5 = '![alt](https://cdn.example.com/a(((((b))))).png)';
      const js12 = '[click12](javascript:alert((((((((((((1)))))))))))))';
      const img12 = '![alt12](https://cdn.example.com/a((((((((((((b)))))))))))).png)';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      expect(sanitizeMarkdownForTextarea(js5)).toBe('click');
      expect(sanitizeMarkdownForTextarea(img5)).toBe('');
      expect(sanitizeMarkdownForTextarea(js12)).toBe('click12');
      expect(sanitizeMarkdownForTextarea(img12)).toBe('');

      // 2. End-to-end <textarea> injectDraft verification
      const combined = [js5, img5, js12, img12].join('\n\n');
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).toBe('click\n\nclick12');

      // 3. renderMarkdownToFragment DOM assertions
      const domWrap = doc.createElement('div');
      domWrap.appendChild(renderMarkdownToFragment(doc, combined));
      expect(domWrap.innerHTML).not.toContain('cdn.example.com');
      expect(domWrap.innerHTML).not.toContain('javascript:');
      expect(domWrap.querySelector('img')).toBeNull();
      expect(domWrap.querySelector('a')).toBeNull();
      expect(domWrap.innerHTML).toBe('<p>click</p><p>click12</p>');

      // 4. Linear performance guard on excessive unclosed parens (> 32)
      const excessiveParens = ('![a](' + '('.repeat(35) + ' ').repeat(200);
      const taStart = performance.now();
      sanitizeMarkdownForTextarea(excessiveParens);
      expect(performance.now() - taStart).toBeLessThan(1_000);

      const domStart = performance.now();
      renderMarkdownToFragment(doc, excessiveParens);
      expect(performance.now() - domStart).toBeLessThan(1_000);
    });

    it('rejects colon-bearing URI schemes as HTML tag names while still scrubbing xlink:href attributes and preserving valid autolinks (I5-3)', async () => {
      const dataScriptImg = '![alt](<data:image/png,<script>alert(1)</script>>)';
      const dataNestedImg = '![alt](<data:image/png,<img src=x>>)';
      const jsSlashScriptImg = '![alt](<javascript:a/b<script>alert(1)</script>>)';
      const dataTextHtml = '<data:text/html,<script>alert(1)</script>>';
      const legitAutolink = '<https://cdn.example.com/a/src=1>';
      const xlinkDiv = '<div xlink:href="javascript:alert(1)">ok</div>';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      expect(sanitizeMarkdownForTextarea(dataScriptImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(dataNestedImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(jsSlashScriptImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(dataTextHtml)).toBe('<data:text/html,>');
      expect(sanitizeMarkdownForTextarea(legitAutolink)).toBe(legitAutolink);

      const scrubbedXlink = sanitizeMarkdownForTextarea(xlinkDiv);
      expect(scrubbedXlink).not.toContain('xlink:href');
      expect(scrubbedXlink).not.toContain('javascript:');
      expect(scrubbedXlink).toBe('<div>ok</div>');

      // 2. End-to-end <textarea> injectDraft verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: [
          dataScriptImg,
          dataNestedImg,
          jsSlashScriptImg,
          xlinkDiv,
          legitAutolink,
        ].join('\n\n'),
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('<script');
      expect(injectedVal).not.toContain('alert(1)');
      expect(injectedVal).not.toContain('<img');
      expect(injectedVal).not.toContain('data:');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('xlink:href');
      expect(injectedVal).toContain('<div>ok</div>');
      expect(injectedVal).toContain(legitAutolink);
    });

    it('skips consumed ](...) destinations in buildInlineScanIndex so backticks inside URLs/titles never blind subsequent images or javascript: links in textarea or DOM paths (I6-1)', async () => {
      const doc = document.implementation.createHTMLDocument('BacktickInDestinationSkip');

      const queryTickImg =
        '[ok](https://post.smzdm.com/p/demo123abc?a=`1) ![hotlink](https://cdn.example.com/leak.png) `';
      const queryTickJs =
        '[ok](https://post.smzdm.com/p/demo123abc?a=`1) [xss](javascript:alert(1)) `';
      const angleQueryTickJs =
        '[ok](<https://post.smzdm.com/p/demo123abc?x=`1>) [xss](javascript:alert(1)) `';
      const twoTickImgs = '![a](https://cdn.example.com/1`2) ![b](https://cdn.example.com/3`4)';
      const tickImgAndJs = '![a](https://cdn.example.com/1`2) [xss](javascript:alert(1)`4)';
      const titleTickJs =
        '[ok](https://post.smzdm.com/p/demo123abc "tip`1") [xss](javascript:alert(1)) `';
      const hashTickImg =
        '[ok](https://post.smzdm.com/p/demo123abc#a`b) ![evil](https://cdn.example.com/evil.png) `';
      const angleImgTickImg =
        '![a](<https://cdn.example.com/a`b.png>) ![evil](https://cdn.example.com/evil.png) `';
      const codeBeforeLink =
        '` [ok](https://post.smzdm.com/p/demo123abc?a=`1) ![evil](https://cdn.example.com/evil.png)';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      const taQueryTickImg = sanitizeMarkdownForTextarea(queryTickImg);
      expect(taQueryTickImg).not.toContain('cdn.example.com');
      expect(taQueryTickImg).not.toContain('leak.png');
      expect(taQueryTickImg).toContain('[ok](https://post.smzdm.com/p/demo123abc?a=`1)');

      const taQueryTickJs = sanitizeMarkdownForTextarea(queryTickJs);
      expect(taQueryTickJs).not.toContain('javascript:');
      expect(taQueryTickJs).not.toContain('alert(1)');
      expect(taQueryTickJs).toContain('[ok](https://post.smzdm.com/p/demo123abc?a=`1)');

      const taAngleQueryTickJs = sanitizeMarkdownForTextarea(angleQueryTickJs);
      expect(taAngleQueryTickJs).not.toContain('javascript:');
      expect(taAngleQueryTickJs).not.toContain('alert(1)');

      expect(sanitizeMarkdownForTextarea(twoTickImgs)).toBe('');
      expect(sanitizeMarkdownForTextarea(tickImgAndJs)).toBe('xss');

      const taTitleTickJs = sanitizeMarkdownForTextarea(titleTickJs);
      expect(taTitleTickJs).not.toContain('javascript:');
      expect(taTitleTickJs).toContain('[ok](https://post.smzdm.com/p/demo123abc)');

      const taHashTickImg = sanitizeMarkdownForTextarea(hashTickImg);
      expect(taHashTickImg).not.toContain('cdn.example.com');
      expect(taHashTickImg).not.toContain('evil.png');

      const taAngleImgTickImg = sanitizeMarkdownForTextarea(angleImgTickImg);
      expect(taAngleImgTickImg).not.toContain('cdn.example.com');
      expect(taAngleImgTickImg).not.toContain('evil.png');
      expect(taAngleImgTickImg).toBe('`');

      // CommonMark §6.1 precedence: code span opened BEFORE '[' still takes precedence
      const taCodeBeforeLink = sanitizeMarkdownForTextarea(codeBeforeLink);
      expect(taCodeBeforeLink).toContain('` [ok](https://post.smzdm.com/p/demo123abc?a=`');
      expect(taCodeBeforeLink).not.toContain('cdn.example.com');
      expect(taCodeBeforeLink).not.toContain('evil.png');

      // 2. renderMarkdownToFragment DOM assertions
      const renderHtml = (md: string): string => {
        const wrap = doc.createElement('div');
        wrap.appendChild(renderMarkdownToFragment(doc, md));
        return wrap.innerHTML;
      };

      const domQueryTickImg = renderHtml(queryTickImg);
      expect(domQueryTickImg).not.toContain('cdn.example.com');
      expect(domQueryTickImg).not.toContain('leak.png');

      const domQueryTickJs = renderHtml(queryTickJs);
      expect(domQueryTickJs).not.toContain('javascript:');
      expect(domQueryTickJs).not.toContain('alert(1)');

      const domAngleQueryTickJs = renderHtml(angleQueryTickJs);
      expect(domAngleQueryTickJs).not.toContain('javascript:');

      expect(renderHtml(twoTickImgs)).toBe('');
      const domTickImgAndJs = renderHtml(tickImgAndJs);
      expect(domTickImgAndJs).not.toContain('cdn.example.com');
      expect(domTickImgAndJs).not.toContain('javascript:');
      expect(domTickImgAndJs).toBe('<p> xss</p>');

      const domTitleTickJs = renderHtml(titleTickJs);
      expect(domTitleTickJs).not.toContain('javascript:');

      const domHashTickImg = renderHtml(hashTickImg);
      expect(domHashTickImg).not.toContain('cdn.example.com');
      expect(domHashTickImg).not.toContain('evil.png');

      const domAngleImgTickImg = renderHtml(angleImgTickImg);
      expect(domAngleImgTickImg).not.toContain('cdn.example.com');
      expect(domAngleImgTickImg).not.toContain('evil.png');

      const domCodeBeforeLink = renderHtml(codeBeforeLink);
      expect(domCodeBeforeLink).toContain('<code>');
      expect(domCodeBeforeLink).not.toContain('cdn.example.com');
      expect(domCodeBeforeLink).not.toContain('evil.png');

      // 3. End-to-end <textarea> injectDraft verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      let draftClicks = 0;
      let publishClicks = 0;
      fixture.saveDraftButton?.addEventListener('click', () => {
        draftClicks += 1;
      });
      fixture.publishButton?.addEventListener('click', () => {
        publishClicks += 1;
      });
      const { uploader } = createMockSmzdmUploader('success');
      const combined = [
        queryTickImg,
        queryTickJs,
        angleQueryTickJs,
        twoTickImgs,
        tickImgAndJs,
        titleTickJs,
        hashTickImg,
        angleImgTickImg,
      ].join('\n\n');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(draftClicks).toBe(1);
      expect(publishClicks).toBe(0);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('leak.png');
      expect(injectedVal).not.toContain('evil.png');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('alert(1)');

      // 4. 200 backtick-in-dest images stripped in single pass in strict O(N) time in BOTH paths
      const manyTickImgs = '![a](https://cdn.example.com/1`2) '.repeat(200);
      const taStart = performance.now();
      const taManyOut = sanitizeMarkdownForTextarea(manyTickImgs);
      expect(performance.now() - taStart).toBeLessThan(1_000);
      expect(taManyOut).toBe('');

      const domStart = performance.now();
      const domManyOut = renderHtml(manyTickImgs);
      expect(performance.now() - domStart).toBeLessThan(1_000);
      expect(domManyOut).toBe('');
    });

    it('uses blank-line and fenced-code-block boundaries in computeCodeSpanEnds to strip multiline CommonMark §6.1 code-span payloads while isolating fences and paragraphs (I6-2)', async () => {
      const doc = document.implementation.createHTMLDocument('MultilineCodeSpanAndBoundaries');

      const mlImgClose = '![`\n]`alt](https://cdn.example.com/a.png)';
      const mlImgOpen = '![`\n[`alt](https://cdn.example.com/a.png)';
      const mlJsClose = '[click `\n]`](javascript:alert(1))';
      const mlLinkedImg = '[![`\n]`alt](https://cdn.example.com/a.png)](javascript:alert(1))';
      const mlDoubleTickImg = '![``\n]\n``alt](https://cdn.example.com/a.png)';
      const fencedBacktickIso =
        '```txt\nconst x = `;\n```\n![evil](https://cdn.example.com/evil.png) `';
      const fencedTildeIso = '~~~js\nconst y = `;\n~~~\n[xss](javascript:alert(1)) `';
      const blankLineIso = '`unclosed\n\n![evil](https://cdn.example.com/evil.png) `';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      expect(sanitizeMarkdownForTextarea(mlImgClose)).toBe('');
      expect(sanitizeMarkdownForTextarea(mlImgOpen)).toBe('');

      const taMlJsClose = sanitizeMarkdownForTextarea(mlJsClose);
      expect(taMlJsClose).not.toContain('javascript:');
      expect(taMlJsClose).not.toContain('alert(1)');
      expect(taMlJsClose).toBe('click `\n]`');

      expect(sanitizeMarkdownForTextarea(mlLinkedImg)).toBe('');
      expect(sanitizeMarkdownForTextarea(mlDoubleTickImg)).toBe('');

      const taFenceBacktick = sanitizeMarkdownForTextarea(fencedBacktickIso);
      expect(taFenceBacktick).not.toContain('cdn.example.com');
      expect(taFenceBacktick).not.toContain('evil.png');
      expect(taFenceBacktick).toContain('```txt\nconst x = `;\n```');

      const taFenceTilde = sanitizeMarkdownForTextarea(fencedTildeIso);
      expect(taFenceTilde).not.toContain('javascript:');
      expect(taFenceTilde).not.toContain('alert(1)');
      expect(taFenceTilde).toContain('~~~js\nconst y = `;\n~~~');

      const taBlankLine = sanitizeMarkdownForTextarea(blankLineIso);
      expect(taBlankLine).not.toContain('cdn.example.com');
      expect(taBlankLine).not.toContain('evil.png');
      expect(taBlankLine).toContain('`unclosed');

      // 2. renderMarkdownToFragment DOM assertions
      const renderHtml = (md: string): string => {
        const wrap = doc.createElement('div');
        wrap.appendChild(renderMarkdownToFragment(doc, md));
        return wrap.innerHTML;
      };

      expect(renderHtml(mlImgClose)).toBe('');
      expect(renderHtml(mlImgOpen)).toBe('');
      expect(renderHtml(mlJsClose)).not.toContain('javascript:');
      expect(renderHtml(mlLinkedImg)).toBe('');
      expect(renderHtml(mlDoubleTickImg)).toBe('');

      const domFenceBacktick = renderHtml(fencedBacktickIso);
      expect(domFenceBacktick).not.toContain('cdn.example.com');
      expect(domFenceBacktick).not.toContain('evil.png');
      expect(domFenceBacktick).toContain(
        '<pre class="measured-data-block"><code>const x = `;</code></pre>',
      );

      const domBlankLine = renderHtml(blankLineIso);
      expect(domBlankLine).not.toContain('cdn.example.com');
      expect(domBlankLine).not.toContain('evil.png');

      // 3. End-to-end <textarea> injectDraft verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      let draftClicks = 0;
      let publishClicks = 0;
      fixture.saveDraftButton?.addEventListener('click', () => {
        draftClicks += 1;
      });
      fixture.publishButton?.addEventListener('click', () => {
        publishClicks += 1;
      });
      const { uploader } = createMockSmzdmUploader('success');
      const combined = [
        mlImgClose,
        mlImgOpen,
        mlJsClose,
        mlLinkedImg,
        mlDoubleTickImg,
        fencedBacktickIso,
        fencedTildeIso,
        blankLineIso,
      ].join('\n\n');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(draftClicks).toBe(1);
      expect(publishClicks).toBe(0);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('evil.png');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('alert(1)');
      expect(injectedVal).toContain('```txt\nconst x = `;\n```');
    });

    it('clears stale codeSpanEnd inside skipped ](...) destinations so literal ![ labels with query/title/fragment backticks cannot shield subsequent hotlinks or javascript: links (I7-1)', async () => {
      const doc = document.implementation.createHTMLDocument('ClearedCodeSpanInDest');
      const renderHtml = (md: string): string => {
        const wrap = doc.createElement('div');
        wrap.appendChild(renderMarkdownToFragment(doc, md));
        return wrap.innerHTML;
      };

      const literalBangQueryImg =
        '[hello ![not] text](https://post.smzdm.com/p/demo123abc?a=`1) ![evil](https://cdn.example.com/evil.png) `';
      const literalBangQueryJs =
        '[hello ![not] text](https://post.smzdm.com/p/demo123abc?a=`1) [xss](javascript:alert(1)) `';
      const literalBangTitleImg =
        '[text ![badge]](https://post.smzdm.com/p/demo123abc "title `tick") ![evil](https://cdn.example.com/2.png) `tail';
      const nestedNotImgQueryImg =
        '[![not-an-img]](https://post.smzdm.com/p/demo123abc?x=`1) ![evil](https://cdn.example.com/evil.png) `';
      const literalBangFragmentJs =
        '[a ![x]](https://post.smzdm.com/p/demo123abc#`1) [xss](javascript:alert(1)) `';
      const imagePlusTextSafeLink =
        '[![a](https://cdn.example.com/x) b](https://post.smzdm.com/p/demo123abc?a=`1) ![evil](https://cdn.example.com/evil.png) `';
      const rawHtmlAnchorWithBang =
        '<a href="https://post.smzdm.com/p/demo123abc?a=`1">hello ![not] text</a> ![evil](https://cdn.example.com/evil.png) `';
      const codeBeforeLinkPrecedence =
        '`code [hello ![not]](https://post.smzdm.com/p/demo123abc?a=`1) ![evil](https://cdn.example.com/evil.png)';

      // 1. Direct sanitizeMarkdownForTextarea assertions
      for (const payload of [
        literalBangQueryImg,
        literalBangTitleImg,
        nestedNotImgQueryImg,
        imagePlusTextSafeLink,
        rawHtmlAnchorWithBang,
      ]) {
        const out = sanitizeMarkdownForTextarea(payload);
        expect(out).not.toContain('cdn.example.com');
        expect(out).not.toContain('evil.png');
        expect(out).not.toContain('2.png');
      }

      for (const payload of [literalBangQueryJs, literalBangFragmentJs]) {
        const out = sanitizeMarkdownForTextarea(payload);
        expect(out).not.toContain('javascript:');
        expect(out).not.toContain('alert(1)');
      }

      const taPrecedence = sanitizeMarkdownForTextarea(codeBeforeLinkPrecedence);
      expect(taPrecedence).toContain(
        '`code [hello ![not]](https://post.smzdm.com/p/demo123abc?a=`',
      );
      expect(taPrecedence).not.toContain('cdn.example.com');
      expect(taPrecedence).not.toContain('evil.png');

      // 2. Single-pass renderMarkdownToFragment DOM assertions
      for (const payload of [
        literalBangQueryImg,
        literalBangTitleImg,
        nestedNotImgQueryImg,
        imagePlusTextSafeLink,
      ]) {
        const html = renderHtml(payload);
        expect(html).not.toContain('cdn.example.com');
        expect(html).not.toContain('evil.png');
        expect(html).not.toContain('2.png');
      }

      for (const payload of [literalBangQueryJs, literalBangFragmentJs]) {
        const html = renderHtml(payload);
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('alert(1)');
      }

      const domPrecedence = renderHtml(codeBeforeLinkPrecedence);
      expect(domPrecedence).toContain('<code>');
      expect(domPrecedence).not.toContain('cdn.example.com');
      expect(domPrecedence).not.toContain('evil.png');

      // 3. End-to-end <textarea> injectDraft verification
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      let draftClicks = 0;
      let publishClicks = 0;
      fixture.saveDraftButton?.addEventListener('click', () => {
        draftClicks += 1;
      });
      fixture.publishButton?.addEventListener('click', () => {
        publishClicks += 1;
      });
      const { uploader } = createMockSmzdmUploader('success');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: [
          literalBangQueryImg,
          literalBangQueryJs,
          literalBangTitleImg,
          nestedNotImgQueryImg,
          literalBangFragmentJs,
          imagePlusTextSafeLink,
          rawHtmlAnchorWithBang,
        ].join('\n\n'),
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(draftClicks).toBe(1);
      expect(publishClicks).toBe(0);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('evil.png');
      expect(injectedVal).not.toContain('2.png');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('alert(1)');
    });

    it('isolates CommonMark §4/§5 & GFM §4.10 block and table-cell | boundaries in computeCodeSpanEnds without breaking multiline paragraph code spans or Θ(N) scaling (I7-2)', async () => {
      const hotlinkPayloads: Array<[string, string]> = [
        [
          'ATX # after para',
          'Intro with stray `\n# Heading ![evil](https://cdn.example.com/evil.png) `',
        ],
        [
          'ATX # before para',
          '# Heading with `unclosed\n![evil](https://cdn.example.com/evil.png) `',
        ],
        [
          'Setext === underline',
          'Heading with stray `\n===\n![evil](https://cdn.example.com/evil.png) `',
        ],
        ['Thematic break ---', '`unclosed\n---\n![evil](https://cdn.example.com/evil.png) `'],
        [
          'Thematic break ***',
          'Para `unclosed\n***\n![evil](https://cdn.example.com/evil.png)\n`closer',
        ],
        ['Unordered list -', '- item 1 `unclosed\n- ![evil](https://cdn.example.com/evil.png) `'],
        [
          'Para to unordered list',
          'Intro with stray `\n- ![evil](https://cdn.example.com/evil.png) `',
        ],
        ['Blockquote exit', '> quote `unclosed\n![evil](https://cdn.example.com/evil.png) `'],
        ['Blockquote entry', 'para `unclosed\n> ![evil](https://cdn.example.com/evil.png) `'],
        [
          'Blockquote inner heading',
          '> # Heading `unclosed\n> ![evil](https://cdn.example.com/evil.png) `',
        ],
        [
          'Piped GFM table cross-row',
          '| A | B |\n| --- | --- |\n| `unclosed | ok |\n| ![evil](https://cdn.example.com/evil.png) | ` |',
        ],
        [
          'Piped GFM table same-row cross-cell |',
          '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 型号 `A | ![evil](https://cdn.example.com/evil.png) | 型号 `B |',
        ],
        [
          'Pipe-less GFM table cross-row',
          'A | B\n--- | ---\n`unclosed | ok\n![evil](https://cdn.example.com/evil.png) | `',
        ],
        [
          'HTML block <p>',
          'Intro with stray `\n<p>![evil](https://cdn.example.com/evil.png) `</p>',
        ],
        [
          'HTML block <div>',
          'Intro with stray `\n<div>![evil](https://cdn.example.com/evil.png) `</div>',
        ],
      ];

      const jsPayloads: Array<[string, string]> = [
        ['ATX ## + js', 'Intro with stray `\n## Heading [xss](javascript:alert(1)) `'],
        ['ATX ## before para + js', '## Heading with `unclosed\n[xss](javascript:alert(1)) `'],
        ['Thematic break *** + js', '`unclosed\n***\n[xss](javascript:alert(1)) `'],
        ['Ordered list 1. + js', '1. item 1 `unclosed\n2. [xss](javascript:alert(1)) `'],
        ['Para to ordered list + js', 'Intro with stray `\n1. [xss](javascript:alert(1)) `'],
        [
          'Piped GFM table + js',
          '| A | B |\n| --- | --- |\n| `unclosed | ok |\n| [xss](javascript:alert(1)) | ` |',
        ],
        [
          'Pipe-less GFM table + js',
          'A | B\n--- | ---\n`unclosed | ok\n[xss](javascript:alert(1)) | `',
        ],
      ];

      // 1. Direct sanitizeMarkdownForTextarea assertions for every I7-2 vector
      for (const [, md] of hotlinkPayloads) {
        const out = sanitizeMarkdownForTextarea(md);
        expect(out).not.toContain('cdn.example.com');
        expect(out).not.toContain('evil.png');
      }

      for (const [, md] of jsPayloads) {
        const out = sanitizeMarkdownForTextarea(md);
        expect(out).not.toContain('javascript:');
        expect(out).not.toContain('alert(1)');
      }

      // 2. Positive controls: legitimate same-cell code span with escaped pipe, normal paragraph pipe,
      //    and multiline inline code spans containing inline HTML remain intact.
      const safeTableEscapedPipe = '| 参数 | 规则 |\n| --- | --- |\n| 正则 | `a \\| b` |';
      expect(sanitizeMarkdownForTextarea(safeTableEscapedPipe)).toBe(safeTableEscapedPipe);

      const safeParaPipe = '说明：`foo | bar` 与普通文本';
      expect(sanitizeMarkdownForTextarea(safeParaPipe)).toBe(safeParaPipe);

      const safeMultilineInlineHtml = 'Before `line1\n<span>ok</span>` after';
      expect(sanitizeMarkdownForTextarea(safeMultilineInlineHtml)).toBe(safeMultilineInlineHtml);

      // 3. End-to-end <textarea> injectDraft verification across all I7-2 vectors
      const fixture = createSmzdmEditorDocument({ editorVariant: 'textarea' });
      let draftClicks = 0;
      let publishClicks = 0;
      fixture.saveDraftButton?.addEventListener('click', () => {
        draftClicks += 1;
      });
      fixture.publishButton?.addEventListener('click', () => {
        publishClicks += 1;
      });
      const { uploader } = createMockSmzdmUploader('success');
      const combined = [
        ...hotlinkPayloads.map(([, md]) => md),
        ...jsPayloads.map(([, md]) => md),
      ].join('\n\n');
      const task = createSmzdmTaskFixture({
        variantHtml: '',
        mediaAssets: [],
        variantMarkdown: combined,
      });
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(draftClicks).toBe(1);
      expect(publishClicks).toBe(0);
      const injectedVal = (fixture.bodyEditor as HTMLTextAreaElement).value;
      expect(injectedVal).not.toContain('cdn.example.com');
      expect(injectedVal).not.toContain('evil.png');
      expect(injectedVal).not.toContain('javascript:');
      expect(injectedVal).not.toContain('alert(1)');

      // 4. Strict Θ(N) performance check on large pipe-heavy / multi-row GFM table input
      const largePipeInput =
        'ColA | ColB\n--- | ---\n' +
        'item `x | ![evil](https://cdn.example.com/evil.png) | item `y\n'.repeat(500);
      const start = performance.now();
      const largeOut = sanitizeMarkdownForTextarea(largePipeInput);
      expect(performance.now() - start).toBeLessThan(1_000);
      expect(largeOut).not.toContain('cdn.example.com');
      expect(largeOut).not.toContain('evil.png');
    });
  });

  describe('7. Image Relay (LocalImageUploader) & PARTIAL_MEDIA_FAILED', () => {
    it('delegates all mediaAssets to uploader.uploadAll with editorElement and fileInput', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmTaskFixture();
      const { uploader, uploadAllSpy, receivedTargets, receivedAssets } =
        createMockSmzdmUploader('success');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(uploadAllSpy).toHaveBeenCalledTimes(1);
      expect(receivedAssets[0]).toEqual(task.mediaAssets);
      expect(receivedTargets[0]?.editorElement).toBe(fixture.bodyEditor);
      expect(receivedTargets[0]?.fileInput).toBe(fixture.fileInput);
      expect(report.uploadedImages).toBe(2);
      expect(report.failedImages).toBe(0);
    });

    it('integrates with real createLocalImageUploader for both <input type="file"> and paste fallback', async () => {
      const fetchMediaAsset = vi.fn(async (asset: { url: string; alt: string; mime?: string }) => ({
        ok: true as const,
        data: {
          ok: true as const,
          url: asset.url,
          alt: asset.alt,
          mime: asset.mime ?? 'image/png',
          base64: DEMO_PNG_BASE64,
          filename: 'demo-image.png',
          byteLength: 68,
        },
      }));
      const realUploader = createLocalImageUploader({ fetchMediaAsset });
      const task = createSmzdmTaskFixture({
        mediaAssets: [
          {
            url: 'https://cdn.example.com/smzdm/demo-cover.png',
            alt: 'DemoBrand 实测封面图',
            mime: 'image/png',
          },
        ],
      });

      // (a) Native <input type="file"> path
      const withInputFixture = createSmzdmEditorDocument({ includeFileInput: true });
      const inputChangeEvents: number[] = [];
      withInputFixture.fileInput?.addEventListener('change', () => {
        inputChangeEvents.push(withInputFixture.fileInput?.files?.length ?? 0);
      });

      const fileReport = await smzdmAdapter.injectDraft(withInputFixture.doc, task, realUploader);
      expect(DraftInjectReportSchema.parse(fileReport)).toEqual(fileReport);
      expect(fileReport.ok).toBe(true);
      expect(fileReport.stage).toBe('INJECTED');
      expect(fileReport.uploadedImages).toBe(1);
      expect(withInputFixture.fileInput?.files?.length).toBe(1);
      expect(inputChangeEvents).toEqual([1]);

      // (b) Paste fallback when no <input type="file"> exists (even if listener calls preventDefault)
      const pasteFixture = createSmzdmEditorDocument({ includeFileInput: false });
      const pastedFileNames: string[] = [];
      pasteFixture.bodyEditor.addEventListener('paste', (event) => {
        event.preventDefault();
        const clipboardEvent = event as ClipboardEvent;
        const pastedFile = clipboardEvent.clipboardData?.files?.[0];
        if (pastedFile) {
          pastedFileNames.push(pastedFile.name);
        }
      });

      const pasteReport = await smzdmAdapter.injectDraft(pasteFixture.doc, task, realUploader);
      expect(DraftInjectReportSchema.parse(pasteReport)).toEqual(pasteReport);
      expect(pasteReport.ok).toBe(true);
      expect(pasteReport.stage).toBe('INJECTED');
      expect(pasteReport.uploadedImages).toBe(1);
      expect(pastedFileNames).toEqual(['demo-image.png']);
    });

    it('reports PARTIAL_MEDIA_FAILED on partial and total failure with zero external hotlink fallback', async () => {
      const task = createSmzdmTaskFixture();

      // Partial failure: 1 uploaded, 1 failed
      const partialFixture = createSmzdmEditorDocument({ documentUrl: SMZDM_EDITOR_DRAFT_URL });
      const partialMock = createMockSmzdmUploader('partial');
      const partialReport = await smzdmAdapter.injectDraft(
        partialFixture.doc,
        task,
        partialMock.uploader,
      );

      expect(DraftInjectReportSchema.parse(partialReport)).toEqual(partialReport);
      expect(partialReport.ok).toBe(false);
      expect(partialReport.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(partialReport.draftUrl).toBe('https://post.smzdm.com/tougao/');
      expect(partialReport.uploadedImages).toBe(1);
      expect(partialReport.failedImages).toBe(1);
      expect(partialReport.failedImageDetails).toEqual([
        {
          url: 'https://cdn.example.com/smzdm/demo-chart.webp',
          alt: '续航与噪音实测曲线图',
          reason: '图片拉取超时 (15s)',
        },
      ]);
      expect(partialReport.operatorReminders).toEqual([...SMZDM_OPERATOR_REMINDERS]);
      expect(partialFixture.bodyEditor.querySelector('img[src*="cdn.example.com"]')).toBeNull();
      expect(partialFixture.bodyEditor.querySelector('table')).not.toBeNull();

      // Total failure: 0 uploaded, 2 failed
      const allFailFixture = createSmzdmEditorDocument();
      const allFailMock = createMockSmzdmUploader('all-fail');
      const allFailReport = await smzdmAdapter.injectDraft(
        allFailFixture.doc,
        task,
        allFailMock.uploader,
      );

      expect(DraftInjectReportSchema.parse(allFailReport)).toEqual(allFailReport);
      expect(allFailReport.ok).toBe(false);
      expect(allFailReport.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(allFailReport.uploadedImages).toBe(0);
      expect(allFailReport.failedImages).toBe(2);
      expect(allFailReport.failedImageDetails).toHaveLength(2);
      expect(allFailReport.operatorReminders).toEqual([...SMZDM_OPERATOR_REMINDERS]);
      expect(allFailFixture.bodyEditor.querySelector('img')).toBeNull();
      expect(allFailFixture.titleInput.value).toBe(task.variantTitle);
    });
  });

  describe('8. Draft-Only Redline & Public URL Capture', () => {
    it('clicks ONLY 保存草稿 and NEVER clicks 提交审核 or 发布', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      const draftSpy = vi.spyOn(fixture.saveDraftButton!, 'click');
      const submitSpy = vi.spyOn(fixture.submitReviewButton!, 'click');
      const publishSpy = vi.spyOn(fixture.publishButton!, 'click');

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(draftSpy).toHaveBeenCalledTimes(1);
      expect(submitSpy).toHaveBeenCalledTimes(0);
      expect(publishSpy).toHaveBeenCalledTimes(0);
    });

    it.each(['存草稿', '暂存草稿', '保存为草稿', '存入草稿箱', '保存草稿箱'])(
      'clicks allowlisted draft button label "%s" only and never publish/submit buttons',
      async (label) => {
        const fixture = createSmzdmEditorDocument({ draftButtonLabel: label });
        const task = createSmzdmTaskFixture({ mediaAssets: [] });
        const { uploader } = createMockSmzdmUploader('success');

        const draftSpy = vi.spyOn(fixture.saveDraftButton!, 'click');
        const submitSpy = vi.spyOn(fixture.submitReviewButton!, 'click');
        const publishSpy = vi.spyOn(fixture.publishButton!, 'click');

        await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

        expect(draftSpy).toHaveBeenCalledTimes(1);
        expect(submitSpy).toHaveBeenCalledTimes(0);
        expect(publishSpy).toHaveBeenCalledTimes(0);
      },
    );

    it.each(['保存并发布', '存草稿并发布', '保存草稿并提交审核', '预览并发布', '删除草稿'])(
      'NEVER clicks adversarial trap button "%s"',
      async (trapLabel) => {
        const fixture = createSmzdmEditorDocument({
          draftButtonLabel: null,
          includeTrapButton: true,
          trapButtonLabel: trapLabel,
        });
        const task = createSmzdmTaskFixture({ mediaAssets: [] });
        const { uploader } = createMockSmzdmUploader('success');

        const trapSpy = vi.spyOn(fixture.trapButton!, 'click');
        const submitSpy = vi.spyOn(fixture.submitReviewButton!, 'click');
        const publishSpy = vi.spyOn(fixture.publishButton!, 'click');

        expect(findDraftSaveButton(fixture.doc)).toBeNull();

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        expect(trapSpy).toHaveBeenCalledTimes(0);
        expect(submitSpy).toHaveBeenCalledTimes(0);
        expect(publishSpy).toHaveBeenCalledTimes(0);
      },
    );

    it('never clicks disabled, aria-disabled, hidden, type="submit", or absent draft buttons', async () => {
      const cases = [
        createSmzdmEditorDocument({ draftButtonDisabled: true }),
        createSmzdmEditorDocument({ draftButtonAriaDisabled: true }),
        createSmzdmEditorDocument({ draftButtonHidden: true }),
        createSmzdmEditorDocument({ draftButtonLabel: null }),
      ];

      // Also verify a button[type="submit"] labeled "保存草稿" is rejected by Layer 1
      const submitTypeCase = createSmzdmEditorDocument();
      submitTypeCase.saveDraftButton?.setAttribute('type', 'submit');
      cases.push(submitTypeCase);

      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      for (const fixture of cases) {
        const draftSpy = fixture.saveDraftButton
          ? vi.spyOn(fixture.saveDraftButton, 'click')
          : null;
        const submitSpy = vi.spyOn(fixture.submitReviewButton!, 'click');
        const publishSpy = vi.spyOn(fixture.publishButton!, 'click');

        expect(findDraftSaveButton(fixture.doc)).toBeNull();

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

        expect(DraftInjectReportSchema.parse(report)).toEqual(report);
        expect(report.ok).toBe(true);
        expect(report.stage).toBe('INJECTED');
        if (draftSpy) {
          expect(draftSpy).not.toHaveBeenCalled();
        }
        expect(submitSpy).toHaveBeenCalledTimes(0);
        expect(publishSpy).toHaveBeenCalledTimes(0);
      }
    });

    it('blocks HTML5 implicit <button> submit inside <form> while allowing standalone or explicit type="button" draft buttons', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      // (a) Implicit submit <button> inside <form> -> rejected, zero form submission
      const formFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const form = formFixture.doc.createElement('form');
      form.action = 'https://post.smzdm.com/tougao/publish';
      let formSubmitted = false;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        formSubmitted = true;
      });
      const implicitSubmitBtn = formFixture.doc.createElement('button');
      implicitSubmitBtn.textContent = '保存草稿';
      form.appendChild(implicitSubmitBtn);
      formFixture.doc.body.appendChild(form);

      expect(findDraftSaveButton(formFixture.doc)).toBeNull();
      const report = await smzdmAdapter.injectDraft(formFixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(formSubmitted).toBe(false);

      // (b) Standalone <button> outside <form> without form attribute -> accepted & clicked
      const standaloneFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const standaloneBtn = standaloneFixture.doc.createElement('button');
      standaloneBtn.textContent = '保存草稿';
      standaloneFixture.doc.body.appendChild(standaloneBtn);
      const standaloneSpy = vi.spyOn(standaloneBtn, 'click');

      expect(findDraftSaveButton(standaloneFixture.doc)).toBe(standaloneBtn);
      await smzdmAdapter.injectDraft(standaloneFixture.doc, task, uploader);
      expect(standaloneSpy).toHaveBeenCalledTimes(1);
    });

    it('never clicks injected <a> links inside bodyEditor and still clicks the real toolbar draft button', async () => {
      const fixture = createSmzdmEditorDocument();
      const task = createSmzdmTaskFixture({
        variantHtml:
          '<p>请点击 <a href="https://evil.example.com/phish">保存草稿</a> 查看说明。</p>',
        mediaAssets: [],
      });
      const { uploader } = createMockSmzdmUploader('success');

      const realDraftSpy = vi.spyOn(fixture.saveDraftButton!, 'click');
      let injectedAnchorClicked = false;
      fixture.bodyEditor.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName.toUpperCase() === 'A') {
          injectedAnchorClicked = true;
        }
      });

      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(injectedAnchorClicked).toBe(false);
      expect(realDraftSpy).toHaveBeenCalledTimes(1);
      expect(findDraftSaveButton(fixture.doc)).toBe(fixture.saveDraftButton);
    });

    it('rejects ancestor/descendant publish metadata traps, navigation/attribute traps, fieldset[disabled], inert, and login-dialog buttons', async () => {
      const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const trapContainer = fixture.doc.createElement('div');
      trapContainer.className = 'trap-suite';
      trapContainer.innerHTML = [
        '<button type="button" class="btn-publish" data-action="publish"><span role="button">保存草稿</span></button>',
        '<button type="button"><span data-action="publish" title="发布"></span><span>保存草稿</span></button>',
        '<a href="/tougao/publish">保存草稿</a>',
        '<a href="javascript:publishPost()">保存草稿</a>',
        '<a href="https://evil.example.com/redirect">保存草稿</a>',
        '<a href="#publish">保存草稿</a>',
        '<a href="https://evil.example.com/phish"><span role="button">保存草稿</span></a>',
        '<button type="button" formaction="/tougao/publish">保存草稿</button>',
        '<button type="button" data-event="publish">保存草稿</button>',
        '<button type="button" onclick="publishPost()">保存草稿</button>',
        '<fieldset disabled><button type="button">保存草稿</button></fieldset>',
        '<div inert><button type="button">保存草稿</button></div>',
      ].join('\n');
      fixture.doc.body.appendChild(trapContainer);

      const clickedElements: Element[] = [];
      trapContainer.addEventListener('click', (event) => {
        if (event.target instanceof Element) {
          clickedElements.push(event.target);
        }
      });

      expect(findDraftSaveButton(fixture.doc)).toBeNull();

      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(report.ok).toBe(true);
      expect(clickedElements).toHaveLength(0);

      // Login prompt dialog with a draft button MUST also be rejected on direct findDraftSaveButton(doc) calls
      const dialogFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const dialog = dialogFixture.doc.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const tip = dialogFixture.doc.createElement('p');
      tip.textContent = '请先登录';
      const dialogDraftBtn = dialogFixture.doc.createElement('button');
      dialogDraftBtn.type = 'button';
      dialogDraftBtn.textContent = '保存草稿';
      dialog.appendChild(tip);
      dialog.appendChild(dialogDraftBtn);
      dialogFixture.doc.body.appendChild(dialog);

      expect(findDraftSaveButton(dialogFixture.doc)).toBeNull();
    });

    it('blocks sibling descendant publish metadata inside an interactive ancestor button', async () => {
      const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const outerBtn = fixture.doc.createElement('button');
      outerBtn.type = 'button';
      outerBtn.id = 'outer-btn';
      outerBtn.innerHTML =
        '<span data-action="publish" title="发布"></span><span role="button" id="inner-role-btn">保存草稿</span>';
      fixture.doc.body.appendChild(outerBtn);

      const outerClickSpy = vi.fn();
      outerBtn.addEventListener('click', outerClickSpy);

      expect(findDraftSaveButton(fixture.doc)).toBeNull();

      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);

      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(outerClickSpy).toHaveBeenCalledTimes(0);
    });

    it('blocks implicit and explicit <label> activation form-submit bypasses', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      // (a) Implicit <label> wrapping a hidden <input type="submit">
      const implicitFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const implicitForm = implicitFixture.doc.createElement('form');
      implicitForm.action = 'https://post.smzdm.com/tougao/publish';
      let implicitSubmitted = false;
      implicitForm.addEventListener('submit', (event) => {
        event.preventDefault();
        implicitSubmitted = true;
      });
      implicitForm.innerHTML =
        '<label><input type="submit" style="display:none"><span role="button">保存草稿</span></label>';
      implicitFixture.doc.body.appendChild(implicitForm);

      expect(findDraftSaveButton(implicitFixture.doc)).toBeNull();
      const implicitReport = await smzdmAdapter.injectDraft(implicitFixture.doc, task, uploader);
      expect(implicitReport.ok).toBe(true);
      expect(implicitSubmitted).toBe(false);

      // (b) Explicit <label for="pub-sub"> targeting an external <input type="submit">
      const explicitFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const explicitForm = explicitFixture.doc.createElement('form');
      explicitForm.action = 'https://post.smzdm.com/tougao/publish';
      let explicitSubmitted = false;
      explicitForm.addEventListener('submit', (event) => {
        event.preventDefault();
        explicitSubmitted = true;
      });
      explicitForm.innerHTML = '<input id="pub-sub" type="submit" style="display:none">';
      const explicitLabel = explicitFixture.doc.createElement('label');
      explicitLabel.setAttribute('for', 'pub-sub');
      explicitLabel.innerHTML = '<span role="button">保存草稿</span>';
      explicitFixture.doc.body.appendChild(explicitForm);
      explicitFixture.doc.body.appendChild(explicitLabel);

      expect(findDraftSaveButton(explicitFixture.doc)).toBeNull();
      const explicitReport = await smzdmAdapter.injectDraft(explicitFixture.doc, task, uploader);
      expect(explicitReport.ok).toBe(true);
      expect(explicitSubmitted).toBe(false);
    });

    it('rejects <input type="image" role="button"> and all non-button <input> types inside <form> with zero form submissions (Defect 1)', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      // 1. <input type="image" role="button"> inside <form>
      const imgInputFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const imgForm = imgInputFixture.doc.createElement('form');
      imgForm.action = 'https://post.smzdm.com/tougao/publish';
      let imgSubmitted = false;
      imgForm.addEventListener('submit', (event) => {
        event.preventDefault();
        imgSubmitted = true;
      });
      imgForm.innerHTML =
        '<input id="img-btn" type="image" role="button" value="保存草稿" alt="保存草稿" />';
      imgInputFixture.doc.body.appendChild(imgForm);

      expect(findDraftSaveButton(imgInputFixture.doc)).toBeNull();
      const imgReport = await smzdmAdapter.injectDraft(imgInputFixture.doc, task, uploader);
      expect(imgReport.ok).toBe(true);
      expect(imgReport.stage).toBe('INJECTED');
      expect(imgSubmitted).toBe(false);

      // 2. Non-button <input> types (checkbox, omitted/text) carrying role="button"
      const nonBtnFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const nonBtnForm = nonBtnFixture.doc.createElement('form');
      let nonBtnSubmitted = false;
      nonBtnForm.addEventListener('submit', (event) => {
        event.preventDefault();
        nonBtnSubmitted = true;
      });
      nonBtnForm.innerHTML =
        '<input type="checkbox" role="button" value="保存草稿"><input role="button" value="保存草稿">';
      nonBtnFixture.doc.body.appendChild(nonBtnForm);

      expect(findDraftSaveButton(nonBtnFixture.doc)).toBeNull();
      await smzdmAdapter.injectDraft(nonBtnFixture.doc, task, uploader);
      expect(nonBtnSubmitted).toBe(false);

      // 3. <label> wrapping hidden <input type="image"> + <span role="button">保存草稿</span>
      const labelImgFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const labelImgForm = labelImgFixture.doc.createElement('form');
      let labelImgSubmitted = false;
      labelImgForm.addEventListener('submit', (event) => {
        event.preventDefault();
        labelImgSubmitted = true;
      });
      labelImgForm.innerHTML =
        '<label><input type="image" style="display:none"><span role="button">保存草稿</span></label>';
      labelImgFixture.doc.body.appendChild(labelImgForm);

      expect(findDraftSaveButton(labelImgFixture.doc)).toBeNull();
      await smzdmAdapter.injectDraft(labelImgFixture.doc, task, uploader);
      expect(labelImgSubmitted).toBe(false);

      // 4. Positive control: explicit <input type="button" value="保存草稿"> inside <form>
      const safeInputFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const safeForm = safeInputFixture.doc.createElement('form');
      safeForm.action = 'https://post.smzdm.com/tougao/publish';
      let safeSubmitted = false;
      safeForm.addEventListener('submit', (event) => {
        event.preventDefault();
        safeSubmitted = true;
      });
      safeForm.innerHTML = '<input id="safe-input-btn" type="button" value="保存草稿" />';
      safeInputFixture.doc.body.appendChild(safeForm);

      const safeBtn = safeInputFixture.doc.getElementById('safe-input-btn') as HTMLInputElement;
      const safeClickSpy = vi.spyOn(safeBtn, 'click');
      expect(findDraftSaveButton(safeInputFixture.doc)).toBe(safeBtn);
      const safeReport = await smzdmAdapter.injectDraft(safeInputFixture.doc, task, uploader);
      expect(safeReport.ok).toBe(true);
      expect(safeClickSpy).toHaveBeenCalledTimes(1);
      expect(safeSubmitted).toBe(false);
    });

    it('rejects ancestors with forbidden inline pointer/click handlers while allowing benign analytics handlers and publish-actions toolbars (Defect 2)', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      // Negative 1 & 2: ancestor inline pointer handlers referencing publish/submit/audit
      const pointerHandlerCases: Array<[string, string]> = [
        ['onclick', 'publishPost()'],
        ['onmousedown', 'publishPost()'],
        ['onmouseup', 'submitReview()'],
        ['onpointerdown', 'publishPost()'],
        ['onpointerup', 'auditPost()'],
        ['ondblclick', 'publishPost()'],
        ['onauxclick', 'publishPost()'],
      ];

      for (const [handlerAttr, handlerBody] of pointerHandlerCases) {
        const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
        const wrap = fixture.doc.createElement('div');
        wrap.id = 'wrap';
        wrap.setAttribute(handlerAttr, handlerBody);
        const btn = fixture.doc.createElement('button');
        btn.type = 'button';
        btn.id = 'draft-btn';
        btn.textContent = '保存草稿';
        wrap.appendChild(btn);
        fixture.doc.body.appendChild(wrap);

        const clickSpy = vi.spyOn(btn, 'click');
        expect(findDraftSaveButton(fixture.doc)).toBeNull();
        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
        expect(report.ok).toBe(true);
        expect(clickSpy).toHaveBeenCalledTimes(0);
      }

      // Negative 3: benign handler value + forbidden same-element attribute on ancestor
      const sameElAttrFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const attrWrap = sameElAttrFixture.doc.createElement('div');
      attrWrap.setAttribute('data-action', 'publish');
      attrWrap.setAttribute('onclick', 'handleClick()');
      const attrBtn = sameElAttrFixture.doc.createElement('button');
      attrBtn.type = 'button';
      attrBtn.textContent = '保存草稿';
      attrWrap.appendChild(attrBtn);
      sameElAttrFixture.doc.body.appendChild(attrWrap);
      expect(findDraftSaveButton(sameElAttrFixture.doc)).toBeNull();

      // Negative 4: JS-assigned named onclick function on ancestor
      const domPropFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const propWrap = domPropFixture.doc.createElement('div');
      propWrap.onclick = function publishPost() {
        // intentional named handler trap
      };
      const propBtn = domPropFixture.doc.createElement('button');
      propBtn.type = 'button';
      propBtn.textContent = '保存草稿';
      propWrap.appendChild(propBtn);
      domPropFixture.doc.body.appendChild(propWrap);
      expect(findDraftSaveButton(domPropFixture.doc)).toBeNull();

      // Positive control 1: benign analytics handler on ancestor
      const analyticsFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const analyticsWrap = analyticsFixture.doc.createElement('div');
      analyticsWrap.setAttribute('onclick', 'trackAnalytics()');
      const analyticsBtn = analyticsFixture.doc.createElement('button');
      analyticsBtn.type = 'button';
      analyticsBtn.id = 'analytics-draft';
      analyticsBtn.textContent = '保存草稿';
      analyticsWrap.appendChild(analyticsBtn);
      analyticsFixture.doc.body.appendChild(analyticsWrap);
      const analyticsSpy = vi.spyOn(analyticsBtn, 'click');
      expect(findDraftSaveButton(analyticsFixture.doc)).toBe(analyticsBtn);
      await smzdmAdapter.injectDraft(analyticsFixture.doc, task, uploader);
      expect(analyticsSpy).toHaveBeenCalledTimes(1);

      // Positive control 2: non-interactive toolbar wrapper with publish-actions class and sibling publish button
      const toolbarFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const toolbar = toolbarFixture.doc.createElement('div');
      toolbar.className = 'editor-footer publish-actions';
      toolbar.innerHTML =
        '<button type="button" id="toolbar-draft">保存草稿</button><button type="button" class="btn-publish">提交审核</button>';
      toolbarFixture.doc.body.appendChild(toolbar);
      const toolbarDraft = toolbarFixture.doc.getElementById('toolbar-draft') as HTMLButtonElement;
      const toolbarPublish = toolbar.querySelector('.btn-publish') as HTMLButtonElement;
      const toolbarDraftSpy = vi.spyOn(toolbarDraft, 'click');
      const toolbarPublishSpy = vi.spyOn(toolbarPublish, 'click');
      expect(findDraftSaveButton(toolbarFixture.doc)).toBe(toolbarDraft);
      await smzdmAdapter.injectDraft(toolbarFixture.doc, task, uploader);
      expect(toolbarDraftSpy).toHaveBeenCalledTimes(1);
      expect(toolbarPublishSpy).toHaveBeenCalledTimes(0);

      // Positive control 3: <form onsubmit="publishPost()"> containing explicit <button type="button">
      const formFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const form = formFixture.doc.createElement('form');
      form.action = 'https://post.smzdm.com/tougao/publish';
      form.setAttribute('onsubmit', 'publishPost()');
      let formSubmitted = false;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        formSubmitted = true;
      });
      form.innerHTML =
        '<button type="button" id="form-draft">保存草稿</button><button type="submit">发布</button>';
      formFixture.doc.body.appendChild(form);
      const formDraft = formFixture.doc.getElementById('form-draft') as HTMLButtonElement;
      const formDraftSpy = vi.spyOn(formDraft, 'click');
      expect(findDraftSaveButton(formFixture.doc)).toBe(formDraft);
      await smzdmAdapter.injectDraft(formFixture.doc, task, uploader);
      expect(formDraftSpy).toHaveBeenCalledTimes(1);
      expect(formSubmitted).toBe(false);
    });

    it('blocks non-button role elements (<area>, <summary>), formaction/formmethod/formtarget overrides, empty/blank/download anchors, nested outer submit/nav/disabled wrappers, and SVG links', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const suite = fixture.doc.createElement('div');
      suite.className = 'html5-redline-suite';

      // 1. <area role="button">
      suite.innerHTML +=
        '<map name="m"><area href="https://post.smzdm.com/tougao/go" role="button" aria-label="保存草稿"></map>';
      // 2. <summary role="button">
      suite.innerHTML += '<details><summary role="button">保存草稿</summary></details>';
      // 3. formaction / formmethod / formtarget overrides without publish keyword
      suite.innerHTML +=
        '<button type="button" formaction="/tougao/go">保存草稿</button>' +
        '<button type="button" formmethod="post">保存草稿</button>' +
        '<button type="button" formtarget="_blank">保存草稿</button>';
      // 4. Empty href="", target="_blank", download anchors
      suite.innerHTML +=
        '<a href="">保存草稿</a>' +
        '<a href="#draft" target="_blank">保存草稿</a>' +
        '<a href="#draft" download>保存草稿</a>';
      // 7. Disabled enclosing button wrapping <span role="button">
      suite.innerHTML +=
        '<button type="button" disabled><span role="button">保存草稿</span></button>';
      // 9. contenteditable="plaintext-only"
      suite.innerHTML += '<div contenteditable="plaintext-only"><a href="#">保存草稿</a></div>';

      // 5. Programmatically nested <form><button id="outer-sub"><button type="button" id="inner-draft">保存草稿</button></button></form>
      const nestedBtnForm = fixture.doc.createElement('form');
      let nestedBtnSubmitted = false;
      nestedBtnForm.addEventListener('submit', (event) => {
        event.preventDefault();
        nestedBtnSubmitted = true;
      });
      const outerSubBtn = fixture.doc.createElement('button');
      outerSubBtn.id = 'outer-sub';
      const innerDraftBtn = fixture.doc.createElement('button');
      innerDraftBtn.type = 'button';
      innerDraftBtn.id = 'inner-draft';
      innerDraftBtn.textContent = '保存草稿';
      outerSubBtn.appendChild(innerDraftBtn);
      nestedBtnForm.appendChild(outerSubBtn);
      suite.appendChild(nestedBtnForm);

      // 6. Programmatically nested <a href="https://evil.example.com/go"><a href="#">保存草稿</a></a>
      const outerAnchor = fixture.doc.createElement('a');
      outerAnchor.setAttribute('href', 'https://evil.example.com/go');
      const innerAnchor = fixture.doc.createElement('a');
      innerAnchor.setAttribute('href', '#');
      innerAnchor.textContent = '保存草稿';
      outerAnchor.appendChild(innerAnchor);
      suite.appendChild(outerAnchor);

      // 8. SVG namespace <a xlink:href="..." role="button">保存草稿</a>
      const svgEl = fixture.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const svgAnchor = fixture.doc.createElementNS('http://www.w3.org/2000/svg', 'a');
      svgAnchor.setAttribute('xlink:href', 'https://evil.example.com/go');
      svgAnchor.setAttribute('role', 'button');
      svgAnchor.textContent = '保存草稿';
      svgEl.appendChild(svgAnchor);
      suite.appendChild(svgEl);

      fixture.doc.body.appendChild(suite);

      const clickedTargets: Element[] = [];
      suite.addEventListener('click', (event) => {
        if (event.target instanceof Element) {
          clickedTargets.push(event.target);
        }
      });

      expect(findDraftSaveButton(fixture.doc)).toBeNull();
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(clickedTargets).toHaveLength(0);
      expect(nestedBtnSubmitted).toBe(false);
    });

    it('blocks zero-width and whitespace obfuscated CN/EN publish attributes across self, descendants, and inline handlers (B2 regression)', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const trapSuite = fixture.doc.createElement('div');
      trapSuite.className = 'zwsp-trap-suite';

      const createTrapButton = (
        setup: (btn: HTMLButtonElement, doc: Document) => void,
      ): HTMLButtonElement => {
        const btn = fixture.doc.createElement('button');
        btn.type = 'button';
        btn.className = 'trap';
        btn.textContent = '保存草稿';
        setup(btn, fixture.doc);
        return btn;
      };

      const traps: HTMLButtonElement[] = [
        createTrapButton((btn) => {
          btn.setAttribute('data-action', 'pub\u200Blish');
        }),
        createTrapButton((btn) => {
          btn.setAttribute('data-action', 'sub\u200Dmit');
        }),
        createTrapButton((btn) => {
          btn.setAttribute('data-action', 'pub lish');
        }),
        createTrapButton((btn) => {
          btn.setAttribute('aria-label', '立\u200B即发\uFEFF布');
        }),
        createTrapButton((btn) => {
          btn.setAttribute('data-action', '发\u200B布');
        }),
        createTrapButton((btn, doc) => {
          btn.textContent = '';
          const child = doc.createElement('span');
          child.setAttribute('data-action', 'pub\u200Blish');
          child.textContent = '保存草稿';
          btn.appendChild(child);
        }),
        createTrapButton((btn) => {
          btn.setAttribute('onclick', 'pub\u200BlishPost()');
        }),
      ];

      let publishClicks = 0;
      for (const trap of traps) {
        trap.addEventListener('click', () => {
          publishClicks += 1;
        });
        trapSuite.appendChild(trap);
      }
      fixture.doc.body.appendChild(trapSuite);

      expect(findDraftSaveButton(fixture.doc)).toBeNull();
      const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
      expect(DraftInjectReportSchema.parse(report)).toEqual(report);
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(publishClicks).toBe(0);

      // Positive control: legitimate draft-save button with data-action="save-draft" still works
      const legitFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const legitBtn = legitFixture.doc.createElement('button');
      legitBtn.type = 'button';
      legitBtn.setAttribute('data-action', 'save-draft');
      legitBtn.textContent = '保存草稿';
      legitFixture.doc.body.appendChild(legitBtn);

      let legitDraftClicks = 0;
      let legitPublishClicks = 0;
      legitBtn.addEventListener('click', () => {
        legitDraftClicks += 1;
      });
      legitFixture.publishButton?.addEventListener('click', () => {
        legitPublishClicks += 1;
      });

      expect(findDraftSaveButton(legitFixture.doc)).toBe(legitBtn);
      const legitReport = await smzdmAdapter.injectDraft(legitFixture.doc, task, uploader);
      expect(legitReport.ok).toBe(true);
      expect(legitDraftClicks).toBe(1);
      expect(legitPublishClicks).toBe(0);
    });

    it('canonicalizes valid SMZDM public article URLs and strips query/hash/trailing slash', () => {
      const { doc } = createSmzdmPublishedDocument();

      const validCases: Array<[string, string]> = [
        [SMZDM_PUBLISHED_URL, 'https://post.smzdm.com/p/demo123abc'],
        ['https://post.smzdm.com/p/AbC987XyZ/', 'https://post.smzdm.com/p/AbC987XyZ'],
        [SMZDM_PUBLISHED_DIRTY_URL, 'https://post.smzdm.com/p/demo123abc'],
      ];

      for (const [rawUrl, expected] of validCases) {
        const extracted = smzdmAdapter.extractPublishedUrl(new URL(rawUrl), doc);
        expect(extracted).toBe(expected);
        expect(isCanonicalPublishedUrl(extracted ?? '', 'SMZDM_EXT')).toBe(true);
      }
    });

    it('rejects draft, edit, traversal, non-alnum, non-HTTPS, ported, credentialed, private, cross-platform, and deceptive canonical URLs', () => {
      const { doc: publishedDoc } = createSmzdmPublishedDocument();

      const rejectedUrls = [
        SMZDM_EDITOR_URL,
        SMZDM_EDITOR_DRAFT_URL,
        'https://post.smzdm.com/p/demo123abc/edit',
        'https://post.smzdm.com/p/demo123abc/preview',
        'https://post.smzdm.com/p/demo123abc/%252e%252e',
        'https://post.smzdm.com/p/%2e%2e/tougao/',
        'https://post.smzdm.com/p/demo-123',
        'https://post.smzdm.com/p/',
        'http://post.smzdm.com/p/demo123abc',
        'https://post.smzdm.com:8443/p/demo123abc',
        'https://user:pass@post.smzdm.com/p/demo123abc',
        'https://127.0.0.1/p/demo123abc',
        'https://localhost/p/demo123abc',
        'https://www.smzdm.com/p/demo123abc',
        'https://zhuanlan.zhihu.com/p/123456',
        'https://www.toutiao.com/article/7123456',
        'https://post.smzdm.com.evil.example.com/p/demo123abc',
      ];

      for (const rawUrl of rejectedUrls) {
        expect(smzdmAdapter.extractPublishedUrl(new URL(rawUrl), publishedDoc)).toBeNull();
      }

      // Deceptive <link rel="canonical"> on /tougao/ draft page MUST be ignored
      const editorFixture = createSmzdmEditorDocument();
      const fakeCanonical = editorFixture.doc.createElement('link');
      fakeCanonical.setAttribute('rel', 'canonical');
      fakeCanonical.setAttribute('href', SMZDM_PUBLISHED_URL);
      editorFixture.doc.head.appendChild(fakeCanonical);

      const fakeOg = editorFixture.doc.createElement('meta');
      fakeOg.setAttribute('property', 'og:url');
      fakeOg.setAttribute('content', SMZDM_PUBLISHED_URL);
      editorFixture.doc.head.appendChild(fakeOg);

      expect(
        smzdmAdapter.extractPublishedUrl(new URL(SMZDM_EDITOR_URL), editorFixture.doc),
      ).toBeNull();
    });
  });

  describe('10. Tier 5 Hardening Regressions (C2-01, C2-02, C2-05)', () => {
    it('blocks Unicode Cf Bidi override/isolate/ALM/MVS publish traps while preserving clean draft-save control (C2-01)', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      const cfTraps: Array<{ label: string; html: string }> = [
        {
          label: 'RLO U+202E data-action',
          html: '<button type="button" class="trap" data-action="pub\u202Elish">保存草稿</button>',
        },
        {
          label: 'LRI U+2066 CN data-action',
          html: '<button type="button" class="trap" data-action="提\u2066交">保存草稿</button>',
        },
        {
          label: 'RLO U+202E onclick',
          html: '<button type="button" class="trap" onclick="doPub\u202Elish()">保存草稿</button>',
        },
        {
          label: 'ALM U+061C data-testid',
          html: '<button type="button" class="trap" data-testid="sub\u061Cmit-btn">保存草稿</button>',
        },
        {
          label: 'MVS U+180E input',
          html: '<input type="button" class="trap" data-action="pub\u180Elish" value="保存草稿" />',
        },
      ];

      for (const trap of cfTraps) {
        const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
        const box = fixture.doc.createElement('div');
        box.innerHTML = trap.html;
        fixture.doc.body.appendChild(box);
        const target = box.querySelector('.trap')!;
        let publishClicks = 0;
        target.addEventListener('click', () => {
          publishClicks += 1;
        });

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
        expect(report.ok, trap.label).toBe(true);
        expect(publishClicks, `${trap.label} must not be clicked`).toBe(0);
      }

      // Positive control: clean draft-save button still clicks once
      const cleanFixture = createSmzdmEditorDocument();
      let draftClicks = 0;
      cleanFixture.saveDraftButton?.addEventListener('click', () => {
        draftClicks += 1;
      });
      const cleanReport = await smzdmAdapter.injectDraft(cleanFixture.doc, task, uploader);
      expect(cleanReport.ok).toBe(true);
      expect(draftClicks).toBe(1);
    });

    it('rejects all 5 structural interactive-ancestor & form-attribute publish traps while preserving top-level <a href="#">保存草稿</a> (C2-02)', async () => {
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const { uploader } = createMockSmzdmUploader('success');

      const structuralTraps: Array<{ label: string; html: string }> = [
        {
          label: 'details>summary>role-button',
          html: '<details data-action="publish"><summary><span role="button" class="trap">保存草稿</span></summary></details>',
        },
        {
          label: 'outer-role-btn>inner-role-btn',
          html: '<div role="button" class="trap-outer"><span role="button" class="trap">保存草稿</span></div>',
        },
        {
          label: 'anchor>button',
          html: '<a href="#" class="trap-outer"><button type="button" class="trap">保存草稿</button></a>',
        },
        {
          label: 'button[form]',
          html: '<button type="button" form="article-editor-form" class="trap">保存草稿</button>',
        },
        {
          label: 'input[form]',
          html: '<input type="button" form="article-editor-form" class="trap" value="保存草稿" />',
        },
      ];

      for (const trap of structuralTraps) {
        const fixture = createSmzdmEditorDocument({ draftButtonLabel: null });
        const box = fixture.doc.createElement('div');
        box.innerHTML = trap.html;
        fixture.doc.body.appendChild(box);
        let publishClicks = 0;
        for (const el of Array.from(box.querySelectorAll('.trap, .trap-outer'))) {
          el.addEventListener('click', () => {
            publishClicks += 1;
          });
        }

        const report = await smzdmAdapter.injectDraft(fixture.doc, task, uploader);
        expect(report.ok, trap.label).toBe(true);
        expect(publishClicks, `${trap.label} must trigger 0 publish clicks`).toBe(0);
      }

      // Positive control: top-level <a href="#">保存草稿</a> still works
      const anchorFixture = createSmzdmEditorDocument({ draftButtonLabel: null });
      const topAnchor = anchorFixture.doc.createElement('a');
      topAnchor.setAttribute('href', '#');
      topAnchor.textContent = '保存草稿';
      anchorFixture.doc.body.appendChild(topAnchor);
      let topAnchorClicks = 0;
      topAnchor.addEventListener('click', (event) => {
        event.preventDefault();
        topAnchorClicks += 1;
      });

      const anchorReport = await smzdmAdapter.injectDraft(anchorFixture.doc, task, uploader);
      expect(anchorReport.ok).toBe(true);
      expect(topAnchorClicks).toBe(1);
    });

    it('guards task.provider, skips uploadAll on empty mediaAssets, catches uploadAll throws with redaction, and enforces failures.length parity (C2-05)', async () => {
      // 1. Mismatched task.provider rejected without DOM mutation or draft click
      const wrongFixture = createSmzdmEditorDocument();
      let wrongDraftClicks = 0;
      wrongFixture.saveDraftButton?.addEventListener('click', () => {
        wrongDraftClicks += 1;
      });
      const wrongTask = createSmzdmTaskFixture({ provider: 'ZHIHU_EXT' });
      const wrongReport = await smzdmAdapter.injectDraft(
        wrongFixture.doc,
        wrongTask,
        createMockSmzdmUploader('success').uploader,
      );
      expect(wrongReport).toMatchObject({
        ok: false,
        stage: 'EDITOR_NOT_FOUND',
        uploadedImages: 0,
        failedImages: 0,
      });
      expect(wrongDraftClicks).toBe(0);

      // 2. Empty mediaAssets does not invoke uploader.uploadAll
      const emptyFixture = createSmzdmEditorDocument();
      const emptyUploadSpy = vi.fn(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      }));
      const emptyReport = await smzdmAdapter.injectDraft(
        emptyFixture.doc,
        createSmzdmTaskFixture({ mediaAssets: [] }),
        { uploadAll: emptyUploadSpy },
      );
      expect(emptyReport.ok).toBe(true);
      expect(emptyUploadSpy).not.toHaveBeenCalled();

      // 3. Throwing uploader.uploadAll degrades to PARTIAL_MEDIA_FAILED with redacted message, draft click, and operatorReminders
      const throwFixture = createSmzdmEditorDocument();
      let throwDraftClicks = 0;
      throwFixture.saveDraftButton?.addEventListener('click', () => {
        throwDraftClicks += 1;
      });
      const fullTask = createSmzdmTaskFixture();
      const throwReport = await smzdmAdapter.injectDraft(throwFixture.doc, fullTask, {
        uploadAll: vi.fn(async () => {
          throw new Error('smzdm upload crash Bearer gmext_demo_secret_smzdm_9');
        }),
      });
      expect(DraftInjectReportSchema.parse(throwReport)).toEqual(throwReport);
      expect(throwReport.ok).toBe(false);
      expect(throwReport.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(throwReport.failedImages).toBe(fullTask.mediaAssets.length);
      expect(throwReport.operatorReminders).toEqual([...SMZDM_OPERATOR_REMINDERS]);
      expect(throwDraftClicks).toBe(1);
      expect(JSON.stringify(throwReport)).not.toContain('gmext_demo_secret_smzdm_9');
      expect(JSON.stringify(throwReport)).toContain('Bearer [REDACTED]');

      // 4. Mismatched uploader result (failedImages: 0 with non-empty failures[]) still returns PARTIAL_MEDIA_FAILED
      const mismatchFixture = createSmzdmEditorDocument();
      const mismatchReport = await smzdmAdapter.injectDraft(mismatchFixture.doc, fullTask, {
        uploadAll: vi.fn(async () => ({
          uploadedImages: 1,
          failedImages: 0,
          failures: [
            {
              url: 'https://cdn.example.com/smzdm/mismatch.png',
              alt: '失配图',
              reason: '上传失败',
            },
          ],
        })),
      });
      expect(mismatchReport.ok).toBe(false);
      expect(mismatchReport.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(mismatchReport.failedImages).toBe(1);
      expect(mismatchReport.operatorReminders).toEqual([...SMZDM_OPERATOR_REMINDERS]);
    });

    it('supports live Vue + TipTap /edit/<id> DOM and extracts /edit/<id> link from /tougao/ landing page', async () => {
      const landingDoc = document.implementation.createHTMLDocument('SMZDM Tougao');
      landingDoc.body.innerHTML = `
        <div id="global-nav"><a class="user-entry J_user_entry">测试值友</a></div>
        <div class="published-articles">
          <a href="/edit/demo1234" class="release-new">发布新文章</a>
        </div>
      `;
      expect(
        smzdmAdapter.isLoggedInEditor(landingDoc, new URL('https://post.smzdm.com/tougao/')),
      ).toBe(true);
      const task = createSmzdmTaskFixture({ mediaAssets: [] });
      const landingReport = await smzdmAdapter.injectDraft(landingDoc, task, {
        uploadAll: vi.fn(async () => ({ uploadedImages: 0, failedImages: 0, failures: [] })),
      });
      expect(landingReport.ok).toBe(false);
      expect(landingReport.stage).toBe('EDITOR_NOT_FOUND');
      expect(landingReport.draftUrl).toBe('https://post.smzdm.com/edit/demo1234');

      const editDoc = document.implementation.createHTMLDocument('SMZDM Edit');
      editDoc.body.innerHTML = `
        <div class="content-wrapper editor_content">
          <div class="main-content">
            <textarea class="article-title" placeholder="请输入文章标题" rows="2"></textarea>
            <div class="editor__content">
              <div class="ProseMirror z-editor--empty" contenteditable="true" data-placeholder="请输入正文"></div>
            </div>
          </div>
        </div>
        <div class="foot-main">
          <p class="status">草稿将自动保存</p>
          <div class="btn-groups">
            <button type="button" class="el-button cancel-btn btn">预览</button>
            <button type="button" class="el-button publish-btn btn">发布</button>
          </div>
        </div>
      `;
      expect(
        smzdmAdapter.isLoggedInEditor(editDoc, new URL('https://post.smzdm.com/edit/demo1234')),
      ).toBe(true);
      let publishClicked = 0;
      editDoc.querySelector('button.publish-btn')?.addEventListener('click', () => {
        publishClicked += 1;
      });
      const editReport = await smzdmAdapter.injectDraft(editDoc, task, {
        uploadAll: vi.fn(async () => ({ uploadedImages: 0, failedImages: 0, failures: [] })),
      });
      expect(editReport.ok).toBe(true);
      expect(editReport.stage).toBe('INJECTED');
      expect((editDoc.querySelector('textarea.article-title') as HTMLTextAreaElement).value).toBe(
        task.variantTitle,
      );
      expect(
        editDoc.querySelector('.editor__content .ProseMirror')?.textContent?.trim().length,
      ).toBeGreaterThan(0);
      expect(publishClicked).toBe(0);
    });
  });
});
