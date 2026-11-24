import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_PERMISSIONS,
  EXTENSION_ICONS,
  OPTIONAL_HOST_PERMISSIONS,
  PLATFORM_HOST_PERMISSIONS,
  buildManifest,
} from '../manifest.config';
// @ts-expect-error ESM JavaScript helper script without .d.ts
import { isExcludedEntry, validateManifest } from '../scripts/pack.mjs';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CURRENT_DIR, '..');
const SRC_DIR = resolve(REPO_ROOT, 'src');
const TESTS_DIR = resolve(REPO_ROOT, 'tests');
const DOCS_DIR = resolve(REPO_ROOT, 'docs');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');
const README_PATH = resolve(REPO_ROOT, 'README.md');
const DIST_DIR = resolve(REPO_ROOT, 'dist');
const DIST_MANIFEST_PATH = resolve(DIST_DIR, 'manifest.json');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
const MANIFEST_CONFIG_PATH = resolve(REPO_ROOT, 'manifest.config.ts');

const EXPECTED_PERMISSIONS = ['storage', 'tabs', 'activeTab', 'scripting'] as const;
const EXPECTED_HOST_PERMISSIONS = [
  'https://zhuanlan.zhihu.com/*',
  'https://www.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://www.toutiao.com/*',
  'https://post.smzdm.com/*',
] as const;
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = ['https://*/*'] as const;

const FORBIDDEN_PERMISSIONS = [
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'declarativeNetRequest',
  'debugger',
  'history',
  'bookmarks',
  'clipboardRead',
  'clipboardWrite',
  'management',
  'nativeMessaging',
  'proxy',
  'sidePanel',
  'tabCapture',
  'desktopCapture',
  'downloads',
  'geolocation',
  'privacy',
  'topSites',
  'webNavigation',
  '<all_urls>',
] as const;

const TOKEN_LITERAL_PATTERN = /gmext_[A-Za-z0-9._-]{8,}/g;
const SYNTHETIC_TOKEN_ALLOWLIST =
  /^gmext_(?:demo|test|mock|fake|example|sample|placeholder|sentinel)(?:[_-]|$)/i;

function readPackageVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
    throw new Error('package.json is missing a valid version string');
  }
  return parsed.version.trim();
}

function toPosixRelative(absPath: string, baseDir = REPO_ROOT): string {
  return relative(baseDir, absPath).split('\\').join('/');
}

function walkFiles(dir: string, filter?: (relPath: string) => boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = resolve(dir, entry.name);
    const relPath = toPosixRelative(absPath);
    if (entry.isDirectory()) {
      if (filter && !filter(`${relPath}/`)) {
        continue;
      }
      results.push(...walkFiles(absPath, filter));
    } else if (entry.isFile()) {
      if (!filter || filter(relPath)) {
        results.push(absPath);
      }
    }
  }
  results.sort();
  return results;
}

function isProductionSrcFile(relPath: string): boolean {
  if (relPath.endsWith('/')) {
    return !relPath.startsWith('src/test/');
  }
  if (!/\.(?:ts|tsx)$/.test(relPath)) {
    return false;
  }
  if (relPath.startsWith('src/test/')) {
    return false;
  }
  if (/\.(?:spec|test)\.(?:ts|tsx)$/.test(relPath)) {
    return false;
  }
  if (/(?:^|\/)fixtures?\.(?:ts|tsx)$/.test(relPath)) {
    return false;
  }
  return true;
}

