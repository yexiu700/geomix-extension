import { afterEach, describe, expect, it } from 'vitest';
import { PUBLISHED_URL_PATTERNS } from '../shared/url-validation';
import {
  clearAdapters,
  DEFAULT_ADAPTERS,
  getAdapterByProvider,
  getAdapterByUrl,
  getEditorEntryUrl,
  listAdapters,
  PROVIDER_EDITOR_ENTRY_URLS,
  registerAdapter,
  registerDefaultAdapters,
  resetDefaultAdapters,
} from './registry';
import { smzdmAdapter } from './smzdm/smzdm.adapter';
import { toutiaoAdapter } from './toutiao/toutiao.adapter';
import type { DraftInjectReport, PlatformDraftAdapter } from './types';
import { zhihuAdapter } from './zhihu/zhihu.adapter';

function makeMockAdapter(
  provider: PlatformDraftAdapter['provider'],
  overrides?: Partial<PlatformDraftAdapter>,
): PlatformDraftAdapter {
  return {
    provider,
    displayName: provider,
    editorEntryUrl: PROVIDER_EDITOR_ENTRY_URLS[provider],
    publishedUrlPatterns: PUBLISHED_URL_PATTERNS[provider],
    isLoggedInEditor: () => true,
    injectDraft: async (): Promise<DraftInjectReport> => ({
      ok: true,
      stage: 'INJECTED',
      uploadedImages: 0,
      failedImages: 0,
      message: 'ok',
    }),
    extractPublishedUrl: () => null,
    ...overrides,
  };
}

