export const REALTIME_VOICE_SAMPLE_RATE = 16_000;

export function downsampleToPcm16(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = REALTIME_VOICE_SAMPLE_RATE,
): ArrayBuffer {
  if (outputSampleRate > inputSampleRate) {
    throw new Error("Output sample rate must not exceed input sample rate");
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outputLength);
  let inputOffset = 0;

  for (let outputOffset = 0; outputOffset < outputLength; outputOffset += 1) {
    const nextInputOffset = Math.min(input.length, Math.round((outputOffset + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (; inputOffset < nextInputOffset; inputOffset += 1) {
      sum += input[inputOffset];
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, count > 0 ? sum / count : 0));
    output[outputOffset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output.buffer;
}

export function realtimeVoiceWebSocketUrl(adoptId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/claw/voice/rtasr?adoptId=${encodeURIComponent(adoptId)}`;
}

export type RealtimeVoiceStatus = "idle" | "starting" | "recording" | "finalizing";

type RealtimeVoiceCallbacks = {
  onStatus: (status: RealtimeVoiceStatus) => void;
  onTranscript: (transcript: string) => void;
  onComplete: (transcript: string) => void;
  onError: (message: string) => void;
};

export class RealtimeVoiceCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recordedBlob: Promise<Blob> | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private socket: WebSocket | null = null;
  private transcript = "";
  private cancelled = false;
  private finalized = false;
  private finishRequested = false;
  private finishTimer: number | null = null;

  constructor(
    private readonly adoptId: string,
    private readonly callbacks: RealtimeVoiceCallbacks,
  ) {}

  async start(): Promise<void> {
    this.callbacks.onStatus("starting");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    if (this.cancelled || this.finishRequested) {
      stream.getTracks().forEach(track => track.stop());
      this.callbacks.onStatus("idle");
      return;
    }
    this.stream = stream;
    this.startFallbackRecorder(stream);
    this.startRealtimeSocket();
    this.startPcmCapture(stream);
    this.callbacks.onStatus("recording");
  }

  finish(): void {
    if (this.cancelled || this.finalized) return;
    this.finishRequested = true;
    this.callbacks.onStatus("finalizing");
    this.stopAudioCapture();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "end" }));
    }
    this.finishTimer = window.setTimeout(() => void this.finalize(), 2500);
  }

  cancel(): void {
    if (this.finalized) return;
    this.cancelled = true;
    this.finalized = true;
    this.cleanup();
    this.callbacks.onStatus("idle");
  }

  private startFallbackRecorder(stream: MediaStream): void {
    if (typeof MediaRecorder === "undefined") return;
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find(candidate => MediaRecorder.isTypeSupported(candidate));
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    this.recordedBlob = new Promise(resolve => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "application/octet-stream" }));
    });
    recorder.start(250);
    this.recorder = recorder;
  }

  private startRealtimeSocket(): void {
    const socket = new WebSocket(realtimeVoiceWebSocketUrl(this.adoptId));
    socket.binaryType = "arraybuffer";
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "text" && typeof message.transcript === "string") {
          this.transcript = message.transcript.trim();
          this.callbacks.onTranscript(this.transcript);
        } else if (message.type === "done") {
          if (typeof message.transcript === "string" && message.transcript.trim()) {
            this.transcript = message.transcript.trim();
            this.callbacks.onTranscript(this.transcript);
          }
          if (this.finishRequested) void this.finalize();
        } else if (message.type === "error") {
          this.callbacks.onError(String(message.error || "实时语音识别失败，正在使用录音转写"));
          if (this.finishRequested) void this.finalize();
        }
      } catch {}
    };
    socket.onerror = () => {
      if (!this.finishRequested) this.callbacks.onError("实时连接暂不可用，松手后将使用录音转写");
    };
    socket.onclose = () => {
      if (this.finishRequested) void this.finalize();
    };
    this.socket = socket;
  }

  private startPcmCapture(stream: MediaStream): void {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("当前设备不支持实时音频采集");
    const context: AudioContext = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = event => {
      if (this.cancelled || this.finishRequested || this.socket?.readyState !== WebSocket.OPEN) return;
      const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate);
      this.socket.send(pcm);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    this.audioContext = context;
    this.source = source;
    this.processor = processor;
    this.silentGain = silentGain;
  }

  private stopAudioCapture(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    if (this.audioContext && this.audioContext.state !== "closed") void this.audioContext.close();
    this.audioContext = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }

  private async finalize(): Promise<void> {
    if (this.finalized || this.cancelled) return;
    this.finalized = true;
    if (this.finishTimer !== null) window.clearTimeout(this.finishTimer);
    this.finishTimer = null;
    let result = this.transcript.trim();
    if (!result && this.recordedBlob) {
      try {
        const blob = await this.recordedBlob;
        if (blob.size >= 100) {
          const response = await fetch("/api/claw/voice/transcribe", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": blob.type },
            body: blob,
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
          result = String(body.text || "").trim();
        }
      } catch (error) {
        this.callbacks.onError(`语音识别失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.cleanup();
    this.callbacks.onStatus("idle");
    if (result) this.callbacks.onComplete(result);
  }

  private cleanup(): void {
    if (this.finishTimer !== null) window.clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.stopAudioCapture();
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
  }
}