function assertManifestRedlines(
  manifest: chrome.runtime.ManifestV3,
  expectedVersion: string,
): void {
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe(expectedVersion);

  expect(manifest.permissions).toEqual([...EXPECTED_PERMISSIONS]);
  expect(manifest.permissions).toHaveLength(4);
  expect(manifest.optional_permissions ?? []).toEqual([]);

  const allDeclaredPermissions = [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ];
  for (const forbidden of FORBIDDEN_PERMISSIONS) {
    expect(allDeclaredPermissions).not.toContain(forbidden);
  }

  expect(manifest.host_permissions).toEqual([...EXPECTED_HOST_PERMISSIONS]);
  for (const host of manifest.host_permissions ?? []) {
    expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/);
    expect(host).not.toBe('<all_urls>');
    expect(host).not.toBe('https://*/*');
    expect(host).not.toBe('http://*/*');
    expect(host).not.toContain('*://');
  }

  expect(manifest.optional_host_permissions).toEqual([...EXPECTED_OPTIONAL_HOST_PERMISSIONS]);
  for (const optionalHost of manifest.optional_host_permissions ?? []) {
    expect(optionalHost).not.toBe('<all_urls>');
    expect(optionalHost).not.toBe('http://*/*');
    expect(optionalHost).not.toBe('*://*/*');
  }

  expect(manifest.web_accessible_resources).toBeUndefined();
  expect((manifest as Record<string, unknown>)['externally_connectable']).toBeUndefined();

  expect(manifest.background).toEqual({
    service_worker: 'background.js',
    type: 'module',
  });
  expect(manifest.action?.default_popup).toBe('popup/index.html');
  expect(manifest.icons).toEqual({ ...EXTENSION_ICONS });
  expect(manifest.action?.default_icon).toEqual({ ...EXTENSION_ICONS });

  expect(manifest.content_scripts).toHaveLength(1);
  expect(manifest.content_scripts?.[0]).toEqual({
    matches: [...PLATFORM_HOST_PERMISSIONS],
    js: ['content.js'],
    run_at: 'document_idle',
  });
}

function getPropertyAccessName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.text;
    }
  }
  return null;
}

function getAccessTargetExpression(node: ts.Node): ts.Expression | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression;
  }
  return null;
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function parseTsSourceFile(filePath: string, source: string): ts.SourceFile {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true, scriptKind);
}

