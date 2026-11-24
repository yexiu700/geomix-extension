import type {
  FailedImageDetail,
  ImageUploadResult,
  ImageUploadTarget,
  LocalImageUploader,
} from '../adapters/types';
import type { ExtensionMediaAsset } from '../shared/bridge-contract';
import {
  sendRuntimeMessage,
  type FetchMediaAssetResult,
  type MessageResponse,
} from '../shared/messages';
import { redactSensitiveText } from '../shared/storage';
import { validateMediaAssetUrl } from '../shared/url-validation';

export const MAX_IMAGE_UPLOAD_CONCURRENCY = 2 as const;

const ALLOWED_UPLOAD_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

export type LocalImageUploaderOptions = {
  concurrency?: number;
  fetchMediaAsset?: (asset: ExtensionMediaAsset) => Promise<MessageResponse<FetchMediaAssetResult>>;
};

function normalizeImageMime(rawMime: string | undefined): string {
  const base = (rawMime ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpg') {
    return 'image/jpeg';
  }
  return base;
}

export function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const cleaned = base64.replace(/\s+/g, '');
  if (cleaned.length === 0) {
    throw new Error('图片 Base64 数据为空');
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function sanitizeImageFilename(
  rawFilename: string | undefined,
  mime: string,
  index: number,
): string {
  const ext = MIME_TO_EXT[normalizeImageMime(mime)] ?? 'png';
  const fallback = `geomix-image-${index + 1}.${ext}`;

  if (typeof rawFilename !== 'string' || rawFilename.trim().length === 0) {
    return fallback;
  }

  let cleaned = '';
  for (let i = 0; i < rawFilename.length; i += 1) {
    const code = rawFilename.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    cleaned += rawFilename[i]!;
  }

  const base = cleaned
    .replace(/[/\\<>:"|?*]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return base.length > 0 ? `${base}.${ext}` : fallback;
}

export function assignFileToInput(fileInput: HTMLInputElement, file: File): void {
  const view = fileInput.ownerDocument?.defaultView;
  const DataTransferCtor = view?.DataTransfer ?? DataTransfer;
  const EventCtor = view?.Event ?? Event;
  const dt = new DataTransferCtor();
  dt.items.add(file);

  try {
    fileInput.files = dt.files;
  } catch {
    // jsdom enforces a native WebIDL FileList brand check on HTMLInputElement.prototype.files
    Object.defineProperty(fileInput, 'files', {
      value: dt.files,
      configurable: true,
      writable: true,
    });
  }

  fileInput.dispatchEvent(new EventCtor('input', { bubbles: true }));
  fileInput.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

export function pasteFileToEditor(editorElement: HTMLElement, file: File): void {
  const view = editorElement.ownerDocument?.defaultView;
  const DataTransferCtor = view?.DataTransfer ?? DataTransfer;
  const EventCtor = view?.Event ?? Event;
  const ClipboardEventCtor =
    view && view !== (globalThis as unknown)
      ? view.ClipboardEvent
      : (view?.ClipboardEvent ??
        (typeof ClipboardEvent !== 'undefined' ? ClipboardEvent : undefined));
  const dt = new DataTransferCtor();
  dt.items.add(file);

  const pasteEvent =
    typeof ClipboardEventCtor === 'function'
      ? new ClipboardEventCtor('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        })
      : new EventCtor('paste', { bubbles: true, cancelable: true });

  if ((pasteEvent as ClipboardEvent).clipboardData !== dt) {
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: dt,
      configurable: true,
    });
  }

  // Rich-text editors (Draft.js / ProseMirror) call event.preventDefault() when handling paste,
  // causing dispatchEvent() to return false; that is expected and NOT an error.
  editorElement.dispatchEvent(pasteEvent);
}

export function createLocalImageUploader(options?: LocalImageUploaderOptions): LocalImageUploader {
  const rawConcurrency = options?.concurrency ?? MAX_IMAGE_UPLOAD_CONCURRENCY;
  const effectiveConcurrency = Math.max(
    1,
    Math.min(
      MAX_IMAGE_UPLOAD_CONCURRENCY,
      Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : MAX_IMAGE_UPLOAD_CONCURRENCY,
    ),
  );

  const fetchMediaAsset =
    options?.fetchMediaAsset ??
    ((asset: ExtensionMediaAsset) =>
      sendRuntimeMessage({
        type: 'FETCH_MEDIA_ASSET',
        payload: {
          url: asset.url,
          alt: asset.alt,
          ...(asset.mime ? { mime: asset.mime } : {}),
        },
      }));

  return {
    async uploadAll(
      assets: ExtensionMediaAsset[],
      target: ImageUploadTarget,
    ): Promise<ImageUploadResult> {
      if (assets.length === 0) {
        return { uploadedImages: 0, failedImages: 0, failures: [] };
      }

      if (!target.fileInput && !target.editorElement) {
        return {
          uploadedImages: 0,
          failedImages: assets.length,
          failures: assets.map((asset) => ({
            url: asset.url,
            alt: asset.alt,
            reason: '未找到可用的平台图片上传入口，请人工补传配图',
          })),
        };
      }

      type ItemOutcome = { ok: true } | { ok: false; detail: FailedImageDetail };
      const outcomes: Array<ItemOutcome | undefined> = new Array(assets.length);
      let cursor = 0;
      let domDispatchChain = Promise.resolve();

      const runSerializedDomDispatch = async (fn: () => Promise<void> | void): Promise<void> => {
        const previous = domDispatchChain;
        let release: (() => void) | undefined;
        domDispatchChain = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await fn();
        } finally {
          release?.();
        }
      };

      const processAsset = async (
        asset: ExtensionMediaAsset,
        index: number,
      ): Promise<ItemOutcome> => {
        const urlCheck = validateMediaAssetUrl(asset.url);
        if (!urlCheck.ok) {
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: redactSensitiveText(urlCheck.reason),
            },
          };
        }

        let response: MessageResponse<FetchMediaAssetResult>;
        try {
          response = await fetchMediaAsset({
            url: urlCheck.normalizedUrl,
            alt: asset.alt,
            ...(asset.mime ? { mime: asset.mime } : {}),
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : '图片拉取通信失败';
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: redactSensitiveText(message),
            },
          };
        }

        if (!response.ok) {
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: redactSensitiveText(response.error.message || '图片拉取失败'),
            },
          };
        }

        const payload = response.data;
        if (!payload.ok) {
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: redactSensitiveText(payload.reason || '图片拉取失败'),
            },
          };
        }

        const resolvedMime = normalizeImageMime(payload.mime || asset.mime);
        if (!ALLOWED_UPLOAD_IMAGE_MIMES.has(resolvedMime)) {
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: '不支持的图片 MIME 类型',
            },
          };
        }

        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = decodeBase64ToBytes(payload.base64);
          if (bytes.byteLength === 0) {
            throw new Error('图片内容为空');
          }
        } catch {
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: '图片二进制解码失败',
            },
          };
        }

        const filename = sanitizeImageFilename(payload.filename, resolvedMime, index);
        const file = new File([bytes], filename, { type: resolvedMime });

        try {
          await runSerializedDomDispatch(async () => {
            if (target.fileInput) {
              assignFileToInput(target.fileInput, file);
              // Yield one microtask so async change listeners read fileInput.files before the next overwrite.
              await Promise.resolve();
            } else if (target.editorElement) {
              pasteFileToEditor(target.editorElement, file);
            }
          });
          return { ok: true };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : '平台编辑器图片上传触发失败';
          return {
            ok: false,
            detail: {
              url: asset.url,
              alt: asset.alt,
              reason: redactSensitiveText(message),
            },
          };
        }
      };

      const workerCount = Math.min(effectiveConcurrency, assets.length);
      const workers: Array<Promise<void>> = [];
      for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        workers.push(
          (async () => {
            while (cursor < assets.length) {
              const currentIndex = cursor;
              cursor += 1;
              const asset = assets[currentIndex]!;
              outcomes[currentIndex] = await processAsset(asset, currentIndex);
            }
          })(),
        );
      }

      await Promise.all(workers);

      let uploadedImages = 0;
      const failures: FailedImageDetail[] = [];
      for (const outcome of outcomes) {
        if (!outcome) {
          continue;
        }
        if (outcome.ok) {
          uploadedImages += 1;
        } else {
          failures.push(outcome.detail);
        }
      }

      return {
        uploadedImages,
        failedImages: failures.length,
        failures,
      };
    },
  };
}
