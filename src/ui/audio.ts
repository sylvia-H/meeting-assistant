export interface MicHandle {
  stop(): void;
  setEnabled(value: boolean): void;
  level(): number;
}

export async function startMic(onFrame: (frame: ArrayBuffer) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const workletUrl = new URL('./pcm-worklet.js', document.baseURI).href;
  await ctx.audioWorklet.addModule(workletUrl);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    processorOptions: { targetRate: 16000 },
  });

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;

  source.connect(node);
  node.connect(analyser);
  analyser.connect(silentSink);
  silentSink.connect(ctx.destination);

  let enabled = true;
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!enabled) return;
    onFrame(event.data);
  };

  const buffer = new Uint8Array(analyser.fftSize);

  return {
    stop() {
      enabled = false;
      node.port.onmessage = null;
      try {
        node.disconnect();
        source.disconnect();
        analyser.disconnect();
        silentSink.disconnect();
      } catch {
        // 忽略
      }
      for (const track of stream.getTracks()) track.stop();
      void ctx.close();
    },
    setEnabled(value: boolean) {
      enabled = value;
      node.port.postMessage({ type: 'mute', value: !value });
    },
    level() {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) {
        const centered = (v - 128) / 128;
        sum += centered * centered;
      }
      return Math.min(1, Math.sqrt(sum / buffer.length) * 3);
    },
  };
}
