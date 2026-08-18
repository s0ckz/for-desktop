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
  sampleRate: number;
  channels: number;
};

export = winAppAudio;
