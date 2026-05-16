import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let appServerClientPromise = null;
let agentClientDeps = null;

export function configureAgentClient(deps) {
  agentClientDeps = deps;
}

function deps() {
  if (!agentClientDeps) {
    throw new Error('agent client is not configured');
  }
  return agentClientDeps;
}

function clip(...args) { return deps().clip(...args); }
function isoJst(...args) { return deps().isoJst(...args); }
function ensureDir(...args) { return deps().ensureDir(...args); }
function sleep(...args) { return deps().sleep(...args); }
function buildPromptStats(...args) { return deps().buildPromptStats(...args); }
function formatDuration(...args) { return deps().formatDuration(...args); }

export async function getAppServerClient(config) { if (!appServerClientPromise) appServerClientPromise = createAgentClient(config); return appServerClientPromise; }
export async function closeAppServerClient() { if (!appServerClientPromise) return; const client = await appServerClientPromise.catch(() => null); appServerClientPromise = null; if (client) await client.close(); }
async function resolveCodexCommand() { return resolveCommand("codex", ["codex.exe", "codex.cmd", "codex"]); }
async function resolveCopilotCommand() { return resolveCommand("github-copilot-cli", ["github-copilot-cli.exe", "github-copilot-cli.cmd", "github-copilot-cli"]); }

export async function createAgentClient(config) {
  const provider = resolveRuntimeProvider(config);
  if (provider === "copilot") {
    return CopilotAppServerClient.create(config);
  }
  if (provider === "ollama") {
    return OllamaClient.create(config);
  }
  return AppServerClient.create(config);
}

export function resolveRuntimeProvider(config) {
  if (config.runtime?.provider === "copilot" || config.provider === "copilot") {
    return "copilot";
  }
  if (config.runtime?.provider === "ollama" || config.provider === "ollama") {
    return "ollama";
  }
  return "codex";
}

export function normalizeAgentRuntimeConfig(config, provider) {
  const runtime = config.runtime && typeof config.runtime === "object" && !Array.isArray(config.runtime) ? config.runtime : {};
  const resolvedProvider = runtime.provider === "copilot" || provider === "copilot"
    ? "copilot"
    : runtime.provider === "ollama" || provider === "ollama"
      ? "ollama"
      : "codex";
  return {
    provider: resolvedProvider,
    codex: normalizeProviderOptions(runtime.codex, {
      transport: "stdio",
      command: undefined,
      args: ["app-server"],
      cwd: process.cwd(),
      env: null,
      websocketUrl: undefined
    }),
    copilot: normalizeProviderOptions(runtime.copilot, {
      transport: "tcp",
      host: "127.0.0.1",
      port: 8765,
      command: undefined,
      args: ["--acp", "--stdio"],
      cwd: process.cwd(),
      env: null
    }),
    ollama: normalizeProviderOptions(runtime.ollama, {
      baseUrl: "http://127.0.0.1:11434",
      keepAlive: "5m",
      think: null,
      headers: null,
      options: null,
      system: null
    })
  };
}

function normalizeProviderOptions(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaults };
  }
  return { ...defaults, ...value };
}

async function resolveCommand(baseName, winCandidates) {
  if (process.platform !== "win32") return baseName;
  for (const candidate of winCandidates.map((name) => path.join(process.env.APPDATA || "", "npm", name)).filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync("where.exe", [baseName], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const candidates = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (candidates[0]) return candidates[0];
  } catch {}
  return baseName;
}

class BaseRpcClient {
  constructor(config, eventLogName, providerLabel) {
    this.config = config;
    this.providerLabel = providerLabel;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.listeners = new Set();
    this.requestHandler = null;
    this.eventLogPath = path.join(config.outputDir, "logs", eventLogName);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  setRequestHandler(handler) {
    this.requestHandler = handler;
  }

  consume(text) {
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handle(JSON.parse(line));
      }
      index = this.buffer.indexOf("\n");
    }
  }

  handle(message) {
    if (typeof message.id !== "undefined" && typeof message.method === "string" && typeof message.result === "undefined" && typeof message.error === "undefined") {
      this.handleIncomingRequest(message);
      return;
    }
    if (typeof message.id !== "undefined") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  handleIncomingRequest(message) {
    if (!this.requestHandler) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }

    Promise.resolve(this.requestHandler(message))
      .then((result) => {
        this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
      })
      .catch((error) => {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        });
      });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  log(entry) {
    ensureDir(path.dirname(this.eventLogPath));
    fs.appendFileSync(this.eventLogPath, `${JSON.stringify({ at: isoJst(), provider: this.providerLabel, ...entry })}\n`, "utf8");
  }
}

