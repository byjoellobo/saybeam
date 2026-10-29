/**
 * On-device model presets (ONNX exports run by transformers.js).
 * Sizes are download MB for the listed dtypes, measured from the Hugging Face
 * file listings in October 2026. Models are cached after the first download.
 */
export interface ModelPreset {
  readonly id: string;
  readonly label: string;
  readonly family: 'moonshine' | 'whisper';
  readonly repo: string;
  /** Pinned Hugging Face commit, so every device and every test run uses identical weights. */
  readonly revision: string;
  /** True when the model only understands English. */
  readonly englishOnly: boolean;
  readonly dtype: { readonly webgpu: Readonly<Record<string, string>>; readonly wasm: Readonly<Record<string, string>> };
  readonly sizeMb: { readonly webgpu: number; readonly wasm: number };
  /** Utterances are split before this length. Whisper's window is 30 s. */
  readonly maxSegmentMs: number;
  readonly note: string;
  /** Hide on devices without WebGPU. */
  readonly needsGpu?: boolean;
}

/** Silero VAD, pinned like the speech models. */
export const VAD_MODEL = { repo: 'onnx-community/silero-vad', revision: 'e71cae966052b992a7eca6b17738916ce0eca4ec' } as const;

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'moonshine-tiny',
    label: 'Moonshine Tiny',
    family: 'moonshine',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95',
    englishOnly: true,
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    sizeMb: { webgpu: 80, wasm: 55 },
    maxSegmentMs: 15_000,
    note: 'Fastest. English only. The pick for older laptops and phones.',
  },
  {
    id: 'moonshine-base',
    label: 'Moonshine Base',
    family: 'moonshine',
    repo: 'onnx-community/moonshine-base-ONNX',
    revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
    englishOnly: true,
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    sizeMb: { webgpu: 158, wasm: 127 },
    maxSegmentMs: 15_000,
    note: 'More accurate English. Comfortable on laptops with a GPU.',
  },
  {
    id: 'whisper-tiny-en',
    label: 'Whisper Tiny (English)',
    family: 'whisper',
    repo: 'onnx-community/whisper-tiny.en',
    revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
    englishOnly: true,
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    sizeMb: { webgpu: 124, wasm: 68 },
    maxSegmentMs: 25_000,
    note: 'Whisper alternative for English, handy for comparing accuracy.',
  },
  {
    id: 'whisper-base',
    label: 'Whisper Base (multilingual)',
    family: 'whisper',
    repo: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    englishOnly: false,
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    sizeMb: { webgpu: 210, wasm: 140 },
    maxSegmentMs: 25_000,
    note: 'Hindi, code-mixed and 90+ other languages. Slower than Moonshine.',
  },
  {
    id: 'whisper-small',
    label: 'Whisper Small (multilingual)',
    family: 'whisper',
    repo: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    englishOnly: false,
    dtype: { webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
    sizeMb: { webgpu: 303, wasm: 253 },
    maxSegmentMs: 25_000,
    note: 'Best multilingual accuracy here. Needs a desktop-class GPU.',
    needsGpu: true,
  },
];

export function findPreset(id: string): ModelPreset {
  return MODEL_PRESETS.find((p) => p.id === id) ?? (MODEL_PRESETS[0] as ModelPreset);
}

/** Moonshine emits about 6 tokens per second of English; give headroom so short clips are not cut off. */
export function maxNewTokens(family: ModelPreset['family'], audioSeconds: number): number {
  if (family === 'moonshine') return Math.max(12, Math.ceil(audioSeconds * 7) + 6);
  return Math.min(224, Math.max(16, Math.ceil(audioSeconds * 9) + 16));
}