describe('manifest & MV3 security redlines (F18)', () => {
  const pkgVersion = readPackageVersion();

  describe('manifest.config.ts (buildManifest) least-privilege contract', () => {
    it('exports exact least-privilege permission and host constants', () => {
      expect([...ALLOWED_PERMISSIONS]).toEqual([...EXPECTED_PERMISSIONS]);
      expect([...PLATFORM_HOST_PERMISSIONS]).toEqual([...EXPECTED_HOST_PERMISSIONS]);
      expect([...OPTIONAL_HOST_PERMISSIONS]).toEqual([...EXPECTED_OPTIONAL_HOST_PERMISSIONS]);
    });

    it('builds a strictly compliant MV3 manifest matching package.json version', () => {
      const manifest = buildManifest(pkgVersion);
      assertManifestRedlines(manifest, pkgVersion);
    });

    it('rejects invalid extension manifest versions', () => {
      for (const invalid of ['', '   ', '1.0', 'v0.1.0', '0.1.0-beta.1', 'abc']) {
        expect(() => buildManifest(invalid), invalid).toThrow(/Invalid extension manifest version/);
      }
    });
  });

  describe('dist/manifest.json & built dist/ artifact hygiene', () => {
    beforeAll(() => {
      if (!existsSync(DIST_MANIFEST_PATH)) {
        execFileSync('pnpm', ['build'], {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        });
      }
    }, 60_000);

    it('emits dist/manifest.json strictly matching buildManifest(pkgVersion) and least-privilege rules', () => {
      expect(existsSync(DIST_MANIFEST_PATH)).toBe(true);
      const distManifest = JSON.parse(
        readFileSync(DIST_MANIFEST_PATH, 'utf8'),
      ) as chrome.runtime.ManifestV3;

      assertManifestRedlines(distManifest, pkgVersion);
      expect(distManifest).toEqual(buildManifest(pkgVersion));
    });

    it('contains every asset referenced by dist/manifest.json and zero sourcemaps/test/archive files', () => {
      const distManifest = JSON.parse(
        readFileSync(DIST_MANIFEST_PATH, 'utf8'),
      ) as chrome.runtime.ManifestV3;

      const referencedAssets = new Set<string>([
        distManifest.background?.service_worker ?? '',
        distManifest.action?.default_popup ?? '',
        ...(distManifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
        ...Object.values(distManifest.icons ?? {}),
        ...Object.values(
          (distManifest.action?.default_icon as Record<string, string> | undefined) ?? {},
        ),
      ]);
      referencedAssets.delete('');

      for (const assetRelPath of referencedAssets) {
        expect(existsSync(resolve(DIST_DIR, assetRelPath)), `missing dist/${assetRelPath}`).toBe(
          true,
        );
      }

      const distFiles = walkFiles(DIST_DIR);
      expect(distFiles.length).toBeGreaterThan(0);

      for (const absPath of distFiles) {
        const relPath = toPosixRelative(absPath, DIST_DIR);
        expect(relPath, `forbidden sourcemap: ${relPath}`).not.toMatch(/\.map$/i);
        expect(relPath, `forbidden test file: ${relPath}`).not.toMatch(
          /(?:\.spec|\.test)\.[jt]sx?$/i,
        );
        expect(relPath, `forbidden fixture file: ${relPath}`).not.toMatch(/fixtures?\.[jt]sx?$/i);
        expect(relPath, `forbidden source/archive/secret file: ${relPath}`).not.toMatch(
          /\.(?:ts|tsx|jsx|crx|zip|pem|env)$/i,
        );

        if (/\.(?:js|css)$/i.test(relPath)) {
          const text = readFileSync(absPath, 'utf8');
          expect(text, `sourceMappingURL leaked in ${relPath}`).not.toContain('sourceMappingURL=');
        }
      }
    });

    it('bundles all 3 wired adapters into IIFE dist/content.js and Bridge v1 endpoints into dist/background.js without cookie access', () => {
      const contentJs = readFileSync(resolve(DIST_DIR, 'content.js'), 'utf8');
      const backgroundJs = readFileSync(resolve(DIST_DIR, 'background.js'), 'utf8');

      // All 3 wired adapters present in content.js
      for (const marker of [
        'ZHIHU_EXT',
        'TOUTIAO_EXT',
        'SMZDM_EXT',
        'https://zhuanlan.zhihu.com/write',
        'https://mp.toutiao.com/profile_v4/graphic/publish',
        'https://post.smzdm.com/tougao/',
      ]) {
        expect(contentJs, `dist/content.js missing ${marker}`).toContain(marker);
      }

      // IIFE bundle (no top-level ESM import/export statements)
      expect(contentJs).not.toMatch(/^\s*import\s+/m);
      expect(contentJs).not.toMatch(/^\s*export\s+/m);

      // Collect dist/background.js plus any local ESM chunks it imports (e.g. ./assets/messages-*.js)
      const bgChunkPaths = Array.from(
        backgroundJs.matchAll(/\bfrom\s*['"](\.\/[^'"]+\.js)['"]/g),
        (match) => match[1] ?? '',
      ).filter((p) => p.length > 0);
      const backgroundGraphSources = [backgroundJs];
      for (const relChunk of bgChunkPaths) {
        const chunkAbsPath = resolve(DIST_DIR, relChunk);
        expect(
          existsSync(chunkAbsPath),
          `missing chunk imported by background.js: ${relChunk}`,
        ).toBe(true);
        backgroundGraphSources.push(readFileSync(chunkAbsPath, 'utf8'));
      }
      const backgroundGraph = backgroundGraphSources.join('\n');

      // Bridge v1 3 endpoints present in background module graph
      for (const endpoint of [
        '/api/v2/extension/me',
        '/api/v2/extension/tasks',
        'confirm-published',
      ]) {
        expect(backgroundGraph, `dist/background.js graph missing ${endpoint}`).toContain(endpoint);
      }

      // Zero cookie access in either built bundle graph
      expect(contentJs).not.toMatch(/\bdocument\s*\.\s*cookie\b/);
      expect(contentJs).not.toMatch(/\bchrome\s*\.\s*cookies\b/);
      expect(backgroundGraph).not.toMatch(/\bdocument\s*\.\s*cookie\b/);
      expect(backgroundGraph).not.toMatch(/\bchrome\s*\.\s*cookies\b/);
    });
  });

  describe('static AST + source redline scan across production src/', () => {
    const prodFiles = walkFiles(SRC_DIR, isProductionSrcFile);

    it('discovers production source files without vacuous scan', () => {
      expect(prodFiles.length).toBeGreaterThanOrEqual(20);
    });

    it('contains zero cookie collection, zero web storage, zero console.*, and zero dangerous dynamic sinks', () => {
      const violations: string[] = [];

      for (const absPath of prodFiles) {
        const relPath = toPosixRelative(absPath);
        const source = readFileSync(absPath, 'utf8');
        const sourceFile = parseTsSourceFile(absPath, source);

        if (/\bdocument\s*\.\s*cookie\b/.test(source) || /\bchrome\s*\.\s*cookies\b/.test(source)) {
          violations.push(`${relPath}: raw cookie access pattern detected`);
        }

        const visit = (node: ts.Node): void => {
          const propName = getPropertyAccessName(node);
          const target = getAccessTargetExpression(node);

          if (propName && target) {
            const targetText = target.getText(sourceFile);

            if (propName === 'cookie' && /(?:^|\.)document$/.test(targetText)) {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} document.cookie`);
            }
            if (propName === 'cookies' && /(?:^|\.)chrome$/.test(targetText)) {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} chrome.cookies`);
            }
            if (propName === 'localStorage' || propName === 'sessionStorage') {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} .${propName}`);
            }
            if (ts.isIdentifier(target) && target.text === 'console') {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} console.${propName}`);
            }
            if (
              (propName === 'write' || propName === 'writeln' || propName === 'execCommand') &&
              /(?:^|\.)document$/.test(targetText)
            ) {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} document.${propName}`);
            }
          }

          if (ts.isIdentifier(node)) {
            if (node.text === 'localStorage' || node.text === 'sessionStorage') {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} ${node.text}`);
            }
          }

          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} ${callee.text}()`);
            }
          }

          if (ts.isNewExpression(node)) {
            if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
              violations.push(`${relPath}:${getLineNumber(sourceFile, node)} new Function()`);
            }
          }

          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
      }

      expect(violations).toEqual([]);
    });

    it('enforces strict draft-only .click() allowlist and zero .submit() or synthetic click events', () => {
      type ClickCall = {
        relPath: string;
        line: number;
        receiver: string;
        method: string;
      };

      const clickCalls: ClickCall[] = [];
      const submitCalls: ClickCall[] = [];
      const syntheticClickEvents: string[] = [];

      for (const absPath of prodFiles) {
        const relPath = toPosixRelative(absPath);
        const source = readFileSync(absPath, 'utf8');
        const sourceFile = parseTsSourceFile(absPath, source);

        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const propName = getPropertyAccessName(node.expression);
            const target = getAccessTargetExpression(node.expression);
            if (target && (propName === 'click' || propName === 'submit')) {
              const entry: ClickCall = {
                relPath,
                line: getLineNumber(sourceFile, node),
                receiver: target.getText(sourceFile),
                method: propName,
              };
              if (propName === 'click') {
                clickCalls.push(entry);
              } else {
                submitCalls.push(entry);
              }
            }
          }

          if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            const ctorName = node.expression.text;
            if (ctorName === 'MouseEvent' || ctorName === 'PointerEvent') {
              const firstArg = node.arguments?.[0];
              if (
                firstArg &&
                (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) &&
                firstArg.text.toLowerCase() === 'click'
              ) {
                syntheticClickEvents.push(
                  `${relPath}:${getLineNumber(sourceFile, node)} new ${ctorName}('click')`,
                );
              }
            }
          }

          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
      }

      expect(submitCalls).toEqual([]);
      expect(syntheticClickEvents).toEqual([]);

      // Zero .click() in zhihu.adapter.ts and every non-allowlisted production file
      const zhihuClicks = clickCalls.filter(
        (c) => c.relPath === 'src/adapters/zhihu/zhihu.adapter.ts',
      );
      const toutiaoClicks = clickCalls.filter(
        (c) => c.relPath === 'src/adapters/toutiao/toutiao.adapter.ts',
      );
      const smzdmClicks = clickCalls.filter(
        (c) => c.relPath === 'src/adapters/smzdm/smzdm.adapter.ts',
      );
      const otherClicks = clickCalls.filter(
        (c) =>
          c.relPath !== 'src/adapters/toutiao/toutiao.adapter.ts' &&
          c.relPath !== 'src/adapters/smzdm/smzdm.adapter.ts',
      );

      expect(zhihuClicks).toEqual([]);
      expect(otherClicks).toEqual([]);

      // Toutiao: exact 1 safe draft-save button click guarded by findSafeDraftSaveButton
      expect(toutiaoClicks).toHaveLength(1);
      expect(toutiaoClicks[0]?.receiver).toBe('safeDraftButton');
      const toutiaoSource = readFileSync(
        resolve(REPO_ROOT, 'src/adapters/toutiao/toutiao.adapter.ts'),
        'utf8',
      );
      expect(toutiaoSource).toContain('const safeDraftButton = findSafeDraftSaveButton(doc);');

      // SMZDM: exact 1 safe draft-save button click guarded by findDraftSaveButton & non-editor containment
      expect(smzdmClicks).toHaveLength(1);
      expect(smzdmClicks[0]?.receiver).toBe('draftButton');
      const smzdmSource = readFileSync(
        resolve(REPO_ROOT, 'src/adapters/smzdm/smzdm.adapter.ts'),
        'utf8',
      );
      expect(smzdmSource).toContain('const draftButton = findDraftSaveButton(doc);');
      expect(smzdmSource).toContain('if (draftButton && !bodyEditor.contains(draftButton))');
    });

    it('enforces token/storage isolation in content & adapters, network isolation to background, and zero wildcard permissions', () => {
      const violations: string[] = [];

      for (const absPath of prodFiles) {
        const relPath = toPosixRelative(absPath);
        const source = readFileSync(absPath, 'utf8');
        const sourceFile = parseTsSourceFile(absPath, source);

        if (relPath.startsWith('src/content/') || relPath.startsWith('src/adapters/')) {
          if (
            /\bchrome\s*\.\s*storage\b/.test(source) ||
            /\b(?:getPairing|savePairing|PAIRING_STORAGE_KEY)\b/.test(source)
          ) {
            violations.push(`${relPath}: content/adapter must never access pairing storage`);
          }
        }

        if (!relPath.startsWith('src/background/')) {
          const visitNet = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
              const callee = node.expression;
              if (ts.isIdentifier(callee) && callee.text === 'fetch') {
                violations.push(
                  `${relPath}:${getLineNumber(sourceFile, node)} fetch() outside background`,
                );
              }
              const propName = getPropertyAccessName(callee);
              if (propName === 'sendBeacon') {
                violations.push(
                  `${relPath}:${getLineNumber(sourceFile, node)} sendBeacon() outside background`,
                );
              }
            }
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
              if (node.expression.text === 'XMLHttpRequest') {
                violations.push(
                  `${relPath}:${getLineNumber(sourceFile, node)} XMLHttpRequest outside background`,
                );
              }
            }
            ts.forEachChild(node, visitNet);
          };
          visitNet(sourceFile);
        }

        if (source.includes('<all_urls>') || source.includes('http://*/*')) {
          violations.push(`${relPath}: forbidden wildcard origin pattern`);
        }
      }

      const manifestConfigSource = readFileSync(MANIFEST_CONFIG_PATH, 'utf8');
      expect(manifestConfigSource).not.toContain('<all_urls>');
      expect(manifestConfigSource).not.toContain('http://*/*');
      expect(violations).toEqual([]);
    });
  });

  describe('public repo zero-leakage token hygiene scan (src/, scripts/, docs/, README.md & tests/)', () => {
    it('has zero hardcoded gmext_ token-length strings in production src/, scripts/, and manifest.config.ts', () => {
      const scriptFiles = walkFiles(
        SCRIPTS_DIR,
        (rel) => rel.endsWith('/') || /\.(?:mjs|js|ts)$/.test(rel),
      );
      expect(scriptFiles.length).toBeGreaterThan(0);

      const prodFiles = [
        ...walkFiles(SRC_DIR, isProductionSrcFile),
        ...scriptFiles,
        MANIFEST_CONFIG_PATH,
      ];
      const leaks: string[] = [];

      for (const absPath of prodFiles) {
        const relPath = toPosixRelative(absPath);
        const source = readFileSync(absPath, 'utf8');
        const matches = source.match(TOKEN_LITERAL_PATTERN);
        if (matches) {
          leaks.push(`${relPath}: ${matches.join(', ')}`);
        }
      }

      expect(leaks).toEqual([]);
    });

    it('restricts all gmext_ token fixtures across src/, non-e2e tests/, docs/, scripts/, and README.md to explicit synthetic prefixes', () => {
      const srcAllTs = walkFiles(SRC_DIR, (rel) => rel.endsWith('/') || /\.(?:ts|tsx)$/.test(rel));
      const nonE2eTests = walkFiles(TESTS_DIR, (rel) => {
        if (rel.startsWith('tests/e2e/')) {
          return false;
        }
        return rel.endsWith('/') || /\.(?:ts|tsx)$/.test(rel);
      });
      const docsMarkdown = walkFiles(DOCS_DIR, (rel) => rel.endsWith('/') || /\.md$/i.test(rel));
      const scriptFiles = walkFiles(
        SCRIPTS_DIR,
        (rel) => rel.endsWith('/') || /\.(?:mjs|js|ts)$/.test(rel),
      );

      expect(docsMarkdown.length).toBeGreaterThan(0);
      expect(scriptFiles.length).toBeGreaterThan(0);
      expect(existsSync(README_PATH)).toBe(true);

      const scanned = [...srcAllTs, ...nonE2eTests, ...docsMarkdown, ...scriptFiles, README_PATH];
      expect(scanned.length).toBeGreaterThan(0);

      const suspicious: string[] = [];
      for (const absPath of scanned) {
        const relPath = toPosixRelative(absPath);
        const source = readFileSync(absPath, 'utf8');
        const matches = source.match(TOKEN_LITERAL_PATTERN);
        if (!matches) {
          continue;
        }
        for (const token of matches) {
          if (!SYNTHETIC_TOKEN_ALLOWLIST.test(token)) {
            suspicious.push(`${relPath}: ${token}`);
          }
        }
      }

      expect(suspicious).toEqual([]);
    });
  });

  describe('scripts/pack.mjs validateManifest() exact allowlists & isExcludedEntry() (G8)', () => {
    const makeValidDistManifest = () => {
      const base = structuredClone(buildManifest('0.1.0')) as Record<string, unknown>;
      base.action = {
        ...(base.action as Record<string, unknown>),
        default_popup: 'popup/index.html',
      };
      return base;
    };

    it('accepts the exact canonical manifest and rejects all 8 hostile manifest mutations', () => {
      const valid = makeValidDistManifest();
      const result = validateManifest(valid) as { version: string; requiredEntries: string[] };
      expect(result.version).toBe('0.1.0');
      expect(result.requiredEntries).toContain('popup/index.html');

      const hostileCases: Array<{ label: string; mutate: (m: Record<string, unknown>) => void }> = [
        {
          label: 'extra permission downloads',
          mutate: (m) => {
            m.permissions = [...EXPECTED_PERMISSIONS, 'downloads'];
          },
        },
        {
          label: 'optional_permissions cookies',
          mutate: (m) => {
            m.optional_permissions = ['cookies'];
          },
        },
        {
          label: 'extra host_permission evil origin',
          mutate: (m) => {
            m.host_permissions = [...EXPECTED_HOST_PERMISSIONS, 'https://evil.example.com/*'];
          },
        },
        {
          label: 'optional_host_permissions <all_urls>',
          mutate: (m) => {
            m.optional_host_permissions = ['<all_urls>'];
          },
        },
        {
          label: 'optional_host_permissions http://*/*',
          mutate: (m) => {
            m.optional_host_permissions = ['http://*/*'];
          },
        },
        {
          label: 'web_accessible_resources present',
          mutate: (m) => {
            m.web_accessible_resources = [{ resources: ['content.js'], matches: ['https://*/*'] }];
          },
        },
        {
          label: 'externally_connectable present',
          mutate: (m) => {
            m.externally_connectable = { matches: ['https://geo.example.com/*'] };
          },
        },
        {
          label: 'content_scripts matches <all_urls>',
          mutate: (m) => {
            m.content_scripts = [{ matches: ['<all_urls>'], js: ['content.js'] }];
          },
        },
      ];

      for (const testCase of hostileCases) {
        const mutated = makeValidDistManifest();
        testCase.mutate(mutated);
        expect(() => validateManifest(mutated), testCase.label).toThrow();
      }
    });

    it('excludes legacy src/popup/index.html while allowing built popup/index.html', () => {
      expect(isExcludedEntry('src/popup/index.html')).toBe(true);
      expect(isExcludedEntry('src/background/index.ts')).toBe(true);
      expect(isExcludedEntry('popup/index.html')).toBe(false);
    });
  });
});
