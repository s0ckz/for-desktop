export type AudioProcess = { pid: number; name: string };

export type MixReport = {
  enumerated: AudioProcess[];
  blocked: (AudioProcess & { reason: "blocklist" | "self-tree" })[];
  started: AudioProcess[];
  failed: (AudioProcess & { error: string })[];
};

export type MixState = { running: boolean; clients: AudioProcess[]; scans: number; lastError: string };

declare const winAppAudio: {
  isSupported(): boolean;
  pidFromWindowHandle(handle: string | number): number;
  windowState(handle: string | number): {
    exists: boolean;
    visible: boolean;
    iconic: boolean;
  };
  start(pid: number, includeTree: boolean, onChunk: (chunk: Buffer) => void): void;
  stop(): void;
  lastError(): string;
  /** Enumerate every process currently rendering audio. */
  listAudioProcesses(): AudioProcess[];
  /**
   * Begin mixed capture of every audible process except those named in
   * excludedNames (lowercase exe basenames). onChunk receives 48kHz stereo
   * signed 16-bit LE PCM buffers, same wire format as start(). Throws if the
   * native binary is not available.
   */
  startSystemExcluding(excludedNames: string[], onChunk: (chunk: Buffer) => void): MixReport;
  /** Snapshot of the running mixer: live clients, scan count, last error. */
  mixState(): MixState;
  sampleRate: number;
  channels: number;
};

export = winAppAudio;
