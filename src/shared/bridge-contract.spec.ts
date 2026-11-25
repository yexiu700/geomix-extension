import { describe, expect, it } from 'vitest';
import {
  ApiEnvelopeSchema,
  DraftInjectReportSchema,
  EXTENSION_BRIDGE_PATHS,
  ExtensionConfirmPublishedInputSchema,
  ExtensionConfirmPublishedResultSchema,
  ExtensionMeDtoSchema,
  ExtensionPendingTaskDtoSchema,
  ExtensionTasksPayloadSchema,
  type ExtensionPendingTaskDto,
} from './bridge-contract';

function makeSyntheticTask(
  overrides: Partial<ExtensionPendingTaskDto> = {},
): ExtensionPendingTaskDto {
  return {
    taskId: 'task_demo_1',
    articleId: 'article_demo_1',
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
    provider: 'ZHIHU_EXT',
    channelLabel: '知乎专栏',
    status: 'READY_TO_PUBLISH',
    variantTitle: '示例品牌甲实测对比分析',
    variantMarkdown: '# 示例标题\n\n正文段落',
    variantHtml: '<h1>示例标题</h1><p>正文段落</p>',
    targetUrlHint: null,
    mediaAssets: [
      {
        url: 'https://cdn.example.com/assets/demo-1.png',
        alt: '对比图一',
        mime: 'image/png',
      },
    ],
    complianceChecklist: ['避免绝对化宣传用语', '请人工核对配图清晰度'],
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('bridge-contract', () => {
  it('defines exact Bridge v1 endpoint paths', () => {
    expect(EXTENSION_BRIDGE_PATHS.ME).toBe('/api/v2/extension/me');
    expect(EXTENSION_BRIDGE_PATHS.TASKS).toBe('/api/v2/extension/tasks');
    expect(EXTENSION_BRIDGE_PATHS.confirmPublished('task_demo_1')).toBe(
      '/api/v2/extension/tasks/task_demo_1/confirm-published',
    );
  });

  it('validates ExtensionMeDto with multi-brand and empty brand lists', () => {
    const valid = ExtensionMeDtoSchema.parse({
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
    });
    expect(valid.brands).toHaveLength(1);

    const emptyBrands = ExtensionMeDtoSchema.parse({
      nickname: 'DemoOperator',
      tokenLabel: '',
      tokenPrefix: 'gmext_demo',
      expiresAt: '2026-12-31T23:59:59.000Z',
      brands: [],
    });
    expect(emptyBrands.brands).toEqual([]);

    expect(
      ExtensionMeDtoSchema.safeParse({
        nickname: '',
        tokenLabel: '测试设备',
        tokenPrefix: 'gmext_demo',
        expiresAt: '2026-12-31T23:59:59.000Z',
        brands: [],
      }).success,
    ).toBe(false);

    // Real GeoMix v2.2 server Bridge v1 payload shape (#9)
    const serverMe = ExtensionMeDtoSchema.parse({
      bridgeVersion: 'v1',
      userDisplayName: 'op***r',
      tokenLabel: '办公电脑 Chrome',
      tokenPrefix: 'gmext_123456',
      expiresAt: '2026-12-31T23:59:59.000Z',
      brands: [
        {
          id: 'brand_cn_1',
          name: 'NordicAudio',
          localBrandName: '北境声学',
          category: '开放式运动耳机',
          market: 'CN',
        },
      ],
    });
    expect(serverMe).toEqual({
      nickname: 'op***r',
      tokenLabel: '办公电脑 Chrome',
      tokenPrefix: 'gmext_123456',
      expiresAt: '2026-12-31T23:59:59.000Z',
      brands: [
        {
          brandId: 'brand_cn_1',
          brandName: 'NordicAudio',
          brandMarketId: 'brand_cn_1:CN',
          localBrandName: '北境声学',
        },
      ],
    });
  });

  it('validates ExtensionPendingTaskDto across all 3 providers, 4 statuses, and payload shapes', () => {
    const zhihuTask = makeSyntheticTask({
      provider: 'ZHIHU_EXT',
      status: 'DRAFT_VARIANT',
      targetUrlHint: 'https://www.zhihu.com/question/123456',
    });
    const toutiaoTask = makeSyntheticTask({
      taskId: 'task_demo_2',
      provider: 'TOUTIAO_EXT',
      status: 'DRAFT_PUSHED',
      mediaAssets: [{ url: 'https://cdn.example.com/assets/demo-2.jpg', alt: '' }],
      complianceChecklist: [],
    });
    const smzdmTask = makeSyntheticTask({
      taskId: 'task_demo_3',
      provider: 'SMZDM_EXT',
      status: 'PUBLISHED',
    });

    expect(ExtensionPendingTaskDtoSchema.parse(zhihuTask).provider).toBe('ZHIHU_EXT');
    expect(ExtensionPendingTaskDtoSchema.parse(toutiaoTask).mediaAssets[0]?.mime).toBeUndefined();
    expect(ExtensionPendingTaskDtoSchema.parse(smzdmTask).status).toBe('PUBLISHED');

    const directArray = ExtensionTasksPayloadSchema.parse([zhihuTask, toutiaoTask]);
    expect(directArray).toHaveLength(2);

    const wrappedItems = ExtensionTasksPayloadSchema.parse({ items: [smzdmTask] });
    expect(wrappedItems).toHaveLength(1);
    expect(wrappedItems[0]?.taskId).toBe('task_demo_3');

    // Real GeoMix v2.2 server /api/v2/extension/tasks payload shape (#9)
    const serverWrapped = ExtensionTasksPayloadSchema.parse({
      bridgeVersion: 'v1',
      items: [
        {
          taskId: 'task_srv_1',
          articleId: 'art_srv_1',
          brandId: 'brand_cn_1',
          brandName: '北境声学',
          provider: 'ZHIHU_EXT',
          channelLabel: '知乎',
          status: 'READY_TO_PUBLISH',
          variantTitle: '北境声学实测评测',
          variantMarkdown: '# 标题',
          variantHtml: '<h1>标题</h1>',
          targetUrlHint: null,
          mediaAssets: [
            {
              id: 'media_1',
              title: '实拍主图',
              url: 'https://cdn.example.com/1.jpg',
              mime: null,
            },
          ],
          antiBanChecklist: ['人工复核后再发布'],
          remotePublishedUrl: null,
          updatedAt: '2026-06-01T10:00:00.000Z',
        },
      ],
    });
    expect(serverWrapped).toHaveLength(1);
    expect(serverWrapped[0]?.complianceChecklist).toEqual(['人工复核后再发布']);
    expect(serverWrapped[0]?.mediaAssets).toEqual([
      { url: 'https://cdn.example.com/1.jpg', alt: '实拍主图' },
    ]);

    // Real GeoMix v2.2 server /confirm-published payload shape (#9)
    const serverConfirm = ExtensionConfirmPublishedResultSchema.parse({
      accepted: true,
      taskId: 'task_srv_1',
      publishRecordId: 'pub_srv_1',
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      status: 'PUBLISHED',
      alreadyRecorded: false,
      retestScheduledCount: 3,
    });
    expect(serverConfirm.crawlProbeQueued).toBe(true);
    expect(serverConfirm.retestMilestones).toEqual([7, 14, 30]);

    expect(
      ExtensionPendingTaskDtoSchema.safeParse({
        ...zhihuTask,
        provider: 'UNSUPPORTED_EXT',
      }).success,
    ).toBe(false);
  });

  it('validates ExtensionConfirmPublishedInput with strict clean public URL allowlist', () => {
    const okResult = ExtensionConfirmPublishedInputSchema.parse({
      publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      publishedAt: '2026-06-01T12:00:00.000Z',
    });
    expect(okResult.publishedUrl).toBe('https://zhuanlan.zhihu.com/p/123456789');

    const okNoTimestamp = ExtensionConfirmPublishedInputSchema.parse({
      publishedUrl: 'https://post.smzdm.com/p/a1B2c3D4',
    });
    expect(okNoTimestamp.publishedAt).toBeUndefined();

    const rejectedUrls = [
      'https://zhuanlan.zhihu.com/p/123456789/edit',
      'https://zhuanlan.zhihu.com/write',
      'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo',
      'https://zhuanlan.zhihu.com/p/123456789#top',
      'http://zhuanlan.zhihu.com/p/123456789',
      'https://127.0.0.1/p/123456789',
      'https://mp.toutiao.com/profile_v4/graphic/publish',
    ];
    for (const url of rejectedUrls) {
      expect(
        ExtensionConfirmPublishedInputSchema.safeParse({ publishedUrl: url }).success,
        url,
      ).toBe(false);
    }
  });

  it('validates ExtensionConfirmPublishedResult including default retestMilestones', () => {
    const withDefault = ExtensionConfirmPublishedResultSchema.parse({
      taskId: 'task_demo_1',
      status: 'PUBLISHED',
      publishRecordId: 'pub_demo_1',
      publishedUrl: 'https://www.toutiao.com/article/7123456789012345678',
      crawlProbeQueued: true,
    });
    expect(withDefault.retestMilestones).toEqual([7, 14, 30]);

    expect(
      ExtensionConfirmPublishedResultSchema.safeParse({
        ...withDefault,
        status: 'DRAFT_PUSHED',
      }).success,
    ).toBe(false);
  });

  it('validates ApiEnvelopeSchema and DraftInjectReportSchema across all 4 stages', () => {
    const envelopeSchema = ApiEnvelopeSchema(ExtensionConfirmPublishedResultSchema);
    const parsed = envelopeSchema.parse({
      code: 0,
      msg: 'ok',
      data: {
        taskId: 'task_demo_1',
        status: 'PUBLISHED',
        publishRecordId: 'pub_demo_1',
        publishedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
        crawlProbeQueued: true,
        retestMilestones: [7, 14, 30],
      },
    });
    expect(parsed.code).toBe(0);

    const partialReport = DraftInjectReportSchema.parse({
      ok: false,
      stage: 'PARTIAL_MEDIA_FAILED',
      draftUrl: 'https://zhuanlan.zhihu.com/p/123456789/edit',
      uploadedImages: 1,
      failedImages: 1,
      failedImageDetails: [
        {
          url: 'https://cdn.example.com/assets/demo-fail.png',
          alt: '失败配图',
          reason: '图片下载超时',
        },
      ],
      operatorReminders: ['请人工补充上传失败配图'],
      message: '正文已写入草稿箱，但有 1 张配图上传失败',
    });
    expect(partialReport.stage).toBe('PARTIAL_MEDIA_FAILED');

    expect(
      DraftInjectReportSchema.safeParse({
        ok: true,
        stage: 'INJECTED',
        uploadedImages: -1,
        failedImages: 0,
        message: 'invalid negative count',
      }).success,
    ).toBe(false);
  });
});
