import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The onnxruntime-web build transformers.js will load from jsDelivr. */
function ortVersion(): string {
  for (const dir of ['../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web', '../../node_modules/onnxruntime-web']) {
    const pkg = join(here, dir, 'package.json');
    if (existsSync(pkg)) return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  }
  throw new Error('onnxruntime-web is not installed; run npm install');
}

/** npm packages that actually end up in the bundles (main app and workers), for THIRD_PARTY_NOTICES.md. */
const bundledPackageDirs = new Set<string>();

function collectBundledPackages(write: boolean): Plugin {
  return {
    name: 'saybeam:collect-bundled-packages',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0/, ''));
          if (m?.[1]) bundledPackageDirs.add(m[1]);
        }
      }
    },
    closeBundle() {
      if (!write) return;
      // Kept out of dist (which is deployed) and stored relative to the repo, so no build-machine paths ship.
      const repoRoot = join(here, '..', '..');
      const list = [...bundledPackageDirs]
        .map((dir) => {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
          return { name: pkg.name, version: pkg.version, dir: relative(repoRoot, dir).replaceAll('\\', '/') };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      mkdirSync(join(here, '.build'), { recursive: true });
      writeFileSync(join(here, '.build', 'bundled-packages.json'), JSON.stringify(list, null, 2));
    },
  };
}

/**
 * Pin the CSP to the exact ONNX Runtime files on jsDelivr instead of the whole
 * CDN, so an attacker-published package there cannot run in this origin.
 */
function pinCspToOrt(): Plugin {
  return {
    name: 'saybeam:pin-csp',
    apply: 'build',
    closeBundle() {
      const file = join(here, 'dist', '_headers');
      if (!existsSync(file)) return;
      const ortDist = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion()}/dist/`;
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__ORT_DIST__', ortDist));
    },
  };
}

/**
 * ONNX Runtime's 27 MB wasm is over Cloudflare's 25 MiB per-asset limit, and
 * transformers.js loads it from jsDelivr by default anyway. The LAN relay
 * serves its own copy from /models/ort/ for offline classrooms.
 */
function dropOrtWasm(): Plugin {
  return {
    name: 'saybeam:drop-ort-wasm',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

// The speaker page runs ONNX speech models on multi-threaded WASM, which needs
// cross-origin isolation. Production gets the same headers from public/_headers
// (Cloudflare) or from the Rust relay.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const backend = process.env.SAYBEAM_BACKEND ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    preact(),
    dropOrtWasm(),
    pinCspToOrt(),
    collectBundledPackages(true),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/icon.svg', 'icons/*.png', 'audio/capture-worklet.js'],
      manifest: {
        name: 'Saybeam',
        short_name: 'Saybeam',
        description: 'Live captions for everyone in the room: you speak, and everyone reads along on their own phone.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0d0d0d',
        theme_color: '#151515',
        categories: ['accessibility', 'education', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Pages are network-first: live captions need the network anyway, a new deploy is
        // picked up immediately, and a missing or evicted precache can never block loading.
        // Offline, navigations fall back to the precached app shell.
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === 'navigate' && !/^\/(api|ws|models)\//.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'pages', networkTimeoutSeconds: 6, precacheFallback: { fallbackURL: '/index.html' } },
          },
        ],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    // AGPL section 13: the app links to the source of the code it is running.
    __SOURCE_URL__: JSON.stringify(process.env.SAYBEAM_SOURCE_URL ?? 'https://github.com/byjoellobo/saybeam'),
  },
  worker: { format: 'es', plugins: () => [dropOrtWasm(), collectBundledPackages(false)] },
  build: { target: 'es2022', sourcemap: true },
  server: {
    headers: isolation,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/models': backend,
    },
  },
  preview: { headers: isolation },
});