class StdioRpcClient extends BaseRpcClient {
  static async create(config, command, args, options = {}) {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.cmd$/i.test(command)
    });
    return new StdioRpcClient(config, options.eventLogName, options.providerLabel, child);
  }

  constructor(config, eventLogName, providerLabel, child) {
    super(config, eventLogName, providerLabel);
    this.child = child;
    child.stdout.on("data", (chunk) => this.consume(String(chunk)));
    child.stderr.on("data", (chunk) => this.log({ stream: "stderr", text: String(chunk).trim() }));
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code) => this.rejectAll(new Error(`${providerLabel} process exited with code ${code}`)));
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  async close() {
    if (!this.child || this.child.killed) return;
    this.child.stdin.end();
    this.child.kill();
    await new Promise((resolve) => {
      this.child.once("close", () => resolve());
      setTimeout(resolve, 1000);
    });
  }
}

class TcpRpcClient extends BaseRpcClient {
  static async create(config, host, port, options = {}) {
    const socket = await new Promise((resolve, reject) => {
      const client = net.createConnection({ host, port }, () => resolve(client));
      client.once("error", reject);
    });
    return new TcpRpcClient(config, options.eventLogName, options.providerLabel, socket);
  }

  constructor(config, eventLogName, providerLabel, socket) {
    super(config, eventLogName, providerLabel);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.consume(String(chunk)));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error(`${providerLabel} tcp connection closed`)));
  }

  write(message) {
    this.socket.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise((resolve) => {
      socket.end(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
}

class AppServerClient {
  static async create(config) {
    const codex = config.runtime?.codex || {};
    const transport = codex.transport || "stdio";
    if (transport !== "stdio") {
      throw new Error(`未対応の Codex transport です: ${transport}`);
    }
    const command = codex.command || await resolveCodexCommand();
    const args = Array.isArray(codex.args) && codex.args.length ? codex.args : ["app-server"];
    const rpc = await StdioRpcClient.create(config, command, args, {
      cwd: codex.cwd || process.cwd(),
      env: codex.env || undefined,
      eventLogName: "app-server-events.log",
      providerLabel: "codex"
    });
    const client = new AppServerClient(rpc, config);
    await client.initialize();
    return client;
  }

  constructor(rpc, config) {
    this.rpc = rpc;
    this.config = config;
  }

  async initialize() {
    await this.rpc.request("initialize", { clientInfo: { name: "nikki", version: "0.2.0" }, capabilities: null });
    this.rpc.notify("initialized", {});
  }

  async runJsonTurn({ model, cwd, prompt, onProgress }) {
    const preview = clip(prompt.replace(/\s+/g, " "), 220);
    onProgress?.({ phase: "thread-start", promptPreview: preview, note: "一時スレッドを作成中" });
    const threadStart = await this.rpc.request("thread/start", {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      experimentalRawEvents: false,
      developerInstructions: [
        "常に日本語で応答してください。",
        "最終応答は JSON オブジェクトのみ。",
        "説明文、コードブロック、前置きは禁止。",
        "コマンド実行、ファイル変更、ツール使用は禁止。"
      ].join("\n")
    });
    const threadId = threadStart.thread.id;
    const sentAt = isoJst();
    const done = this.waitForTurn(threadId);
    const listener = (message) => {
      if (message.params?.threadId !== threadId) return;
      this.rpc.log({ method: message.method });
      const mapped = progressFromNotification("codex", message);
      if (mapped) onProgress?.({ threadId, promptPreview: preview, sentAt, ...mapped });
    };
    this.rpc.addListener(listener);
    onProgress?.({ phase: "turn-start", threadId, promptPreview: preview, sentAt, note: "プロンプト送信中" });
    await this.rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      model,
      effort: null,
      summary: "auto"
    });
    onProgress?.({ phase: "waiting", threadId, promptPreview: preview, sentAt, note: "モデル応答を待機中" });
    const completed = await done;
    this.rpc.removeListener(listener);
    if (completed.turn?.status !== "completed") throw new Error(`app-server turn failed: ${JSON.stringify(completed)}`);
    const threadRead = await this.rpc.request("thread/read", { threadId, includeTurns: true });
    const turns = threadRead.thread?.turns || [];
    const lastTurn = turns[turns.length - 1];
    const message = [...(lastTurn?.items || [])].reverse().find((item) => item.type === "agentMessage");
    if (!message?.text) throw new Error("app-server から最終 agentMessage を取得できませんでした。");
    onProgress?.({ phase: "done", threadId, promptPreview: preview, sentAt, note: "最終応答の取得完了" });
    return message.text;
  }

  waitForTurn(threadId) {
    return new Promise((resolve) => {
      const listener = (message) => {
        if (message.method === "turn/completed" && message.params?.threadId === threadId) {
          this.rpc.removeListener(listener);
          resolve(message.params);
        }
      };
      this.rpc.addListener(listener);
    });
  }

  async close() {
    await this.rpc.close();
  }
}

class CopilotAppServerClient {
  static async create(config) {
    const copilot = config.runtime?.copilot || {};
    let rpc;
    if ((copilot.transport || "tcp") === "stdio") {
      const command = copilot.command || await resolveCopilotCommand();
      const args = Array.isArray(copilot.args) && copilot.args.length ? copilot.args : ["--acp", "--stdio"];
      rpc = await StdioRpcClient.create(config, command, args, {
        cwd: copilot.cwd || process.cwd(),
        env: copilot.env || undefined,
        eventLogName: "copilot-events.log",
        providerLabel: "copilot"
      });
    } else {
      rpc = await TcpRpcClient.create(config, copilot.host || "127.0.0.1", Number(copilot.port || 8765), {
        eventLogName: "copilot-events.log",
        providerLabel: "copilot"
      });
    }
    const client = new CopilotAppServerClient(rpc, config);
    await client.initialize();
    return client;
  }

  constructor(rpc, config) {
    this.rpc = rpc;
    this.config = config;
    this.providerSessionId = null;
    this.rpc.setRequestHandler((message) => this.handleRequest(message));
  }

  async initialize() {
    await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "nikki", version: "0.2.0" }
    });
    const started = await this.rpc.request("session/new", {
      cwd: process.cwd(),
      mcpServers: []
    });
    this.providerSessionId = started.sessionId || "nikki";
  }

  async runJsonTurn({ model, cwd, prompt, onProgress }) {
    if (!this.providerSessionId) {
      throw new Error("copilot session is not initialized");
    }
    const preview = clip(prompt.replace(/\s+/g, " "), 220);
    const sentAt = isoJst();
    let accumulated = "";
    const listener = (message) => {
      this.rpc.log({ method: message.method });
      if (message.method === "session/update" && message.params?.sessionId === this.providerSessionId) {
        const update = message.params.update || {};
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
          accumulated += String(update.content.text || "");
        }
      }
      const mapped = progressFromNotification("copilot", message);
      if (mapped) onProgress?.({ promptPreview: preview, sentAt, ...mapped });
    };
    this.rpc.addListener(listener);
    onProgress?.({ phase: "turn-start", promptPreview: preview, sentAt, note: "Copilot にプロンプト送信中" });
    const result = await this.rpc.request("session/prompt", {
      sessionId: this.providerSessionId,
      prompt: [{ type: "text", text: prompt }],
      _meta: { cwd, model: model || this.config.model }
    });
    onProgress?.({ phase: "waiting", promptPreview: preview, sentAt, note: "Copilot 応答を待機中" });
    this.rpc.removeListener(listener);
    const text = accumulated;
    if (!text) {
      throw new Error("copilot から最終応答を取得できませんでした。");
    }
    if (result.stopReason && result.stopReason !== "end_turn") {
      this.rpc.log({ method: "session/prompt", stopReason: result.stopReason });
    }
    onProgress?.({ phase: "done", promptPreview: preview, sentAt, note: "最終応答の取得完了" });
    return text;
  }

  async handleRequest(message) {
    if (message.method === "session/request_permission") {
      return { outcome: { outcome: "cancelled" } };
    }
    throw new Error(`unsupported ACP client request: ${message.method}`);
  }

  async close() {
    await this.rpc.close();
  }
}

