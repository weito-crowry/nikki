import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let aiJsonDeps = null;

export function configureAiJson(deps) {
  aiJsonDeps = deps;
}

function deps() {
  if (!aiJsonDeps) {
    throw new Error('ai-json is not configured');
  }
  return aiJsonDeps;
}

function ensureDir(...args) { return deps().ensureDir(...args); }
function readJson(...args) { return deps().readJson(...args); }
function writeJson(...args) { return deps().writeJson(...args); }
function getAppServerClient(...args) { return deps().getAppServerClient(...args); }
function emitEvent(...args) { return deps().emitEvent(...args); }
function writeProgress(...args) { return deps().writeProgress(...args); }
function logTextBlock(...args) { return deps().logTextBlock(...args); }
function getOllamaSystemPrompt(...args) { return deps().getOllamaSystemPrompt(...args); }
function logThinkingConsole(...args) { return deps().logThinkingConsole(...args); }
function logResponseDeltaConsole(...args) { return deps().logResponseDeltaConsole(...args); }
function logTaskProgressConsole(...args) { return deps().logTaskProgressConsole(...args); }
function flushResponseDeltaConsole(...args) { return deps().flushResponseDeltaConsole(...args); }
function normalizeAiUsage(...args) { return deps().normalizeAiUsage(...args); }
function isoJst(...args) { return deps().isoJst(...args); }
function clip(...args) { return deps().clip(...args); }
function sleep(...args) { return deps().sleep(...args); }
function logConsole(...args) { return deps().logConsole(...args); }
function writeArtifact(...args) { return deps().writeArtifact(...args); }

function aiCacheKey(taskKey, meta) {
  return crypto.createHash("sha256").update(JSON.stringify({ taskKey, model: meta.model, think: meta.think ?? null, inputHash: meta.inputHash, promptHash: meta.promptHash, taskVersion: 1, outputSchemaVersion: 1 })).digest("hex");
}

