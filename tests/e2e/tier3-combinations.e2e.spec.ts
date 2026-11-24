import fs from 'node:fs';
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
  TAB_TASKS_STORAGE_KEY,
  PublicSurfaceError,
  assertShadowIsolation,
  bootBackgroundServiceWorker,
  bootContentScript,
  createChromeMv3Env,
  createMockBridgeServer,
  createSimpleMockUploader,
  createSmzdmEditorFixture,
  createSmzdmLoggedOutFixture,
  createToutiaoEditorFixture,
  createToutiaoLoggedOutFixture,
  createZhihuColumnFixture,
  createZhihuLoggedOutFixture,
  createZhihuQuestionAnswerFixture,
  findShadowHosts,
  getCapturedShadowRoots,
  getShadowRootForHost,
  invokeDispatcher,
  invokeMediaFetcherBatch,
  invokeMediaFetcherSingle,
  listFilesRecursive,
  loadBridgeClientModule,
  loadImageUploaderModule,
  loadManifestConfig,
  loadMediaFetcherModule,
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
  resolveRepoPath,
  runPackScript,
  scanSourceFiles,
  sendInjectDraftToTab,
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

// ============================================================================
// Cluster A: Pairing + Optional Host Permissions + /me + Storage Local + Unbind
// ============================================================================

describe('Tier 3 — Cluster A: Pairing, Permissions, /me, Storage & Unbind', () => {
  it('T3-01: pairing happy path across Permission Gate -> Bridge /me -> chrome.storage.local -> Popup Summary', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    env.captureConsoleLogs();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    let permissionRequestedBeforeFetch = false;
    env.setPermissionPolicy((req) => {
      permissionRequestedBeforeFetch = bridge.bridgeRequests.length === 0;
      return (req.origins ?? []).includes(`${SYNTHETIC_API_BASE_URL}/*`);
    });

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_SENTINEL_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
    });

    expect(permissionRequestedBeforeFetch).toBe(true);
    const meReq = bridge.bridgeRequests.find((r) =>
      r.url.endsWith('/api/v2/extension/me'),
    );
    expect(meReq?.headers['authorization']).toBe(
      `Bearer ${SYNTHETIC_SENTINEL_TOKEN}`,
    );
    expect(meReq?.headers['x-geomix-extension-version']).toBeTruthy();
    expect(meReq?.headers['accept']).toContain('application/json');

    const stored = env.localStore.get(PAIRING_STORAGE_KEY) as
      | { baseUrl: string; token: string; me: { nickname: string } }
      | undefined;
    expect(stored?.baseUrl).toBe(SYNTHETIC_API_BASE_URL);
    expect(stored?.token).toBe(SYNTHETIC_SENTINEL_TOKEN);
    expect(stored?.me.nickname).toBe('DemoOperator');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(container.textContent).toContain('Demo Extension Key');
    expect(container.textContent).toContain('gmext_demo_');
    expect(container.textContent).not.toContain(SYNTHETIC_SENTINEL_TOKEN);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('T3-02: optional host permission denial aborts pairing before network call or storage write', async () => {
    const env = setupEnv({ permissionPolicy: 'deny' });
    const bridge = setupBridge();
    env.captureConsoleLogs();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_SENTINEL_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toMatch(/权限|拒绝|授权|permission/i);
    });
    expect(bridge.requests.length).toBe(0);
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('T3-03: one-click unbind immediately wipes chrome.storage.local, resets Popup queue & blocks subsequent SW calls', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });

    // Capture the real task-fetch wire message BEFORE unbinding
    const callsBeforeRefresh = env.runtimeMessages.length;
    const bridgeBeforeRefresh = bridge.bridgeRequests.length;
    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /刷新|refresh/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(callsBeforeRefresh);
      expect(bridge.bridgeRequests.length).toBeGreaterThan(bridgeBeforeRefresh);
    });
    const realFetchTasksMsg = env.runtimeMessages[callsBeforeRefresh]!.payload;

    // Click real Unbind button (matches '解除绑定' as well as '解绑'/'注销'/...)
    const unbindBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /解除绑定|解绑|解除配对|注销|退出|断开|unbind/i.test(b.textContent ?? ''),
    );
    expect(unbindBtn).toBeTruthy();
    fireEvent.click(unbindBtn!);

    await waitFor(async () => {
      expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
      expect(await storage.getPairing()).toBeFalsy();
      expect(container.textContent).not.toContain('示例品牌A 深度实测报告');
      expect(() => findPopupInputs(container)).not.toThrow();
    });

    // Replaying the REAL task-fetch message after unbind must fail as NOT_PAIRED with 0 new Bridge calls
    const beforeCount = bridge.bridgeRequests.length;
    const postUnbindResp = await env.sendFromPopup(realFetchTasksMsg);
    expect(bridge.bridgeRequests.length).toBe(beforeCount);
    expect(postUnbindResp).toBeTruthy();
    expect((postUnbindResp as { ok?: unknown }).ok).toBe(false);
    const serialized = JSON.stringify(postUnbindResp);
    expect(serialized).toMatch(/NOT_PAIRED|UNPAIRED|reauthRequired|未配对|尚未配对/i);
    expect(serialized).not.toMatch(/INVALID_REQUEST/i);
    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
  });
});

// ============================================================================
// Cluster B: Task Queue Filtering + Dispatch + Tab Reuse + Session Persistence
// ============================================================================

