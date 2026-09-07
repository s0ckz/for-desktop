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
          /** Times the staging-texture readback (D3D11_MAP_FLAG_DO_NOT_WAIT)
           *  returned DXGI_ERROR_WAS_STILL_DRAWING and the frame was skipped
           *  -- an ordinary pacing drop, not a failure, but one worth seeing
           *  climb: a session stuck at this incrementing on every frame is
           *  delivering nothing and this is why. Cumulative for this capture
           *  session. */
          stillDrawing: number;
          /** Times frame->get_SystemRelativeTime() failed, or returned
           *  Duration == 0, and pacing fell back to a QueryPerformanceCounter
           *  read instead -- see addon.cc's QpcNow100ns for why a failed read
           *  must never be treated as a genuine 0. Cumulative for this
           *  capture session; normally 0 for the whole session. */
          timestampFallbacks: number;
          /** Times pacing detected `ts` (whichever clock produced it --
           *  see `timestampFallbacks` above) landing BEFORE the previous
           *  delivered frame's timestamp, not just too close to it, and
           *  re-baselined instead of dropping every frame for the rest of
           *  the session -- see addon.cc's CaptureThread, the discontinuity
           *  guard immediately above its pacing check. A separate counter
           *  from `timestampFallbacks`: using the QPC fallback and hitting
           *  this backward jump are not the same event (see
           *  g_timestampDiscontinuities's own doc comment for why). Cumulative
           *  for this capture session; normally 0 for the whole session. */
          timestampDiscontinuities: number;
          /** This frame's own capture timestamp -- frame->get_SystemRelativeTime()
           *  (100ns units) converted to microseconds -- not when the JS side
           *  happened to receive it. Monotonically increasing within a capture
           *  session; not comparable across sessions or to Date.now()/
           *  performance.now(). Use directly as a generated VideoFrame's
           *  `timestamp`, and the delta between consecutive values as its
           *  `duration` -- see appAudioPatch.ts. */
          timestampUs: number;
        },
      ): void;
      /** The one death-signal call on capture-thread exit -- see above. No
       *  pixel buffer and no frame dimensions/timings, just the counters and
       *  why. */
      (
        frame: null,
        meta: {
          refused: number;
          poolResizes: number;
          stillDrawing: number;
          timestampFallbacks: number;
          timestampDiscontinuities: number;
          reason: string;
        },
      ): void;
    },
  ): boolean;
  /**
   * Requests capture to stop and resolves once the capture thread has
   * actually joined -- the join runs off the main thread (a libuv
   * threadpool AsyncWorker), so this never blocks Electron's main thread
   * the way the old synchronous stop() did. Safe to call when nothing is
   * running (resolves immediately). While the returned promise is
   * pending, start() throws "previous capture still shutting down"
   * instead of racing a new session against this one's teardown.
   */
  stop(): Promise<void>;
  /**
   * Change the delivery rate of the capture already running. Returns false if
   * nothing is capturing or the value is unusable. Takes effect on the next
   * frame -- no session teardown.
   */
  setFps(fps: number): boolean;
  /**
   * Change the target bounding box of the capture already running -- a
   * mid-share preset change (e.g. 1080p -> 720p). Frames continue to be
   * fit inside `width` x `height` the same way `start()`'s targetWidth/
   * targetHeight are (aspect preserved, never upscaled, both dimensions
   * rounded to even). Scaling happens on the GPU before readback, so this is
   * how a 720p pick actually shrinks the per-frame CPU copy instead of
   * relying on a downstream `scaleResolutionDownBy` CPU scale. Returns false
   * if nothing is capturing or the values are unusable. Takes effect on the
   * next frame -- no session teardown.
   */
  setTarget(width: number, height: number): boolean;
  lastError(): string;
};

export = winCapture;
