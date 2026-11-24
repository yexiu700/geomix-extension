import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionConfirmPublishedResult } from '../shared/bridge-contract';
import type { MessageResponse } from '../shared/messages';
import type { PendingTabTask } from '../shared/storage';
import {
  CAPTURE_BAR_HOST_ID,
  getActiveCaptureBarHost,
  mountOperatorNoticeBar,
  mountUrlCaptureBar,
  unmountCaptureBar,
} from './url-capture-bar';

const DEMO_PENDING_TASK: PendingTabTask = {
  tabId: 101,
  taskId: 'task_zhihu_demo_1',
  articleId: 'art_demo_1',
  brandId: 'brand_demo_1',
  brandName: '示例品牌甲',
  provider: 'ZHIHU_EXT',
  variantTitle: '示例品牌甲 2026 实测深度指南',
  complianceChecklist: ['请人工核对合规用语'],
};

const DEMO_CONFIRM_RESULT: ExtensionConfirmPublishedResult = {
  taskId: 'task_zhihu_demo_1',
  status: 'PUBLISHED',
  publishRecordId: 'pub_demo_7788',
  publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
  crawlProbeQueued: true,
  retestMilestones: [7, 14, 30],
};

describe('content/url-capture-bar (Shadow DOM)', () => {
  afterEach(() => {
    act(() => {
      unmountCaptureBar();
    });
  });

  it('mounts inside an isolated open Shadow DOM with :host { all: initial } and zero styles leaked to document.head', async () => {
    const headStyleCountBefore = document.head.querySelectorAll(
      'style, link[rel="stylesheet"]',
    ).length;

    let handle!: ReturnType<typeof mountUrlCaptureBar>;
    act(() => {
      handle = mountUrlCaptureBar({
        task: DEMO_PENDING_TASK,
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        onConfirmPublished: vi.fn(async () => ({ ok: true as const, data: DEMO_CONFIRM_RESULT })),
      });
    });

    expect(handle.host.id).toBe(CAPTURE_BAR_HOST_ID);
    expect(document.documentElement.contains(handle.host)).toBe(true);
    expect(handle.shadowRoot).not.toBeNull();

    const styleTag = handle.shadowRoot.querySelector('style');
    expect(styleTag?.textContent?.trim().startsWith(':host {')).toBe(true);
    expect(styleTag?.textContent).toContain('all: initial;');
    expect(document.head.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(
      headStyleCountBefore,
    );

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    expect(await shadow.findByText('GeoMix 回传追踪')).toBeTruthy();
    expect(shadow.getByTestId('geomix-captured-url').textContent).toBe(
      'https://zhuanlan.zhihu.com/p/123456789',
    );

    // Verify ZERO buttons contain the word '发布'
    const buttons = shadow.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn.textContent).not.toContain('发布');
    }
  });

  it('executes Mode A happy path with synchronous double-submit guard and shows T+1 crawl probe & T+7/14/30 confirmation', async () => {
    let resolveConfirm: ((res: MessageResponse<ExtensionConfirmPublishedResult>) => void) | null =
      null;
    const onConfirmPublished = vi.fn(
      () =>
        new Promise<MessageResponse<ExtensionConfirmPublishedResult>>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const onConfirmed = vi.fn();

    let handle!: ReturnType<typeof mountUrlCaptureBar>;
    act(() => {
      handle = mountUrlCaptureBar({
        task: DEMO_PENDING_TASK,
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        onConfirmPublished,
        onConfirmed,
      });
    });

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    const ctaBtn = await shadow.findByRole('button', {
      name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
    });

    // Rapid same-tick double-click must only invoke callback ONCE
    fireEvent.click(ctaBtn);
    fireEvent.click(ctaBtn);
    expect(onConfirmPublished).toHaveBeenCalledTimes(1);
    expect(onConfirmPublished).toHaveBeenCalledWith({
      taskId: 'task_zhihu_demo_1',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
    });

    act(() => {
      resolveConfirm!({ ok: true, data: DEMO_CONFIRM_RESULT });
    });

    expect(await shadow.findByText('已成功回传至 GeoMix！')).toBeTruthy();
    expect(shadow.getByText(/pub_demo_7788/)).toBeTruthy();
    expect(shadow.getByText('T+1 抓取探针已排队')).toBeTruthy();
    expect(shadow.getByText('T+7 / T+14 / T+30 复测已预约')).toBeTruthy();
    expect(onConfirmed).toHaveBeenCalledWith(DEMO_CONFIRM_RESULT);
  });

  it('displays 401 re-pair guidance, redacts transient errors, allows retry, and supports dismiss', async () => {
    let attempt = 0;
    const onConfirmPublished = vi.fn(
      async (): Promise<MessageResponse<ExtensionConfirmPublishedResult>> => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            error: {
              kind: 'UNAUTHORIZED',
              httpStatus: 401,
              message: 'revoked token gmext_demo_secret_12345',
              reauthRequired: true,
            },
          };
        }
        if (attempt === 2) {
          return {
            ok: false,
            error: {
              kind: 'NETWORK_ERROR',
              message: 'network error for Bearer gmext_demo_secret_12345',
              reauthRequired: false,
            },
          };
        }
        return { ok: true, data: DEMO_CONFIRM_RESULT };
      },
    );
    const onDismiss = vi.fn();

    let handle!: ReturnType<typeof mountUrlCaptureBar>;
    act(() => {
      handle = mountUrlCaptureBar({
        task: DEMO_PENDING_TASK,
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        onConfirmPublished,
        onDismiss,
      });
    });

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    const ctaBtn = await shadow.findByRole('button', {
      name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
    });

    fireEvent.click(ctaBtn);
    const alert1 = await shadow.findByRole('alert');
    expect(alert1.textContent).toContain('401');
    expect(alert1.textContent).not.toContain('gmext_demo_secret_12345');

    fireEvent.click(ctaBtn);
    await waitFor(() => {
      expect(shadow.getByRole('alert').textContent).toContain('Bearer [REDACTED]');
    });
    expect(shadow.getByRole('alert').textContent).not.toContain('gmext_demo_secret_12345');

    fireEvent.click(ctaBtn);
    expect(await shadow.findByText('已成功回传至 GeoMix！')).toBeTruthy();

    fireEvent.click(shadow.getByRole('button', { name: '完成并关闭' }));
    expect(getActiveCaptureBarHost()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders Mode B partial-media failures & operator reminders with zero <img> tags and cleanly replaces with Mode A', async () => {
    let handle!: ReturnType<typeof mountOperatorNoticeBar>;
    act(() => {
      handle = mountOperatorNoticeBar({
        provider: 'SMZDM_EXT',
        variantTitle: '示例品牌甲参数横评',
        uploadedImages: 1,
        failedImages: 2,
        failedImageDetails: [
          {
            url: 'https://cdn.example.com/a.png?token=secret',
            alt: '对比表格图',
            reason: '图片体积超过 10MB 上限',
          },
          {
            url: 'https://cdn.example.com/b.png',
            alt: '实拍细节图',
            reason: '图片下载超时（超过 15 秒）',
          },
        ],
        operatorReminders: ['请手动插入值得买商品卡片', '请核对体验来源披露声明'],
        message: '正文已写入草稿箱，部分配图需手动补传',
      });
    });

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    expect(await shadow.findByText('GeoMix 草稿写入提醒')).toBeTruthy();
    expect(shadow.getByText(/对比表格图：图片体积超过 10MB 上限/)).toBeTruthy();
    expect(shadow.getByText('https://cdn.example.com/a.png')).toBeTruthy();
    expect(shadow.getByText('请手动插入值得买商品卡片')).toBeTruthy();
    expect(handle.shadowRoot.querySelectorAll('img')).toHaveLength(0);

    // Replacing Mode B with Mode A keeps strictly 1 Shadow DOM host in the document
    let nextHandle!: ReturnType<typeof mountUrlCaptureBar>;
    act(() => {
      nextHandle = mountUrlCaptureBar({
        task: { ...DEMO_PENDING_TASK, provider: 'SMZDM_EXT' },
        publishedUrl: 'https://post.smzdm.com/p/a1B2c3D4',
        onConfirmPublished: vi.fn(async () => ({ ok: true as const, data: DEMO_CONFIRM_RESULT })),
      });
    });

    expect(document.querySelectorAll(`#${CAPTURE_BAR_HOST_ID}`)).toHaveLength(1);
    const nextShadow = within(nextHandle.shadowRoot as unknown as HTMLElement);
    expect(await nextShadow.findByText('GeoMix 回传追踪')).toBeTruthy();
    expect(nextShadow.getByTestId('geomix-captured-url').textContent).toBe(
      'https://post.smzdm.com/p/a1B2c3D4',
    );

    // Calling unmount on the replaced stale handle must NOT unmount the active newer bar
    act(() => {
      handle.unmount();
    });
    expect(getActiveCaptureBarHost()).toBe(nextHandle.host);
  });

  it('redacts path-embedded gmext_ tokens in Mode B failed image URL previews', async () => {
    let handle!: ReturnType<typeof mountOperatorNoticeBar>;
    act(() => {
      handle = mountOperatorNoticeBar({
        provider: 'ZHIHU_EXT',
        variantTitle: '路径脱敏测试',
        uploadedImages: 0,
        failedImages: 1,
        failedImageDetails: [
          {
            url: 'https://cdn.example.com/gmext_demo_secret_9999/pic.png?sig=abc',
            alt: '配图',
            reason: '下载失败',
          },
        ],
        message: '配图上传失败',
      });
    });

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    expect(await shadow.findByText('GeoMix 草稿写入提醒')).toBeTruthy();
    expect(handle.shadowRoot.textContent).not.toContain('gmext_demo_secret_9999');
    expect(handle.shadowRoot.textContent).not.toContain('sig=abc');
    expect(handle.shadowRoot.textContent).toContain('gmext_[REDACTED]');
  });

  it('commits both Mode B notice bar and Mode A capture bar synchronously into shadowRoot without act or waitFor', () => {
    const headStyleCountBefore = document.head.querySelectorAll(
      'style, link[rel="stylesheet"]',
    ).length;

    const noticeHandle = mountOperatorNoticeBar({
      provider: 'ZHIHU_EXT',
      variantTitle: '同步挂载回归测试',
      uploadedImages: 1,
      failedImages: 1,
      failedImageDetails: [
        {
          url: 'https://cdn.example.com/missing.png',
          alt: '失败配图',
          reason: '图片下载失败（HTTP 404）',
        },
      ],
      operatorReminders: ['请人工核对配图'],
      message: '正文已写入草稿箱，1 张配图上传失败',
    });

    // Rendered content is synchronously available in shadowRoot immediately upon return
    expect(noticeHandle.shadowRoot.querySelector('style')?.textContent).toContain('all: initial;');
    expect(noticeHandle.shadowRoot.textContent).toContain('GeoMix 草稿写入提醒');
    expect(noticeHandle.shadowRoot.textContent).toContain('失败配图');
    expect(noticeHandle.shadowRoot.textContent).toContain('请人工核对配图');
    expect(document.head.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(
      headStyleCountBefore,
    );

    noticeHandle.unmount();
    expect(getActiveCaptureBarHost()).toBeNull();
    expect(document.getElementById(CAPTURE_BAR_HOST_ID)).toBeNull();

    const captureHandle = mountUrlCaptureBar({
      task: DEMO_PENDING_TASK,
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      onConfirmPublished: vi.fn(async () => ({ ok: true as const, data: DEMO_CONFIRM_RESULT })),
    });

    expect(captureHandle.shadowRoot.querySelector('style')?.textContent).toContain('all: initial;');
    expect(captureHandle.shadowRoot.textContent).toContain('GeoMix 回传追踪');
    expect(captureHandle.shadowRoot.textContent).toContain(
      'https://zhuanlan.zhihu.com/p/123456789',
    );
    expect(captureHandle.shadowRoot.textContent).toContain('一键回传至 GeoMix 开启 T+7/14/30 追踪');
    expect(document.head.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(
      headStyleCountBefore,
    );

    captureHandle.unmount();
    expect(getActiveCaptureBarHost()).toBeNull();
    expect(document.getElementById(CAPTURE_BAR_HOST_ID)).toBeNull();
  });

  it('preserves structured BridgeError 401 and 500 metadata when onConfirmPublished throws, redacts tokens, and supports retry (C2-07)', async () => {
    let attempt = 0;
    const onConfirmPublished = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error('Token revoked for Bearer gmext_demo_secret_thrown_401'), {
          kind: 'UNAUTHORIZED',
          httpStatus: 401,
          apiCode: 40100,
          reauthRequired: true,
        });
      }
      if (attempt === 2) {
        throw Object.assign(new Error('Upstream failed with Bearer gmext_demo_secret_thrown_500'), {
          kind: 'SERVER_ERROR',
          httpStatus: 500,
          reauthRequired: false,
        });
      }
      return { ok: true as const, data: DEMO_CONFIRM_RESULT };
    });

    let handle!: ReturnType<typeof mountUrlCaptureBar>;
    act(() => {
      handle = mountUrlCaptureBar({
        task: DEMO_PENDING_TASK,
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        onConfirmPublished,
      });
    });

    const shadow = within(handle.shadowRoot as unknown as HTMLElement);
    const submitBtn = await shadow.findByRole('button', {
      name: '一键回传至 GeoMix 开启 T+7/14/30 追踪',
    });

    // 1. Thrown 401 BridgeError renders warn banner with re-pair guidance and zero token leakage
    fireEvent.click(submitBtn);
    const warnAlert = await shadow.findByRole('alert');
    expect(warnAlert.className).toContain('gm-banner-warn');
    expect(warnAlert.textContent).toContain('重新配对');
    expect(warnAlert.textContent).not.toContain('gmext_demo_secret_thrown_401');

    // 2. Thrown 500 BridgeError renders danger banner with Bearer [REDACTED] and zero token leakage
    fireEvent.click(
      await shadow.findByRole('button', { name: '一键回传至 GeoMix 开启 T+7/14/30 追踪' }),
    );
    await waitFor(() => {
      const dangerAlert = shadow.getByRole('alert');
      expect(dangerAlert.className).toContain('gm-banner-danger');
      expect(dangerAlert.textContent).toContain('Bearer [REDACTED]');
      expect(dangerAlert.textContent).not.toContain('gmext_demo_secret_thrown_500');
    });

    // 3. Retry succeeds after recovery
    fireEvent.click(
      await shadow.findByRole('button', { name: '一键回传至 GeoMix 开启 T+7/14/30 追踪' }),
    );
    await waitFor(() => {
      expect(handle.shadowRoot.textContent).toContain('T+1');
    });
    expect(onConfirmPublished).toHaveBeenCalledTimes(3);
  });
});
