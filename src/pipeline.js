import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { TASK_DEFINITIONS } from "./task-definitions.js";
import { applyItemFilters, configureTaskState, getInvalidation, migrateReusableState, resolveDependsOn, reusable, validateRunOptions } from "./task-state.js";
import { buildTaskMeta, configureTaskMeta } from "./task-meta.js";
import { askForJson, configureAiJson, isContextOverflowFailure, writeRaw } from "./ai-json.js";
import { closeAppServerClient, configureAgentClient, getAppServerClient, getOllamaSystemPrompt, normalizeAgentRuntimeConfig, resolveRuntimeProvider } from "./agent-client.js";
import { buildArchiveStatsFromEntries, configureRenderHandlers, draftToMarkdown, handleRenderHtml, handleRenderMarkdown, handleRenderPdf } from "./render.js";
import { configureCategoryHelpers, defaultCategoryGroups, mergeCategoryMaster, normalizeCategoryGroups, normalizeCategoryMaster, normalizeProposedCategories, readCategoryMaster, writeCategoryMaster } from "./categories.js";
import { configureDeterministicHandlers, handleClassifyTurnDeterministic, handleMergeThreadTurnsDeterministic, handleRewriteEntryDeterministic, handleSummarizeTurnDeterministic, handleSummarizeUnitDeterministic, handleWriteEntryDeterministic, handleWriteMonthlySummaryDeterministic, handleWriteWeeklySummaryDeterministic, handleWriteYearlySummaryDeterministic } from "./deterministic.js";

const execFileAsync = promisify(execFile);
let appServerClientPromise = null;
let activeStreamConsoleKey = null;
let activeStreamConsoleLabel = null;
let activeStreamConsoleTrailingNewline = true;
const promptTemplateCache = new Map();

class GracefulStopError extends Error {
  constructor(message) {
    super(message);
    this.name = "GracefulStopError";
  }
}

export async function inspectZip(zipPath) {
  const lines = await listZipEntries(zipPath);
  return {
    zipPath,
    totalEntries: lines.length,
    conversationFiles: lines.filter((entry) => /^conversations-\d+\.json$/i.test(entry)).length,
    imageFiles: lines.filter((entry) => /\.(png|jpg|jpeg|webp)$/i.test(entry)).length,
    hasChatHtml: lines.includes("chat.html"),
    hasUserJson: lines.includes("user.json"),
    hasSharedConversations: lines.includes("shared_conversations.json")
  };
}

