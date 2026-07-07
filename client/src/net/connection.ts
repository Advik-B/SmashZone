import { decode_server_msg } from "../wasm/pkg/sim_wasm";
import type { ServerMsg } from "./messages";

export class Connection {
  private ws: WebSocket;
  onMessage: (msg: ServerMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private closedReason = "connection lost";

  constructor(code: string, name: string) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?code=${encodeURIComponent(
      code,
    )}&name=${encodeURIComponent(name)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onmessage = (ev) => {
      const msg = decode_server_msg(new Uint8Array(ev.data as ArrayBuffer)) as
        | ServerMsg
        | null;
      if (!msg) return;
      if (msg.type === "Error") {
        this.closedReason = msg.msg;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = () => this.onClose(this.closedReason);
    this.ws.onerror = () => this.ws.close();
  }

  send(bytes: Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  close() {
    this.onClose = () => {};
    this.ws.close();
  }
}
