import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_HOST_PERMISSIONS,
  EXPECTED_MANIFEST_PERMISSIONS,
  EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  FORBIDDEN_PERMISSIONS,
  PAIRING_STORAGE_KEY,
  REPO_ROOT,
  SYNTHETIC_API_BASE_URL,
  SYNTHETIC_CDN_BASE_URL,
  SYNTHETIC_RENEWED_TOKEN,
  SYNTHETIC_REVOKED_TOKEN,
  SYNTHETIC_SENTINEL_TOKEN,
  SYNTHETIC_TOKEN,
  TAB_TASKS_STORAGE_KEY,
  PublicSurfaceError,
  bootBackgroundServiceWorker,
  bootContentScript,
  createBrokenEditorFixture,
  createChromeMv3Env,
  createMinimalPngBytes,
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
  getShadowRootForHost,
  invokeDispatcher,
  invokeMediaFetcherSingle,
  listFilesRecursive,
  loadAdapterRegistryModule,
  loadBridgeClientModule,
  loadBridgeContract,
  loadDispatchModule,
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
  readDistBundle,
  readDistManifest,
  readQaChecklistDoc,
  readZipEntryText,
  resolveRepoPath,
  runPackScript,
  scanSourceFiles,
  sendInjectDraftToTab,
  setGlobalPageUrl,
  type ChromeMv3Controller,
  type ExtensionProviderKey,
  type ManifestV3Shape,
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
// F01 — MV3 Project Scaffold & CI (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F01: MV3 Project Scaffold & CI Boundaries', () => {
  it('F01-T2-01: rejects incompatible TypeScript 6.1+/7.x peer-dep regression', () => {
    const pkg = JSON.parse(
      fs.readFileSync(resolveRepoPath('package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    const tsRange = pkg.devDependencies?.['typescript'] ?? '';
    const match = /(\d+)\.(\d+)/.exec(tsRange);
    expect(match).not.toBeNull();
    const major = Number(match![1]);
    expect(major).toBe(5);
  });

  it('F01-T2-02: rejects Zod v4 drift (must stay on Zod v3 for upstream parity)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(resolveRepoPath('package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const zodRange = pkg.dependencies?.['zod'] ?? '';
    expect(zodRange).toMatch(/^[\^~]?3\./);
    expect(zodRange).not.toMatch(/^[\^~]?4\./);
  });

  it('F01-T2-03: zero tracked .zip/.crx archives or large binaries (>100KB) under docs/', () => {
    const tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked.filter((f) => /\.(zip|crx)$/i.test(f))).toEqual([]);

    const docFiles = tracked.filter((f) => f.startsWith('docs/'));
    expect(docFiles.length).toBeGreaterThan(0);
    for (const rel of docFiles) {
      if (/\.(png|jpg|jpeg|gif|webp|pdf|zip|crx|bin)$/i.test(rel)) {
        const size = fs.statSync(resolveRepoPath(rel)).size;
        expect(size, `Large binary in docs/: ${rel}`).toBeLessThanOrEqual(
          100 * 1024,
        );
      }
    }
  });

  it('F01-T2-04: valid binary PNG icon headers (no corrupted or placeholder text icons)', () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const size of ['16', '32', '48', '128']) {
      const iconAbs = resolveRepoPath(`public/icons/icon-${size}.png`);
      expect(fs.existsSync(iconAbs), `Missing ${iconAbs}`).toBe(true);
      const buf = fs.readFileSync(iconAbs);
      expect(buf.byteLength).toBeGreaterThan(64);
      expect(buf.subarray(0, 8).equals(pngMagic)).toBe(true);
    }
  });

  it('F01-T2-05: zero dangling manifest asset references or unsolicited web_accessible_resources', () => {
    const manifest = readDistManifest();
    const referenced: string[] = [];
    if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
    if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
    for (const cs of manifest.content_scripts ?? []) {
      for (const js of cs.js ?? []) referenced.push(js);
    }
    for (const icon of Object.values(manifest.icons ?? {})) referenced.push(icon);
    for (const icon of Object.values(manifest.action?.default_icon ?? {})) referenced.push(icon);

    expect(referenced.length).toBeGreaterThanOrEqual(7);
    for (const rel of referenced) {
      expect(
        fs.existsSync(resolveRepoPath('dist', rel)),
        `Dangling dist reference: ${rel}`,
      ).toBe(true);
    }
    expect((manifest.web_accessible_resources ?? []).length).toBe(0);
  });
});

// ============================================================================
// F02 — Minimal MV3 Manifest (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F02: Minimal MV3 Manifest Boundaries', () => {
  it('F02-T2-01: strictly forbids high-risk permissions and optional_permissions', () => {
    const dist = readDistManifest();
    expect(dist.optional_permissions ?? []).toEqual([]);
    const declared = new Set([
      ...(dist.permissions ?? []),
      ...(dist.optional_permissions ?? []),
    ]);
    const forbiddenPresent = FORBIDDEN_PERMISSIONS.filter((p) => declared.has(p));
    expect(forbiddenPresent).toEqual([]);
    expect([...(dist.permissions ?? [])].sort()).toEqual([
      ...EXPECTED_MANIFEST_PERMISSIONS,
    ]);
  });

  it('F02-T2-02: strictly forbids wildcard or HTTP schemes in host_permissions and content_scripts.matches', () => {
    const dist = readDistManifest();
    const patterns = [
      ...(dist.host_permissions ?? []),
      ...(dist.content_scripts ?? []).flatMap((cs) => cs.matches ?? []),
    ];
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p).not.toBe('<all_urls>');
      expect(p).not.toBe('http://*/*');
      expect(p).not.toBe('https://*/*');
      expect(p).not.toBe('*://*/*');
      expect(p.startsWith('http://')).toBe(false);
      expect(p.startsWith('*://')).toBe(false);
    }
  });

  it('F02-T2-03: strictly forbids HTTP or <all_urls> in optional_host_permissions', () => {
    const dist = readDistManifest();
    const opt = dist.optional_host_permissions ?? [];
    expect(opt.length).toBeGreaterThan(0);
    for (const p of opt) {
      expect(p.startsWith('https://')).toBe(true);
      expect(p).not.toBe('<all_urls>');
      expect(p).not.toBe('http://*/*');
    }
  });

  it('F02-T2-04: invalid version input rejected by buildManifest', async () => {
    const { buildManifest } = await loadManifestConfig();
    expect(buildManifest('0.1.0').manifest_version).toBe(3);
    expect(() => buildManifest('')).toThrow();
    expect(() => buildManifest('v1.0.0-invalid!')).toThrow();
  });

  it('F02-T2-05: no unsafe CSP, no wildcard externally_connectable, and zero real-domain leakage', () => {
    const dist = readDistManifest();
    const serialized = JSON.stringify(dist);
    expect(serialized).not.toContain('unsafe-eval');
    expect(dist.externally_connectable).toBeUndefined();
    expect(serialized).not.toMatch(/gmext_/);
  });
});

// ============================================================================
// F03 — Bridge v1 Shared Contract (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F03: Bridge v1 Shared Contract Boundaries', () => {
  it('F03-T2-01: rejects unsupported provider and unknown status enums', async () => {
    const { pendingTaskSchema } = await loadBridgeContract();
    const base = makeSyntheticTask('ZHIHU_EXT');
    expect(pendingTaskSchema.safeParse(base).success).toBe(true);

    for (const badProvider of ['XIAOHONGSHU_EXT', 'WECHAT_MP', '']) {
      expect(
        pendingTaskSchema.safeParse({ ...base, provider: badProvider }).success,
      ).toBe(false);
    }
    for (const badStatus of ['DELETED', 'QUEUED', 'UNKNOWN']) {
      expect(
        pendingTaskSchema.safeParse({ ...base, status: badStatus }).success,
      ).toBe(false);
    }
  });

  it('F03-T2-02: rejects non-HTTPS, script-scheme, or draft/edit URLs in ExtensionConfirmPublishedInput', async () => {
    const { confirmPublishedInputSchema } = await loadBridgeContract();
    expect(
      confirmPublishedInputSchema.safeParse({
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      }).success,
    ).toBe(true);
    const badUrls = [
      'http://zhuanlan.zhihu.com/p/123',
      'javascript:alert(1)',
      'https://zhuanlan.zhihu.com/p/123/edit',
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      '',
    ];
    for (const publishedUrl of badUrls) {
      expect(
        confirmPublishedInputSchema.safeParse({ publishedUrl }).success,
        `Expected rejection for ${publishedUrl}`,
      ).toBe(false);
    }
  });

  it('F03-T2-03: rejects ExtensionConfirmPublishedResult with non-PUBLISHED status or invalid retestMilestones', async () => {
    const { confirmPublishedResultSchema } = await loadBridgeContract();
    const base = {
      taskId: 'task_demo_01',
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_01',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      crawlProbeQueued: true,
      retestMilestones: [7, 14, 30],
    };

    expect(confirmPublishedResultSchema.safeParse(base).success).toBe(true);
    expect(
      confirmPublishedResultSchema.safeParse({ ...base, status: 'DRAFT_PUSHED' }).success,
    ).toBe(false);
    expect(
      confirmPublishedResultSchema.safeParse({ ...base, retestMilestones: ['7'] }).success,
    ).toBe(false);
    expect(
      confirmPublishedResultSchema.safeParse({ ...base, retestMilestones: [-1, 0] }).success,
    ).toBe(false);
    expect(
      confirmPublishedResultSchema.safeParse({ ...base, crawlProbeQueued: 'yes' }).success,
    ).toBe(false);
  });

  it('F03-T2-04: rejects ExtensionPendingTaskDto with missing required fields or malformed structural types', async () => {
    const { pendingTaskSchema } = await loadBridgeContract();
    const base = makeSyntheticTask('ZHIHU_EXT');

    // Positive control
    expect(pendingTaskSchema.safeParse(base).success).toBe(true);

    const { taskId: _t, ...missingTaskId } = base;
    const { variantTitle: _v, ...missingTitle } = base;

    const invalidPayloads: Array<[string, unknown]> = [
      ['missing taskId', missingTaskId],
      ['empty taskId', { ...base, taskId: '' }],
      ['missing variantTitle', missingTitle],
      ['empty variantTitle', { ...base, variantTitle: '' }],
      ['empty mediaAssets[].url', { ...base, mediaAssets: [{ url: '', alt: 'x' }] }],
      [
        'empty optional mediaAssets[].mime',
        { ...base, mediaAssets: [{ url: `${SYNTHETIC_CDN_BASE_URL}/a.png`, alt: 'x', mime: '' }] },
      ],
      ['non-array mediaAssets', { ...base, mediaAssets: 'not-an-array' }],
      ['non-array complianceChecklist', { ...base, complianceChecklist: 'not-an-array' }],
      ['non-string/non-null targetUrlHint', { ...base, targetUrlHint: 123 }],
    ];

    for (const [label, payload] of invalidPayloads) {
      expect(
        pendingTaskSchema.safeParse(payload).success,
        `Expected schema rejection for ${label}`,
      ).toBe(false);
    }
  });

  it('F03-T2-05: rejects malformed ApiEnvelope and incomplete ExtensionMeDto.brands', async () => {
    const { createEnvelopeSchema, meSchema } = await loadBridgeContract();
    const envSchema = createEnvelopeSchema(meSchema);
    expect(
      envSchema.safeParse({ code: 0, msg: 'ok', data: makeSyntheticMe() }).success,
    ).toBe(true);

    expect(
      envSchema.safeParse({ code: '0', msg: 'ok', data: makeSyntheticMe() }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ code: 0, msg: 'ok', data: null }).success,
    ).toBe(false);
    expect(
      meSchema.safeParse({
        ...makeSyntheticMe(),
        brands: [{ brandId: 'b1', brandName: 'DemoBrand' }],
      }).success,
    ).toBe(false);
  });
});

