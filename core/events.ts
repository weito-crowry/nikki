import {
  AgentApprovalRequestedEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentMessageCompletedEvent,
  AgentMessageDeltaEvent,
  AgentSessionUpdatedEvent,
  AgentToolCalledEvent,
  ApprovalRequest,
  SessionStatus
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function freezeMetadata(metadata?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...(metadata ?? {}) });
}

export function messageDelta(sessionId: string, textDelta: string, metadata?: Readonly<Record<string, unknown>>): AgentMessageDeltaEvent {
  return {
    type: "message.delta",
    sessionId,
    textDelta,
    timestamp: nowIso(),
    metadata: freezeMetadata(metadata)
  };
}

export function messageCompleted(sessionId: string, message: string, metadata?: Readonly<Record<string, unknown>>): AgentMessageCompletedEvent {
  return {
    type: "message.completed",
    sessionId,
    message,
    timestamp: nowIso(),
    metadata: freezeMetadata(metadata)
  };
}

export function approvalRequested(sessionId: string, request: ApprovalRequest, metadata?: Readonly<Record<string, unknown>>): AgentApprovalRequestedEvent {
  return {
    type: "approval.requested",
    sessionId,
    request,
    timestamp: nowIso(),
    metadata: freezeMetadata(metadata)
  };
}

export function toolCalled(sessionId: string, toolName: string, argumentsText?: string, metadata?: Readonly<Record<string, unknown>>): AgentToolCalledEvent {
  return {
    type: "tool.called",
    sessionId,
    toolName,
    argumentsText,
    timestamp: nowIso(),
    metadata: freezeMetadata(metadata)
  };
}

export function sessionUpdated(sessionId: string, status: SessionStatus, metadata?: Readonly<Record<string, unknown>>): AgentSessionUpdatedEvent {
  return {
    type: "session.updated",
    sessionId,
    status,
    timestamp: nowIso(),
    metadata: freezeMetadata(metadata)
  };
}

export function errorEvent(
  sessionId: string,
  message: string,
  options?: { code?: string; retryable?: boolean; metadata?: Readonly<Record<string, unknown>> }
): AgentErrorEvent {
  return {
    type: "error",
    sessionId,
    message,
    code: options?.code,
    retryable: options?.retryable ?? false,
    timestamp: nowIso(),
    metadata: freezeMetadata(options?.metadata)
  };
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "message.completed" || (event.type === "session.updated" && (event.status === "ended" || event.status === "failed" || event.status === "cancelled"));
}
