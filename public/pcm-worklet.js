// 麥克風 → 16 kHz 單聲道 PCM16，每 100 ms 送出一塊。
// 這個檔案必須是獨立檔（AudioWorklet 不能走 bundler 的 import）。

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options?.processorOptions?.targetRate ?? 16000;
    this.ratio = sampleRate / target;
    this.frameSamples = Math.round(target / 10); // 100 ms
    this.out = new Int16Array(this.frameSamples);
    this.outLen = 0;
    this.pos = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = Boolean(event.data.value);
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const n = channel.length;
    let i = this.pos;

    while (i < n) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const s0 = channel[idx] ?? 0;
      const s1 = channel[Math.min(idx + 1, n - 1)] ?? s0;
      let value = s0 + (s1 - s0) * frac;

      if (this.muted) value = 0;
      value = Math.max(-1, Math.min(1, value));
      this.out[this.outLen] = value < 0 ? value * 0x8000 : value * 0x7fff;
      this.outLen += 1;

      if (this.outLen >= this.frameSamples) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(this.frameSamples);
        this.outLen = 0;
      }
      i += this.ratio;
    }

    this.pos = i - n;
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