// ============================================================================
// F04 — Secure Local & Session Storage (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F04: Secure Local & Session Storage Boundaries', () => {
  it('F04-T2-01: rejects saving invalid token prefix or non-HTTPS/private baseUrl', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();
    const base = makeSyntheticPairing();

    const invalidCases = [
      { ...base, token: 'invalid_tok_123' },
      { ...base, token: '' },
      { ...base, baseUrl: 'http://geo.example.com' },
      { ...base, baseUrl: 'https://127.0.0.1:8080' },
    ];

    for (const invalid of invalidCases) {
      await expect(storage.savePairing(invalid)).rejects.toThrow();
    }
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);

    // Positive control: valid pairing persists cleanly
    await storage.savePairing(base);
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(true);
  });

  it('F04-T2-02: zero window.localStorage or window.sessionStorage writes', async () => {
    setupEnv();
    const localSetSpy = vi.spyOn(Storage.prototype, 'setItem');
    const storage = await loadStorageModule();

    await storage.savePairing(makeSyntheticPairing());
    await storage.getPairing();
    await storage.setTabTask(
      11,
      makeSyntheticPendingTabTask(11, makeSyntheticTask('ZHIHU_EXT')),
    );
    await storage.getTabTask(11);
    await storage.removeTabTask(11);
    await storage.clearPairing();

    expect(localSetSpy).not.toHaveBeenCalled();
  });

  it('F04-T2-03: zero raw gmext_ token logging to console.*', async () => {
    const env = setupEnv();
    env.captureConsoleLogs();
    const storage = await loadStorageModule();
    const sentinel = makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN });

    await storage.savePairing(sentinel);
    await storage.getPairing();
    await storage.clearPairing();

    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('F04-T2-04: graceful degradation on corrupted chrome.storage.local entry', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();

    for (const corrupt of [{ broken: true }, 'not-an-object', { baseUrl: 'http://bad', token: 'bad' }]) {
      env.localStore.set(PAIRING_STORAGE_KEY, corrupt);
      const result = await storage.getPairing();
      expect(result).toBeFalsy();
    }

    // Positive control: valid pairing saved afterwards reads back cleanly
    await storage.savePairing(makeSyntheticPairing());
    expect((await storage.getPairing())?.token).toBe(SYNTHETIC_TOKEN);
  });

  it('F04-T2-05: graceful handling of corrupted chrome.storage.session or unknown tabId', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();

    env.sessionStore.set(TAB_TASKS_STORAGE_KEY, 'corrupt-string');
    expect(await storage.getTabTask(99999)).toBeFalsy();
    await expect(storage.removeTabTask(99999)).resolves.not.toThrow();

    const freshTask = makeSyntheticPendingTabTask(7, makeSyntheticTask('ZHIHU_EXT'));
    await storage.setTabTask(7, freshTask);
    expect(await storage.getTabTask(7)).toEqual(freshTask);
  });
});

// ============================================================================
// F05 — URL Allowlist & SSRF-Safe Validator (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F05: URL Allowlist & SSRF-Safe Validator Boundaries', () => {
  it('F05-T2-01: strictly rejects draft, editor, and creator-backend URLs on all 3 platforms', async () => {
    const v = await loadUrlValidationModule();

    // Positive controls (defeat always-null validator mutations)
    expect(v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456789', 'ZHIHU_EXT')).toBe(
      'https://zhuanlan.zhihu.com/p/123456789',
    );
    expect(
      v.canonicalizePublishedUrl('https://www.toutiao.com/article/7123456789', 'TOUTIAO_EXT'),
    ).toBe('https://www.toutiao.com/article/7123456789');
    expect(v.canonicalizePublishedUrl('https://post.smzdm.com/p/aB3dE5fG7', 'SMZDM_EXT')).toBe(
      'https://post.smzdm.com/p/aB3dE5fG7',
    );

    const forbidden: Array<[string, ExtensionProviderKey]> = [
      ['https://zhuanlan.zhihu.com/write', 'ZHIHU_EXT'],
      ['https://zhuanlan.zhihu.com/p/123456789/edit', 'ZHIHU_EXT'],
      ['https://mp.toutiao.com/profile_v4/graphic/publish', 'TOUTIAO_EXT'],
      ['https://mp.toutiao.com/article/7123456789', 'TOUTIAO_EXT'],
      ['https://post.smzdm.com/tougao/', 'SMZDM_EXT'],
      ['https://post.smzdm.com/p/aB3dE5fG7/edit', 'SMZDM_EXT'],
    ];

    for (const [url, provider] of forbidden) {
      expect(v.canonicalizePublishedUrl(url, provider), `Should reject ${url}`).toBeNull();
    }
  });

  it('F05-T2-02: rejects cross-platform URL mismatches', async () => {
    const v = await loadUrlValidationModule();

    // Positive controls on each URL's matching provider
    expect(v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456789', 'ZHIHU_EXT')).toBe(
      'https://zhuanlan.zhihu.com/p/123456789',
    );
    expect(
      v.canonicalizePublishedUrl('https://www.toutiao.com/article/7123456789', 'TOUTIAO_EXT'),
    ).toBe('https://www.toutiao.com/article/7123456789');
    expect(v.canonicalizePublishedUrl('https://post.smzdm.com/p/aB3dE5fG7', 'SMZDM_EXT')).toBe(
      'https://post.smzdm.com/p/aB3dE5fG7',
    );

    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123456789', 'TOUTIAO_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://www.toutiao.com/article/7123456789', 'SMZDM_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://post.smzdm.com/p/aB3dE5fG7', 'ZHIHU_EXT'),
    ).toBeNull();
  });

  it('F05-T2-03: rejects all SSRF, loopback, RFC1918, link-local, IPv6 ULA, .local & .internal hosts', async () => {
    const v = await loadUrlValidationModule();

    // Positive controls
    expect(v.validateApiBaseUrl(SYNTHETIC_API_BASE_URL)).toBe(SYNTHETIC_API_BASE_URL);
    expect(v.validateMediaUrl(`${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`)).toBe(
      `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
    );

    const ssrfUrls = [
      'https://localhost/a',
      'https://sub.localhost/a',
      'https://127.0.0.1/a',
      'https://10.0.0.1/a',
      'https://100.64.0.1/a',
      'https://172.16.5.4/a',
      'https://192.168.1.2/a',
      'https://169.254.169.254/latest/meta-data/',
      'https://0.0.0.0/a',
      'https://2130706433/a',
      'https://0x7f000001/a',
      'https://[::1]/a',
      'https://[fc00::1]/a',
      'https://[fd12:3456::1]/a',
      'https://[fe80::1]/a',
      'https://[::ffff:127.0.0.1]/a',
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:10.0.0.1]/a',
      'https://[::ffff:192.168.1.1]/a',
      'https://[::ffff:172.16.0.1]/a',
      'https://[::ffff:0.0.0.0]/a',
      'https://api.local/a',
      'https://api.internal/a',
      'https://intranet/a',
    ];

    for (const bad of ssrfUrls) {
      expect(v.validateApiBaseUrl(bad), `API validator should reject ${bad}`).toBeNull();
      expect(v.validateMediaUrl(bad), `Media validator should reject ${bad}`).toBeNull();
    }
  });

  it('F05-T2-04: rejects non-HTTPS schemes and embedded credentials', async () => {
    const v = await loadUrlValidationModule();

    // Positive controls
    expect(v.validateApiBaseUrl(SYNTHETIC_API_BASE_URL)).toBe(SYNTHETIC_API_BASE_URL);
    expect(v.validateMediaUrl(`${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`)).toBe(
      `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
    );
    expect(v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123', 'ZHIHU_EXT')).toBe(
      'https://zhuanlan.zhihu.com/p/123',
    );

    const bad = [
      'http://zhuanlan.zhihu.com/p/123',
      'http://geo.example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'https://user:pass@zhuanlan.zhihu.com/p/123',
      'https://secret@geo.example.com',
    ];
    for (const url of bad) {
      expect(v.validateApiBaseUrl(url), `Base URL should reject ${url}`).toBeNull();
      expect(v.validateMediaUrl(url), `Media URL should reject ${url}`).toBeNull();
      expect(
        v.canonicalizePublishedUrl(url, 'ZHIHU_EXT'),
        `Published URL should reject ${url}`,
      ).toBeNull();
    }
  });

  it('F05-T2-05: rejects lookalike domains, extra path segments, path traversal, non-default ports, control chars, whitespace, and >2048-char URLs', async () => {
    const v = await loadUrlValidationModule();

    // Positive controls
    expect(v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123', 'ZHIHU_EXT')).toBe(
      'https://zhuanlan.zhihu.com/p/123',
    );
    expect(v.canonicalizePublishedUrl('https://post.smzdm.com/p/abc123/', 'SMZDM_EXT')).toBe(
      'https://post.smzdm.com/p/abc123',
    );
    expect(v.validateApiBaseUrl(SYNTHETIC_API_BASE_URL)).toBe(SYNTHETIC_API_BASE_URL);

    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com.evil.example/p/123', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123/extra', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123/../write', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123/../p/456', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com:8443/p/123', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://post.smzdm.com/p/abc_def/', 'SMZDM_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123\r\nX-Test: 1', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.canonicalizePublishedUrl('https://zhuanlan.zhihu.com/p/123 456', 'ZHIHU_EXT'),
    ).toBeNull();
    expect(
      v.validateApiBaseUrl(`${SYNTHETIC_API_BASE_URL}/${'a'.repeat(2100)}`),
    ).toBeNull();
  });
});

