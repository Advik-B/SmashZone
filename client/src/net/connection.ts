import { decode_server_msg } from "../wasm/pkg/sim_wasm";
import type { ServerMsg } from "./messages";

// Backoff schedule for reconnect attempts (~15 s total, inside the server's
// 45 s reconnect grace window).
const RECONNECT_BACKOFFS_MS = [500, 1000, 2000, 4000, 8000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFFS_MS.length;

/**
 * WebSocket wrapper with automatic reconnect. After the first Welcome the
 * caller hands us a session token; if the socket then drops unexpectedly we
 * retry with the token (rejoining the same slot + score) on a backoff. A
 * user-initiated close or a server Error message (room not found / full /
 * restarting) is terminal.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private attempt = 0;
  private closedByUser = false;
  private gotError = false;
  private closedReason = "connection lost";
  private retryTimer: number | null = null;

  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  onReconnecting: (attempt: number) => void = () => {};

  constructor(
    private code: string,
    private name: string,
  ) {
    this.connect();
  }

  /** Remember the session token so a dropped socket can rejoin its slot. */
  setToken(token: string) {
    this.token = token;
    this.attempt = 0; // fresh session: reset the retry budget
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let url = `${proto}://${location.host}/ws?code=${encodeURIComponent(
      this.code,
    )}&name=${encodeURIComponent(this.name)}`;
    if (this.token) url += `&token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (ev) => {
      const msg = decode_server_msg(new Uint8Array(ev.data as ArrayBuffer)) as
        | ServerMsg
        | null;
      if (!msg) return;
      if (msg.type === "Error") {
        this.gotError = true;
        this.closedReason = msg.msg;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => this.handleClose();
    ws.onerror = () => ws.close();
  }

  private handleClose() {
    if (this.closedByUser) return;
    // Retry only if we have a session token, the server didn't explicitly
    // reject us, and we still have attempts left.
    const canRetry =
      this.token !== null && !this.gotError && this.attempt < MAX_RECONNECT_ATTEMPTS;
    if (!canRetry) {
      this.onClose(this.closedReason);
      return;
    }
    this.attempt++;
    this.onReconnecting(this.attempt);
    const delay = RECONNECT_BACKOFFS_MS[Math.min(this.attempt - 1, RECONNECT_BACKOFFS_MS.length - 1)];
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  send(bytes: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.onClose = () => {};
    this.ws?.close();
  }
}
