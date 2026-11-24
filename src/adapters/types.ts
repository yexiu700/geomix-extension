import type {
  DraftInjectReport,
  DraftInjectStage,
  ExtensionMediaAsset,
  ExtensionPendingTaskDto,
  ExtensionProviderKey,
  FailedImageDetail,
} from '../shared/bridge-contract';

export type {
  DraftInjectReport,
  DraftInjectStage,
  ExtensionMediaAsset,
  ExtensionPendingTaskDto,
  ExtensionProviderKey,
  FailedImageDetail,
};

export type ImageUploadResult = {
  uploadedImages: number;
  failedImages: number;
  failures: FailedImageDetail[];
};

export type ImageUploadTarget = {
  editorElement?: HTMLElement | null;
  fileInput?: HTMLInputElement | null;
};

export interface LocalImageUploader {
  uploadAll(assets: ExtensionMediaAsset[], target: ImageUploadTarget): Promise<ImageUploadResult>;
}

export interface PlatformDraftAdapter {
  readonly provider: ExtensionProviderKey;
  readonly displayName: string;
  readonly editorEntryUrl: string;
  readonly publishedUrlPatterns: readonly RegExp[];
  isLoggedInEditor(doc: Document, url: URL): boolean;
  injectDraft(
    doc: Document,
    task: ExtensionPendingTaskDto,
    uploader: LocalImageUploader,
  ): Promise<DraftInjectReport>;
  extractPublishedUrl(url: URL, doc: Document): string | null;
}