describe('adapters/registry', () => {
  afterEach(() => {
    resetDefaultAdapters();
  });

  it('registers all 3 platform adapters by default on module load', () => {
    expect(DEFAULT_ADAPTERS).toEqual([zhihuAdapter, toutiaoAdapter, smzdmAdapter]);
    expect(listAdapters()).toEqual([zhihuAdapter, toutiaoAdapter, smzdmAdapter]);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBe(zhihuAdapter);
    expect(getAdapterByProvider('TOUTIAO_EXT')).toBe(toutiaoAdapter);
    expect(getAdapterByProvider('SMZDM_EXT')).toBe(smzdmAdapter);
  });

  it('defines canonical default editor entry URLs for all 3 platforms', () => {
    expect(PROVIDER_EDITOR_ENTRY_URLS).toEqual({
      ZHIHU_EXT: 'https://zhuanlan.zhihu.com/write',
      TOUTIAO_EXT: 'https://mp.toutiao.com/profile_v4/graphic/publish',
      SMZDM_EXT: 'https://post.smzdm.com/tougao/',
    });
  });

  it('resolves all 3 default adapters by editor, secondary edit, and published URLs', () => {
    // Zhihu: editor, draft edit, question answer, published article & answer
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write')).toBe(zhihuAdapter);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/123456/edit')).toBe(zhihuAdapter);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/123456/edit/')).toBe(zhihuAdapter);
    expect(getAdapterByUrl('https://www.zhihu.com/question/123456')).toBe(zhihuAdapter);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/998877?utm_source=demo#top')).toBe(
      zhihuAdapter,
    );
    expect(getAdapterByUrl('https://www.zhihu.com/question/100/answer/200')).toBe(zhihuAdapter);

    // Toutiao: publish editor, edit secondary routes, published article & /i routes
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/publish')).toBe(
      toutiaoAdapter,
    );
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit')).toBe(toutiaoAdapter);
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit/?id=42')).toBe(
      toutiaoAdapter,
    );
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit/draft_789')).toBe(
      toutiaoAdapter,
    );
    expect(getAdapterByUrl('https://www.toutiao.com/article/7123456789012345678')).toBe(
      toutiaoAdapter,
    );
    expect(getAdapterByUrl('https://www.toutiao.com/i7123456789012345678')).toBe(toutiaoAdapter);

    // Toutiao negative boundaries
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit-other')).toBeUndefined();
    expect(
      getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/publish-other'),
    ).toBeUndefined();
    expect(
      getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit/%2e%2e'),
    ).toBeUndefined();

    // SMZDM: editor, /edit/<id> draft editor & published article
    expect(getAdapterByUrl('https://post.smzdm.com/tougao/')).toBe(smzdmAdapter);
    expect(getAdapterByUrl('https://post.smzdm.com/tougao/?draft_id=1')).toBe(smzdmAdapter);
    expect(getAdapterByUrl('https://post.smzdm.com/edit/anvm0rv7')).toBe(smzdmAdapter);
    expect(getAdapterByUrl('https://post.smzdm.com/edit/anvm0rv7/')).toBe(smzdmAdapter);
    expect(getAdapterByUrl('https://post.smzdm.com/p/aB12cD34')).toBe(smzdmAdapter);
  });

  it('supports clearAdapters, registerDefaultAdapters, and resetDefaultAdapters cleanly', () => {
    clearAdapters();
    expect(listAdapters()).toEqual([]);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBeUndefined();
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write')).toBeUndefined();
    expect(getEditorEntryUrl('ZHIHU_EXT')).toBe(PROVIDER_EDITOR_ENTRY_URLS.ZHIHU_EXT);

    registerDefaultAdapters();
    expect(listAdapters()).toEqual([zhihuAdapter, toutiaoAdapter, smzdmAdapter]);

    const customZhihu = makeMockAdapter('ZHIHU_EXT', { displayName: '自定义知乎' });
    registerAdapter(customZhihu);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBe(customZhihu);

    resetDefaultAdapters();
    expect(listAdapters()).toEqual([zhihuAdapter, toutiaoAdapter, smzdmAdapter]);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBe(zhihuAdapter);
  });

  it('registers, retrieves, overwrites idempotently, defensively copies, and clears custom adapters', () => {
    clearAdapters();
    expect(listAdapters()).toEqual([]);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBeUndefined();
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write')).toBeUndefined();

    const zhihu1 = makeMockAdapter('ZHIHU_EXT', { displayName: '知乎 v1' });
    const zhihu2 = makeMockAdapter('ZHIHU_EXT', { displayName: '知乎 v2' });
    const toutiao = makeMockAdapter('TOUTIAO_EXT', { displayName: '今日头条' });

    registerAdapter(zhihu1);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBe(zhihu1);

    registerAdapter(zhihu2);
    registerAdapter(toutiao);
    expect(getAdapterByProvider('ZHIHU_EXT')).toBe(zhihu2);

    const snapshot = listAdapters();
    expect(snapshot).toHaveLength(2);
    snapshot.pop();
    expect(listAdapters()).toHaveLength(2);

    clearAdapters();
    expect(listAdapters()).toEqual([]);
  });

  it('resolves getEditorEntryUrl from registered adapter or falls back to PROVIDER_EDITOR_ENTRY_URLS', () => {
    clearAdapters();
    expect(getEditorEntryUrl('ZHIHU_EXT')).toBe('https://zhuanlan.zhihu.com/write');
    expect(getEditorEntryUrl('TOUTIAO_EXT')).toBe(
      'https://mp.toutiao.com/profile_v4/graphic/publish',
    );
    expect(getEditorEntryUrl('SMZDM_EXT')).toBe('https://post.smzdm.com/tougao/');

    registerAdapter(
      makeMockAdapter('ZHIHU_EXT', {
        editorEntryUrl: 'https://zhuanlan.zhihu.com/write/custom',
      }),
    );
    expect(getEditorEntryUrl('ZHIHU_EXT')).toBe('https://zhuanlan.zhihu.com/write/custom');
  });

  it('matches editor entry URLs with segment-boundary safety, published patterns statelessly, and secondary editor URLs', () => {
    clearAdapters();
    const zhihu = makeMockAdapter('ZHIHU_EXT', {
      publishedUrlPatterns: [
        /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?$/g, // global flag tested for stateless matching
        /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+\/?$/,
      ],
    });
    const toutiao = makeMockAdapter('TOUTIAO_EXT');
    const smzdm = makeMockAdapter('SMZDM_EXT');
    registerAdapter(zhihu);
    registerAdapter(toutiao);
    registerAdapter(smzdm);

    // Editor entry URLs (with query, hash, trailing slash, subpath)
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write/?draftId=1#editor')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write/123')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/write-other')).toBeUndefined();

    // Zhihu secondary editor URLs (question answer & draft edit)
    expect(getAdapterByUrl('https://www.zhihu.com/question/123456')).toBe(zhihu);
    expect(getAdapterByUrl('https://www.zhihu.com/question/123456?sort=created')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/123456/edit')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/123456/edit/')).toBe(zhihu);

    // Published URLs (repeated calls with /g pattern must remain stateless)
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/998877?utm_source=demo#top')).toBe(zhihu);
    expect(getAdapterByUrl('https://zhuanlan.zhihu.com/p/998877')).toBe(zhihu);
    expect(getAdapterByUrl('https://www.zhihu.com/question/100/answer/200')).toBe(zhihu);

    // Toutiao & SMZDM
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/publish?from=demo')).toBe(
      toutiao,
    );
    expect(getAdapterByUrl('https://mp.toutiao.com/profile_v4/graphic/edit/draft_42')).toBe(
      toutiao,
    );
    expect(getAdapterByUrl('https://www.toutiao.com/article/7123456789012345678')).toBe(toutiao);
    expect(getAdapterByUrl(new URL('https://post.smzdm.com/tougao/'))).toBe(smzdm);
    expect(getAdapterByUrl('https://post.smzdm.com/p/aB12cD34')).toBe(smzdm);
  });

  it('fails closed on non-HTTPS, private, ported, credentialed, malformed, and unknown URLs', () => {
    const rejected = [
      '',
      'not-a-url',
      'http://zhuanlan.zhihu.com/write',
      'https://zhuanlan.zhihu.com:8443/write',
      'https://user:pass@zhuanlan.zhihu.com/write',
      'https://127.0.0.1/write',
      'https://evil.example.com/write',
      'http://mp.toutiao.com/profile_v4/graphic/edit',
      'https://mp.toutiao.com:8443/profile_v4/graphic/edit',
      'https://user:pass@mp.toutiao.com/profile_v4/graphic/edit',
    ];
    for (const candidate of rejected) {
      expect(getAdapterByUrl(candidate), candidate).toBeUndefined();
    }
  });
});