// ============================================================================
// F06 — Internal Extension Message Protocol (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F06: Internal Extension Message Protocol Boundaries', () => {
  it('F06-T2-01: SW -> Content messages NEVER carry raw gmext_ tokens', async () => {
    const env = setupEnv();
    setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    document.body.innerHTML = createZhihuColumnFixture().doc.body.innerHTML;
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const storage = await loadStorageModule();
    await storage.savePairing(
      makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN }),
    );

    const task = makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] });
    await env.withContext({ kind: 'sw' }, () => invokeDispatcher(task));
    expect(env.contentBoundMessages.length).toBeGreaterThan(0);
    expect(
      env.contentBoundMessages.some((m) =>
        JSON.stringify(m.payload).includes(task.taskId),
      ),
    ).toBe(true);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('F06-T2-02: rejects unknown message types and primitive/null inputs', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    render(React.createElement(App));
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThanOrEqual(1);
    });

    // Positive control: real Popup -> SW message must be accepted
    expect(msgs.validateMessage(env.runtimeMessages[0]!.payload).ok).toBe(true);

    for (const bad of [
      null,
      undefined,
      'INJECT_DRAFT',
      123,
      {},
      { type: 'MALICIOUS_EVAL', code: '1+1' },
    ]) {
      expect(msgs.validateMessage(bad).ok).toBe(false);
    }

    const swResp = await env.sendFromPopup({ type: 'MALICIOUS_EVAL', code: '1+1' });
    expect((swResp as { ok?: unknown })?.ok).toBe(false);
  });

  it('F06-T2-03: rejects malformed payloads and content-script callers on privileged operations', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge();

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
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));

    // Pair legitimately via Popup UI and capture real wire messages
    const beforePairIdx = env.runtimeMessages.length;
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);
    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });

    const pairMsg = env.runtimeMessages
      .slice(beforePairIdx)
      .find((m) => JSON.stringify(m.payload).includes(SYNTHETIC_TOKEN))?.payload as
      | Record<string, unknown>
      | undefined;
    expect(pairMsg).toBeTruthy();
    expect(msgs.validateMessage(pairMsg).ok).toBe(true);

    // Capture real task-fetch message via Refresh click
    const beforeRefreshIdx = env.runtimeMessages.length;
    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /刷新|refresh/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(beforeRefreshIdx);
    });
    const fetchMsg = env.runtimeMessages[beforeRefreshIdx]!.payload;
    expect(msgs.validateMessage(fetchMsg).ok).toBe(true);

    // (a) Malformed pairing payloads (missing fields & insecure/loopback baseUrl + bad token)
    const bridgeBeforeMalformed = bridge.bridgeRequests.length;
    const pairType = pairMsg!['type'];
    const malformedEmptyPair = { type: pairType };
    const malformedInsecurePair =
      'payload' in pairMsg!
        ? { type: pairType, payload: { baseUrl: 'http://127.0.0.1', token: 'bad_token' } }
        : { type: pairType, baseUrl: 'http://127.0.0.1', token: 'bad_token' };

    const respEmptyPair = await env.sendFromPopup(malformedEmptyPair);
    expect((respEmptyPair as { ok?: unknown })?.ok).toBe(false);
    const respInsecurePair = await env.sendFromPopup(malformedInsecurePair);
    expect((respInsecurePair as { ok?: unknown })?.ok).toBe(false);
    expect(bridge.bridgeRequests.length).toBe(bridgeBeforeMalformed);
    expect((await storage.getPairing())?.baseUrl).toBe(SYNTHETIC_API_BASE_URL);

    // (b) Content script (sender.tab defined) MUST be forbidden from invoking Popup-only task fetch
    const fromContentResp = await env.sendFromContent(tab.id!, fetchMsg);
    expect((fromContentResp as { ok?: unknown })?.ok).toBe(false);
    expect(bridge.bridgeRequests.length).toBe(bridgeBeforeMalformed);

    // (c) Malformed draft push payload (invalid task object)
    const beforePushIdx = env.runtimeMessages.length;
    const pushBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /写入草稿箱|推送草稿/.test(b.textContent ?? ''),
    );
    expect(pushBtn).toBeTruthy();
    fireEvent.click(pushBtn!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(beforePushIdx);
    });
    const pushMsg = env.runtimeMessages[beforePushIdx]!.payload as Record<string, unknown>;
    expect(msgs.validateMessage(pushMsg).ok).toBe(true);

    const malformedPush =
      'payload' in pushMsg
        ? { type: pushMsg['type'], payload: { task: { taskId: '', provider: 'INVALID' } } }
        : { type: pushMsg['type'], task: { taskId: '', provider: 'INVALID' } };
    const respBadPush = await env.sendFromPopup(malformedPush);
    expect((respBadPush as { ok?: unknown })?.ok).toBe(false);
  });

  it('F06-T2-04: prototype pollution keys (__proto__, constructor) cannot spoof message types', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const msgs = await loadMessagesModule();
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    render(React.createElement(App));
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThanOrEqual(1);
    });

    // Positive control with real valid Popup -> SW message type
    const validMsg = env.runtimeMessages[0]!.payload as { type: string };
    expect(typeof validMsg.type).toBe('string');
    expect(msgs.validateMessage(validMsg).ok).toBe(true);

    const protoCrafted = JSON.parse(
      `{"__proto__":{"type":${JSON.stringify(validMsg.type)}},"payload":{}}`,
    ) as unknown;
    const ctorCrafted = JSON.parse(
      `{"constructor":{"prototype":{"type":${JSON.stringify(validMsg.type)}}},"payload":{}}`,
    ) as unknown;

    expect(msgs.validateMessage(protoCrafted).ok).toBe(false);
    expect(msgs.validateMessage(ctorCrafted).ok).toBe(false);
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();

    const swResp = await env.sendFromPopup(protoCrafted);
    expect((swResp as { ok?: unknown })?.ok).toBe(false);
  });

  it('F06-T2-05: structured error responses never leak raw tokens or stack traces', async () => {
    const env = setupEnv();
    env.captureConsoleLogs();
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const storage = await loadStorageModule();
    await storage.savePairing(
      makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN }),
    );

    // Render Popup while paired to capture the real task-fetch wire message
    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });

    const callsBeforeRefresh = env.runtimeMessages.length;
    const refreshBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /刷新|refresh/i.test(b.textContent ?? ''),
    );
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);
    await waitFor(() => {
      expect(env.runtimeMessages.length).toBeGreaterThan(callsBeforeRefresh);
    });
    const fetchTasksMsg = env.runtimeMessages[callsBeforeRefresh]!.payload;

    // Revoke token and invoke live SW directly (ZERO .catch() error swallower!)
    bridge.revokeToken(SYNTHETIC_SENTINEL_TOKEN);
    const bridgeCountBefore = bridge.bridgeRequests.length;

    const resp = await env.sendFromPopup(fetchTasksMsg);

    // MUST actually hit the Bridge /tasks endpoint with the revoked sentinel token
    expect(bridge.bridgeRequests.length).toBe(bridgeCountBefore + 1);
    const lastReq = bridge.bridgeRequests[bridge.bridgeRequests.length - 1]!;
    expect(lastReq.url).toContain('/api/v2/extension/tasks');
    expect(lastReq.headers['authorization']).toBe(`Bearer ${SYNTHETIC_SENTINEL_TOKEN}`);

    // MUST return a structured auth error without leaking token or stack traces
    expect(resp).toBeTruthy();
    expect((resp as { ok?: unknown }).ok).toBe(false);
    const serialized = JSON.stringify(resp);
    expect(serialized).toMatch(/UNAUTHORIZED|401|reauthRequired/i);
    expect(serialized).not.toMatch(/INVALID_REQUEST/i);
    expect(serialized).not.toContain(SYNTHETIC_SENTINEL_TOKEN);
    expect(serialized).not.toContain('    at ');
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });
});

// ============================================================================
// F07 — Bridge v1 HTTP Client (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F07: Bridge v1 HTTP Client Boundaries', () => {
  it('F07-T2-01: HTTP 401 and 403 produce typed auth errors without leaking token', async () => {
    const env = setupEnv();
    env.captureConsoleLogs();
    const bridge = setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_SENTINEL_TOKEN,
    });

    bridge.queueFault('me', {
      kind: 'http',
      status: 401,
      body: { code: 40100, msg: 'Token revoked', data: null },
    });
    const err401 = await client.getMe().catch((e: unknown) => {
      if (
        e instanceof PublicSurfaceError ||
        e instanceof TypeError ||
        e instanceof ReferenceError ||
        e instanceof SyntaxError
      ) {
        throw e;
      }
      return e;
    });
    expect(bridge.bridgeRequests.length).toBe(1);
    expect(err401).toBeInstanceOf(Error);
    expect(String(err401)).not.toContain(SYNTHETIC_SENTINEL_TOKEN);

    bridge.queueFault('tasks', {
      kind: 'http',
      status: 403,
      body: { code: 40300, msg: 'Forbidden', data: null },
    });
    const err403 = await client.listTasks().catch((e: unknown) => {
      if (
        e instanceof PublicSurfaceError ||
        e instanceof TypeError ||
        e instanceof ReferenceError ||
        e instanceof SyntaxError
      ) {
        throw e;
      }
      return e;
    });
    expect(bridge.bridgeRequests.length).toBe(2);
    expect(err403).toBeInstanceOf(Error);
    expect(String(err403)).not.toContain(SYNTHETIC_SENTINEL_TOKEN);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });

  it('F07-T2-02: HTTP 400, 429, and 503 HTML surface structured API errors (never SyntaxError)', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    bridge.queueFault('me', {
      kind: 'http',
      status: 400,
      body: { code: 40000, msg: 'Bad request', data: null },
    });
    await expect(client.getMe()).rejects.toThrow();

    bridge.queueFault('tasks', {
      kind: 'http',
      status: 429,
      headers: { 'Retry-After': '30' },
      body: { code: 42900, msg: 'Rate limited', data: null },
    });
    await expect(client.listTasks()).rejects.toThrow();

    bridge.queueFault('tasks', {
      kind: 'invalid-json',
      status: 503,
      rawBody: '<html><body>503 Service Unavailable</body></html>',
    });
    const err503 = await client.listTasks().catch((e: unknown) => {
      if (
        e instanceof PublicSurfaceError ||
        e instanceof TypeError ||
        e instanceof ReferenceError
      ) {
        throw e;
      }
      return e;
    });
    expect(bridge.bridgeRequests.length).toBe(3);
    expect(err503).toBeInstanceOf(Error);
    expect((err503 as Error).name).not.toBe('SyntaxError');
  });

  it('F07-T2-03: HTTP 200 with non-zero envelope code or data: null is strictly rejected', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    bridge.queueFault('me', {
      kind: 'http',
      status: 200,
      body: { code: 50001, msg: 'Internal error', data: {} },
    });
    await expect(client.getMe()).rejects.toThrow();

    bridge.queueFault('confirm-published', {
      kind: 'http',
      status: 200,
      body: { code: 0, msg: 'ok', data: null },
    });
    await expect(
      client.confirmPublished('task_demo_01', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      }),
    ).rejects.toThrow();
  });

  it('F07-T2-04: Zod schema drift & network failure rejection', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });

    bridge.queueFault('tasks', {
      kind: 'http',
      status: 200,
      body: {
        code: 0,
        msg: 'ok',
        data: [{ taskId: 't1', provider: 'UNKNOWN_EXT' }],
      },
    });
    await expect(client.listTasks()).rejects.toThrow();

    bridge.queueFault('tasks', { kind: 'network-error', message: 'Failed to fetch' });
    await expect(client.listTasks()).rejects.toThrow();
  });

  it('F07-T2-05: client-side preflight blocks invalid publishedUrl, non-HTTPS baseUrl, and path-traversal taskId', async () => {
    const bridge = setupBridge();
    const { createClient } = await loadBridgeClientModule();

    const validClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    await expect(
      validClient.confirmPublished('task_demo_01', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123/edit',
      }),
    ).rejects.toThrow();
    expect(bridge.requests.length).toBe(0);

    // Non-HTTPS or loopback baseUrl must fail with 0 fetch calls
    await expect(async () => {
      const badClient = createClient({
        baseUrl: 'http://geo.example.com',
        token: SYNTHETIC_TOKEN,
      });
      await badClient.getMe();
    }).rejects.toThrow();
    expect(bridge.forbiddenFetchAttempts.length).toBe(0);

    // Path traversal taskId must either reject OR strictly encodeURIComponent
    let traversalEscaped = false;
    try {
      await validClient.confirmPublished('../admin', {
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      });
    } catch (err) {
      if (
        err instanceof PublicSurfaceError ||
        err instanceof TypeError ||
        err instanceof ReferenceError ||
        err instanceof SyntaxError
      ) {
        throw err;
      }
      // rejecting traversal taskId is valid
    }
    for (const req of bridge.bridgeRequests) {
      const pathname = new URL(req.url).pathname;
      if (!pathname.startsWith('/api/v2/extension/tasks/')) {
        traversalEscaped = true;
      }
    }
    expect(traversalEscaped).toBe(false);
  });
});

