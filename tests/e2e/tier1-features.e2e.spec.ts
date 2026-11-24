import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_HOST_PERMISSIONS,
  EXPECTED_MANIFEST_PERMISSIONS,
  EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  PAIRING_STORAGE_KEY,
  REPO_ROOT,
  SYNTHETIC_API_BASE_URL,
  SYNTHETIC_BRAND_ALPHA,
  SYNTHETIC_BRAND_BETA,
  SYNTHETIC_CDN_BASE_URL,
  SYNTHETIC_SECONDARY_API_URL,
  SYNTHETIC_SENTINEL_TOKEN,
  SYNTHETIC_TOKEN,
  TAB_TASKS_STORAGE_KEY,
  PublicSurfaceError,
  assertShadowIsolation,
  assertValidPlatformAdapter,
  attachFixtureSpies,
  bootBackgroundServiceWorker,
  bootContentScript,
  createChromeMv3Env,
  createFullByteRangePngBytes,
  createMinimalPngBytes,
  createMockBridgeServer,
  createSimpleMockUploader,
  createSmzdmEditorFixture,
  createToutiaoEditorFixture,
  createZhihuColumnFixture,
  createZhihuQuestionAnswerFixture,
  findShadowHosts,
  getShadowRootForHost,
  invokeDispatcher,
  invokeMediaFetcherBatch,
  invokeMediaFetcherSingle,
  listFilesRecursive,
  loadAdapterRegistryModule,
  loadAdapterTypesModule,
  loadBridgeClientModule,
  loadBridgeContract,
  loadImageUploaderModule,
  loadManifestConfig,
  loadMediaFetcherModule,
  loadMessagesModule,
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
  readBlobBytes,
  readDistBundle,
  readDistManifest,
  readQaChecklistDoc,
  resolveRepoPath,
  runPackScript,
  scanSourceFiles,
  sendInjectDraftToTab,
  setGlobalPageUrl,
  type ChromeMv3Controller,
  type ExtensionPendingTaskDto,
  type MockBridgeController,
} from './harness/index.js';

let activeChrome: ChromeMv3Controller | null = null;
let activeBridge: MockBridgeController | null = null;

afterEach(() => {
  activeBridge?.restore();
  activeBridge = null;
  activeChrome?.restore();
  activeChrome = null;
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
    throw new Error(
      `Popup pairing form inputs/button not found (inputs=${inputs.length}, buttons=${buttons.length})`,
    );
  }
  return { urlInput, tokenInput, submitBtn };
}

// ============================================================================
// F01 — MV3 Project Scaffold & CI (6 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F01: MV3 Project Scaffold & CI', () => {
  it('F01-T1-01: pinned toolchain & required scripts in package.json', () => {
    const pkgPath = resolveRepoPath('package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      type?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.type).toBe('module');
    expect(pkg.scripts?.['lint']).toBeTruthy();
    expect(pkg.scripts?.['typecheck']).toBeTruthy();
    expect(pkg.scripts?.['test']).toBeTruthy();
    expect(pkg.scripts?.['build']).toBeTruthy();

    expect(pkg.dependencies?.['react']).toMatch(/^[\^~]?19\./);
    expect(pkg.dependencies?.['react-dom']).toMatch(/^[\^~]?19\./);
    expect(pkg.dependencies?.['zod']).toMatch(/^[\^~]?3\.25\./);
    expect(pkg.devDependencies?.['vite']).toMatch(/^[\^~]?6\./);
    expect(pkg.devDependencies?.['typescript']).toMatch(/^[\^~]?5\.9\./);
    expect(pkg.devDependencies?.['vitest']).toMatch(/^[\^~]?3\.2\./);
    expect(pkg.devDependencies?.['eslint']).toMatch(/^[\^~]?9\./);
  });

  it('F01-T1-02: 2-pass Vite MV3 build produces complete Chrome-loadable dist/', () => {
    const manifest = readDistManifest();
    expect(fs.existsSync(resolveRepoPath('dist/background.js'))).toBe(true);
    expect(fs.statSync(resolveRepoPath('dist/background.js')).size).toBeGreaterThan(0);
    expect(fs.existsSync(resolveRepoPath('dist/content.js'))).toBe(true);
    expect(fs.statSync(resolveRepoPath('dist/content.js')).size).toBeGreaterThan(0);

    const popupRel = manifest.action?.default_popup;
    expect(popupRel).toBeTruthy();
    expect(fs.existsSync(resolveRepoPath('dist', popupRel!))).toBe(true);

    const icons = manifest.icons ?? {};
    for (const size of ['16', '32', '48', '128']) {
      const iconPath = icons[size];
      expect(iconPath).toBeTruthy();
      const absIcon = resolveRepoPath('dist', iconPath!);
      expect(fs.existsSync(absIcon)).toBe(true);
      expect(fs.statSync(absIcon).size).toBeGreaterThan(64);
    }
  });

  it('F01-T1-03: dist/content.js is a self-contained single-file IIFE bundle', () => {
    const contentJs = readDistBundle('content.js');
    expect(contentJs.length).toBeGreaterThan(0);
    expect(/^\s*import\s+[\s\S]*?\sfrom\s+['"]/m.test(contentJs)).toBe(false);
    expect(/^\s*export\s+(default|const|let|var|function|class|\{)/m.test(contentJs)).toBe(false);
    expect(/\bimport\s*\(\s*['"]\.?\//.test(contentJs)).toBe(false);
  });

  it('F01-T1-04: zero sourcemaps emitted into dist/', () => {
    const distFiles = listFilesRecursive('dist');
    const mapFiles = distFiles.filter((f) => f.endsWith('.map'));
    expect(mapFiles).toEqual([]);

    const bgJs = readDistBundle('background.js');
    const contentJs = readDistBundle('content.js');
    expect(bgJs).not.toContain('//# sourceMappingURL=');
    expect(contentJs).not.toContain('//# sourceMappingURL=');
  });

  it('F01-T1-05: GitHub Actions CI workflow enforces all 4 required quality gates', () => {
    const ciPath = resolveRepoPath('.github/workflows/ci.yml');
    expect(fs.existsSync(ciPath)).toBe(true);
    const yaml = fs.readFileSync(ciPath, 'utf8');
    expect(yaml).toMatch(/node-version\s*:\s*['"]?2[2-9]/);
    expect(yaml).toContain('pnpm');
    expect(yaml).toContain('pnpm lint');
    expect(yaml).toContain('pnpm typecheck');
    expect(yaml).toContain('pnpm test');
    expect(yaml).toContain('pnpm build');
    expect(yaml).toMatch(/pull_request/);
    expect(yaml).toMatch(/push/);
  });

  it('F01-T1-06: strict TypeScript and tests/e2e/** isolation in root configs', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(resolveRepoPath('tsconfig.json'), 'utf8'),
    ) as { compilerOptions?: { strict?: boolean }; exclude?: string[] };
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(
      (tsconfig.exclude ?? []).some((e) => e.includes('tests/e2e')),
    ).toBe(true);

    const vitestCfg = fs.readFileSync(resolveRepoPath('vitest.config.ts'), 'utf8');
    expect(vitestCfg).toContain('tests/e2e');

    const eslintCfg = fs.readFileSync(resolveRepoPath('eslint.config.mjs'), 'utf8');
    expect(eslintCfg).toContain('tests/e2e');
  });
});

// ============================================================================
// F02 — Minimal MV3 Manifest (6 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F02: Minimal MV3 Manifest', () => {
  it('F02-T1-01: MV3 version and metadata propagation from buildManifest', async () => {
    const { buildManifest } = await loadManifestConfig();
    const m = buildManifest('0.2.3');
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe('0.2.3');
    expect(typeof m.name).toBe('string');
    expect((m.name ?? '').length).toBeGreaterThan(0);
    expect(typeof m.description).toBe('string');
    expect((m.description ?? '').length).toBeGreaterThan(0);
  });

  it('F02-T1-02: exact minimal permissions allowlist in config and dist/manifest.json', async () => {
    const { buildManifest } = await loadManifestConfig();
    const cfgManifest = buildManifest('0.1.0');
    const distManifest = readDistManifest();

    expect([...(cfgManifest.permissions ?? [])].sort()).toEqual([
      ...EXPECTED_MANIFEST_PERMISSIONS,
    ]);
    expect([...(distManifest.permissions ?? [])].sort()).toEqual([
      ...EXPECTED_MANIFEST_PERMISSIONS,
    ]);
  });

  it('F02-T1-03: exact 5-domain host_permissions allowlist', async () => {
    const { buildManifest } = await loadManifestConfig();
    const cfgManifest = buildManifest('0.1.0');
    const distManifest = readDistManifest();

    expect([...(cfgManifest.host_permissions ?? [])].sort()).toEqual([
      ...EXPECTED_HOST_PERMISSIONS,
    ]);
    expect([...(distManifest.host_permissions ?? [])].sort()).toEqual([
      ...EXPECTED_HOST_PERMISSIONS,
    ]);
  });

  it('F02-T1-04: exact optional_host_permissions for on-demand GeoMix API', async () => {
    const { buildManifest } = await loadManifestConfig();
    expect(buildManifest('0.1.0').optional_host_permissions).toEqual([
      ...EXPECTED_OPTIONAL_HOST_PERMISSIONS,
    ]);
    expect(readDistManifest().optional_host_permissions).toEqual([
      ...EXPECTED_OPTIONAL_HOST_PERMISSIONS,
    ]);
  });

  it('F02-T1-05: action, ESM Service Worker, and Content Script bindings', async () => {
    const { buildManifest } = await loadManifestConfig();
    const m = buildManifest('0.1.0');
    expect(m.background?.service_worker).toBe('background.js');
    expect(m.background?.type).toBe('module');
    expect(m.action?.default_popup).toBeTruthy();

    expect(Array.isArray(m.content_scripts)).toBe(true);
    expect(m.content_scripts?.length).toBe(1);
    const cs = m.content_scripts![0]!;
    expect(cs.js).toEqual(['content.js']);
    expect(cs.run_at).toBe('document_idle');
    expect([...(cs.matches ?? [])].sort()).toEqual([...EXPECTED_HOST_PERMISSIONS]);

    for (const sz of ['16', '32', '48', '128']) {
      expect(m.icons?.[sz]).toBeTruthy();
    }
  });

  it('F02-T1-06: deterministic parity between manifest.config.ts and dist/manifest.json', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(resolveRepoPath('package.json'), 'utf8'),
    ) as { version: string };
    const { buildManifest } = await loadManifestConfig();
    const expected = buildManifest(pkg.version);
    const actual = readDistManifest();

    expect(actual.manifest_version).toBe(expected.manifest_version);
    expect(actual.version).toBe(expected.version);
    expect([...(actual.permissions ?? [])].sort()).toEqual(
      [...(expected.permissions ?? [])].sort(),
    );
    expect([...(actual.host_permissions ?? [])].sort()).toEqual(
      [...(expected.host_permissions ?? [])].sort(),
    );
    expect(actual.optional_host_permissions).toEqual(
      expected.optional_host_permissions,
    );
    expect(actual.background).toEqual(expected.background);
    expect(actual.content_scripts).toEqual(expected.content_scripts);
  });
});

// ============================================================================
// F03 — Bridge v1 Shared Contract (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F03: Bridge v1 Shared Contract', () => {
  it('F03-T1-01: ExtensionMeDto schema validates full & empty-brand payloads', async () => {
    const { meSchema } = await loadBridgeContract();
    const full = makeSyntheticMe();
    const emptyBrands = makeSyntheticMe({ brands: [] });

    const r1 = meSchema.safeParse(full);
    expect(r1.success).toBe(true);
    expect(r1.data).toEqual(full);

    const r2 = meSchema.safeParse(emptyBrands);
    expect(r2.success).toBe(true);
    expect(r2.data).toEqual(emptyBrands);
  });

  it('F03-T1-02: ExtensionPendingTaskDto validates all 3 providers, 4 statuses, nullable hint & optional mime', async () => {
    const { pendingTaskSchema } = await loadBridgeContract();
    const samples: ExtensionPendingTaskDto[] = [
      makeSyntheticTask('ZHIHU_EXT', {
        status: 'DRAFT_VARIANT',
        targetUrlHint: 'https://www.zhihu.com/question/987654321',
      }),
      makeSyntheticTask('TOUTIAO_EXT', {
        status: 'READY_TO_PUBLISH',
        targetUrlHint: null,
        mediaAssets: [
          { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1' },
        ],
      }),
      makeSyntheticTask('SMZDM_EXT', { status: 'DRAFT_PUSHED' }),
      makeSyntheticTask('ZHIHU_EXT', { status: 'PUBLISHED' }),
    ];

    for (const sample of samples) {
      const parsed = pendingTaskSchema.safeParse(sample);
      expect(parsed.success).toBe(true);
    }
  });

  it('F03-T1-03: ExtensionConfirmPublishedInput validates with and without publishedAt', async () => {
    const { confirmPublishedInputSchema } = await loadBridgeContract();
    const withoutTime = confirmPublishedInputSchema.safeParse({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });
    expect(withoutTime.success).toBe(true);

    const withTime = confirmPublishedInputSchema.safeParse({
      publishedUrl: 'https://post.smzdm.com/p/aB3dE5fG7',
      publishedAt: '2026-11-24T05:00:00.000Z',
    });
    expect(withTime.success).toBe(true);
    expect((withTime.data as { publishedAt?: string }).publishedAt).toBe(
      '2026-11-24T05:00:00.000Z',
    );
  });

  it('F03-T1-04: ExtensionConfirmPublishedResult validates T+1/T+7/14/30 callback payload', async () => {
    const { confirmPublishedResultSchema } = await loadBridgeContract();
    const payload = {
      taskId: 'task_demo_01',
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_01',
      publishedUrl: 'https://www.toutiao.com/article/7123456789012345678',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };
    const parsed = confirmPublishedResultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(payload);
  });

  it('F03-T1-05: ApiEnvelope wraps and unwraps { code: 0, msg, data } for all 3 endpoints', async () => {
    const {
      createEnvelopeSchema,
      meSchema,
      pendingTaskSchema,
      confirmPublishedResultSchema,
    } = await loadBridgeContract();

    const envMe = createEnvelopeSchema(meSchema).safeParse({
      code: 0,
      msg: 'ok',
      data: makeSyntheticMe(),
    });
    expect(envMe.success).toBe(true);

    const envTask = createEnvelopeSchema(pendingTaskSchema).safeParse({
      code: 0,
      msg: 'ok',
      data: makeSyntheticTask('ZHIHU_EXT'),
    });
    expect(envTask.success).toBe(true);

    const envConfirm = createEnvelopeSchema(
      confirmPublishedResultSchema,
    ).safeParse({
      code: 0,
      msg: 'ok',
      data: {
        taskId: 'task_demo_01',
        status: 'PUBLISHED',
        publishRecordId: 'pub_demo_01',
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        crawlProbeQueued: true,
        retestMilestones: [7, 14, 30],
      },
    });
    expect(envConfirm.success).toBe(true);
  });
});

