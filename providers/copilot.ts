import { BaseRuntime } from "../core/runtime";
import { approvalRequested, errorEvent, messageCompleted, messageDelta, sessionUpdated, toolCalled } from "../core/events";
import { RuntimeSession, SessionDelegate } from "../core/session";
import {
  AgentCapabilities,
  ApprovalDecision,
  ApprovalRequest,
  SessionResumeOptions,
  SessionStartOptions
} from "../core/types";
import { StdioTransport } from "../transports/stdio";
import { TcpTransport } from "../transports/tcp";

type CopilotTransport = StdioTransport | TcpTransport;

export interface CopilotAdapterOptions {
  readonly transport?: "tcp" | "stdio";
  readonly host?: string;
  readonly port?: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

class CopilotRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Readonly<Record<string, unknown>>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();

  public constructor(private readonly transport: CopilotTransport) {
    this.transport.on("message", (line: string) => this.handleLine(line));
    this.transport.on("error", (error: Error) => this.broadcast({ error: { message: error.message } }));
  }

  public async connect(): Promise<void> {
    await this.transport.connect();
  }

  public async request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const id = this.nextId++;
    await this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  public async notify(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    await this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  public addListener(listener: (message: JsonRpcMessage) => void): void {
    this.listeners.add(listener);
  }

  public async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("copilot rpc client closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.broadcast({ error: { message: error instanceof Error ? error.message : String(error) } });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "unknown copilot rpc error"));
        return;
      }
      pending.resolve(message.result ?? {});
      return;
    }

    this.broadcast(message);
  }

  private broadcast(message: JsonRpcMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

class CopilotSession extends RuntimeSession implements SessionDelegate {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private providerSessionId: string | null = null;
  private accumulatedMessage = "";

  public constructor(
    id: string,
    capabilities: AgentCapabilities,
    private readonly rpc: CopilotRpcClient,
    private readonly options?: SessionStartOptions | SessionResumeOptions
  ) {
    super(id, "copilot", capabilities, {
      send: (input: string) => this.performSend(input),
      cancel: (reason?: string) => this.performCancel(reason),
      approve: (requestId: string, decision: ApprovalDecision, reason?: string) => this.performApprove(requestId, decision, reason),
      end: () => this.performEnd()
    });
  }

  public async initialize(resumeSessionId?: string): Promise<void> {
    this.rpc.addListener((message) => this.handleNotification(message));

    const result = await this.rpc.request(resumeSessionId ? "session/resume" : "session/start", {
      sessionId: resumeSessionId ?? null,
      cwd: this.options?.cwd,
      model: this.options?.model,
      metadata: this.options?.metadata ?? {}
    });

    const session = result.session as Readonly<Record<string, unknown>> | undefined;
    this.providerSessionId = typeof session?.id === "string" ? session.id : this.id;
    this.setStatus("active", { providerSessionId: this.providerSessionId });
  }

  private async performSend(input: string): Promise<void> {
    if (!this.providerSessionId) {
      throw new Error("copilot session is not initialized");
    }

    this.accumulatedMessage = "";
    await this.rpc.notify("session/send", {
      sessionId: this.providerSessionId,
      input,
      model: this.options?.model
    });
  }

  private async performCancel(reason?: string): Promise<void> {
    if (this.providerSessionId) {
      await this.rpc.notify("session/cancel", { sessionId: this.providerSessionId, reason: reason ?? "cancelled" }).catch(() => undefined);
    }
  }

  private async performApprove(requestId: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    const request = this.approvals.get(requestId);
    if (!request) {
      throw new Error(`unknown approval request: ${requestId}`);
    }
    await this.rpc.notify("approval/respond", { sessionId: this.providerSessionId, requestId, decision, reason: reason ?? null });
  }

  private async performEnd(): Promise<void> {
    if (this.providerSessionId) {
      await this.rpc.notify("session/end", { sessionId: this.providerSessionId }).catch(() => undefined);
    }
    await this.rpc.close();
  }

  private handleNotification(message: JsonRpcMessage): void {
    const method = message.method;
    const params = message.params ?? {};
    if (!method) {
      if (message.error?.message) {
        this.pushEvent(errorEvent(this.id, message.error.message, { retryable: false }));
        this.setStatus("failed");
      }
      return;
    }

    if (method === "response.delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      this.accumulatedMessage += delta;
      this.pushEvent(messageDelta(this.id, delta, { method }));
      return;
    }
    if (method === "response.completed") {
      const messageText = typeof params.message === "string" ? params.message : this.accumulatedMessage;
      this.pushEvent(messageCompleted(this.id, messageText, { method }));
      return;
    }
    if (method === "approval.requested") {
      const request: ApprovalRequest = {
        id: typeof params.requestId === "string" ? params.requestId : `${this.id}_approval_${Date.now()}`,
        sessionId: this.id,
        title: typeof params.title === "string" ? params.title : "Approval required",
        description: typeof params.description === "string" ? params.description : JSON.stringify(params),
        command: typeof params.command === "string" ? params.command : undefined,
        metadata: { method, params }
      };
      this.approvals.set(request.id, request);
      this.pushEvent(approvalRequested(this.id, request, { method }));
      return;
    }
    if (method === "tool.called") {
      this.pushEvent(toolCalled(this.id, typeof params.toolName === "string" ? params.toolName : "unknown", typeof params.arguments === "string" ? params.arguments : undefined, { method }));
      return;
    }
    if (method === "session.updated") {
      const status = typeof params.status === "string" ? (params.status as "idle" | "starting" | "active" | "ended" | "failed" | "cancelled") : "active";
      this.syncStatus(status);
      this.pushEvent(sessionUpdated(this.id, status, { method, params }));
      return;
    }
    if (method.toLowerCase().includes("error")) {
      this.pushEvent(errorEvent(this.id, JSON.stringify(params), { retryable: false, metadata: { method } }));
      this.setStatus("failed");
      return;
    }

    this.pushEvent(sessionUpdated(this.id, this.status, { method, params }));
  }
}

export class CopilotAdapter extends BaseRuntime<CopilotSession> {
  private readonly options: CopilotAdapterOptions;

  public constructor(options?: CopilotAdapterOptions) {
    super("copilot", {
      provider: "copilot",
      supportsStreaming: true,
      supportsApprovals: true,
      supportsToolDiscovery: true,
      supportsTcpTransport: true,
      supportsWebSocketTransport: false
    });
    this.options = options ?? {};
  }

  protected override async buildSession(sessionId: string, options?: SessionStartOptions | SessionResumeOptions): Promise<CopilotSession> {
    const rpc = new CopilotRpcClient(this.createTransport());
    await rpc.connect();
    const session = new CopilotSession(sessionId, this.getCapabilities(), rpc, options);
    const isResume = Boolean((options as SessionResumeOptions | SessionStartOptions | undefined)?.metadata?.__resume);
    await session.initialize(isResume ? sessionId : undefined);
    return session;
  }

  protected override async destroySession(session: CopilotSession): Promise<void> {
    void session;
  }

  private createTransport(): CopilotTransport {
    if (this.options.transport === "stdio") {
      return new StdioTransport({
        command: this.options.command ?? "github-copilot-cli",
        args: this.options.args ?? ["acp", "serve"],
        cwd: this.options.cwd,
        env: this.options.env
      });
    }

    return new TcpTransport({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port ?? 8765
    });
  }
}
