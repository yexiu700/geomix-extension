import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMeDto, ExtensionPendingTaskDto } from './bridge-contract';
import {
  clearPairing,
  clearPendingTabTasks,
  createPendingTabTaskFromDto,
  getPairing,
  getPendingTabTask,
  getPublicPairing,
  isValidGmextToken,
  listPendingTabTasks,
  PAIRING_STORAGE_KEY,
  redactSensitiveText,
  removePendingTabTask,
  savePairing,
  setPendingTabTask,
  TAB_TASKS_STORAGE_KEY,
  updatePendingTabTask,
  validatePairingToken,
  type ChromeStorageAreaLike,
} from './storage';

const DEMO_TOKEN = 'gmext_demo_token_0001';
const DEMO_ME: ExtensionMeDto = {
  nickname: 'DemoOperator',
  tokenLabel: '测试设备',
  tokenPrefix: 'gmext_demo',
  expiresAt: '2026-12-31T23:59:59.000Z',
  brands: [
    {
      brandId: 'brand_demo_1',
      brandName: 'DemoBrand Alpha',
      brandMarketId: 'bm_cn_1',
      localBrandName: '示例品牌甲',
    },
  ],
};

describe('storage', () => {
  it('validates synthetic gmext_ tokens and rejects invalid formats', () => {
    expect(isValidGmextToken(DEMO_TOKEN)).toBe(true);
    expect(validatePairingToken(`  ${DEMO_TOKEN}  `)).toEqual({
      ok: true,
      token: DEMO_TOKEN,
    });

    const invalidTokens = [
      '',
      'gmext_',
      'gmext_short',
      'bearer_1234567890',
      'gmext_has space_12345',
      'gmext_demo_token_0001\r\n',
      `gmext_${'a'.repeat(520)}`,
    ];
    for (const token of invalidTokens) {
      expect(isValidGmextToken(token), token).toBe(false);
    }
  });

  it('persists, reads, sanitizes public view, and immediately wipes credentials in chrome.storage.local', async () => {
    const saved = await savePairing({
      baseUrl: 'https://geo.example.com/',
      token: DEMO_TOKEN,
      me: DEMO_ME,
      pairedAt: '2026-06-01T10:00:00.000Z',
    });

    expect(saved.baseUrl).toBe('https://geo.example.com');
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [PAIRING_STORAGE_KEY]: saved,
    });

    const loaded = await getPairing();
    expect(loaded).toEqual(saved);

    const publicView = await getPublicPairing();
    expect(publicView).toEqual({
      baseUrl: 'https://geo.example.com',
      me: DEMO_ME,
      pairedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(publicView).not.toHaveProperty('token');

    await clearPairing();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(PAIRING_STORAGE_KEY);
    expect(await getPairing()).toBeNull();
  });

  it('never writes to Web Storage or logs raw tokens to console.*', async () => {
    const webStorageSetSpy = vi.spyOn(Storage.prototype, 'setItem');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await savePairing({
      baseUrl: 'https://geo.example.com',
      token: DEMO_TOKEN,
      me: DEMO_ME,
    });
    await getPairing();
    await getPublicPairing();
    await clearPairing();

    await expect(
      savePairing({
        baseUrl: 'http://geo.example.com',
        token: DEMO_TOKEN,
        me: DEMO_ME,
      }),
    ).rejects.toThrow();

    expect(webStorageSetSpy).not.toHaveBeenCalled();

    const allConsoleOutput = [
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...debugSpy.mock.calls,
    ]
      .flat()
      .map((item) => String(item))
      .join('\n');

    expect(allConsoleOutput).not.toContain(DEMO_TOKEN);
  });

  it('rejects non-HTTPS/private baseUrl or invalid token and leaves storage clean', async () => {
    await expect(
      savePairing({
        baseUrl: 'http://geo.example.com',
        token: DEMO_TOKEN,
        me: DEMO_ME,
      }),
    ).rejects.toThrow();

    await expect(
      savePairing({
        baseUrl: 'https://127.0.0.1',
        token: DEMO_TOKEN,
        me: DEMO_ME,
      }),
    ).rejects.toThrow();

    await expect(
      savePairing({
        baseUrl: 'https://geo.example.com',
        token: 'invalid_token',
        me: DEMO_ME,
      }),
    ).rejects.toThrow();

    expect(await getPairing()).toBeNull();
  });

  it('returns null safely when chrome.storage.local contains corrupt data', async () => {
    await chrome.storage.local.set({
      [PAIRING_STORAGE_KEY]: { baseUrl: 'http://bad.example.com', token: 'bad', me: {} },
    });
    expect(await getPairing()).toBeNull();
  });

  it('redacts gmext_ tokens and Bearer credentials cleanly and idempotently', () => {
    expect(redactSensitiveText('Authorization: Bearer gmext_demo_123')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactSensitiveText(redactSensitiveText('Authorization: Bearer gmext_demo_123'))).toBe(
      'Authorization: Bearer [REDACTED]',
    );

    const raw = `Auth failed for Bearer ${DEMO_TOKEN} and token=${DEMO_TOKEN}`;
    const redacted = redactSensitiveText(raw);
    expect(redacted).toBe('Auth failed for Bearer [REDACTED] and token=gmext_[REDACTED]');
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it('rejects oversized whitespace-padded pairing tokens before trim', () => {
    const padded = `${' '.repeat(520)}${DEMO_TOKEN}`;
    const result = validatePairingToken(padded);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('512');
    }
  });

  describe('chrome.storage.session tab tasks (geomix.tabTasks.v1)', () => {
    const sampleDto: ExtensionPendingTaskDto = {
      taskId: 'task_demo_101',
      articleId: 'art_demo_101',
      brandId: 'brand_demo_1',
      brandName: '示例品牌甲',
      provider: 'ZHIHU_EXT',
      channelLabel: '知乎专栏',
      status: 'READY_TO_PUBLISH',
      variantTitle: '示例品牌甲实测笔记',
      variantMarkdown: '# 标题',
      variantHtml: '<h1>标题</h1>',
      targetUrlHint: null,
      mediaAssets: [],
      complianceChecklist: ['人工核对合规项'],
      updatedAt: '2026-06-01T10:00:00.000Z',
    };

    it('creates, persists, updates, lists, removes, and clears PendingTabTask strictly in chrome.storage.session', async () => {
      const record = createPendingTabTaskFromDto(101, sampleDto);
      const saved = await setPendingTabTask(record);
      expect(saved).toEqual(record);
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        [TAB_TASKS_STORAGE_KEY]: { '101': record },
      });
      expect(chrome.storage.local.set).not.toHaveBeenCalled();

      expect(await getPendingTabTask(101)).toEqual(record);
      expect(await getPendingTabTask(999)).toBeNull();
      expect(await getPendingTabTask(0)).toBeNull();
      expect(await getPendingTabTask(-5)).toBeNull();

      const updated = await updatePendingTabTask(101, {
        injectedAt: '2026-06-01T10:05:00.000Z',
        lastInjectReport: {
          ok: true,
          stage: 'INJECTED',
          uploadedImages: 2,
          failedImages: 0,
          message: '已写入知乎草稿箱',
        },
      });
      expect(updated?.injectedAt).toBe('2026-06-01T10:05:00.000Z');
      expect(updated?.lastInjectReport?.stage).toBe('INJECTED');
      expect(
        await updatePendingTabTask(999, { injectedAt: '2026-06-01T10:05:00.000Z' }),
      ).toBeNull();

      const listed = await listPendingTabTasks();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.taskId).toBe('task_demo_101');

      await removePendingTabTask(101);
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(TAB_TASKS_STORAGE_KEY);
      expect(await getPendingTabTask(101)).toBeNull();

      await setPendingTabTask(createPendingTabTaskFromDto(201, sampleDto));
      await setPendingTabTask(
        createPendingTabTaskFromDto(202, { ...sampleDto, taskId: 'task_demo_202' }),
      );
      await clearPendingTabTasks();
      expect(await listPendingTabTasks()).toEqual([]);
    });

    it('strips unknown credential-like keys and never stores gmext_ tokens in session storage', async () => {
      const polluted = {
        ...createPendingTabTaskFromDto(301, sampleDto),
        token: DEMO_TOKEN,
        baseUrl: 'https://geo.example.com',
      };
      const saved = await setPendingTabTask(
        polluted as unknown as ReturnType<typeof createPendingTabTaskFromDto>,
      );
      expect(JSON.stringify(saved)).not.toContain(DEMO_TOKEN);
      expect(saved).not.toHaveProperty('token');
      expect(saved).not.toHaveProperty('baseUrl');

      const stored = await chrome.storage.session.get(TAB_TASKS_STORAGE_KEY);
      expect(JSON.stringify(stored)).not.toContain(DEMO_TOKEN);
    });

    it('skips corrupted and mismatched entries individually without breaking valid sibling tabs', async () => {
      const valid = createPendingTabTaskFromDto(105, sampleDto);
      await chrome.storage.session.set({
        [TAB_TASKS_STORAGE_KEY]: {
          '105': valid,
          '106': { ...valid, tabId: 999 }, // mismatched tabId vs key
          '0': { ...valid, tabId: 0 }, // non-positive key
          __proto__: { ...valid, tabId: 107 }, // prototype key
          '108': { tabId: 108, taskId: '' }, // invalid schema
        },
      });

      const list = await listPendingTabTasks();
      expect(list).toEqual([valid]);
      expect(await getPendingTabTask(105)).toEqual(valid);
      expect(await getPendingTabTask(106)).toBeNull();
      expect(await getPendingTabTask(108)).toBeNull();
    });

    it('serializes concurrent read-modify-write operations so sibling tabs never clobber each other', async () => {
      const backing = new Map<string, unknown>();
      const delayedArea = {
        async get(key?: string | string[] | Record<string, unknown> | null) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (typeof key === 'string') {
            return backing.has(key) ? { [key]: structuredClone(backing.get(key)) } : {};
          }
          return {};
        },
        async set(items: Record<string, unknown>) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          for (const [k, v] of Object.entries(items)) {
            backing.set(k, structuredClone(v));
          }
        },
        async remove(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) {
            backing.delete(k);
          }
        },
      } as unknown as ChromeStorageAreaLike;

      const t1 = createPendingTabTaskFromDto(11, { ...sampleDto, taskId: 'task_11' });
      const t2 = createPendingTabTaskFromDto(12, { ...sampleDto, taskId: 'task_12' });
      const t3 = createPendingTabTaskFromDto(13, { ...sampleDto, taskId: 'task_13' });

      await Promise.all([
        setPendingTabTask(t1, delayedArea),
        setPendingTabTask(t2, delayedArea),
        setPendingTabTask(t3, delayedArea),
      ]);

      const all = await listPendingTabTasks(delayedArea);
      expect(all.map((item) => item.tabId).sort((a, b) => a - b)).toEqual([11, 12, 13]);

      await Promise.all([
        updatePendingTabTask(11, { injectedAt: '2026-06-01T11:00:00.000Z' }, delayedArea),
        removePendingTabTask(12, delayedArea),
      ]);

      const remaining = await listPendingTabTasks(delayedArea);
      expect(remaining.map((item) => item.tabId).sort((a, b) => a - b)).toEqual([11, 13]);
      expect((await getPendingTabTask(11, delayedArea))?.injectedAt).toBe(
        '2026-06-01T11:00:00.000Z',
      );
    });
  });
});
