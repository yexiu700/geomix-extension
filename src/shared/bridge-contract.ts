import { z } from 'zod';
import {
  EXTENSION_PROVIDER_KEYS,
  isCanonicalPublishedUrl,
  type ExtensionProviderKey,
} from './url-validation';

export { EXTENSION_PROVIDER_KEYS, type ExtensionProviderKey };

export const EXTENSION_TASK_STATUSES = [
  'DRAFT_VARIANT',
  'READY_TO_PUBLISH',
  'DRAFT_PUSHED',
  'PUBLISHED',
] as const;

export const DEFAULT_PENDING_TASK_STATUSES = ['DRAFT_VARIANT', 'READY_TO_PUBLISH'] as const;

export const DEFAULT_RETEST_MILESTONES = [7, 14, 30] as const;

export const EXTENSION_BRIDGE_PATHS = {
  ME: '/api/v2/extension/me',
  TASKS: '/api/v2/extension/tasks',
  confirmPublished: (taskId: string): string =>
    `/api/v2/extension/tasks/${encodeURIComponent(taskId)}/confirm-published`,
} as const;

export const ExtensionProviderKeySchema = z.enum(EXTENSION_PROVIDER_KEYS);

export const ExtensionTaskStatusSchema = z.enum(EXTENSION_TASK_STATUSES);
export type ExtensionTaskStatus = z.infer<typeof ExtensionTaskStatusSchema>;

export const ExtensionBrandSchema = z.object({
  brandId: z.string().min(1),
  brandName: z.string().min(1),
  brandMarketId: z.string().min(1),
  localBrandName: z.string().min(1),
});
export type ExtensionBrand = z.infer<typeof ExtensionBrandSchema>;

export const ExtensionMeDtoSchema = z.object({
  nickname: z.string().min(1),
  tokenLabel: z.string(),
  tokenPrefix: z.string().min(1),
  expiresAt: z.string().min(1),
  brands: z.array(ExtensionBrandSchema),
});
export type ExtensionMeDto = z.infer<typeof ExtensionMeDtoSchema>;

export const ExtensionMediaAssetSchema = z.object({
  url: z.string().min(1),
  alt: z.string(),
  mime: z.string().min(1).optional(),
});
export type ExtensionMediaAsset = z.infer<typeof ExtensionMediaAssetSchema>;

export const ExtensionPendingTaskDtoSchema = z.object({
  taskId: z.string().min(1),
  articleId: z.string().min(1),
  brandId: z.string().min(1),
  brandName: z.string().min(1),
  provider: ExtensionProviderKeySchema,
  channelLabel: z.string().min(1),
  status: ExtensionTaskStatusSchema,
  variantTitle: z.string().min(1),
  variantMarkdown: z.string(),
  variantHtml: z.string(),
  targetUrlHint: z.string().nullable(),
  mediaAssets: z.array(ExtensionMediaAssetSchema),
  complianceChecklist: z.array(z.string()),
  updatedAt: z.string().min(1),
});
export type ExtensionPendingTaskDto = z.infer<typeof ExtensionPendingTaskDtoSchema>;

export const ExtensionPendingTaskListSchema = z.array(ExtensionPendingTaskDtoSchema);

export const ExtensionTasksPayloadSchema = z
  .union([ExtensionPendingTaskListSchema, z.object({ items: ExtensionPendingTaskListSchema })])
  .transform((payload) => (Array.isArray(payload) ? payload : payload.items));

export const ExtensionTasksQuerySchema = z.object({
  brandId: z.string().min(1).optional(),
  provider: ExtensionProviderKeySchema.optional(),
  status: z.array(ExtensionTaskStatusSchema).min(1).optional(),
});
export type ExtensionTasksQuery = z.infer<typeof ExtensionTasksQuerySchema>;

export const ExtensionConfirmPublishedInputSchema = z.object({
  publishedUrl: z
    .string()
    .min(1)
    .refine((value) => isCanonicalPublishedUrl(value), {
      message:
        'publishedUrl must be a clean https:// public article URL matching a supported platform allowlist',
    }),
  publishedAt: z.string().min(1).optional(),
});
export type ExtensionConfirmPublishedInput = z.infer<typeof ExtensionConfirmPublishedInputSchema>;

export const ExtensionConfirmPublishedResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.literal('PUBLISHED'),
  publishRecordId: z.string().min(1),
  publishedUrl: z.string().min(1),
  crawlProbeQueued: z.boolean(),
  retestMilestones: z.array(z.number().int().positive()).default([...DEFAULT_RETEST_MILESTONES]),
});
export type ExtensionConfirmPublishedResult = z.infer<typeof ExtensionConfirmPublishedResultSchema>;

export const FailedImageDetailSchema = z.object({
  url: z.string().min(1),
  alt: z.string(),
  reason: z.string().min(1),
});
export type FailedImageDetail = z.infer<typeof FailedImageDetailSchema>;

export const DRAFT_INJECT_STAGES = [
  'AUTH_REQUIRED',
  'EDITOR_NOT_FOUND',
  'INJECTED',
  'PARTIAL_MEDIA_FAILED',
] as const;

export const DraftInjectStageSchema = z.enum(DRAFT_INJECT_STAGES);
export type DraftInjectStage = z.infer<typeof DraftInjectStageSchema>;

export const DraftInjectReportSchema = z.object({
  ok: z.boolean(),
  stage: DraftInjectStageSchema,
  draftUrl: z.string().min(1).optional(),
  uploadedImages: z.number().int().nonnegative(),
  failedImages: z.number().int().nonnegative(),
  failedImageDetails: z.array(FailedImageDetailSchema).optional(),
  operatorReminders: z.array(z.string()).optional(),
  message: z.string().min(1),
});
export type DraftInjectReport = z.infer<typeof DraftInjectReportSchema>;

export const RawApiEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.unknown(),
});

export function ApiEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    code: z.number(),
    msg: z.string(),
    data: dataSchema,
  });
}

export type ApiEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
};
