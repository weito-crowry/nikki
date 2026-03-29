import { BaseRuntime } from "../core/runtime";
import { approvalRequested, errorEvent, messageCompleted, messageDelta, sessionUpdated, toolCalled } from "../core/events";
import { RuntimeSession, SessionDelegate } from "../core/session";
import {
  AgentCapabilities,
  AgentEvent,
  AgentProviderKind,
  AgentSession,
  ApprovalDecision,
  ApprovalRequest,
  SessionResumeOptions,
  SessionStartOptions
} from "../core/types";
import { StdioTransport } from "../transports/stdio";
import { WebSocketTransport } from "../transports/websocket";

type CodexTransport = StdioTransport | WebSocketTransport;

export interface CodexAdapterOptions {
  readonly transport?: "stdio" | "websocket";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly websocketUrl?: string;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Readonly<Record<string, unknown>>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();

  public constructor(private readonly transport: CodexTransport) {
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

  public removeListener(listener: (message: JsonRpcMessage) => void): void {
    this.listeners.delete(listener);
  }

  public async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("codex rpc client closed"));
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
        pending.reject(new Error(message.error.message ?? "unknown codex rpc error"));
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

class CodexSession extends RuntimeSession implements SessionDelegate {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private accumulatedMessage = "";

  public constructor(
    id: string,
    capabilities: AgentCapabilities,
    private readonly rpc: CodexRpcClient,
    private readonly options?: SessionStartOptions | SessionResumeOptions
  ) {
    super(id, "codex", capabilities, {
      send: (input: string) => this.performSend(input),
      cancel: (reason?: string) => this.performCancel(reason),
      approve: (requestId: string, decision: ApprovalDecision, reason?: string) => this.performApprove(requestId, decision, reason),
      end: () => this.performEnd()
    });
  }

  public async initialize(): Promise<void> {
    this.rpc.addListener((message) => this.handleNotification(message));
    await this.rpc.request("initialize", {
      clientInfo: { name: "agent-runtime", version: "1.0.0" },
      capabilities: {}
    });
    await this.rpc.notify("initialized", {});

    const thread = await this.rpc.request("thread/start", {
      cwd: this.options?.cwd,
      model: this.options?.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false
    });

    const rawThread = thread.thread as Readonly<Record<string, unknown>> | undefined;
    this.threadId = typeof rawThread?.id === "string" ? rawThread.id : this.id;
    this.setStatus("active", { threadId: this.threadId });
  }

  private async performSend(input: string): Promise<void> {
    if (!this.threadId) {
      throw new Error("codex session is not initialized");
    }

    this.accumulatedMessage = "";
    const result = await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input, text_elements: [] }],
      cwd: this.options?.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      model: this.options?.model,
      effort: null,
      summary: "auto"
    });

    const turn = result.turn as Readonly<Record<string, unknown>> | undefined;
    this.activeTurnId = typeof turn?.id === "string" ? turn.id : null;
  }

  private async performCancel(reason?: string): Promise<void> {
    if (this.threadId && this.activeTurnId) {
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId, reason: reason ?? "cancelled" }).catch(() => undefined);
    }
  }

  private async performApprove(requestId: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    const request = this.approvals.get(requestId);
    if (!request) {
      throw new Error(`unknown approval request: ${requestId}`);
    }

    await this.rpc.request("approval/respond", {
      requestId,
      decision,
      reason: reason ?? null
    }).catch(() => undefined);
  }

  private async performEnd(): Promise<void> {
    if (this.threadId) {
      await this.rpc.request("thread/archive", { threadId: this.threadId }).catch(() => undefined);
    }
    await this.rpc.close();
  }

  private handleNotification(message: JsonRpcMessage): void {
    const method = message.method;
    if (!method) {
      if (message.error?.message) {
        this.pushEvent(errorEvent(this.id, message.error.message, { retryable: false }));
        this.setStatus("failed");
      }
      return;
    }

    const params = message.params ?? {};
    if (method === "turn/started") {
      this.syncStatus("active");
      this.pushEvent(sessionUpdated(this.id, "active", { method, params }));
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      this.accumulatedMessage += delta;
      this.pushEvent(messageDelta(this.id, delta, { method, itemId: params.itemId }));
      return;
    }
    if (method === "item/completed") {
      const item = params.item as Readonly<Record<string, unknown>> | undefined;
      const itemType = typeof item?.type === "string" ? item.type : "";
      if (itemType.toLowerCase().includes("tool")) {
        this.pushEvent(toolCalled(this.id, itemType, JSON.stringify(item), { method }));
      }
      return;
    }
    if (method.toLowerCase().includes("approval") || method.toLowerCase().includes("requestapproval")) {
      const request: ApprovalRequest = {
        id: typeof params.requestId === "string" ? params.requestId : `${this.id}_approval_${Date.now()}`,
        sessionId: this.id,
        title: typeof params.title === "string" ? params.title : "Approval required",
        description: typeof params.message === "string" ? params.message : JSON.stringify(params),
        command: typeof params.command === "string" ? params.command : undefined,
        metadata: { method, params }
      };
      this.approvals.set(request.id, request);
      this.pushEvent(approvalRequested(this.id, request, { method }));
      return;
    }
    if (method === "turn/completed") {
      this.pushEvent(messageCompleted(this.id, this.accumulatedMessage, { method, turnId: params.turnId }));
      this.activeTurnId = null;
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

export class CodexAdapter extends BaseRuntime<CodexSession> {
  private readonly options: CodexAdapterOptions;

  public constructor(options?: CodexAdapterOptions) {
    super("codex", {
      provider: "codex",
      supportsStreaming: true,
      supportsApprovals: true,
      supportsToolDiscovery: false,
      supportsTcpTransport: false,
      supportsWebSocketTransport: true
    });
    this.options = options ?? {};
  }

  protected override async buildSession(sessionId: string, options?: SessionStartOptions | SessionResumeOptions): Promise<CodexSession> {
    const transport = this.createTransport();
    const rpc = new CodexRpcClient(transport);
    await rpc.connect();
    const session = new CodexSession(sessionId, this.getCapabilities(), rpc, options);
    await session.initialize();
    return session;
  }

  protected override async destroySession(session: CodexSession): Promise<void> {
    void session;
  }

  private createTransport(): CodexTransport {
    if (this.options.transport === "websocket") {
      if (!this.options.websocketUrl) {
        throw new Error("websocketUrl is required for Codex websocket transport");
      }
      return new WebSocketTransport({ url: this.options.websocketUrl });
    }

    return new StdioTransport({
      command: this.options.command ?? "codex",
      args: this.options.args ?? ["app-server"],
      cwd: this.options.cwd,
      env: this.options.env
    });
  }
}
