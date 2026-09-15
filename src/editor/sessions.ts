import { EventEmitter } from "node:events";

export interface SessionTrackerOptions {
  /** How long to wait after the last tab disconnects before going idle, so a page reload doesn't end the editor. */
  idleGraceMs?: number;
}

/**
 * Counts open editor tabs, each holding one long-lived request. Emits "connected" when the first tab
 * connects and "idle" once every tab has been gone for `idleGraceMs`.
 */
export class SessionTracker extends EventEmitter<{ connected: []; idle: [] }> {
  private count = 0;
  private everConnected = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleGraceMs: number;

  constructor(options: SessionTrackerOptions = {}) {
    super();
    this.idleGraceMs = options.idleGraceMs ?? 3000;
  }

  get active(): number {
    return this.count;
  }

  /** Registers a tab and returns the function to call when its connection closes. */
  open(): () => void {
    this.count++;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.everConnected) {
      this.everConnected = true;
      this.emit("connected");
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.count--;
      if (this.count === 0) {
        this.idleTimer = setTimeout(() => this.emit("idle"), this.idleGraceMs);
      }
    };
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
  }
}
