declare const winCapture: {
  isSupported(): boolean;
  /**
   * Start capturing `hwnd` (a desktopCapturer window handle, decimal or
   * string). Frames are delivered as NV12 buffers fit inside
   * targetWidth x targetHeight -- the source aspect ratio is preserved (not
   * stretched) and both dimensions are rounded to even, so the delivered
   * frame may be smaller than the requested box on one axis. `fps` bounds
   * how often onFrame fires; frames arriving faster are dropped, not queued.
   * Returns true if the native capture session was started.
   */
  start(
    hwnd: string | number,
    targetWidth: number,
    targetHeight: number,
    fps: number,
    onFrame: (
      frame: Buffer,
      meta: { width: number; height: number; bltMs: number; grabMs: number },
    ) => void,
  ): boolean;
  stop(): void;
  lastError(): string;
};

export = winCapture;