// ============================================================================
// F04 — Secure Local & Session Storage (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F04: Secure Local & Session Storage', () => {
  it('F04-T1-01: save & retrieve pairing state under chrome.storage.local["geomix.pairing.v1"]', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();
    const pairing = makeSyntheticPairing();

    await storage.savePairing(pairing);
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(true);
    const loaded = await storage.getPairing();
    expect(loaded).toEqual(pairing);
  });

  it('F04-T1-02: immediate wipe on unbind/logout clears chrome.storage.local', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(true);

    await storage.clearPairing();
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
    expect(await storage.getPairing()).toBeFalsy();
    expect(JSON.stringify(Object.fromEntries(env.localStore))).not.toContain(
      SYNTHETIC_TOKEN,
    );
  });

  it('F04-T1-03: save & retrieve PendingTabTask under chrome.storage.session["geomix.tabTasks.v1"]', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();
    const tabTask = makeSyntheticPendingTabTask(42, makeSyntheticTask('ZHIHU_EXT'));

    await storage.setTabTask(42, tabTask);
    const rawMap = env.sessionStore.get(TAB_TASKS_STORAGE_KEY) as
      | Record<string, unknown>
      | undefined;
    expect(rawMap?.['42']).toBeTruthy();

    const loaded = await storage.getTabTask(42);
    expect(loaded).toEqual(tabTask);
  });

  it('F04-T1-04: multi-tab isolation & selective tab removal', async () => {
    setupEnv();
    const storage = await loadStorageModule();
    const t101 = makeSyntheticPendingTabTask(101, makeSyntheticTask('ZHIHU_EXT'));
    const t102 = makeSyntheticPendingTabTask(102, makeSyntheticTask('TOUTIAO_EXT'));

    await storage.setTabTask(101, t101);
    await storage.setTabTask(102, t102);
    await storage.removeTabTask(101);

    expect(await storage.getTabTask(101)).toBeFalsy();
    expect(await storage.getTabTask(102)).toEqual(t102);
  });

  it('F04-T1-05: partial update of injectedAt & lastInjectReport preserves existing tab metadata', async () => {
    setupEnv();
    const storage = await loadStorageModule();
    const base = makeSyntheticPendingTabTask(
      55,
      makeSyntheticTask('SMZDM_EXT', { complianceChecklist: ['核对商品卡片'] }),
    );
    await storage.setTabTask(55, base);

    const report = {
      ok: true,
      stage: 'INJECTED' as const,
      uploadedImages: 2,
      failedImages: 0,
      message: '草稿已写入',
    };
    await storage.updateTabTask(55, {
      injectedAt: '2026-11-24T04:20:00.000Z',
      lastInjectReport: report,
    });

    const updated = await storage.getTabTask(55);
    expect(updated?.taskId).toBe(base.taskId);
    expect(updated?.brandId).toBe(base.brandId);
    expect(updated?.complianceChecklist).toEqual(['核对商品卡片']);
    expect(updated?.injectedAt).toBe('2026-11-24T04:20:00.000Z');
    expect(updated?.lastInjectReport).toEqual(report);
  });
});

// ============================================================================
// F05 — URL Allowlist & SSRF-Safe Validator (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F05: URL Allowlist & SSRF-Safe Validator', () => {
  it('F05-T1-01: canonicalizes Zhihu column & question-answer public URLs', async () => {
    const v = await loadUrlValidationModule();
    const col = v.canonicalizePublishedUrl(
      'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo&utm_medium=social#comments',
      'ZHIHU_EXT',
    );
    expect(col).toBe('https://zhuanlan.zhihu.com/p/123456789');

    const ans = v.canonicalizePublishedUrl(
      'https://www.zhihu.com/question/987654321/answer/1122334455/?utm_id=0#top',
      'ZHIHU_EXT',
    );
    expect(ans).toBe('https://www.zhihu.com/question/987654321/answer/1122334455');
  });

  it('F05-T1-02: canonicalizes Toutiao /article/<digits> and /i<digits> public URLs', async () => {
    const v = await loadUrlValidationModule();
    const a1 = v.canonicalizePublishedUrl(
      'https://www.toutiao.com/article/7123456789012345678/?log_from=demo#section',
      'TOUTIAO_EXT',
    );
    expect(a1).toEqual(expect.any(String));
    expect(a1).toMatch(/^https:\/\/www\.toutiao\.com\/article\/7123456789012345678\/?$/);
    expect(a1).not.toContain('?');
    expect(a1).not.toContain('#');

    const a2 = v.canonicalizePublishedUrl(
      'https://www.toutiao.com/i7123456789012345678?wid=12345',
      'TOUTIAO_EXT',
    );
    expect(a2).toEqual(expect.any(String));
    expect(a2).toMatch(/^https:\/\/www\.toutiao\.com\/i7123456789012345678\/?$/);
  });

  it('F05-T1-03: canonicalizes SMZDM alphanumeric /p/<id> public URLs', async () => {
    const v = await loadUrlValidationModule();
    const sm = v.canonicalizePublishedUrl(
      'https://post.smzdm.com/p/aB3dE5fG7/?send_by=999#comment',
      'SMZDM_EXT',
    );
    expect(sm).toEqual(expect.any(String));
    expect(sm).toMatch(/^https:\/\/post\.smzdm\.com\/p\/aB3dE5fG7\/?$/);
    expect(sm).not.toContain('send_by');
    expect(sm).not.toContain('#');
  });

  it('F05-T1-04: validates & normalizes public HTTPS GeoMix API baseUrl', async () => {
    const v = await loadUrlValidationModule();
    expect(v.validateApiBaseUrl(`${SYNTHETIC_API_BASE_URL}/`)).toBe(
      SYNTHETIC_API_BASE_URL,
    );
    expect(v.validateApiBaseUrl(`${SYNTHETIC_API_BASE_URL}/subpath/`)).toBe(
      `${SYNTHETIC_API_BASE_URL}/subpath`,
    );
    expect(
      v.validateApiBaseUrl(`${SYNTHETIC_SECONDARY_API_URL}:8443`),
    ).toBe(`${SYNTHETIC_SECONDARY_API_URL}:8443`);
  });

  it('F05-T1-05: validates public HTTPS media URLs and Zhihu question targetUrlHint', async () => {
    const v = await loadUrlValidationModule();
    const media = v.validateMediaUrl(`${SYNTHETIC_CDN_BASE_URL}/assets/demo-img-1.png?v=2`);
    expect(media).toBe(`${SYNTHETIC_CDN_BASE_URL}/assets/demo-img-1.png?v=2`);

    const hint = v.validateZhihuTargetUrlHint(
      'https://www.zhihu.com/question/987654321?sort=created',
    );
    expect(hint).toBe('https://www.zhihu.com/question/987654321');
  });
});