export async function askForJson(runtime, taskKey, itemId, name, meta) {
  const dir = path.join(runtime.paths.root, ".codex-temp");
  ensureDir(dir);
  const cacheKey = aiCacheKey(taskKey, meta);
  const cachePath = path.join(runtime.paths.cache, `${cacheKey}.json`);
  const cached = readJson(cachePath);
  if (cached?.text) {
    emitEvent(runtime, { type: "task.cache_hit", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note: "AI cache を再利用しました" });
    writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: meta.promptPreview, sentAt: cached.cachedAt || null, note: "AI cache を再利用しました", lastEvent: "task.cache_hit" });
    return { text: cached.text, parsed: cached.parsed, usage: cached.usage || null, cacheHit: true };
  }
  const client = await getAppServerClient(runtime.config);
  const maxParseAttempts = Number(runtime.config.jsonRetryAttempts || 2);
  for (let parseAttempt = 1; parseAttempt <= maxParseAttempts; parseAttempt += 1) {
    const prompt = parseAttempt === 1 ? meta.prompt : buildJsonRepairPrompt(meta.prompt);
    const promptPath = path.join(dir, `${name.replace(/[^a-zA-Z0-9-_]/g, "_")}${parseAttempt > 1 ? `__retry${parseAttempt}` : ""}.prompt.txt`);
    fs.writeFileSync(promptPath, ["あなたは JSON のみを返す情報整理アシスタントです。", "前置き、説明、コードブロックは禁止です。", "コマンド実行、ファイル変更、ツール使用は禁止です。", "必ず単一の JSON オブジェクトだけを返してください。", "", prompt].join("\n"), "utf8");
    if (runtime.config.provider === "ollama") {
      logTextBlock("system", `${taskKey}__${itemId}${parseAttempt > 1 ? ` retry=${parseAttempt}` : ""}`, getOllamaSystemPrompt(runtime.config));
    }
    logTextBlock("prompt", `${taskKey}__${itemId}${parseAttempt > 1 ? ` retry=${parseAttempt}` : ""}`, prompt);
    const aiResult = await runAiWithRetry(runtime, taskKey, itemId, async () => client.runJsonTurn({
      model: meta.model,
      think: meta.think,
      cwd: process.cwd(),
      prompt,
      onProgress: (event) => {
        runtime.current.sentAt = event.sentAt || runtime.current.sentAt;
        runtime.current.promptStats = event.promptStats || runtime.current.promptStats;
        if (event.phase === "thinking" && event.thinkingText) {
          logThinkingConsole(taskKey, itemId, event.thinkingText);
        }
        if (event.phase === "agent-message" && event.deltaText) {
          logResponseDeltaConsole(taskKey, itemId, event.deltaText);
        }
        if (event.phase === "turn-start") {
          logTaskProgressConsole(runtime);
        }
        writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: event.promptPreview || runtime.current.promptPreview, promptStats: event.promptStats || runtime.current.promptStats, sentAt: event.sentAt || runtime.current.sentAt, note: event.note || null, lastEvent: `ai.${event.phase || "progress"}` });
      }
    })).catch((error) => {
      throw normalizeAiFailure(error);
    });
    const text = typeof aiResult === "string" ? aiResult : String(aiResult?.text || "");
    const usage = typeof aiResult === "string" ? null : normalizeAiUsage(aiResult?.usage);
    flushResponseDeltaConsole(taskKey, itemId);
    logTextBlock("response", `${taskKey}__${itemId}${parseAttempt > 1 ? ` retry=${parseAttempt}` : ""}`, text);
    writeRaw(runtime, taskKey, itemId, text, usage);
    const parsedResult = parseAiJsonResponse(text);
    if (parsedResult.parsed) {
      if (usage) {
        emitEvent(runtime, { type: "task.ai_usage", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, usage });
      }
      writeJson(cachePath, { schemaVersion: 1, cachedAt: isoJst(), taskKey, itemId, model: meta.model, think: meta.think, inputHash: meta.inputHash, promptHash: meta.promptHash, text, parsed: parsedResult.parsed, usage });
      return { text, parsed: parsedResult.parsed, usage, cacheHit: false };
    }
    writeParseError(runtime, taskKey, itemId, {
      parseAttempt,
      model: meta.model,
      think: meta.think,
      promptHash: meta.promptHash,
      inputHash: meta.inputHash,
      usage,
      ...parsedResult
    });
    emitEvent(runtime, { type: "task.json_parse_error", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note: `JSON 解析に失敗しました (attempt=${parseAttempt})` });
    if (parseAttempt < maxParseAttempts) {
      const note = `JSON 形式エラーのため、より厳しい JSON 指示で再実行します (${parseAttempt}/${maxParseAttempts})`;
      emitEvent(runtime, { type: "task.retry_scheduled", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note });
      logConsole("retry", runtime.current.taskInstanceId, note);
      writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: runtime.current.promptPreview, sentAt: runtime.current.sentAt, note, lastEvent: "task.retry_scheduled" });
      continue;
    }
    if (/prompt token count .* exceeds the limit/i.test(parsedResult.normalized || "")) {
      throw new Error(`AI プロンプトが長すぎます: ${clip(parsedResult.normalized, 220)}`);
    }
    throw new Error(`AI が JSON ではない応答を返しました: ${clip(parsedResult.normalized || text, 220)}`);
  }
  throw new Error("AI の JSON 応答を取得できませんでした。");
}

async function runAiWithRetry(runtime, taskKey, itemId, run) {
  const maxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await run();
      const text = typeof result === "string" ? result : String(result?.text || "");
      if (isRetryableAiText(text)) {
        throw new Error(text.trim());
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableAiFailure(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 30000);
      const diagnostics = await collectAiRetryDiagnostics(error);
      const note = `一時的な AI エラーのため ${delayMs}ms 後に再試行します (${attempt}/${maxAttempts}) 理由=${summarizeAiRetryError(error)}${diagnostics ? ` ${diagnostics}` : ""}`;
      emitEvent(runtime, { type: "task.retry_scheduled", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note });
      logConsole("retry", runtime.current.taskInstanceId, note);
      writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: runtime.current.promptPreview, sentAt: runtime.current.sentAt, note, lastEvent: "task.retry_scheduled" });
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("AI 呼び出しに失敗しました");
}

function normalizeAiFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (isQuotaExceededFailure(message)) {
    return new Error(`AI 利用枠が不足しています: quota 切れのため処理を継続できません。${extractRequestId(message) ? ` (${extractRequestId(message)})` : ""}`);
  }
  return error instanceof Error ? error : new Error(message);
}

function isQuotaExceededFailure(message) {
  return /\b402\b.*\bno quota\b/i.test(String(message || ""));
}

