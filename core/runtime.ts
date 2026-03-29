import crypto from "node:crypto";
import { RuntimeSession } from "./session";
import {
  AgentCapabilities,
  AgentProviderKind,
  AgentRuntime,
  AgentSession,
  SessionResumeOptions,
  SessionStartOptions
} from "./types";

export interface RuntimeFactory<TSession extends RuntimeSession> {
  createSession(sessionId: string, options?: SessionStartOptions | SessionResumeOptions): Promise<TSession>;
  destroySession(session: TSession): Promise<void>;
}

export abstract class BaseRuntime<TSession extends RuntimeSession> implements AgentRuntime {
  protected readonly sessions = new Map<string, TSession>();

  protected constructor(
    public readonly provider: AgentProviderKind,
    private readonly capabilities: AgentCapabilities
  ) {}

  public getCapabilities(): AgentCapabilities {
    return this.capabilities;
  }

  public async startSession(options?: SessionStartOptions): Promise<AgentSession> {
    const sessionId = this.createSessionId();
    const session = await this.buildSession(sessionId, options);
    this.sessions.set(sessionId, session);
    return session;
  }

  public async resumeSession(sessionId: string, options?: SessionResumeOptions): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const session = await this.buildSession(sessionId, {
      metadata: {
        ...(options?.metadata ?? {}),
        __resume: true
      }
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  public async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    await session.end();
    await this.destroySession(session);
    this.sessions.delete(sessionId);
  }

  protected abstract buildSession(sessionId: string, options?: SessionStartOptions | SessionResumeOptions): Promise<TSession>;
  protected abstract destroySession(session: TSession): Promise<void>;

  protected createSessionId(): string {
    return `${this.provider}_${crypto.randomUUID()}`;
  }
}
