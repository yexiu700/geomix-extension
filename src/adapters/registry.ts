import {
  isValidZhihuQuestionUrl,
  validatePublicHttpsUrl,
  type ExtensionProviderKey,
} from '../shared/url-validation';
import { smzdmAdapter } from './smzdm/smzdm.adapter';
import { toutiaoAdapter } from './toutiao/toutiao.adapter';
import type { PlatformDraftAdapter } from './types';
import { zhihuAdapter } from './zhihu/zhihu.adapter';

export const PROVIDER_EDITOR_ENTRY_URLS: Record<ExtensionProviderKey, string> = {
  ZHIHU_EXT: 'https://zhuanlan.zhihu.com/write',
  TOUTIAO_EXT: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  SMZDM_EXT: 'https://post.smzdm.com/tougao/',
} as const;

export const DEFAULT_ADAPTERS: readonly PlatformDraftAdapter[] = [
  zhihuAdapter,
  toutiaoAdapter,
  smzdmAdapter,
] as const;

const ZHIHU_DRAFT_EDIT_PATH_PATTERN = /^\/p\/\d+\/edit\/?$/;
const TOUTIAO_DRAFT_EDIT_PATH_PATTERN = /^\/profile_v4\/graphic\/edit(?:\/[a-zA-Z0-9_-]+)?\/?$/i;

const adapterRegistry = new Map<ExtensionProviderKey, PlatformDraftAdapter>();

function matchesRegexStateless(pattern: RegExp, input: string): boolean {
  const safePattern =
    pattern.global || pattern.sticky
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      : pattern;
  return safePattern.test(input);
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '');
}

function matchesEditorEntryUrl(parsed: URL, editorEntryUrl: string): boolean {
  let entryUrl: URL;
  try {
    entryUrl = new URL(editorEntryUrl);
  } catch {
    return false;
  }
  if (parsed.origin !== entryUrl.origin) {
    return false;
  }

  const candidatePath = normalizePathname(parsed.pathname);
  const entryPath = normalizePathname(entryUrl.pathname);

  if (entryPath === '') {
    return candidatePath === '';
  }

  return candidatePath === entryPath || candidatePath.startsWith(`${entryPath}/`);
}

function matchesSecondaryEditorUrl(
  provider: ExtensionProviderKey,
  parsed: URL,
  canonical: string,
): boolean {
  if (provider === 'ZHIHU_EXT') {
    if (isValidZhihuQuestionUrl(canonical)) {
      return true;
    }
    if (
      parsed.origin === 'https://zhuanlan.zhihu.com' &&
      ZHIHU_DRAFT_EDIT_PATH_PATTERN.test(parsed.pathname)
    ) {
      return true;
    }
  }
  if (provider === 'TOUTIAO_EXT') {
    if (
      parsed.origin === 'https://mp.toutiao.com' &&
      TOUTIAO_DRAFT_EDIT_PATH_PATTERN.test(parsed.pathname)
    ) {
      return true;
    }
  }
  return false;
}

export function registerAdapter(adapter: PlatformDraftAdapter): void {
  adapterRegistry.set(adapter.provider, adapter);
}

export function getAdapterByProvider(
  provider: ExtensionProviderKey,
): PlatformDraftAdapter | undefined {
  return adapterRegistry.get(provider);
}

export function getAdapterByUrl(rawUrl: string | URL): PlatformDraftAdapter | undefined {
  const urlString = rawUrl instanceof URL ? rawUrl.toString() : rawUrl;
  const check = validatePublicHttpsUrl(urlString);
  if (!check.ok || check.url.port !== '') {
    return undefined;
  }

  const parsed = check.url;
  const canonical = `${parsed.origin}${parsed.pathname}`;

  for (const adapter of adapterRegistry.values()) {
    if (adapter.publishedUrlPatterns.some((pattern) => matchesRegexStateless(pattern, canonical))) {
      return adapter;
    }
    if (matchesEditorEntryUrl(parsed, adapter.editorEntryUrl)) {
      return adapter;
    }
    if (matchesSecondaryEditorUrl(adapter.provider, parsed, canonical)) {
      return adapter;
    }
  }

  return undefined;
}

export function listAdapters(): PlatformDraftAdapter[] {
  return [...adapterRegistry.values()];
}

export function clearAdapters(): void {
  adapterRegistry.clear();
}

export function registerDefaultAdapters(): void {
  for (const adapter of DEFAULT_ADAPTERS) {
    registerAdapter(adapter);
  }
}

export function resetDefaultAdapters(): void {
  clearAdapters();
  registerDefaultAdapters();
}

export function getEditorEntryUrl(provider: ExtensionProviderKey): string {
  return adapterRegistry.get(provider)?.editorEntryUrl ?? PROVIDER_EDITOR_ENTRY_URLS[provider];
}

registerDefaultAdapters();
