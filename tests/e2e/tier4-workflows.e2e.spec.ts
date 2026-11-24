import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_HOST_PERMISSIONS,
  EXPECTED_MANIFEST_PERMISSIONS,
  EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  PAIRING_STORAGE_KEY,
  SYNTHETIC_API_BASE_URL,
  SYNTHETIC_BRAND_ALPHA,
  SYNTHETIC_BRAND_BETA,
  SYNTHETIC_CDN_BASE_URL,
  SYNTHETIC_RENEWED_TOKEN,
  SYNTHETIC_SENTINEL_TOKEN,
  SYNTHETIC_TOKEN,
  assertShadowIsolation,
  attachFixtureSpies,
  bootBackgroundServiceWorker,
  bootContentScript,
  createChromeMv3Env,
  createMockBridgeServer,
  createSmzdmEditorFixture,
  createToutiaoEditorFixture,
  createToutiaoLoggedOutFixture,
  createZhihuColumnFixture,
  createZhihuQuestionAnswerFixture,
  findShadowHosts,
  getShadowRootForHost,
  injectHostileCss,
  invokeDispatcher,
  invokeMediaFetcherSingle,
  listFilesRecursive,
  loadBridgeClientModule,
  loadImageUploaderModule,
  loadPlatformAdapter,
  loadPopupApp,
  loadStorageModule,
  loadUrlCaptureBarController,
  loadUrlValidationModule,
  makeSyntheticMe,
  makeSyntheticPairing,
  makeSyntheticPendingTabTask,
  makeSyntheticTask,
  navigateSpa,
  readDistBundle,
  readDistManifest,
  readQaChecklistDoc,
  runPackScript,
  scanSourceFiles,
  setGlobalPageUrl,
  type ChromeMv3Controller,
  type MockBridgeController,
} from './harness/index.js';

let activeChrome: ChromeMv3Controller | null = null;
let activeBridge: MockBridgeController | null = null;

afterEach(() => {
  activeBridge?.restore();
  activeBridge = null;
  activeChrome?.restore();
  activeChrome = null;
  vi.useRealTimers();
});

function setupEnv(opts?: Parameters<typeof createChromeMv3Env>[0]) {
  activeChrome = createChromeMv3Env(opts);
  return activeChrome;
}

function setupBridge(opts?: Parameters<typeof createMockBridgeServer>[0]) {
  activeBridge = createMockBridgeServer(opts);
  return activeBridge;
}

function findPopupInputs(container: HTMLElement): {
  urlInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  submitBtn: HTMLButtonElement;
} {
  const inputs = Array.from(container.querySelectorAll('input'));
  const tokenInput =
    inputs.find(
      (i) =>
        i.type === 'password' ||
        /token|gmext/i.test(`${i.name} ${i.id} ${i.placeholder}`),
    ) ?? inputs[1];
  const urlInput =
    inputs.find(
      (i) =>
        i !== tokenInput &&
        (i.type === 'url' ||
          i.type === 'text' ||
          /url|base|https|地址|域名/i.test(`${i.name} ${i.id} ${i.placeholder}`)),
    ) ?? inputs[0];
  const buttons = Array.from(container.querySelectorAll('button'));
  const submitBtn =
    buttons.find(
      (b) =>
        b.type === 'submit' ||
        /配对|绑定|连接|验证|保存|pair|bind|connect/i.test(b.textContent ?? ''),
    ) ?? buttons[0];

  if (!urlInput || !tokenInput || !submitBtn) {
    throw new Error('Popup pairing inputs not found');
  }
  return { urlInput, tokenInput, submitBtn };
}