describe('Tier 3 — Cluster B: Task Filtering, Dispatch, Tab Reuse & Session Persistence', () => {
  it('T3-04: Brand + Platform dual filtering synchronizes tasks and renders complianceChecklist[]', async () => {
    const env = setupEnv();
    setupBridge({
      tasks: [
        makeSyntheticTask('ZHIHU_EXT', {
          taskId: 't_alpha_zh',
          brandId: SYNTHETIC_BRAND_ALPHA.brandId,
          brandName: SYNTHETIC_BRAND_ALPHA.brandName,
          variantTitle: 'Alpha-知乎任务',
        }),
        makeSyntheticTask('SMZDM_EXT', {
          taskId: 't_alpha_sm',
          brandId: SYNTHETIC_BRAND_ALPHA.brandId,
          brandName: SYNTHETIC_BRAND_ALPHA.brandName,
          variantTitle: 'Alpha-值得买任务',
          complianceChecklist: ['核对商品卡片链接', '确认合规披露声明'],
        }),
        makeSyntheticTask('SMZDM_EXT', {
          taskId: 't_beta_sm',
          brandId: SYNTHETIC_BRAND_BETA.brandId,
          brandName: SYNTHETIC_BRAND_BETA.brandName,
          variantTitle: 'Beta-值得买任务',
        }),
        makeSyntheticTask('TOUTIAO_EXT', {
          taskId: 't_beta_tt',
          brandId: SYNTHETIC_BRAND_BETA.brandId,
          brandName: SYNTHETIC_BRAND_BETA.brandName,
          variantTitle: 'Beta-头条任务',
        }),
      ],
    });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('Alpha-值得买任务');
    });

    const selects = Array.from(container.querySelectorAll('select'));
    const brandSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === SYNTHETIC_BRAND_ALPHA.brandId),
    )!;
    const platformSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'SMZDM_EXT'),
    )!;

    fireEvent.change(brandSelect, {
      target: { value: SYNTHETIC_BRAND_ALPHA.brandId },
    });
    fireEvent.change(platformSelect, { target: { value: 'SMZDM_EXT' } });

    await waitFor(() => {
      const txt = container.textContent ?? '';
      expect(txt).toContain('Alpha-值得买任务');
      expect(txt).toContain('核对商品卡片链接');
      expect(txt).not.toContain('Alpha-知乎任务');
      expect(txt).not.toContain('Beta-值得买任务');
      expect(txt).not.toContain('Beta-头条任务');
    });
  });

  it('T3-05: dispatch opens target editor tab, persists geomix.tabTasks.v1, handshakes Content Script & reports to Popup', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

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
            uploadedImages: 2,
            failedImages: 0,
            message: '草稿已写入，请审阅后手动发布',
          };
          sendResponse({ ...report, ok: true, data: report });
        });
      }
    });

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });

    const pushBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /写入草稿箱/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(pushBtn);

    await waitFor(() => {
      expect(container.textContent).toMatch(/草稿已写入|INJECTED|已写入/);
    });
    expect(env.chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://zhuanlan.zhihu.com/write' }),
    );
    const sessionMap = env.sessionStore.get(TAB_TASKS_STORAGE_KEY) as Record<
      string,
      { lastInjectReport?: { stage: string }; injectedAt?: string }
    >;
    const entries = Object.values(sessionMap ?? {});
    expect(entries.length).toBe(1);
    expect(entries[0]?.lastInjectReport?.stage).toBe('INJECTED');
    expect(entries[0]?.injectedAt).toBeTruthy();
  });

  it('T3-06: idle and same-task tab reuse updates existing platform tab without contaminating sibling tabs; tabs.onRemoved cleans up only closed tab', async () => {
    const env = setupEnv({
      initialTabs: [
        { id: 10, url: 'https://zhuanlan.zhihu.com/write', active: false, status: 'complete' },
        { id: 20, url: 'https://mp.toutiao.com/profile_v4/graphic/publish', active: false, status: 'complete' },
      ],
    });
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const storage = await loadStorageModule();
    const taskZ1 = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_z1',
      variantTitle: '知乎草稿Z1',
      mediaAssets: [],
    });
    const taskZ1Updated = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_z1',
      variantTitle: '知乎草稿Z1-更新版',
      mediaAssets: [],
    });
    const taskT1 = makeSyntheticTask('TOUTIAO_EXT', {
      taskId: 'task_t1',
      mediaAssets: [],
    });

    // Leave Tab 10 idle/unbound while sibling Tab 20 is actively bound to task_t1
    await storage.setTabTask(20, makeSyntheticPendingTabTask(20, taskT1));

    env.attachTabContentListener(10, (msg, _s, sendResponse) => {
      const m = msg as { type?: string };
      if (m?.type && /PING|READY/i.test(m.type)) {
        sendResponse({
          ok: true,
          ready: true,
          data: { ready: true, href: 'https://zhuanlan.zhihu.com/write' },
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

    // 1. Idle-tab reuse: Tab 10 is reused without creating a new tab or contaminating Tab 20
    const firstOutcome = await env.withContext({ kind: 'sw' }, () =>
      invokeDispatcher(taskZ1),
    );
    expect(firstOutcome['ok']).toBe(true);
    expect(firstOutcome['stage']).toBe('INJECTED');
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
    expect((await storage.getTabTask(10))?.taskId).toBe('task_z1');
    expect((await storage.getTabTask(10))?.variantTitle).toBe('知乎草稿Z1');
    expect((await storage.getTabTask(20))?.taskId).toBe('task_t1');

    // 2. Same-task re-dispatch reuse: Tab 10 is still reused & updated without contaminating Tab 20
    const secondOutcome = await env.withContext({ kind: 'sw' }, () =>
      invokeDispatcher(taskZ1Updated),
    );
    expect(secondOutcome['ok']).toBe(true);
    expect(secondOutcome['stage']).toBe('INJECTED');
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
    expect((await storage.getTabTask(10))?.taskId).toBe('task_z1');
    expect((await storage.getTabTask(10))?.variantTitle).toBe('知乎草稿Z1-更新版');
    expect((await storage.getTabTask(20))?.taskId).toBe('task_t1');

    // 3. Closing Tab 10 cleans up ONLY Tab 10 while sibling Tab 20 retains task_t1
    env.removeTab(10);
    await waitFor(async () => {
      expect(await storage.getTabTask(10)).toBeFalsy();
      expect((await storage.getTabTask(20))?.taskId).toBe('task_t1');
    });
  });
});

// ============================================================================
// Cluster C: SW Hibernation + Session Recovery + Capture + Idempotent Callback
// ============================================================================

describe('Tier 3 — Cluster C: SW Hibernation, SPA Deduplication & Idempotent Callback', () => {
  it('T3-07: cold SW restart mid-session recovers tabId <-> PendingTabTask from chrome.storage.session and mounts Shadow DOM bar', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const task = makeSyntheticTask('ZHIHU_EXT', { variantTitle: '休眠恢复验证文章' });
    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, task));

    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    // Cold SW restart — wipes all SW memory while preserving chrome.storage.session
    await env.simulateServiceWorkerRestart(() => bootBackgroundServiceWorker());
    const bridgeCallsBeforeNav = bridge.bridgeRequests.length;

    env.setContext({
      kind: 'content',
      tabId: tab.id!,
      url: 'https://zhuanlan.zhihu.com/p/445566?utm_source=demo#sec',
    });
    navigateSpa('/p/445566?utm_source=demo#sec', 'pushState');
    env.updateTabUrl(
      tab.id!,
      'https://zhuanlan.zhihu.com/p/445566?utm_source=demo#sec',
      'complete',
    );

    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!)!;
      expect(sr.textContent).toContain('https://zhuanlan.zhihu.com/p/445566');
      expect(sr.textContent).toContain('休眠恢复验证文章');
    });
    // Must NOT have re-fetched /tasks to recover tab context
    expect(bridge.bridgeRequests.length).toBe(bridgeCallsBeforeNav);
  });

  it('T3-08: SPA pushState/replaceState/popstate + SW tabs.onUpdated dual signals deduplicate Shadow DOM bar mounting', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    setGlobalPageUrl('https://www.toutiao.com/');
    const tab = await env.chrome.tabs.create({ url: 'https://www.toutiao.com/' });
    await storage.setTabTask(
      tab.id!,
      makeSyntheticPendingTabTask(tab.id!, makeSyntheticTask('TOUTIAO_EXT')),
    );
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const rawPublishedUrl = 'https://www.toutiao.com/i73500112233?wid=1';
    env.setContext({ kind: 'content', tabId: tab.id!, url: rawPublishedUrl });
    navigateSpa('/i73500112233?wid=1', 'pushState');
    navigateSpa('/i73500112233?wid=1', 'replaceState');
    navigateSpa('/i73500112233?wid=1', 'popstate');
    env.updateTabUrl(tab.id!, rawPublishedUrl, 'complete');

    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!)!;
      expect(sr.textContent).toContain('https://www.toutiao.com/i73500112233');
      expect(sr.textContent).not.toContain('wid=1');
      expect(sr.textContent).toContain('一键回传至 GeoMix 开启 T+7/14/30 追踪');
      expect(
        env.runtimeMessages.filter(
          (m) => m.senderKind === 'content' && m.tabId === tab.id,
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(env.contentBoundMessages.some((m) => m.tabId === tab.id)).toBe(true);
    });

    // Follow-up duplicate SPA + SW signals after mount must remain deduplicated at 1 host
    navigateSpa('/i73500112233?wid=1', 'popstate');
    env.updateTabUrl(tab.id!, rawPublishedUrl, 'complete');
    await new Promise((r) => setTimeout(r, 40));
    expect(findShadowHosts(document).length).toBe(1);
    expect(env.runtimeMessages.some((m) => m.senderKind === 'popup')).toBe(false);
  });

  it('T3-09: deterministic Idempotency-Key across 503 retry + T+1/T+7/14/30 feedback + post-confirm tab unbinding', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const task = makeSyntheticTask('SMZDM_EXT', { taskId: 'task-99' });
    setGlobalPageUrl('https://post.smzdm.com/p/Ab12Cd34');
    const tab = await env.chrome.tabs.create({
      url: 'https://post.smzdm.com/p/Ab12Cd34',
    });
    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, task));

    bridge.queueFault('confirm-published', {
      kind: 'invalid-json',
      status: 503,
      rawBody: '<html>503</html>',
    });

    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    env.setContext({ kind: 'content', tabId: tab.id!, url: 'https://post.smzdm.com/p/Ab12Cd34' });
    env.updateTabUrl(tab.id!, 'https://post.smzdm.com/p/Ab12Cd34', 'complete');

    const getCta = () => {
      const host = findShadowHosts(document)[0];
      const root = host ? getShadowRootForHost(host) : null;
      return root
        ? Array.from(root.querySelectorAll('button')).find((b) =>
            /一键回传|重试|回传/.test(b.textContent ?? ''),
          )
        : undefined;
    };

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
      expect(getCta()).toBeTruthy();
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;

    // Attempt 1 -> 503
    fireEvent.click(getCta()!);
    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBe(1);
      expect(sr.textContent).toMatch(/失败|503|重试/);
    });

    // Attempt 2 -> 200 success
    fireEvent.click(getCta()!);
    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBe(2);
      expect(sr.textContent).toMatch(/T\+1|7.*14.*30|追踪已开启|已回传/);
    });

    const k1 = bridge.bridgeRequests[0]!.headers['idempotency-key'];
    const k2 = bridge.bridgeRequests[1]!.headers['idempotency-key'];
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2);

    await waitFor(async () => {
      expect(await storage.getTabTask(tab.id!)).toBeFalsy();
    });
  });
});

