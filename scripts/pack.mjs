import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const ALLOWED_PERMISSIONS = ['storage', 'tabs', 'activeTab', 'scripting'];
const ALLOWED_PERMISSIONS_SET = new Set(ALLOWED_PERMISSIONS);

const ALLOWED_HOST_PERMISSIONS = [
  'https://zhuanlan.zhihu.com/*',
  'https://www.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://www.toutiao.com/*',
  'https://post.smzdm.com/*',
];
const ALLOWED_HOST_PERMISSIONS_SET = new Set(ALLOWED_HOST_PERMISSIONS);

const ALLOWED_OPTIONAL_HOST_PERMISSIONS = ['https://*/*'];

const EXCLUDED_DIR_SEGMENTS = new Set([
  'tests',
  '__tests__',
  '__mocks__',
  'node_modules',
  '.git',
  '.agents',
  '.github',
  'docs',
  'scripts',
  'coverage',
]);

const EXCLUDED_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.gitkeep']);
const EXCLUDED_EXT_RE = /\.(map|ts|tsx|jsx|zip|crx|pem|log)$/i;
const EXCLUDED_TEST_FILE_RE = /(?:^|\/)(?:fixtures\.[^/]+|[^/]+\.(?:spec|test)\.[^/]+)$/i;
const EXCLUDED_ENV_FILE_RE = /(?:^|\/)\.env(?:\.[^/]+)?$/i;

// Deterministic DOS timestamp: 2026-01-01 00:00:00
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizePosixPath(rawPath) {
  return String(rawPath).split('\\').join('/').replace(/^\.\//, '');
}

export function isExcludedEntry(relPath) {
  const normalized = normalizePosixPath(relPath);
  if (!normalized || normalized.startsWith('/')) {
    return true;
  }

  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '' || seg === '..' || seg === '.')) {
    return true;
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (EXCLUDED_DIR_SEGMENTS.has(segments[i].toLowerCase())) {
      return true;
    }
  }

  const baseName = segments[segments.length - 1].toLowerCase();
  if (EXCLUDED_BASENAMES.has(baseName)) {
    return true;
  }
  if (EXCLUDED_EXT_RE.test(normalized)) {
    return true;
  }
  if (EXCLUDED_TEST_FILE_RE.test(normalized)) {
    return true;
  }
  if (EXCLUDED_ENV_FILE_RE.test(normalized)) {
    return true;
  }
  if (normalized.startsWith('src/')) {
    return true;
  }

  return false;
}