// ============================================================================
// F08 — Popup Token Pairing & Account Status UI (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F08: Popup Token Pairing & Account Status UI Boundaries', () => {
  it('F08-T2-01: rejects non-HTTPS or private/loopback API URLs before permission request', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: 'http://geo.example.com' } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toMatch(/https|安全|地址|无效/i);
    });
    expect(env.permissionRequests.length).toBe(0);
    expect(bridge.requests.length).toBe(0);

    fireEvent.change(urlInput, { target: { value: 'https://127.0.0.1:8080' } });
    fireEvent.click(submitBtn);
    expect(env.permissionRequests.length).toBe(0);
    expect(bridge.forbiddenFetchAttempts.length).toBe(0);
  });

  it('F08-T2-02: rejects token missing gmext_ prefix or empty/whitespace token', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: 'sk_live_not_gmext' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toMatch(/gmext_|token|令牌/i);
    });
    expect(bridge.requests.length).toBe(0);
  });

  it('F08-T2-03: graceful handling when user declines optional_host_permissions', async () => {
    const env = setupEnv({ permissionPolicy: 'deny' });
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
      expect(container.textContent).toMatch(/权限|授权|拒绝|permission/i);
    });
    expect(bridge.requests.length).toBe(0);
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
  });

  it('F08-T2-04: 401 / expired token during /me displays clear error and persists nothing', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const App = await loadPopupApp();

    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => findPopupInputs(container));
    const { urlInput, tokenInput, submitBtn } = findPopupInputs(container);

    fireEvent.change(urlInput, { target: { value: SYNTHETIC_API_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: SYNTHETIC_REVOKED_TOKEN } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(container.textContent).toMatch(/失效|过期|无效|401|重新|Token/i);
    });
    expect(env.localStore.has(PAIRING_STORAGE_KEY)).toBe(false);
  });

  it('F08-T2-05: raw gmext_ token never exposed in paired DOM, localStorage, or console.*', async () => {
    const env = setupEnv({ permissionPolicy: 'grant' });
    env.captureConsoleLogs();
    setupBridge({ validToken: SYNTHETIC_SENTINEL_TOKEN });
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
      expect(container.textContent).toContain('DemoOperator');
    });

    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });
});

// ============================================================================
// F09 — Popup Pending Task Queue UI (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F09: Popup Pending Task Queue UI Boundaries', () => {
  it('F09-T2-01: empty queue renders clear empty state without crashing', async () => {
    const env = setupEnv();
    setupBridge({ tasks: [] });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toMatch(/暂无|没有待发布|空|empty/i);
    });
  });

  it('F09-T2-02: 401 token expiration during task fetch triggers clear re-pair prompt', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());
    bridge.revokeToken(SYNTHETIC_TOKEN);

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toMatch(/失效|过期|重新配对|解除绑定|解绑|401/);
    });
  });

  it('F09-T2-03: actionable feedback for AUTH_REQUIRED, EDITOR_NOT_FOUND, and PARTIAL_MEDIA_FAILED', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const stages = [
      {
        ok: false,
        stage: 'AUTH_REQUIRED',
        uploadedImages: 0,
        failedImages: 0,
        message: '请先在当前浏览器登录目标平台',
      },
      {
        ok: false,
        stage: 'EDITOR_NOT_FOUND',
        uploadedImages: 0,
        failedImages: 0,
        message: '未检测到编辑器，请刷新页面后重试',
      },
      {
        ok: true,
        stage: 'PARTIAL_MEDIA_FAILED',
        uploadedImages: 1,
        failedImages: 1,
        failedImageDetails: [
          {
            url: `${SYNTHETIC_CDN_BASE_URL}/media/forbidden-403.png`,
            alt: '实测对比图',
            reason: 'HTTP 403',
          },
        ],
        message: '部分图片转存失败，请手动上传：实测对比图',
      },
    ];
    let stageIdx = 0;

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
          const resp = stages[Math.min(stageIdx++, stages.length - 1)]!;
          sendResponse({ ...resp, ok: true, data: resp });
        });
      }
    });

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('写入草稿箱');
    });

    const pushBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /写入草稿箱/.test(b.textContent ?? ''),
    )!;

    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(container.textContent).toMatch(/登录|AUTH_REQUIRED/);
    });

    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(container.textContent).toMatch(/未检测到编辑器|编辑器|EDITOR_NOT_FOUND/);
    });

    fireEvent.click(pushBtn);
    await waitFor(() => {
      expect(container.textContent).toMatch(/实测对比图|部分图片|手动上传/);
    });
  });

  it('F09-T2-04: network/5xx error during fetch keeps UI responsive with Retry', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    bridge.queueFault('tasks', {
      kind: 'invalid-json',
      status: 503,
      rawBody: '<html>503</html>',
    });

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));

    await waitFor(() => {
      expect(container.textContent).toContain('DemoOperator');
      expect(container.textContent).toMatch(/失败|错误|503|重试|刷新/);
    });

    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /重试|刷新|retry|refresh/i.test(b.textContent ?? ''),
    )!;
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(container.textContent).toContain('示例品牌A 深度实测报告');
    });
  });

  it('F09-T2-05: double-click guard prevents duplicate concurrent dispatch for same task', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    let injectCalls = 0;
    const injectGate: { release: (() => void) | null } = { release: null };

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
          injectCalls += 1;
          injectGate.release = () => {
            const report = {
              ok: true,
              stage: 'INJECTED' as const,
              uploadedImages: 0,
              failedImages: 0,
              message: 'ok',
            };
            sendResponse({ ...report, ok: true, data: report });
          };
          return true;
        });
      }
    });

    const App = await loadPopupApp();
    env.setContext({ kind: 'popup' });
    const { container } = render(React.createElement(App));
    await waitFor(() => {
      expect(container.textContent).toContain('写入草稿箱');
    });

    const pushBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /写入草稿箱/.test(b.textContent ?? ''),
    )!;
    fireEvent.click(pushBtn);
    fireEvent.click(pushBtn);

    await waitFor(() => {
      expect(injectCalls).toBe(1);
    });
    expect(pushBtn.disabled).toBe(true);
    injectGate.release?.();
  });
});

// ============================================================================
// F10 — PlatformDraftAdapter Protocol & Registry (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F10: PlatformDraftAdapter Protocol & Registry Boundaries', () => {
  const CANONICAL_PUBLISHED_URL_BY_PROVIDER: Record<ExtensionProviderKey, string> = {
    ZHIHU_EXT: 'https://zhuanlan.zhihu.com/p/123456789',
    TOUTIAO_EXT: 'https://www.toutiao.com/article/7123456789',
    SMZDM_EXT: 'https://post.smzdm.com/p/aB3dE5fG7',
  };

  it('F10-T2-01: unsupported provider key never silently falls back to another adapter', async () => {
    const reg = await loadAdapterRegistryModule();
    // Positive controls: defeat empty or always-undefined registry
    const adapters = reg.listAll();
    expect(adapters.length).toBe(3);
    expect(reg.getByProvider('ZHIHU_EXT')?.provider).toBe('ZHIHU_EXT');
    expect(reg.getByProvider('TOUTIAO_EXT')?.provider).toBe('TOUTIAO_EXT');
    expect(reg.getByProvider('SMZDM_EXT')?.provider).toBe('SMZDM_EXT');

    for (const bad of ['XIAOHONGSHU_EXT', '']) {
      let result: unknown = null;
      try {
        result = reg.getByProvider(bad as unknown as ExtensionProviderKey);
      } catch (err) {
        if (
          err instanceof PublicSurfaceError ||
          err instanceof TypeError ||
          err instanceof ReferenceError ||
          err instanceof SyntaxError
        ) {
          throw err;
        }
        result = null;
      }
      expect(result).toBeFalsy();
    }
  });

  it('F10-T2-02: unrelated, lookalike, or HTTP URLs return null/undefined on URL lookup', async () => {
    const reg = await loadAdapterRegistryModule();
    // Positive controls: defeat empty or always-undefined registry on both published and editor URLs
    expect(reg.listAll().length).toBe(3);
    expect(reg.getByUrl('https://zhuanlan.zhihu.com/p/123456789')?.provider).toBe('ZHIHU_EXT');
    expect(reg.getByUrl('https://zhuanlan.zhihu.com/write')?.provider).toBe('ZHIHU_EXT');
    expect(reg.getByUrl('https://mp.toutiao.com/profile_v4/graphic/publish')?.provider).toBe(
      'TOUTIAO_EXT',
    );
    expect(reg.getByUrl('https://post.smzdm.com/tougao/')?.provider).toBe('SMZDM_EXT');

    for (const url of [
      'https://example.com/p/123',
      'https://zhuanlan.zhihu.com.evil.example/p/123',
      'http://zhuanlan.zhihu.com/p/123',
      'https://evil.example/https://post.smzdm.com/p/abc',
    ]) {
      expect(reg.getByUrl(url), `Should not match ${url}`).toBeFalsy();
    }
  });

  it('F10-T2-03: every adapter publishedUrlPatterns strictly rejects edit/draft URLs', async () => {
    const reg = await loadAdapterRegistryModule();
    const adapters = reg.listAll();
    expect(adapters.length).toBe(3);

    const draftUrls = [
      'https://zhuanlan.zhihu.com/write',
      'https://zhuanlan.zhihu.com/p/123/edit',
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      'https://www.toutiao.com/article/7123456789/edit',
      'https://post.smzdm.com/tougao/',
      'https://post.smzdm.com/p/aB3dE5fG7/edit',
    ];
    for (const adapter of adapters) {
      expect(
        adapter.publishedUrlPatterns.length,
        `${adapter.provider} must declare at least one publishedUrlPattern`,
      ).toBeGreaterThan(0);

      // Positive control: adapter patterns must match its own canonical published URL
      const canonicalUrl = CANONICAL_PUBLISHED_URL_BY_PROVIDER[adapter.provider];
      const matchesOwnCanonical = adapter.publishedUrlPatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(canonicalUrl);
      });
      expect(
        matchesOwnCanonical,
        `${adapter.provider} publishedUrlPatterns failed to match ${canonicalUrl}`,
      ).toBe(true);

      for (const pattern of adapter.publishedUrlPatterns) {
        for (const u of draftUrls) {
          pattern.lastIndex = 0;
          expect(pattern.test(u), `${adapter.provider} matched draft URL ${u}`).toBe(false);
        }
      }
    }
  });

  it('F10-T2-04: registry returned collections cannot corrupt internal registry state', async () => {
    const reg = await loadAdapterRegistryModule();
    const list1 = reg.listAll();
    expect(list1.length).toBe(3);
    try {
      (list1 as unknown[]).pop();
    } catch {
      // frozen array throws in strict mode — even better
    }
    expect(reg.listAll().length).toBe(3);
    expect(reg.getByProvider('ZHIHU_EXT')).toBeTruthy();
    expect(reg.getByProvider('TOUTIAO_EXT')).toBeTruthy();
    expect(reg.getByProvider('SMZDM_EXT')).toBeTruthy();
  });

  it('F10-T2-05: non-matching URL on extractPublishedUrl across all 3 adapters returns null without throwing', async () => {
    const reg = await loadAdapterRegistryModule();
    const adapters = reg.listAll();
    expect(adapters.length).toBe(3);

    const emptyDoc = document.implementation.createHTMLDocument('empty');
    for (const adapter of adapters) {
      // Positive control: extractPublishedUrl must return canonical URL for its own published URL
      const canonicalUrl = CANONICAL_PUBLISHED_URL_BY_PROVIDER[adapter.provider];
      const extracted = adapter.extractPublishedUrl(new URL(canonicalUrl), emptyDoc);
      expect(
        extracted?.replace(/\/+$/, ''),
        `${adapter.provider} failed to extract its own canonical URL`,
      ).toBe(canonicalUrl);

      expect(
        adapter.extractPublishedUrl(new URL('https://example.com/'), emptyDoc),
      ).toBeNull();
    }
  });
});