// ============================================================================
// Cluster D: Media Concurrency/Size/Timeout + LocalImageUploader + Shadow Notice
// ============================================================================

describe('Tier 3 — Cluster D: Media Relay Limits, Binary Fidelity & Zero Hotlink Fallback', () => {
  it('T3-10: media fetcher enforces concurrency <= 2 and LocalImageUploader delivers binary-accurate Files', async () => {
    await loadMediaFetcherModule();
    const env = setupEnv();
    const bridge = setupBridge({ deferConcurrentMedia: true });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const assets = Array.from({ length: 5 }, (_, i) => ({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/concurrent-${i + 1}.png`,
      alt: `配图${i + 1}`,
      mime: 'image/png',
    }));

    const batchPromise = invokeMediaFetcherBatch(assets);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      expect(bridge.getMaxObservedMediaConcurrency()).toBeLessThanOrEqual(2);
      bridge.releaseNextDeferredMedia();
    }
    bridge.releaseAllDeferredMedia();
    const fetched = await batchPromise;
    expect(fetched.every((r) => r.ok)).toBe(true);
    expect(bridge.getMaxObservedMediaConcurrency()).toBeLessThanOrEqual(2);

    // Also verify LocalImageUploader reconstructs binary-accurate File onto <input type="file">
    bridge.restore();
    setupBridge({ deferConcurrentMedia: false });
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const { createUploader } = await loadImageUploaderModule();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    document.body.appendChild(fileInput);

    const upRes = await createUploader().uploadAll(
      [{ url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '校验图', mime: 'image/png' }],
      { fileInput },
    );
    expect(upRes.uploadedImages).toBe(1);
    expect(fileInput.files?.item(0)?.size).toBe(128);
    expect(fileInput.files?.item(0)?.type).toBe('image/png');
  });

  it('T3-11: size cap (>10MB header & streamed) + 15s timeout abort produce PARTIAL_MEDIA_FAILED', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const { createUploader } = await loadImageUploaderModule();
    const fix = createZhihuColumnFixture();
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const uploader = createUploader();

    const task = makeSyntheticTask('ZHIHU_EXT', {
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '正常图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-header.png`, alt: '头超限图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-stream.png`, alt: '流超限图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/slow-timeout.png`, alt: '超时图', mime: 'image/png' },
      ],
    });

    vi.useFakeTimers();
    try {
      const injectPromise = adapter.injectDraft(fix.doc, task, uploader);
      await vi.advanceTimersByTimeAsync(20_000);
      const report = await injectPromise;

      expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
      expect(report.uploadedImages).toBe(1);
      expect(report.failedImages).toBe(3);
      expect(report.failedImageDetails?.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T3-12: zero external hotlink fallback on media failure + Shadow DOM operator manual-upload notice', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = createZhihuColumnFixture().doc.body.innerHTML;
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const task = makeSyntheticTask('ZHIHU_EXT', {
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '正常图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`, alt: '缺失图404', mime: 'image/png' },
        { url: 'http://cdn.example.com/media/insecure.jpg', alt: '不安全HTTP图', mime: 'image/jpeg' },
      ],
    });

    const report = await sendInjectDraftToTab(env, tab.id!, task);

    expect(report).toBeTruthy();
    expect(report!['stage']).toBe('PARTIAL_MEDIA_FAILED');
    expect(report!['failedImages']).toBe(2);

    const editorHtml = document.querySelector('[contenteditable="true"]')?.innerHTML ?? '';
    expect(editorHtml).not.toContain('missing-404.png');
    expect(editorHtml).not.toContain('insecure.jpg');

    const hosts = findShadowHosts(document);
    expect(hosts.length).toBe(1);
    const iso = assertShadowIsolation(document, hosts[0]!, '缺失图404');
    expect(iso.lightDomContainsShadowText).toBe(false);
    expect(iso.shadowRoot.textContent).toContain('缺失图404');
  });
});

