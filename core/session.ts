import { errorEvent, sessionUpdated } from "./events";
import {
  AgentCapabilities,
  AgentEvent,
  AgentProviderKind,
  AgentSession,
  ApprovalDecision,
  SessionStatus
} from "./types";

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  complete(): void {
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return { value, done: false };
        }
        if (this.done) {
          return { value: undefined as T, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}

export interface SessionDelegate {
  send(input: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision, reason?: string): Promise<void>;
  end(): Promise<void>;
}

export class RuntimeSession implements AgentSession {
  private readonly queue = new AsyncEventQueue<AgentEvent>();
  private currentStatus: SessionStatus = "idle";

  public constructor(
    public readonly id: string,
    public readonly provider: AgentProviderKind,
    public readonly capabilities: AgentCapabilities,
    private readonly delegate: SessionDelegate
  ) {}

  public get status(): SessionStatus {
    return this.currentStatus;
  }

  public syncStatus(status: SessionStatus): void {
    this.currentStatus = status;
    if (status === "ended" || status === "failed" || status === "cancelled") {
      this.queue.complete();
    }
  }

  public setStatus(status: SessionStatus, metadata?: Readonly<Record<string, unknown>>): void {
    this.syncStatus(status);
    this.pushEvent(sessionUpdated(this.id, status, metadata));
  }

  public pushEvent(event: AgentEvent): void {
    this.queue.push(event);
  }

  public pushInternalError(message: string, code?: string): void {
    this.queue.push(errorEvent(this.id, message, { code, retryable: false }));
    this.setStatus("failed");
  }

  public async send(input: string): Promise<void> {
    await this.delegate.send(input);
  }

  public stream(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  public async cancel(reason?: string): Promise<void> {
    await this.delegate.cancel(reason);
    this.setStatus("cancelled", reason ? { reason } : undefined);
  }

  public async approve(requestId: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    await this.delegate.approve(requestId, decision, reason);
  }

  public async end(): Promise<void> {
    await this.delegate.end();
    this.setStatus("ended");
  }
}
