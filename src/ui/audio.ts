export interface MicHandle {
  stop(): void;
  setEnabled(value: boolean): void;
  level(): number;
  /** 實際收到的裝置名稱，顯示在錄音頁讓使用者確認 */
  label: string;
}

export interface CaptureOptions {
  /** 自己的麥克風 */
  mic: boolean;
  /** 分頁／整個螢幕的系統音訊（線上會議對方的聲音） */
  system: boolean;
}

interface SourceNode {
  stream: MediaStream;
  gain: number;
  label: string;
  kind: 'mic' | 'system';
}

function trackLabel(stream: MediaStream, fallback: string): string {
  const label = stream.getAudioTracks()[0]?.label?.trim() ?? '';
  if (!label || /^default$/i.test(label)) return fallback;
  return label
    .replace(/^Default\s*-\s*/i, '')
    .replace(/\s*\((?:Realtek|High Definition|USB|Bluetooth)[^)]*\)$/i, '')
    .trim();
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/**
 * 抓「會議的聲音」：Chrome／Edge 的分頁音訊或整個螢幕的系統音訊。
 * 這裡刻意關掉回音消除與自動增益，否則 Chrome 會把會議的聲音當成回音濾掉。
 */
async function openSystemAudio(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  if (!stream.getAudioTracks().length) {
    stopStream(stream);
    throw new Error('分享時沒有勾音訊。請選會議的分頁並勾「分享分頁音訊」，或選整個螢幕並勾「分享系統音訊」。');
  }
  return stream;
}

/**
 * 開一條（或多條混音的）音訊擷取。麥克風與系統音訊都接到同一個 worklet，
 * Web Audio 會自動相加，所以「麥克風＋會議音訊」是一路 PCM，伺服器不用改。
 */
export async function startCapture(
  options: CaptureOptions,
  onFrame: (frame: ArrayBuffer) => void,
  onEnded?: (label: string, kind: 'mic' | 'system') => void,
): Promise<MicHandle> {
  const sources: SourceNode[] = [];
  try {
    if (options.mic) {
      const stream = await openMic();
      sources.push({ stream, gain: 0.7, label: trackLabel(stream, '麥克風'), kind: 'mic' });
    }
    if (options.system) {
      const stream = await openSystemAudio();
      sources.push({ stream, gain: 0.7, label: trackLabel(stream, '會議音訊'), kind: 'system' });
    }
  } catch (err) {
    for (const source of sources) stopStream(source.stream);
    throw err;
  }
  if (!sources.length) throw new Error('沒有選擇音訊來源');

  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  // ?v= 是快取破壞：AudioWorklet 模組換版本時，瀏覽器才不會拿舊的
  const workletUrl = new URL('./pcm-worklet.js?v=2', document.baseURI).href;
  await ctx.audioWorklet.addModule(workletUrl);

  const node = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    // explicit 會讓 Web Audio 先把立體聲（例如系統音訊）混成單聲道再進 worklet，
    // 不然只讀 channel 0 會漏掉偏右聲道的聲音。
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { targetRate: 16000 },
  });

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;

  const wired = sources.map((source) => {
    const input = ctx.createMediaStreamSource(source.stream);
    const gain = ctx.createGain();
    gain.gain.value = source.gain;
    input.connect(gain);
    gain.connect(node);
    const track = source.stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => onEnded?.(source.label, source.kind));
    return { input, gain };
  });

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
    label: sources.map((source) => source.label).join(' ＋ '),
    stop() {
      enabled = false;
      node.port.onmessage = null;
      try {
        for (const { input, gain } of wired) {
          input.disconnect();
          gain.disconnect();
        }
        node.disconnect();
        analyser.disconnect();
        silentSink.disconnect();
      } catch {
        // 忽略
      }
      for (const source of sources) stopStream(source.stream);
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
