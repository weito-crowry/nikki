import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface TransportEvents {
  message: [string];
  error: [Error];
  close: [number | null];
}

export class StdioTransport extends EventEmitter<TransportEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";

  public constructor(private readonly options: StdioTransportOptions) {
    super();
  }

  public async connect(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: "pipe"
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.consume(chunk);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.emit("error", new Error(chunk.trim() || "stdio stderr error"));
    });
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("close", (code) => this.emit("close", code));
  }

  public async send(message: string): Promise<void> {
    if (!this.child) {
      throw new Error("stdio transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      this.child?.stdin.write(`${message}\n`, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
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
