import net from "node:net";
import { EventEmitter } from "node:events";

export interface TcpTransportOptions {
  readonly host: string;
  readonly port: number;
}

export interface TcpTransportEvents {
  message: [string];
  error: [Error];
  close: [boolean];
}

export class TcpTransport extends EventEmitter<TcpTransportEvents> {
  private socket: net.Socket | null = null;
  private buffer = "";

  public constructor(private readonly options: TcpTransportOptions) {
    super();
  }

  public async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = new net.Socket();
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", (hadError) => this.emit("close", hadError));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = (): void => {
        socket.off("error", onError);
        resolve();
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.connect(this.options.port, this.options.host);
    });
  }

  public async send(message: string): Promise<void> {
    if (!this.socket) {
      throw new Error("tcp transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket?.write(`${message}\n`, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
      setTimeout(resolve, 1000);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.emit("message", line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }
}
