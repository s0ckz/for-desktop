type Frame = {
  frame: Buffer;
  meta: {
    width: number;
    height: number;
    timestampUs: number;
    sessionId: number;
  };
};
type Port = { postMessage(message: unknown): void };

/** One message in transit and one replaceable latest frame. No pixel FIFO. */
export class FrameDelivery {
  private port: Port | null = null;
  private sessionId = 0;
  private ready = false;
  private latest: Frame | null = null;
  private pending: Frame | null = null;
  private inFlight: number | null = null;
  private nextId = 0;
  private posted = 0;
  private acknowledged = 0;
  private coalesced = 0;
  private failures = 0;

  setPort(port: Port | null) {
    this.port = port;
    this.ready = false;
    this.inFlight = null;
    this.pending = this.latest;
  }

  start(sessionId: number) {
    this.sessionId = sessionId;
    this.ready = false;
    this.latest = this.pending = null;
    this.inFlight = null;
    this.posted = this.acknowledged = this.coalesced = this.failures = 0;
  }

  stop() {
    this.start(0);
  }

  offer(frame: Frame) {
    if (!this.sessionId || frame.meta.sessionId !== this.sessionId) return;
    if (this.pending) this.coalesced++;
    this.latest = this.pending = frame;
    this.flush();
  }

  receive(message: unknown) {
    if (!message || typeof message !== "object") return;
    const value = message as {
      kind?: unknown;
      sessionId?: unknown;
      frameId?: unknown;
    };
    if (!this.sessionId || value.sessionId !== this.sessionId) return;
    if (value.kind === "ready") {
      this.ready = true;
      this.flush();
    } else if (
      value.kind === "ack" &&
      this.inFlight !== null &&
      value.frameId === this.inFlight
    ) {
      this.inFlight = null;
      this.acknowledged++;
      this.flush();
    } else if (value.kind === "pause") {
      this.ready = false;
      this.pending = this.latest;
    }
  }

  snapshot() {
    return {
      posted: this.posted,
      acknowledged: this.acknowledged,
      coalesced: this.coalesced,
      failures: this.failures,
      pending: this.pending !== null,
      inFlight: this.inFlight !== null,
      ready: this.ready,
    };
  }

  private flush() {
    if (!this.ready || !this.port || this.inFlight !== null || !this.pending)
      return;
    const frame = this.pending;
    const frameId = ++this.nextId;
    this.pending = null;
    this.inFlight = frameId;
    try {
      this.port.postMessage({ ...frame, meta: { ...frame.meta, frameId } });
      this.posted++;
    } catch {
      this.failures++;
      this.inFlight = null;
      this.pending = this.latest;
      this.ready = false;
    }
  }
}