function extractRequestId(message) {
  const match = String(message || "").match(/Request ID:\s*([^)]+)/i);
  return match?.[1]?.trim() || null;
}

function isRetryableAiText(text) {
  const normalized = String(text || "").trim();
  return /^Error:/i.test(normalized) && /(429|rate limit|temporar|timeout|ECONNRESET|socket hang up|service unavailable|too many requests|invalid_request_body|fetch failed|internal error|-32603|同一行を繰り返したため中断しました)/i.test(normalized);
}

function isRetryableAiFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(429|rate limit|temporar|timeout|ECONNRESET|socket hang up|service unavailable|too many requests|invalid_request_body|fetch failed|internal error|-32603|同一行を繰り返したため中断しました)/i.test(message);
}

function summarizeAiRetryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "詳細不明";
  }
  if (/Ollama 応答がタイムアウトしました|UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error/i.test(normalized)) {
    return clip(normalized, 220);
  }
  if (/Ollama への接続に失敗しました|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(normalized)) {
    return clip(normalized, 220);
  }
  if (/同一行を繰り返したため中断しました/i.test(normalized)) {
    return clip(normalized, 220);
  }
  if (/invalid_request_body|internal error|-32603|service unavailable|too many requests|rate limit|429/i.test(normalized)) {
    return clip(normalized, 220);
  }
  return clip(normalized, 220);
}

async function collectAiRetryDiagnostics(error) {
  if (!isOllamaTimeoutRetryError(error)) {
    return "";
  }
  return formatOllamaCpuSnapshot(await sampleOllamaCpuUsage());
}

function isOllamaTimeoutRetryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Ollama 応答がタイムアウトしました|UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error|UND_ERR_BODY_TIMEOUT|Body Timeout Error/i.test(message);
}

async function sampleOllamaCpuUsage() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors",
    "$p1 = Get-Process -Name ollama -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, CPU",
    "Start-Sleep -Milliseconds 1000",
    "$p2 = Get-Process -Name ollama -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, CPU, WorkingSet64",
    "$result = @()",
    "foreach ($b in $p2) {",
    "  $a = $p1 | Where-Object { $_.Id -eq $b.Id } | Select-Object -First 1",
    "  $delta = $null",
    "  if ($a -and $null -ne $a.CPU -and $null -ne $b.CPU) { $delta = $b.CPU - $a.CPU }",
    "  $cpu = $null",
    "  if ($null -ne $delta -and $cores) { $cpu = [math]::Round(($delta / 1.0 / $cores) * 100, 1) }",
    "  $mem = $null",
    "  if ($null -ne $b.WorkingSet64) { $mem = [math]::Round($b.WorkingSet64 / 1MB, 1) }",
    "  $result += [pscustomobject]@{ pid = $b.Id; name = $b.ProcessName; cpuPercent = $cpu; workingSetMB = $mem }",
    "}",
    "$result | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const text = String(stdout || "").trim();
    if (!text) {
      return [];
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

function formatOllamaCpuSnapshot(snapshot) {
  if (snapshot === null) {
    return "ollamaCpu=取得失敗";
  }
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return "ollamaCpu=processなし";
  }
  const details = snapshot
    .map((process) => {
      const pid = process?.pid ?? "-";
      const cpu = Number.isFinite(Number(process?.cpuPercent)) ? `${Number(process.cpuPercent).toFixed(1)}%` : "-";
      const mem = Number.isFinite(Number(process?.workingSetMB)) ? `${Number(process.workingSetMB).toFixed(1)}MB` : "-";
      return `pid=${pid} cpu=${cpu} mem=${mem}`;
    })
    .join("; ");
  return `ollamaCpu=${details}`;
}

export function isContextOverflowFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(prompt token count .* exceeds the limit|maximum context length|context length|too many tokens|token limit|input too long|request too large|exceeds the limit|AI プロンプトが長すぎます)/i.test(message);
}

function buildJsonRepairPrompt(prompt) {
  return [
    prompt,
    "",
    "追加の厳格ルール:",
    "- 必ず JSON 構文として正しい単一の JSON オブジェクトだけを返してください。",
    "- 説明文、Markdown、コードブロック、前置きは返さないでください。",
    "- キーは重複させないでください。",
    "- 配列やオブジェクトを途中で切らないでください。",
    "- 文字列値の中に生の改行を入れないでください。",
    "- スキーマは上の指示に厳密に従ってください。"
  ].join("\n");
}

