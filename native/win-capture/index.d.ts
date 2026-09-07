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
   *
   * onFrame also fires exactly once more when the capture thread exits, for
   * whatever reason (window gone, an unrecoverable capture error, or an
   * ordinary stop()) -- with `frame` null and `meta.reason` set to
   * lastError() at that moment (may be empty for an ordinary stop()). This
   * lets the caller react immediately instead of inferring death from a
   * frame drought.
   */
  // Two call signatures, not one object type with optional fields: a live
  // frame's meta and the death signal's meta genuinely don't overlap (see
  // addon.cc's Emit()/EmitToJs -- the death branch never sets
  // width/height/bltMs/grabMs at all), so `frame`'s nullness should rule out
  // reading the fields that don't exist for it, not just leave them typed
  // optional and hope every caller remembers to check.
  start(
    hwnd: string | number,
    targetWidth: number,
    targetHeight: number,
    fps: number,
    onFrame: {
      (
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
      ): void;
      /** The one death-signal call on capture-thread exit -- see above. No
       *  pixel buffer and no frame dimensions/timings, just the counters and
       *  why. */
      (
        frame: null,
        meta: { refused: number; poolResizes: number; reason: string },
      ): void;
    },
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