export async function runPipeline(inputConfig) {
  const runtime = createRuntime(inputConfig);
  acquireRunLock(runtime);
  initRun(runtime);
  const cleanupSignalHandlers = installGracefulStopHandlers(runtime);
  emitEvent(runtime, { type: "run.started", note: "run を開始しました" });
  writeProgress(runtime, { status: "running", note: "初期化完了", lastEvent: "run.started" });

  try {
    if (runtime.config.executionOrder === "date") {
      await runPipelineDateOrder(runtime);
    } else {
      await runPipelineTaskOrder(runtime);
    }
    emitEvent(runtime, { type: "run.completed", note: "完了" });
    writeProgress(runtime, { status: "completed", note: "完了", lastEvent: "run.completed", stage: null, taskKey: null, itemType: null, currentItemId: null, currentTaskInstanceId: null });
    console.log("\n完了");
  } catch (error) {
    if (error instanceof GracefulStopError) {
      emitEvent(runtime, { type: "run.stopped", note: error.message });
      writeProgress(runtime, {
        status: "stopped",
        note: error.message,
        lastEvent: "run.stopped",
        stage: null,
        taskKey: null,
        itemType: null,
        currentItemId: null,
        currentTaskInstanceId: null
      });
      console.log(`\n停止: ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    emitEvent(runtime, { type: "run.failed", note: message });
    writeProgress(runtime, { status: "failed", note: message, lastEvent: "run.failed" });
    throw error;
  } finally {
    cleanupSignalHandlers();
    await closeAppServerClient();
    releaseRunLock(runtime);
  }
}

async function runPipelineTaskOrder(runtime) {
  for (const definition of TASK_DEFINITIONS) {
    throwIfStopRequested(runtime);
    await executeDefinitionItems(runtime, definition);
  }
}

async function runPipelineDateOrder(runtime) {
  const originalDate = runtime.config.date || null;
  const initialTaskKeys = [
    "prepare.extract_export",
    "prepare.scan_export",
    "prepare.build_thread_index",
    "analyze.normalize_threads",
    "analyze.attach_images",
    "ai.generate_category_candidates"
  ];
  const dailyTaskKeys = [
    "analyze.split_thread_turns",
    "ai.summarize_turn",
    "ai.classify_turn",
    "ai.merge_thread_turns",
    "analyze.group_units",
    "ai.summarize_unit",
    "ai.write_diary_entry",
    "ai.rewrite_diary_entry"
  ];
  const archiveTaskKeys = [
    "ai.write_weekly_summary",
    "ai.write_monthly_summary",
    "ai.write_yearly_summary",
    "render.markdown",
    "render.html",
    "render.pdf"
  ];

  try {
    runtime.config.date = originalDate;
    for (const taskKey of initialTaskKeys) {
      throwIfStopRequested(runtime);
      await executeDefinitionItems(runtime, taskDefinitionByKey(taskKey));
    }

    const dates = originalDate ? [originalDate] : enumerateExecutionDates(runtime);
    for (const date of dates) {
      throwIfStopRequested(runtime);
      runtime.config.date = date;
      logConsole("date", date, "日付単位の処理を開始します");
      for (const taskKey of dailyTaskKeys) {
        throwIfStopRequested(runtime);
        await executeDefinitionItems(runtime, taskDefinitionByKey(taskKey));
      }
    }

    runtime.config.date = originalDate;
    for (const taskKey of archiveTaskKeys) {
      throwIfStopRequested(runtime);
      await executeDefinitionItems(runtime, taskDefinitionByKey(taskKey));
    }
  } finally {
    runtime.config.date = originalDate;
  }
}

async function executeDefinitionItems(runtime, definition) {
  if (!definition) {
    return;
  }
  const items = enumerateItems(runtime, definition.itemType);
  const runnableItems = registerPlanned(runtime, definition, items);
  for (const item of runnableItems) {
    throwIfStopRequested(runtime);
    await executeTask(runtime, definition, item);
    throwIfStopRequested(runtime);
  }
}

function taskDefinitionByKey(taskKey) {
  return TASK_DEFINITIONS.find((definition) => definition.taskKey === taskKey) || null;
}

function enumerateExecutionDates(runtime) {
  const dates = new Set();
  for (const thread of loadScopedThreadIndex(runtime)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(thread.primaryDate || ""))) {
      dates.add(thread.primaryDate);
    }
  }
  return [...dates].sort((left, right) => left.localeCompare(right, "ja"));
}

function createRuntime(config) {
  const runId = sanitizeId(config.runId || path.basename(config.outputDir || "run"));
  const now = isoJst();
  const provider = resolveConfiguredProvider(config.provider);
  const runtimeConfig = normalizeAgentRuntimeConfig(config, provider);
  return {
    config: { ...config, provider, runtime: runtimeConfig, runId, taskModels: config.taskModels || {} },
    paths: {
      root: config.outputDir,
      lock: path.join(config.outputDir, ".run.lock.json"),
      extracted: path.join(config.outputDir, "work", "extracted"),
      artifacts: path.join(config.outputDir, "artifacts"),
      state: path.join(config.outputDir, "task-state"),
      cache: path.join(config.outputDir, "cache", "ai"),
      logs: path.join(config.outputDir, "logs"),
      progress: path.join(config.outputDir, "progress.json"),
      events: path.join(config.outputDir, "events.jsonl")
    },
    startedAt: now,
    planned: new Set(),
    changed: new Set(),
    invalidated: new Set(),
    taskDurations: { started: new Map(), completedMsByTaskKey: new Map() },
    counts: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    current: { stage: null, taskKey: null, itemType: null, itemId: null, itemMeta: null, taskInstanceId: null, promptPreview: null, promptStats: null, sentAt: null, lastEvent: null, note: null },
    lock: null,
    stopRequested: false,
    stopReason: null
  };
}

function installGracefulStopHandlers(runtime) {
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      requestGracefulStop(runtime, "Ctrl+C により停止予約しました。現在の task 完了後に停止します。");
      return;
    }
    console.error("\nCtrl+C が再度押されたため即時終了します。");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  return () => {
    process.off("SIGINT", onSigint);
  };
}

function requestGracefulStop(runtime, reason) {
  if (runtime.stopRequested) {
    return;
  }
  runtime.stopRequested = true;
  runtime.stopReason = reason;
  emitEvent(runtime, { type: "run.stop_requested", note: reason });
  writeProgress(runtime, {
    status: "running",
    stage: runtime.current.stage,
    taskKey: runtime.current.taskKey,
    itemType: runtime.current.itemType,
    currentItemId: runtime.current.itemId,
    currentTaskInstanceId: runtime.current.taskInstanceId,
    promptPreview: runtime.current.promptPreview,
    sentAt: runtime.current.sentAt,
    note: reason,
    lastEvent: "run.stop_requested"
  });
  console.log(`\n停止予約: ${reason}`);
}

function throwIfStopRequested(runtime) {
  if (runtime.stopRequested) {
    throw new GracefulStopError(runtime.stopReason || "停止予約により処理を終了します。");
  }
}

function resolveConfiguredProvider(value) {
  if (value === "copilot") {
    return "copilot";
  }
  if (value === "ollama") {
    return "ollama";
  }
  return "codex";
}

function renderPromptTemplate(name, variables) {
  let template = promptTemplateCache.get(name);
  if (!template) {
    const filePath = path.join(process.cwd(), "prompts", `${name}.txt`);
    template = fs.readFileSync(filePath, "utf8");
    promptTemplateCache.set(name, template);
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables?.[key];
    return typeof value === "undefined" || value === null ? "" : String(value);
  });
}

function initRun(runtime) {
  ensureDir(runtime.paths.root);
  for (const relative of [
    "work/extracted",
    "artifacts/manifest",
      "artifacts/indexes",
      "artifacts/normalized",
      "artifacts/turns",
      "artifacts/ai/turn_summaries",
      "artifacts/ai/turn_classification",
      "artifacts/ai/thread_summaries",
      "artifacts/ai/thread_classification",
      "artifacts/ai/thread_findings",
    "artifacts/ai/unit_summaries",
    "artifacts/ai/diary_drafts",
    "artifacts/ai/diary_entries",
    "artifacts/ai/weekly_summaries",
    "artifacts/ai/monthly_summaries",
    "artifacts/ai/yearly_summaries",
      "artifacts/raw",
    "artifacts/units",
    "artifacts/render",
    "artifacts/render/weeks",
    "artifacts/render/months",
    "artifacts/render/years",
    "task-state",
    "cache/ai",
    "logs"
  ]) {
    ensureDir(path.join(runtime.paths.root, relative));
  }
  writeJson(path.join(runtime.paths.root, "run-config.json"), runtime.config);
  validateRunOptions(runtime);
}

function acquireRunLock(runtime) {
  ensureDir(runtime.paths.root);
  const existing = readJson(runtime.paths.lock);
  if (existing) {
    if (isStaleRunLock(existing)) {
      try {
        fs.unlinkSync(runtime.paths.lock);
      } catch {}
    }
  }
  const active = readJson(runtime.paths.lock);
  if (active) {
    const detail = [active.pid ? `pid=${active.pid}` : null, active.runId ? `runId=${active.runId}` : null, active.startedAt ? `startedAt=${active.startedAt}` : null].filter(Boolean).join(", ");
    throw new Error(`この outputDir は別 run が使用中です: ${runtime.paths.root}${detail ? ` (${detail})` : ""}`);
  }
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    runId: runtime.config.runId,
    outputDir: runtime.paths.root,
    startedAt: runtime.startedAt,
    command: process.argv.join(" ")
  };
  fs.writeFileSync(runtime.paths.lock, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
  runtime.lock = lock;
}

function releaseRunLock(runtime) {
  try {
    const current = readJson(runtime.paths.lock);
    if (!current) return;
    if (current.pid === process.pid && current.runId === runtime.config.runId) {
      fs.unlinkSync(runtime.paths.lock);
    }
  } catch {}
}

function isStaleRunLock(lock) {
  if (!lock || typeof lock !== "object") {
    return true;
  }
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  if (pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") {
        return true;
      }
      if (error.code === "EPERM") {
        return false;
      }
    }
    return false;
  }
}

function enumerateItems(runtime, itemType) {
  if (itemType === "run") {
    return [{ itemId: "run", meta: { itemId: "run" } }];
  }
  if (itemType === "thread") {
    return (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((meta) => ({ itemId: meta.itemId, meta }));
  }
  if (itemType === "turn") {
    return loadTurns(runtime).map((meta) => ({ itemId: meta.itemId, meta }));
  }
  if (itemType === "unit") {
    return (readArtifact(runtime, "artifacts/units/units.json")?.items || []).map((meta) => ({ itemId: meta.itemId, meta }));
  }
  if (itemType === "entry") {
    const map = new Map();
    for (const unit of readArtifact(runtime, "artifacts/units/units.json")?.items || []) {
      if (!unit.entryId) continue;
      if (!map.has(unit.entryId)) map.set(unit.entryId, { itemId: unit.entryId, meta: { itemId: unit.entryId, date: unit.date, unitItemIds: [], threadItemIds: [] } });
      map.get(unit.entryId).meta.unitItemIds.push(unit.itemId);
      for (const threadItemId of unit.threadItemIds || []) {
        if (!map.get(unit.entryId).meta.threadItemIds.includes(threadItemId)) {
          map.get(unit.entryId).meta.threadItemIds.push(threadItemId);
        }
      }
    }
    return [...map.values()];
  }
  if (itemType === "week") {
    return enumerateWeekItems(runtime);
  }
  if (itemType === "month") {
    return enumerateMonthItems(runtime);
  }
  if (itemType === "year") {
    return enumerateYearItems(runtime);
  }
  return [];
}

function registerPlanned(runtime, definition, items) {
  const filteredItems = applyItemFilters(runtime, definition, items);
  for (const item of filteredItems) runtime.planned.add(taskInstanceId(definition.taskKey, item.itemId));
  runtime.counts.total = runtime.planned.size;
  runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
  return filteredItems;
}

function recordTaskDuration(runtime, taskKey, instanceId) {
  const startedAt = runtime.taskDurations.started.get(instanceId);
  runtime.taskDurations.started.delete(instanceId);
  if (!startedAt) {
    return;
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  const values = runtime.taskDurations.completedMsByTaskKey.get(taskKey) || [];
  values.push(durationMs);
  if (values.length > 200) {
    values.splice(0, values.length - 200);
  }
  runtime.taskDurations.completedMsByTaskKey.set(taskKey, values);
}

async function executeTask(runtime, definition, item) {
  const instanceId = taskInstanceId(definition.taskKey, item.itemId);
  runtime.current = { stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, itemMeta: item.meta || null, taskInstanceId: instanceId, promptPreview: null, promptStats: null, sentAt: null, lastEvent: null, note: null };
  const meta = await buildTaskMeta(runtime, definition, item);
  const dependsOn = resolveDependsOn(runtime, definition.taskKey, item.itemId);
  let state = readState(runtime, definition.taskKey, item.itemId);
  const migration = migrateReusableState(runtime, definition, item, state, meta, dependsOn);
  if (migration) {
    state = migration.state;
    emitEvent(runtime, { type: "task.state_migrated", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: migration.note });
    logConsole("migr ", instanceId, migration.note);
  }
  const invalidation = getInvalidation(runtime, definition, item, state, meta, dependsOn);
  const canReuse = reusable(state, runtime, definition, item, meta, dependsOn, invalidation);

  if (canReuse) {
    logConsole("skip", instanceId);
    runtime.counts.skipped += 1;
    runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
    emitEvent(runtime, { type: "task.skipped", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: "既存成果物を再利用しました" });
    writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, note: "既存成果物を再利用しました", lastEvent: "task.skipped" });
    return;
  }

  if (invalidation) {
    runtime.invalidated.add(instanceId);
    emitEvent(runtime, { type: "task.invalidated", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: invalidation.reason });
    writeState(runtime, definition, item.itemId, { status: "invalidated", dependsOn, inputHash: state?.inputHash ?? meta.inputHash, promptHash: state?.promptHash ?? meta.promptHash, model: state?.model ?? meta.model, artifactPaths: state?.artifactPaths || [], startedAt: state?.startedAt || null, finishedAt: state?.finishedAt || null, retryCount: Number(state?.retryCount || 0), error: null });
  }

  logConsole("run ", instanceId);
  runtime.counts.running += 1;
  runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
  runtime.taskDurations.started.set(instanceId, Date.now());
  emitEvent(runtime, { type: "task.started", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: "task を開始しました" });
  writeState(runtime, definition, item.itemId, { status: "running", dependsOn, inputHash: meta.inputHash, promptHash: meta.promptHash, model: meta.model, artifactPaths: state?.artifactPaths || [], startedAt: isoJst(), finishedAt: null, retryCount: Number(state?.retryCount || 0), error: null });
  writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, promptPreview: meta.promptPreview, note: "実行中", lastEvent: "task.started" });

  try {
    const artifactPaths = await runHandler(runtime, definition.taskKey, item.itemId, meta);
    runtime.changed.add(instanceId);
    runtime.invalidated.delete(instanceId);
    runtime.counts.running -= 1;
    runtime.counts.completed += 1;
    recordTaskDuration(runtime, definition.taskKey, instanceId);
    runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
    writeState(runtime, definition, item.itemId, { status: "completed", dependsOn, inputHash: meta.inputHash, promptHash: meta.promptHash, model: meta.model, artifactPaths, startedAt: readState(runtime, definition.taskKey, item.itemId)?.startedAt || isoJst(), finishedAt: isoJst(), retryCount: Number(state?.retryCount || 0), error: null });
    emitEvent(runtime, { type: "task.completed", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, artifactPaths, note: "task が完了しました" });
    writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, promptPreview: meta.promptPreview, sentAt: runtime.current.sentAt, note: "完了", lastEvent: "task.completed" });
    logConsole("done", instanceId);
  } catch (error) {
    runtime.counts.running -= 1;
    runtime.counts.failed += 1;
    recordTaskDuration(runtime, definition.taskKey, instanceId);
    runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
    const message = error instanceof Error ? error.message : String(error);
    writeState(runtime, definition, item.itemId, { status: "failed", dependsOn, inputHash: meta.inputHash, promptHash: meta.promptHash, model: meta.model, artifactPaths: state?.artifactPaths || [], startedAt: readState(runtime, definition.taskKey, item.itemId)?.startedAt || isoJst(), finishedAt: isoJst(), retryCount: Number(state?.retryCount || 0) + 1, error: { code: "TASK_FAILED", message, retryable: true } });
    emitEvent(runtime, { type: "task.failed", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: message });
    writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, promptPreview: meta.promptPreview, sentAt: runtime.current.sentAt, note: message, lastEvent: "task.failed" });
    throw error;
  }
}


function aiProviderLabel(runtime) {
  const provider = resolveRuntimeProvider(runtime.config);
  if (provider === "copilot") {
    return "copilot-acp";
  }
  if (provider === "ollama") {
    return "ollama";
  }
  return "codex-app-server";
}

function normalizeAiUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const normalized = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    } else if (typeof value === "string" && value.trim()) {
      normalized[key] = value;
    } else if (typeof value === "boolean") {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length ? normalized : null;
}

function mergeAiUsages(usages) {
  const normalized = (usages || []).map((usage) => normalizeAiUsage(usage)).filter(Boolean);
  if (!normalized.length) {
    return null;
  }
  const result = { chunkCountWithUsage: normalized.length };
  for (const usage of normalized) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        result[key] = (result[key] || 0) + value;
      }
    }
  }
  if (typeof result.inputTokens === "number" || typeof result.outputTokens === "number") {
    result.totalTokens = (result.inputTokens || 0) + (result.outputTokens || 0);
  }
  return Object.keys(result).length > 1 ? result : null;
}

function buildAiMeta(runtime, meta, response, extra = {}) {
  const usage = normalizeAiUsage(response?.usage);
  return {
    model: meta.model,
    think: meta.think,
    promptHash: meta.promptHash,
    inputHash: meta.inputHash,
    provider: aiProviderLabel(runtime),
    cacheHit: Boolean(response?.cacheHit),
    ...(usage ? { usage } : {}),
    ...extra
  };
}

function isDeterministicAiMode(runtime) {
  return runtime.config.aiMode === "deterministic";
}

function buildLocalAiMeta(_runtime, meta, extra = {}) {
  return {
    model: meta.model ?? null,
    think: meta.think ?? null,
    promptHash: meta.promptHash ?? null,
    inputHash: meta.inputHash,
    provider: "local-deterministic",
    cacheHit: false,
    ...extra
  };
}

async function askForAdaptiveThreadJson(runtime, options) {
  const savedPlan = readThreadSplitPlan(runtime, options.taskKey, options.itemId);
  if (savedPlan?.leaves?.length) {
    const note = `保存済み split plan を使用します (leaf=${savedPlan.leaves.length})`;
    emitEvent(runtime, { type: "task.split_plan_reused", stage: runtime.current.stage, taskKey: options.taskKey, itemType: runtime.current.itemType, itemId: options.itemId, taskInstanceId: runtime.current.taskInstanceId, note });
    logConsole("plan ", `${options.taskKey}__${options.itemId}`, note);
  }
  const initialLeaves = savedPlan?.leaves?.length ? savedPlan.leaves : [{ path: "root", groups: buildThreadGroups(options.thread) }];
  const results = [];
  for (const leaf of initialLeaves) {
    const leafResults = await collectAdaptiveThreadResults(runtime, options, leaf.groups, leaf.path === "root" ? 0 : 1, leaf.path);
    results.push(...leafResults);
  }
  writeThreadSplitPlan(runtime, options.taskKey, options.itemId, { adaptiveSplit: results.length > 1, leaves: results.map((result) => ({ path: result.path, groups: result.groups })) });
  return {
    parsed: options.mergeParsed(results.map((result) => result.parsed)),
    text: JSON.stringify({ adaptiveSplit: results.length > 1, chunkCount: results.length, chunks: results.map((result) => ({ path: result.path, rawPreview: clip(result.text, 180) })) }, null, 2),
    usage: mergeAiUsages(results.map((result) => result.usage)),
    cacheHit: results.every((result) => result.cacheHit),
    adaptiveSplit: results.length > 1,
    chunkCount: results.length
  };
}

async function collectAdaptiveThreadResults(runtime, options, groups, depth, pathKey) {
  const payload = serializeThreadGroupsForAi(options.thread, groups);
  const prompt = options.buildPrompt(payload);
  const meta = aiMeta(runtime, prompt, { ...options.baseInput, payload, pathKey, depth });
  try {
    const response = await askForJson(runtime, options.taskKey, options.itemId, `${options.name}-${pathKey}`, meta);
    return [{ parsed: response.parsed, text: response.text, usage: response.usage || null, cacheHit: response.cacheHit, path: pathKey, groups }];
  } catch (error) {
    if (!isContextOverflowFailure(error)) {
      throw error;
    }
    const savedPlan = pathKey === "root" ? readThreadSplitPlan(runtime, options.taskKey, options.itemId) : null;
    if (savedPlan?.leaves?.length) {
      const note = `コンテキスト超過後に保存済み split plan を再利用します (leaf=${savedPlan.leaves.length})`;
      emitEvent(runtime, { type: "task.split_plan_reused", stage: runtime.current.stage, taskKey: options.taskKey, itemType: runtime.current.itemType, itemId: options.itemId, taskInstanceId: runtime.current.taskInstanceId, note });
      logConsole("plan ", `${options.taskKey}__${options.itemId}`, note);
      const results = [];
      for (const leaf of savedPlan.leaves) {
        const leafResults = await collectAdaptiveThreadResults(runtime, options, leaf.groups, depth + 1, leaf.path);
        results.push(...leafResults);
      }
      return results;
    }
    const split = splitThreadGroups(groups);
    if (!split) {
      throw error;
    }
    updateThreadSplitPlan(runtime, options.taskKey, options.itemId, pathKey, split);
    const splitNote = `コンテキスト超過のため ${groups.length} group を 2 分割します (depth=${depth})`;
    emitEvent(runtime, { type: "task.split", stage: runtime.current.stage, taskKey: options.taskKey, itemType: runtime.current.itemType, itemId: options.itemId, taskInstanceId: runtime.current.taskInstanceId, note: splitNote });
    logConsole("split", `${options.taskKey}__${options.itemId}`, splitNote);
    const left = await collectAdaptiveThreadResults(runtime, options, split.left, depth + 1, `${pathKey}L`);
    const right = await collectAdaptiveThreadResults(runtime, options, split.right, depth + 1, `${pathKey}R`);
    return [...left, ...right];
  }
}

function buildClassifyThreadPrompt(categories, payload) {
  return renderPromptTemplate("ai.classify_thread", {
    categoryGroupsJson: JSON.stringify(categories.groups || [], null, 2),
    flatCategoriesJson: JSON.stringify(categories.categories || [], null, 2),
    payloadJson: JSON.stringify(payload, null, 2)
  });
}

function buildExtractFindingsPrompt(payload) {
  return renderPromptTemplate("ai.extract_findings", {
    payloadJson: JSON.stringify(payload, null, 2)
  });
}

function mergeClassificationResults(items) {
  const primaryGroupCounts = new Map();
  const primaryCategoryCounts = new Map();
  const secondaryCounts = new Map();
  const reasons = [];
  const proposedCategories = [];
  for (const item of items) {
    const primaryGroup = item?.primaryGroup || "other";
    const primaryCategory = item?.primaryCategory || item?.primary || "uncategorized";
    primaryGroupCounts.set(primaryGroup, (primaryGroupCounts.get(primaryGroup) || 0) + 1);
    primaryCategoryCounts.set(primaryCategory, (primaryCategoryCounts.get(primaryCategory) || 0) + 1);
    for (const secondary of Array.isArray(item?.secondaryCategories) ? item.secondaryCategories : Array.isArray(item?.secondary) ? item.secondary : []) {
      secondaryCounts.set(secondary, (secondaryCounts.get(secondary) || 0) + 1);
    }
    if (item?.reason) {
      reasons.push(String(item.reason));
    }
    if (Array.isArray(item?.proposedCategories)) {
      proposedCategories.push(...item.proposedCategories);
    }
  }
  const primaryGroup = [...primaryGroupCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "other";
  const primaryCategory = [...primaryCategoryCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "uncategorized";
  const secondaryCategories = [...secondaryCounts.entries()].filter(([value]) => value && value !== primaryCategory).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([value]) => value);
  return {
    primaryGroup,
    primaryCategory,
    primary: primaryCategory,
    secondaryCategories,
    secondary: secondaryCategories,
    reason: reasons[0] || "",
    proposedCategories: normalizeProposedCategories(proposedCategories)
  };
}

function mergeFindingsResults(items) {
  const interests = uniqueStrings(items.flatMap((item) => Array.isArray(item?.interests) ? item.interests : []));
  const outcomes = uniqueStrings(items.flatMap((item) => Array.isArray(item?.outcomes) ? item.outcomes : []));
  const images = dedupeObjects(items.flatMap((item) => Array.isArray(item?.images) ? item.images : []), (image) => `${image?.path || ""}|${image?.note || ""}`);
  const questionMap = new Map();
  for (const question of items.flatMap((item) => Array.isArray(item?.questions) ? item.questions : [])) {
    const key = normalizeQuestionKey(question?.text);
    if (!key) continue;
    const existing = questionMap.get(key);
    if (!existing || compareQuestionStatus(question?.status, existing.status) > 0) {
      questionMap.set(key, { text: question.text, status: normalizeQuestionStatus(question.status) });
    }
  }
  const narratives = uniqueStrings(items.map((item) => item?.narrative).filter(Boolean)).slice(0, 4);
  return { interests, questions: [...questionMap.values()], outcomes, images, narrative: narratives.join("\n") };
}

function buildThreadGroups(thread) {
  const groups = [];
  let current = null;
  for (const message of thread.messages || []) {
    if (message.role === "user") {
      if (current) groups.push(finalizeThreadGroup(current, groups.length));
      current = { kind: "pair", promptMessages: [message], responseMessages: [] };
      continue;
    }
    if (!current) {
      current = { kind: "pair", promptMessages: [], responseMessages: [] };
    }
    current.responseMessages.push(message);
  }
  if (current) groups.push(finalizeThreadGroup(current, groups.length));
  return groups;
}

function buildTurnsFromThread(thread) {
  return buildThreadGroups(thread).filter(isNonEmptyTurnGroup).map((group, index) => ({
    itemId: `${thread.itemId}_turn_${String(index + 1).padStart(4, "0")}`,
    threadItemId: thread.itemId,
    turnIndex: index + 1,
    date: group.date || thread.primaryDate || null,
    promptMessages: group.promptMessages || [],
    responseMessages: group.responseMessages || []
  }));
}

function isNonEmptyTurnGroup(group) {
  const messages = [...(group?.promptMessages || []), ...(group?.responseMessages || [])];
  return messages.some((message) => isDiaryRelevantMessage(message));
}

function isDiaryRelevantMessage(message) {
  if (!message || message.role === "system") {
    return false;
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return true;
  }
  return Number(message.attachmentCount || 0) > 0
    || Number(message.generatedImageCount || 0) > 0
    || (Array.isArray(message.attachments) && message.attachments.length > 0)
    || (Array.isArray(message.generatedImages) && message.generatedImages.length > 0);
}

function finalizeThreadGroup(group, index) {
  const messages = [...(group.promptMessages || []), ...(group.responseMessages || [])];
  const date = messages.find((message) => message?.date)?.date || null;
  return { ...group, index, date };
}

function splitThreadGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return null;
  }
  const dateSplit = splitThreadGroupsByDate(groups);
  if (dateSplit) {
    return dateSplit;
  }
  if (groups.length > 1) {
    const middle = Math.floor(groups.length / 2);
    return { left: groups.slice(0, middle), right: groups.slice(middle) };
  }
  return splitSingleThreadGroup(groups[0]);
}

function splitThreadGroupsByDate(groups) {
  const buckets = [];
  let currentBucket = [];
  let currentDate = groups[0]?.date || null;

  for (const group of groups) {
    const groupDate = group?.date || null;
    if (currentBucket.length === 0) {
      currentBucket.push(group);
      currentDate = groupDate;
      continue;
    }
    if (groupDate === currentDate) {
      currentBucket.push(group);
      continue;
    }
    buckets.push(currentBucket);
    currentBucket = [group];
    currentDate = groupDate;
  }

  if (currentBucket.length > 0) {
    buckets.push(currentBucket);
  }
  if (buckets.length <= 1) {
    return null;
  }

  const totalGroups = groups.length;
  let running = 0;
  let splitIndex = -1;
  for (let index = 0; index < buckets.length - 1; index += 1) {
    running += buckets[index].length;
    if (running >= totalGroups / 2) {
      splitIndex = index;
      break;
    }
  }
  if (splitIndex < 0) {
    splitIndex = 0;
  }

  const left = buckets.slice(0, splitIndex + 1).flat();
  const right = buckets.slice(splitIndex + 1).flat();
  if (!left.length || !right.length) {
    return null;
  }
  return { left, right };
}

function splitSingleThreadGroup(group) {
  const promptMessages = Array.isArray(group.promptMessages) ? group.promptMessages : [];
  const responseMessages = Array.isArray(group.responseMessages) ? group.responseMessages : [];
  if (promptMessages.length > 0 && responseMessages.length > 0) {
    return {
      left: [{ kind: "prompt-side", index: `${group.index}p`, messages: promptMessages }],
      right: [{ kind: "response-side", index: `${group.index}r`, messages: responseMessages }]
    };
  }
  const messages = promptMessages.length > 0 ? promptMessages : responseMessages;
  if (messages.length === 1) {
    const message = messages[0];
    const text = String(message?.text || "");
    if (text.length < 2000) {
      return null;
    }
    const middle = Math.floor(text.length / 2);
    return {
      left: [{ kind: "message-text-half", index: `${group.index}a`, messages: [{ ...message, text: text.slice(0, middle) }] }],
      right: [{ kind: "message-text-half", index: `${group.index}b`, messages: [{ ...message, text: text.slice(middle) }] }]
    };
  }
  const middle = Math.floor(messages.length / 2);
  const leftMessages = messages.slice(0, middle);
  const rightMessages = messages.slice(middle);
  if (!leftMessages.length || !rightMessages.length) {
    return null;
  }
  return {
    left: [{ kind: "message-half", index: `${group.index}a`, messages: leftMessages }],
    right: [{ kind: "message-half", index: `${group.index}b`, messages: rightMessages }]
  };
}

function serializeThreadGroupsForAi(thread, groups) {
  const dateSegments = [];
  let currentSegment = null;
  for (const group of groups) {
    const groupDate = group?.date || "unknown";
    if (!currentSegment || currentSegment.date !== groupDate) {
      currentSegment = { date: groupDate, groupCount: 0 };
      dateSegments.push(currentSegment);
    }
    currentSegment.groupCount += 1;
  }
  return {
    itemId: thread.itemId,
    title: thread.title,
    primaryDate: thread.primaryDate,
    totalMessages: Array.isArray(thread.messages) ? thread.messages.length : 0,
    groupCount: groups.length,
    dateSegments,
    groups: groups.map((group) => serializeThreadGroup(group))
  };
}

function threadSplitPlanPath(runtime, taskKey, itemId) {
  return path.join(runtime.paths.root, "artifacts", "chunks", taskKey, `${itemId}.json`);
}

function readThreadSplitPlan(runtime, taskKey, itemId) {
  return readJson(threadSplitPlanPath(runtime, taskKey, itemId));
}

function writeThreadSplitPlan(runtime, taskKey, itemId, value) {
  writeJson(threadSplitPlanPath(runtime, taskKey, itemId), { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, taskKey, itemId, ...value });
}

function updateThreadSplitPlan(runtime, taskKey, itemId, pathKey, split) {
  const current = readThreadSplitPlan(runtime, taskKey, itemId);
  const replacement = [
    { path: `${pathKey}L`, groups: split.left },
    { path: `${pathKey}R`, groups: split.right }
  ];
  let leaves;
  if (!current?.leaves?.length || pathKey === "root") {
    leaves = replacement;
  } else {
    leaves = current.leaves.flatMap((leaf) => leaf.path === pathKey ? replacement : [leaf]);
  }
  writeThreadSplitPlan(runtime, taskKey, itemId, { adaptiveSplit: true, leaves });
}

function serializeThreadGroup(group) {
  if (group.kind === "pair") {
    return {
      kind: "pair",
      index: group.index,
      date: group.date,
      promptMessages: serializeMessagesForAi(group.promptMessages || []),
      responseMessages: serializeMessagesForAi(group.responseMessages || [])
    };
  }
  return {
    kind: group.kind,
    index: group.index,
    date: group.date || null,
    messages: serializeMessagesForAi(group.messages || [])
  };
}

function serializeMessagesForAi(messages) {
  return messages
    .filter((message) => shouldIncludeMessageForAi(message))
    .map((message) => ({
      role: message.role,
      date: message.date,
      contentType: message.contentType,
      text: clip(message.text || "", 4000),
      attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
      generatedImageCount: Array.isArray(message.generatedImages) ? message.generatedImages.length : 0
    }));
}

function shouldIncludeMessageForAi(message) {
  if (!message) {
    return false;
  }
  const contentType = String(message.contentType || "");
  const text = String(message.text || "").trim();
  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  const generatedImageCount = Array.isArray(message.generatedImages) ? message.generatedImages.length : 0;
  if (
    message.role === "tool"
    && ["tether_quote", "tether_browsing_display"].includes(contentType)
    && !text
    && attachmentCount === 0
    && generatedImageCount === 0
  ) {
    return false;
  }
  return true;
}

function compactThreadForAi(thread, options = {}) {
  const maxMessages = Number(options.maxMessages || 80);
  const maxTotalChars = Number(options.maxTotalChars || 12000);
  const maxPerMessageChars = Number(options.maxPerMessageChars || 320);
  const messages = [];
  let totalChars = 0;
  let omittedMessages = 0;

  for (let index = 0; index < (thread.messages || []).length; index += 1) {
    const message = thread.messages[index];
    if (messages.length >= maxMessages) {
      omittedMessages = (thread.messages || []).length - index;
      break;
    }

    const text = clip(message.text || "", maxPerMessageChars);
    const nextChars = totalChars + text.length;
    if (nextChars > maxTotalChars) {
      omittedMessages = (thread.messages || []).length - index;
      break;
    }

    messages.push({
      role: message.role,
      date: message.date,
      text,
      attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
      generatedImageCount: Array.isArray(message.generatedImages) ? message.generatedImages.length : 0
    });
    totalChars = nextChars;
  }

  return {
    itemId: thread.itemId,
    title: thread.title,
    primaryDate: thread.primaryDate,
    totalMessages: Array.isArray(thread.messages) ? thread.messages.length : 0,
    includedMessages: messages.length,
    omittedMessages,
    preview: thread.preview || "",
    messages
  };
}

function compactThreadForMerge(thread) {
  if (!thread) {
    return null;
  }
  return {
    itemId: thread.itemId,
    title: thread.title || "",
    primaryDate: thread.primaryDate || null,
    preview: clip(thread.preview || "", 500)
  };
}

function compactTurnForAi(turn) {
  if (!turn) {
    return null;
  }
  return {
    itemId: turn.itemId,
    threadItemId: turn.threadItemId,
    date: turn.date || null,
    turnIndex: turn.turnIndex || null,
    promptMessages: serializeMessagesForAi(turn.promptMessages || []),
    responseMessages: serializeMessagesForAi(turn.responseMessages || [])
  };
}

function compactTurnSummaryForMerge(summary) {
  if (!summary) {
    return null;
  }
  return {
    turnIndex: Number(summary.turnIndex || 0) || null,
    date: summary.date || null,
    userIntent: clip(summary.userIntent || "", 240),
    assistantResponse: clip(summary.assistantResponse || "", 320),
    outcome: clip(summary.outcome || "", 240)
  };
}

function compactMergedClassificationForMerge(classification, master) {
  const groupLabels = new Map((master?.groups || []).map((group) => [group.id, group.label]));
  const categoryLabels = new Map((master?.categories || []).map((category) => [category.id, category.label]));
  const secondaryCategories = Array.isArray(classification?.secondaryCategories) ? classification.secondaryCategories.slice(0, 2) : [];
  return {
    primaryGroup: classification?.primaryGroup || "other",
    primaryGroupLabel: groupLabels.get(classification?.primaryGroup || "other") || classification?.primaryGroup || "other",
    primaryCategory: classification?.primaryCategory || classification?.primary || "uncategorized",
    primaryCategoryLabel: categoryLabels.get(classification?.primaryCategory || classification?.primary || "uncategorized") || classification?.primaryCategory || classification?.primary || "uncategorized",
    secondaryCategories,
    secondaryCategoryLabels: secondaryCategories.map((categoryId) => categoryLabels.get(categoryId) || categoryId),
    reasonHint: classification?.reason || ""
  };
}

function compactUnitForAi(unit, availableThreadItemIds) {
  return {
    itemId: unit.itemId,
    label: unit.label || "",
    date: unit.date || null,
    entryId: unit.entryId || null,
    threadItemIds: availableThreadItemIds,
    omittedThreadItemIds: (unit.threadItemIds || []).filter((threadItemId) => !availableThreadItemIds.includes(threadItemId))
  };
}

function compactThreadClassificationForAi(classification) {
  if (!classification) {
    return null;
  }
  return {
    primaryGroup: classification.primaryGroup || "",
    primaryGroupLabel: classification.primaryGroupLabel || classification.primaryGroup || "",
    primaryCategory: classification.primaryCategory || classification.primary || "",
    primaryCategoryLabel: classification.primaryCategoryLabel || classification.primaryCategory || classification.primary || "",
    secondaryCategories: Array.isArray(classification.secondaryCategories) ? classification.secondaryCategories.slice(0, 2) : Array.isArray(classification.secondary) ? classification.secondary.slice(0, 2) : [],
    secondaryCategoryLabels: Array.isArray(classification.secondaryCategoryLabels) ? classification.secondaryCategoryLabels.slice(0, 2) : [],
    reason: clip(classification.reason || "", 160)
  };
}

function compactThreadFindingsForAi(findings) {
  if (!findings) {
    return null;
  }
  return {
    interests: uniqueStrings((findings.interests || []).map((value) => clip(value, 120))).slice(0, 8),
    questions: (findings.questions || []).map((question) => ({
      text: clip(question?.text || "", 160),
      status: normalizeQuestionStatus(question?.status)
    })).filter((question) => question.text).slice(0, 8),
    outcomes: uniqueStrings((findings.outcomes || []).map((value) => clip(value, 160))).slice(0, 8),
    images: (findings.images || []).map((image) => ({
      path: image?.path || "",
      note: clip(image?.note || image?.caption || image?.prompt || "", 120)
    })).filter((image) => image.path || image.note).slice(0, 8),
    narrative: clip(findings.narrative || "", 400)
  };
}

function compactThreadSummaryForAi(summary) {
  if (!summary) {
    return null;
  }
  return {
    summaryTitle: clip(summary.summaryTitle || "", 120),
    narrative: clip(summary.narrative || "", 400)
  };
}

function compactThreadInputsForUnit(runtime, threadItemId) {
  const thread = readArtifact(runtime, `artifacts/normalized/${threadItemId}.json`);
  const classification = readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`);
  const findings = readArtifact(runtime, `artifacts/ai/thread_findings/${threadItemId}.json`);
  const summary = readArtifact(runtime, `artifacts/ai/thread_summaries/${threadItemId}.json`);
  if (!thread || !classification || !findings) {
    return null;
  }
  return {
    itemId: threadItemId,
    title: thread.title || "",
    primaryDate: thread.primaryDate || null,
    classification: compactThreadClassificationForAi(classification),
    summary: compactThreadSummaryForAi(summary),
    findings: compactThreadFindingsForAi(findings)
  };
}

function compactUnitSummaryForEntry(summary) {
  if (!summary) {
    return null;
  }
  return {
    itemId: summary.itemId,
    label: summary.label || summary.unitLabel || "",
    date: summary.date || null,
    summaryTitle: clip(summary.summaryTitle || "", 120),
    interests: uniqueStrings((summary.interests || []).map((value) => clip(value, 120))).slice(0, 8),
    questions: uniqueStrings((summary.questions || []).map((value) => {
      if (typeof value === "string") return clip(value, 160);
      return clip(value?.text || "", 160);
    })).slice(0, 8),
    outcomes: uniqueStrings((summary.outcomes || []).map((value) => clip(value, 160))).slice(0, 8),
    narrative: clip(summary.narrative || "", 500),
    images: (summary.images || []).map((image) => ({
      path: image?.path || "",
      note: clip(image?.note || image?.caption || image?.prompt || "", 120)
    })).filter((image) => image.path || image.note).slice(0, 8)
  };
}

function compactEntryForAi(entry) {
  return {
    itemId: entry.itemId,
    date: entry.date,
    units: (entry.units || []).map((unit) => ({
      itemId: unit.itemId,
      label: unit.label || "",
      date: unit.date || null,
      threadItemIds: unit.threadItemIds || []
    })),
    unitSummaries: (entry.unitSummaries || []).map((summary) => compactUnitSummaryForEntry(summary)).filter(Boolean)
  };
}

function compactDiaryDraftForAi(draft) {
  return {
    itemId: draft.itemId || "",
    date: draft.date || null,
    title: draft.title || "",
    lead: clip(draft.lead || "", 800),
    sections: (draft.sections || []).map((section) => ({
      heading: section?.heading || "",
      body: clip(section?.body || "", 1600)
    })),
    closing: clip(draft.closing || "", 800),
    images: (draft.images || []).map((image) => ({
      path: image?.path || "",
      caption: clip(image?.caption || "", 120)
    })).filter((image) => image.path || image.caption)
  };
}

function enumerateWeekItems(runtime) {
  const entries = loadDiaryEntries(runtime);
  const units = readArtifact(runtime, "artifacts/units/units.json")?.items || [];
  const threadIdsByEntry = buildThreadIdsByEntry(units);
  const map = new Map();
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || ""))) {
      continue;
    }
    const week = monthWeekKey(entry.date);
    if (!week) {
      continue;
    }
    const itemId = `week_${week}`;
    if (!map.has(itemId)) {
      map.set(itemId, { itemId, meta: { itemId, week, month: week.slice(0, 7), year: week.slice(0, 4), date: entry.date, entryIds: [], threadItemIds: [] } });
    }
    const meta = map.get(itemId).meta;
    if (entry.date < meta.date) {
      meta.date = entry.date;
    }
    meta.entryIds.push(entry.itemId);
    for (const threadItemId of threadIdsByEntry.get(entry.itemId) || []) {
      if (!meta.threadItemIds.includes(threadItemId)) {
        meta.threadItemIds.push(threadItemId);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.meta.week.localeCompare(b.meta.week, "ja"));
}

