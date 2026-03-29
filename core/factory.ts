import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentRuntime, AgentProviderKind } from "./types";
import { CodexAdapter, CodexAdapterOptions } from "../providers/codex";
import { CopilotAdapter, CopilotAdapterOptions } from "../providers/copilot";

export interface AgentRuntimeFactoryOptions {
  readonly provider: AgentProviderKind;
  readonly codex?: CodexAdapterOptions;
  readonly copilot?: CopilotAdapterOptions;
}

export interface AgentRuntimeConfig {
  readonly provider: AgentProviderKind;
  readonly codex?: CodexAdapterOptions;
  readonly copilot?: CopilotAdapterOptions;
}

export function createAgentRuntime(options: AgentRuntimeFactoryOptions): AgentRuntime {
  if (options.provider === "codex") {
    return new CodexAdapter(options.codex);
  }
  return new CopilotAdapter(options.copilot);
}

export function createAgentRuntimeFromConfig(config: AgentRuntimeConfig): AgentRuntime {
  return createAgentRuntime({
    provider: config.provider,
    codex: config.codex,
    copilot: config.copilot
  });
}

export async function loadAgentRuntimeConfig(configPath: string): Promise<AgentRuntimeConfig> {
  const resolvedPath = path.resolve(configPath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseAgentRuntimeConfig(parsed, resolvedPath);
}

export async function createAgentRuntimeFromConfigFile(configPath: string): Promise<AgentRuntime> {
  const config = await loadAgentRuntimeConfig(configPath);
  return createAgentRuntimeFromConfig(config);
}

export function createAgentRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const provider = normalizeProvider(env.AGENT_PROVIDER);
  if (provider === "copilot") {
    return new CopilotAdapter({
      transport: normalizeCopilotTransport(env.AGENT_COPILOT_TRANSPORT),
      host: env.AGENT_COPILOT_HOST,
      port: parseOptionalPort(env.AGENT_COPILOT_PORT),
      command: env.AGENT_COPILOT_COMMAND,
      args: parseOptionalArgs(env.AGENT_COPILOT_ARGS) ?? ["--acp"],
      cwd: env.AGENT_COPILOT_CWD,
      env: undefined
    });
  }

  return new CodexAdapter({
    transport: normalizeCodexTransport(env.AGENT_CODEX_TRANSPORT),
    command: env.AGENT_CODEX_COMMAND,
    args: parseOptionalArgs(env.AGENT_CODEX_ARGS),
    cwd: env.AGENT_CODEX_CWD,
    env: undefined,
    websocketUrl: env.AGENT_CODEX_WS_URL
  });
}

function normalizeProvider(value: string | undefined): AgentProviderKind {
  return value === "copilot" ? "copilot" : "codex";
}

function normalizeCodexTransport(value: string | undefined): "stdio" | "websocket" | undefined {
  if (value === "websocket") {
    return "websocket";
  }
  if (value === "stdio") {
    return "stdio";
  }
  return undefined;
}

function normalizeCopilotTransport(value: string | undefined): "tcp" | "stdio" | undefined {
  if (value === "stdio") {
    return "stdio";
  }
  if (value === "tcp") {
    return "tcp";
  }
  return undefined;
}

function parseOptionalArgs(value: string | undefined): readonly string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) ? port : undefined;
}

function parseAgentRuntimeConfig(value: unknown, configPath: string): AgentRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime config at ${configPath}: root must be an object`);
  }

  const provider = value.provider;
  if (provider !== "codex" && provider !== "copilot") {
    throw new Error(`Invalid runtime config at ${configPath}: provider must be "codex" or "copilot"`);
  }

  return {
    provider,
    codex: parseCodexOptions(value.codex, configPath),
    copilot: parseCopilotOptions(value.copilot, configPath)
  };
}

function parseCodexOptions(value: unknown, configPath: string): CodexAdapterOptions | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime config at ${configPath}: codex must be an object`);
  }

  const transport = value.transport;
  if (transport !== undefined && transport !== "stdio" && transport !== "websocket") {
    throw new Error(`Invalid runtime config at ${configPath}: codex.transport must be "stdio" or "websocket"`);
  }

  return {
    transport,
    command: parseOptionalString(value.command, "codex.command", configPath),
    args: parseOptionalStringArray(value.args, "codex.args", configPath),
    cwd: parseOptionalString(value.cwd, "codex.cwd", configPath),
    env: parseOptionalStringRecord(value.env, "codex.env", configPath),
    websocketUrl: parseOptionalString(value.websocketUrl, "codex.websocketUrl", configPath)
  };
}

function parseCopilotOptions(value: unknown, configPath: string): CopilotAdapterOptions | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime config at ${configPath}: copilot must be an object`);
  }

  const transport = value.transport;
  if (transport !== undefined && transport !== "tcp" && transport !== "stdio") {
    throw new Error(`Invalid runtime config at ${configPath}: copilot.transport must be "tcp" or "stdio"`);
  }

  return {
    transport,
    host: parseOptionalString(value.host, "copilot.host", configPath),
    port: parseOptionalNumber(value.port, "copilot.port", configPath),
    command: parseOptionalString(value.command, "copilot.command", configPath),
    args: parseOptionalStringArray(value.args, "copilot.args", configPath),
    cwd: parseOptionalString(value.cwd, "copilot.cwd", configPath),
    env: parseOptionalStringRecord(value.env, "copilot.env", configPath)
  };
}

function parseOptionalString(value: unknown, fieldName: string, configPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid runtime config at ${configPath}: ${fieldName} must be a string`);
  }
  return value;
}

function parseOptionalNumber(value: unknown, fieldName: string, configPath: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid runtime config at ${configPath}: ${fieldName} must be a finite number`);
  }
  return value;
}

function parseOptionalStringArray(value: unknown, fieldName: string, configPath: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid runtime config at ${configPath}: ${fieldName} must be a string array`);
  }
  return value;
}

function parseOptionalStringRecord(value: unknown, fieldName: string, configPath: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid runtime config at ${configPath}: ${fieldName} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Invalid runtime config at ${configPath}: ${fieldName}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