// ============================================================================
// F11 — Background Task Dispatcher & Tab Router (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F11: Background Task Dispatcher & Tab Router Boundaries', () => {
  it('F11-T2-01: rejects hostile or non-Zhihu targetUrlHint and safely falls back to editorEntryUrl', async () => {
    const hostileHints = [
      'https://evil.example.com/phish',
      'javascript:alert(1)',
      'http://www.zhihu.com/question/987654321',
      'https://www.zhihu.com/signin',
    ];

    for (const hint of hostileHints) {
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
        makeSyntheticTask('ZHIHU_EXT', { targetUrlHint: hint, mediaAssets: [] }),
      );
      expect(env.chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://zhuanlan.zhihu.com/write' }),
      );
      env.restore();
      activeChrome = null;
    }
  });

  it('F11-T2-02: content-script readiness timeout returns structured failure without hanging', async () => {
    await loadDispatchModule();
    vi.useFakeTimers();
    try {
      const env = setupEnv({ autoCompleteNewTabs: true });

      let settled = false;
      let fatalError: unknown = null;
      const outcomePromise = invokeDispatcher(
        makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }),
      )
        .catch((e: unknown) => {
          if (
            e instanceof PublicSurfaceError ||
            e instanceof TypeError ||
            e instanceof ReferenceError ||
            e instanceof SyntaxError
          ) {
            fatalError = e;
          }
          return {
            ok: false,
            stage: 'EDITOR_NOT_FOUND',
            message: e instanceof Error ? e.message : String(e),
          };
        })
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(100);
      if (fatalError) {
        throw fatalError;
      }
      expect(env.chrome.tabs.create).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(20_000);
      const outcome = await outcomePromise;
      if (fatalError) {
        throw fatalError;
      }
      expect(settled).toBe(true);
      expect(outcome['ok']).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F11-T2-03: tab closed mid-injection aborts cleanly and purges session state', async () => {
    await loadDispatchModule();
    const env = setupEnv({ autoCompleteNewTabs: false });
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    let createdTabId: number | undefined;
    env.chrome.tabs.onCreated.addListener((tab) => {
      createdTabId = tab.id;
    });

    const dispatchPromise = invokeDispatcher(
      makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }),
    );

    await waitFor(() => {
      expect(createdTabId).toBeDefined();
    });
    env.removeTab(createdTabId!);

    const outcome = await dispatchPromise.catch((e: unknown) => {
      if (
        e instanceof PublicSurfaceError ||
        e instanceof TypeError ||
        e instanceof ReferenceError ||
        e instanceof SyntaxError
      ) {
        throw e;
      }
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    });
    expect(outcome['ok']).toBe(false);

    const storage = await loadStorageModule();
    expect(await storage.getTabTask(createdTabId!)).toBeFalsy();
  });

  it('F11-T2-04: unsupported provider rejected before creating any browser tab', async () => {
    await loadDispatchModule();
    const env = setupEnv();
    const badTask = makeSyntheticTask('ZHIHU_EXT', {
      provider: 'UNKNOWN_EXT' as unknown as ExtensionProviderKey,
    });

    const outcome = await invokeDispatcher(badTask).catch((e: unknown) => {
      if (
        e instanceof PublicSurfaceError ||
        e instanceof TypeError ||
        e instanceof ReferenceError ||
        e instanceof SyntaxError
      ) {
        throw e;
      }
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    });
    expect(outcome['ok']).toBe(false);
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('F11-T2-05: zero gmext_ credential leakage in chrome.tabs.sendMessage payloads', async () => {
    const env = setupEnv();
    const storage = await loadStorageModule();
    await storage.savePairing(
      makeSyntheticPairing({ token: SYNTHETIC_SENTINEL_TOKEN }),
    );
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

    await invokeDispatcher(makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }));
    expect(env.contentBoundMessages.length).toBeGreaterThan(0);
    env.assertZeroTokenLeakage(SYNTHETIC_SENTINEL_TOKEN);
  });
});

// ============================================================================
// F12 — Anti-Hotlink Media Fetcher (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F12: Anti-Hotlink Media Fetcher Boundaries', () => {
  it('F12-T2-01: blocks non-HTTPS, data:, file:, and SSRF private/loopback URLs before fetch', async () => {
    const bridge = setupBridge();
    const badUrls = [
      'http://cdn.example.com/a.png',
      'https://127.0.0.1/a.png',
      'https://169.254.169.254/latest',
      'https://10.0.0.1/a.png',
      'https://[::1]/a.png',
      'data:image/png;base64,AA==',
    ];

    for (const url of badUrls) {
      const outcome = await invokeMediaFetcherSingle({ url, alt: 'bad' });
      expect(outcome.ok, `Expected rejection for ${url}`).toBe(false);
    }
    expect(bridge.requests.length).toBe(0);
    expect(bridge.forbiddenFetchAttempts.length).toBe(0);

    // Positive control: valid public HTTPS media asset fetches cleanly
    const validRes = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
      alt: '正常图',
      mime: 'image/png',
    });
    expect(validRes.ok).toBe(true);
    expect(bridge.requests.length).toBe(1);
  });

  it('F12-T2-02: rejects image with Content-Length exceeding 10MB (10MB + 1) while allowing exact 10MB', async () => {
    setupBridge();
    const oversize = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-header.png`,
      alt: '超限图',
      mime: 'image/png',
    });
    expect(oversize.ok).toBe(false);
    expect(oversize.reason).toMatch(/10\s*MB|size|大小|超限|limit/i);

    const exact = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/exact-10mb.png`,
      alt: '边界10MB图',
      mime: 'image/png',
    });
    expect(exact.ok).toBe(true);
    expect(exact.byteLength).toBe(10 * 1024 * 1024);
  });

  it('F12-T2-03: aborts oversized streamed response when Content-Length is missing or spoofed', async () => {
    const bridge = setupBridge();
    const unheadered = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-stream.png`,
      alt: '无头流超限',
      mime: 'image/png',
    });
    expect(unheadered.ok).toBe(false);

    const spoofed = await invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-spoofed-header.png`,
      alt: '伪造头流超限',
      mime: 'image/png',
    });
    expect(spoofed.ok).toBe(false);
    expect(bridge.requests.length).toBe(2);
  });

  it('F12-T2-04: enforces 15s timeout via AbortController (using fake timers)', async () => {
    await loadMediaFetcherModule();
    vi.useFakeTimers();
    setupBridge();

    const fetchPromise = invokeMediaFetcherSingle({
      url: `${SYNTHETIC_CDN_BASE_URL}/media/slow-timeout.png`,
      alt: '超时图',
      mime: 'image/png',
    });

    await vi.advanceTimersByTimeAsync(15_050);
    const outcome = await fetchPromise;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/timeout|abort|超时|取消/i);
  });

  it('F12-T2-05: rejects HTTP 403/404/500, non-image HTML responses, and redirects to private/HTTP URLs', async () => {
    const bridge = setupBridge();
    for (const file of [
      'forbidden-403.png',
      'missing-404.png',
      'error-500.png',
      'html-wall.png',
      'redirect-http.png',
      'redirect-private.png',
    ]) {
      const res = await invokeMediaFetcherSingle({
        url: `${SYNTHETIC_CDN_BASE_URL}/media/${file}`,
        alt: file,
        mime: 'image/png',
      });
      expect(res.ok, `Expected rejection for ${file}`).toBe(false);
    }
    expect(bridge.requests.length).toBeGreaterThanOrEqual(6);
  });
});

// ============================================================================
// F13 — Content Injection Runtime & LocalImageUploader (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F13: Content Injection Runtime & LocalImageUploader Boundaries', () => {
  it('F13-T2-01: NEVER falls back to inserting raw external image URLs on upload failure', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const { createUploader } = await loadImageUploaderModule();
    const editorElement = document.createElement('div');
    editorElement.setAttribute('contenteditable', 'true');
    document.body.appendChild(editorElement);

    const res = await createUploader().uploadAll(
      [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/forbidden-403.png`, alt: '失败图1' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`, alt: '失败图2' },
      ],
      { editorElement },
    );

    expect(res.uploadedImages).toBe(0);
    expect(res.failedImages).toBe(2);
    expect(editorElement.innerHTML).not.toContain('cdn.example.com');
    expect(editorElement.querySelectorAll('img').length).toBe(0);
  });

  it('F13-T2-02: empty mediaAssets: [] performs zero SW relay calls', async () => {
    const env = setupEnv();
    setupBridge();
    const sendSpy = env.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    const { createUploader } = await loadImageUploaderModule();

    const res = await createUploader().uploadAll([], {});
    expect(res).toEqual({ uploadedImages: 0, failedImages: 0, failures: [] });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('F13-T2-03: missing both fileInput and editorElement fails gracefully per asset without throwing', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const { createUploader } = await loadImageUploaderModule();
    const res = await createUploader().uploadAll(
      [{ url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '无目标图' }],
      { fileInput: null, editorElement: null },
    );
    expect(res.uploadedImages).toBe(0);
    expect(res.failedImages).toBe(1);
    expect(res.failures[0]?.reason.length).toBeGreaterThan(0);
  });

  it('F13-T2-04: corrupted Base64 or 0-byte relay payload rejected cleanly without breaking sibling assets', async () => {
    const env = setupEnv();
    const validBytes = createMinimalPngBytes();
    const validB64 = Buffer.from(validBytes).toString('base64');
    let callNum = 0;
    env.chrome.runtime.onMessage.addListener((_msg, _s, sendResponse) => {
      callNum += 1;
      if (callNum === 1) {
        const badData = {
          ok: true,
          url: `${SYNTHETIC_CDN_BASE_URL}/media/bad.png`,
          alt: '坏图',
          mime: 'image/png',
          mimeType: 'image/png',
          byteLength: 0,
          base64: '!!!not-valid-base64!!!',
          dataBase64: '!!!not-valid-base64!!!',
          filename: 'bad.png',
        };
        sendResponse({ ...badData, ok: true, data: badData });
      } else {
        const goodData = {
          ok: true,
          url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`,
          alt: '好图',
          mime: 'image/png',
          mimeType: 'image/png',
          byteLength: validBytes.byteLength,
          base64: validB64,
          dataBase64: validB64,
          filename: 'ok.png',
        };
        sendResponse({ ...goodData, ok: true, data: goodData });
      }
    });

    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const { createUploader } = await loadImageUploaderModule();
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    document.body.appendChild(fileInput);

    const res = await createUploader().uploadAll(
      [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/bad.png`, alt: '坏图' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '好图' },
      ],
      { fileInput },
    );

    expect(res.uploadedImages).toBe(1);
    expect(res.failedImages).toBe(1);
    expect(res.failures[0]?.alt).toBe('坏图');
  });

  it('F13-T2-05: content runtime ignores unknown messages and rejects provider/host mismatches', async () => {
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

    const beforeHtml = document.body.innerHTML;
    const unknownResp = await env.sendToTab(tab.id!, { type: 'UNKNOWN_OP_XYZ' });
    if (unknownResp !== undefined) {
      expect((unknownResp as Record<string, unknown>)['ok']).toBe(false);
    }
    expect(document.body.innerHTML).toBe(beforeHtml);

    // Negative check: SMZDM_EXT task sent to a Zhihu /write tab must be rejected with untouched DOM
    const mismatch = await sendInjectDraftToTab(
      env,
      tab.id!,
      makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] }),
    );
    expect(mismatch).toBeTruthy();
    expect(mismatch!['ok']).toBe(false);
    expect(document.body.innerHTML).toBe(beforeHtml);

    // Positive controls: defeat empty adapter registry & always-fail INJECT_DRAFT stubs
    const reg = await loadAdapterRegistryModule();
    expect(reg.getByProvider('ZHIHU_EXT')?.provider).toBe('ZHIHU_EXT');
    expect(reg.getByProvider('SMZDM_EXT')?.provider).toBe('SMZDM_EXT');

    const matched = await sendInjectDraftToTab(
      env,
      tab.id!,
      makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }),
    );
    expect(matched).toBeTruthy();
    expect(matched!['ok']).toBe(true);
    expect(matched!['stage']).toBe('INJECTED');
  });
});