function enumerateMonthItems(runtime) {
  const weeks = enumerateWeekItems(runtime);
  const map = new Map();
  for (const weekItem of weeks) {
    const month = weekItem.meta.month;
    const itemId = `month_${month}`;
    if (!map.has(itemId)) {
      map.set(itemId, { itemId, meta: { itemId, month, date: `${month}-01`, weekIds: [], entryIds: [], threadItemIds: [] } });
    }
    const meta = map.get(itemId).meta;
    meta.weekIds.push(weekItem.itemId);
    meta.entryIds.push(...(weekItem.meta.entryIds || []));
    for (const threadItemId of weekItem.meta.threadItemIds || []) {
      if (!meta.threadItemIds.includes(threadItemId)) {
        meta.threadItemIds.push(threadItemId);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.meta.month.localeCompare(b.meta.month, "ja"));
}

function enumerateYearItems(runtime) {
  const months = enumerateMonthItems(runtime);
  const map = new Map();
  for (const monthItem of months) {
    const year = monthItem.meta.month.slice(0, 4);
    const itemId = `year_${year}`;
    if (!map.has(itemId)) {
      map.set(itemId, { itemId, meta: { itemId, year, date: `${year}-01-01`, monthIds: [], threadItemIds: [] } });
    }
    const meta = map.get(itemId).meta;
    meta.monthIds.push(monthItem.itemId);
    for (const threadItemId of monthItem.meta.threadItemIds || []) {
      if (!meta.threadItemIds.includes(threadItemId)) {
        meta.threadItemIds.push(threadItemId);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.meta.year.localeCompare(b.meta.year, "ja"));
}

function buildThreadIdsByEntry(units) {
  const map = new Map();
  for (const unit of units || []) {
    if (!unit.entryId) {
      continue;
    }
    if (!map.has(unit.entryId)) {
      map.set(unit.entryId, []);
    }
    for (const threadItemId of unit.threadItemIds || []) {
      if (!map.get(unit.entryId).includes(threadItemId)) {
        map.get(unit.entryId).push(threadItemId);
      }
    }
  }
  return map;
}

function compactDiaryEntryForArchiveSummary(entry) {
  return {
    itemId: entry.itemId || "",
    date: entry.date || null,
    title: entry.title || "",
    markdownBody: clip(entry.markdownBody || "", 2200)
  };
}

function compactWeekSummaryForMonthlySummary(summary) {
  return {
    itemId: summary.itemId || "",
    week: summary.week || null,
    title: summary.title || "",
    overview: clip(summary.overview || "", 900),
    themes: (summary.themes || []).map((theme) => ({
      heading: theme?.heading || "",
      body: clip(theme?.body || "", 900)
    })),
    notableDays: (summary.notableDays || []).map((day) => ({
      date: day?.date || "",
      title: day?.title || "",
      note: clip(day?.note || "", 300)
    })),
    closing: clip(summary.closing || "", 700)
  };
}

function compactArchiveStatsForAi(stats) {
  return {
    dayCount: stats.dayCount,
    weekCount: stats.weekCount || 0,
    monthCount: stats.monthCount || 0,
    threadCount: stats.threadCount,
    messageCount: stats.messageCount,
    userMessageCount: stats.userMessageCount,
    assistantMessageCount: stats.assistantMessageCount,
    estimatedInputTokens: stats.estimatedInputTokens,
    estimatedOutputTokens: stats.estimatedOutputTokens,
    estimatedTotalTokens: stats.estimatedTotalTokens,
    generatedImageCount: stats.generatedImageCount,
    topCategories: (stats.topCategories || []).slice(0, 12),
    topPrimaryCategories: (stats.topPrimaryCategories || []).slice(0, 12)
  };
}

function compactMonthSummaryForYearlySummary(summary) {
  return {
    itemId: summary.itemId || "",
    month: summary.month || null,
    title: summary.title || "",
    overview: clip(summary.overview || "", 900),
    themes: (summary.themes || []).map((theme) => ({
      heading: theme?.heading || "",
      body: clip(theme?.body || "", 900)
    })),
    notableWeeks: (summary.notableWeeks || []).map((week) => ({
      week: week?.week || "",
      title: week?.title || "",
      note: clip(week?.note || "", 300)
    })),
    closing: clip(summary.closing || "", 700)
  };
}

function readWeekInput(runtime, weekItemId) {
  const week = String(weekItemId).replace(/^week_/, "");
  const entries = loadDiaryEntries(runtime)
    .filter((entry) => monthWeekKey(entry.date) === week)
    .sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
  return { itemId: weekItemId, week, entries, stats: buildArchiveStatsFromEntries(runtime, entries, { weekCount: 1 }) };
}

function readMonthInput(runtime, monthItemId) {
  const month = String(monthItemId).replace(/^month_/, "");
  const weeks = enumerateWeekItems(runtime)
    .map((item) => item.meta.week)
    .filter((week) => week.startsWith(month))
    .sort((a, b) => a.localeCompare(b, "ja"));
  const weeklySummaries = weeks
    .map((week) => readArtifact(runtime, `artifacts/ai/weekly_summaries/week_${week}.json`))
    .filter(Boolean);
  const entries = loadDiaryEntries(runtime)
    .filter((entry) => String(entry.date || "").startsWith(`${month}-`))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
  return { itemId: monthItemId, month, weeks, weeklySummaries, entries, stats: buildArchiveStatsFromEntries(runtime, entries, { monthCount: 1, weekCount: weeks.length }) };
}

function readYearInput(runtime, yearItemId) {
  const year = String(yearItemId).replace(/^year_/, "");
  const months = enumerateMonthItems(runtime)
    .map((item) => item.meta.month)
    .filter((month) => month.startsWith(year))
    .sort((a, b) => a.localeCompare(b, "ja"));
  const monthlySummaries = months
    .map((month) => readArtifact(runtime, `artifacts/ai/monthly_summaries/month_${month}.json`))
    .filter(Boolean);
  const entries = loadDiaryEntries(runtime)
    .filter((entry) => String(entry.date || "").startsWith(`${year}-`))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
  return { itemId: yearItemId, year, months, monthlySummaries, entries, stats: buildArchiveStatsFromEntries(runtime, entries, { monthCount: months.length }) };
}


async function runHandler(runtime, taskKey, itemId, meta) {
  if (taskKey === "prepare.extract_export") return handleExtractExport(runtime);
  if (taskKey === "prepare.scan_export") return handleScanExport(runtime);
  if (taskKey === "prepare.build_thread_index") return handleBuildThreadIndex(runtime);
  if (taskKey === "analyze.normalize_threads") return handleNormalizeThreads(runtime);
  if (taskKey === "analyze.attach_images") return handleAttachImages(runtime);
  if (taskKey === "ai.generate_category_candidates") return handleCategories(runtime, meta);
  if (taskKey === "analyze.split_thread_turns") return handleSplitThreadTurns(runtime, itemId);
  if (taskKey === "ai.summarize_turn") return handleSummarizeTurn(runtime, itemId, meta);
  if (taskKey === "ai.classify_turn") return handleClassifyTurn(runtime, itemId, meta);
  if (taskKey === "ai.merge_thread_turns") return handleMergeThreadTurns(runtime, itemId, meta);
  if (taskKey === "analyze.group_units") return handleGroupUnits(runtime);
  if (taskKey === "ai.summarize_unit") return handleSummarizeUnit(runtime, itemId, meta);
  if (taskKey === "ai.write_diary_entry") return handleWriteEntry(runtime, itemId, meta);
  if (taskKey === "ai.rewrite_diary_entry") return handleRewriteEntry(runtime, itemId, meta);
  if (taskKey === "ai.write_weekly_summary") return handleWriteWeeklySummary(runtime, itemId, meta);
  if (taskKey === "ai.write_monthly_summary") return handleWriteMonthlySummary(runtime, itemId, meta);
  if (taskKey === "ai.write_yearly_summary") return handleWriteYearlySummary(runtime, itemId, meta);
  if (taskKey === "render.markdown") return handleRenderMarkdown(runtime);
  if (taskKey === "render.html") return handleRenderHtml(runtime);
  if (taskKey === "render.pdf") return handleRenderPdf(runtime);
  throw new Error(`未対応の taskKey: ${taskKey}`);
}

async function handleExtractExport(runtime) {
  if (runtime.config.force && fs.existsSync(runtime.paths.extracted)) fs.rmSync(runtime.paths.extracted, { recursive: true, force: true });
  ensureDir(runtime.paths.extracted);
  await execFileAsync("tar", ["-xf", runtime.config.zipPath, "-C", runtime.paths.extracted], { windowsHide: true, maxBuffer: 1024 * 1024 * 64 });
  writeArtifact(runtime, "artifacts/manifest/extract-result.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, zipPath: runtime.config.zipPath, extractedTo: rel(runtime, runtime.paths.extracted) });
  return ["artifacts/manifest/extract-result.json"];
}

function handleScanExport(runtime) {
  const files = walkFiles(runtime.paths.extracted).map((file) => path.relative(runtime.paths.extracted, file).replaceAll("\\", "/")).sort();
  const rawThreads = loadRawThreads(runtime.paths.extracted);
  const manifest = { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, exportRoot: rel(runtime, runtime.paths.extracted), sources: { conversationsFiles: files.filter((file) => /^conversations-\d+\.json$/i.test(path.basename(file))), dalleGenerationsDir: files.some((file) => file.startsWith("dalle-generations/")) ? "dalle-generations" : null, attachmentsDir: files.some((file) => file.startsWith("attachments/")) ? "attachments" : null }, counts: { conversationFiles: files.filter((file) => /^conversations-\d+\.json$/i.test(path.basename(file))).length, threads: rawThreads.length, messages: rawThreads.reduce((sum, thread) => sum + thread.messages.length, 0), generatedImages: files.filter((file) => /(^|\/)dalle-generations\//i.test(file) && /\.(png|jpg|jpeg|webp)$/i.test(file)).length, attachedImages: files.filter((file) => /(^|\/)attachments\//i.test(file) && /\.(png|jpg|jpeg|webp)$/i.test(file)).length } };
  writeArtifact(runtime, "artifacts/manifest/export-manifest.json", manifest);
  writeArtifact(runtime, "artifacts/manifest/file-inventory.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, files });
  return ["artifacts/manifest/export-manifest.json", "artifacts/manifest/file-inventory.json"];
}

function handleBuildThreadIndex(runtime) {
  const rawThreads = loadRawThreads(runtime.paths.extracted);
  const threads = rawThreads.map((thread, index) => ({ itemId: `thread_${String(index + 1).padStart(6, "0")}`, sourceThreadId: thread.sourceThreadId, groupId: thread.groupId, gizmoId: thread.gizmoId, conversationTemplateId: thread.conversationTemplateId, gizmoType: thread.gizmoType, title: thread.title, primaryDate: thread.primaryDate, messageCount: thread.messageCount, userMessageCount: thread.userMessageCount, assistantMessageCount: thread.assistantMessageCount, generatedImageCount: thread.generatedImageCount, preview: thread.preview, sourceFile: thread.sourceFile }));
  const messages = rawThreads.flatMap((thread, index) => thread.messages.map((message) => ({ threadItemId: `thread_${String(index + 1).padStart(6, "0")}`, messageId: message.id, role: message.role, date: message.date })));
  writeArtifact(runtime, "artifacts/indexes/thread-index.json", { schemaVersion: 2, generatedAt: isoJst(), runId: runtime.config.runId, threads });
  writeArtifact(runtime, "artifacts/indexes/message-index.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, messages });
  return ["artifacts/indexes/thread-index.json", "artifacts/indexes/message-index.json"];
}

function handleNormalizeThreads(runtime) {
  const indexBySource = new Map((readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => [thread.sourceThreadId, thread.itemId]));
  const artifactPaths = [];
  for (const thread of loadRawThreads(runtime.paths.extracted)) {
    const itemId = indexBySource.get(thread.sourceThreadId);
    if (!itemId) continue;
    writeArtifact(runtime, `artifacts/normalized/${itemId}.json`, { schemaVersion: 2, generatedAt: isoJst(), runId: runtime.config.runId, itemId, sourceThreadId: thread.sourceThreadId, groupId: thread.groupId, gizmoId: thread.gizmoId, conversationTemplateId: thread.conversationTemplateId, gizmoType: thread.gizmoType, title: thread.title, primaryDate: thread.primaryDate, createTime: thread.createTime, updateTime: thread.updateTime, messageCount: thread.messageCount, userMessageCount: thread.userMessageCount, assistantMessageCount: thread.assistantMessageCount, generatedImageCount: thread.generatedImageCount, preview: thread.preview, messages: thread.messages });
    artifactPaths.push(`artifacts/normalized/${itemId}.json`);
  }
  return artifactPaths;
}

function handleAttachImages(runtime) {
  const artifactPaths = [];
  for (const thread of loadThreads(runtime)) {
    writeArtifact(runtime, `artifacts/normalized/${thread.itemId}.json`, { ...thread, generatedAt: isoJst(), imageStats: { attachments: thread.messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0), generated: thread.messages.reduce((sum, message) => sum + (message.generatedImages?.length || 0), 0) } });
    artifactPaths.push(`artifacts/normalized/${thread.itemId}.json`);
  }
  return artifactPaths;
}

function handleSplitThreadTurns(runtime, itemId) {
  const thread = readArtifact(runtime, `artifacts/normalized/${itemId}.json`);
  const turns = buildTurnsFromThread(thread);
  const index = readArtifact(runtime, "artifacts/indexes/turn-index.json")?.turns || [];
  const retained = index.filter((turn) => turn.threadItemId !== itemId);
  const artifactPaths = [];
  for (const turn of turns) {
    const meta = {
      itemId: turn.itemId,
      threadItemId: itemId,
      threadTitle: thread.title,
      date: turn.date || thread.primaryDate || null,
      turnIndex: turn.turnIndex,
      promptMessageCount: turn.promptMessages.length,
      responseMessageCount: turn.responseMessages.length
    };
    retained.push(meta);
    writeArtifact(runtime, `artifacts/turns/${turn.itemId}.json`, {
      schemaVersion: 1,
      generatedAt: isoJst(),
      runId: runtime.config.runId,
      ...meta,
      promptMessages: turn.promptMessages,
      responseMessages: turn.responseMessages
    });
    artifactPaths.push(`artifacts/turns/${turn.itemId}.json`);
  }
  writeArtifact(runtime, "artifacts/indexes/turn-index.json", {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    turns: retained.sort((left, right) => left.itemId.localeCompare(right.itemId, "ja"))
  });
  artifactPaths.push("artifacts/indexes/turn-index.json");
  return artifactPaths;
}

async function handleSummarizeTurn(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleSummarizeTurnDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.summarize_turn", itemId, `turn-summary-${itemId}`, meta);
  const turn = readTurn(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/turn_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    threadItemId: turn.threadItemId,
    date: turn.date,
    turnIndex: turn.turnIndex,
    userIntent: response.parsed.userIntent || "",
    assistantResponse: response.parsed.assistantResponse || "",
    outcome: response.parsed.outcome || "",
    aiMeta: buildAiMeta(runtime, meta, response)
  });
  writeRaw(runtime, "ai.summarize_turn", itemId, response.text, response.usage);
  return [`artifacts/ai/turn_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_turn/${itemId}.raw.json`];
}

async function handleClassifyTurn(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleClassifyTurnDeterministic(runtime, itemId, meta);
  }
  const turn = readTurn(runtime, itemId);
  const categories = readCategoryMaster(runtime) || {};
  const response = await askForJson(runtime, "ai.classify_turn", itemId, `turn-classify-${itemId}`, meta);
  const masterUpdated = mergeCategoryMaster(runtime, response.parsed.proposedCategories || [], itemId);
  const categoryLabels = new Map((categories.categories || []).map((category) => [category.id, category.label]));
  const groupLabels = new Map((categories.groups || []).map((group) => [group.id, group.label]));
  const primaryGroup = response.parsed.primaryGroup || "other";
  const primaryCategory = response.parsed.primaryCategory || "uncategorized";
  const secondaryCategories = Array.isArray(response.parsed.secondaryCategories) ? response.parsed.secondaryCategories : [];
  const artifactPaths = [`artifacts/ai/turn_classification/${itemId}.json`, `artifacts/raw/ai.classify_turn/${itemId}.raw.json`];
  if (masterUpdated) {
    artifactPaths.push("artifacts/ai/category_master.json", "artifacts/ai/categories.json");
  }
  writeArtifact(runtime, `artifacts/ai/turn_classification/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    threadItemId: turn.threadItemId,
    date: turn.date,
    turnIndex: turn.turnIndex,
    primaryGroup,
    primaryGroupLabel: groupLabels.get(primaryGroup) || primaryGroup,
    primaryCategory,
    primaryCategoryLabel: categoryLabels.get(primaryCategory) || primaryCategory,
    secondaryCategories,
    secondaryCategoryLabels: secondaryCategories.map((categoryId) => categoryLabels.get(categoryId) || categoryId),
    reason: response.parsed.reason || "",
    proposedCategories: Array.isArray(response.parsed.proposedCategories) ? response.parsed.proposedCategories : [],
    aiMeta: buildAiMeta(runtime, meta, response, { categoryMasterUpdated: masterUpdated })
  });
  writeRaw(runtime, "ai.classify_turn", itemId, response.text, response.usage);
  return artifactPaths;
}

async function handleMergeThreadTurns(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleMergeThreadTurnsDeterministic(runtime, itemId, meta);
  }
  const context = buildThreadMergeContext(runtime, itemId);
  const response = await askForMergedThreadJson(runtime, itemId, meta, context);
  const categories = readCategoryMaster(runtime) || {};
  const categoryLabels = new Map((categories.categories || []).map((category) => [category.id, category.label]));
  const groupLabels = new Map((categories.groups || []).map((group) => [group.id, group.label]));
  const mergedClassification = context.mergedClassificationRaw;
  const primaryGroup = mergedClassification.primaryGroup || "other";
  const primaryCategory = mergedClassification.primaryCategory || mergedClassification.primary || "uncategorized";
  const secondaryCategories = Array.isArray(mergedClassification.secondaryCategories)
    ? mergedClassification.secondaryCategories
    : Array.isArray(mergedClassification.secondary)
      ? mergedClassification.secondary
      : [];
  const artifactPaths = [
    `artifacts/ai/thread_classification/${itemId}.json`,
    `artifacts/ai/thread_findings/${itemId}.json`,
    `artifacts/ai/thread_summaries/${itemId}.json`,
    ...response.artifactPaths,
    `artifacts/raw/ai.merge_thread_turns/${itemId}.raw.json`
  ];
  writeArtifact(runtime, `artifacts/ai/thread_classification/${itemId}.json`, {
    schemaVersion: 2,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    primaryGroup,
    primaryGroupLabel: groupLabels.get(primaryGroup) || primaryGroup,
    primaryCategory,
    primaryCategoryLabel: categoryLabels.get(primaryCategory) || primaryCategory,
    secondaryCategories,
    secondaryCategoryLabels: secondaryCategories.map((categoryId) => categoryLabels.get(categoryId) || categoryId),
    primary: primaryCategory,
    secondary: secondaryCategories,
    reason: response.parsed.reason || mergedClassification.reason || "",
    proposedCategories: [],
    aiMeta: buildAiMeta(runtime, meta, response, { classificationMergedInCode: true, mergeStrategy: response.mergeStrategy })
  });
  writeArtifact(runtime, `artifacts/ai/thread_findings/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [],
    questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [],
    outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [],
    images: Array.isArray(response.parsed.images) ? response.parsed.images : [],
    narrative: response.parsed.narrative || "",
    aiMeta: buildAiMeta(runtime, meta, response, { mergeStrategy: response.mergeStrategy })
  });
  writeArtifact(runtime, `artifacts/ai/thread_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    summaryTitle: response.parsed.summaryTitle || "",
    narrative: response.parsed.narrative || "",
    aiMeta: buildAiMeta(runtime, meta, response, { mergeStrategy: response.mergeStrategy })
  });
  writeRaw(runtime, "ai.merge_thread_turns", itemId, response.text, response.usage);
  return artifactPaths;
}

async function askForMergedThreadJson(runtime, itemId, meta, context) {
  const prompt = buildMergeThreadTurnsPrompt(context.payload);
  const promptStats = buildPromptStats({ prompt, systemPrompt: getOllamaSystemPrompt(runtime.config) });
  const tokenLimit = threadMergeInputTokenLimit(runtime);
  if (promptStats.estimatedInputTokens <= tokenLimit) {
    return { ...(await askForJson(runtime, "ai.merge_thread_turns", itemId, `thread-merge-${itemId}`, meta)), artifactPaths: [], mergeStrategy: { mode: "single", estimatedInputTokens: promptStats.estimatedInputTokens, tokenLimit } };
  }
  return askForChunkedMergedThreadJson(runtime, itemId, meta, context, promptStats.estimatedInputTokens, tokenLimit);
}

async function askForChunkedMergedThreadJson(runtime, itemId, meta, context, initialEstimatedInputTokens, tokenLimit) {
  let level = 1;
  let summaries = context.turnSummaries;
  const artifactPaths = [];
  const usages = [];
  const chunkSize = threadMergeChunkSize(runtime);
  const maxLevels = Number(runtime.config.threadMergeMaxLevels || 8);
  logConsole("plan", `ai.merge_thread_turns__${itemId}`, `入力が大きいためチャンク統合します input≈${formatInteger(initialEstimatedInputTokens)}tok limit=${formatInteger(tokenLimit)} chunkSize=${chunkSize}`);

  while (level <= maxLevels) {
    const chunks = splitThreadMergeSummaries(runtime, context, summaries, tokenLimit, chunkSize);
    logConsole("plan", `ai.merge_thread_turns__${itemId}`, `merge level=${level} summaries=${summaries.length} chunks=${chunks.length}`);
    if (chunks.length <= 1) {
      const finalPayload = { ...context.payload, turnSummaries: summaries };
      const finalMeta = buildMergeThreadTurnsAiMeta(runtime, meta, finalPayload, { mode: "chunked-final", level, sourceSummaryCount: summaries.length, initialEstimatedInputTokens, tokenLimit });
      const finalResponse = await askForJson(runtime, "ai.merge_thread_turns", itemId, `thread-merge-${itemId}-final`, finalMeta);
      return {
        ...finalResponse,
        usage: mergeAiUsages([...usages, finalResponse.usage]),
        artifactPaths,
        mergeStrategy: { mode: "chunked", levels: level - 1, chunks: artifactPaths.length, initialEstimatedInputTokens, tokenLimit, chunkSize }
      };
    }

    const nextSummaries = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkNumber = index + 1;
      const chunkId = `${itemId}__level_${String(level).padStart(2, "0")}__chunk_${String(chunkNumber).padStart(3, "0")}`;
      const chunkPayload = { ...context.payload, turnSummaries: chunks[index], partialMerge: { level, chunkNumber, chunkCount: chunks.length } };
      const chunkMeta = buildMergeThreadTurnsAiMeta(runtime, meta, chunkPayload, { mode: "chunk", level, chunkNumber, chunkCount: chunks.length, initialEstimatedInputTokens, tokenLimit });
      const response = await askForJson(runtime, "ai.merge_thread_turns", chunkId, `thread-merge-${chunkId}`, chunkMeta);
      usages.push(response.usage);
      const artifactPath = `artifacts/ai/thread_merge_chunks/${itemId}/level_${String(level).padStart(2, "0")}_chunk_${String(chunkNumber).padStart(3, "0")}.json`;
      writeArtifact(runtime, artifactPath, {
        schemaVersion: 1,
        generatedAt: isoJst(),
        runId: runtime.config.runId,
        itemId: chunkId,
        threadItemId: itemId,
        level,
        chunkNumber,
        chunkCount: chunks.length,
        sourceSummaryCount: chunks[index].length,
        summary: response.parsed,
        aiMeta: buildAiMeta(runtime, chunkMeta, response, { mergeStrategy: { mode: "chunk", level, chunkNumber, chunkCount: chunks.length } })
      });
      artifactPaths.push(artifactPath, `artifacts/raw/ai.merge_thread_turns/${chunkId}.raw.json`);
      nextSummaries.push(compactPartialThreadSummaryForMerge(response.parsed, level, chunkNumber));
    }
    summaries = nextSummaries;
    level += 1;
  }

  throw new Error(`thread merge の階層統合が最大段数を超えました: ${itemId} levels=${maxLevels}`);
}

function buildThreadMergeContext(runtime, itemId) {
  const turns = loadTurnsForThread(runtime, itemId);
  const rawTurnClassifications = turns
    .map((turn) => readArtifact(runtime, `artifacts/ai/turn_classification/${turn.itemId}.json`))
    .filter(Boolean);
  const turnSummaries = turns
    .map((turn) => compactTurnSummaryForMerge(readArtifact(runtime, `artifacts/ai/turn_summaries/${turn.itemId}.json`)))
    .filter(Boolean);
  const categories = readCategoryMaster(runtime) || {};
  const mergedClassificationRaw = mergeClassificationResults(rawTurnClassifications);
  const mergedClassification = compactMergedClassificationForMerge(mergedClassificationRaw, categories);
  const payload = {
    thread: compactThreadForMerge(readThread(runtime, itemId)),
    turnSummaries,
    mergedClassification
  };
  return {
    turns,
    turnSummaries,
    rawTurnClassifications,
    mergedClassificationRaw,
    payload,
    input: { thread: payload.thread, turnSummaries, mergedClassification, rawTurnClassificationCount: rawTurnClassifications.length }
  };
}

function buildMergeThreadTurnsPrompt(payload) {
  return renderPromptTemplate("ai.merge_thread_turns", {
    payloadJson: JSON.stringify(payload, null, 2)
  });
}

function buildMergeThreadTurnsAiMeta(runtime, baseMeta, payload, strategy) {
  const prompt = buildMergeThreadTurnsPrompt(payload);
  return {
    ...baseMeta,
    prompt,
    input: { payload, strategy },
    inputHash: hashJson({ payload, strategy }),
    promptHash: hashText(prompt),
    promptPreview: clip(prompt.replace(/\s+/g, " "), 220)
  };
}

function splitThreadMergeSummaries(runtime, context, summaries, tokenLimit, chunkSize) {
  const chunks = [];
  let current = [];
  for (const summary of summaries) {
    const candidate = [...current, summary];
    const payload = { ...context.payload, turnSummaries: candidate };
    const prompt = buildMergeThreadTurnsPrompt(payload);
    const estimatedInputTokens = buildPromptStats({ prompt, systemPrompt: getOllamaSystemPrompt(runtime.config) }).estimatedInputTokens;
    if (current.length > 0 && (candidate.length > chunkSize || estimatedInputTokens > tokenLimit)) {
      chunks.push(current);
      current = [summary];
      continue;
    }
    current = candidate;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}

function compactPartialThreadSummaryForMerge(summary, level, chunkNumber) {
  return {
    turnIndex: null,
    date: null,
    userIntent: clip(summary?.summaryTitle || `partial summary L${level}-${chunkNumber}`, 240),
    assistantResponse: clip(summary?.narrative || "", 500),
    outcome: clip(Array.isArray(summary?.outcomes) ? summary.outcomes.join(" / ") : "", 360),
    interests: Array.isArray(summary?.interests) ? summary.interests.slice(0, 8) : [],
    questions: Array.isArray(summary?.questions) ? summary.questions.slice(0, 8) : []
  };
}

function threadMergeInputTokenLimit(runtime) {
  return Number(runtime.config.threadMergeInputTokenLimit || 15000);
}

function threadMergeChunkSize(runtime) {
  return Number(runtime.config.threadMergeChunkSize || 20);
}

async function handleCategories(runtime, meta) {
  const current = readCategoryMaster(runtime);
  const next = normalizeCategoryMaster(runtime, current || { schemaVersion: 2, generatedAt: isoJst(), runId: runtime.config.runId, groups: [] });
  writeCategoryMaster(runtime, {
    ...next,
    aiMeta: {
      model: meta.model,
      think: meta.think,
      promptHash: meta.promptHash,
      inputHash: meta.inputHash,
      provider: "local",
      cacheHit: Boolean(current)
    }
  });
  return ["artifacts/ai/category_master.json", "artifacts/ai/categories.json"];
}

async function handleClassifyThread(runtime, itemId, meta) {
  const thread = readArtifact(runtime, `artifacts/normalized/${itemId}.json`);
  const categories = readCategoryMaster(runtime) || {};
  const response = await askForAdaptiveThreadJson(runtime, { taskKey: "ai.classify_thread", itemId, name: `classify-${itemId}`, model: meta.model, thread, baseInput: { categories, threadId: itemId }, buildPrompt: (payload) => buildClassifyThreadPrompt(categories, payload), mergeParsed: mergeClassificationResults });
  const artifactPaths = [`artifacts/ai/thread_classification/${itemId}.json`, `artifacts/raw/ai.classify_thread/${itemId}.raw.json`];
  const masterUpdated = mergeCategoryMaster(runtime, response.parsed.proposedCategories || [], itemId);
  if (masterUpdated) {
    artifactPaths.push("artifacts/ai/category_master.json", "artifacts/ai/categories.json");
  }
  const primaryGroup = response.parsed.primaryGroup || "other";
  const primaryCategory = response.parsed.primaryCategory || response.parsed.primary || "uncategorized";
  const secondaryCategories = Array.isArray(response.parsed.secondaryCategories)
    ? response.parsed.secondaryCategories
    : Array.isArray(response.parsed.secondary)
      ? response.parsed.secondary
      : [];
  const categoryLabels = new Map((categories.categories || []).map((category) => [category.id, category.label]));
  const groupLabels = new Map((categories.groups || []).map((group) => [group.id, group.label]));
  writeArtifact(runtime, `artifacts/ai/thread_classification/${itemId}.json`, {
    schemaVersion: 2,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    primaryGroup,
    primaryGroupLabel: groupLabels.get(primaryGroup) || primaryGroup,
    primaryCategory,
    primaryCategoryLabel: categoryLabels.get(primaryCategory) || primaryCategory,
    secondaryCategories,
    secondaryCategoryLabels: secondaryCategories.map((categoryId) => categoryLabels.get(categoryId) || categoryId),
    primary: primaryCategory,
    secondary: secondaryCategories,
    reason: response.parsed.reason || "",
    proposedCategories: Array.isArray(response.parsed.proposedCategories) ? response.parsed.proposedCategories : [],
    aiMeta: buildAiMeta(runtime, meta, response, { adaptiveSplit: response.adaptiveSplit, chunkCount: response.chunkCount, categoryMasterUpdated: masterUpdated })
  });
  writeRaw(runtime, "ai.classify_thread", itemId, response.text, response.usage);
  return artifactPaths;
}

async function handleExtractFindings(runtime, itemId, meta) {
  const thread = readArtifact(runtime, `artifacts/normalized/${itemId}.json`);
  const response = await askForAdaptiveThreadJson(runtime, { taskKey: "ai.extract_findings", itemId, name: `findings-${itemId}`, model: meta.model, thread, baseInput: { threadId: itemId }, buildPrompt: (payload) => buildExtractFindingsPrompt(payload), mergeParsed: mergeFindingsResults });
  writeArtifact(runtime, `artifacts/ai/thread_findings/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [], questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [], outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [], images: Array.isArray(response.parsed.images) ? response.parsed.images : [], narrative: response.parsed.narrative || "", aiMeta: buildAiMeta(runtime, meta, response, { adaptiveSplit: response.adaptiveSplit, chunkCount: response.chunkCount }) });
  writeRaw(runtime, "ai.extract_findings", itemId, response.text, response.usage);
  return [`artifacts/ai/thread_findings/${itemId}.json`, `artifacts/raw/ai.extract_findings/${itemId}.raw.json`];
}

function handleGroupUnits(runtime) {
  const classes = loadClassifications(runtime);
  const labels = new Map((readCategoryMaster(runtime)?.categories || []).map((category) => [category.id, category.label]));
  const existing = readArtifact(runtime, "artifacts/units/units.json")?.items || [];
  const allThreads = readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [];
  const scopedThreads = hasThreadFilterScope(runtime.config) ? allThreads.filter((thread) => threadMatchesTargetScopes(thread, runtime.config)) : allThreads;
  const affectedSourceThreads = hasTargetThreadScope(runtime.config)
    ? allThreads.filter((thread) => threadMatchesPositiveTargetScopes(thread, runtime.config))
    : hasThreadExcludeScope(runtime.config) && existing.length > 0
      ? allThreads.filter((thread) => threadMatchesExcludeScopes(thread, runtime.config))
      : scopedThreads;
  const affectedDates = runtime.config.date
    ? new Set([runtime.config.date])
    : new Set(affectedSourceThreads.map((thread) => thread.primaryDate || "unknown"));
  const preserved = runtime.config.grouping === "category"
    ? []
    : existing.filter((unit) => !affectedDates.has(unit.date || "unknown"));
  const buckets = new Map(preserved.map((unit) => [unit.itemId, { ...unit, threadItemIds: [...(unit.threadItemIds || [])] }]));
  for (const thread of allThreads) {
    const date = thread.primaryDate || "unknown";
    if (threadMatchesExcludeScopes(thread, runtime.config)) {
      continue;
    }
    if (runtime.config.grouping !== "category" && affectedDates.size > 0 && !affectedDates.has(date)) {
      continue;
    }
    if (hasThreadFilterScope(runtime.config) && runtime.config.grouping === "category" && !threadMatchesTargetScopes(thread, runtime.config)) {
      continue;
    }
    if (hasThreadFilterScope(runtime.config) && runtime.config.grouping !== "category" && !threadMatchesTargetScopes(thread, runtime.config) && !hasThreadSummaryInputs(runtime, thread.itemId)) {
      continue;
    }
    const classification = classes.get(thread.itemId);
    const category = runtime.config.grouping === "category" ? (classification?.primaryCategory || classification?.primary || "uncategorized") : null;
    const itemId = runtime.config.grouping === "category" ? `unit_category_${category}` : `unit_date_${date}`;
    if (!buckets.has(itemId)) buckets.set(itemId, { itemId, label: runtime.config.grouping === "category" ? (labels.get(category) || category) : `${date} の記録`, date, category, entryId: `entry_${date}`, threadItemIds: [] });
    if (!buckets.get(itemId).threadItemIds.includes(thread.itemId)) {
      buckets.get(itemId).threadItemIds.push(thread.itemId);
    }
  }
  writeArtifact(runtime, "artifacts/units/units.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, unitStrategy: runtime.config.grouping === "category" ? "category" : "date", items: [...buckets.values()].filter((unit) => (unit.threadItemIds || []).length > 0).sort((a, b) => a.itemId.localeCompare(b.itemId, "ja")) });
  return ["artifacts/units/units.json"];
}

async function handleSummarizeUnit(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleSummarizeUnitDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.summarize_unit", itemId, `unit-${itemId}`, meta);
  const unit = readUnit(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/unit_summaries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, label: unit.label, date: unit.date, category: unit.category, summaryTitle: response.parsed.summaryTitle || unit.label, interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [], questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [], outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [], images: Array.isArray(response.parsed.images) ? response.parsed.images : [], narrative: response.parsed.narrative || "", aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.summarize_unit", itemId, response.text, response.usage);
  return [`artifacts/ai/unit_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_unit/${itemId}.raw.json`];
}

async function handleWriteEntry(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleWriteEntryDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.write_diary_entry", itemId, `entry-draft-${itemId}`, meta);
  const entry = readEntry(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: entry.date, title: response.parsed.title || `${entry.date} の日記`, lead: response.parsed.lead || "", sections: Array.isArray(response.parsed.sections) ? response.parsed.sections : [], closing: response.parsed.closing || "", images: Array.isArray(response.parsed.images) ? response.parsed.images : [], aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.write_diary_entry", itemId, response.text, response.usage);
  return [`artifacts/ai/diary_drafts/${itemId}.json`, `artifacts/raw/ai.write_diary_entry/${itemId}.raw.json`];
}

async function handleRewriteEntry(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleRewriteEntryDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.rewrite_diary_entry", itemId, `entry-final-${itemId}`, meta);
  const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`) || {};
  writeArtifact(runtime, `artifacts/ai/diary_entries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: draft.date, title: response.parsed.title || draft.title, markdownBody: response.parsed.markdownBody || draftToMarkdown(draft), images: Array.isArray(response.parsed.images) ? response.parsed.images : draft.images || [], aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.rewrite_diary_entry", itemId, response.text, response.usage);
  return [`artifacts/ai/diary_entries/${itemId}.json`, `artifacts/raw/ai.rewrite_diary_entry/${itemId}.raw.json`];
}

async function handleWriteWeeklySummary(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleWriteWeeklySummaryDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.write_weekly_summary", itemId, `weekly-summary-${itemId}`, meta);
  const weekInput = readWeekInput(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/weekly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    week: weekInput.week,
    entryIds: weekInput.entries.map((entry) => entry.itemId),
    stats: weekInput.stats,
    title: response.parsed.title || `${weekInput.week} の日記`,
    overview: response.parsed.overview || "",
    themes: Array.isArray(response.parsed.themes) ? response.parsed.themes : [],
    notableDays: Array.isArray(response.parsed.notableDays) ? response.parsed.notableDays : [],
    closing: response.parsed.closing || "",
    aiMeta: buildAiMeta(runtime, meta, response)
  });
  writeRaw(runtime, "ai.write_weekly_summary", itemId, response.text, response.usage);
  return [`artifacts/ai/weekly_summaries/${itemId}.json`, `artifacts/raw/ai.write_weekly_summary/${itemId}.raw.json`];
}

async function handleWriteMonthlySummary(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleWriteMonthlySummaryDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.write_monthly_summary", itemId, `monthly-summary-${itemId}`, meta);
  const monthInput = readMonthInput(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/monthly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    month: monthInput.month,
    weekIds: monthInput.weeks.map((week) => `week_${week}`),
    entryIds: monthInput.entries.map((entry) => entry.itemId),
    stats: monthInput.stats,
    title: response.parsed.title || `${monthInput.month} の日記`,
    overview: response.parsed.overview || "",
    themes: Array.isArray(response.parsed.themes) ? response.parsed.themes : [],
    notableWeeks: Array.isArray(response.parsed.notableWeeks) ? response.parsed.notableWeeks : [],
    closing: response.parsed.closing || "",
    aiMeta: buildAiMeta(runtime, meta, response)
  });
  writeRaw(runtime, "ai.write_monthly_summary", itemId, response.text, response.usage);
  return [`artifacts/ai/monthly_summaries/${itemId}.json`, `artifacts/raw/ai.write_monthly_summary/${itemId}.raw.json`];
}

async function handleWriteYearlySummary(runtime, itemId, meta) {
  if (isDeterministicAiMode(runtime)) {
    return handleWriteYearlySummaryDeterministic(runtime, itemId, meta);
  }
  const response = await askForJson(runtime, "ai.write_yearly_summary", itemId, `yearly-summary-${itemId}`, meta);
  const yearInput = readYearInput(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/yearly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    year: yearInput.year,
    monthIds: yearInput.months.map((month) => `month_${month}`),
    stats: yearInput.stats,
    title: response.parsed.title || `${yearInput.year} 年の日記`,
    overview: response.parsed.overview || "",
    themes: Array.isArray(response.parsed.themes) ? response.parsed.themes : [],
    notableMonths: Array.isArray(response.parsed.notableMonths) ? response.parsed.notableMonths : [],
    closing: response.parsed.closing || "",
    aiMeta: buildAiMeta(runtime, meta, response)
  });
  writeRaw(runtime, "ai.write_yearly_summary", itemId, response.text, response.usage);
  return [`artifacts/ai/yearly_summaries/${itemId}.json`, `artifacts/raw/ai.write_yearly_summary/${itemId}.raw.json`];
}

function loadRawThreads(extractDir) {
  const files = walkFiles(extractDir).filter((file) => /^conversations-\d+\.json$/i.test(path.basename(file))).sort();
  const imageIndex = buildImageIndex(extractDir);
  const threads = [];
  for (const file of files) {
    for (const conversation of JSON.parse(fs.readFileSync(file, "utf8"))) {
      const messages = Object.values(conversation.mapping || {}).map((entry) => normalizeMessage(entry?.message, imageIndex)).filter(Boolean).sort((a, b) => a.createTime - b.createTime);
      if (!messages.length) continue;
      const startTime = messages[0].createTime || conversation.create_time || 0;
      const firstUser = messages.find((message) => message.role === "user");
      const gizmoId = conversation.gizmo_id || null;
      const conversationTemplateId = conversation.conversation_template_id || null;
      threads.push({ sourceThreadId: conversation.conversation_id || conversation.id || `thread-${threads.length + 1}`, groupId: gizmoId || conversationTemplateId, gizmoId, conversationTemplateId, gizmoType: conversation.gizmo_type || null, title: conversation.title || "Untitled", createTime: conversation.create_time || startTime, updateTime: conversation.update_time || startTime, primaryDate: dateKey(startTime), messageCount: messages.length, userMessageCount: messages.filter((message) => message.role === "user").length, assistantMessageCount: messages.filter((message) => message.role === "assistant").length, generatedImageCount: messages.reduce((sum, message) => sum + message.generatedImages.length, 0), preview: clip(firstUser?.text ?? messages[0]?.text ?? "", 300), sourceFile: path.relative(extractDir, file).replaceAll("\\", "/"), messages });
    }
  }
  return threads;
}

function normalizeMessage(message, imageIndex) {
  if (!message || typeof message.create_time !== "number") return null;
  const content = message.content || {};
  const parts = Array.isArray(content.parts) ? content.parts.map((part) => typeof part === "string" ? { type: "text", text: part } : (part || { type: "unknown" })) : [];
  const text = content.content_type === "execution_output" ? (content.text || "") : parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
  const attachments = (message.metadata?.attachments || []).filter((attachment) => /^image\//.test(attachment.mime_type || "")).map((attachment) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mime_type, width: attachment.width || null, height: attachment.height || null, path: imageIndex.byId.get(attachment.id) || null }));
  const generatedImages = [...parts.filter((part) => part?.content_type === "image_asset_pointer" && typeof part.asset_pointer === "string").map((part) => { const fileId = part.asset_pointer.replace("file-service://", ""); return { id: fileId, prompt: part.metadata?.dalle?.prompt || null, width: part.width || null, height: part.height || null, path: imageIndex.byId.get(fileId) || null }; }), ...(message.metadata?.aggregate_result?.messages || []).filter((candidate) => candidate.message_type === "image" && typeof candidate.image_url === "string").map((candidate) => { const fileId = candidate.image_url.replace("file-service://", ""); return { id: fileId, prompt: null, width: candidate.width || null, height: candidate.height || null, path: imageIndex.byId.get(fileId) || null }; })];
  return { id: message.id, role: message.author?.role || "unknown", authorName: message.author?.name || null, createTime: message.create_time, date: dateKey(message.create_time), contentType: content.content_type || "unknown", text, attachments, generatedImages, hasImageAttachment: attachments.length > 0, hasGeneratedImage: generatedImages.length > 0 };
}

function buildImageIndex(extractDir) {
  const byId = new Map();
  for (const file of walkFiles(extractDir)) {
    const relative = path.relative(extractDir, file).replaceAll("\\", "/");
    const match = relative.match(/(file-[A-Za-z0-9]+)(?=[^/]*\.(png|jpg|jpeg|webp)$)/i) || path.basename(file).match(/^(file-[A-Za-z0-9]+)/i);
    if (match) byId.set(match[1], file);
  }
  return { byId };
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function uniqueStrings(values) { return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))]; }
function dedupeObjects(values, keyFn) { const seen = new Set(); const items = []; for (const value of values || []) { const key = keyFn(value); if (seen.has(key)) continue; seen.add(key); items.push(value); } return items; }
function normalizeQuestionKey(text) { return String(text || "").trim().toLowerCase(); }
function normalizeQuestionStatus(status) { return ["resolved", "partially_resolved", "unresolved"].includes(status) ? status : "unresolved"; }
function compareQuestionStatus(left, right) { const rank = { unresolved: 0, partially_resolved: 1, resolved: 2 }; return (rank[normalizeQuestionStatus(left)] || 0) - (rank[normalizeQuestionStatus(right)] || 0); }
function readArtifact(runtime, relativePath) { return readJson(path.join(runtime.paths.root, relativePath)); }
function writeArtifact(runtime, relativePath, value) { writeJson(path.join(runtime.paths.root, relativePath), value); }


function readUnit(runtime, itemId) { const item = (readArtifact(runtime, "artifacts/units/units.json")?.items || []).find((candidate) => candidate.itemId === itemId); if (!item) throw new Error(`unit が見つかりません: ${itemId}`); return item; }
function readEntry(runtime, itemId) { const units = (readArtifact(runtime, "artifacts/units/units.json")?.items || []).filter((unit) => unit.entryId === itemId); if (!units.length) throw new Error(`entry が見つかりません: ${itemId}`); return { itemId, date: units[0].date || itemId.replace(/^entry_/, ""), units, unitSummaries: units.map((unit) => readArtifact(runtime, `artifacts/ai/unit_summaries/${unit.itemId}.json`)).filter(Boolean) }; }
function readThread(runtime, itemId) { const item = readArtifact(runtime, `artifacts/normalized/${itemId}.json`); if (!item) throw new Error(`thread が見つかりません: ${itemId}`); return item; }
function readTurn(runtime, itemId) { const item = readArtifact(runtime, `artifacts/turns/${itemId}.json`); if (!item) throw new Error(`turn が見つかりません: ${itemId}`); return item; }
function loadThreads(runtime) { return (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => readArtifact(runtime, `artifacts/normalized/${thread.itemId}.json`)).filter(Boolean); }
function loadScopedThreads(runtime) {
  const threads = loadThreads(runtime);
  if (!hasThreadFilterScope(runtime.config)) {
    return threads;
  }
  return threads.filter((thread) => threadMatchesTargetScopes(thread, runtime.config));
}
function loadScopedThreadIndex(runtime) {
  const threads = readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [];
  if (!hasThreadFilterScope(runtime.config)) {
    return threads;
  }
  return threads.filter((thread) => threadMatchesTargetScopes(thread, runtime.config));
}
function loadTurns(runtime) {
  return (readArtifact(runtime, "artifacts/indexes/turn-index.json")?.turns || [])
    .filter((turn) => isNonEmptyTurnItem(runtime, turn));
}
function loadTurnsForThread(runtime, threadItemId) { return loadTurns(runtime).filter((turn) => turn.threadItemId === threadItemId); }
function isNonEmptyTurnItem(runtime, turnMeta) {
  const turn = readArtifact(runtime, `artifacts/turns/${turnMeta.itemId}.json`);
  if (!turn) {
    return false;
  }
  return isNonEmptyTurnGroup(turn);
}
function hasThreadSummaryInputs(runtime, threadItemId) {
  return Boolean(
    readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`)
    && readArtifact(runtime, `artifacts/ai/thread_findings/${threadItemId}.json`)
  );
}
function loadClassifications(runtime) { return new Map((readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => [thread.itemId, readArtifact(runtime, `artifacts/ai/thread_classification/${thread.itemId}.json`)]).filter(([, value]) => value)); }
function loadScopedClassifications(runtime) {
  const entries = [...loadClassifications(runtime).entries()];
  if (!hasThreadFilterScope(runtime.config)) {
    return new Map(entries);
  }
  return new Map(entries.filter(([threadItemId]) => threadItemMatchesTargetScopes(runtime, threadItemId)));
}
function hasThreadFilterScope(config) {
  return hasTargetThreadScope(config) || hasThreadExcludeScope(config);
}
function hasTargetThreadScope(config) {
  return Boolean(
    config?.targetThreadItemIds?.length
    || config?.targetDates?.length
    || config?.targetWeeks?.length
    || config?.targetMonths?.length
    || config?.targetYears?.length
  );
}
function hasThreadExcludeScope(config) {
  return Boolean(
    config?.excludeThreadItemIds?.length
    || config?.excludeSourceThreadIds?.length
    || config?.excludeGroupIds?.length
  );
}
function threadItemMatchesTargetScopes(runtime, threadItemId) {
  const thread = (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).find((candidate) => candidate.itemId === threadItemId);
  return threadMatchesTargetScopes(thread, runtime.config);
}
function threadMatchesTargetScopes(thread, config) {
  if (!thread) {
    return false;
  }
  if (threadMatchesExcludeScopes(thread, config)) {
    return false;
  }
  return threadMatchesPositiveTargetScopes(thread, config);
}
function threadMatchesPositiveTargetScopes(thread, config) {
  if (!thread) {
    return false;
  }
  const allow = new Set(config?.targetThreadItemIds || []);
  if (allow.size > 0 && !allow.has(thread.itemId)) {
    return false;
  }
  const primaryDate = String(thread.primaryDate || "");
  const targetDates = new Set(config?.targetDates || []);
  if (targetDates.size > 0 && !targetDates.has(primaryDate)) {
    return false;
  }
  const targetMonths = new Set(config?.targetMonths || []);
  if (targetMonths.size > 0 && !targetMonths.has(primaryDate.slice(0, 7))) {
    return false;
  }
  const targetYears = new Set(config?.targetYears || []);
  if (targetYears.size > 0 && !targetYears.has(primaryDate.slice(0, 4))) {
    return false;
  }
  const targetWeeks = new Set(config?.targetWeeks || []);
  if (targetWeeks.size > 0 && !targetWeeks.has(monthWeekKey(primaryDate))) {
    return false;
  }
  return true;
}
function threadMatchesExcludeScopes(thread, config) {
  if (!thread) {
    return false;
  }
  const excludedThreadItemIds = new Set(config?.excludeThreadItemIds || []);
  if (excludedThreadItemIds.has(thread.itemId)) {
    return true;
  }
  const excludedSourceThreadIds = new Set(config?.excludeSourceThreadIds || []);
  if (excludedSourceThreadIds.has(thread.sourceThreadId)) {
    return true;
  }
  const excludedGroupIds = new Set(config?.excludeGroupIds || []);
  if (excludedGroupIds.size > 0) {
    const groupIds = [thread.groupId, thread.gizmoId, thread.conversationTemplateId].filter(Boolean);
    if (groupIds.some((groupId) => excludedGroupIds.has(groupId))) {
      return true;
    }
  }
  return false;
}
function monthWeekKey(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return null;
  }
  const [year, month, day] = String(date).split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const targetDayOfWeek = target.getUTCDay() || 7;
  const weekMonday = new Date(target);
  weekMonday.setUTCDate(target.getUTCDate() - (targetDayOfWeek - 1));
  const weekSunday = new Date(weekMonday);
  weekSunday.setUTCDate(weekMonday.getUTCDate() + 6);
  const anchorYear = weekSunday.getUTCFullYear();
  const anchorMonth = weekSunday.getUTCMonth() + 1;
  const monthStart = new Date(Date.UTC(anchorYear, anchorMonth - 1, 1));
  const monthStartDayOfWeek = monthStart.getUTCDay() || 7;
  const firstWeekMonday = new Date(monthStart);
  firstWeekMonday.setUTCDate(monthStart.getUTCDate() - (monthStartDayOfWeek - 1));
  const diffDays = Math.floor((weekMonday - firstWeekMonday) / 86400000);
  const weekOfMonth = Math.floor(diffDays / 7) + 1;
  return `${anchorYear}-${String(anchorMonth).padStart(2, "0")}-W${weekOfMonth}`;
}
function loadDiaryEntries(runtime) { const entryIds = [...new Set((readArtifact(runtime, "artifacts/units/units.json")?.items || []).map((unit) => unit.entryId).filter(Boolean))]; return entryIds.map((entryId) => readArtifact(runtime, `artifacts/ai/diary_entries/${entryId}.json`)).filter(Boolean); }
function loadWeeklySummaries(runtime) { return enumerateWeekItems(runtime).map((item) => readArtifact(runtime, `artifacts/ai/weekly_summaries/${item.itemId}.json`)).filter(Boolean); }
function loadMonthlySummaries(runtime) { return enumerateMonthItems(runtime).map((item) => readArtifact(runtime, `artifacts/ai/monthly_summaries/${item.itemId}.json`)).filter(Boolean); }
function loadYearlySummaries(runtime) { return enumerateYearItems(runtime).map((item) => readArtifact(runtime, `artifacts/ai/yearly_summaries/${item.itemId}.json`)).filter(Boolean); }
function getChangedEntryIds(runtime) {
  const changed = new Set();
  for (const instanceId of runtime.changed || []) {
    if (instanceId.startsWith("ai.rewrite_diary_entry__") || instanceId.startsWith("ai.write_diary_entry__")) {
      changed.add(instanceId.split("__")[1]);
      continue;
    }
    if (instanceId.startsWith("ai.summarize_unit__")) {
      const unitItemId = instanceId.split("__")[1];
      const unit = readUnit(runtime, unitItemId);
      if (unit?.entryId) {
        changed.add(unit.entryId);
      }
    }
  }
  return changed;
}
function emitEvent(runtime, payload) { fs.appendFileSync(runtime.paths.events, `${JSON.stringify({ at: isoJst(), runId: runtime.config.runId, ...payload })}\n`, "utf8"); runtime.current.lastEvent = payload.type || null; runtime.current.note = payload.note || null; }
configureTaskState({
  taskInstanceId,
  readTurn,
  loadTurnsForThread,
  readArtifact,
  threadMatchesTargetScopes,
  hasThreadSummaryInputs,
  readUnit,
  readEntry,
  readWeekInput,
  readMonthInput,
  readYearInput,
  loadDiaryEntries,
  enumerateWeekItems,
  enumerateMonthItems,
  enumerateYearItems,
  sameArray,
  writeState,
  readCategoryMaster,
  threadItemMatchesTargetScopes,
  hasThreadFilterScope,
  monthWeekKey
});

configureTaskMeta({
  readArtifact,
  hashJson,
  fileStat,
  walkFiles,
  loadThreads,
  normalizeCategoryGroups,
  readTurn,
  compactTurnForAi,
  renderPromptTemplate,
  readCategoryMaster,
  buildThreadMergeContext,
  buildMergeThreadTurnsPrompt,
  buildPromptStats,
  getOllamaSystemPrompt,
  threadMergeInputTokenLimit,
  hashText,
  threadMergeChunkSize,
  loadScopedThreadIndex,
  loadScopedClassifications,
  readUnit,
  hasThreadSummaryInputs,
  compactUnitForAi,
  compactThreadInputsForUnit,
  readEntry,
  compactEntryForAi,
  compactDiaryDraftForAi,
  readWeekInput,
  compactArchiveStatsForAi,
  compactDiaryEntryForArchiveSummary,
  readMonthInput,
  compactWeekSummaryForMonthlySummary,
  readYearInput,
  compactMonthSummaryForYearlySummary,
  loadDiaryEntries,
  loadWeeklySummaries,
  loadMonthlySummaries,
  loadYearlySummaries,
  resolveModelForTask,
  resolveThinkForTask,
  clip
});

configureAiJson({
  ensureDir,
  readJson,
  writeJson,
  getAppServerClient,
  emitEvent,
  writeProgress,
  logTextBlock,
  getOllamaSystemPrompt,
  logThinkingConsole,
  logResponseDeltaConsole,
  logTaskProgressConsole,
  flushResponseDeltaConsole,
  normalizeAiUsage,
  isoJst,
  clip,
  sleep,
  logConsole,
  writeArtifact
});

configureAgentClient({
  clip,
  isoJst,
  ensureDir,
  sleep,
  buildPromptStats,
  formatDuration
});

configureRenderHandlers({
  readArtifact,
  writeArtifact,
  isoJst,
  loadDiaryEntries,
  loadWeeklySummaries,
  loadMonthlySummaries,
  loadYearlySummaries,
  readCategoryMaster,
  ensureDir,
  findChromiumBrowser,
  execFileAsync,
  fileStat,
  estimateInputTokens,
  sanitizeId,
  getChangedEntryIds,
  monthWeekKey,
  fileUrl,
  formatInteger
});

configureCategoryHelpers({
  readArtifact,
  writeArtifact,
  isoJst,
  sanitizeId,
  uniqueStrings,
  emitEvent,
  logConsole
});

configureDeterministicHandlers({
  readTurn,
  readArtifact,
  writeArtifact,
  isoJst,
  buildLocalAiMeta,
  writeRaw,
  readCategoryMaster,
  mergeClassificationResults,
  buildThreadMergeContext,
  readUnit,
  hasThreadSummaryInputs,
  compactThreadInputsForUnit,
  readEntry,
  draftToMarkdown,
  readWeekInput,
  readMonthInput,
  readYearInput,
  loadDiaryEntries,
  defaultCategoryGroups,
  uniqueStrings,
  clip,
  dedupeObjects
});

function writeProgress(runtime, override = {}) { const started = new Date(runtime.startedAt); writeJson(runtime.paths.progress, { schemaVersion: 1, runId: runtime.config.runId, status: override.status ?? "running", stage: override.stage ?? runtime.current.stage, taskKey: override.taskKey ?? runtime.current.taskKey, itemType: override.itemType ?? runtime.current.itemType, currentItemId: override.currentItemId ?? runtime.current.itemId, currentTaskInstanceId: override.currentTaskInstanceId ?? runtime.current.taskInstanceId, counts: { ...runtime.counts }, startedAt: runtime.startedAt, updatedAt: isoJst(), elapsedSec: Number.isNaN(started.getTime()) ? 0 : Math.max(Math.floor((Date.now() - started.getTime()) / 1000), 0), lastEvent: override.lastEvent ?? runtime.current.lastEvent, promptPreview: override.promptPreview ?? runtime.current.promptPreview, promptStats: override.promptStats ?? runtime.current.promptStats, sentAt: override.sentAt ?? runtime.current.sentAt, note: override.note ?? runtime.current.note }); }
function logConsole(label, target, note = "") { ensureStreamConsoleClosed(); const suffix = note ? ` ${note}` : ""; console.log(`${consoleTime()} [${label}] ${target}${suffix}`); }
function logTaskProgressConsole(runtime) {
  ensureStreamConsoleClosed();
  const taskDone = runtime.counts.completed + runtime.counts.skipped + runtime.counts.failed + runtime.counts.running;
  const taskTotal = runtime.counts.total || 0;
  const taskText = `tasks ${taskDone}/${taskTotal} ${progressBar(taskDone, taskTotal)}`;
  const thread = currentThreadProgress(runtime);
  const threadText = thread
    ? `threads ${thread.current}/${thread.total} ${progressBar(thread.current, thread.total)} current=${thread.itemId}${thread.title ? ` ${clip(thread.title, 48)}` : ""}`
    : "threads -";
  const eta = currentTaskEta(runtime);
  const etaText = eta
    ? `avg=${formatDuration(eta.averageMs)} eta=${formatDuration(eta.remainingMs)} finish=${formatClockTime(new Date(Date.now() + eta.remainingMs))} samples=${eta.samples}`
    : "avg=- eta=-";
  const inputText = formatPromptStats(runtime.current.promptStats);
  logConsole("progress", runtime.current.taskInstanceId || "run", `${taskText} ${threadText} ${etaText} ${inputText}`);
}
function currentTaskEta(runtime) {
  const taskKey = runtime.current.taskKey;
  if (!taskKey) {
    return null;
  }
  const samples = runtime.taskDurations.completedMsByTaskKey.get(taskKey) || [];
  if (!samples.length) {
    return null;
  }
  const averageMs = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  const remaining = plannedRemainingForTaskKey(runtime, taskKey);
  return { averageMs, remainingMs: averageMs * remaining, remaining, samples: samples.length };
}
function plannedRemainingForTaskKey(runtime, taskKey) {
  let remaining = 0;
  const prefix = `${taskKey}__`;
  for (const instanceId of runtime.planned) {
    if (!instanceId.startsWith(prefix)) {
      continue;
    }
    const state = readStateByInstanceId(runtime, instanceId);
    if (!["completed", "skipped"].includes(state?.status)) {
      remaining += 1;
    }
  }
  return remaining;
}
function readStateByInstanceId(runtime, instanceId) {
  return readJson(path.join(runtime.paths.state, `${instanceId}.json`));
}
function currentThreadProgress(runtime) {
  const currentThreadItemId = currentThreadItemIdForProgress(runtime);
  if (!currentThreadItemId) {
    return null;
  }
  const scopedThreads = loadScopedThreadIndex(runtime);
  const allThreads = readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [];
  const threads = scopedThreads.length ? scopedThreads : allThreads;
  const index = threads.findIndex((thread) => thread.itemId === currentThreadItemId);
  const fallbackIndex = allThreads.findIndex((thread) => thread.itemId === currentThreadItemId);
  const thread = index >= 0 ? threads[index] : allThreads[fallbackIndex];
  const total = threads.length || allThreads.length || 0;
  const current = index >= 0 ? index + 1 : fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
  return thread ? { itemId: thread.itemId, title: thread.title || "", current, total } : null;
}
function currentThreadItemIdForProgress(runtime) {
  if (runtime.current.itemType === "thread") {
    return runtime.current.itemId;
  }
  if (runtime.current.itemType === "turn") {
    return runtime.current.itemMeta?.threadItemId || String(runtime.current.itemId || "").match(/^(thread_\d+)_turn_\d+$/)?.[1] || null;
  }
  const threadItemIds = runtime.current.itemMeta?.threadItemIds || [];
  return threadItemIds.length === 1 ? threadItemIds[0] : null;
}
function progressBar(current, total, width = 20) {
  if (!total || total <= 0) {
    return "[--------------------]   0.0%";
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${(ratio * 100).toFixed(1).padStart(5, " ")}%`;
}
function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
function formatClockTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}
function buildPromptStats({ prompt = "", systemPrompt = "" } = {}) {
  const promptText = String(prompt || "");
  const systemText = String(systemPrompt || "");
  const systemTokensEstimate = estimateInputTokens(systemText);
  const promptTokensEstimate = estimateInputTokens(promptText);
  const systemBytes = Buffer.byteLength(systemText, "utf8");
  const promptBytes = Buffer.byteLength(promptText, "utf8");
  return {
    estimate: true,
    systemTokensEstimate,
    promptTokensEstimate,
    estimatedInputTokens: systemTokensEstimate + promptTokensEstimate,
    systemChars: systemText.length,
    promptChars: promptText.length,
    totalChars: systemText.length + promptText.length,
    systemBytes,
    promptBytes,
    totalBytes: systemBytes + promptBytes
  };
}
function estimateInputTokens(text) {
  const value = String(text || "");
  if (!value) {
    return 0;
  }
  const asciiChars = (value.match(/[\x00-\x7F]/g) || []).length;
  const nonAsciiChars = value.length - asciiChars;
  return Math.ceil(asciiChars / 4 + nonAsciiChars * 0.8);
}
function formatPromptStats(stats) {
  if (!stats) {
    return "input=-";
  }
  return `input≈${formatInteger(stats.estimatedInputTokens)}tok chars=${formatInteger(stats.totalChars)} bytes=${formatBytes(stats.totalBytes)}`;
}
function formatInteger(value) {
  return Number(value || 0).toLocaleString("en-US");
}
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)}MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${value}B`;
}
function logTextBlock(label, target, text) {
  ensureStreamConsoleClosed();
  console.log(`${consoleTime()} [${label}] ${target}`);
  console.log(String(text ?? "").trim());
}
function logThinkingConsole(taskKey, itemId, thinkingText) {
  logStreamConsole("think", taskKey, itemId, thinkingText);
}
function logResponseDeltaConsole(taskKey, itemId, text) {
  logStreamConsole("delta", taskKey, itemId, text);
}
function logStreamConsole(label, taskKey, itemId, text) {
  const key = `${taskKey}__${itemId}`;
  const chunk = String(text ?? "");
  if (!chunk) {
    return;
  }
  if (activeStreamConsoleKey !== key || activeStreamConsoleLabel !== label) {
    ensureStreamConsoleClosed();
    activeStreamConsoleKey = key;
    activeStreamConsoleLabel = label;
    activeStreamConsoleTrailingNewline = true;
    console.log(`${consoleTime()} [${label}] ${key}`);
  }
  process.stdout.write(chunk);
  activeStreamConsoleTrailingNewline = /[\r\n]$/.test(chunk);
}
function flushResponseDeltaConsole(taskKey, itemId) {
  const key = `${taskKey}__${itemId}`;
  if (activeStreamConsoleKey !== key) {
    return;
  }
  ensureStreamConsoleClosed();
}
function ensureStreamConsoleClosed() {
  if (!activeStreamConsoleKey) {
    return;
  }
  if (!activeStreamConsoleTrailingNewline) {
    process.stdout.write("\n");
  }
  activeStreamConsoleKey = null;
  activeStreamConsoleLabel = null;
  activeStreamConsoleTrailingNewline = true;
}
function taskInstanceId(taskKey, itemId) { return `${taskKey}__${itemId}`; }
function aiCacheKey(taskKey, meta) { return crypto.createHash("sha256").update(JSON.stringify({ taskKey, model: meta.model, think: meta.think ?? null, inputHash: meta.inputHash, promptHash: meta.promptHash, taskVersion: 1, outputSchemaVersion: 1 })).digest("hex"); }
function resolveModelForTask(runtime, taskKey) { return runtime.config.taskModels?.[taskKey] || runtime.config.model; }
function resolveThinkForTask(runtime, taskKey) {
  const taskThink = runtime.config.taskThinks?.[taskKey];
  if (typeof taskThink === "boolean") {
    return taskThink;
  }
  const provider = resolveRuntimeProvider(runtime.config);
  if (provider !== "ollama") {
    return null;
  }
  const runtimeThink = runtime.config.runtime?.ollama?.think;
  return typeof runtimeThink === "boolean" ? runtimeThink : null;
}
function readState(runtime, taskKey, itemId) { return readJson(path.join(runtime.paths.state, `${taskKey}__${itemId}.json`)); }
function writeState(runtime, definition, itemId, patch) { writeJson(path.join(runtime.paths.state, `${definition.taskKey}__${itemId}.json`), { schemaVersion: 1, runId: runtime.config.runId, taskKey: definition.taskKey, itemType: definition.itemType, itemId, taskVersion: 1, outputSchemaVersion: 1, ...patch }); }
function listZipEntries(zipPath) { return execFileAsync("tar", ["-tf", zipPath], { windowsHide: true, maxBuffer: 1024 * 1024 * 64 }).then(({ stdout }) => stdout.split(/\r?\n/).filter(Boolean)); }
function fileUrl(filePath) { return `file:///${path.resolve(filePath).replaceAll("\\", "/")}`; }
function dateKey(unixTimeSeconds) { return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unixTimeSeconds * 1000)); }
function isoJst(date = new Date()) { const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`; }
function consoleTime(date = new Date()) { const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`; }
function readJson(filePath) { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null; }
function writeJson(filePath, value) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8"); }
function walkFiles(target) { if (!fs.existsSync(target)) return []; const entries = fs.readdirSync(target, { withFileTypes: true }); return entries.flatMap((entry) => entry.isDirectory() ? walkFiles(path.join(target, entry.name)) : [path.join(target, entry.name)]); }
function ensureDir(target) { fs.mkdirSync(target, { recursive: true }); }
function sanitizeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, "_"); }
function hashJson(value) { return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function hashText(value) { return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`; }
function sameArray(left, right) { const sortedLeft = [...left].sort(); const sortedRight = [...right].sort(); return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]); }
function clip(text, max) { return !text ? "" : (text.length <= max ? text : `${text.slice(0, max)}...`); }
function fileStat(filePath) { if (!filePath || !fs.existsSync(filePath)) return null; const stat = fs.statSync(filePath); return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }; }
function rel(runtime, fullPath) { return path.relative(runtime.paths.root, fullPath).replaceAll("\\", "/"); }
async function findChromiumBrowser() { for (const candidate of [process.env.EDGE_PATH, process.env.CHROME_PATH, "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean)) if (fs.existsSync(candidate)) return candidate; return null; }
