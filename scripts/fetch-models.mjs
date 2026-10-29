#!/usr/bin/env node
/**
 * Download on-device speech models for offline LAN mode.
 *
 *   node scripts/fetch-models.mjs [--out relay/models] [--models moonshine-tiny,moonshine-base,whisper-base]
 *
 * Then run the relay with --models-dir relay/models. The web app loads models
 * from http://<laptop>/models/<repo>/... and ONNX Runtime from /models/ort/, so
 * the classroom needs no internet once this has run.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MODEL_PRESETS, VAD_MODEL } from '../apps/web/src/engines/models.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const out = resolve(opt('out', 'relay/models'));
const wanted = opt('models', 'moonshine-tiny,moonshine-base,whisper-base').split(',').map((s) => s.trim());

const HF = 'https://huggingface.co';
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(repo, revision, file) {
  const dest = join(out, repo, file);
  if (await exists(dest)) {
    console.log(`  have ${repo}/${file}`);
    return;
  }
  const res = await fetch(`${HF}/${repo}/resolve/${revision}/${file}`);
  if (res.status === 404) return; // optional file
  if (!res.ok) throw new Error(`${repo}/${file}: HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  const body = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, body);
  console.log(`  got  ${repo}/${file} (${(body.length / 1e6).toFixed(1)} MB)`);
}

async function listFiles(repo, revision) {
  const res = await fetch(`${HF}/api/models/${repo}/tree/${revision}?recursive=1`);
  if (!res.ok) throw new Error(`cannot list ${repo}: HTTP ${res.status}`);
  return (await res.json()).filter((e) => e.type === 'file').map((e) => e.path);
}

async function fetchRepo(repo, revision, onnxFiles) {
  console.log(`${repo} @ ${revision.slice(0, 8)}`);
  const files = await listFiles(repo, revision);
  const configs = files.filter((f) => !f.includes('/') && f.endsWith('.json'));
  for (const f of [...configs, ...onnxFiles]) await download(repo, revision, f);
}

async function main() {
  console.log(`Saving models to ${out}`);
  await fetchRepo(VAD_MODEL.repo, VAD_MODEL.revision, ['onnx/model.onnx']);

  for (const id of wanted) {
    const preset = MODEL_PRESETS.find((p) => p.id === id);
    if (!preset) {
      console.warn(`skipping unknown model "${id}" (known: ${MODEL_PRESETS.map((p) => p.id).join(', ')})`);
      continue;
    }
    // Fetch the dtypes used on both GPU and CPU so either works offline. Also the
    // q8 files: transformers.js probes the default (q8) file names for download
    // sizes before loading, and that probe must not need the internet.
    const onnx = new Set();
    for (const dtypes of [preset.dtype.webgpu, preset.dtype.wasm]) {
      for (const [module, dtype] of Object.entries(dtypes)) {
        onnx.add(`onnx/${module}${SUFFIX[dtype] ?? ''}.onnx`);
        onnx.add(`onnx/${module}${SUFFIX.q8}.onnx`);
      }
    }
    await fetchRepo(preset.repo, preset.revision, [...onnx]);
  }

  // Use the exact onnxruntime-web build transformers.js was installed with.
  const candidates = [resolve('node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'), resolve('node_modules/onnxruntime-web/dist')];
  let ortDist = null;
  for (const dir of candidates) if (await exists(join(dir, ORT_FILES[1]))) ortDist ??= dir;
  if (!ortDist) throw new Error('onnxruntime-web is not installed. Run npm install at the repo root first.');
  await mkdir(join(out, 'ort'), { recursive: true });
  for (const f of ORT_FILES) {
    await copyFile(join(ortDist, f), join(out, 'ort', f));
    console.log(`  copied ort/${f}`);
  }
  console.log(`\nDone. Start the relay with:  caption-room-relay --models-dir ${out}`);
}

main().catch((err) => {
  console.error(`fetch-models failed: ${err.message ?? err}`);
  process.exit(1);
});