// ============================================================================
// Cluster E: Zhihu targetUrlHint vs /write + Login Wall + Public URL Normalization
// ============================================================================

describe('Tier 3 — Cluster E: Zhihu Routing, Login Detection & URL Normalization', () => {
  it('T3-13: Zhihu targetUrlHint routing precedence vs fallback to /write', async () => {
    const cases: Array<{ hint: string | null; expectedUrl: string }> = [
      {
        hint: 'https://www.zhihu.com/question/55667788',
        expectedUrl: 'https://www.zhihu.com/question/55667788',
      },
      { hint: null, expectedUrl: 'https://zhuanlan.zhihu.com/write' },
      {
        hint: 'https://evil.example.com/question/55667788',
        expectedUrl: 'https://zhuanlan.zhihu.com/write',
      },
    ];

    for (const c of cases) {
      const env = setupEnv();
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
        makeSyntheticTask('ZHIHU_EXT', { targetUrlHint: c.hint, mediaAssets: [] }),
      );
      expect(env.chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: c.expectedUrl }),
      );
      env.restore();
      activeChrome = null;
    }

    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const qaFix = createZhihuQuestionAnswerFixture('55667788');
    expect(adapter.isLoggedInEditor(qaFix.doc, qaFix.url)).toBe(true);
  });

  it('T3-14: Zhihu login wall detection (AUTH_REQUIRED) vs React controlled title + Draft.js HTML paste (draft-only)', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const loggedOut = createZhihuLoggedOutFixture('login-modal');
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    expect(adapter.isLoggedInEditor(loggedOut.doc, loggedOut.url)).toBe(false);
    const authRes = await adapter.injectDraft(
      loggedOut.doc,
      makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }),
      uploader,
    );
    expect(authRes).toMatchObject({
      ok: false,
      stage: 'AUTH_REQUIRED',
      uploadedImages: 0,
      failedImages: 0,
    });

    const loggedIn = createZhihuColumnFixture();
    const task = makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] });
    expect(adapter.isLoggedInEditor(loggedIn.doc, loggedIn.url)).toBe(true);
    const okRes = await adapter.injectDraft(loggedIn.doc, task, uploader);
    expect(okRes.ok).toBe(true);
    expect(okRes.stage).toBe('INJECTED');
    expect(loggedIn.doc.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      task.variantTitle,
    );
    expect(loggedIn.spies.titleEvents).toContain('input');
    expect(loggedIn.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
  });

  it('T3-15: Zhihu public column & answer URL canonicalization vs /edit, /write, and bare /question/:id rejection', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const v = await loadUrlValidationModule();
    const fix = createZhihuColumnFixture();

    expect(
      adapter.extractPublishedUrl(
        new URL('https://zhuanlan.zhihu.com/p/123456789?utm_source=wechat#comments'),
        fix.doc,
      ),
    ).toBe('https://zhuanlan.zhihu.com/p/123456789');
    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.zhihu.com/question/112233/answer/445566?utm_id=1#top'),
        fix.doc,
      ),
    ).toBe('https://www.zhihu.com/question/112233/answer/445566');

    for (const bad of [
      'https://zhuanlan.zhihu.com/p/123456789/edit',
      'https://zhuanlan.zhihu.com/write',
      'https://www.zhihu.com/question/112233',
      'http://zhuanlan.zhihu.com/p/123456789',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
      expect(v.canonicalizePublishedUrl(bad, 'ZHIHU_EXT')).toBeNull();
    }
  });
});