// ============================================================================
// F14 — Shadow DOM URL Capture & Partial-Media Bar (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F14: Shadow DOM URL Capture & Partial-Media Bar Boundaries', () => {
  it('F14-T2-01: never mounts URL capture bar on draft/edit URLs or tabs without active PendingTabTask', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    // (a) Active task on /edit URL -> must NOT mount
    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab1 = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const storage = await loadStorageModule();
    await storage.setTabTask(
      tab1.id!,
      makeSyntheticPendingTabTask(tab1.id!, makeSyntheticTask('ZHIHU_EXT')),
    );
    await env.withContext(
      { kind: 'content', tabId: tab1.id!, url: tab1.url },
      () => bootContentScript(),
    );

    const editUrl = 'https://zhuanlan.zhihu.com/p/123456789/edit';
    env.setContext({ kind: 'content', tabId: tab1.id!, url: editUrl });
    navigateSpa('/p/123456789/edit', 'pushState');
    env.updateTabUrl(tab1.id!, editUrl, 'complete');
    await waitFor(() => {
      expect(
        env.runtimeMessages.some(
          (m) => m.senderKind === 'content' && m.tabId === tab1.id,
        ),
      ).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(findShadowHosts(document).length).toBe(0);

    // Positive control: same bound tab navigating via SPA to a valid published URL MUST mount
    const publishedUrl = 'https://zhuanlan.zhihu.com/p/123456789';
    env.setContext({ kind: 'content', tabId: tab1.id!, url: publishedUrl });
    navigateSpa('/p/123456789', 'pushState');
    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!)!;
      expect(sr.textContent).toContain(publishedUrl);
    });

    // (b) No active task bound on valid published URL -> must unmount / NOT mount
    await storage.removeTabTask(tab1.id!);
    const unboundPublishedUrl = 'https://zhuanlan.zhihu.com/p/999888777';
    env.setContext({ kind: 'content', tabId: tab1.id!, url: unboundPublishedUrl });
    const msgIdxBeforeUnbound = env.runtimeMessages.length;
    navigateSpa('/p/999888777', 'pushState');
    env.updateTabUrl(tab1.id!, unboundPublishedUrl, 'complete');
    await waitFor(() => {
      expect(
        env.runtimeMessages
          .slice(msgIdxBeforeUnbound)
          .some((m) => m.senderKind === 'content' && m.tabId === tab1.id),
      ).toBe(true);
      expect(findShadowHosts(document).length).toBe(0);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(findShadowHosts(document).length).toBe(0);
    expect(env.runtimeMessages.some((m) => m.senderKind === 'popup')).toBe(false);
  });

  it('F14-T2-02: idempotent click protection prevents duplicate CONFIRM_PUBLISHED calls', async () => {
    const ctrl = await loadUrlCaptureBarController();
    const tabTask = makeSyntheticPendingTabTask(100, makeSyntheticTask('ZHIHU_EXT'));

    const confirmGate: { release: (() => void) | null } = { release: null };
    const onConfirm = vi.fn(
      (url: string) =>
        new Promise<{
          taskId: string;
          status: 'PUBLISHED';
          publishRecordId: string;
          publishedUrl: string;
          crawlProbeQueued: boolean;
          retestMilestones: number[];
        }>((resolve) => {
          confirmGate.release = () =>
            resolve({
              taskId: tabTask.taskId,
              status: 'PUBLISHED',
              publishRecordId: 'pub_demo_0001',
              publishedUrl: url,
              crawlProbeQueued: true,
              retestMilestones: [7, 14, 30],
            });
        }),
    );

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
    fireEvent.click(cta);
    fireEvent.click(cta);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    confirmGate.release?.();
    await waitFor(() => {
      expect(sr.textContent).toMatch(/T\+1|已回传|追踪/);
    });
    fireEvent.click(cta);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('F14-T2-03: XSS safety on untrusted variantTitle and failure reason strings', async () => {
    const ctrl = await loadUrlCaptureBarController();
    const xssTitle = '<img src=x onerror="window.__xss=1">恶意标题';
    const xssReason = '<script>window.__xss=2</script>拦截原因';

    // (1) Inspect PublishedUrlCaptureBar independently before unmounting singleton host
    const pubHandle = ctrl.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      task: makeSyntheticPendingTabTask(
        100,
        makeSyntheticTask('ZHIHU_EXT', { variantTitle: xssTitle }),
      ),
    });
    const pubHosts = findShadowHosts(document);
    expect(pubHosts.length).toBe(1);
    const pubSr = getShadowRootForHost(pubHosts[0]!)!;
    expect(pubSr).toBeTruthy();
    expect(pubSr.textContent).toContain('恶意标题');
    expect(pubSr.querySelectorAll('script').length).toBe(0);
    expect(pubSr.querySelectorAll('[onerror]').length).toBe(0);
    expect(pubSr.querySelectorAll('img[src="x"]').length).toBe(0);
    expect((window as unknown as { __xss?: unknown }).__xss).toBeUndefined();
    pubHandle.unmount();
    expect(findShadowHosts(document).length).toBe(0);

    // (2) Inspect PartialMediaNotice independently
    const noticeHandle = ctrl.mountPartialMediaNotice({
      taskTitle: xssTitle,
      failedImages: [
        {
          url: `${SYNTHETIC_CDN_BASE_URL}/media/missing-404.png`,
          alt: xssTitle,
          reason: xssReason,
        },
      ],
    });
    const noticeHosts = findShadowHosts(document);
    expect(noticeHosts.length).toBe(1);
    const noticeSr = getShadowRootForHost(noticeHosts[0]!)!;
    expect(noticeSr).toBeTruthy();
    expect(noticeSr.textContent).toContain('恶意标题');
    expect(noticeSr.textContent).toContain('拦截原因');
    expect(noticeSr.querySelectorAll('script').length).toBe(0);
    expect(noticeSr.querySelectorAll('[onerror]').length).toBe(0);
    expect(noticeSr.querySelectorAll('img[src="x"]').length).toBe(0);
    expect((window as unknown as { __xss?: unknown }).__xss).toBeUndefined();
    noticeHandle.unmount();
  });

  it('F14-T2-04: API callback error (401/network) shows actionable error and allows Retry', async () => {
    const ctrl = await loadUrlCaptureBarController();
    const tabTask = makeSyntheticPendingTabTask(100, makeSyntheticTask('ZHIHU_EXT'));
    let attempt = 0;
    const onConfirm = vi.fn(async (url: string) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('401 Token revoked');
      }
      return {
        taskId: tabTask.taskId,
        status: 'PUBLISHED' as const,
        publishRecordId: 'pub_demo_0001',
        publishedUrl: url,
        crawlProbeQueued: true,
        retestMilestones: [7, 14, 30],
      };
    });

    ctrl.mountPublishedBar({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      task: tabTask,
      onConfirm,
    });

    const sr = getShadowRootForHost(findShadowHosts(document)[0]!)!;
    const getCta = () =>
      Array.from(sr.querySelectorAll('button')).find((b) =>
        /一键回传|重试|回传/.test(b.textContent ?? ''),
      )!;

    fireEvent.click(getCta());
    await waitFor(() => {
      expect(sr.textContent).toMatch(/401|失效|失败|重试/);
    });

    fireEvent.click(getCta());
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(2);
      expect(sr.textContent).toMatch(/T\+1|已回传|追踪/);
    });
  });

  it('F14-T2-05: strictly singleton host mount across repeated SPA route transitions & unmounts on leaving', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const storage = await loadStorageModule();
    await storage.setTabTask(
      tab.id!,
      makeSyntheticPendingTabTask(tab.id!, makeSyntheticTask('ZHIHU_EXT')),
    );
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });
    navigateSpa('/p/111111', 'pushState');
    navigateSpa('/p/222222', 'replaceState');
    navigateSpa('/p/333333', 'popstate');

    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(1);
    });

    navigateSpa('/write', 'pushState');
    await waitFor(() => {
      expect(findShadowHosts(document).length).toBe(0);
    });
  });
});