class OllamaClient {
  static async create(config) {
    return new OllamaClient(config);
  }

  constructor(config) {
    this.config = config;
    this.ollama = config.runtime?.ollama || {};
    this.baseUrl = String(this.ollama.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.eventLogPath = path.join(config.outputDir, "logs", "ollama-events.log");
    this.command = String(this.ollama.command || "ollama");
    this.activeModel = null;
    this.waitForIdleModelAfterError = null;
  }

  async runJsonTurn({ model, think, cwd, prompt, onProgress }) {
    const preview = clip(prompt.replace(/\s+/g, " "), 220);
    const sentAt = isoJst();
    const finalModel = model || this.config.model;
    await this.waitForPreviousErrorModelIdle(finalModel, onProgress, preview, sentAt);
    await this.ensureModelReady(finalModel, onProgress, preview, sentAt);
    const systemPrompt = getOllamaSystemPrompt(this.config);
    const body = {
      model: finalModel,
      system: systemPrompt,
      prompt,
      stream: true
    };

    if (this.ollama.keepAlive) {
      body.keep_alive = this.ollama.keepAlive;
    }
    if (typeof think === "boolean") {
      body.think = think;
    } else if (typeof this.ollama.think === "boolean") {
      body.think = this.ollama.think;
    }
    if (this.ollama.options && typeof this.ollama.options === "object" && !Array.isArray(this.ollama.options)) {
      body.options = this.ollama.options;
    }

    const promptStats = buildPromptStats({ prompt, systemPrompt });
    onProgress?.({ phase: "system", promptPreview: preview, promptStats, sentAt, note: "Ollama system prompt を送信します", systemPrompt });
    onProgress?.({ phase: "turn-start", promptPreview: preview, promptStats, sentAt, note: "Ollama にプロンプト送信中" });
    this.log({ phase: "request", model: finalModel, cwd, promptPreview: preview, promptStats, think: typeof body.think === "boolean" ? body.think : null });

    const url = `${this.baseUrl}/api/generate`;
    const timeoutMs = Number(this.ollama.requestTimeoutMs || 0);
    const headersTimeoutMs = Number(this.ollama.headersTimeoutMs || 0);
    const bodyTimeoutMs = Number(this.ollama.bodyTimeoutMs || 0);
    const fetchOptions = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...normalizeHeaders(this.ollama.headers)
      },
      body: JSON.stringify(body)
    };
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    }

    let output = "";
    let usage = null;
    try {
      const response = await requestOllamaStream(url, {
        method: fetchOptions.method,
        headers: fetchOptions.headers,
        body: fetchOptions.body,
        signal: fetchOptions.signal,
        headersTimeoutMs,
        bodyTimeoutMs
      });

      if (!response.ok) {
        const text = await response.text();
        this.log({ phase: "response", status: response.status, ok: response.ok, preview: clip(text, 500) });
        throw new Error(extractOllamaErrorMessage(response.status, text));
      }
      onProgress?.({ phase: "waiting", promptPreview: preview, sentAt, note: "Ollama 応答を待機中" });
      const streamed = await readOllamaStream(response, { preview, sentAt, onProgress, log: (entry) => this.log(entry) });
      output = streamed.output;
      usage = streamed.usage;
      const thinkingText = streamed.thinking;
      if (!output) {
        throw new Error("Ollama から最終応答を取得できませんでした。");
      }
    } catch (error) {
      const normalizedError = normalizeOllamaFetchError(error, { url, model: finalModel, timeoutMs, headersTimeoutMs, bodyTimeoutMs });
      this.log({
        phase: "transport-error",
        model: finalModel,
        url,
        timeoutMs: timeoutMs || null,
        headersTimeoutMs: headersTimeoutMs || null,
        bodyTimeoutMs: bodyTimeoutMs || null,
        error: String(normalizedError.message || normalizedError)
      });
      if (shouldWaitForOllamaIdleAfterError(normalizedError)) {
        this.waitForIdleModelAfterError = finalModel;
        this.log({ phase: "model-idle-wait-scheduled", model: finalModel, reason: String(normalizedError.message || normalizedError) });
      }
      throw normalizedError;
    }

    onProgress?.({ phase: "done", promptPreview: preview, sentAt, note: "最終応答の取得完了" });
    this.activeModel = finalModel;
    return { text: output, usage };
  }

  async close() {}

  async waitForPreviousErrorModelIdle(nextModel, onProgress, preview, sentAt) {
    const model = this.waitForIdleModelAfterError;
    if (!model || !nextModel || model !== nextModel) {
      return;
    }
    const maxWaitMs = Number(this.ollama.waitForModelIdleAfterErrorMs || 30 * 60 * 1000);
    const pollMs = Number(this.ollama.waitForModelIdlePollMs || 10000);
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      attempt += 1;
      const loaded = await this.listLoadedModels();
      if (!loaded.includes(model)) {
        this.waitForIdleModelAfterError = null;
        const note = `前回エラー後の ${model} アンロードを確認しました`;
        onProgress?.({ phase: "ollama-idle", promptPreview: preview, sentAt, note });
        this.log({ phase: "model-idle-confirmed", model, attempts: attempt, waitedMs: Date.now() - startedAt });
        return;
      }
      const note = `前回エラー後も ${model} がロード中のため、新規リクエストを待機します (${formatDuration(Date.now() - startedAt)}/${formatDuration(maxWaitMs)})`;
      onProgress?.({ phase: "ollama-busy-wait", promptPreview: preview, sentAt, note });
      this.log({ phase: "model-idle-wait", model, attempt, waitedMs: Date.now() - startedAt });
      await sleep(pollMs);
    }
    const message = `前回エラー後も ${model} がアンロードされないため、新規リクエストを中止しました (wait=${maxWaitMs}ms)`;
    this.log({ phase: "model-idle-wait-timeout", model, waitedMs: Date.now() - startedAt });
    throw new Error(message);
  }

  async ensureModelReady(nextModel, onProgress, preview, sentAt) {
    if (!nextModel || !this.activeModel || this.activeModel === nextModel) {
      return;
    }
    const oldModel = this.activeModel;
    const note = `モデル切替のため ${oldModel} をアンロードします`;
    onProgress?.({ phase: "model-switch", promptPreview: preview, sentAt, note });
    this.log({ phase: "model-switch", from: oldModel, to: nextModel });
    await this.stopModel(oldModel);
    await this.waitForModelUnload(oldModel);
  }

  async stopModel(model) {
    try {
      await execFileAsync(this.command, ["stop", model], { windowsHide: true });
      this.log({ phase: "model-stop", model, status: "ok" });
    } catch (error) {
      this.log({ phase: "model-stop", model, status: "failed", error: String(error instanceof Error ? error.message : error) });
    }
  }

  async waitForModelUnload(model) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const loaded = await this.listLoadedModels();
      if (!loaded.includes(model)) {
        this.log({ phase: "model-unloaded", model, attempts: attempt + 1 });
        return;
      }
      await sleep(500);
    }
    this.log({ phase: "model-unload-timeout", model });
  }

  async listLoadedModels() {
    try {
      const { stdout } = await execFileAsync(this.command, ["ps"], { windowsHide: true, maxBuffer: 1024 * 1024 });
      return parseOllamaPsModels(stdout);
    } catch (error) {
      this.log({ phase: "model-ps", status: "failed", error: String(error instanceof Error ? error.message : error) });
      return [];
    }
  }

  log(entry) {
    ensureDir(path.dirname(this.eventLogPath));
    fs.appendFileSync(this.eventLogPath, `${JSON.stringify({ at: isoJst(), provider: "ollama", ...entry })}\n`, "utf8");
  }
}