// ============================================================================
// Cluster F: Toutiao Injection + 存草稿 Safe Action vs Forbidden Publish
// ============================================================================

describe('Tier 3 — Cluster F: Toutiao Injection, Draft-Only Redline & URL Capture', () => {
  it('T3-16: Toutiao login redirect detection + ProseMirror/rich-text injection + native image relay', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const loggedOut = createToutiaoLoggedOutFixture();
    expect(adapter.isLoggedInEditor(loggedOut.doc, loggedOut.url)).toBe(false);
    const authRes = await adapter.injectDraft(
      loggedOut.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(authRes.stage).toBe('AUTH_REQUIRED');

    const fix = createToutiaoEditorFixture();
    const tab = await env.chrome.tabs.create({ url: fix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const { createUploader } = await loadImageUploaderModule();

    const okRes = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createUploader(),
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.stage).toBe('INJECTED');
    expect(okRes.uploadedImages).toBe(2);
    expect(okRes.failedImages).toBe(0);
  });

  it('T3-17: Toutiao draft-only redline — 存草稿 permitted, 预览并发布 & 发布 strictly untouched', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT', { mediaAssets: [] }),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(fix.spies.publishButtonLabelsClicked).toEqual([]);
    expect(fix.spies.draftButtonClicks.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('T3-18: Toutiao /article/\\d+ & /i\\d+ canonicalization vs mp.toutiao.com rejection', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const v = await loadUrlValidationModule();
    const fix = createToutiaoEditorFixture();

    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.toutiao.com/article/7350011223344/?log_from=abc#comment'),
        fix.doc,
      ),
    ).toBe('https://www.toutiao.com/article/7350011223344');
    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.toutiao.com/i7350011223344/?wid=999'),
        fix.doc,
      ),
    ).toBe('https://www.toutiao.com/i7350011223344');

    for (const bad of [
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      'https://mp.toutiao.com/article/7350011223344',
      'https://www.toutiao.com/article/7350011223344/edit',
      'https://www.toutiao.com/i7350011223344/draft',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
      expect(v.canonicalizePublishedUrl(bad, 'TOUTIAO_EXT')).toBeNull();
    }
  });
});

// ============================================================================
// Cluster G: SMZDM Table Preservation + Reminders + /p/ Capture
// ============================================================================

describe('Tier 3 — Cluster G: SMZDM Table Preservation, Operator Reminders & URL Capture', () => {
  it('T3-19: SMZDM review injection preserves comparison <table> and measured-data lists alongside relayed images', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const tab = await env.chrome.tabs.create({ url: fix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const { createUploader } = await loadImageUploaderModule();

    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT'),
      createUploader(),
    );
    expect(report.ok).toBe(true);
    expect(report.uploadedImages).toBe(2);
    expect(report.failedImages).toBe(0);

    const html = `${fix.doc.querySelector('[contenteditable="true"]')?.innerHTML ?? ''}\n${fix.spies.pastedHtml.join('\n')}`;
    expect(html).toContain('<table');
    expect(html).toContain('<th>参数</th>');
    expect(html).toContain('<td>185g</td>');
    expect(html).toContain('32dB');
  });

  it('T3-20: SMZDM operator reminders (product cards & disclosure) + draft-only redline + logged-out detection', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] }),
      uploader,
    );
    expect((report.operatorReminders ?? []).length).toBeGreaterThan(0);
    const joined = (report.operatorReminders ?? []).join(' ');
    expect(joined).toContain('商品卡片');
    expect(joined).toMatch(/披露|合规/);
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);

    const loggedOut = createSmzdmLoggedOutFixture();
    const authRes = await adapter.injectDraft(
      loggedOut.doc,
      makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] }),
      uploader,
    );
    expect(authRes.stage).toBe('AUTH_REQUIRED');
  });

  it('T3-21: SMZDM /p/[a-zA-Z0-9]+ canonicalization vs /tougao/ and /edit rejection', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const v = await loadUrlValidationModule();
    const fix = createSmzdmEditorFixture();

    expect(
      adapter.extractPublishedUrl(
        new URL('https://post.smzdm.com/p/k9Xm2Qp7/?from=share#reviews'),
        fix.doc,
      ),
    ).toBe('https://post.smzdm.com/p/k9Xm2Qp7');

    for (const bad of [
      'https://post.smzdm.com/tougao/',
      'https://post.smzdm.com/p/k9Xm2Qp7/edit',
      'https://post.smzdm.com/p/k9Xm2Qp7-bad',
      'https://www.smzdm.com/p/k9Xm2Qp7',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
      expect(v.canonicalizePublishedUrl(bad, 'SMZDM_EXT')).toBeNull();
    }
  });
});

// ============================================================================
// Cluster H: Unified Anti-SSRF + Cross-Provider Guard + Outbound Sanitization
// ============================================================================