// ============================================================================
// F15 — Zhihu Draft Adapter Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F15: Zhihu Draft Adapter Boundaries', () => {
  it('F15-T2-01: unauthenticated login modal / /signin redirect returns AUTH_REQUIRED', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const uploadSpy = vi.fn();
    const uploader = createSimpleMockUploader(uploadSpy);

    for (const variant of ['signin-redirect', 'login-modal'] as const) {
      const fix = createZhihuLoggedOutFixture(variant);
      expect(adapter.isLoggedInEditor(fix.doc, fix.url)).toBe(false);
      const report = await adapter.injectDraft(
        fix.doc,
        makeSyntheticTask('ZHIHU_EXT'),
        uploader,
      );
      expect(report.ok).toBe(false);
      expect(report.stage).toBe('AUTH_REQUIRED');
      expect(report.uploadedImages).toBe(0);
      expect(report.failedImages).toBe(0);
    }
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('F15-T2-02: missing editor selectors returns EDITOR_NOT_FOUND cleanly', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createBrokenEditorFixture('ZHIHU_EXT');
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('ZHIHU_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('EDITOR_NOT_FOUND');
  });

  it('F15-T2-03: partial media failure returns PARTIAL_MEDIA_FAILED with failure details and zero external URLs', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('ZHIHU_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 1,
        failedImages: 1,
        failures: [
          {
            url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-2.jpg`,
            alt: '图2',
            reason: 'Timeout',
          },
        ],
      })),
    );
    expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(report.uploadedImages).toBe(1);
    expect(report.failedImages).toBe(1);
    expect(report.failedImageDetails?.length).toBe(1);
    expect(fix.doc.querySelector('[contenteditable="true"]')?.innerHTML ?? '').not.toContain(
      'cdn.example.com',
    );
  });

  it('F15-T2-04: redline — strictly ZERO clicks on 发布 / 发布文章 / 发布回答 buttons', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const noopUploader = createSimpleMockUploader(async () => ({
      uploadedImages: 0,
      failedImages: 0,
      failures: [],
    }));

    // 1. Zhihu Column editor ('发布', '发布文章')
    const colFix = createZhihuColumnFixture();
    expect(colFix.spies.publishButtonsWatched).toBeGreaterThanOrEqual(2);
    await adapter.injectDraft(
      colFix.doc,
      makeSyntheticTask('ZHIHU_EXT', { mediaAssets: [] }),
      noopUploader,
    );
    expect(colFix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(colFix.spies.publishButtonLabelsClicked).toEqual([]);

    // 2. Zhihu Question Answer editor ('发布回答')
    const qaFix = createZhihuQuestionAnswerFixture('987654321');
    expect(qaFix.spies.publishButtonsWatched).toBeGreaterThanOrEqual(1);
    await adapter.injectDraft(
      qaFix.doc,
      makeSyntheticTask('ZHIHU_EXT', {
        targetUrlHint: 'https://www.zhihu.com/question/987654321',
        mediaAssets: [],
      }),
      noopUploader,
    );
    expect(qaFix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(qaFix.spies.publishButtonLabelsClicked).toEqual([]);
  });

  it('F15-T2-05: rejects draft/edit/question-only/HTTP URLs in extractPublishedUrl', async () => {
    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    // Positive control
    expect(
      adapter
        .extractPublishedUrl(new URL('https://zhuanlan.zhihu.com/p/123456789'), fix.doc)
        ?.replace(/\/+$/, ''),
    ).toBe('https://zhuanlan.zhihu.com/p/123456789');
    for (const bad of [
      'https://zhuanlan.zhihu.com/write',
      'https://zhuanlan.zhihu.com/p/123456789/edit',
      'https://www.zhihu.com/question/987654321',
      'https://www.zhihu.com/signin',
      'http://zhuanlan.zhihu.com/p/123456789',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
    }
  });
});

// ============================================================================
// F16 — Toutiao Draft Adapter Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F16: Toutiao Draft Adapter Boundaries', () => {
  it('F16-T2-01: login redirect / auth gate returns AUTH_REQUIRED', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoLoggedOutFixture();
    const uploadSpy = vi.fn();

    expect(adapter.isLoggedInEditor(fix.doc, fix.url)).toBe(false);
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createSimpleMockUploader(uploadSpy),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('AUTH_REQUIRED');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('F16-T2-02: missing editor selectors returns EDITOR_NOT_FOUND cleanly', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createBrokenEditorFixture('TOUTIAO_EXT');
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('EDITOR_NOT_FOUND');
  });

  it('F16-T2-03: partial media failure returns PARTIAL_MEDIA_FAILED without injecting external image URLs', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 1,
        failedImages: 1,
        failures: [
          {
            url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-3.webp`,
            alt: '配图2',
            reason: 'HTTP 403',
          },
        ],
      })),
    );
    expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(report.failedImages).toBe(1);
    expect(report.failedImageDetails?.length).toBe(1);
    expect(fix.doc.querySelector('.ProseMirror')?.innerHTML ?? '').not.toContain(
      'cdn.example.com',
    );
  });

  it('F16-T2-04: redline — strictly ZERO clicks on 预览并发布 / 发布 / 确认发布 buttons', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    expect(fix.spies.publishButtonsWatched).toBeGreaterThanOrEqual(3);
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
  });

  it('F16-T2-05: rejects creator-backend, edit, non-numeric, and HTTP URLs in extractPublishedUrl', async () => {
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoEditorFixture();
    // Positive control
    expect(
      adapter
        .extractPublishedUrl(
          new URL('https://www.toutiao.com/article/7123456789'),
          fix.doc,
        )
        ?.replace(/\/+$/, ''),
    ).toBe('https://www.toutiao.com/article/7123456789');
    for (const bad of [
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      'https://mp.toutiao.com/article/7123456789',
      'https://www.toutiao.com/article/not-a-number',
      'https://www.toutiao.com/article/7123456789/edit',
      'http://www.toutiao.com/i7123456789',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
    }
  });
});

// ============================================================================
// F17 — SMZDM Draft Adapter Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F17: SMZDM Draft Adapter Boundaries', () => {
  it('F17-T2-01: unauthenticated / login redirect returns AUTH_REQUIRED', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmLoggedOutFixture();
    const uploadSpy = vi.fn();

    expect(adapter.isLoggedInEditor(fix.doc, fix.url)).toBe(false);
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT'),
      createSimpleMockUploader(uploadSpy),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('AUTH_REQUIRED');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('F17-T2-02: missing editor selectors returns EDITOR_NOT_FOUND cleanly', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createBrokenEditorFixture('SMZDM_EXT');
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('EDITOR_NOT_FOUND');
  });

  it('F17-T2-03: partial media failure returns PARTIAL_MEDIA_FAILED while preserving table & reminders', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 1,
        failedImages: 1,
        failures: [
          {
            url: `${SYNTHETIC_CDN_BASE_URL}/media/oversize-header.png`,
            alt: '实验室读数图',
            reason: 'Size > 10MB',
          },
        ],
      })),
    );
    expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(report.uploadedImages).toBe(1);
    expect(report.failedImages).toBe(1);
    expect(report.failedImageDetails?.length).toBe(1);
    expect((report.operatorReminders ?? []).length).toBeGreaterThan(0);

    const editorHtml = `${fix.doc.querySelector('[contenteditable="true"]')?.innerHTML ?? ''}\n${fix.spies.pastedHtml.join('\n')}`;
    expect(editorHtml).toContain('<table');
    expect(fix.doc.querySelector('[contenteditable="true"]')?.innerHTML ?? '').not.toContain(
      'cdn.example.com',
    );
  });

  it('F17-T2-04: redline — strictly ZERO clicks on 提交审核 / 发布 / 立即发布 buttons', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    expect(fix.spies.publishButtonsWatched).toBeGreaterThanOrEqual(3);
    await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('SMZDM_EXT', { mediaAssets: [] }),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(fix.spies.publishButtonClicks).toHaveBeenCalledTimes(0);
    expect(fix.spies.publishButtonLabelsClicked).toEqual([]);
  });

  it('F17-T2-05: rejects /tougao/, /edit, invalid slug chars, wrong subdomain & HTTP URLs', async () => {
    const adapter = await loadPlatformAdapter('SMZDM_EXT');
    const fix = createSmzdmEditorFixture();
    // Positive control
    expect(
      adapter
        .extractPublishedUrl(new URL('https://post.smzdm.com/p/aB3dE5fG7'), fix.doc)
        ?.replace(/\/+$/, ''),
    ).toBe('https://post.smzdm.com/p/aB3dE5fG7');
    for (const bad of [
      'https://post.smzdm.com/tougao/',
      'https://post.smzdm.com/p/aB3dE5fG7/edit',
      'https://post.smzdm.com/p/bad-slug_!/',
      'https://www.smzdm.com/p/123456/',
      'http://post.smzdm.com/p/aB3dE5fG7',
    ]) {
      expect(adapter.extractPublishedUrl(new URL(bad), fix.doc)).toBeNull();
    }
  });
});

