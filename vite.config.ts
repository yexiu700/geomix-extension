import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { buildManifest } from './manifest.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const raw = readFileSync(resolve(__dirname, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  if (!parsed.version) {
    throw new Error('package.json is missing a valid "version" field');
  }
  return parsed.version;
}

function emitManifestPlugin(): Plugin {
  return {
    name: 'geomix-emit-manifest',
    generateBundle() {
      const manifest = buildManifest(readPackageVersion());
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), emitManifestPlugin()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
