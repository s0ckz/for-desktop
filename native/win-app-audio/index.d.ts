declare const winAppAudio: {
  isSupported(): boolean;
  pidFromWindowHandle(handle: string | number): number;
  start(pid: number, includeTree: boolean, onChunk: (chunk: Buffer) => void): void;
  stop(): void;
  lastError(): string;
  sampleRate: number;
  channels: number;
};

export = winAppAudio;
