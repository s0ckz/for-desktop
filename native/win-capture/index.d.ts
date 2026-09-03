declare const winCapture: {
  isSupported(): boolean;
  /**
   * Start capturing `hwnd` (a desktopCapturer window handle, decimal or
   * string). Frames are delivered as NV12 buffers fit inside
   * targetWidth x targetHeight -- the source aspect ratio is preserved (not
   * stretched, and never upscaled) and both dimensions are rounded to even,
   * so the delivered frame may be smaller than the requested box on either
   * axis, or both (a source smaller than the box on both axes is captured at
   * its own size). `fps` bounds how often onFrame fires; frames arriving
   * faster are dropped, not queued. Returns true if the native capture
   * session was started.
   */
  start(
    hwnd: string | number,
    targetWidth: number,
    targetHeight: number,
    fps: number,
    onFrame: (
      frame: Buffer,
      meta: {
        width: number;
        height: number;
        bltMs: number;
        grabMs: number;
        /** Frames the JS side refused because it wasn't ready in time (see
         *  screenCapture.ts's ThreadSafeFunction queue). Cumulative for this
         *  capture session. */
        refused: number;
        /** Times the frame pool was recreated because the window's content
         *  size changed, i.e. resize events observed. A session that dies
         *  with this climbing was mid-resize; one that dies at zero hit a
         *  genuine capture failure. Cumulative for this capture session. */
        poolResizes: number;
      },
    ) => void,
  ): boolean;
  stop(): void;
  /**
   * Change the delivery rate of the capture already running. Returns false if
   * nothing is capturing or the value is unusable. Takes effect on the next
   * frame -- no session teardown.
   */
  setFps(fps: number): boolean;
  lastError(): string;
};

export = winCapture;