export function getOllamaSystemPrompt(config) {
  return config?.runtime?.ollama?.system || [
    "常に日本語で応答してください。",
    "Respond in Japanese.",
    "Return exactly one JSON object.",
    "Do not output markdown.",
    "Do not output code fences.",
    "Do not output explanations.",
    "Do not output any text before or after JSON."
  ].join("\n");
}

function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
      .map(([key, entry]) => [key, String(entry)])
  );
}

function extractOllamaErrorMessage(status, text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) {
      return `Ollama error (${status}): ${parsed.error}`;
    }
  } catch {}
  return `Ollama error (${status}): ${clip(text || "unknown error", 400)}`;
}

async function requestOllamaStream(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const headers = options.headers || {};
  const headersTimeoutMs = Number(options.headersTimeoutMs || 0);
  const bodyTimeoutMs = Number(options.bodyTimeoutMs || 0);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let headersTimer = null;
    const request = transport.request(target, {
      method: options.method || "POST",
      headers
    });

    const cleanup = () => {
      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = null;
      }
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (response) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };

    const abortHandler = () => {
      const abortError = new Error("The operation was aborted due to timeout");
      abortError.name = "TimeoutError";
      request.destroy(abortError);
      fail(abortError);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    if (headersTimeoutMs > 0) {
      headersTimer = setTimeout(() => {
        const timeoutError = new Error("Headers Timeout Error");
        timeoutError.code = "UND_ERR_HEADERS_TIMEOUT";
        request.destroy(timeoutError);
        fail(timeoutError);
      }, headersTimeoutMs);
    }

    request.on("response", (incoming) => {
      if (bodyTimeoutMs > 0) {
        incoming.setTimeout(bodyTimeoutMs, () => {
          const timeoutError = new Error("Body Timeout Error");
          timeoutError.code = "UND_ERR_BODY_TIMEOUT";
          incoming.destroy(timeoutError);
        });
      }
      const response = new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode || 0,
        statusText: incoming.statusMessage || "",
        headers: incoming.headers
      });
      succeed(response);
    });

    request.on("error", (error) => {
      fail(error);
    });

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function normalizeOllamaFetchError(error, context = {}) {
  if (error instanceof Error && /^Ollama error \(\d+\):/i.test(error.message)) {
    return error;
  }
  const cause = error && typeof error === "object" ? error.cause : null;
  const timeoutMs = Number(context.timeoutMs || 0);
  const headersTimeoutMs = Number(context.headersTimeoutMs || 0);
  const bodyTimeoutMs = Number(context.bodyTimeoutMs || 0);
  const url = context.url || "Ollama";
  const model = context.model ? ` model=${context.model}` : "";
  const causeCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code || "").trim() : "";
  const causeMessage = cause instanceof Error ? cause.message : (cause && typeof cause === "object" && "message" in cause ? String(cause.message || "") : "");
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  const detail = [causeCode, causeMessage, rawMessage]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => value && values.indexOf(value) === index && value.toLowerCase() !== "fetch failed")
    .join(" / ");

  if (isOllamaTimeoutFailure({ rawMessage, causeCode, causeMessage, errorName: error?.name, causeName: cause?.name, detail })) {
    const timeoutParts = [
      timeoutMs > 0 ? `timeout=${timeoutMs}ms` : "",
      headersTimeoutMs > 0 ? `headersTimeout=${headersTimeoutMs}ms` : "",
      bodyTimeoutMs > 0 ? `bodyTimeout=${bodyTimeoutMs}ms` : ""
    ].filter(Boolean).join(" ");
    return new Error(`Ollama 応答がタイムアウトしました: ${url}${model}${timeoutParts ? ` ${timeoutParts}` : ""}${detail ? ` (${detail})` : ""}`);
  }
  if (/fetch failed/i.test(rawMessage) || /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_/i.test(detail)) {
    return new Error(`Ollama への接続に失敗しました: ${url}${model}${detail ? ` (${detail})` : ""}`);
  }
  return error instanceof Error ? error : new Error(rawMessage || "Ollama への接続に失敗しました。");
}