describe('Tier 4 — Real-World End-to-End Operator Workflows (S4-01..S4-14)', () => {
  it('S4-01: Full Zhihu Column Article Publish Lifecycle (Golden Path)', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    env.captureConsoleLogs();
    const zhTask = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_s4_zhihu_col',
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`, alt: '图2', mime: 'image/jpeg' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-3.webp`, alt: '图3', mime: 'image/webp' },
      ],
    });
    const bridge = setupBridge({ tasks: [zhTask] });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    // 1. Operator pairs in Popup
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container, unmount: unmountPopup } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);
    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
      expect(container.textContent).toContain(zhTask.variantTitle);
    });
    unmountPopup();

    // 2. Dispatch draft to Zhihu column editor with real adapter + real LocalImageUploader
    const colFix = createZhihuColumnFixture();
    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = colFix.doc.body.innerHTML;
    const liveSpies = attachFixtureSpies(document);
    expect(liveSpies.publishButtonsWatched).toBeGreaterThanOrEqual(2);

    env.setTabAutoBootHandler(async () => {
      await bootContentScript();
    });

    const report = await env.withContext({ kind: 'sw' }, () =>
      invokeDispatcher(zhTask),
    );
    env.setTabAutoBootHandler(null);

    expect(report['ok']).toBe(true);
    expect(report['stage']).toBe('INJECTED');
    expect(report['uploadedImages']).toBe(3);
    expect(report['failedImages']).toBe(0);
    expect(bridge.getMaxObservedMediaConcurrency()).toBeLessThanOrEqual(2);
    expect(liveSpies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(liveSpies.publishButtonLabelsClicked).toEqual([]);

    // 3. Operator reviews & manually publishes -> SPA navigates to tracking-parameterized URL
    const tabId = Array.from(env.tabs.keys())[0]!;
    env.setContext({
      kind: 'content',
      tabId,
      url: 'https://zhuanlan.zhihu.com/p/123456?utm_source=x#top',
    });
    navigateSpa('/p/123456?utm_source=x#top', 'pushState');
    env.updateTabUrl(tabId, 'https://zhuanlan.zhihu.com/p/123456?utm_source=x#top', 'complete');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });
    const host = findShadowHosts(document)[0]!;
    const iso = assertShadowIsolation(document, host, 'https://zhuanlan.zhihu.com/p/123456');
    expect(iso.hasHostReset).toBe(true);
    expect(iso.lightDomContainsShadowText).toBe(false);
    expect(iso.shadowRoot.textContent).toContain(zhTask.variantTitle);

    // 4. Operator clicks confirm CTA -> Bridge records PUBLISHED & session binding cleared
    const cta = Array.from(iso.shadowRoot.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(cta);

    await waitFor(async () => {
      expect(bridge.publishRecords.length).toBe(1);
      expect(bridge.publishRecords[0]?.publishedUrl).toBe(
        'https://zhuanlan.zhihu.com/p/123456',
      );
      expect(bridge.publishRecords[0]?.retestMilestones).toEqual([7, 14, 30]);
      expect(iso.shadowRoot.textContent).toMatch(/T\+1|7.*14.*30|追踪已开启|已回传/);
      const storage = await loadStorageModule();
      expect(await storage.getTabTask(tabId)).toBeFalsy();
    });

    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
  });

  it('S4-02: Full Zhihu High-Citation Question Answer Workflow (targetUrlHint)', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const qaTask = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_s4_zhihu_qa',
      targetUrlHint: 'https://www.zhihu.com/question/88001122',
    });

    const qaFix = createZhihuQuestionAnswerFixture('88001122');
    setGlobalPageUrl('https://www.zhihu.com/question/88001122');
    document.body.innerHTML = qaFix.doc.body.innerHTML;
    const liveSpies = attachFixtureSpies(document);
    expect(liveSpies.publishButtonsWatched).toBeGreaterThanOrEqual(1);

    env.setTabAutoBootHandler(async () => {
      await bootContentScript();
    });

    const report = await env.withContext({ kind: 'sw' }, () =>
      invokeDispatcher(qaTask),
    );
    env.setTabAutoBootHandler(null);

    expect(env.chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.zhihu.com/question/88001122' }),
    );
    expect(report['ok']).toBe(true);
    expect(report['stage']).toBe('INJECTED');
    expect(liveSpies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(liveSpies.publishButtonLabelsClicked).toEqual([]);

    const tabId = Array.from(env.tabs.keys())[0]!;
    const pubRaw =
      'https://www.zhihu.com/question/88001122/answer/99001122?utm_campaign=geo#answer';
    env.setContext({ kind: 'content', tabId, url: pubRaw });
    navigateSpa('/question/88001122/answer/99001122?utm_campaign=geo#answer', 'pushState');
    env.updateTabUrl(tabId, pubRaw, 'complete');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });
    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    expect(sr.textContent).toContain(
      'https://www.zhihu.com/question/88001122/answer/99001122',
    );
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(cta);

    await waitFor(async () => {
      expect(bridge.publishRecords.length).toBe(1);
      expect(bridge.publishRecords[0]?.publishedUrl).toBe(
        'https://www.zhihu.com/question/88001122/answer/99001122',
      );
      expect(await storage.getTabTask(tabId)).toBeFalsy();
    });
  });

  it('S4-03: Full Toutiao Graphic Article Workflow (/i... & /article/... Capture)', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const ttTask = makeSyntheticTask('TOUTIAO_EXT', {
      taskId: 'task_s4_toutiao',
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`, alt: '图2', mime: 'image/jpeg' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-3.webp`, alt: '图3', mime: 'image/webp' },
      ],
    });

    const ttFix = createToutiaoEditorFixture();
    const tab = await env.chrome.tabs.create({ url: ttFix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const { createUploader } = await loadImageUploaderModule();
    const report = await adapter.injectDraft(ttFix.doc, ttTask, createUploader());
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');
    expect(report.uploadedImages).toBe(3);
    expect(ttFix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);

    // Verify both /i<digits> and /article/<digits> canonicalization + callback
    const urlI = adapter.extractPublishedUrl(
      new URL('https://www.toutiao.com/i73500998877/?tt_from=copy_link#top'),
      ttFix.doc,
    );
    expect(urlI).toBe('https://www.toutiao.com/i73500998877');

    const urlArticle = adapter.extractPublishedUrl(
      new URL('https://www.toutiao.com/article/73500998877/?log_from=xyz'),
      ttFix.doc,
    );
    expect(urlArticle).toBe('https://www.toutiao.com/article/73500998877');

    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    const ctrl = await loadUrlCaptureBarController();
    const handle = ctrl.mountPublishedBar({
      publishedUrl: urlI!,
      task: makeSyntheticPendingTabTask(tab.id!, ttTask),
      onConfirm: (u) => client.confirmPublished(ttTask.taskId, { publishedUrl: u }),
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(cta);

    await waitFor(() => {
      expect(bridge.publishRecords[0]?.publishedUrl).toBe(
        'https://www.toutiao.com/i73500998877',
      );
    });
    handle.unmount();
  });

  it('S4-04: Full SMZDM Review Workflow (<table> Preservation + Reminders + Alphanumeric /p/ Capture)', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const smTask = makeSyntheticTask('SMZDM_EXT', { taskId: 'task_s4_smzdm' });
    const smFix = createSmzdmEditorFixture();
    const tab = await env.chrome.tabs.create({ url: smFix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const { createUploader } = await loadImageUploaderModule();
    const report = await adapter.injectDraft(smFix.doc, smTask, createUploader());

    expect(report.ok).toBe(true);
    expect(report.uploadedImages).toBe(2);
    expect(smFix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect((report.operatorReminders ?? []).join(' ')).toContain('商品卡片');
    expect((report.operatorReminders ?? []).join(' ')).toMatch(/披露|合规/);

    const editorHtml = `${smFix.doc.querySelector('[contenteditable="true"]')?.innerHTML ?? ''}\n${smFix.spies.pastedHtml.join('\n')}`;
    expect(editorHtml).toContain('<table');
    expect(editorHtml).toContain('<td>12小时</td>');

    const cleaned = adapter.extractPublishedUrl(
      new URL('https://post.smzdm.com/p/k9Xm2Qp7/?from=app#reviews'),
      smFix.doc,
    );
    expect(cleaned).toBe('https://post.smzdm.com/p/k9Xm2Qp7');

    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    const res = await client.confirmPublished(smTask.taskId, {
      publishedUrl: cleaned!,
    });
    expect(res.status).toBe('PUBLISHED');
    expect(bridge.publishRecords.length).toBe(1);
  });

  it('S4-05: Multi-Brand Operator Switching Brands & Platforms Across Concurrent Tabs', async () => {
    const env = setupEnv({
      initialTabs: [
        { id: 101, url: 'https://zhuanlan.zhihu.com/write', active: false, status: 'complete' },
        { id: 102, url: 'https://mp.toutiao.com/profile_v4/graphic/publish', active: false, status: 'complete' },
        { id: 103, url: 'https://post.smzdm.com/tougao/', active: false, status: 'complete' },
      ],
    });
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const taskAZh = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task-a-zh',
      brandId: SYNTHETIC_BRAND_ALPHA.brandId,
      brandName: SYNTHETIC_BRAND_ALPHA.brandName,
      variantTitle: 'BrandA 知乎文章',
    });
    const taskBTt = makeSyntheticTask('TOUTIAO_EXT', {
      taskId: 'task-b-tt',
      brandId: SYNTHETIC_BRAND_BETA.brandId,
      brandName: SYNTHETIC_BRAND_BETA.brandName,
      variantTitle: 'BrandB 头条文章',
    });
    const taskASm = makeSyntheticTask('SMZDM_EXT', {
      taskId: 'task-a-sm',
      brandId: SYNTHETIC_BRAND_ALPHA.brandId,
      brandName: SYNTHETIC_BRAND_ALPHA.brandName,
      variantTitle: 'BrandA 值得买文章',
    });

    await storage.setTabTask(101, makeSyntheticPendingTabTask(101, taskAZh));
    await storage.setTabTask(102, makeSyntheticPendingTabTask(102, taskBTt));
    await storage.setTabTask(103, makeSyntheticPendingTabTask(103, taskASm));

    expect((await storage.getTabTask(101))?.taskId).toBe('task-a-zh');
    expect((await storage.getTabTask(102))?.taskId).toBe('task-b-tt');
    expect((await storage.getTabTask(103))?.taskId).toBe('task-a-sm');

    // Publish Tab 102 first -> confirm -> Tab 102 unbound while 101 and 103 stay bound
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    await client.confirmPublished('task-b-tt', {
      publishedUrl: 'https://www.toutiao.com/i7111222333',
    });
    await storage.removeTabTask(102);

    expect(await storage.getTabTask(102)).toBeFalsy();
    expect((await storage.getTabTask(101))?.taskId).toBe('task-a-zh');
    expect((await storage.getTabTask(103))?.taskId).toBe('task-a-sm');

    // Publish remaining 101 and 103
    await client.confirmPublished('task-a-zh', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/551122',
    });
    await client.confirmPublished('task-a-sm', {
      publishedUrl: 'https://post.smzdm.com/p/Xy98Zt76',
    });
    expect(bridge.publishRecords.map((r) => r.taskId)).toEqual([
      'task-b-tt',
      'task-a-zh',
      'task-a-sm',
    ]);
  });

  it('S4-06: Service Worker Hibernation Mid-Session (10-Minute Operator Review Delay)', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const zhTask = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_s4_hibernate',
      variantTitle: '10分钟审稿后发布的专栏文章',
    });
    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, zhTask));
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    // Simulate MV3 SW idle kill & cold boot after 10 min
    await env.simulateServiceWorkerRestart(() => bootBackgroundServiceWorker());

    env.setContext({
      kind: 'content',
      tabId: tab.id!,
      url: 'https://zhuanlan.zhihu.com/p/778899',
    });
    navigateSpa('/p/778899', 'pushState');
    env.updateTabUrl(tab.id!, 'https://zhuanlan.zhihu.com/p/778899', 'complete');

    const getCta = () => {
      const host = findShadowHosts(document)[0];
      const root = host ? getShadowRootForHost(host) : null;
      return root
        ? Array.from(root.querySelectorAll('button')).find((b) =>
            /一键回传至 GeoMix/.test(b.textContent ?? ''),
          )
        : undefined;
    };

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
      expect(getCta()).toBeTruthy();
    });
    fireEvent.click(getCta()!);

    await waitFor(async () => {
      expect(bridge.publishRecords.length).toBe(1);
      expect(bridge.publishRecords[0]?.taskId).toBe('task_s4_hibernate');
      expect(bridge.publishRecords[0]?.publishedUrl).toBe(
        'https://zhuanlan.zhihu.com/p/778899',
      );
      const freshStorage = await loadStorageModule();
      expect(await freshStorage.getTabTask(tab.id!)).toBeFalsy();
    });
  });

  it('S4-07: Partial Media Relay Failure & Manual-Upload Recovery Workflow', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const ttTask = makeSyntheticTask('TOUTIAO_EXT', {
      taskId: 'task_s4_partial',
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '正常配图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-header.png`, alt: '12MB大图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`, alt: '失效404图', mime: 'image/png' },
      ],
    });

    const ttFix = createToutiaoEditorFixture();
    const tab = await env.chrome.tabs.create({ url: ttFix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const { createUploader } = await loadImageUploaderModule();
    const report = await adapter.injectDraft(ttFix.doc, ttTask, createUploader());

    expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(report.uploadedImages).toBe(1);
    expect(report.failedImages).toBe(2);
    expect(report.failedImageDetails?.length).toBe(2);
    expect(ttFix.doc.querySelector('.ProseMirror')?.innerHTML ?? '').not.toContain(
      'oversize-header.png',
    );
    expect(ttFix.doc.querySelector('.ProseMirror')?.innerHTML ?? '').not.toContain(
      'missing-404.png',
    );

    const ctrl = await loadUrlCaptureBarController();
    const notice = ctrl.mountPartialMediaNotice({
      failedImages: report.failedImageDetails!,
      taskTitle: ttTask.variantTitle,
    });
    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    expect(sr.textContent).toContain('12MB大图');
    expect(sr.textContent).toContain('失效404图');
    notice.unmount();

    // Operator uploads manually and publishes -> URL callback succeeds
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    const res = await client.confirmPublished(ttTask.taskId, {
      publishedUrl: 'https://www.toutiao.com/article/7350011223344',
    });
    expect(res.status).toBe('PUBLISHED');
    expect(bridge.publishRecords.length).toBe(1);
  });

  it('S4-08: Mid-Workflow Token Revocation (401) -> Re-Pair -> Resume & Confirm', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    env.captureConsoleLogs();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const zhTask = makeSyntheticTask('ZHIHU_EXT', { taskId: 'task_s4_revoke' });
    setGlobalPageUrl('https://zhuanlan.zhihu.com/p/667788');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/p/667788' });
    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, zhTask));
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    env.setContext({
      kind: 'content',
      tabId: tab.id!,
      url: 'https://zhuanlan.zhihu.com/p/667788',
    });

    // Revoke old token before operator clicks confirm
    bridge.revokeToken(SYNTHETIC_TOKEN);
    env.updateTabUrl(tab.id!, 'https://zhuanlan.zhihu.com/p/667788', 'complete');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });
    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const getCta = () =>
      Array.from(sr.querySelectorAll('button')).find((b) =>
        /一键回传|重试|回传/.test(b.textContent ?? ''),
      )!;
    fireEvent.click(getCta());

    await waitFor(() => {
      expect(sr.textContent).toMatch(/401|失效|过期|失败|重新/);
    });
    expect(bridge.publishRecords.length).toBe(0);

    // Operator re-pairs with fresh token
    bridge.addValidToken(SYNTHETIC_RENEWED_TOKEN, makeSyntheticMe());
    await storage.savePairing(makeSyntheticPairing({ token: SYNTHETIC_RENEWED_TOKEN }));

    // Retry confirm -> succeeds with new Bearer token
    fireEvent.click(getCta());
    await waitFor(() => {
      expect(bridge.publishRecords.length).toBe(1);
    });
    const lastConfirm = bridge.bridgeRequests[bridge.bridgeRequests.length - 1];
    expect(lastConfirm?.headers['authorization']).toBe(
      `Bearer ${SYNTHETIC_RENEWED_TOKEN}`,
    );
    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
    env.assertZeroTokenLeakage(SYNTHETIC_RENEWED_TOKEN);
  });

  it('S4-09: Logged-Out Platform Editor Recovery (AUTH_REQUIRED -> Manual Login -> Retry)', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const { createUploader } = await loadImageUploaderModule();

    // Attempt 1 on logged-out page
    const loggedOut = createToutiaoLoggedOutFixture();
    const tab = await env.chrome.tabs.create({ url: loggedOut.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const firstReport = await adapter.injectDraft(
      loggedOut.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createUploader(),
    );
    expect(firstReport.ok).toBe(false);
    expect(firstReport.stage).toBe('AUTH_REQUIRED');

    // Operator logs in manually -> editor now present -> Retry succeeds
    const loggedIn = createToutiaoEditorFixture();
    const retryReport = await adapter.injectDraft(
      loggedIn.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createUploader(),
    );
    expect(retryReport.ok).toBe(true);
    expect(retryReport.stage).toBe('INJECTED');
    expect(retryReport.uploadedImages).toBe(2);
    expect(loggedIn.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
  });

  it('S4-10: Adversarial Input, Hostile Page CSS & Security Redline Defense Gauntlet', async () => {
    const env = setupEnv();
    env.captureConsoleLogs();
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const v = await loadUrlValidationModule();
    // 1. Pairing rejects SSRF URL
    expect(v.validateApiBaseUrl('https://127.0.0.1')).toBeNull();
    // 2. Media fetcher blocks cloud metadata IP without calling fetch
    const ssrfMedia = await invokeMediaFetcherSingle({
      url: 'https://169.254.169.254/img.png',
      alt: 'ssrf',
    });
    expect(ssrfMedia.ok).toBe(false);
    expect(bridge.forbiddenFetchAttempts.length).toBe(0);

    // 3. Hostile CSS injected on host page + decoy publish buttons
    injectHostileCss(document);
    const decoyBtn = document.createElement('button');
    decoyBtn.textContent = '发布';
    const decoySpy = vi.fn();
    decoyBtn.addEventListener('click', decoySpy);
    document.body.appendChild(decoyBtn);

    // 4. Edit URL never mounts capture bar
    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN }));
    await storage.setTabTask(
      tab.id!,
      makeSyntheticPendingTabTask(tab.id!, makeSyntheticTask('ZHIHU_EXT')),
    );
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    env.setContext({
      kind: 'content',
      tabId: tab.id!,
      url: 'https://zhuanlan.zhihu.com/write',
    });

    navigateSpa('/p/123/edit', 'pushState');
    await new Promise((r) => setTimeout(r, 40));
    expect(findShadowHosts(document).length).toBe(0);

    // 5. Valid published URL mounts isolated Shadow DOM bar with :host { all: initial }
    env.setContext({
      kind: 'content',
      tabId: tab.id!,
      url: 'https://zhuanlan.zhihu.com/p/123456',
    });
    navigateSpa('/p/123456', 'pushState');
    env.updateTabUrl(tab.id!, 'https://zhuanlan.zhihu.com/p/123456', 'complete');
    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });
    const iso = assertShadowIsolation(
      document,
      findShadowHosts(document)[0]!,
      'https://zhuanlan.zhihu.com/p/123456',
    );
    expect(iso.hasHostReset).toBe(true);
    expect(iso.lightDomContainsShadowText).toBe(false);
    expect(decoySpy).toHaveBeenCalledTimes(0);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('S4-11: Duplicate Click & Flaky Network Retry Idempotency Scenario', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const task = makeSyntheticTask('ZHIHU_EXT', { taskId: 'task_s4_idemp' });
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    bridge.queueFault('confirm-published', {
      kind: 'network-error',
      message: 'Failed to fetch',
    });

    const ctrl = await loadUrlCaptureBarController();
    ctrl.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/334455',
      task: makeSyntheticPendingTabTask(100, task),
      onConfirm: (url) => client.confirmPublished(task.taskId, { publishedUrl: url }),
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const getCta = () =>
      Array.from(sr.querySelectorAll('button')).find((b) =>
        /一键回传|重试|回传/.test(b.textContent ?? ''),
      )!;

    // Rapid double click during first failing request -> strictly 1 attempt
    fireEvent.click(getCta());
    fireEvent.click(getCta());

    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBe(1);
      expect(sr.textContent).toMatch(/失败|重试|网络/);
    });

    // Retry -> succeeds with identical Idempotency-Key & single publishRecordId
    fireEvent.click(getCta());
    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBe(2);
      expect(bridge.publishRecords.length).toBe(1);
    });
    expect(bridge.bridgeRequests[0]!.headers['idempotency-key']).toBe(
      bridge.bridgeRequests[1]!.headers['idempotency-key'],
    );
  });

  it('S4-12: Release Build & Chrome Web Store Audit Scenario', () => {
    const dist = readDistManifest();
    expect(dist.manifest_version).toBe(3);
    expect([...(dist.permissions ?? [])].sort()).toEqual([
      ...EXPECTED_MANIFEST_PERMISSIONS,
    ]);
    expect([...(dist.host_permissions ?? [])].sort()).toEqual([
      ...EXPECTED_HOST_PERMISSIONS,
    ]);
    expect(dist.optional_host_permissions).toEqual([
      ...EXPECTED_OPTIONAL_HOST_PERMISSIONS,
    ]);

    expect(listFilesRecursive('dist').filter((f) => f.endsWith('.map'))).toEqual([]);
    const contentJs = readDistBundle('content.js');
    expect(/^\s*import\s+[\s\S]*?\sfrom\s+['"]/m.test(contentJs)).toBe(false);
    expect(readDistBundle('background.js').length).toBeGreaterThan(0);

    const pack = runPackScript();
    expect(pack.exitCode).toBe(0);
    expect(pack.entries.some((e) => e.name === 'manifest.json')).toBe(true);
    expect(pack.entries.some((e) => /\.map$|\.(spec|test)\./.test(e.name))).toBe(false);

    const qaDoc = readQaChecklistDoc();
    expect(qaDoc).toContain('知乎');
    expect(qaDoc).toContain('今日头条');
    expect(qaDoc).toContain('什么值得买');
    expect(qaDoc).toMatch(/Cookie|cookie/);
    expect(qaDoc).toMatch(/手动发布|不自动发布|严禁自动/);

    const srcFiles = scanSourceFiles('src');
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const f of srcFiles) {
      expect(f.content).not.toMatch(/document\s*\.\s*cookie/);
    }
    expect(contentJs).not.toMatch(/document\s*\.\s*cookie/);
  });

  it('S4-13: Abandoned Draft & Tab-Close Cleanup Prevents Phantom Capture Bar', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const tab1 = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await storage.setTabTask(
      tab1.id!,
      makeSyntheticPendingTabTask(tab1.id!, makeSyntheticTask('ZHIHU_EXT')),
    );
    expect((await storage.getTabTask(tab1.id!))?.taskId).toBeTruthy();

    // Operator abandons draft and closes tab1
    env.removeTab(tab1.id!);
    await waitFor(async () => {
      expect(await storage.getTabTask(tab1.id!)).toBeFalsy();
    });

    // Operator opens an unrelated public Zhihu article in tab2 -> zero capture bar
    setGlobalPageUrl('https://zhuanlan.zhihu.com/p/999888');
    const tab2 = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/p/999888',
    });
    await env.withContext(
      { kind: 'content', tabId: tab2.id!, url: tab2.url },
      () => bootContentScript(),
    );
    env.setContext({ kind: 'content', tabId: tab2.id!, url: tab2.url });
    env.updateTabUrl(tab2.id!, 'https://zhuanlan.zhihu.com/p/999888', 'complete');
    await new Promise((r) => setTimeout(r, 40));

    expect(findShadowHosts(document).length).toBe(0);
    expect(bridge.publishRecords.length).toBe(0);
  });

  it('S4-14: Hostile targetUrlHint Fallback & Malformed Bridge Response Resilience', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    // 1. Hostile targetUrlHint safely falls back to /write
    env.chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) {
        env.attachTabContentListener(tab.id, (msg, _s, sendResponse) => {
          const m = msg as { type?: string };
          if (m?.type && /PING|READY/i.test(m.type)) {
            sendResponse({
              ok: true,
              ready: true,
              data: { ready: true, href: tab.url ?? 'https://zhuanlan.zhihu.com/write' },
            });
            return;
          }
          const report = {
            ok: true,
            stage: 'INJECTED' as const,
            uploadedImages: 0,
            failedImages: 0,
            message: 'ok',
          };
          sendResponse({ ...report, ok: true, data: report });
        });
      }
    });

    await invokeDispatcher(
      makeSyntheticTask('ZHIHU_EXT', {
        targetUrlHint: 'https://127.0.0.1/question/1',
        mediaAssets: [],
      }),
    );
    expect(env.chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://zhuanlan.zhihu.com/write' }),
    );

    // 2. Malformed Bridge responses handled gracefully in Popup while preserving pairing session
    bridge.queueFault('tasks', {
      kind: 'http',
      status: 200,
      body: { code: 50001, msg: 'upstream error', data: null },
    });
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
      expect(container.textContent).toMatch(/失败|错误|upstream error|重试|刷新/i);
    });
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(true);
  });
});
