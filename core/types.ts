export type AgentProviderKind = "codex" | "copilot";
export type AgentTransportKind = "stdio" | "tcp" | "websocket";
export type SessionStatus = "idle" | "starting" | "active" | "ended" | "failed" | "cancelled";
export type ApprovalDecision = "approved" | "rejected";

export interface AgentCapabilities {
  readonly provider: AgentProviderKind;
  readonly supportsStreaming: boolean;
  readonly supportsApprovals: boolean;
  readonly supportsToolDiscovery: boolean;
  readonly supportsTcpTransport: boolean;
  readonly supportsWebSocketTransport: boolean;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly description: string;
  readonly command?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SessionStartOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionResumeOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentMessageDeltaEvent {
  readonly type: "message.delta";
  readonly sessionId: string;
  readonly textDelta: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentMessageCompletedEvent {
  readonly type: "message.completed";
  readonly sessionId: string;
  readonly message: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentApprovalRequestedEvent {
  readonly type: "approval.requested";
  readonly sessionId: string;
  readonly request: ApprovalRequest;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentToolCalledEvent {
  readonly type: "tool.called";
  readonly sessionId: string;
  readonly toolName: string;
  readonly argumentsText?: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentSessionUpdatedEvent {
  readonly type: "session.updated";
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentErrorEvent {
  readonly type: "error";
  readonly sessionId: string;
  readonly message: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type AgentEvent =
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent
  | AgentApprovalRequestedEvent
  | AgentToolCalledEvent
  | AgentSessionUpdatedEvent
  | AgentErrorEvent;

export interface AgentSession {
  readonly id: string;
  readonly provider: AgentProviderKind;
  readonly capabilities: AgentCapabilities;
  readonly status: SessionStatus;
  send(input: string): Promise<void>;
  stream(): AsyncIterable<AgentEvent>;
  cancel(reason?: string): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision, reason?: string): Promise<void>;
  end(): Promise<void>;
}

export interface AgentRuntime {
  readonly provider: AgentProviderKind;
  getCapabilities(): AgentCapabilities;
  startSession(options?: SessionStartOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, options?: SessionResumeOptions): Promise<AgentSession>;
  endSession(sessionId: string): Promise<void>;
}

export interface ProviderEventEnvelope {
  readonly kind: string;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