describe('Tier 3 — Cluster H: Anti-SSRF Defense, Cross-Provider Guard & Wire Sanitization', () => {
  it('T3-22: unified Anti-SSRF & protocol defense across Pairing baseUrl, Media Fetcher & Published URL Validator', async () => {
    const bridge = setupBridge();
    const v = await loadUrlValidationModule();

    // Positive controls
    expect(v.validateApiBaseUrl(SYNTHETIC_API_BASE_URL)).toBe(SYNTHETIC_API_BASE_URL);
    expect(v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456', 'ZHIHU_EXT')).toBe(
      'https://zhuanlan.zhihu.com/p/123456',
    );

    const matrix = [
      'http://geo.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:image/png;base64,AA==',
      'https://user:pass@geo.example.com',
      'https://user@zhuanlan.zhihu.com/p/123',
      'https://127.0.0.1',
      'https://localhost',
      'https://sub.localhost/a',
      'https://intranet/a',
      'https://2130706433/a',
      'https://0x7f000001/a',
      'https://[::1]',
      'https://10.0.0.1',
      'https://100.64.0.1/a',
      'https://172.16.5.4',
      'https://192.168.1.10',
      'https://169.254.169.254/latest/meta-data',
      'https://[fc00::1]',
      'https://[fe80::1]',
      'https://[::ffff:127.0.0.1]/a',
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://api.corp.local',
      'https://meta.internal',
      'https://geo.example.com/a\r\nb',
      'https://geo.example.com/has space',
      `https://geo.example.com/${'x'.repeat(2050)}`,
    ];

    for (const bad of matrix) {
      expect(v.validateApiBaseUrl(bad), `baseUrl failed to block ${bad}`).toBeNull();
      expect(
        v.canonicalizePublishedUrl(bad, 'ZHIHU_EXT'),
        `publishedUrl failed to block ${bad}`,
      ).toBeNull();
      const mediaRes = await invokeMediaFetcherSingle({ url: bad, alt: 'bad' });
      expect(mediaRes.ok, `mediaFetcher failed to block ${bad}`).toBe(false);
    }
    expect(bridge.requests.length).toBe(0);
    expect(bridge.forbiddenFetchAttempts.length).toBe(0);
  });

  it('T3-23: cross-provider URL mismatch rejected prior to Bridge confirm-published call', async () => {
    const bridge = setupBridge();
    const v = await loadUrlValidationModule();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
      extensionVersion: '0.1.0',
    });

    // Positive controls on url-validation
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456', 'ZHIHU_EXT'),
    ).toBe('https://zhuanlan.zhihu.com/p/123456');
    expect(
      v.canonicalizePublishedUrl('https://www.toutiao.com/article/7123456789', 'TOUTIAO_EXT'),
    ).toBe('https://www.toutiao.com/article/7123456789');
    expect(
      v.canonicalizePublishedUrl('https://post.smzdm.com/p/Ab12Cd', 'SMZDM_EXT'),
    ).toBe('https://post.smzdm.com/p/Ab12Cd');

    // Cross-provider mismatches rejected by url-validation
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456', 'TOUTIAO_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://post.smzdm.com/p/Ab12Cd', 'TOUTIAO_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://www.toutiao.com/article/7123456789', 'ZHIHU_EXT'),
    ).toBeNull();

    // Cross-provider mismatches rejected client-side by real BridgeClient BEFORE HTTP fetch
    await expect(
      client.confirmPublished(
        'task_demo_toutiao_01',
        { publishedUrl: 'https://zhuanlan.zhihu.com/p/123456' },
        { provider: 'TOUTIAO_EXT' },
      ),
    ).rejects.toThrow();
    await expect(
      client.confirmPublished(
        'task_demo_smzdm_01',
        { publishedUrl: 'https://www.toutiao.com/article/7123456789' },
        { provider: 'SMZDM_EXT' },
      ),
    ).rejects.toThrow();
    await expect(
      client.confirmPublished(
        'task_demo_zhihu_01',
        { publishedUrl: 'https://post.smzdm.com/p/Ab12Cd' },
        { provider: 'ZHIHU_EXT' },
      ),
    ).rejects.toThrow();

    expect(bridge.bridgeRequests.length).toBe(0);
    expect(bridge.requests.length).toBe(0);
    expect(bridge.publishRecords.length).toBe(0);

    // Positive control on real BridgeClient: matching provider succeeds and sends 1 request
    const confirmed = await client.confirmPublished(
      'task_demo_toutiao_01',
      { publishedUrl: 'https://www.toutiao.com/article/7123456789' },
      { provider: 'TOUTIAO_EXT' },
    );
    expect(confirmed.status).toBe('PUBLISHED');
    expect(bridge.bridgeRequests.length).toBe(1);
    expect(bridge.publishRecords.length).toBe(1);
  });

  it('T3-24: Bridge confirm-published outbound sanitization & strict Zod envelope validation', async () => {
    const bridge = setupBridge();
    const v = await loadUrlValidationModule();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
      extensionVersion: '0.1.0',
    });

    const dirtyUrl =
      'https://zhuanlan.zhihu.com/p/123456789?utm_source=x&token=secret#frag';

    // Step A: Direct dirty URL call must either fail closed (0 wire calls) OR strip before wire
    let acceptedDirty = false;
    try {
      await client.confirmPublished('task_demo_zhihu_01', { publishedUrl: dirtyUrl });
      acceptedDirty = true;
    } catch (err) {
      if (
        err instanceof PublicSurfaceError ||
        err instanceof TypeError ||
        err instanceof ReferenceError ||
        err instanceof SyntaxError
      ) {
        throw err;
      }
      expect(bridge.bridgeRequests.length).toBe(0);
    }

    if (acceptedDirty) {
      expect(bridge.bridgeRequests.length).toBe(1);
      const firstReq = bridge.bridgeRequests[0]!;
      const firstBody = JSON.parse(firstReq.bodyText ?? '{}') as { publishedUrl: string };
      expect(firstBody.publishedUrl).toBe('https://zhuanlan.zhihu.com/p/123456789');
      expect(firstReq.bodyText ?? '').not.toContain('utm_source');
      expect(firstReq.bodyText ?? '').not.toContain('token=secret');
      expect(firstReq.bodyText ?? '').not.toContain('#frag');
    }

    // Step B: Upstream url-validation -> BridgeClient.confirmPublished clean wire flow
    const cleaned = v.canonicalizePublishedUrl(dirtyUrl, 'ZHIHU_EXT');
    expect(cleaned).toBe('https://zhuanlan.zhihu.com/p/123456789');

    const reqIdx = bridge.bridgeRequests.length;
    await client.confirmPublished('task_demo_zhihu_01', { publishedUrl: cleaned! });
    const req = bridge.bridgeRequests[reqIdx]!;
    const body = JSON.parse(req.bodyText ?? '{}') as { publishedUrl: string };
    expect(body.publishedUrl).toBe('https://zhuanlan.zhihu.com/p/123456789');
    expect(req.headers['content-type']).toContain('application/json');
    expect(req.headers['idempotency-key']).toBeTruthy();
    expect(req.headers['x-geomix-extension-version']).toBe('0.1.0');
    expect(req.headers['authorization']).toBe(`Bearer ${SYNTHETIC_TOKEN}`);

    // Step C: Strict Zod envelope validation rejects non-zero code & invalid status
    bridge.queueFault('confirm-published', {
      kind: 'http',
      status: 200,
      body: { code: 1, msg: 'err', data: null },
    });
    await expect(
      client.confirmPublished('task_demo_zhihu_01', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      }),
    ).rejects.toThrow();

    bridge.queueFault('confirm-published', {
      kind: 'http',
      status: 200,
      body: {
        code: 0,
        msg: 'ok',
        data: { taskId: 't1', status: 'DRAFT_PUSHED' },
      },
    });
    await expect(
      client.confirmPublished('task_demo_zhihu_01', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// Cluster I: Token Security Redline Across Popup <-> SW <-> Content
// ============================================================================

describe('Tier 3 — Cluster I: Token Isolation & Mid-Session Revocation', () => {
  it('T3-25: zero raw gmext_ token leakage in SW <-> Content Script IPC payloads', async () => {
    const env = setupEnv();
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(
      makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN }),
    );

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = createZhihuColumnFixture().doc.body.innerHTML;
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const task = makeSyntheticTask('ZHIHU_EXT');
    const injectResp = await sendInjectDraftToTab(env, tab.id!, task);
    expect(injectResp).toBeTruthy();
    expect(injectResp!['ok']).toBe(true);
    expect(injectResp!['stage']).toBe('INJECTED');
    expect(Number(injectResp!['uploadedImages'])).toBeGreaterThan(0);
    // Ensure real Content -> SW media-relay IPC messages crossed the wire
    expect(
      env.runtimeMessages.some(
        (m) =>
          m.senderKind === 'content' &&
          m.tabId === tab.id &&
          JSON.stringify(m.payload).includes('valid-1.png'),
      ),
    ).toBe(true);

    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, task));

    env.setContext({ kind: 'content', tabId: tab.id!, url: 'https://zhuanlan.zhihu.com/p/998877' });
    navigateSpa('/p/998877', 'pushState');
    env.updateTabUrl(tab.id!, 'https://zhuanlan.zhihu.com/p/998877', 'complete');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });
    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(cta);

    await waitFor(() => {
      expect(bridge.publishRecords.length).toBe(1);
    });

    expect(env.contentBoundMessages.length).toBeGreaterThan(0);
    expect(env.runtimeMessages.some((m) => m.senderKind === 'content')).toBe(true);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('T3-26: zero raw gmext_ token leakage in console.*, localStorage, sessionStorage & Host/Shadow DOM (including errors)', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    env.captureConsoleLogs();
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    // MUST load real M2 Shadow DOM controller (prevents vacuous pass before M2 exists)
    const captureBar = await loadUrlCaptureBarController();
    const { createClient } = await loadBridgeClientModule();

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    // Trigger HTTP 500 on initial tasks fetch right after pairing
    bridge.queueFault('tasks', { kind: 'http', status: 500 });
    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_SENTINEL_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });

    // Revoke token and unconditionally trigger refresh -> real 401 error rendered in Popup
    bridge.revokeToken(SYNTHETIC_SENTINEL_TOKEN);
    const callsBeforeRevokedRefresh = bridge.bridgeRequests.length;
    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /刷新|重试|refresh|retry/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);

    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBeGreaterThan(callsBeforeRevokedRefresh);
      expect(container.textContent).toMatch(/401|失效|过期|重新配对/);
    });

    // Mount real Shadow DOM URL capture bar and trigger real 401 confirm-published error inside Shadow DOM
    const revokedClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_SENTINEL_TOKEN,
    });
    const tabTask = makeSyntheticPendingTabTask(201, makeSyntheticTask('ZHIHU_EXT'));
    const barHandle = captureBar.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/778899',
      task: tabTask,
      onConfirm: async (url) =>
        revokedClient.confirmPublished(tabTask.taskId, { publishedUrl: url }),
    });

    const shadowRoots = getCapturedShadowRoots();
    expect(shadowRoots.length).toBeGreaterThan(0);
    const sr = shadowRoots[shadowRoots.length - 1]!.root;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix|回传|确认/i.test(b.textContent ?? ''),
    );
    expect(cta).toBeTruthy();

    const callsBeforeConfirm = bridge.bridgeRequests.length;
    fireEvent.click(cta!);
    await waitFor(() => {
      expect(bridge.bridgeRequests.length).toBeGreaterThan(callsBeforeConfirm);
      expect((sr.textContent ?? '').length).toBeGreaterThan(0);
    });

    // Audits localStorage, sessionStorage, Host DOM, ALL ShadowRoots, console.*, and contentBoundMessages
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
    barHandle.unmount();
  });

  it('T3-27: mid-session 401 token revocation degrades gracefully across SW, Popup & Shadow DOM without retry storms', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    // MUST load real M2 Shadow DOM controller (prevents vacuous pass before M2 exists)
    const captureBar = await loadUrlCaptureBarController();
    const { createClient } = await loadBridgeClientModule();

    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    bridge.revokeToken(SYNTHETIC_TOKEN);

    // (a) Popup + SW graceful 401 degradation without retry storms
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toMatch(/失效|过期|401|重新配对|解除绑定|解绑/);
    });
    await new Promise((r) => setTimeout(r, 40));
    const failedTaskCalls = bridge.bridgeRequests.filter((r) =>
      r.url.includes('/api/v2/extension/tasks'),
    ).length;
    expect(failedTaskCalls).toBeGreaterThanOrEqual(1);
    expect(failedTaskCalls).toBeLessThanOrEqual(2);

    // (b) Shadow DOM URL capture bar 401 degradation without retry storms
    const revokedClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    const tabTask = makeSyntheticPendingTabTask(202, makeSyntheticTask('ZHIHU_EXT'));
    const barHandle = captureBar.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/667788',
      task: tabTask,
      onConfirm: async (url) =>
        revokedClient.confirmPublished(tabTask.taskId, { publishedUrl: url }),
    });

    const shadowRoots = getCapturedShadowRoots();
    expect(shadowRoots.length).toBeGreaterThan(0);
    const sr = shadowRoots[shadowRoots.length - 1]!.root;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix|回传|确认/i.test(b.textContent ?? ''),
    );
    expect(cta).toBeTruthy();
    fireEvent.click(cta!);

    await waitFor(() => {
      const confirmCalls = bridge.bridgeRequests.filter((r) =>
        r.url.includes('/confirm-published'),
      ).length;
      expect(confirmCalls).toBeGreaterThanOrEqual(1);
      expect(sr.textContent ?? '').toMatch(/401|失效|过期|失败|重试|重新/i);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      bridge.bridgeRequests.filter((r) => r.url.includes('/confirm-published')).length,
    ).toBe(1);
    expect(bridge.publishRecords.length).toBe(0);
    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
    barHandle.unmount();

    // (c) Re-pair with fresh token restores full access (matches '解除绑定' and '重新配对')
    bridge.addValidToken(SYNTHETIC_RENEWED_TOKEN, makeSyntheticMe());
    const unbindBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /解除绑定|解绑|解除配对|重新配对|重新绑定|注销|退出|断开|unbind/i.test(
        b.textContent ?? '',
      ),
    );
    expect(unbindBtn).toBeTruthy();
    fireEvent.click(unbindBtn!);

    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);
    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_RENEWED_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });

    const renewedClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_RENEWED_TOKEN,
    });
    const confirmResult = await renewedClient.confirmPublished(tabTask.taskId, {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/667788',
    });
    expect(confirmResult.status).toBe('PUBLISHED');
    expect(bridge.publishRecords.length).toBe(1);
  });
});

