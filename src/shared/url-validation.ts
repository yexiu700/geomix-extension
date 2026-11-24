export const EXTENSION_PROVIDER_KEYS = ['ZHIHU_EXT', 'TOUTIAO_EXT', 'SMZDM_EXT'] as const;
export type ExtensionProviderKey = (typeof EXTENSION_PROVIDER_KEYS)[number];

export const MAX_URL_LENGTH = 2048;

export const PUBLISHED_URL_PATTERNS: Record<ExtensionProviderKey, readonly RegExp[]> = {
  ZHIHU_EXT: [
    /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?$/,
    /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+\/?$/,
  ],
  TOUTIAO_EXT: [
    /^https:\/\/www\.toutiao\.com\/article\/\d+\/?$/,
    /^https:\/\/www\.toutiao\.com\/i\d+\/?$/,
  ],
  SMZDM_EXT: [/^https:\/\/post\.smzdm\.com\/p\/[a-zA-Z0-9]+\/?$/],
};

export const ZHIHU_QUESTION_URL_PATTERN = /^https:\/\/www\.zhihu\.com\/question\/\d+\/?$/;

export const ALLOWED_PLATFORM_ORIGINS: ReadonlySet<string> = new Set([
  'https://zhuanlan.zhihu.com',
  'https://www.zhihu.com',
  'https://mp.toutiao.com',
  'https://www.toutiao.com',
  'https://post.smzdm.com',
]);

const FORBIDDEN_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.lan',
  '.intranet',
] as const;

export type UrlValidationResult =
  { ok: true; url: URL; normalizedUrl: string } | { ok: false; reason: string };

export type BaseUrlValidationResult =
  | { ok: true; normalizedUrl: string; origin: string; originPattern: string }
  | { ok: false; reason: string };

export type PublishedUrlValidationResult =
  | { ok: true; provider: ExtensionProviderKey; normalizedUrl: string }
  | { ok: false; reason: string };

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isPrivateOrReservedIpv4(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF reserved
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function parseDottedIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) {
    return null;
  }
  return [a, b, c, d];
}

