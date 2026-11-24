// @ts-expect-error jsdom ships without bundled TypeScript declarations
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMediaAsset } from '../shared/bridge-contract';
import type { FetchMediaAssetResult, MessageResponse } from '../shared/messages';
import {
  assignFileToInput,
  createLocalImageUploader,
  decodeBase64ToBytes,
  pasteFileToEditor,
  sanitizeImageFilename,
} from './image-uploader';

const SAMPLE_PNG_BASE64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

function makeOkFetchResponse(
  asset: ExtensionMediaAsset,
  overrides?: Partial<Extract<FetchMediaAssetResult, { ok: true }>>,
): MessageResponse<FetchMediaAssetResult> {
  return {
    ok: true,
    data: {
      ok: true,
      url: asset.url,
      alt: asset.alt,
      base64: SAMPLE_PNG_BASE64,
      mime: asset.mime ?? 'image/png',
      filename: 'demo-pic.png',
      byteLength: 8,
      ...overrides,
    },
  };
}

describe('content/image-uploader', () => {
  it('uploads reconstructed File objects via target.fileInput with input and change events', async () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    const seenEvents: string[] = [];
    const seenFiles: File[] = [];

    fileInput.addEventListener('input', (event) => {
      expect(event.bubbles).toBe(true);
      seenEvents.push('input');
    });
    fileInput.addEventListener('change', (event) => {
      expect(event.bubbles).toBe(true);
      seenEvents.push('change');
      const f = fileInput.files?.[0];
      if (f) {
        seenFiles.push(f);
      }
    });

    const uploader = createLocalImageUploader({
      fetchMediaAsset: vi.fn(async (asset) => makeOkFetchResponse(asset)),
    });

    const result = await uploader.uploadAll(
      [
        { url: 'https://cdn.example.com/a.png', alt: '图1', mime: 'image/png' },
        { url: 'https://cdn.example.com/b.png', alt: '图2', mime: 'image/png' },
      ],
      { fileInput },
    );

    expect(result).toEqual({ uploadedImages: 2, failedImages: 0, failures: [] });
    expect(seenEvents).toEqual(['input', 'change', 'input', 'change']);
    expect(seenFiles).toHaveLength(2);
    expect(seenFiles[0]?.name).toBe('demo-pic.png');
    expect(seenFiles[0]?.type).toBe('image/png');
    expect(seenFiles[0]?.size).toBe(8);
  });

  it('uploads via ClipboardEvent paste on target.editorElement even when editor calls preventDefault()', async () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const pastedFiles: File[] = [];

    editor.addEventListener('paste', (event) => {
      // Rich-text editors preventDefault() on paste; dispatchEvent() returns false!
      event.preventDefault();
      const clip = (event as ClipboardEvent).clipboardData;
      expect(clip).not.toBeNull();
      const firstFile = clip?.files[0] ?? clip?.items[0]?.getAsFile() ?? null;
      if (firstFile) {
        pastedFiles.push(firstFile);
      }
    });

    const uploader = createLocalImageUploader({
      fetchMediaAsset: vi.fn(async (asset) =>
        makeOkFetchResponse(asset, { mime: 'image/jpeg', filename: 'cover.jpg' }),
      ),
    });

    const result = await uploader.uploadAll(
      [{ url: 'https://cdn.example.com/cover.jpg', alt: '封面图' }],
      { editorElement: editor },
    );

    expect(result).toEqual({ uploadedImages: 1, failedImages: 0, failures: [] });
    expect(pastedFiles).toHaveLength(1);
    expect(pastedFiles[0]?.name).toBe('cover.jpg');
    expect(pastedFiles[0]?.type).toBe('image/jpeg');
  });

  it('strictly caps upload concurrency at <= 2 even when caller requests higher concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const editor = document.createElement('div');
    const uploader = createLocalImageUploader({
      concurrency: 10,
      fetchMediaAsset: vi.fn(async (asset) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return makeOkFetchResponse(asset);
      }),
    });

    const assets: ExtensionMediaAsset[] = Array.from({ length: 5 }, (_, idx) => ({
      url: `https://cdn.example.com/img-${idx}.png`,
      alt: `图 ${idx}`,
    }));

    const result = await uploader.uploadAll(assets, { editorElement: editor });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result).toEqual({ uploadedImages: 5, failedImages: 0, failures: [] });
  });

  it('records partial failures (oversized, non-HTTPS, invalid Base64, SVG MIME) without ever injecting external <img> URLs', async () => {
    const editor = document.createElement('div');
    const fetchMock = vi.fn(
      async (asset: ExtensionMediaAsset): Promise<MessageResponse<FetchMediaAssetResult>> => {
        if (asset.url.includes('ok.png')) {
          return makeOkFetchResponse(asset);
        }
        if (asset.url.includes('big.png')) {
          return {
            ok: true,
            data: {
              ok: false,
              url: asset.url,
              alt: asset.alt,
              code: 'TOO_LARGE',
              reason: '图片体积超过 10MB 上限',
            },
          };
        }
        if (asset.url.includes('svg.svg')) {
          return makeOkFetchResponse(asset, { mime: 'image/svg+xml', filename: 'bad.svg' });
        }
        return makeOkFetchResponse(asset, { base64: '@@@not-base64@@@' });
      },
    );

    const uploader = createLocalImageUploader({ fetchMediaAsset: fetchMock });
    const result = await uploader.uploadAll(
      [
        { url: 'https://cdn.example.com/ok.png', alt: '成功图' },
        { url: 'https://cdn.example.com/big.png', alt: '超大图' },
        { url: 'http://cdn.example.com/insecure.png', alt: '非HTTPS图' },
        { url: 'https://cdn.example.com/svg.svg', alt: 'SVG图' },
        { url: 'https://cdn.example.com/corrupt.png', alt: '损坏图' },
      ],
      { editorElement: editor },
    );

    expect(result.uploadedImages).toBe(1);
    expect(result.failedImages).toBe(4);
    expect(result.failures.map((item) => item.alt)).toEqual([
      '超大图',
      '非HTTPS图',
      'SVG图',
      '损坏图',
    ]);
    // Non-HTTPS URL was rejected client-side before even calling SW
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Editor DOM must NEVER contain fallback external <img> tags
    expect(editor.querySelectorAll('img')).toHaveLength(0);
    expect(editor.innerHTML).not.toContain('cdn.example.com');
  });

  it('short-circuits cleanly when no upload target is provided without calling SW', async () => {
    const fetchMock = vi.fn();
    const uploader = createLocalImageUploader({ fetchMediaAsset: fetchMock });

    const result = await uploader.uploadAll(
      [{ url: 'https://cdn.example.com/a.png', alt: '缺入口图' }],
      {},
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.uploadedImages).toBe(0);
    expect(result.failedImages).toBe(1);
    expect(result.failures[0]?.reason).toContain('上传入口');
  });

  it('decodes Base64 cleanly and sanitizes filenames safely', () => {
    expect(decodeBase64ToBytes(SAMPLE_PNG_BASE64).byteLength).toBe(8);
    expect(sanitizeImageFilename('../../etc/passwd.png', 'image/png', 0)).toBe('etc-passwd.png');
    expect(sanitizeImageFilename(undefined, 'image/webp', 1)).toBe('geomix-image-2.webp');
  });

  it('serializes shared fileInput assignments so async microtask change listeners never lose earlier files under concurrency=2 (C2-04)', async () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';

    const asyncReadNames: string[] = [];
    fileInput.addEventListener('change', () => {
      void Promise.resolve().then(() => {
        asyncReadNames.push(fileInput.files?.[0]?.name ?? 'missing');
      });
    });

    const assets: ExtensionMediaAsset[] = [
      { url: 'https://cdn.example.com/first.png', alt: '图1' },
      { url: 'https://cdn.example.com/second.png', alt: '图2' },
    ];

    const uploader = createLocalImageUploader({
      concurrency: 2,
      fetchMediaAsset: vi.fn(async (asset) => {
        const filename = asset.url.endsWith('first.png') ? 'first.png' : 'second.png';
        return makeOkFetchResponse(asset, { filename });
      }),
    });

    const result = await uploader.uploadAll(assets, { fileInput });
    await Promise.resolve();

    expect(result).toEqual({ uploadedImages: 2, failedImages: 0, failures: [] });
    expect(asyncReadNames).toEqual(['first.png', 'second.png']);
  });

  it('dispatches input/change/paste events cleanly on cross-realm JSDOM elements (C2-04)', () => {
    const foreignDom = new JSDOM(
      '<!doctype html><html><body><input type="file" /><div contenteditable="true"></div></body></html>',
      { url: 'https://zhuanlan.zhihu.com/write' },
    ) as { window: { document: Document } };
    const foreignInput = foreignDom.window.document.querySelector('input')!;
    const foreignEditor = foreignDom.window.document.querySelector('div')!;

    const receivedEvents: string[] = [];
    foreignInput.addEventListener('input', () => receivedEvents.push('input'));
    foreignInput.addEventListener('change', () => receivedEvents.push('change'));
    foreignEditor.addEventListener('paste', (event: Event) => {
      const clip = (event as ClipboardEvent).clipboardData;
      receivedEvents.push(`paste:${clip?.files?.[0]?.name ?? 'none'}`);
    });

    const file = new File([decodeBase64ToBytes(SAMPLE_PNG_BASE64)], 'cross-realm.png', {
      type: 'image/png',
    });

    expect(() => assignFileToInput(foreignInput, file)).not.toThrow();
    expect(() => pasteFileToEditor(foreignEditor, file)).not.toThrow();
    expect(receivedEvents).toEqual(['input', 'change', 'paste:cross-realm.png']);
  });
});