// ============================================================================
// Cluster J: Manifest Permissions + Build Output + CWS Clean ZIP Packager
// ============================================================================

describe('Tier 3 — Cluster J: Manifest, 2-Pass Build Integrity & CWS ZIP Audit', () => {
  it('T3-28: dist/manifest.json parity with manifest.config.ts, exact minimal permissions & physical asset presence', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(resolveRepoPath('package.json'), 'utf8'),
    ) as { version: string };
    const { buildManifest } = await loadManifestConfig();
    const cfg = buildManifest(pkg.version);
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
    expect(dist.version).toBe(cfg.version);
    expect((dist.web_accessible_resources ?? []).length).toBe(0);

    for (const rel of [
      dist.background?.service_worker,
      ...(dist.content_scripts ?? []).flatMap((c) => c.js ?? []),
      dist.action?.default_popup,
      ...Object.values(dist.icons ?? {}),
    ].filter((x): x is string => Boolean(x))) {
      expect(fs.statSync(resolveRepoPath('dist', rel)).size).toBeGreaterThan(0);
    }
  });

  it('T3-29: two-pass Vite MV3 build structural integrity (IIFE content.js, ESM background.js, zero .map)', () => {
    const distFiles = listFilesRecursive('dist');
    expect(distFiles.filter((f) => f.endsWith('.map'))).toEqual([]);

    const contentJs = readDistBundle('content.js');
    expect(/^\s*import\s+[\s\S]*?\sfrom\s+['"]/m.test(contentJs)).toBe(false);
    expect(/^\s*export\s+(default|const|let|var|function|class|\{)/m.test(contentJs)).toBe(false);

    const bgJs = readDistBundle('background.js');
    expect(bgJs.length).toBeGreaterThan(0);
    expect(readDistManifest().background?.type).toBe('module');
  });

  it('T3-30: CWS ZIP packager produces clean uploadable archive + static repo redline scan', () => {
    const pack = runPackScript();
    expect(pack.exitCode).toBe(0);
    expect(pack.zipBuffer).not.toBeNull();
    const names = pack.entries.map((e) => e.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('background.js');
    expect(names).toContain('content.js');
    expect(names.some((n) => n.endsWith('.html'))).toBe(true);
    for (const entryName of names) {
      expect(entryName, `Forbidden sourcemap in ZIP: ${entryName}`).not.toMatch(/\.map$/i);
      expect(entryName, `Forbidden test file in ZIP: ${entryName}`).not.toMatch(
        /\.(spec|test)\.|(^|\/)fixtures\./i,
      );
      expect(entryName, `Forbidden TS/JSX source in ZIP: ${entryName}`).not.toMatch(
        /\.(ts|tsx|jsx)$/i,
      );
      expect(entryName, `Forbidden OS junk in ZIP: ${entryName}`).not.toMatch(
        /(^|\/)(\.DS_Store|Thumbs\.db)$/i,
      );
      expect(entryName, `Forbidden non-dist directory in ZIP: ${entryName}`).not.toMatch(
        /^(node_modules|\.agents|tests|docs|scripts|\.github)\//,
      );
      if (entryName.startsWith('src/')) {
        expect(
          entryName,
          `Only built manifest default_popup HTML is permitted under src/ in ZIP: ${entryName}`,
        ).toBe('src/popup/index.html');
      }
    }

    const srcFiles = scanSourceFiles('src');
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const f of srcFiles) {
      expect(f.content).not.toMatch(/document\s*\.\s*cookie/);
    }
    expect(readDistBundle('content.js')).not.toMatch(/document\s*\.\s*cookie/);
    expect(readDistBundle('background.js')).not.toMatch(/document\s*\.\s*cookie/);
  });
});
