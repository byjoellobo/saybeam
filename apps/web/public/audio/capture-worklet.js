/**
 * Microphone capture worklet. Downmixes to mono and posts ~100 ms chunks at
 * the context's native sample rate. Resampling to 16 kHz happens in the ASR
 * worker (tested TypeScript) so this file stays trivial.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global in AudioWorkletGlobalScope.
    this.chunkSize = Math.round(sampleRate / 10);
    this.buffer = new Float32Array(this.chunkSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      this.buffer[this.filled++] = sum / channels;
      if (this.filled === this.chunkSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.chunkSize);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('caption-room-capture', CaptureProcessor);