// ============================================================================
// F18 — Manifest & Redline Static Security Guard Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F18: Manifest & Redline Static Security Guard Boundaries', () => {
  it('F18-T2-01: built dist/background.js, dist/content.js & dist/assets/*.js contain zero document.cookie or <all_urls>', () => {
    const assetJsBundles = listFilesRecursive('dist').filter((f) =>
      /^assets\/.+\.m?js$/.test(f),
    );
    expect(assetJsBundles.length).toBeGreaterThanOrEqual(1);

    const bundles = ['background.js', 'content.js', ...assetJsBundles];
    expect(bundles.length).toBeGreaterThanOrEqual(3);

    for (const name of bundles) {
      const code =
        name === 'background.js' || name === 'content.js'
          ? readDistBundle(name)
          : fs.readFileSync(resolveRepoPath('dist', name), 'utf8');
      expect(code.length, `Empty dist bundle dist/${name}`).toBeGreaterThan(0);
      expect(code, `Cookie access in dist/${name}`).not.toMatch(
        /document\s*\.\s*cookie|document\s*\[\s*['"]cookie['"]\s*\]|chrome\s*\.\s*cookies/,
      );
      expect(code, `<all_urls> in dist/${name}`).not.toContain('<all_urls>');
    }
  });

  it('F18-T2-02: public-repo zero-leakage audit across src/, docs/, manifest.config.ts', () => {
    const srcFiles = scanSourceFiles('src', { includeTests: true });
    expect(srcFiles.length).toBeGreaterThan(0);

    const docRelPaths = listFilesRecursive('docs').filter((p) =>
      /\.(md|txt|json|ya?ml)$/i.test(p),
    );
    expect(docRelPaths.length).toBeGreaterThan(0);
    const docFiles = docRelPaths.map((p) => ({
      relPath: `docs/${p}`,
      content: fs.readFileSync(resolveRepoPath('docs', p), 'utf8'),
    }));

    const files = [
      ...srcFiles,
      ...docFiles,
      {
        relPath: 'manifest.config.ts',
        content: fs.readFileSync(resolveRepoPath('manifest.config.ts'), 'utf8'),
      },
    ];
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const matches = f.content.match(/gmext_[A-Za-z0-9_-]{8,}/g) ?? [];
      for (const tok of matches) {
        expect(
          tok,
          `Potential non-synthetic gmext_ token in ${f.relPath}: ${tok}`,
        ).toMatch(
          /^gmext_(demo|test|mock|fake|sample|example|sentinel|invalid|revoked|valid|expired|renewed)/i,
        );
      }
    }
  });

  it('F18-T2-03: static check confirms zero eval / new Function / dangerouslySetInnerHTML in SW, Popup & Shared', () => {
    for (const dir of ['src/background', 'src/popup', 'src/shared']) {
      const files = scanSourceFiles(dir);
      expect(files.length, `No source files scanned in ${dir}`).toBeGreaterThan(0);
      for (const f of files) {
        expect(f.content, `eval( in ${f.relPath}`).not.toMatch(/\beval\s*\(/);
        expect(f.content, `new Function in ${f.relPath}`).not.toMatch(
          /\bnew\s+Function\s*\(/,
        );
        expect(f.content, `dangerouslySetInnerHTML in ${f.relPath}`).not.toContain(
          'dangerouslySetInnerHTML',
        );
      }
    }
  });

  it('F18-T2-04: static check confirms Content Script & Adapters never access geomix.pairing.v1 or chrome.storage.local', () => {
    for (const dir of ['src/content', 'src/adapters']) {
      const files = scanSourceFiles(dir);
      expect(files.length, `No source files scanned in ${dir}`).toBeGreaterThan(0);
      for (const f of files) {
        expect(f.content, `Pairing key in ${f.relPath}`).not.toContain(
          PAIRING_STORAGE_KEY,
        );
        expect(f.content, `chrome.storage.local in ${f.relPath}`).not.toMatch(
          /chrome\s*\.\s*storage\s*\.\s*local/,
        );
      }
    }
  });

  it('F18-T2-05: tests/manifest-security.spec.ts covers all mandatory Issue #6 redlines without .skip', () => {
    const abs = resolveRepoPath('tests/manifest-security.spec.ts');
    if (!fs.existsSync(abs)) {
      throw new PublicSurfaceError(
        'MISSING_FILE',
        'tests/manifest-security.spec.ts',
        'M6 security guard suite not found',
      );
    }
    const content = fs.readFileSync(abs, 'utf8');
    expect(content).not.toMatch(/\b(it|test|describe)\.(skip|todo)\b/);
    expect(content).toContain('manifest_version');
    expect(content).toContain('cookies');
    expect(content).toContain('<all_urls>');
    expect(content).toContain('document.cookie');
  });
});

// ============================================================================
// F19 — Mock Bridge E2E Integration Regression Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F19: Mock Bridge E2E Integration Regression Boundaries', () => {
  it('F19-T2-01: mid-session token revocation (401) degrades gracefully and permits clean re-pairing', async () => {
    setupEnv();
    const bridge = setupBridge();
    const storage = await loadStorageModule();
    const { createClient } = await loadBridgeClientModule();

    await storage.savePairing(makeSyntheticPairing());
    bridge.revokeToken(SYNTHETIC_TOKEN);

    const revokedClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    await expect(revokedClient.listTasks()).rejects.toThrow();

    await storage.clearPairing();
    bridge.addValidToken(SYNTHETIC_RENEWED_TOKEN, makeSyntheticMe());
    const renewedClient = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_RENEWED_TOKEN,
    });
    const me = await renewedClient.getMe();
    await storage.savePairing(
      makeSyntheticPairing({ token: SYNTHETIC_RENEWED_TOKEN, me }),
    );
    const tasks = await renewedClient.listTasks();
    expect(tasks.length).toBe(3);
  });

  it('F19-T2-02: partial media failure degrades without blocking publish URL capture callback', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());

    const adapter = await loadPlatformAdapter('ZHIHU_EXT');
    const fix = createZhihuColumnFixture();
    const tab = await env.chrome.tabs.create({ url: fix.url.toString() });
    env.setContext({ kind: 'content', tabId: tab.id!, url: tab.url });

    const { createUploader } = await loadImageUploaderModule();
    const task = makeSyntheticTask('ZHIHU_EXT', {
      mediaAssets: [
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/valid-1.png`, alt: '好图' },
        { url: `${SYNTHETIC_CDN_BASE_URL}/media/forbidden-403.png`, alt: '防盗链失败图' },
      ],
    });
    const report = await adapter.injectDraft(fix.doc, task, createUploader());
    expect(report.stage).toBe('PARTIAL_MEDIA_FAILED');
    expect(report.failedImages).toBe(1);

    // Operator manually publishes -> confirm callback still works
    const { createClient } = await loadBridgeClientModule();
    const client = createClient({
      baseUrl: SYNTHETIC_API_BASE_URL,
      token: SYNTHETIC_TOKEN,
    });
    const pubUrl = adapter.extractPublishedUrl(
      new URL('https://zhuanlan.zhihu.com/p/123456789?utm_source=demo'),
      fix.doc,
    );
    const result = await client.confirmPublished(task.taskId, {
      publishedUrl: pubUrl!,
    });
    expect(result.status).toBe('PUBLISHED');
    expect(bridge.publishRecords.length).toBe(1);
  });

  it('F19-T2-03: Service Worker cold restart between draft injection and manual publish', async () => {
    const env = setupEnv();
    setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    const tabTask = makeSyntheticPendingTabTask(tab.id!, makeSyntheticTask('ZHIHU_EXT'));
    await storage.setTabTask(tab.id!, tabTask);

    await env.simulateServiceWorkerRestart(() => bootBackgroundServiceWorker());

    const freshStorage = await loadStorageModule();
    const recovered = await freshStorage.getTabTask(tab.id!);
    expect(recovered?.taskId).toBe(tabTask.taskId);
    const recoveredPairing = await freshStorage.getPairing();
    expect(recoveredPairing?.token).toBe(SYNTHETIC_TOKEN);
  });

  it('F19-T2-04: navigating to draft/edit URLs during active task never triggers confirm-published', async () => {
    const env = setupEnv();
    const bridge = setupBridge();
    await env.withContext({ kind: 'sw' }, () => bootBackgroundServiceWorker());
    const storage = await loadStorageModule();
    await storage.savePairing(makeSyntheticPairing());

    setGlobalPageUrl('https://zhuanlan.zhihu.com/write');
    const tab = await env.chrome.tabs.create({ url: 'https://zhuanlan.zhihu.com/write' });
    await storage.setTabTask(
      tab.id!,
      makeSyntheticPendingTabTask(tab.id!, makeSyntheticTask('ZHIHU_EXT')),
    );
    await env.withContext(
      { kind: 'content', tabId: tab.id!, url: tab.url },
      () => bootContentScript(),
    );

    const editUrl = 'https://zhuanlan.zhihu.com/p/123456789/edit';
    env.setContext({ kind: 'content', tabId: tab.id!, url: editUrl });
    navigateSpa('/p/123456789/edit', 'pushState');
    env.updateTabUrl(tab.id!, editUrl, 'complete');
    await waitFor(() => {
      expect(
        env.runtimeMessages.some(
          (m) => m.senderKind === 'content' && m.tabId === tab.id,
        ),
      ).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(findShadowHosts(document).length).toBe(0);
    expect(bridge.publishRecords.length).toBe(0);

    // Positive control: navigating the same bound tab to a valid published URL DOES mount
    // the capture bar (and still never auto-calls confirm-published before manual CTA click).
    const publishedUrl = 'https://zhuanlan.zhihu.com/p/123456789';
    env.setContext({ kind: 'content', tabId: tab.id!, url: publishedUrl });
    navigateSpa('/p/123456789', 'pushState');
    env.updateTabUrl(tab.id!, publishedUrl, 'complete');
    await waitFor(() => {
      const hosts = findShadowHosts(document);
      expect(hosts.length).toBe(1);
      const sr = getShadowRootForHost(hosts[0]!)!;
      expect(sr.textContent).toContain(publishedUrl);
    });
    expect(bridge.publishRecords.length).toBe(0);
    expect(env.runtimeMessages.some((m) => m.senderKind === 'popup')).toBe(false);
  });

  it('F19-T2-05: logged-out platform tab returns AUTH_REQUIRED and leaves Mock Bridge untouched', async () => {
    setupEnv();
    const bridge = setupBridge();
    const adapter = await loadPlatformAdapter('TOUTIAO_EXT');
    const fix = createToutiaoLoggedOutFixture();
    const report = await adapter.injectDraft(
      fix.doc,
      makeSyntheticTask('TOUTIAO_EXT'),
      createSimpleMockUploader(async () => ({
        uploadedImages: 0,
        failedImages: 0,
        failures: [],
      })),
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('AUTH_REQUIRED');
    expect(bridge.publishRecords.length).toBe(0);
    expect(bridge.bridgeRequests.length).toBe(0);
  });
});

// ============================================================================
// F20 — CWS Clean ZIP Packager & Real-Device QA Doc Boundaries (5 Tier 2 tests)
// ============================================================================

describe('Tier 2 — F20: CWS Clean ZIP Packager & Real-Device QA Doc Boundaries', () => {
  it('F20-T2-01: scripts/pack.mjs fails fast when dist/ or dist/manifest.json is missing', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geomix-empty-dist-'));
    try {
      const res = runPackScript({ distDir: emptyDir, expectFailure: true });
      expect(res.exitCode).not.toBe(0);
      expect(res.zipBuffer).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('F20-T2-02: scripts/pack.mjs excludes injected .map, *.spec.js, and .DS_Store stray files from dist/', () => {
    const distAbs = resolveRepoPath('dist');
    if (!fs.existsSync(path.join(distAbs, 'manifest.json'))) {
      throw new PublicSurfaceError(
        'MISSING_FILE',
        'dist/manifest.json',
        'Run pnpm build before packaging test',
      );
    }
    const cleanDist = fs.mkdtempSync(path.join(os.tmpdir(), 'geomix-clean-dist-'));
    const dirtyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'geomix-dirty-dist-'));
    try {
      fs.cpSync(distAbs, cleanDist, { recursive: true });
      fs.cpSync(distAbs, dirtyDist, { recursive: true });
      fs.writeFileSync(path.join(dirtyDist, 'leak.js.map'), '{}');
      fs.writeFileSync(path.join(dirtyDist, 'dummy.spec.js'), '// test');
      fs.writeFileSync(path.join(dirtyDist, '.DS_Store'), 'junk');

      // Positive control: pack.mjs MUST succeed on an unmodified dist copy via --dist
      const cleanRes = runPackScript({ distDir: cleanDist });
      expect(cleanRes.exitCode).toBe(0);
      expect(cleanRes.zipBuffer).not.toBeNull();
      expect(cleanRes.entries.map((e) => e.name)).toContain('manifest.json');

      // Dirty dist: either strips all forbidden artifacts cleanly OR fails closed naming them
      const res = runPackScript({ distDir: dirtyDist, expectFailure: true });
      if (res.exitCode === 0) {
        expect(res.zipBuffer).not.toBeNull();
        const names = res.entries.map((e) => e.name);
        expect(names).toContain('manifest.json');
        expect(names.some((n) => n.endsWith('.map'))).toBe(false);
        expect(names.some((n) => n.includes('.spec.'))).toBe(false);
        expect(names.some((n) => n.includes('.DS_Store'))).toBe(false);
      } else {
        expect(res.zipBuffer).toBeNull();
        const output = `${res.stdout}\n${res.stderr}`;
        expect(output).toMatch(
          /leak\.js\.map|dummy\.spec\.js|\.DS_Store|\.map|\.spec\.|forbidden|sourcemap|禁止|不允许/i,
        );
      }
    } finally {
      fs.rmSync(cleanDist, { recursive: true, force: true });
      fs.rmSync(dirtyDist, { recursive: true, force: true });
    }
  });

  it('F20-T2-03: manifest.json extracted from the ZIP passes all F02 minimal-permission redlines', () => {
    const res = runPackScript();
    expect(res.zipBuffer).not.toBeNull();
    const manifestJson = readZipEntryText(res.zipBuffer!, 'manifest.json');
    const parsed = JSON.parse(manifestJson) as ManifestV3Shape;

    expect(parsed.manifest_version).toBe(3);
    expect([...(parsed.permissions ?? [])].sort()).toEqual([
      ...EXPECTED_MANIFEST_PERMISSIONS,
    ]);
    expect([...(parsed.host_permissions ?? [])].sort()).toEqual([
      ...EXPECTED_HOST_PERMISSIONS,
    ]);
    expect(parsed.optional_host_permissions).toEqual([
      ...EXPECTED_OPTIONAL_HOST_PERMISSIONS,
    ]);
  });

  it('F20-T2-04: packaging never pollutes tracked git state with untracked .zip/.crx artifacts', () => {
    const gitignore = fs.readFileSync(resolveRepoPath('.gitignore'), 'utf8');
    expect(gitignore).toMatch(/\.zip|dist/);

    runPackScript();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const zipLines = status
      .split('\n')
      .filter((line) => /\.(zip|crx)\s*$/i.test(line));
    expect(zipLines).toEqual([]);
  });

  it('F20-T2-05: docs/发布与真机验收清单.md passes zero-leakage & no-binary-bloat audit', () => {
    const doc = readQaChecklistDoc();
    const tokens = doc.match(/gmext_[A-Za-z0-9_-]{8,}/g) ?? [];
    for (const t of tokens) {
      expect(t).toMatch(/^gmext_(demo|test|mock|example|sample|xxxx|placeholder)/i);
    }
    const docsFiles = listFilesRecursive('docs');
    expect(docsFiles.filter((f) => /\.(zip|crx)$/i.test(f))).toEqual([]);
  });
});
