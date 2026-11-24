import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PLATFORM_ORIGINS,
  detectProviderPublishedUrl,
  isAllowedPlatformSenderUrl,
  isCanonicalPublishedUrl,
  isValidZhihuQuestionUrl,
  MAX_URL_LENGTH,
  normalizeGeoMixBaseUrl,
  normalizeZhihuQuestionUrl,
  validateMediaAssetUrl,
  validatePublicHttpsUrl,
  validatePublishedUrl,
} from './url-validation';

describe('url-validation', () => {
  describe('validatePublicHttpsUrl & normalizeGeoMixBaseUrl', () => {
    it('accepts and normalizes valid public HTTPS GeoMix URLs', () => {
      const root = normalizeGeoMixBaseUrl('https://geo.example.com/');
      expect(root).toEqual({
        ok: true,
        normalizedUrl: 'https://geo.example.com',
        origin: 'https://geo.example.com',
        originPattern: 'https://geo.example.com/*',
      });

      const subpath = normalizeGeoMixBaseUrl('  https://geo.example.com:8443/api-proxy///  ');
      expect(subpath).toEqual({
        ok: true,
        normalizedUrl: 'https://geo.example.com:8443/api-proxy',
        origin: 'https://geo.example.com:8443',
        originPattern: 'https://geo.example.com/*',
      });
    });

    it('rejects non-HTTPS schemes, credentials, control chars, whitespace, backslashes, and oversized URLs', () => {
      const invalidCases = [
        '',
        '   ',
        'http://geo.example.com',
        'ftp://geo.example.com',
        'file:///etc/hosts',
        'javascript:alert(1)',
        'data:text/html,demo',
        'geo.example.com',
        'https:geo.example.com',
        'https://user:pass@geo.example.com',
        'https://@geo.example.com',
        'https://:@geo.example.com',
        'https://geo.example.com\r\n',
        'https://geo.example.com/\0path',
        'https://geo.example.com/\tpath',
        'https://geo.example.com/with space',
        'https://geo.example.com\\@127.0.0.1',
        `https://geo.example.com/${'a'.repeat(MAX_URL_LENGTH)}`,
      ];

      for (const candidate of invalidCases) {
        expect(validatePublicHttpsUrl(candidate).ok, candidate).toBe(false);
        expect(normalizeGeoMixBaseUrl(candidate).ok, candidate).toBe(false);
      }
    });

    it('rejects query, bare ?/#, hash fragments, and dot-segment traversal on GeoMix base URLs', () => {
      const invalidBaseUrls = [
        'https://geo.example.com?token=1',
        'https://geo.example.com#section',
        'https://geo.example.com?',
        'https://geo.example.com#',
        'https://geo.example.com?#',
        'https://geo.example.com/sub/../admin',
        'https://geo.example.com/sub/%2e%2e/admin',
        'https://geo.example.com/sub/./admin',
      ];
      for (const candidate of invalidBaseUrls) {
        expect(normalizeGeoMixBaseUrl(candidate).ok, candidate).toBe(false);
      }
    });

    it('rejects loopback, private IPv4, reserved ranges, and non-canonical numeric IP encodings', () => {
      const privateOrNumericHosts = [
        'https://localhost',
        'https://api.localhost',
        'https://app.local',
        'https://svc.internal',
        'https://router.lan',
        'https://intranet',
        'https://127.0.0.1',
        'https://127.0.1.1',
        'https://0.0.0.0',
        'https://10.0.0.1',
        'https://100.64.0.1',
        'https://169.254.169.254',
        'https://172.16.0.1',
        'https://172.31.255.254',
        'https://192.168.1.1',
        'https://192.0.2.1',
        'https://198.18.0.1',
        'https://224.0.0.1',
        'https://240.0.0.1',
        'https://255.255.255.255',
        'https://2130706433',
        'https://0x7f000001',
        'https://0177.0.0.1',
        'https://127.1',
        'https://134744072',
        'https://134744072.',
        'https://0x08080808.',
        'https://010.010.010.010.',
        'https://8.8.8.0x',
        'https://8。8。2056',
        'https://8.8.8.8.',
      ];

      for (const candidate of privateOrNumericHosts) {
        expect(validatePublicHttpsUrl(candidate).ok, candidate).toBe(false);
      }

      expect(validatePublicHttpsUrl('https://8.8.8.8').ok).toBe(true);
    });

    it('rejects private, loopback, link-local, SIIT, NAT64, Teredo, Discard, Benchmarking, ORCHID, and 6to4 IPv6 literals while allowing public Global Unicast IPv6', () => {
      const privateIpv6Hosts = [
        'https://[::1]',
        'https://[::]',
        'https://[fc00::1]',
        'https://[fd12:3456::1]',
        'https://[fe80::1]',
        'https://[ff02::1]',
        'https://[100::1]',
        'https://[2001:0::80ff:fffe]',
        'https://[2001:2::1]',
        'https://[2001:10::1]',
        'https://[2001:20::1]',
        'https://[2001:db8::1]',
        'https://[::ffff:127.0.0.1]',
        'https://[::ffff:7f00:1]',
        'https://[::ffff:a00:1]',
        'https://[::ffff:c0a8:101]',
        'https://[::ffff:a9fe:a9fe]',
        'https://[::ffff:0:127.0.0.1]',
        'https://[::ffff:0:10.0.0.1]',
        'https://[::ffff:0:169.254.169.254]',
        'https://[64:ff9b::127.0.0.1]',
        'https://[64:ff9b:1::127.0.0.1]',
        'https://[2002:7f00:1::1]',
        'https://[2002:0808:0808::1]',
      ];

      for (const candidate of privateIpv6Hosts) {
        expect(validatePublicHttpsUrl(candidate).ok, candidate).toBe(false);
      }

      expect(validatePublicHttpsUrl('https://[2606:4700:4700::1111]').ok).toBe(true);
      expect(validatePublicHttpsUrl('https://[2001:4860:4860::8888]').ok).toBe(true);
    });

    it('validates media asset URLs with strict public HTTPS enforcement', () => {
      expect(validateMediaAssetUrl('https://cdn.example.com/assets/demo-1.png?w=800').ok).toBe(
        true,
      );
      expect(validateMediaAssetUrl('http://cdn.example.com/assets/demo-1.png').ok).toBe(false);
      expect(validateMediaAssetUrl('https://192.168.1.10/assets/demo-1.png').ok).toBe(false);
      expect(validateMediaAssetUrl('data:image/png;base64,AAA').ok).toBe(false);
    });
  });

  describe('validatePublishedUrl, detectProviderPublishedUrl & isCanonicalPublishedUrl', () => {
    it('accepts and canonicalizes Zhihu published column and answer URLs', () => {
      expect(
        validatePublishedUrl(
          'ZHIHU_EXT',
          'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo&token=secret#top',
        ),
      ).toEqual({
        ok: true,
        provider: 'ZHIHU_EXT',
        normalizedUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      });

      expect(
        validatePublishedUrl(
          'ZHIHU_EXT',
          'https://www.zhihu.com/question/10001/answer/20002/?share=1#comments',
        ),
      ).toEqual({
        ok: true,
        provider: 'ZHIHU_EXT',
        normalizedUrl: 'https://www.zhihu.com/question/10001/answer/20002',
      });
    });

    it('accepts and canonicalizes Toutiao and SMZDM published article URLs', () => {
      expect(
        validatePublishedUrl(
          'TOUTIAO_EXT',
          'https://www.toutiao.com/article/7123456789012345678/?log_from=demo&session=abc',
        ),
      ).toEqual({
        ok: true,
        provider: 'TOUTIAO_EXT',
        normalizedUrl: 'https://www.toutiao.com/article/7123456789012345678',
      });

      expect(
        validatePublishedUrl('TOUTIAO_EXT', 'https://www.toutiao.com/i7123456789012345678/?src=m'),
      ).toEqual({
        ok: true,
        provider: 'TOUTIAO_EXT',
        normalizedUrl: 'https://www.toutiao.com/i7123456789012345678',
      });

      expect(
        validatePublishedUrl('SMZDM_EXT', 'https://post.smzdm.com/p/a1B2c3D4/?from=app#comment'),
      ).toEqual({
        ok: true,
        provider: 'SMZDM_EXT',
        normalizedUrl: 'https://post.smzdm.com/p/a1B2c3D4',
      });
    });

    it('strictly rejects draft, edit, non-default port, cross-provider, and private URLs', () => {
      expect(validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/write').ok).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit?a=1').ok,
      ).toBe(false);
      expect(validatePublishedUrl('ZHIHU_EXT', 'https://www.zhihu.com/question/10001').ok).toBe(
        false,
      );
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com:8443/p/123456789').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('TOUTIAO_EXT', 'https://mp.toutiao.com/profile_v4/graphic/publish').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('TOUTIAO_EXT', 'https://www.toutiao.com/article/7123456/edit').ok,
      ).toBe(false);
      expect(validatePublishedUrl('SMZDM_EXT', 'https://post.smzdm.com/tougao/').ok).toBe(false);
      expect(validatePublishedUrl('SMZDM_EXT', 'https://post.smzdm.com/p/a1B2c3D4/edit').ok).toBe(
        false,
      );
      expect(validatePublishedUrl('TOUTIAO_EXT', 'https://zhuanlan.zhihu.com/p/123456789').ok).toBe(
        false,
      );
      expect(validatePublishedUrl('ZHIHU_EXT', 'http://zhuanlan.zhihu.com/p/123456789').ok).toBe(
        false,
      );
      expect(validatePublishedUrl('ZHIHU_EXT', 'https://127.0.0.1/p/123456789').ok).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/write/../p/123456789').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit/%2e%2e').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit/.%2e').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/edit/%2e.').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/./').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('ZHIHU_EXT', 'https://zhuanlan.zhihu.com/p/123456789/%2e').ok,
      ).toBe(false);
      expect(
        validatePublishedUrl('SMZDM_EXT', 'https://post.smzdm.com/p/a1B2c3D4/edit/%2e%2e').ok,
      ).toBe(false);
    });

    it('auto-detects supported provider and enforces strictly canonical wire URLs', () => {
      expect(detectProviderPublishedUrl('https://post.smzdm.com/p/a1B2c3D4/?from=share')).toEqual({
        ok: true,
        provider: 'SMZDM_EXT',
        normalizedUrl: 'https://post.smzdm.com/p/a1B2c3D4',
      });
      expect(detectProviderPublishedUrl('https://unknown.example.com/p/123').ok).toBe(false);

      expect(isCanonicalPublishedUrl('https://zhuanlan.zhihu.com/p/123456789', 'ZHIHU_EXT')).toBe(
        true,
      );
      expect(isCanonicalPublishedUrl('https://zhuanlan.zhihu.com/p/123456789/', 'ZHIHU_EXT')).toBe(
        true,
      );

      const nonCanonicalCandidates = [
        'https://zhuanlan.zhihu.com/p/123456789?utm_source=demo',
        'https://zhuanlan.zhihu.com/p/123456789#top',
        'https://zhuanlan.zhihu.com/p/123456789?',
        'https://zhuanlan.zhihu.com/p/123456789#',
        'https://zhuanlan.zhihu.com/p/123456789?#',
        '  https://zhuanlan.zhihu.com/p/123456789  ',
        'HTTPS://ZHUANLAN.ZHIHU.COM/p/123456789',
        'https://ZHUANLAN.ZHIHU.COM/p/123456789',
        'https://zhuanlan.zhihu.com:443/p/123456789',
        'https://zhuanlan.zhihu.com/p/123456789/./',
        'https://zhuanlan.zhihu.com/p/123456789/edit/%2e%2e',
        'https://zhuanlan.zhihu.com/p/123456789/edit',
        'https://zhuanlan.zhihu.com/p/123456789//',
      ];
      for (const candidate of nonCanonicalCandidates) {
        expect(isCanonicalPublishedUrl(candidate), candidate).toBe(false);
      }
    });
  });

  describe('normalizeZhihuQuestionUrl & isValidZhihuQuestionUrl', () => {
    it('accepts valid Zhihu question URLs and rejects answer/edit/traversal/non-Zhihu URLs', () => {
      expect(normalizeZhihuQuestionUrl('https://www.zhihu.com/question/987654321/?sort=new')).toBe(
        'https://www.zhihu.com/question/987654321',
      );
      expect(isValidZhihuQuestionUrl('https://www.zhihu.com/question/987654321')).toBe(true);

      expect(isValidZhihuQuestionUrl('https://www.zhihu.com/question/987654321/answer/111')).toBe(
        false,
      );
      expect(
        isValidZhihuQuestionUrl(
          'https://www.zhihu.com/question/987654321/answer/111/%2e%2e/%2e%2e',
        ),
      ).toBe(false);
      expect(isValidZhihuQuestionUrl('https://zhuanlan.zhihu.com/write')).toBe(false);
      expect(isValidZhihuQuestionUrl('http://www.zhihu.com/question/987654321')).toBe(false);
      expect(isValidZhihuQuestionUrl('https://geo.example.com/question/987654321')).toBe(false);
      expect(isValidZhihuQuestionUrl(null)).toBe(false);
    });
  });

  describe('ALLOWED_PLATFORM_ORIGINS & isAllowedPlatformSenderUrl', () => {
    it('accepts strictly the 5 manifest platform HTTPS origins with default port', () => {
      expect(ALLOWED_PLATFORM_ORIGINS.size).toBe(5);
      const allowedUrls = [
        'https://zhuanlan.zhihu.com/write',
        'https://www.zhihu.com/question/123456',
        'https://mp.toutiao.com/profile_v4/graphic/publish',
        'https://www.toutiao.com/article/7123456789012345678',
        'https://post.smzdm.com/tougao/',
      ];
      for (const candidate of allowedUrls) {
        expect(isAllowedPlatformSenderUrl(candidate), candidate).toBe(true);
      }
    });

    it('rejects non-HTTPS, custom ports, credentials, control chars, undefined, and non-platform origins', () => {
      const rejectedUrls: Array<string | undefined> = [
        undefined,
        '',
        'http://zhuanlan.zhihu.com/write',
        'https://zhuanlan.zhihu.com:8443/write',
        'https://user:pass@zhuanlan.zhihu.com/write',
        'https://@zhuanlan.zhihu.com/write',
        'https://:@zhuanlan.zhihu.com/write',
        'https:zhuanlan.zhihu.com/write',
        `https://zhuanlan.zhihu.com/${'a'.repeat(2050)}`,
        'https://evil.example.com/write',
        'https://zhuanlan.zhihu.com.evil.example.com/write',
        'https://www.zhihu.com/question/1\r\n',
        'https://www.zhihu.com/with space',
        'chrome-extension://geomix-test-extension-id/popup.html',
      ];
      for (const candidate of rejectedUrls) {
        expect(isAllowedPlatformSenderUrl(candidate), String(candidate)).toBe(false);
      }
    });

    it('rejects oversized whitespace-padded URLs before trim in validatePublicHttpsUrl', () => {
      const paddedOverLimit = `${' '.repeat(2050)}https://geo.example.com`;
      const result = validatePublicHttpsUrl(paddedOverLimit);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('2048');
      }
    });
  });
});