function isOllamaTimeoutFailure({ rawMessage, causeCode, causeMessage, errorName, causeName, detail }) {
  const text = [rawMessage, causeCode, causeMessage, errorName, causeName, detail]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
  return /The operation was aborted due to timeout|TimeoutError|UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error|UND_ERR_BODY_TIMEOUT|Body Timeout Error|ETIMEDOUT/i.test(text);
}

function shouldWaitForOllamaIdleAfterError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Ollama 応答がタイムアウトしました|Ollama への接続に失敗しました|UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error|UND_ERR_BODY_TIMEOUT|Body Timeout Error|fetch failed|ECONNRESET|socket hang up/i.test(message);
}

function parseOllamaPsModels(text) {
  return String(text || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s{2,}/)[0]?.trim())
    .filter(Boolean);
}

async function readOllamaStream(response, context) {
  if (!response.body) {
    throw new Error("Ollama のストリームを取得できませんでした。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let thinking = "";
  let sawDone = false;
  let responseLineBuffer = "";
  let recentResponseLines = [];
  let recentResponseLastSemanticLine = "";
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const chunk = parseOllamaStreamChunk(line);
          sawDone ||= Boolean(chunk.done);
          usage = extractOllamaUsage(chunk) || usage;
          const thinkingChunk = typeof chunk.thinking === "string"
          ? chunk.thinking
          : typeof chunk.message?.thinking === "string"
            ? chunk.message.thinking
            : "";
        const responseChunk = typeof chunk.response === "string"
          ? chunk.response
          : typeof chunk.message?.content === "string"
            ? chunk.message.content
            : "";
        if (thinkingChunk) {
          thinking += thinkingChunk;
          context.log({ phase: "thinking-chunk", preview: clip(thinkingChunk, 200) });
          context.onProgress?.({ phase: "thinking", promptPreview: context.preview, sentAt: context.sentAt, note: `thinking: ${clip(thinkingChunk, 80)}`, thinkingText: thinkingChunk });
        }
        if (responseChunk) {
          output += responseChunk;
          const repetition = detectRepeatedResponseLine(responseChunk, {
            lineBuffer: responseLineBuffer,
            recentLines: recentResponseLines,
            lastSemanticLine: recentResponseLastSemanticLine
          });
          responseLineBuffer = repetition.lineBuffer;
          recentResponseLines = repetition.recentLines;
          recentResponseLastSemanticLine = repetition.lastSemanticLine;
          if (repetition.abort) {
            context.log({ phase: "response-loop-detected", line: repetition.repeatedLine, count: repetition.repeatedLineCount });
            try {
              await reader.cancel("repeated response line detected");
            } catch {}
            throw new Error(`Ollama 応答が同一行を繰り返したため中断しました: ${clip(repetition.repeatedLine || "", 120)} (count=${repetition.repeatedLineCount})`);
          }
          context.log({ phase: "response-chunk", preview: clip(responseChunk, 200) });
          context.onProgress?.({ phase: "agent-message", promptPreview: context.preview, sentAt: context.sentAt, note: `応答生成中: ${clip(responseChunk, 80)}`, deltaText: responseChunk });
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const chunk = parseOllamaStreamChunk(tail);
    sawDone ||= Boolean(chunk.done);
    usage = extractOllamaUsage(chunk) || usage;
    const thinkingChunk = typeof chunk.thinking === "string"
      ? chunk.thinking
      : typeof chunk.message?.thinking === "string"
        ? chunk.message.thinking
        : "";
    const responseChunk = typeof chunk.response === "string"
      ? chunk.response
      : typeof chunk.message?.content === "string"
        ? chunk.message.content
        : "";
    if (thinkingChunk) {
      thinking += thinkingChunk;
      context.log({ phase: "thinking-chunk", preview: clip(thinkingChunk, 200) });
      context.onProgress?.({ phase: "thinking", promptPreview: context.preview, sentAt: context.sentAt, note: `thinking: ${clip(thinkingChunk, 80)}`, thinkingText: thinkingChunk });
    }
    if (responseChunk) {
      output += responseChunk;
      const repetition = detectRepeatedResponseLine(responseChunk, {
        lineBuffer: responseLineBuffer,
        recentLines: recentResponseLines,
        lastSemanticLine: recentResponseLastSemanticLine
      });
      responseLineBuffer = repetition.lineBuffer;
      recentResponseLines = repetition.recentLines;
      recentResponseLastSemanticLine = repetition.lastSemanticLine;
      if (repetition.abort) {
        context.log({ phase: "response-loop-detected", line: repetition.repeatedLine, count: repetition.repeatedLineCount });
        try {
          await reader.cancel("repeated response line detected");
        } catch {}
        throw new Error(`Ollama 応答が同一行を繰り返したため中断しました: ${clip(repetition.repeatedLine || "", 120)} (count=${repetition.repeatedLineCount})`);
      }
      context.log({ phase: "response-chunk", preview: clip(responseChunk, 200) });
      context.onProgress?.({ phase: "agent-message", promptPreview: context.preview, sentAt: context.sentAt, note: `応答生成中: ${clip(responseChunk, 80)}`, deltaText: responseChunk });
    }
  }

  context.log({ phase: "response", ok: true, done: sawDone, preview: clip(output, 500), usage });
  if (thinking) {
    context.log({ phase: "thinking", preview: clip(thinking, 500) });
  }
  return { output, thinking, done: sawDone, usage };
}

function extractOllamaUsage(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const inputTokens = toFiniteNumber(chunk.prompt_eval_count);
  const outputTokens = toFiniteNumber(chunk.eval_count);
  const usage = {
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(inputTokens !== null || outputTokens !== null ? { totalTokens: (inputTokens || 0) + (outputTokens || 0) } : {}),
    ...durationNsToMsField("totalDurationMs", chunk.total_duration),
    ...durationNsToMsField("loadDurationMs", chunk.load_duration),
    ...durationNsToMsField("promptEvalDurationMs", chunk.prompt_eval_duration),
    ...durationNsToMsField("evalDurationMs", chunk.eval_duration)
  };
  const promptEvalCount = toFiniteNumber(chunk.prompt_eval_count);
  const evalCount = toFiniteNumber(chunk.eval_count);
  if (promptEvalCount !== null) usage.promptEvalCount = promptEvalCount;
  if (evalCount !== null) usage.evalCount = evalCount;
  return Object.keys(usage).length ? usage : null;
}

function durationNsToMsField(key, value) {
  const number = toFiniteNumber(value);
  return number === null ? {} : { [key]: Math.round(number / 1000000) };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function detectRepeatedResponseLine(chunk, state) {
  let lineBuffer = `${state.lineBuffer || ""}${String(chunk || "")}`;
  let recentLines = Array.isArray(state.recentLines) ? [...state.recentLines] : [];
  let lastSemanticLine = state.lastSemanticLine || "";

  while (true) {
    const newlineIndex = lineBuffer.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    const rawLine = lineBuffer.slice(0, newlineIndex);
    lineBuffer = lineBuffer.slice(newlineIndex + 1);
    const normalized = rawLine.trim();
    if (!normalized || normalized.length <= 2) {
      continue;
    }
    const semanticKey = repeatedLineSemanticKey(normalized, lastSemanticLine);
    lastSemanticLine = semanticHistoryLine(normalized) || lastSemanticLine;
    if (!semanticKey) {
      continue;
    }
    recentLines.push(semanticKey);
    if (recentLines.length > 100) {
      recentLines = recentLines.slice(recentLines.length - 100);
    }
    const repeatedLineCount = recentLines.filter((line) => line === semanticKey).length;
    if (repeatedLineCount >= 10) {
      return { lineBuffer, recentLines, lastSemanticLine, repeatedLine: normalized, repeatedLineCount, abort: true };
    }
  }

  return { lineBuffer, recentLines, lastSemanticLine, repeatedLine: null, repeatedLineCount: 0, abort: false };
}

function repeatedLineSemanticKey(line, previousSemanticLine) {
  if (isRepeatedStatusLine(line)) {
    if (isRepeatedTextLine(previousSemanticLine)) {
      return `${previousSemanticLine}\n${line}`;
    }
    return null;
  }
  return line;
}

function semanticHistoryLine(line) {
  return isRepeatedTextLine(line) ? line : null;
}

function isRepeatedTextLine(line) {
  return /^"text"\s*:\s*".*"?\s*,?$/.test(String(line || "").trim());
}

function isRepeatedStatusLine(line) {
  return /^"status"\s*:\s*"(resolved|unresolved|partially_resolved)"\s*,?$/.test(String(line || "").trim());
}

function parseOllamaStreamChunk(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Ollama のストリーム JSON を解析できませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function progressFromNotification(provider, message) {
  if (provider === "copilot") {
    if (message.method === "session/request_permission") return { phase: "approval", note: "Copilot が承認要求を通知" };
    if (message.method === "session/update") {
      const update = message.params?.update || {};
      if (update.sessionUpdate === "agent_message_chunk") return { phase: "agent-message", note: `応答生成中: ${clip(update.content?.text || "", 80)}` };
      if (update.sessionUpdate === "agent_thought_chunk") return { phase: "reasoning", note: `reasoning: ${clip(update.content?.text || "", 80)}` };
      if (update.sessionUpdate === "tool_call") return { phase: "tool-called", note: `tool呼び出し: ${update.title || update.kind || "unknown"}` };
      if (update.sessionUpdate === "tool_call_update") return { phase: "tool-update", note: `tool更新: ${update.title || update.status || "unknown"}` };
      if (update.sessionUpdate === "plan") return { phase: "plan", note: "実行計画を更新中" };
      if (update.sessionUpdate === "current_mode_update") return { phase: "session-updated", note: `mode更新: ${update.currentModeId || "unknown"}` };
      if (update.sessionUpdate === "session_info_update") return { phase: "session-updated", note: `session更新: ${update.title || "info"}` };
    }
    return null;
  }
  if (message.method === "turn/started") return { phase: "turn-started", note: "app-server がターン開始を通知" };
  if (message.method === "item/started") return { phase: "item-started", note: `item開始: ${message.params?.item?.type || "unknown"}` };
  if (message.method === "item/completed") return { phase: "item-completed", note: `item完了: ${message.params?.item?.type || "unknown"}` };
  if (message.method === "item/reasoning/summaryTextDelta") return { phase: "reasoning", note: `reasoning: ${clip(message.params?.delta || "", 80)}` };
  if (message.method === "item/agentMessage/delta") return { phase: "agent-message", note: `応答生成中: ${clip(message.params?.delta || "", 80)}` };
  if (message.method === "turn/completed") return { phase: "turn-completed", note: "app-server がターン完了を通知" };
  return null;
}