function recoverJsonObjectText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1).trim();
}

function recoverLastJsonFence(text) {
  const matches = [...String(text || "").matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
  if (!matches.length) {
    return null;
  }
  const last = matches[matches.length - 1]?.[1]?.trim();
  return last || null;
}

function parseAiJsonResponse(text) {
  const normalized = stripFence(String(text || "").trim());
  if (/^Error:/i.test(normalized)) {
    throw normalizeAiFailure(new Error(normalized));
  }
  try {
    return { parsed: JSON.parse(normalized), normalized, fenced: null, recovered: null, repaired: null };
  } catch {}
  const fenced = recoverLastJsonFence(normalized);
  if (fenced) {
    try {
      return { parsed: JSON.parse(fenced), normalized, fenced, recovered: null, repaired: null };
    } catch {}
  }
  const recovered = recoverJsonObjectText(normalized);
  if (recovered) {
    try {
      return { parsed: JSON.parse(recovered), normalized, fenced, recovered, repaired: null };
    } catch {}
  }
  const repaired = repairJsonText(recovered || normalized);
  if (repaired) {
    try {
      return { parsed: JSON.parse(repaired), normalized, fenced, recovered, repaired };
    } catch {}
  }
  return { parsed: null, normalized, fenced, recovered, repaired };
}

function repairJsonText(text) {
  if (!text) {
    return null;
  }
  text = String(text)
    .replaceAll("“", "\"")
    .replaceAll("”", "\"")
    .replaceAll("„", "\"")
    .replaceAll("‟", "\"")
    .replaceAll("「", "\"")
    .replaceAll("」", "\"")
    .replaceAll("’", "'")
    .replaceAll("‘", "'");
  text = text.replace(/\\\\",\\n\s+\\"(userIntent|assistantResponse|outcome)\\":/g, (_match, key) => `",\n  "${key}":`);
  text = text.replace(/\]\s*,\s*\[/g, ",");
  text = repairMalformedKeywordsField(text);
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (!escaped) {
        if (char === "\r") {
          continue;
        }
        if (char === "\n") {
          result += "\\n";
          continue;
        }
        if (char === "\t") {
          result += "\\t";
          continue;
        }
        if (char === "\b") {
          result += "\\b";
          continue;
        }
        if (char === "\f") {
          result += "\\f";
          continue;
        }
        if (isIllegalJsonControlChar(char)) {
          continue;
        }
        if (char === "\"") {
          if (isLikelyStringTerminator(text, index)) {
            result += char;
            inString = false;
            continue;
          }
          result += "\\\"";
          continue;
        }
      }
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }
    if (isIllegalJsonControlChar(char)) {
      continue;
    }
    if (char === "(" || char === ")") {
      continue;
    }
    result += char;
  }

  return result.trim() || null;
}

function isLikelyStringTerminator(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      continue;
    }
    return char === ":" || char === "," || char === "}" || char === "]";
  }
  return true;
}

function isIllegalJsonControlChar(char) {
  const code = String(char || "").charCodeAt(0);
  return Number.isFinite(code) && code >= 0x00 && code <= 0x1f && char !== "\r" && char !== "\n" && char !== "\t" && char !== "\b" && char !== "\f";
}

function repairMalformedKeywordsField(text) {
  let repaired = String(text);
  repaired = repaired.replace(/"keywords"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g, (_match, a, b, c, d) => `"keywords":["${a}","${b}","${c}","${d}"]`);
  repaired = repaired.replace(/"keywords"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g, (_match, a, b, c) => `"keywords":["${a}","${b}","${c}"]`);
  repaired = repaired.replace(/"keywords"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g, (_match, a, b) => `"keywords":["${a}","${b}"]`);
  return repaired;
}

function stripFence(text) { return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); }

export function writeRaw(runtime, taskKey, itemId, text, usage = null) {
  const normalizedUsage = normalizeAiUsage(usage);
  writeArtifact(runtime, `artifacts/raw/${taskKey}/${itemId}.raw.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    taskKey,
    itemId,
    rawText: text,
    ...(normalizedUsage ? { usage: normalizedUsage } : {})
  });
}
function writeParseError(runtime, taskKey, itemId, value) { writeArtifact(runtime, `artifacts/raw/${taskKey}/${itemId}.parse-error.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, taskKey, itemId, ...value }); }