// ============================================================================
// F06 — Internal Extension Message Protocol (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F06: Internal Extension Message Protocol', () => {
  it('F06-T1-01: Popup <-> SW pairing & unbind messages round-trip cleanly', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const storage = await loadStorageModule();
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));

    // Initial status message emitted on Popup mount must pass messages.ts validator
    expect(env.runtimeMessages.length).toBeGreaterThanOrEqual(1);
    const statusMsg = env.runtimeMessages[0]!.payload;
    expect(msgs.validateMessage(statusMsg).ok).toBe(true);

    const countBeforePair = env.runtimeMessages.length;
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);
    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_SENTINEL_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
    });

    // Every wire message emitted by Popup during pairing & bootstrap must pass validateMessage
    const postPairMessages = env.runtimeMessages.slice(countBeforePair);
    expect(postPairMessages.length).toBeGreaterThanOrEqual(1);
    for (const entry of postPairMessages) {
      expect(msgs.validateMessage(entry.payload).ok).toBe(true);
    }
    expect(bridge.bridgeRequests.some((r) => r.url.includes('/api/v2/extension/me'))).toBe(
      true,
    );

    // Replaying real status message to SW must return paired public state with ZERO raw token
    const pairedStatusResp = await env.sendFromPopup(statusMsg);
    expect((pairedStatusResp as { ok?: unknown })?.ok).toBe(true);
    expect(JSON.stringify(pairedStatusResp)).toContain('DemoOperator');
    expect(JSON.stringify(pairedStatusResp)).not.toContain(SYNTHETIC_SENTINEL_TOKEN);
    const stored = await storage.getPairing();
    expect(stored?.baseUrl).toBe(SYNTHETIC_API_BASE_URL);
    expect(stored?.token).toBe(SYNTHETIC_SENTINEL_TOKEN);

    // Trigger real Popup -> SW unbind message
    const countBeforeUnbind = env.runtimeMessages.length;
    const unbindBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /解除绑定|解绑|解除配对|注销|退出|断开|unbind/i.test(b.textContent ?? ''),
    );
    expect(unbindBtn).toBeTruthy();
    fireEvent.click(unbindBtn!);

    await waitFor(async () => {
      expect(await storage.getPairing()).toBeFalsy();
      expect(() => findPopupInputs(container)).not.toThrow();
    });

    const unbindMessages = env.runtimeMessages.slice(countBeforeUnbind);
    expect(unbindMessages.length).toBeGreaterThanOrEqual(1);
    expect(msgs.validateMessage(unbindMessages[0]!.payload).ok).toBe(true);

    const afterUnbindStatus = await env.sendFromPopup(statusMsg);
    expect((afterUnbindStatus as { ok?: unknown })?.ok).toBe(true);
    expect(JSON.stringify(afterUnbindStatus)).not.toContain('DemoOperator');
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('F06-T1-02: Popup <-> SW task listing & draft dispatch payloads survive structuredClone intact', async () => {
    const env = setupEnv();
    const richTask = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_f06_rich_01',
      variantTitle: '结构化克隆完整回传验证标题',
      targetUrlHint: null,
      mediaAssets: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '实测图1',
          mime: 'image/png',
        },
      ],
      complianceChecklist: ['核对客观表述', '避免绝对化用语'],
    });
    const qaTask = makeSyntheticTask('ZHIHU_EXT', {
      taskId: 'task_f06_qa_02',
      variantTitle: '知乎问答目标提示任务',
      targetUrlHint: 'https://www.zhihu.com/question/55667788',
    });
    const bridge = setupBridge({ tasks: [richTask, qaTask] });

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = createZhihuColumnFixture().doc.body.innerHTML;
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('结构化克隆完整回传验证标题');
      expect(container.textContent).toContain('核对客观表述');
    });

    // Capture exact task-fetch wire message via real Refresh click
    const callsBeforeRefresh = env.runtimeMessages.length;
    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /刷新|refresh/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(callsBeforeRefresh);
    });

    const fetchMsg = env.runtimeMessages[callsBeforeRefresh]!.payload;
    expect(msgs.validateMessage(fetchMsg).ok).toBe(true);

    // Replay directly through SW (chrome-env applies structuredClone on both request & response)
    const rawResp = (await env.sendFromPopup(fetchMsg)) as {
      ok?: boolean;
      data?: { tasks?: ExtensionPendingTaskDto[] } | ExtensionPendingTaskDto[];
      tasks?: ExtensionPendingTaskDto[];
    };
    expect(rawResp.ok).toBe(true);
    const returnedTasks = Array.isArray(rawResp.data)
      ? rawResp.data
      : (rawResp.data?.tasks ?? rawResp.tasks ?? []);
    const roundTrippedRich = returnedTasks.find((t) => t.taskId === richTask.taskId);
    const roundTrippedQa = returnedTasks.find((t) => t.taskId === qaTask.taskId);
    expect(roundTrippedRich?.mediaAssets).toEqual(richTask.mediaAssets);
    expect(roundTrippedRich?.complianceChecklist).toEqual(richTask.complianceChecklist);
    expect(roundTrippedRich?.variantHtml).toBe(richTask.variantHtml);
    expect(roundTrippedQa?.targetUrlHint).toBe('https://www.zhihu.com/question/55667788');
    expect(
      bridge.bridgeRequests.filter((r) => r.url.includes('/api/v2/extension/tasks')).length,
    ).toBeGreaterThanOrEqual(2);

    // Capture exact draft-dispatch wire message via real 写入草稿箱 CTA click
    const callsBeforePush = env.runtimeMessages.length;
    const pushBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
      /写入草稿箱|推送草稿/.test(b.textContent ?? ''),
    );
    expect(pushBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(pushBtns[0]!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(callsBeforePush);
    });

    const pushMsg = env.runtimeMessages[callsBeforePush]!.payload;
    expect(msgs.validateMessage(pushMsg).ok).toBe(true);
    const pushSerialized = JSON.stringify(pushMsg);
    expect(pushSerialized).toContain(richTask.taskId);
    expect(pushSerialized).toContain(richTask.variantTitle);
    expect(pushSerialized).not.toContain(SYNTHETIC_TOKEN);
  });

  it('F06-T1-03: SW <-> Content INJECT_DRAFT & DraftInjectReport round-trip losslessly', async () => {
    const env = setupEnv();
    setupBridge();

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const fix = createZhihuColumnFixture();
    document.body.innerHTML = fix.doc.body.innerHTML;
    const spies = attachFixtureSpies(document);
    expect(spies.publishButtonsWatched).toBeGreaterThanOrEqual(2);

    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const task = makeSyntheticTask('ZHIHU_EXT', {
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '正常图', mime: 'image/png' },
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`,
          alt: '缺省图',
          mime: 'image/png',
        },
      ],
    });

    const report = await env.withContext({ kind: 'sw' }, () => invokeDispatcher(task));
    const failedDetails = report['failedImageDetails'] as
      | Array<{ url: string; alt: string; reason: string }>
      | undefined;

    expect(msgs.validateMessage({ type: 'UNKNOWN_INVALID_TYPE' }).ok).toBe(false);
    expect(env.contentBoundMessages.length).toBeGreaterThan(0);
    expect(
      env.contentBoundMessages.some((m) => JSON.stringify(m.payload).includes(task.taskId)),
    ).toBe(true);
    expect(report['stage']).toBe('PARTIAL_MEDIA_FAILED');
    expect(report['uploadedImages']).toBe(1);
    expect(report['failedImages']).toBe(1);
    expect(failedDetails?.length).toBe(1);
    expect(failedDetails?.[0]?.url).toContain('missing-404.png');
    expect(spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
  });

  it('F06-T1-04: Content <-> SW media relay supports binary/Base64 payload transfer', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const { createUploader } = await loadImageUploaderModule();

    // full-bytes.png returns all 256 byte values (0x00..0xFF) via MockBridge
    const expectedBytes = createFullByteRangePngBytes();
    const fix = createZhihuColumnFixture();
    const editorElement = fix.doc.querySelector<HTMLElement>('[contenteditable="true"]');
    const fileInput = fix.doc.querySelector<HTMLInputElement>('input[type="file"]');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });

    const uploader = createUploader();
    const result = await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () =>
        uploader.uploadAll(
          [
            {
              url: `${SYNTHETIC_CDN_BASE_URL}/media/full-bytes.png`,
              alt: '全字节校验图',
              mime: 'image/png',
            },
          ],
          { editorElement, fileInput },
        ),
    );

    expect(result.uploadedImages).toBe(1);
    expect(result.failedImages).toBe(0);
    expect(bridge.mediaRequests.length).toBe(1);
    expect(bridge.mediaRequests[0]!.url).toContain('/media/full-bytes.png');

    // Verify real Content -> SW runtime message was sent and passes messages.ts validator
    const contentMessages = env.runtimeMessages.filter((m) => m.senderKind === 'content');
    expect(contentMessages.length).toBeGreaterThanOrEqual(1);
    expect(msgs.validateMessage(contentMessages[0]!.payload).ok).toBe(true);

    // Verify reconstructed File delivered to DOM preserved every byte across Base64/binary IPC
    const deliveredFile = fix.spies.pastedFiles[0] ?? fix.spies.uploadedInputFiles[0];
    expect(deliveredFile).toBeTruthy();
    expect(deliveredFile!.size).toBe(expectedBytes.byteLength);
    expect(deliveredFile!.type).toBe('image/png');
    const receivedBytes = await readBlobBytes(deliveredFile!);
    expect(receivedBytes).toEqual(expectedBytes);
  });

  it('F06-T1-05: Content <-> SW CONFIRM_PUBLISHED message preserves result fields', async () => {
    const env = setupEnv();
    const bridge = setupBridge();

    const publishedUrl = 'https://zhuanlan.zhihu.com/p/123456789';
    setGlobalPageUrl(publishedUrl);
    const tab = await env.chrome.tabs.create({ url: publishedUrl });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const task = makeSyntheticTask('ZHIHU_EXT', { taskId: 'task_demo_zhihu_01' });
    await storage.setTabTask(tab.id!, makeSyntheticPendingTabTask(tab.id!, task));

    env.setContext({ kind: 'content', tabId: tab.id!, url: publishedUrl });
    env.updateTabUrl(tab.id!, publishedUrl, 'complete');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    );
    expect(cta).toBeTruthy();
    fireEvent.click(cta!);

    await waitFor(() => {
      expect(bridge.publishRecords.length).toBe(1);
    });

    expect(bridge.publishRecords[0]).toMatchObject({
      taskId: 'task_demo_zhihu_01',
      status: 'PUBLISHED',
      publishedUrl,
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    });

    const confirmMsgEntry = env.runtimeMessages.find(
      (m) =>
        m.senderKind === 'content' && JSON.stringify(m.payload).includes(publishedUrl),
    );
    expect(confirmMsgEntry).toBeTruthy();
    expect(msgs.validateMessage(confirmMsgEntry!.payload).ok).toBe(true);

    await waitFor(() => {
      expect(sr.textContent ?? '').toMatch(/T\+1|7.*14.*30|追踪|已回传/);
    });
    env.assertZeroTokenLeakage(SYNTHETIC_TOKEN);
  });
});

// ============================================================================
// F07 — Bridge v1 HTTP Client (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F07: Bridge v1 HTTP Client', () => {
  it('F07-T1-01: GET /api/v2/extension/me sends exact headers and unwraps ExtensionMeDto', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
      extensionVersion: '0.1.0',
    });

    const me = await client.getMe();
    expect(me.nickname).toBe('DemoOperator');
    expect(me.brands.length).toBeGreaterThan(0);

    const req = bridge.bridgeRequests[0];
    expect(req?.url).toBe(`${SYNTHETIC_API_BASE_URL}/api/v2/extension/me`);
    expect(req?.method).toBe('GET');
    expect(req?.headers['authorization']).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
    expect(req?.headers['x-geomix-extension-version']).toBe('0.1.0');
    expect(req?.headers['accept']).toContain('application/json');
  });

  it('F07-T1-02: GET /api/v2/extension/tasks applies default status and optional brandId/provider filters', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    const all = await client.listTasks();
    expect(all.length).toBe(3);
    const firstUrl = new URL(bridge.bridgeRequests[0]!.url);
    expect(firstUrl.pathname).toBe('/api/v2/extension/tasks');
    expect(firstUrl.searchParams.get('status')).toContain('DRAFT_VARIANT');
    expect(firstUrl.searchParams.get('status')).toContain('READY_TO_PUBLISH');

    const filtered = await client.listTasks({
      brandId: SYNTHETIC_BRAND_ALPHA.brandId,
      provider: 'ZHIHU_EXT',
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.provider).toBe('ZHIHU_EXT');
    const secondUrl = new URL(bridge.bridgeRequests[1]!.url);
    expect(secondUrl.searchParams.get('brandId')).toBe(
      SYNTHETIC_BRAND_ALPHA.brandId,
    );
    expect(secondUrl.searchParams.get('provider')).toBe('ZHIHU_EXT');
  });

  it('F07-T1-03: GET /api/v2/extension/tasks normalizes { items: [...] } compatibility wrapper', async () => {
    setupBridge({ tasksEnvelopeMode: 'items' });
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    const items = await client.listTasks();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(3);
  });

  it('F07-T1-04: POST confirm-published sends deterministic Idempotency-Key & canonical URL', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    const r1 = await client.confirmPublished('task_demo_zhihu_01', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789/',
    });
    const r2 = await client.confirmPublished('task_demo_zhihu_01', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });
    const r3 = await client.confirmPublished('task_demo_toutiao_01', {
      publishedUrl: 'https://www.toutiao.com/i7123456789012345678',
    });

    expect(r1.status).toBe('PUBLISHED');
    expect(r1.retestMilestones).toEqual([7, 14, 30]);
    expect(r1.publishRecordId).toBe(r2.publishRecordId);

    const k1 = bridge.bridgeRequests[0]!.headers['idempotency-key'];
    const k2 = bridge.bridgeRequests[1]!.headers['idempotency-key'];
    const k3 = bridge.bridgeRequests[2]!.headers['idempotency-key'];
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2);
    expect(k3).not.toBe(k1);

    const sentBody = JSON.parse(bridge.bridgeRequests[0]!.bodyText ?? '{}') as {
      publishedUrl: string;
    };
    expect(sentBody.publishedUrl).toBe('https://zhuanlan.zhihu.com/p/123456789');
    expect(bridge.bridgeRequests[0]!.headers['content-type']).toContain(
      'application/json',
    );
  });

  it('F07-T1-05: thin-endpoint allowlist strictly limited to 3 Bridge v1 routes', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    await client.getMe();
    await client.listTasks();
    await client.confirmPublished('task_demo_zhihu_01', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });

    expect(bridge.disallowedApiRoutes).toEqual([]);
    expect(bridge.bridgeRequests.length).toBe(3);
    for (const req of bridge.bridgeRequests) {
      const p = new URL(req.url).pathname;
      expect(
        p === '/api/v2/extension/me' ||
          p === '/api/v2/extension/tasks' ||
          /^\/api\/v2\/extension\/tasks\/[^/]+\/confirm-published$/.test(p),
      ).toBe(true);
    }
  });
});

// ============================================================================
// F08 — Popup Token Pairing & Account Status UI (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F08: Popup Token Pairing & Account Status UI', () => {
  it('F08-T1-01: unpaired initial render shows pairing form with masked token input', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      const { tokenInput, urlInput } = findPopupInputs(container);
      expect(urlInput).toBeTruthy();
      expect(tokenInput.type).toBe('password');
    });
    expect(container.textContent).not.toContain('写入草稿箱');
  });

  it('F08-T1-02: successful pairing requests optional_host_permissions, verifies /me, and shows paired view', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
    });
    expect(
      env.permissionRequests.some((r) =>
        (r.origins ?? []).includes(`${SYNTHETIC_API_BASE_URL}/*`),
      ),
    ).toBe(true);
    expect(
      bridge.bridgeRequests.some((r) => r.url.endsWith('/api/v2/extension/me')),
    ).toBe(true);
  });

  it('F08-T1-03: account summary displays nickname, tokenLabel, tokenPrefix, expiresAt & CN brands', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
    });
    expect(container.textContent).toContain('Demo Extension Key');
    expect(container.textContent).toContain('gmext_demo_');
    expect(container.textContent).toMatch(/2027/);
    expect(container.textContent).toMatch(/示例品牌A|DemoBrandAlpha/);
  });

  it('F08-T1-04: persisted session auto-restores on Popup reopen & fetches pending tasks', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });
    expect(
      bridge.bridgeRequests.some((r) =>
        r.url.includes('/api/v2/extension/tasks'),
      ),
    ).toBe(true);
  });

  it('F08-T1-05: one-click Unbind clears stored credentials and resets to pairing form', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
    });

    const unbindBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /解除绑定|解绑|解除配对|注销|退出|断开|unbind/i.test(b.textContent ?? ''),
    );
    expect(unbindBtn).toBeTruthy();
    fireEvent.click(unbindBtn!);

    await waitFor(async () => {
      expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
      const { tokenInput } = findPopupInputs(container);
      expect(tokenInput.value).toBe('');
    });
  });
});

// ============================================================================
// F09 — Popup Pending Task Queue UI (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F09: Popup Pending Task Queue UI', () => {
  async function renderPairedPopup() {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const view = render(React.createElement(App));
    await waitFor(() => {
      expect(view.container.textContent).toContain('示例品牌A 深度实测报告');
    });
    return { env, bridge, view };
  }

  it('F09-T1-01: renders all L2_EXTENSION task fields including complianceChecklist', async () => {
    const { view } = await renderPairedPopup();
    const text = view.container.textContent ?? '';
    expect(text).toContain('示例品牌A 深度实测报告');
    expect(text).toContain('示例品牌B 选购避坑与实测参数解析');
    expect(text).toContain('示例品牌A 横向对比评测');
    expect(text).toContain('核对数据来源与测试环境');
    expect(text).toContain('人工核对商品卡片链接');

    const ctaBtns = Array.from(view.container.querySelectorAll('button')).filter(
      (b) => /写入草稿箱/.test(b.textContent ?? ''),
    );
    expect(ctaBtns.length).toBeGreaterThanOrEqual(3);
  });

  it('F09-T1-02: brand filter isolates tasks by CN brand and resets to All', async () => {
    const { view } = await renderPairedPopup();
    const selects = Array.from(view.container.querySelectorAll('select'));
    const brandSelect = selects.find((s) =>
      Array.from(s.options).some(
        (o) =>
          o.value === SYNTHETIC_BRAND_ALPHA.brandId ||
          /示例品牌A|DemoBrandAlpha/.test(o.textContent ?? ''),
      ),
    );
    expect(brandSelect).toBeTruthy();
    const alphaOpt = Array.from(brandSelect!.options).find(
      (o) =>
        o.value === SYNTHETIC_BRAND_ALPHA.brandId ||
        /示例品牌A|DemoBrandAlpha/.test(o.textContent ?? ''),
    )!;
    fireEvent.change(brandSelect!, { target: { value: alphaOpt.value } });

    await waitFor(() => {
      expect(view.container.textContent).toContain('示例品牌A 深度实测报告');
      expect(view.container.textContent).not.toContain(
        '示例品牌B 选购避坑与实测参数解析',
      );
    });

    const allOpt = Array.from(brandSelect!.options).find(
      (o) => o.value === '' || o.value === 'ALL' || /全部/.test(o.textContent ?? ''),
    );
    expect(allOpt).toBeTruthy();
    fireEvent.change(brandSelect!, { target: { value: allOpt!.value } });
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        '示例品牌B 选购避坑与实测参数解析',
      );
    });
  });

  it('F09-T1-03: platform filter combines cleanly with brand filter', async () => {
    const { view } = await renderPairedPopup();
    const selects = Array.from(view.container.querySelectorAll('select'));
    const platformSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'SMZDM_EXT'),
    );
    expect(platformSelect).toBeTruthy();

    fireEvent.change(platformSelect!, { target: { value: 'SMZDM_EXT' } });
    await waitFor(() => {
      expect(view.container.textContent).toContain('示例品牌A 横向对比评测');
      expect(view.container.textContent).not.toContain('示例品牌A 深度实测报告');
      expect(view.container.textContent).not.toContain(
        '示例品牌B 选购避坑与实测参数解析',
      );
    });
  });

  it('F09-T1-04: clicking 写入草稿箱 dispatches live task to SW and renders INJECTED feedback', async () => {
    const { env, view } = await renderPairedPopup();
    // Attach content-script responder for any newly created tab
    env.chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) {
        env.attachTabContentListener(tab.id, (msg, _s, sendResponse) => {
          const m = msg as { type?: string };
          if (m?.type && /PING|READY|HEALTH/i.test(m.type)) {
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
            message: '草稿已写入，请人工审阅后手动发布',
          };
          sendResponse({ ...report, ok: true, data: report });
        });
      }
    });

    const firstPushBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => /写入草稿箱/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(firstPushBtn);

    await waitFor(() => {
      const txt = view.container.textContent ?? '';
      expect(txt).toMatch(/草稿已写入|INJECTED|已写入/);
    });
  });

  it('F09-T1-05: manual refresh re-fetches queue and updates UI with new task', async () => {
    const { bridge, view } = await renderPairedPopup();
    const initialCalls = bridge.bridgeRequests.filter((r) =>
      r.url.includes('/api/v2/extension/tasks'),
    ).length;

    bridge.setTasks([
      makeSyntheticTask('ZHIHU_EXT'),
      makeSyntheticTask('TOUTIAO_EXT'),
      makeSyntheticTask('SMZDM_EXT'),
      makeSyntheticTask('ZHIHU_EXT', {
        taskId: 'task_demo_zhihu_new',
        variantTitle: '新增刷新验证草稿标题',
      }),
    ]);

    const refreshBtn = Array.from(view.container.querySelectorAll('button')).find(
      (b) => /刷新|refresh/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);

    await waitFor(() => {
      expect(view.container.textContent).toContain('新增刷新验证草稿标题');
    });
    const afterCalls = bridge.bridgeRequests.filter((r) =>
      r.url.includes('/api/v2/extension/tasks'),
    ).length;
    expect(afterCalls).toBeGreaterThan(initialCalls);
  });
});

// ============================================================================
// F10 — PlatformDraftAdapter Protocol & Registry (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F10: PlatformDraftAdapter Protocol & Registry', () => {
  it('F10-T1-01: registry resolves all 3 MVP providers (ZHIHU_EXT, TOUTIAO_EXT, SMZDM_EXT)', async () => {
    await loadAdapterTypesModule();
    const reg = await loadAdapterRegistryModule();
    const zh = reg.getByProvider('ZHIHU_EXT');
    const tt = reg.getByProvider('TOUTIAO_EXT');
    const sm = reg.getByProvider('SMZDM_EXT');

    expect(zh?.provider).toBe('ZHIHU_EXT');
    expect(tt?.provider).toBe('TOUTIAO_EXT');
    expect(sm?.provider).toBe('SMZDM_EXT');
    expect(reg.listAll().length).toBe(3);
  });

  it('F10-T1-02: every registered adapter satisfies full PlatformDraftAdapter contract', async () => {
    const reg = await loadAdapterRegistryModule();
    const all = reg.listAll();
    expect(all.length).toBe(3);
    for (const adapter of all) {
      assertValidPlatformAdapter(adapter, 'src/adapters/registry.ts');
    }
  });

  it('F10-T1-03: exact PRD §4.2 editorEntryUrl values on all 3 adapters', async () => {
    const reg = await loadAdapterRegistryModule();
    expect(reg.getByProvider('ZHIHU_EXT')?.editorEntryUrl).toBe(
      'https://zhuanlan.zhihu.com/write',
    );
    expect(reg.getByProvider('TOUTIAO_EXT')?.editorEntryUrl).toBe(
      'https://mp.toutiao.com/profile_v4/graphic/publish',
    );
    expect(reg.getByProvider('SMZDM_EXT')?.editorEntryUrl).toBe(
      'https://post.smzdm.com/tougao/',
    );
  });

  it('F10-T1-04: URL-based adapter lookup maps editor & published URLs to right platform', async () => {
    const reg = await loadAdapterRegistryModule();
    expect(reg.getByUrl('https://zhuanlan.zhihu.com/p/123')?.provider).toBe(
      'ZHIHU_EXT',
    );
    expect(
      reg.getByUrl('https://www.zhihu.com/question/1/answer/2')?.provider,
    ).toBe('ZHIHU_EXT');
    expect(
      reg.getByUrl('https://mp.toutiao.com/profile_v4/graphic/publish')
        ?.provider,
    ).toBe('TOUTIAO_EXT');
    expect(reg.getByUrl('https://www.toutiao.com/i7123456789')?.provider).toBe(
      'TOUTIAO_EXT',
    );
    expect(reg.getByUrl('https://post.smzdm.com/p/aB3dE5fG7')?.provider).toBe(
      'SMZDM_EXT',
    );
  });

  it('F10-T1-05: zero cross-adapter coupling or shared mutable state under interleaved calls', async () => {
    const reg = await loadAdapterRegistryModule();
    const zh = reg.getByProvider('ZHIHU_EXT')!;
    const tt = reg.getByProvider('TOUTIAO_EXT')!;
    const sm = reg.getByProvider('SMZDM_EXT')!;

    const zhFix = createZhihuColumnFixture();
    const ttFix = createToutiaoEditorFixture();
    const smFix = createSmzdmEditorFixture();

    expect(zh.isLoggedInEditor(zhFix.doc, zhFix.url)).toBe(true);
    expect(tt.isLoggedInEditor(ttFix.doc, ttFix.url)).toBe(true);
    expect(sm.isLoggedInEditor(smFix.doc, smFix.url)).toBe(true);
    expect(zh.isLoggedInEditor(ttFix.doc, ttFix.url)).toBe(false);
    expect(tt.isLoggedInEditor(smFix.doc, smFix.url)).toBe(false);
    expect(sm.isLoggedInEditor(zhFix.doc, zhFix.url)).toBe(false);
  });
});

// ============================================================================
// F11 — Background Task Dispatcher & Tab Router (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F11: Background Task Dispatcher & Tab Router', () => {
  function attachReadyInjectResponder(env: ChromeMv3Controller) {
    env.chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) {
        env.attachTabContentListener(tab.id, (msg, _s, sendResponse) => {
          const m = msg as { type?: string };
          if (m?.type && /PING|READY|HEALTH/i.test(m.type)) {
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
            message: 'ok',
          };
          sendResponse({ ...report, ok: true, data: report });
        });
      }
    });
  }

  it('F11-T1-01: opens platform editorEntryUrl tab and persists tabId <-> PendingTabTask in chrome.storage.session', async () => {
    const env = setupEnv();
    attachReadyInjectResponder(env);

    const task = makeSyntheticTask('TOUTIAO_EXT', { targetUrlHint: null });
    await invokeDispatcher(task);

    expect(env.chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://mp.toutiao.com/profile_v4/graphic/publish',
      }),
    );
    const sessionMap = env.sessionStore.get(TAB_TASKS_STORAGE_KEY) as
      | Record<string, { taskId: string; provider: string }>
      | undefined;
    expect(sessionMap).toBeTruthy();
    const values = Object.values(sessionMap!);
    expect(values.some((v) => v.taskId === task.taskId && v.provider === 'TOUTIAO_EXT')).toBe(true);
  });

  it('F11-T1-02: routes ZHIHU_EXT task with valid question targetUrlHint to that question page', async () => {
    const env = setupEnv();
    attachReadyInjectResponder(env);

    const hint = 'https://www.zhihu.com/question/987654321';
    const task = makeSyntheticTask('ZHIHU_EXT', { targetUrlHint: hint });
    await invokeDispatcher(task);

    expect(env.chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: hint }),
    );
  });

  it('F11-T1-03: reuses an existing idle matching editor tab instead of spawning duplicates', async () => {
    const env = setupEnv({
      initialTabs: [
        {
          id: 77,
          url: 'https://post.smzdm.com/tougao/',
          active: false,
          status: 'complete',
        },
      ],
    });
    env.attachTabContentListener(77, (msg, _s, sendResponse) => {
      const m = msg as { type?: string };
      if (m?.type && /PING|READY|HEALTH/i.test(m.type)) {
        sendResponse({
          ok: true,
          ready: true,
          data: { ready: true, href: 'https://post.smzdm.com/tougao/' },
        });
        return;
      }
      const report = {
        ok: true,
        stage: 'INJECTED' as const,
        uploadedImages: 2,
        failedImages: 0,
        message: 'ok',
      };
      sendResponse({ ...report, ok: true, data: report });
    });

    await invokeDispatcher(makeSyntheticTask('SMZDM_EXT'));
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
    expect(env.chrome.tabs.update).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ active: true }),
    );
  });

  it('F11-T1-04: waits for readiness, sends INJECT_DRAFT, and records lastInjectReport in session storage', async () => {
    const env = setupEnv();
    attachReadyInjectResponder(env);

    const task = makeSyntheticTask('ZHIHU_EXT');
    const report = await invokeDispatcher(task);
    expect(report['ok']).toBe(true);
    expect(report['stage']).toBe('INJECTED');

    const storage = await loadStorageModule();
    const tabId = Array.from(env.tabs.keys())[0]!;
    const persisted = await storage.getTabTask(tabId);
    expect(persisted?.lastInjectReport?.stage).toBe('INJECTED');
    expect(persisted?.injectedAt).toBeTruthy();
  });

  it('F11-T1-05: survives SW hibernation via chrome.storage.session and cleans up on tabs.onRemoved', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const tab = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/write',
    });
    const tabId = tab.id!;
    const storage = await loadStorageModule();
    await storage.setTabTask(
      tabId,
      makeSyntheticPendingTabTask(tabId, makeSyntheticTask('ZHIHU_EXT')),
    );

    const receivedAfterWake: unknown[] = [];
    env.attachTabContentListener(tabId, (msg, _s, sendResponse) => {
      receivedAfterWake.push(msg);
      sendResponse({ ok: true });
    });

    // True cold restart: wipe SW memory, preserve chrome.storage.session
    await env.simulateServiceWorkerRestart(() => bootBackgroundServiceWorker());

    env.updateTabUrl(tabId, 'https://zhuanlan.zhihu.com/p/123456789', 'complete');
    await waitFor(() => {
      expect(receivedAfterWake.length).toBeGreaterThan(0);
    });

    env.removeTab(tabId);
    await waitFor(async () => {
      const freshStorage = await loadStorageModule();
      expect(await freshStorage.getTabTask(tabId)).toBeFalsy();
    });
  });
});

// ============================================================================
// F12 — Anti-Hotlink Media Fetcher (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F12: Anti-Hotlink Media Fetcher', () => {
  it('F12-T1-01: fetches valid HTTPS PNG/JPEG/WebP asset with intact metadata', async () => {
    setupBridge();
    const res = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
      alt: '主图',
      mime: 'image/png',
    });
    expect(res.ok).toBe(true);
    expect(res.mime).toBe('image/png');
    expect(res.byteLength).toBe(128);
    expect(res.filename).toMatch(/\.png$/i);
    expect(res.bytes).toEqual(createMinimalPngBytes());
  });

  it('F12-T1-02: enforces strict concurrency ceiling <= 2 across batch fetches', async () => {
    await loadMediaFetcherModule();
    const bridge = setupBridge({ deferConcurrentMedia: true });
    const assets = Array.from({ length: 5 }, (_, i) => ({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/concurrent-${i + 1}.png`,
      alt: `并发图${i + 1}`,
      mime: 'image/png',
    }));

    const batchPromise = invokeMediaFetcherBatch(assets);

    // Wait for initial batch to reach fetch and drain deferreds deterministically
    for (let step = 0; step < 25; step += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      expect(bridge.getMaxObservedMediaConcurrency()).toBeLessThanOrEqual(2);
      if (bridge.deferredMedia.length > 0) {
        bridge.releaseNextDeferredMedia();
      }
    }
    bridge.releaseAllDeferredMedia();

    const results = await batchPromise;
    expect(results.length).toBe(5);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(bridge.getMaxObservedMediaConcurrency()).toBeLessThanOrEqual(2);
    expect(bridge.getMaxObservedMediaConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it('F12-T1-03: exact binary fidelity for arbitrary byte values 0x00–0xFF', async () => {
    setupBridge();
    const expected = createFullByteRangePngBytes();
    const res = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/full-bytes.png`,
      alt: '全字节图',
      mime: 'image/png',
    });
    expect(res.ok).toBe(true);
    expect(res.bytes).toEqual(expected);
  });

  it('F12-T1-04: accepts valid streamed response without Content-Length header (<= 10MB)', async () => {
    setupBridge();
    const res = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/streamed-valid.jpg`,
      alt: '流式图片',
      mime: 'image/jpeg',
    });
    expect(res.ok).toBe(true);
    expect(res.byteLength).toBe(4096);
    expect(res.bytes?.byteLength).toBe(4096);
  });

  it('F12-T1-05: safe MIME fallback when upstream returns application/octet-stream', async () => {
    setupBridge();
    const res = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/octet-stream.webp`,
      alt: '评测图',
      mime: 'image/webp',
    });
    expect(res.ok).toBe(true);
    expect(res.mime).toBe('image/webp');
  });
});

// ============================================================================
// F13 — Content Injection Runtime & LocalImageUploader (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F13: Content Injection Runtime & LocalImageUploader', () => {
  async function setupSwAndUploader() {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const tab = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/write',
    });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    const { createUploader } = await loadImageUploaderModule();
    return { env, bridge, tab, uploader: createUploader() };
  }

  it('F13-T1-01: reconstructs valid File objects from SW binary/Base64 relay', async () => {
    const { uploader } = await setupSwAndUploader();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    document.body.appendChild(fileInput);

    const res = await uploader.uploadAll(
      [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '图1',
          mime: 'image/png',
        },
      ],
      { fileInput },
    );

    expect(res.uploadedImages).toBe(1);
    expect(res.failedImages).toBe(0);
    const uploaded = fileInput.files?.item(0);
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded?.type).toBe('image/png');
    expect(uploaded?.size).toBe(128);
    expect(uploaded?.name).toMatch(/\.png$/i);
  });

  it('F13-T1-02: uploads via native <input type="file"> dispatching change/input events', async () => {
    const { uploader } = await setupSwAndUploader();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    document.body.appendChild(fileInput);

    const changeSpy = vi.fn();
    fileInput.addEventListener('change', changeSpy);

    const res = await uploader.uploadAll(
      [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`, alt: '图2', mime: 'image/jpeg' },
      ],
      { fileInput },
    );

    expect(res).toEqual({ uploadedImages: 2, failedImages: 0, failures: [] });
    expect(changeSpy).toHaveBeenCalled();
  });

  it('F13-T1-03: uploads via DataTransfer synthetic ClipboardEvent("paste") onto editorElement', async () => {
    const { uploader } = await setupSwAndUploader();
    const editorElement = document.createElement('div');
    editorElement.setAttribute('contenteditable', 'true');
    document.body.appendChild(editorElement);

    const pastedFiles: File[] = [];
    editorElement.addEventListener('paste', (ev) => {
      const ce = ev as ClipboardEvent;
      const files = ce.clipboardData?.files;
      if (files) {
        for (let i = 0; i < files.length; i += 1) {
          const f = files.item(i);
          if (f) pastedFiles.push(f);
        }
      }
    });

    const res = await uploader.uploadAll(
      [{ url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1', mime: 'image/png' }],
      { editorElement },
    );

    expect(res.uploadedImages).toBe(1);
    expect(res.failedImages).toBe(0);
    expect(pastedFiles.length).toBe(1);
    expect(pastedFiles[0]?.size).toBe(128);
  });

  it('F13-T1-04: partial failure degrades transparently without dropping failure metadata', async () => {
    const { uploader } = await setupSwAndUploader();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    document.body.appendChild(fileInput);

    const res = await uploader.uploadAll(
      [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '图1', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-header.png`, alt: '超大原图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`, alt: '图3', mime: 'image/jpeg' },
      ],
      { fileInput },
    );

    expect(res.uploadedImages).toBe(2);
    expect(res.failedImages).toBe(1);
    expect(res.failures.length).toBe(1);
    expect(res.failures[0]?.alt).toBe('超大原图');
    expect(res.failures[0]?.reason.length).toBeGreaterThan(0);
  });

  it('F13-T1-05: content runtime routes INJECT_DRAFT to matching adapter and surfaces partial-media notice', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = createZhihuColumnFixture().doc.body.innerHTML;
    const tab = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/write',
    });

    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const task = makeSyntheticTask('ZHIHU_EXT', {
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '正常图', mime: 'image/png' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`, alt: '失败配图', mime: 'image/png' },
      ],
    });

    const report = await sendInjectDraftToTab(env, tab.id!, task);

    expect(report).toBeTruthy();
    expect(report!['stage']).toBe('PARTIAL_MEDIA_FAILED');
    expect(report!['failedImages']).toBe(1);

    const hosts = findShadowHosts(document);
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    const sr = getShadowRootForHost(hosts[0]!);
    expect(sr?.textContent).toContain('失败配图');
  });
});

// ============================================================================
// F14 — Shadow DOM URL Capture & Partial-Media Bar (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F14: Shadow DOM URL Capture & Partial-Media Bar', () => {
  it('F14-T1-01: complete Shadow DOM isolation with :host { all: initial }', async () => {
    const ctrl = await loadUrlCaptureBarController();
    const tabTask = makeSyntheticPendingTabTask(100, makeSyntheticTask('ZHIHU_EXT'));
    ctrl.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      task: tabTask,
      onConfirm: async () => ({
        taskId: tabTask.taskId,
        status: 'PUBLISHED',
        publishRecordId: 'pub_demo_0001',
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        crawlProbeQueued: true,
        retestMilestones: [7, 14, 30],
      }),
    });

    const hosts = findShadowHosts(document);
    expect(hosts.length).toBe(1);
    const iso = assertShadowIsolation(
      document,
      hosts[0]!,
      '一键回传至 GeoMix',
    );
    expect(iso.hasHostReset).toBe(true);
    expect(iso.lightDomContainsShadowText).toBe(false);
    expect(document.querySelectorAll('button').length).toBe(0);
  });

  it('F14-T1-02: displays cleaned canonical URL, task title, and exact GeoMix CTA', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/write',
    });
    const storage = await loadStorageModule();
    const tabTask = makeSyntheticPendingTabTask(
      tab.id!,
      makeSyntheticTask('ZHIHU_EXT', { variantTitle: '示例品牌深度实测报告' }),
    );
    await storage.setTabTask(tab.id!, tabTask);

    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const dirtyPublishedUrl =
      'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#comments';
    env.setContext({ kind: 'content', tabId: tab.id!, url: dirtyPublishedUrl });
    navigateSpa('/p/123456789?utm_source=demo#comments', 'pushState');
    env.updateTabUrl(tab.id!, dirtyPublishedUrl);

    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!)!;
      expect(sr.textContent).toContain('https://zhuanlan.zhihu.com/p/123456789');
      expect(sr.textContent).not.toContain('utm_source=demo');
      expect(sr.textContent).not.toContain('#comments');
      expect(sr.textContent).toContain('示例品牌深度实测报告');
      const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes('一键回传至 GeoMix 开启 T+7/14/30 追踪'),
      );
      expect(cta).toBeTruthy();
    });
  });

  it('F14-T1-03: clicking CTA invokes confirm callback and displays T+1 / T+7/14/30 confirmation', async () => {
    const ctrl = await loadUrlCaptureBarController();
    const tabTask = makeSyntheticPendingTabTask(100, makeSyntheticTask('ZHIHU_EXT'));
    const onConfirm = vi.fn(async (url: string) => ({
      taskId: tabTask.taskId,
      status: 'PUBLISHED' as const,
      publishRecordId: 'pub_demo_0001',
      publishedUrl: url,
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    }));

    ctrl.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      task: tabTask,
      onConfirm,
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const cta = Array.from(sr.querySelectorAll('button')).find((b) =>
      /一键回传至 GeoMix/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(cta);

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
      const txt = sr.textContent ?? '';
      expect(txt).toMatch(/T\+1|7.*14.*30|追踪已开启|已回传/);
    });
  });

  it('F14-T1-04: SPA navigation (pushState / replaceState / popstate) triggers bar mount', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({
      url: 'https://zhuanlan.zhihu.com/write',
    });
    const storage = await loadStorageModule();
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
      url: 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#comments',
    });
    navigateSpa('/p/123456789?utm_source=demo#comments', 'pushState');

    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!);
      expect(sr?.textContent).toContain('https://zhuanlan.zhihu.com/p/123456789');
      expect(sr?.textContent).not.toContain('utm_source=demo');
      expect(sr?.textContent).not.toContain('#comments');
    });
  });

  it('F14-T1-05: partial-media failure notice inside Shadow DOM lists failed images & dismisses cleanly', async () => {
    const ctrl = await loadUrlCaptureBarController();
    ctrl.mountPartialMediaNotice({
      failedImages: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/forbidden-403.png`,
          alt: '参数对比图',
          reason: 'HTTP 403',
        },
      ],
    });

    const host = findShadowHosts(document)[0]!;
    const sr = getShadowRootForHost(host)!;
    expect(sr.textContent).toContain('参数对比图');
    expect(sr.textContent).toContain('HTTP 403');
    expect(document.body.textContent).not.toContain('参数对比图');

    const closeBtn = Array.from(sr.querySelectorAll('button')).find((b) =>
      /关闭|知道了|忽略|×|close|dismiss/i.test(b.textContent ?? ''),
    );
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(0);
    });
  });
});

// ============================================================================
// F15 — Zhihu Draft Adapter (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F15: Zhihu Draft Adapter (ZHIHU_EXT)', () => {
  it('F15-T1-01: authenticated editor detection on both Column /write and Question Answer page', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const colFix = createZhihuColumnFixture();
    const qaFix = createZhihuQuestionAnswerFixture('987654321');

    expect(adapter.provider).toBe('ZHIHU_EXT');
    expect(adapter.editorEntryUrl).toBe('https://zhuanlan.zhihu.com/write');
    expect(adapter.isLoggedInEditor(colFix.doc, colFix.url)).toBe(true);
    expect(adapter.isLoggedInEditor(qaFix.doc, qaFix.url)).toBe(true);
  });

  it('F15-T1-02: column /write injects title (React setter + input/change) and Draft.js HTML body', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    const task = makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');

    const titleEl = fix.doc.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(titleEl.value).toBe(task.variantTitle);
    expect(fix.spies.titleEvents).toContain('input');
    expect(
      fix.spies.pastedHtml.length > 0 ||
        (fix.doc.querySelector('[contenteditable="true"]')?.textContent ?? '').includes(
          '示例品牌A',
        ),
    ).toBe(true);
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
  });

  it('F15-T1-03: question answer mode injects answer body without requiring column title field', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuQuestionAnswerFixture('987654321');
    const task = makeSyntheticTask('ZHIHU_EXT', {
      targetUrlHint: 'https://www.zhihu.com/question/987654321',
      mediaAssets: [],
    });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');
    expect(
      fix.spies.pastedHtml.length > 0 ||
        (fix.doc.querySelector('[contenteditable="true"]')?.textContent ?? '').includes(
          '示例品牌A',
        ),
    ).toBe(true);
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
  });

  it('F15-T1-04: relays media assets through LocalImageUploader and reports counts', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    const task = makeSyntheticTask('ZHIHU_EXT');
    const uploadSpy = vi.fn(async () => ({
      uploadedImages: 2,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(
      fix.doc,
      task,
      createSimpleMockUploader(uploadSpy),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(report.uploadedImages).toBe(2);
    expect(report.failedImages).toBe(0);
  });

  it('F15-T1-05: extracts and canonicalizes both Zhihu column and question-answer public URLs', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    expect(
      adapter.extractPublishedUrl(
        new URL('https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#top'),
        fix.doc,
      ),
    ).toBe('https://zhuanlan.zhihu.com/p/123456789');

    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.zhihu.com/question/987654321/answer/1122334455?utm_id=1'),
        fix.doc,
      ),
    ).toBe('https://www.zhihu.com/question/987654321/answer/1122334455');
  });
});

// ============================================================================
// F16 — Toutiao Draft Adapter (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F16: Toutiao Draft Adapter (TOUTIAO_EXT)', () => {
  it('F16-T1-01: authenticated editor detection on mp.toutiao.com/profile_v4/graphic/publish', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    expect(adapter.provider).toBe('TOUTIAO_EXT');
    expect(adapter.editorEntryUrl).toBe(
      'https://mp.toutiao.com/profile_v4/graphic/publish',
    );
    expect(adapter.isLoggedInEditor(fix.doc, fix.url)).toBe(true);
  });

  it('F16-T1-02: injects title and ProseMirror/rich-text formatted body', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    const task = makeSyntheticTask('TOUTIAO_EXT', { mediaAssets: [] });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');

    const titleEl = fix.doc.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(titleEl.value).toBe(task.variantTitle);
    const bodyText =
      fix.doc.querySelector('.ProseMirror')?.textContent ?? '';
    expect(
      fix.spies.pastedHtml.length > 0 || bodyText.includes('三大核心选购维度'),
    ).toBe(true);
  });

  it('F16-T1-03: relays images via LocalImageUploader using native file input / editor paste', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    const task = makeSyntheticTask('TOUTIAO_EXT');
    const uploadSpy = vi.fn(async () => ({
      uploadedImages: 2,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(
      fix.doc,
      task,
      createSimpleMockUploader(uploadSpy),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(report.uploadedImages).toBe(2);
    expect(report.failedImages).toBe(0);
  });

  it('F16-T1-04: optional 存草稿 permitted while keeping article unpublished', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    const task = makeSyntheticTask('TOUTIAO_EXT', { mediaAssets: [] });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(fix.spies.draftButtonClicks.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('F16-T1-05: extracts and canonicalizes both /article/<digits> and /i<digits> public URLs', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.toutiao.com/article/7123456789012345678/?log_from=demo#top'),
        fix.doc,
      ),
    ).toBe('https://www.toutiao.com/article/7123456789012345678');

    expect(
      adapter.extractPublishedUrl(
        new URL('https://www.toutiao.com/i7123456789012345678/?wid=1'),
        fix.doc,
      ),
    ).toBe('https://www.toutiao.com/i7123456789012345678');
  });
});

// ============================================================================
// F17 — SMZDM Draft Adapter (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F17: SMZDM Draft Adapter (SMZDM_EXT)', () => {
  it('F17-T1-01: authenticated editor detection on https://post.smzdm.com/tougao/', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    expect(adapter.provider).toBe('SMZDM_EXT');
    expect(adapter.editorEntryUrl).toBe('https://post.smzdm.com/tougao/');
    expect(adapter.isLoggedInEditor(fix.doc, fix.url)).toBe(true);
  });

  it('F17-T1-02: preserves parameter comparison <table> and measured-data blocks in editor DOM', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const task = makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('INJECTED');

    const editor = fix.doc.querySelector('[contenteditable="true"]')!;
    const htmlEvidence = `${editor.innerHTML}\n${fix.spies.pastedHtml.join('\n')}`;
    expect(htmlEvidence).toContain('<table');
    expect(htmlEvidence).toContain('<th>参数</th>');
    expect(htmlEvidence).toContain('<td>12小时</td>');
    expect(htmlEvidence).toContain('42 分钟');
  });

  it('F17-T1-03: relays media assets via LocalImageUploader and reports counts', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const task = makeSyntheticTask('SMZDM_EXT');
    const uploadSpy = vi.fn(async () => ({
      uploadedImages: 2,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(
      fix.doc,
      task,
      createSimpleMockUploader(uploadSpy),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(report.uploadedImages).toBe(2);
    expect(report.failedImages).toBe(0);
  });

  it('F17-T1-04: emits explicit operator reminders for product cards & compliance disclosure', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const task = makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] });
    const uploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    const report = await adapter.injectDraft(fix.doc, task, uploader);
    expect(Array.isArray(report.operatorReminders)).toBe(true);
    expect((report.operatorReminders ?? []).length).toBeGreaterThan(0);
    const joined = `${(report.operatorReminders ?? []).join(' ')} ${report.message}`;
    expect(joined).toContain('商品卡片');
    expect(joined).toMatch(/披露|合规/);
  });

  it('F17-T1-05: extracts and canonicalizes SMZDM alphanumeric public URL /p/[a-zA-Z0-9]+', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    expect(
      adapter.extractPublishedUrl(
        new URL('https://post.smzdm.com/p/aB3dE5fG7/?send_by=demo&utm_source=1#comments'),
        fix.doc,
      ),
    ).toBe('https://post.smzdm.com/p/aB3dE5fG7');
  });
});

// ============================================================================
// F18 — Manifest & Redline Static Security Guard (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F18: Manifest & Redline Static Security Guard', () => {
  it(
    'F18-T1-01: tests/manifest-security.spec.ts exists and passes cleanly in Vitest',
    () => {
      const guardPath = resolveRepoPath('tests/manifest-security.spec.ts');
      if (!fs.existsSync(guardPath)) {
        throw new PublicSurfaceError(
          'MISSING_FILE',
          'tests/manifest-security.spec.ts',
          'M6 manifest security guard test file is missing',
        );
      }
      const output = execFileSync(
        'pnpm',
        ['exec', 'vitest', 'run', 'tests/manifest-security.spec.ts'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 55_000,
        },
      );
      expect(output).toMatch(/passed/i);
    },
    60_000,
  );

  it('F18-T1-02: built dist/manifest.json passes MV3 least-privilege assertions', () => {
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
  });

  it('F18-T1-03: static scan of src/** confirms zero document.cookie or chrome.cookies access', () => {
    const files = scanSourceFiles('src');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.content, `Forbidden cookie access in ${f.relPath}`).not.toMatch(
        /document\s*\.\s*cookie|document\s*\[\s*['"]cookie['"]\s*\]|chrome\s*\.\s*cookies/,
      );
    }
  });

  it('F18-T1-04: static scan of src/** confirms zero localStorage writes and zero raw token console.* prints', () => {
    const files = scanSourceFiles('src');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.content, `Forbidden localStorage in ${f.relPath}`).not.toMatch(
        /\blocalStorage\b/,
      );
      expect(f.content, `Token console print in ${f.relPath}`).not.toMatch(
        /console\.(log|info|warn|error|debug)\s*\([^)]*(gmext_|Authorization|\btoken\b)/i,
      );
    }
  });

  it('F18-T1-05: static scan of src/adapters/** and src/content/** confirms zero auto-publish click logic', () => {
    const adapterFiles = scanSourceFiles('src/adapters');
    const contentFiles = scanSourceFiles('src/content');
    expect(adapterFiles.length).toBeGreaterThan(0);
    expect(contentFiles.length).toBeGreaterThan(0);

    const stripComments = (code: string): string =>
      code.replace(
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
        (_m, strLiteral: string | undefined) => strLiteral ?? ' ',
      );

    const PUBLISH_LABELS =
      '(?:发布文章|发布回答|预览并发布|提交审核|确认发布|立即发布|发布)';
    const CLICK_ACTION =
      '(?:(?:\\?\\.|\\.)\\s*(?:click\\s*\\(|dispatchEvent\\s*\\(\\s*new\\s+(?:MouseEvent|PointerEvent|Event)\\s*\\(\\s*[\'"]click[\'"]))';
    const NEG_CHAIN =
      '(?:[\\w$]+(?:\\(\\))?\\s*(?:\\?\\.|\\.)\\s*)*[\\w$]+(?:\\(\\))?';

    const helperClickPattern = new RegExp(
      `\\b(?:click\\w*|triggerClick\\w*|press\\w*)\\s*\\([^;)]*['"\`]${PUBLISH_LABELS}['"\`]`,
      'i',
    );
    const selectorClickPattern = new RegExp(
      `querySelector(?:All)?\\s*\\([^)]*(?:publish-btn-submit|publish-btn-preview|publish-btn-confirm|PublishPanel|AnswerForm-submit|btn-submit-review|btn-publish|btn-publish-now|提交审核)[^)]*\\)[^;]{0,160}${CLICK_ACTION}`,
      'i',
    );
    const publishVarClickPattern = new RegExp(
      `\\b(?:publish|submitReview|publishArticle|publishAnswer|finalPublish)\\w*(?:Btn|Button|El|Element)\\s*${CLICK_ACTION}`,
      'i',
    );
    const positiveLabelMatch = new RegExp(
      `(?:(?<![!！]\\s*\\(?\\s*(?:${NEG_CHAIN}\\s*)?)(?:(?<![!=])===|(?<![!=])==|(?:\\?\\.|(?<!\\?)\\.)\\s*(?:includes|test)\\s*\\()\\s*['"\`/](?:\\^)?${PUBLISH_LABELS}(?:\\$)?['"\`/]|(?<![!！]\\s*\\(?\\s*)\\/(?:\\^)?${PUBLISH_LABELS}(?:\\$)?\\/[a-z]*\\s*\\.test\\s*\\()`,
    );
    const chainedLabelClickPattern = new RegExp(
      `${positiveLabelMatch.source}[^;]{0,180}${CLICK_ACTION}`,
    );
    const assignedPublishBtnPattern = new RegExp(
      `(?:const|let|var)\\s+(\\w+)\\s*=[^;]{0,220}${positiveLabelMatch.source}`,
      'g',
    );

    for (const f of [...adapterFiles, ...contentFiles]) {
      const stripped = stripComments(f.content);
      expect(stripped, `Forbidden publish helper click in ${f.relPath}`).not.toMatch(
        helperClickPattern,
      );
      expect(stripped, `Forbidden publish selector click in ${f.relPath}`).not.toMatch(
        selectorClickPattern,
      );
      expect(
        stripped,
        `Forbidden publish button variable click in ${f.relPath}`,
      ).not.toMatch(publishVarClickPattern);
      expect(
        stripped,
        `Forbidden chained publish label click in ${f.relPath}`,
      ).not.toMatch(chainedLabelClickPattern);

      for (const match of stripped.matchAll(assignedPublishBtnPattern)) {
        const varName = match[1];
        if (!varName) continue;
        const assignmentText = match[0];
        if (
          /[!！]\s*\(?\s*(?:[\w$.?()]+\s*\.\s*(?:includes|test|some)\s*\([^)]*|\/[^/]+\/[a-z]*\s*\.test\s*\([^)]*)$/.test(
            assignmentText,
          )
        ) {
          continue;
        }
        const varClickRe = new RegExp(`\\b${varName}\\s*${CLICK_ACTION}`);
        expect(
          stripped,
          `Forbidden click on publish button variable "${varName}" in ${f.relPath}`,
        ).not.toMatch(varClickRe);
      }
    }
  });
});

// ============================================================================
// F19 — Mock Bridge E2E Integration Regression (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F19: Mock Bridge E2E Integration Regression', () => {
  it(
    'F19-T1-01: tests/bridge-e2e.spec.ts exists and passes cleanly in Vitest',
    () => {
      const e2ePath = resolveRepoPath('tests/bridge-e2e.spec.ts');
      if (!fs.existsSync(e2ePath)) {
        throw new PublicSurfaceError(
          'MISSING_FILE',
          'tests/bridge-e2e.spec.ts',
          'M6 mock bridge E2E regression file is missing',
        );
      }
      const content = fs.readFileSync(e2ePath, 'utf8');
      expect(content).not.toMatch(/\b(it|test|describe)\.skip\b/);
      const output = execFileSync(
        'pnpm',
        ['exec', 'vitest', 'run', 'tests/bridge-e2e.spec.ts'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 55_000,
        },
      );
      expect(output).toMatch(/passed/i);
    },
    60_000,
  );

  it('F19-T1-02: full pairing -> pull 3 platform tasks lifecycle against Mock Bridge v1', async () => {
    setupEnv();
    const bridge = setupBridge();
    const storage = await loadStorageModule();
    const { createClient } = await loadBridgeClientModule();

    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
      extensionVersion: '0.1.0',
    });
    const me = await client.getMe();
    await storage.savePairing({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
      me,
      pairedAt: '2026-11-24T04:00:00.000Z',
    });
    const tasks = await client.listTasks();

    expect(tasks.map((t) => t.provider).sort()).toEqual([
      'SMZDM_EXT',
      'TOUTIAO_EXT',
      'ZHIHU_EXT',
    ]);
    expect(bridge.bridgeRequests[0]?.headers['authorization']).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
  });

  it('F19-T1-03: full 3-platform draft injection with local image relay and zero auto-publish clicks', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const reg = await loadAdapterRegistryModule();
    const { createUploader } = await loadImageUploaderModule();

    const cases = [
      { provider: 'ZHIHU_EXT' as const, fixture: createZhihuColumnFixture() },
      { provider: 'TOUTIAO_EXT' as const, fixture: createToutiaoEditorFixture() },
      { provider: 'SMZDM_EXT' as const, fixture: createSmzdmEditorFixture() },
    ];

    for (const item of cases) {
      const tab = await env.chrome.tabs.create({ url: item.fixture.url.toString() });
      env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
      const adapter = reg.getByProvider(item.provider)!;
      const report = await adapter.injectDraft(
        item.fixture.doc,
        makeSyntheticTask(item.provider),
        createUploader(),
      );
      expect(report.ok).toBe(true);
      expect(report.stage).toBe('INJECTED');
      expect(report.uploadedImages).toBeGreaterThan(0);
      expect(report.failedImages).toBe(0);
      expect(item.fixture.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
      if (item.provider === 'SMZDM_EXT') {
        expect((report.operatorReminders ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it('F19-T1-04: publish navigation -> Shadow DOM capture -> confirm-published for all 3 platforms', async () => {
    setupEnv();
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const reg = await loadAdapterRegistryModule();
    const ctrl = await loadUrlCaptureBarController();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    const cases = [
      {
        provider: 'ZHIHU_EXT' as const,
        rawUrl: 'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo#top',
        expectedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      },
      {
        provider: 'TOUTIAO_EXT' as const,
        rawUrl: 'https://www.toutiao.com/i7123456789012345678/?wid=99',
        expectedUrl: 'https://www.toutiao.com/i7123456789012345678',
      },
      {
        provider: 'SMZDM_EXT' as const,
        rawUrl: 'https://post.smzdm.com/p/aB3dE5fG7/?from=app#c',
        expectedUrl: 'https://post.smzdm.com/p/aB3dE5fG7',
      },
    ];

    for (const c of cases) {
      const task = makeSyntheticTask(c.provider);
      const adapter = reg.getByProvider(c.provider)!;
      const extracted = adapter.extractPublishedUrl(new URL(c.rawUrl), document);
      expect(extracted).toBe(c.expectedUrl);

      const handle = ctrl.mountPublishedBar({
        publishedUrl: extracted!,
        task: makeSyntheticPendingTabTask(100, task),
        onConfirm: (url) => client.confirmPublished(task.taskId, { publishedUrl: url }),
      });

      const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
      const btn = Array.from(sr.querySelectorAll('button')).find((b) =>
        /一键回传至 GeoMix/.test(b.textContent ?? ''),
      )!;
      fireEvent.click(btn);

      await waitFor(() => {
        expect(
          bridge.publishRecords.some(
            (r) => r.taskId === task.taskId && r.publishedUrl === c.expectedUrl,
          ),
        ).toBe(true);
      });
      handle.unmount();
    }
    expect(bridge.publishRecords.length).toBe(3);
  });

  it('F19-T1-05: idempotent callback replay deduplicates cleanly on Mock Bridge', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    const first = await client.confirmPublished('task_demo_zhihu_01', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });
    const second = await client.confirmPublished('task_demo_zhihu_01', {
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });

    expect(first.publishRecordId).toBe(second.publishRecordId);
    expect(bridge.publishRecords.length).toBe(1);
    expect(bridge.bridgeRequests[0]?.headers['idempotency-key']).toBe(
      bridge.bridgeRequests[1]?.headers['idempotency-key'],
    );
  });
});

// ============================================================================
// F20 — CWS Clean ZIP Packager & Real-Device QA Doc (5 Tier 1 tests)
// ============================================================================

describe('Tier 1 — F20: CWS Clean ZIP Packager & Real-Device QA Doc', () => {
  it('F20-T1-01: scripts/pack.mjs builds a valid, non-corrupt .zip archive from dist/', () => {
    const res = runPackScript();
    expect(res.exitCode).toBe(0);
    expect(res.zipBuffer).not.toBeNull();
    expect(res.zipBuffer!.readUInt32LE(0)).toBe(0x04034b50);
    expect(res.entries.length).toBeGreaterThan(4);
  });

  it('F20-T1-02: ZIP entries are rooted at Chrome-loadable root (no extra dist/ wrapper)', () => {
    const res = runPackScript();
    const names = res.entries.map((e) => e.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('background.js');
    expect(names).toContain('content.js');
    expect(names.some((n) => n.startsWith('dist/'))).toBe(false);
    expect(names.some((n) => n.endsWith('.html'))).toBe(true);
    for (const sz of ['16', '32', '48', '128']) {
      expect(names.some((n) => n.includes(`icon-${sz}.png`))).toBe(true);
    }
  });

  it('F20-T1-03: ZIP strictly excludes sourcemaps, test files, OS junk, and TS sources', () => {
    const res = runPackScript();
    const names = res.entries.map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('manifest.json');
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
  });

  it('F20-T1-04: docs/发布与真机验收清单.md covers end-to-end smoke checklists for all 3 platforms', () => {
    const doc = readQaChecklistDoc();
    expect(doc).toContain('知乎');
    expect(doc).toContain('今日头条');
    expect(doc).toContain('什么值得买');
    expect(doc).toMatch(/Token|配对/);
    expect(doc).toMatch(/草稿/);
    expect(doc).toMatch(/图片|转存/);
    expect(doc).toMatch(/手动发布|人工/);
    expect(doc).toMatch(/URL|回传|Shadow DOM/);
  });

  it('F20-T1-05: docs/发布与真机验收清单.md includes CWS privacy & single-purpose disclosure template', () => {
    const doc = readQaChecklistDoc();
    expect(doc).toMatch(/Chrome Web Store|CWS|隐私/);
    expect(doc).toMatch(/Cookie|cookie/);
    expect(doc).toMatch(/storage|tabs|activeTab|scripting/);
    expect(doc).toMatch(/不自动发布|严禁自动.*发布|手动发布/);
  });
});
