import { EventEmitter } from "node:events";

export interface WebSocketTransportOptions {
  readonly url: string;
  readonly protocols?: readonly string[];
}

export interface WebSocketTransportEvents {
  message: [string];
  error: [Error];
  close: [number, string];
}

interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface WebSocketCtor {
  new (url: string, protocols?: readonly string[] | string): WebSocketLike;
}

export class WebSocketTransport extends EventEmitter<WebSocketTransportEvents> {
  private socket: WebSocketLike | null = null;

  public constructor(private readonly options: WebSocketTransportOptions) {
    super();
  }

  public async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    const ctor = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!ctor) {
      throw new Error("WebSocket is not available in this Node.js runtime");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new ctor(this.options.url, this.options.protocols);
      this.socket = socket;
      let settled = false;
      socket.onopen = () => {
        settled = true;
        resolve();
      };
      socket.onmessage = (event) => {
        this.emit("message", String(event.data));
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("websocket transport error"));
          return;
        }
        this.emit("error", new Error("websocket transport error"));
      };
      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          reject(new Error(`websocket closed during connect: ${event.code ?? 1000}`));
          return;
        }
        this.emit("close", event.code ?? 1000, event.reason ?? "");
      };
    });
  }

  public async send(message: string): Promise<void> {
    if (!this.socket) {
      throw new Error("websocket transport is not connected");
    }
    this.socket.send(message);
  }

  public async close(): Promise<void> {
    if (!this.socket) {
      return;
    }
    this.socket.close();
    this.socket = null;
  }
}