export function parseArgs(argv, env = process.env) {
  let cliDist = null;
  let cliOut = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--dist') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --dist');
      }
      cliDist = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--dist=')) {
      const value = arg.slice('--dist='.length);
      if (!value) {
        throw new Error('Missing value for --dist=');
      }
      cliDist = value;
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --out');
      }
      cliOut = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) {
        throw new Error('Missing value for --out=');
      }
      cliOut = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const distRaw = cliDist ?? env.PACK_DIST ?? env.DIST_DIR ?? resolve(REPO_ROOT, 'dist');
  const outRaw = cliOut ?? env.PACK_OUT ?? env.OUTPUT_ZIP ?? null;

  return {
    help,
    distDir: resolve(distRaw),
    outPath: outRaw ? resolve(outRaw) : null,
  };
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest.json must be a JSON object');
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version === 3, got ${String(manifest.manifest_version)}`);
  }

  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`Invalid manifest version: "${String(manifest.version)}"`);
  }

  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new Error('manifest.name must be a non-empty string');
  }

  if (!Array.isArray(manifest.permissions)) {
    throw new Error('manifest.permissions must be an array');
  }
  const seenPermissions = new Set();
  for (const perm of manifest.permissions) {
    if (
      typeof perm !== 'string' ||
      !ALLOWED_PERMISSIONS_SET.has(perm) ||
      seenPermissions.has(perm)
    ) {
      throw new Error(
        `Forbidden, duplicate, or invalid permission in manifest.json: ${String(perm)}`,
      );
    }
    seenPermissions.add(perm);
  }
  if (seenPermissions.size !== ALLOWED_PERMISSIONS.length) {
    throw new Error(
      `manifest.permissions must match exact allowlist: ${ALLOWED_PERMISSIONS.join(', ')}`,
    );
  }

  if (manifest.optional_permissions !== undefined) {
    if (!Array.isArray(manifest.optional_permissions) || manifest.optional_permissions.length > 0) {
      throw new Error('manifest.optional_permissions must be omitted or empty');
    }
  }

  if (!Array.isArray(manifest.host_permissions)) {
    throw new Error('manifest.host_permissions must be an array');
  }
  const seenHostPermissions = new Set();
  for (const host of manifest.host_permissions) {
    if (
      typeof host !== 'string' ||
      !ALLOWED_HOST_PERMISSIONS_SET.has(host) ||
      seenHostPermissions.has(host)
    ) {
      throw new Error(
        `Forbidden, duplicate, or invalid host_permission in manifest.json: ${String(host)}`,
      );
    }
    seenHostPermissions.add(host);
  }
  if (seenHostPermissions.size !== ALLOWED_HOST_PERMISSIONS.length) {
    throw new Error(
      `manifest.host_permissions must match exact allowlist: ${ALLOWED_HOST_PERMISSIONS.join(', ')}`,
    );
  }

  if (
    !Array.isArray(manifest.optional_host_permissions) ||
    manifest.optional_host_permissions.length !== ALLOWED_OPTIONAL_HOST_PERMISSIONS.length ||
    manifest.optional_host_permissions[0] !== ALLOWED_OPTIONAL_HOST_PERMISSIONS[0]
  ) {
    throw new Error(
      `manifest.optional_host_permissions must be strictly ${JSON.stringify(ALLOWED_OPTIONAL_HOST_PERMISSIONS)}`,
    );
  }

  if (manifest.web_accessible_resources !== undefined) {
    throw new Error('manifest.web_accessible_resources is forbidden');
  }

  if (manifest.externally_connectable !== undefined) {
    throw new Error('manifest.externally_connectable is forbidden');
  }

  const requiredSet = new Set(['manifest.json']);

  const serviceWorker = manifest.background?.service_worker;
  if (typeof serviceWorker !== 'string' || serviceWorker.trim().length === 0) {
    throw new Error('manifest.background.service_worker is required');
  }
  requiredSet.add(normalizePosixPath(serviceWorker));

  const defaultPopup = manifest.action?.default_popup;
  if (typeof defaultPopup !== 'string' || defaultPopup.trim().length === 0) {
    throw new Error('manifest.action.default_popup is required');
  }
  requiredSet.add(normalizePosixPath(defaultPopup));

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error('manifest.content_scripts must be a non-empty array');
  }
  let contentJsCount = 0;
  for (const cs of manifest.content_scripts) {
    if (!Array.isArray(cs?.matches) || cs.matches.length === 0) {
      throw new Error('manifest.content_scripts[*].matches must be a non-empty array');
    }
    for (const matchPattern of cs.matches) {
      if (typeof matchPattern !== 'string' || !ALLOWED_HOST_PERMISSIONS_SET.has(matchPattern)) {
        throw new Error(
          `Forbidden or invalid content_scripts match pattern in manifest.json: ${String(matchPattern)}`,
        );
      }
    }
    if (Array.isArray(cs?.js)) {
      for (const jsPath of cs.js) {
        if (typeof jsPath === 'string' && jsPath.trim().length > 0) {
          requiredSet.add(normalizePosixPath(jsPath));
          contentJsCount += 1;
        }
      }
    }
    if (Array.isArray(cs?.css)) {
      for (const cssPath of cs.css) {
        if (typeof cssPath === 'string' && cssPath.trim().length > 0) {
          requiredSet.add(normalizePosixPath(cssPath));
        }
      }
    }
  }
  if (contentJsCount === 0) {
    throw new Error('manifest.content_scripts must declare at least one JS file');
  }

  const icons = manifest.icons;
  if (!icons || typeof icons !== 'object' || Array.isArray(icons)) {
    throw new Error('manifest.icons is required');
  }
  for (const size of ['16', '32', '48', '128']) {
    const iconPath = icons[size];
    if (typeof iconPath !== 'string' || iconPath.trim().length === 0) {
      throw new Error(`manifest.icons["${size}"] is required`);
    }
    requiredSet.add(normalizePosixPath(iconPath));
  }

  const defaultIcon = manifest.action?.default_icon;
  if (defaultIcon && typeof defaultIcon === 'object' && !Array.isArray(defaultIcon)) {
    for (const iconPath of Object.values(defaultIcon)) {
      if (typeof iconPath === 'string' && iconPath.trim().length > 0) {
        requiredSet.add(normalizePosixPath(iconPath));
      }
    }
  }

  return {
    version,
    requiredEntries: [...requiredSet].sort(),
  };
}

export function collectDistFiles(distDir, resolvedOutPath = null) {
  let stats;
  try {
    stats = statSync(distDir);
  } catch {
    throw new Error(`Build directory not found: ${distDir} (run "pnpm build" first)`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Build path is not a directory: ${distDir}`);
  }

  const included = [];
  const excluded = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      const relPath = relative(distDir, fullPath).split(sep).join('/');

      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to package symbolic link inside dist: ${relPath}`);
      }

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_SEGMENTS.has(entry.name.toLowerCase())) {
          excluded.push(`${relPath}/`);
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        if (resolvedOutPath && resolve(fullPath) === resolvedOutPath) {
          excluded.push(relPath);
          continue;
        }
        if (isExcludedEntry(relPath)) {
          excluded.push(relPath);
          continue;
        }
        included.push({
          name: relPath,
          absPath: fullPath,
          data: readFileSync(fullPath),
        });
      }
    }
  }

  walk(distDir);

  included.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  excluded.sort();

  return { included, excluded };
}

export function createZipBuffer(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Cannot create an empty ZIP archive');
  }
  if (files.length > 0xffff) {
    throw new Error('ZIP64 is not supported (exceeds 65535 entries)');
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const checksum = crc32(rawData);

    let method = 0;
    let payload = rawData;
    if (rawData.length > 0) {
      const deflated = deflateRawSync(rawData, { level: 9 });
      if (deflated.length < rawData.length) {
        method = 8;
        payload = deflated;
      }
    }

    if (offset > 0xffffffff) {
      throw new Error('ZIP64 offset limit exceeded');
    }

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(ZIP_LOCAL_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIR_SIG, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // Unix / PKZip 2.0
    centralHeader.writeUInt16LE(20, 6); // version needed: 2.0
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file rw-r--r--
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localChunks.push(localHeader, payload);
    centralChunks.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDirBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirBuffer, eocd]);
}

export function verifyZipArchive(zipBuffer, requiredEntries) {
  if (zipBuffer.length < 22 || zipBuffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIG) {
    throw new Error('Generated archive failed PKZip signature check');
  }

  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Generated archive is missing End of Central Directory record');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Generated archive Central Directory bounds are invalid');
  }

  const entryNames = new Set();
  let cursor = cdOffset;
  let manifestPayload = null;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIR_SIG) {
      throw new Error(`Invalid Central Directory signature at entry ${idx}`);
    }
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const expectedCrc = zipBuffer.readUInt32LE(cursor + 16);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localOffset = zipBuffer.readUInt32LE(cursor + 42);

    const name = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (name.startsWith('dist/') || name.startsWith('./') || isExcludedEntry(name)) {
      throw new Error(`Archive contains forbidden entry: ${name}`);
    }
    if (zipBuffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER_SIG) {
      throw new Error(`Invalid Local File Header signature for ${name}`);
    }

    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    let extracted;
    if (method === 0) {
      extracted = compressedData;
    } else if (method === 8) {
      extracted = inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (extracted.length !== uncompressedSize || crc32(extracted) !== expectedCrc) {
      throw new Error(`CRC/size verification failed for ${name}`);
    }

    entryNames.add(name);
    if (name === 'manifest.json') {
      manifestPayload = extracted.toString('utf8');
    }
  }

  if (manifestPayload === null) {
    throw new Error('Archive verification failed: manifest.json missing');
  }
  const parsedManifest = JSON.parse(manifestPayload);
  if (parsedManifest.manifest_version !== 3) {
    throw new Error('Archive verification failed: manifest.json is not MV3');
  }

  for (const required of requiredEntries) {
    if (!entryNames.has(required)) {
      throw new Error(`Archive verification failed: missing required entry "${required}"`);
    }
  }

  return entryNames;
}

export function packExtension(options = {}) {
  const distDir = resolve(options.distDir ?? resolve(REPO_ROOT, 'dist'));
  const manifestPath = resolve(distDir, 'manifest.json');

  let manifestRaw;
  try {
    manifestRaw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`Missing dist manifest at ${manifestPath} (run "pnpm build" first)`);
  }

  let manifestJson;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }

  const { version, requiredEntries } = validateManifest(manifestJson);
  const finalOutPath = options.outPath
    ? resolve(options.outPath)
    : resolve(REPO_ROOT, 'release', `geomix-extension-v${version}.zip`);

  const { included, excluded } = collectDistFiles(distDir, finalOutPath);
  const includedSet = new Set(included.map((f) => f.name));
  for (const required of requiredEntries) {
    if (!includedSet.has(required)) {
      throw new Error(`Missing required manifest asset in dist: ${required}`);
    }
  }

  const zipBuffer = createZipBuffer(included);
  verifyZipArchive(zipBuffer, requiredEntries);

  mkdirSync(dirname(finalOutPath), { recursive: true });
  writeFileSync(finalOutPath, zipBuffer);

  return {
    outPath: finalOutPath,
    version,
    entryCount: included.length,
    excludedCount: excluded.length,
    excluded,
    byteLength: zipBuffer.length,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const parsed = parseArgs(process.argv.slice(2), process.env);
    if (parsed.help) {
      process.stdout.write(
        [
          'Usage: node scripts/pack.mjs [--dist <dir>] [--out <zipPath>]',
          '',
          'Packages a clean Chrome Web Store MV3 ZIP archive from dist/.',
          'Environment variables: PACK_DIST / DIST_DIR, PACK_OUT / OUTPUT_ZIP.',
        ].join('\n') + '\n',
      );
    } else {
      const result = packExtension({
        distDir: parsed.distDir,
        outPath: parsed.outPath,
      });
      const sizeKb = (result.byteLength / 1024).toFixed(1);
      process.stdout.write(
        `[pack] Created ${result.outPath} (v${result.version}, ${result.entryCount} files, ${sizeKb} KB` +
          (result.excludedCount > 0
            ? `, excluded ${result.excludedCount} non-release entries`
            : '') +
          ')\n',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pack] Error: ${message}\n`);
    process.exitCode = 1;
  }
}