function parseIpv6Groups(raw: string): number[] | null {
  if (!raw || raw.includes('%')) {
    return null;
  }

  let input = raw.toLowerCase();
  const lastColon = input.lastIndexOf(':');
  if (lastColon !== -1 && input.slice(lastColon + 1).includes('.')) {
    const ipv4Part = input.slice(lastColon + 1);
    const octets = parseDottedIpv4(ipv4Part);
    if (!octets) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = input.split('::');
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseSegment = (segment: string): number[] | null => {
    if (segment === '') {
      return [];
    }
    const tokens = segment.split(':');
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) {
        return null;
      }
      out.push(Number.parseInt(token, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSegment(doubleColonParts[0] ?? '');
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSegment(doubleColonParts[0] ?? '');
  const right = parseSegment(doubleColonParts[1] ?? '');
  if (!left || !right) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateOrReservedIpv6(rawIpv6: string): boolean {
  const g = parseIpv6Groups(rawIpv6);
  if (!g || g.length !== 8) {
    return true;
  }

  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;
  const g2 = g[2] ?? 0;

  // Default-deny everything outside Global Unicast 2000::/3.
  // Blocks ::, ::1, ::/96, ::ffff:0:0/96, RFC 2765 SIIT ::ffff:0:0:0/96,
  // RFC 6666 Discard-Only 100::/64, NAT64 64:ff9b::/96 & 64:ff9b:1::/48,
  // ULA fc00::/7, Link-Local fe80::/10, Site-Local fec0::/10, Multicast ff00::/8, etc.
  if ((g0 & 0xe000) !== 0x2000) {
    return true;
  }

  // Teredo 2001::/32 (RFC 4380)
  if (g0 === 0x2001 && g1 === 0x0000) {
    return true;
  }
  // Benchmarking 2001:2::/48 (RFC 5180)
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0x0000) {
    return true;
  }
  // ORCHID 2001:10::/28 & ORCHIDv2 2001:20::/28
  if (g0 === 0x2001 && ((g1 & 0xfff0) === 0x0010 || (g1 & 0xfff0) === 0x0020)) {
    return true;
  }
  // Documentation 2001:db8::/32 (RFC 3849)
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }
  // 6to4 2002::/16 (deprecated RFC 7526; embeds arbitrary IPv4)
  if (g0 === 0x2002) {
    return true;
  }

  return false;
}

function isNonCanonicalNumericIpv4Host(rawHost: string): boolean {
  if (!rawHost || rawHost.startsWith('[')) {
    return false;
  }
  const withoutTrailingDot = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (!withoutTrailingDot) {
    return false;
  }
  const labels = withoutTrailingDot.split('.');
  if (labels.some((label) => label.length === 0)) {
    return false;
  }
  const allLookNumeric = labels.every((label) => /^(?:0x[\da-f]*|0[0-7]*|\d+)$/i.test(label));
  if (!allLookNumeric) {
    return false;
  }
  return !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(rawHost);
}

function hasPathTraversal(rawTrimmedHttpsUrl: string): boolean {
  const afterScheme = rawTrimmedHttpsUrl.slice('https://'.length);
  const slashIndex = afterScheme.indexOf('/');
  if (slashIndex === -1) {
    return false;
  }
  const rawPath = afterScheme.slice(slashIndex).split(/[?#]/, 1)[0] ?? '';
  return rawPath.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

export function validatePublicHttpsUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string') {
    return { ok: false, reason: 'URL 必须为字符串' };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL 长度不能超过 ${MAX_URL_LENGTH} 字符` };
  }
  if (hasControlChar(rawUrl)) {
    return { ok: false, reason: 'URL 包含非法控制字符' };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'URL 不能为空' };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: 'URL 不能包含空白字符' };
  }
  if (trimmed.includes('\\')) {
    return { ok: false, reason: 'URL 不能包含反斜杠字符' };
  }
  if (!/^https:\/\//i.test(trimmed)) {
    return { ok: false, reason: '仅允许 https:// 协议地址' };
  }

  const afterScheme = trimmed.slice('https://'.length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (!authority) {
    return { ok: false, reason: 'URL 缺少主机名' };
  }
  if (authority.includes('@')) {
    return { ok: false, reason: 'URL 不允许包含内嵌凭据' };
  }

  let rawHost: string | null = null;
  if (!authority.startsWith('[')) {
    rawHost = authority.replace(/:\d*$/, '');
    if (isNonCanonicalNumericIpv4Host(rawHost)) {
      return { ok: false, reason: '不允许使用整数、十六进制、八进制或简写 IP 地址' };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'URL 格式无效' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅允许 https:// 协议地址' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'URL 不允许包含内嵌凭据' };
  }
  if (parsed.hostname.length === 0) {
    return { ok: false, reason: 'URL 缺少主机名' };
  }

  const host = parsed.hostname.toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) {
    const ipv6Raw = host.slice(1, -1);
    if (isPrivateOrReservedIpv6(ipv6Raw)) {
      return { ok: false, reason: '不允许访问本地或内网 IPv6 地址' };
    }
    return { ok: true, url: parsed, normalizedUrl: parsed.toString() };
  }

  const ipv4Octets = parseDottedIpv4(host);
  if (ipv4Octets) {
    if (rawHost !== null && rawHost.toLowerCase() !== host) {
      return { ok: false, reason: '不允许使用非规范 IPv4 地址格式' };
    }
    if (isPrivateOrReservedIpv4(ipv4Octets[0], ipv4Octets[1], ipv4Octets[2], ipv4Octets[3])) {
      return { ok: false, reason: '不允许访问本地或内网 IPv4 地址' };
    }
    return { ok: true, url: parsed, normalizedUrl: parsed.toString() };
  }

  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return { ok: false, reason: '主机名格式无效' };
  }
  if (!host.includes('.')) {
    return { ok: false, reason: '不允许单标签本地主机名' };
  }
  if (host === 'localhost' || FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: '不允许访问本地或保留内网域名' };
  }

  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (/^\d+$/.test(tld)) {
    return { ok: false, reason: '主机名顶级域不能为纯数字' };
  }

  return { ok: true, url: parsed, normalizedUrl: parsed.toString() };
}

export function validateMediaAssetUrl(rawUrl: string): UrlValidationResult {
  return validatePublicHttpsUrl(rawUrl);
}

export function normalizeGeoMixBaseUrl(rawUrl: string): BaseUrlValidationResult {
  const result = validatePublicHttpsUrl(rawUrl);
  if (!result.ok) {
    return result;
  }

  const trimmed = rawUrl.trim();
  const { url } = result;
  if (rawUrl.includes('?') || rawUrl.includes('#') || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'GeoMix 服务地址不能包含 Query 参数或 Hash 片段' };
  }
  if (hasPathTraversal(trimmed)) {
    return { ok: false, reason: 'GeoMix 服务地址不允许包含路径穿越段' };
  }

  const cleanPath = url.pathname.replace(/\/+$/, '');
  const normalizedUrl = cleanPath ? `${url.origin}${cleanPath}` : url.origin;
  // Chrome MV3 match patterns forbid ports; hostname-only pattern matches all ports on that host.
  const originPattern = `https://${url.hostname}/*`;

  return {
    ok: true,
    normalizedUrl,
    origin: url.origin,
    originPattern,
  };
}

export function validatePublishedUrl(
  provider: ExtensionProviderKey,
  rawUrl: string,
): PublishedUrlValidationResult {
  const baseCheck = validatePublicHttpsUrl(rawUrl);
  if (!baseCheck.ok) {
    return baseCheck;
  }

  const { url } = baseCheck;
  if (url.port !== '') {
    return { ok: false, reason: '公网文章链接必须使用默认 HTTPS 端口' };
  }
  if (hasPathTraversal(rawUrl.trim())) {
    return { ok: false, reason: '公网文章链接不允许包含路径穿越段' };
  }

  const stripped = `${url.origin}${url.pathname}`;
  const patterns = PUBLISHED_URL_PATTERNS[provider];
  if (!patterns.some((pattern) => pattern.test(stripped))) {
    return { ok: false, reason: '链接不符合目标平台公网文章白名单格式' };
  }

  const normalizedUrl = stripped.replace(/\/+$/, '');
  return {
    ok: true,
    provider,
    normalizedUrl,
  };
}

export function detectProviderPublishedUrl(rawUrl: string): PublishedUrlValidationResult {
  const baseCheck = validatePublicHttpsUrl(rawUrl);
  if (!baseCheck.ok) {
    return baseCheck;
  }

  for (const provider of EXTENSION_PROVIDER_KEYS) {
    const matched = validatePublishedUrl(provider, rawUrl);
    if (matched.ok) {
      return matched;
    }
  }

  return { ok: false, reason: '链接不匹配任何已支持平台的公网文章白名单' };
}

export function isCanonicalPublishedUrl(rawUrl: string, provider?: ExtensionProviderKey): boolean {
  if (typeof rawUrl !== 'string' || rawUrl !== rawUrl.trim()) {
    return false;
  }
  if (rawUrl.includes('?') || rawUrl.includes('#')) {
    return false;
  }

  const baseCheck = validatePublicHttpsUrl(rawUrl);
  if (!baseCheck.ok) {
    return false;
  }

  const { url } = baseCheck;
  if (url.port !== '' || url.search !== '' || url.hash !== '') {
    return false;
  }
  if (hasPathTraversal(rawUrl)) {
    return false;
  }

  const candidate = `${url.origin}${url.pathname}`;
  if (rawUrl.replace(/\/+$/, '') !== candidate.replace(/\/+$/, '')) {
    return false;
  }

  if (provider !== undefined) {
    return PUBLISHED_URL_PATTERNS[provider].some((pattern) => pattern.test(candidate));
  }

  return EXTENSION_PROVIDER_KEYS.some((key) =>
    PUBLISHED_URL_PATTERNS[key].some((pattern) => pattern.test(candidate)),
  );
}

export function normalizeZhihuQuestionUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  const baseCheck = validatePublicHttpsUrl(rawUrl);
  if (!baseCheck.ok) {
    return null;
  }
  const { url } = baseCheck;
  if (url.port !== '' || hasPathTraversal(rawUrl.trim())) {
    return null;
  }
  const stripped = `${url.origin}${url.pathname}`;
  if (!ZHIHU_QUESTION_URL_PATTERN.test(stripped)) {
    return null;
  }
  return stripped.replace(/\/+$/, '');
}

export function isValidZhihuQuestionUrl(rawUrl: string | null | undefined): boolean {
  return normalizeZhihuQuestionUrl(rawUrl) !== null;
}

export function isAllowedPlatformSenderUrl(rawUrl: string | undefined): boolean {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_URL_LENGTH ||
    hasControlChar(rawUrl)
  ) {
    return false;
  }
  if (/\s/.test(rawUrl) || rawUrl.includes('\\')) {
    return false;
  }
  if (!/^https:\/\//i.test(rawUrl)) {
    return false;
  }
  const afterScheme = rawUrl.slice('https://'.length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (!authority || authority.includes('@')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return false;
  }
  return ALLOWED_PLATFORM_ORIGINS.has(parsed.origin);
}
