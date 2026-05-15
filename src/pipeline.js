import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { marked } from "marked";
import { TASK_DEFINITIONS } from "./task-definitions.js";

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

async function buildTaskMeta(runtime, definition, item) {
  const readThread = (itemId) => readArtifact(runtime, `artifacts/normalized/${itemId}.json`);
  switch (definition.taskKey) {
    case "prepare.extract_export":
      return { inputHash: hashJson({ zipPath: runtime.config.zipPath, zipStat: fileStat(runtime.config.zipPath) }), promptHash: null, model: null, promptPreview: null };
    case "prepare.scan_export":
      return { inputHash: hashJson({ files: walkFiles(runtime.paths.extracted).map((file) => path.relative(runtime.paths.extracted, file).replaceAll("\\", "/")).sort() }), promptHash: null, model: null, promptPreview: null };
    case "prepare.build_thread_index":
      return { inputHash: hashJson({ schema: "thread-index-v2", manifest: readArtifact(runtime, "artifacts/manifest/export-manifest.json") || {} }), promptHash: null, model: null, promptPreview: null };
    case "analyze.normalize_threads":
      return { inputHash: hashJson(readArtifact(runtime, "artifacts/indexes/thread-index.json") || {}), promptHash: null, model: null, promptPreview: null };
      case "analyze.attach_images":
        return { inputHash: hashJson(loadThreads(runtime).map((thread) => ({ itemId: thread.itemId, attachments: thread.messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0), generatedImages: thread.messages.reduce((sum, message) => sum + (message.generatedImages?.length || 0), 0) }))), promptHash: null, model: null, promptPreview: null };
      case "ai.generate_category_candidates": {
        const groups = normalizeCategoryGroups(runtime.config.categoryGroups);
        return {
          inputHash: hashJson({ schema: "category-master-v2", groups }),
          promptHash: null,
          model: null,
          promptPreview: null
        };
      }
      case "analyze.split_thread_turns": {
        const thread = readThread(runtime, item.itemId);
        return { inputHash: hashJson(thread), promptHash: null, model: null, promptPreview: null };
      }
      case "ai.summarize_turn": {
        const turn = compactTurnForAi(readTurn(runtime, item.itemId));
        const prompt = renderPromptTemplate("ai.summarize_turn", {
          payloadJson: JSON.stringify(turn, null, 2)
        });
        return aiMeta(runtime, prompt, turn);
      }
      case "ai.classify_turn": {
        const turn = compactTurnForAi(readTurn(runtime, item.itemId));
        const categories = readCategoryMaster(runtime) || {};
        const prompt = renderPromptTemplate("ai.classify_thread", {
          categoryGroupsJson: JSON.stringify(categories.groups || [], null, 2),
          flatCategoriesJson: JSON.stringify(categories.categories || [], null, 2),
          payloadJson: JSON.stringify(turn, null, 2)
        });
        return aiMeta(runtime, prompt, { categories, turn });
      }
      case "ai.merge_thread_turns": {
        const context = buildThreadMergeContext(runtime, item.itemId);
        const prompt = buildMergeThreadTurnsPrompt(context.payload);
        const promptStats = buildPromptStats({ prompt, systemPrompt: getOllamaSystemPrompt(runtime.config) });
        const tokenLimit = threadMergeInputTokenLimit(runtime);
        if (promptStats.estimatedInputTokens > tokenLimit) {
          const templateHash = hashText(renderPromptTemplate("ai.merge_thread_turns", { payloadJson: "" }));
          const strategy = {
            mode: "chunked",
            estimatedInputTokens: promptStats.estimatedInputTokens,
            tokenLimit,
            chunkSize: threadMergeChunkSize(runtime),
            templateHash
          };
          return aiMeta(runtime, `chunked ai.merge_thread_turns ${JSON.stringify(strategy)}`, { ...context.input, strategy });
        }
        return aiMeta(runtime, prompt, context.input);
      }
      case "analyze.group_units":
        return {
          inputHash: hashJson({
            grouping: runtime.config.grouping,
            targetThreadItemIds: runtime.config.targetThreadItemIds || null,
            targetDates: runtime.config.targetDates || null,
            targetWeeks: runtime.config.targetWeeks || null,
            targetMonths: runtime.config.targetMonths || null,
            targetYears: runtime.config.targetYears || null,
            excludeThreadItemIds: runtime.config.excludeThreadItemIds || null,
            excludeSourceThreadIds: runtime.config.excludeSourceThreadIds || null,
            excludeGroupIds: runtime.config.excludeGroupIds || null,
            threads: loadScopedThreadIndex(runtime),
            classifications: [...loadScopedClassifications(runtime).entries()]
          }),
          promptHash: null,
          model: null,
          promptPreview: null
        };
      case "ai.summarize_unit": {
        const unit = readUnit(runtime, item.itemId);
        const availableThreadItemIds = (unit.threadItemIds || []).filter((threadItemId) => hasThreadSummaryInputs(runtime, threadItemId));
        const payload = {
          grouping: runtime.config.grouping,
          unit: compactUnitForAi(unit, availableThreadItemIds),
          threads: availableThreadItemIds.map((threadItemId) => compactThreadInputsForUnit(runtime, threadItemId)).filter(Boolean)
        };
        const prompt = renderPromptTemplate("ai.summarize_unit", {
          unitId: unit.itemId,
          unitLabel: unit.label,
          payloadJson: JSON.stringify(payload, null, 2)
        });
        return aiMeta(runtime, prompt, payload);
      }
    case "ai.write_diary_entry": {
      const entry = readEntry(runtime, item.itemId);
      const payload = compactEntryForAi(entry);
      const prompt = renderPromptTemplate("ai.write_diary_entry", {
        entryId: entry.itemId,
        entryDate: entry.date,
        entryJson: JSON.stringify(payload, null, 2)
      });
      return aiMeta(runtime, prompt, payload);
    }
    case "ai.rewrite_diary_entry": {
      const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${item.itemId}.json`) || {};
      const payload = compactDiaryDraftForAi(draft);
      const prompt = renderPromptTemplate("ai.rewrite_diary_entry", {
        draftJson: JSON.stringify(payload, null, 2)
      });
      return aiMeta(runtime, prompt, payload);
    }
    case "ai.write_weekly_summary": {
      const weekInput = readWeekInput(runtime, item.itemId);
      const payload = {
        week: weekInput.week,
        stats: compactArchiveStatsForAi(weekInput.stats),
        entries: weekInput.entries.map((entry) => compactDiaryEntryForArchiveSummary(entry))
      };
      const prompt = renderPromptTemplate("ai.write_weekly_summary", {
        weekId: item.itemId,
        week: weekInput.week,
        weekJson: JSON.stringify(payload, null, 2)
      });
      return aiMeta(runtime, prompt, payload);
    }
    case "ai.write_monthly_summary": {
      const monthInput = readMonthInput(runtime, item.itemId);
      const payload = {
        month: monthInput.month,
        stats: compactArchiveStatsForAi(monthInput.stats),
        weeks: monthInput.weeklySummaries.map((summary) => compactWeekSummaryForMonthlySummary(summary))
      };
      const prompt = renderPromptTemplate("ai.write_monthly_summary", {
        monthId: item.itemId,
        month: monthInput.month,
        monthJson: JSON.stringify(payload, null, 2)
      });
      return aiMeta(runtime, prompt, payload);
    }
    case "ai.write_yearly_summary": {
      const yearInput = readYearInput(runtime, item.itemId);
      const payload = {
        year: yearInput.year,
        stats: compactArchiveStatsForAi(yearInput.stats),
        months: yearInput.monthlySummaries.map((summary) => compactMonthSummaryForYearlySummary(summary))
      };
      const prompt = renderPromptTemplate("ai.write_yearly_summary", {
        yearId: item.itemId,
        year: yearInput.year,
        yearJson: JSON.stringify(payload, null, 2)
      });
      return aiMeta(runtime, prompt, payload);
    }
    case "render.markdown":
      return { inputHash: hashJson({ grouping: runtime.config.grouping, entries: loadDiaryEntries(runtime), weeklySummaries: loadWeeklySummaries(runtime), monthlySummaries: loadMonthlySummaries(runtime), yearlySummaries: loadYearlySummaries(runtime) }), promptHash: null, model: null, promptPreview: null };
    case "render.html":
      return { inputHash: hashJson(readArtifact(runtime, "artifacts/render/diary.json") || {}), promptHash: null, model: null, promptPreview: null };
    case "render.pdf":
      return { inputHash: hashJson(fileStat(path.join(runtime.paths.root, "artifacts", "render", "diary.html"))), promptHash: null, model: null, promptPreview: null };
    default:
      return { inputHash: hashJson({ taskKey: definition.taskKey, itemId: item.itemId }), promptHash: null, model: null, promptPreview: null };
  }
}

function aiMeta(runtime, prompt, input) {
  return {
    prompt,
    input,
    inputHash: hashJson(input),
    promptHash: hashText(prompt),
    model: resolveModelForTask(runtime, runtime.current.taskKey),
    think: resolveThinkForTask(runtime, runtime.current.taskKey),
    promptPreview: clip(prompt.replace(/\s+/g, " "), 220)
  };
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

function readCategoryMaster(runtime) {
  const value = readArtifact(runtime, "artifacts/ai/category_master.json") || readArtifact(runtime, "artifacts/ai/categories.json") || null;
  return value ? normalizeCategoryMaster(runtime, value) : null;
}

function writeCategoryMaster(runtime, value) {
  const normalized = normalizeCategoryMaster(runtime, value);
  writeArtifact(runtime, "artifacts/ai/category_master.json", normalized);
  writeArtifact(runtime, "artifacts/ai/categories.json", normalized);
}

function readCategorySuggestions(runtime) {
  return readArtifact(runtime, "artifacts/ai/category_suggestions.json") || { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, items: [] };
}

function writeCategorySuggestions(runtime, value) {
  writeArtifact(runtime, "artifacts/ai/category_suggestions.json", value);
}

function defaultCategoryGroups() {
  return [
    { id: "work", label: "仕事", description: "仕事として進めた依頼、業務、調査、制作に関するまとまり。", keywords: ["仕事", "業務", "依頼"] },
    { id: "technology", label: "技術", description: "プログラミング、ツール、AI、システム利用に関するまとまり。", keywords: ["技術", "開発", "AI"] },
    { id: "research-learning", label: "調査・学習", description: "概念の理解、比較、調査、知識整理に関するまとまり。", keywords: ["調査", "学習", "理解"] },
    { id: "creative-media", label: "創作・メディア", description: "物語、作品、文章、表現の検討に関するまとまり。", keywords: ["創作", "作品", "文章"] },
    { id: "life", label: "生活", description: "日常生活、健康、買い物、趣味に関するまとまり。", keywords: ["生活", "健康", "趣味"] },
    { id: "other", label: "その他", description: "上記の大カテゴリに明確に収まらないまとまり。", keywords: ["その他"] }
  ];
}

function normalizeCategoryGroups(groups) {
  const input = Array.isArray(groups) && groups.length ? groups : defaultCategoryGroups();
  const seen = new Set();
  const result = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const id = sanitizeId(String(item.id || item.label || "").trim()).toLowerCase();
    const label = String(item.label || "").trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      label,
      description: String(item.description || "").trim() || `${label} に関する大カテゴリ。`,
      keywords: uniqueStrings(Array.isArray(item.keywords) ? item.keywords : []).slice(0, 6)
    });
  }
  return result.length ? result : defaultCategoryGroups();
}

function normalizeCategoryMaster(runtime, value) {
  const configuredGroups = normalizeCategoryGroups(runtime.config.categoryGroups);
  const existingGroups = Array.isArray(value?.groups) ? value.groups : [];
  const legacyCategories = Array.isArray(value?.categories) ? value.categories : [];
  const mergedGroups = configuredGroups.map((configured) => {
    const matched = existingGroups.find((group) => sanitizeId(String(group?.id || "")).toLowerCase() === configured.id);
    const categories = Array.isArray(matched?.categories)
      ? matched.categories
      : configured.id === "other"
        ? legacyCategories
        : [];
    return {
      id: configured.id,
      label: configured.label,
      description: configured.description,
      keywords: configured.keywords,
      categories: normalizeChildCategories(categories, configured)
    };
  });
  const flatCategories = mergedGroups.flatMap((group) => group.categories.map((category) => ({
    id: category.id,
    label: category.label,
    description: category.description,
    keywords: category.keywords,
    groupId: group.id,
    groupLabel: group.label
  })));
  return {
    schemaVersion: 2,
    generatedAt: value?.generatedAt || isoJst(),
    runId: value?.runId || runtime.config.runId,
    groups: mergedGroups,
    categories: flatCategories,
    aiMeta: value?.aiMeta || null,
    updatedBy: value?.updatedBy || null
  };
}

function normalizeChildCategories(categories, group) {
  const seen = new Set();
  const result = [];
  for (const item of categories || []) {
    if (!item || typeof item !== "object") continue;
    const label = String(item.label || "").trim();
    const id = sanitizeId(String(item.id || label).trim()).toLowerCase();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      label,
      description: String(item.description || "").trim() || `${group.label} 配下の ${label} に関するカテゴリ。`,
      keywords: uniqueStrings(Array.isArray(item.keywords) ? item.keywords : []).slice(0, 6)
    });
  }
  return result;
}

function normalizeProposedCategories(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const label = String(item.label || "").trim();
    const rawId = String(item.id || label).trim();
    const id = sanitizeId(rawId).toLowerCase();
    const groupId = sanitizeId(String(item.groupId || item.primaryGroup || "").trim()).toLowerCase();
    if (!id || !label || !groupId || seen.has(`${groupId}:${id}`)) continue;
    seen.add(`${groupId}:${id}`);
    result.push({
      groupId,
      id,
      label,
      description: String(item.description || "").trim() || `${label} に関する話題を分類するカテゴリ。`,
      keywords: uniqueStrings(Array.isArray(item.keywords) ? item.keywords : [])
    });
  }
  return result;
}

function mergeCategoryMaster(runtime, proposedCategories, itemId = null) {
  const normalized = normalizeProposedCategories(proposedCategories);
  if (!normalized.length) {
    return false;
  }
  if (runtime.config.freezeCategories) {
    return false;
  }
  const currentSuggestions = readCategorySuggestions(runtime);
  const suggestionItems = Array.isArray(currentSuggestions.items) ? currentSuggestions.items : [];
  for (const category of normalized) {
    suggestionItems.push({
      groupId: category.groupId,
      id: category.id,
      label: category.label,
      description: category.description,
      keywords: category.keywords,
      sourceTaskKey: runtime.current.taskKey,
      sourceItemId: itemId,
      adoptedAt: isoJst()
    });
  }
  writeCategorySuggestions(runtime, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    items: suggestionItems
  });
  const current = readCategoryMaster(runtime) || normalizeCategoryMaster(runtime, { schemaVersion: 2, generatedAt: isoJst(), runId: runtime.config.runId, groups: [] });
  const groups = Array.isArray(current.groups) ? current.groups.map((group) => ({ ...group, categories: [...(group.categories || [])] })) : [];
  let changed = false;
  for (const category of normalized) {
    const group = groups.find((entry) => entry.id === category.groupId);
    if (!group) {
      continue;
    }
    if (group.categories.some((entry) => entry.id === category.id || entry.label === category.label)) {
      continue;
    }
    group.categories.push({
      id: category.id,
      label: category.label,
      description: category.description,
      keywords: category.keywords
    });
    changed = true;
  }
  if (!changed) {
    return false;
  }
  writeCategoryMaster(runtime, {
    ...current,
    schemaVersion: 2,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    groups,
    updatedBy: itemId ? { taskKey: runtime.current.taskKey, itemId, at: isoJst() } : current.updatedBy || null
  });
  if (itemId) {
    const note = `新しい中カテゴリを category master に追加しました (${normalized.map((category) => `${category.groupId}/${category.id}`).join(", ")})`;
    emitEvent(runtime, { type: "category_master.updated", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note });
    logConsole("cat  ", `${runtime.current.taskKey}__${itemId}`, note);
  }
  return true;
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

function resolveDependsOn(runtime, taskKey, itemId) {
  if (taskKey === "prepare.extract_export") return [];
  if (taskKey === "prepare.scan_export") return [taskInstanceId("prepare.extract_export", "run")];
  if (taskKey === "prepare.build_thread_index") return [taskInstanceId("prepare.scan_export", "run")];
  if (taskKey === "analyze.normalize_threads") return [taskInstanceId("prepare.build_thread_index", "run")];
  if (taskKey === "analyze.attach_images") return [taskInstanceId("analyze.normalize_threads", "run")];
  if (taskKey === "ai.generate_category_candidates") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "analyze.split_thread_turns") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "ai.summarize_turn") return [taskInstanceId("analyze.split_thread_turns", readTurn(runtime, itemId).threadItemId)];
  if (taskKey === "ai.classify_turn") return [taskInstanceId("analyze.split_thread_turns", readTurn(runtime, itemId).threadItemId), taskInstanceId("ai.generate_category_candidates", "run")];
  if (taskKey === "ai.merge_thread_turns") return loadTurnsForThread(runtime, itemId).flatMap((turn) => [taskInstanceId("ai.summarize_turn", turn.itemId), taskInstanceId("ai.classify_turn", turn.itemId)]);
  if (taskKey === "analyze.group_units") return (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [])
    .filter((thread) => threadMatchesTargetScopes(thread, runtime.config))
    .map((thread) => taskInstanceId("ai.merge_thread_turns", thread.itemId));
  if (taskKey === "ai.summarize_unit") return readUnit(runtime, itemId).threadItemIds.filter((threadItemId) => hasThreadSummaryInputs(runtime, threadItemId)).map((threadItemId) => taskInstanceId("ai.merge_thread_turns", threadItemId));
  if (taskKey === "ai.write_diary_entry") return readEntry(runtime, itemId).unitSummaries.map((unitSummary) => taskInstanceId("ai.summarize_unit", unitSummary.itemId));
  if (taskKey === "ai.rewrite_diary_entry") return [taskInstanceId("ai.write_diary_entry", itemId)];
  if (taskKey === "ai.write_weekly_summary") return readWeekInput(runtime, itemId).entries.map((entry) => taskInstanceId("ai.rewrite_diary_entry", entry.itemId));
  if (taskKey === "ai.write_monthly_summary") return readMonthInput(runtime, itemId).weeks.map((week) => taskInstanceId("ai.write_weekly_summary", `week_${week}`));
  if (taskKey === "ai.write_yearly_summary") return readYearInput(runtime, itemId).months.map((month) => taskInstanceId("ai.write_monthly_summary", `month_${month}`));
  if (taskKey === "render.markdown") return [...loadDiaryEntries(runtime).map((entry) => taskInstanceId("ai.rewrite_diary_entry", entry.itemId)), ...enumerateWeekItems(runtime).map((item) => taskInstanceId("ai.write_weekly_summary", item.itemId)), ...enumerateMonthItems(runtime).map((item) => taskInstanceId("ai.write_monthly_summary", item.itemId)), ...enumerateYearItems(runtime).map((item) => taskInstanceId("ai.write_yearly_summary", item.itemId))];
  if (taskKey === "render.html") return [taskInstanceId("render.markdown", "run")];
  if (taskKey === "render.pdf") return [taskInstanceId("render.html", "run")];
  return [];
}

function reusable(state, runtime, definition, item, meta, dependsOn, invalidation) {
  if (runtime.config.force || !state || state.status !== "completed") return false;
  if (shouldRerunExplicitSelection(runtime, definition, item)) return false;
  if (invalidation) return false;
  if (isPersistentAiTask(definition)) return hasArtifacts(runtime, state.artifactPaths);
  if (runtime.config.skipCompleted) return hasArtifacts(runtime, state.artifactPaths);
  if (state.inputHash !== meta.inputHash) return false;
  if (definition.isAi && (state.promptHash !== meta.promptHash || state.model !== meta.model)) return false;
  if (!sameArray(state.dependsOn || [], dependsOn)) return false;
  return hasArtifacts(runtime, state.artifactPaths);
}

function getInvalidation(runtime, definition, item, state, meta, dependsOn) {
  if (!state) {
    return null;
  }
  if (runtime.config.force) {
    return { reason: "--force により再実行します" };
  }
  if (shouldRerunExplicitSelection(runtime, definition, item)) {
    if (shouldRerunExplicitItem(runtime, item)) {
      return { reason: "--item-id 指定により対象 item を再実行します" };
    }
    if (shouldRerunExplicitDate(runtime, definition, item)) {
      return { reason: `--date ${runtime.config.date} 指定により対象日付を再実行します` };
    }
  }
  if (state.status === "running") {
    return { reason: "前回実行が running のまま終了していたため再実行します" };
  }
  if (state.status === "failed") {
    return { reason: runtime.config.retryFailed ? "failed task を再試行します" : "failed task を再実行します" };
  }
  if (state.status === "completed" && isPersistentAiTask(definition)) {
    if (!hasArtifacts(runtime, state.artifactPaths)) {
      return { reason: "必要 artifact が欠落しているため再実行します" };
    }
    return null;
  }
  if (runtime.changed.size > 0 && dependsOn.some((dependency) => runtime.changed.has(dependency) || runtime.invalidated.has(dependency))) {
    return { reason: "依存 task が変更されたため再実行します" };
  }
  if (state.status === "completed") {
    if (!hasArtifacts(runtime, state.artifactPaths)) {
      return { reason: "必要 artifact が欠落しているため再実行します" };
    }
    if (state.inputHash !== meta.inputHash) {
      return { reason: "inputHash が変化したため再実行します" };
    }
    if (definition.isAi && state.promptHash !== meta.promptHash) {
      return { reason: "promptHash が変化したため再実行します" };
    }
    if (definition.isAi && state.model !== meta.model) {
      return { reason: "model が変化したため再実行します" };
    }
    if (!sameArray(state.dependsOn || [], dependsOn)) {
      return { reason: "dependsOn が変化したため再実行します" };
    }
  }
  return null;
}

function isPersistentAiTask(definition) {
  return Boolean(definition?.isAi && [
    "ai.summarize_turn",
    "ai.classify_turn",
    "ai.merge_thread_turns",
    "ai.summarize_unit",
    "ai.write_diary_entry",
    "ai.rewrite_diary_entry",
    "ai.write_weekly_summary",
    "ai.write_monthly_summary",
    "ai.write_yearly_summary"
  ].includes(definition.taskKey));
}

function hasArtifacts(runtime, artifactPaths) {
  return Array.isArray(artifactPaths) && artifactPaths.length > 0 && artifactPaths.every((relativePath) => fs.existsSync(path.join(runtime.paths.root, relativePath)));
}

function migrateReusableState(runtime, definition, item, state, meta, dependsOn) {
  if (!state || state.status !== "completed") {
    return null;
  }
  if (!hasArtifacts(runtime, state.artifactPaths)) {
    return null;
  }
  if (definition.taskKey === "ai.classify_thread" && runtime.config.freezeCategories) {
    const legacyDependency = taskInstanceId("ai.generate_category_candidates", "run");
    const currentDependsOn = Array.isArray(state.dependsOn) ? state.dependsOn : [];
    const withoutLegacy = currentDependsOn.filter((dependency) => dependency !== legacyDependency);
    const canMigrate = currentDependsOn.includes(legacyDependency)
      && sameArray(withoutLegacy, dependsOn)
      && state.model === meta.model
      && state.promptHash === meta.promptHash
      && state.inputHash === meta.inputHash;
    if (canMigrate) {
      const nextState = { ...state, dependsOn };
      writeState(runtime, definition, item.itemId, nextState);
      return {
        state: nextState,
        note: "過去の分類成果物を freezeCategories 互換の state に変換して再利用します"
      };
    }
    const classificationArtifact = readArtifact(runtime, `artifacts/ai/thread_classification/${item.itemId}.json`);
    const categoryIds = new Set((readCategoryMaster(runtime)?.categories || []).map((category) => category.id));
      const usedCategoryIds = [classificationArtifact?.primaryCategory || classificationArtifact?.primary, ...((classificationArtifact?.secondaryCategories || classificationArtifact?.secondary || []))].filter(Boolean);
    const canCompatMigrate = classificationArtifact
      && state.model === meta.model
      && usedCategoryIds.length > 0
      && usedCategoryIds.every((categoryId) => categoryIds.has(categoryId));
    if (canCompatMigrate) {
      const nextState = {
        ...state,
        dependsOn,
        inputHash: meta.inputHash,
        promptHash: meta.promptHash
      };
      writeState(runtime, definition, item.itemId, nextState);
      return {
        state: nextState,
        note: "過去の分類成果物を互換変換して再利用します"
      };
    }
  }
  return null;
}

function validateRunOptions(runtime) {
  if (!["task", "date"].includes(runtime.config.executionOrder || "task")) {
    throw new Error(`executionOrder は task または date で指定してください: ${runtime.config.executionOrder}`);
  }
  if (runtime.config.date && !/^\d{4}-\d{2}-\d{2}$/.test(runtime.config.date)) {
    throw new Error(`--date の形式が不正です: ${runtime.config.date}`);
  }
  for (const value of runtime.config.targetDates || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`targetDates の形式が不正です: ${value}`);
    }
  }
  for (const value of runtime.config.targetWeeks || []) {
    if (!/^\d{4}-\d{2}-W[1-5]$/.test(value)) {
      throw new Error(`targetWeeks の形式が不正です: ${value}`);
    }
  }
  for (const value of runtime.config.targetMonths || []) {
    if (!/^\d{4}-\d{2}$/.test(value)) {
      throw new Error(`targetMonths の形式が不正です: ${value}`);
    }
  }
  for (const value of runtime.config.targetYears || []) {
    if (!/^\d{4}$/.test(value)) {
      throw new Error(`targetYears の形式が不正です: ${value}`);
    }
  }
  if (runtime.config.limit !== null && runtime.config.limit <= 0) {
    throw new Error(`--limit は 1 以上で指定してください: ${runtime.config.limit}`);
  }
  if (runtime.config.jsonRetryAttempts !== null && runtime.config.jsonRetryAttempts < 1) {
    throw new Error(`jsonRetryAttempts は 1 以上で指定してください: ${runtime.config.jsonRetryAttempts}`);
  }
  if (runtime.config.date && runtime.config.grouping === "category") {
    throw new Error("--group-by category では --date は指定できません。");
  }
  if (runtime.config.targetThreadItemIds && !Array.isArray(runtime.config.targetThreadItemIds)) {
    throw new Error("targetThreadItemIds は配列で指定してください。");
  }
  for (const key of ["excludeThreadItemIds", "excludeSourceThreadIds", "excludeGroupIds"]) {
    if (runtime.config[key] && !Array.isArray(runtime.config[key])) {
      throw new Error(`${key} は配列で指定してください。`);
    }
  }
  if (runtime.config.rerunScopes?.length) {
    const invalid = runtime.config.rerunScopes.filter((scope) => !["thread", "unit"].includes(scope));
    if (invalid.length) {
      throw new Error(`rerunScopes には thread, unit のみ指定できます: ${invalid.join(", ")}`);
    }
  }
}

function applyItemFilters(runtime, definition, items) {
  if (!matchesOnly(runtime, definition.taskKey)) {
    return [];
  }

  let filtered = [...items];
  if (runtime.config.itemIds?.length) {
    const allow = new Set(runtime.config.itemIds);
    filtered = filtered.filter((item) => allow.has(item.itemId));
  }
  if (hasThreadFilterScope(runtime.config)) {
    filtered = filtered.filter((item) => matchesTargetThreadFilter(runtime, definition.itemType, item.meta || item));
  }
  if (runtime.config.date) {
    filtered = filtered.filter((item) => matchesDateFilter(definition.itemType, item.meta || item, runtime.config.date));
  }
  if (runtime.config.limit && definition.itemType !== "run") {
    filtered = filtered.slice(0, runtime.config.limit);
  }
  return filtered;
}

function matchesOnly(runtime, taskKey) {
  if (runtime.config.rerunScopes?.length && !matchesRerunScope(taskKey, runtime.config.rerunScopes)) {
    return false;
  }
  if (!runtime.config.only?.length) {
    return true;
  }
  return runtime.config.only.some((pattern) => taskKey === pattern || taskKey.startsWith(`${pattern}.`) || taskKey.startsWith(pattern));
}

function shouldRerunExplicitItem(runtime, item) {
  return Boolean(item?.itemId && runtime.config.itemIds?.length && runtime.config.itemIds.includes(item.itemId));
}

function shouldRerunExplicitSelection(runtime, definition, item) {
  return shouldRerunExplicitItem(runtime, item) || shouldRerunExplicitDate(runtime, definition, item);
}

function shouldRerunExplicitDate(runtime, definition, item) {
  if (!runtime.config.date) {
    return false;
  }
  if (runtime.config.rerunScopes?.length && !matchesRerunScope(definition.taskKey, runtime.config.rerunScopes)) {
    return false;
  }
  const meta = item?.meta || item;
  if (definition.itemType === "run") {
    return ["analyze.group_units", "render.markdown", "render.html", "render.pdf"].includes(definition.taskKey);
  }
  return matchesDateFilter(definition.itemType, meta, runtime.config.date);
}

function matchesRerunScope(taskKey, scopes) {
  const allow = new Set(scopes || []);
  if (!allow.size) {
    return true;
  }
  if (allow.has("thread") && [
    "analyze.split_thread_turns",
    "ai.summarize_turn",
    "ai.classify_turn",
    "ai.merge_thread_turns"
  ].includes(taskKey)) {
    return true;
  }
  if (allow.has("unit") && [
    "analyze.group_units",
    "ai.summarize_unit",
    "ai.write_diary_entry",
    "ai.rewrite_diary_entry",
    "ai.write_weekly_summary",
    "ai.write_monthly_summary",
    "ai.write_yearly_summary",
    "render.markdown",
    "render.html",
    "render.pdf"
  ].includes(taskKey)) {
    return true;
  }
  return false;
}

function matchesTargetThreadFilter(runtime, itemType, meta) {
  if (!hasThreadFilterScope(runtime.config)) {
    return true;
  }
  if (itemType === "run") {
    return true;
  }
  if (itemType === "thread") {
    return threadMatchesTargetScopes(meta, runtime.config);
  }
  if (itemType === "turn") {
    return threadItemMatchesTargetScopes(runtime, meta.threadItemId);
  }
  if (itemType === "unit" || itemType === "entry" || itemType === "week" || itemType === "month" || itemType === "year") {
    return (meta.threadItemIds || []).some((threadItemId) => threadItemMatchesTargetScopes(runtime, threadItemId));
  }
  return true;
}

function matchesDateFilter(itemType, meta, date) {
  if (itemType === "run") {
    return true;
  }
  if (itemType === "thread") {
    return meta.primaryDate === date;
  }
  if (itemType === "turn") {
    return meta.date === date;
  }
  if (itemType === "week") {
    return meta.week === monthWeekKey(date);
  }
  if (itemType === "month") {
    return meta.month === date.slice(0, 7);
  }
  if (itemType === "year") {
    return meta.year === date.slice(0, 4);
  }
  return meta.date === date || meta.itemId === `entry_${date}` || meta.itemId === `unit_date_${date}`;
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
  const response = await askForJson(runtime, "ai.summarize_unit", itemId, `unit-${itemId}`, meta);
  const unit = readUnit(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/unit_summaries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, label: unit.label, date: unit.date, category: unit.category, summaryTitle: response.parsed.summaryTitle || unit.label, interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [], questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [], outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [], images: Array.isArray(response.parsed.images) ? response.parsed.images : [], narrative: response.parsed.narrative || "", aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.summarize_unit", itemId, response.text, response.usage);
  return [`artifacts/ai/unit_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_unit/${itemId}.raw.json`];
}

async function handleWriteEntry(runtime, itemId, meta) {
  const response = await askForJson(runtime, "ai.write_diary_entry", itemId, `entry-draft-${itemId}`, meta);
  const entry = readEntry(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: entry.date, title: response.parsed.title || `${entry.date} の日記`, lead: response.parsed.lead || "", sections: Array.isArray(response.parsed.sections) ? response.parsed.sections : [], closing: response.parsed.closing || "", images: Array.isArray(response.parsed.images) ? response.parsed.images : [], aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.write_diary_entry", itemId, response.text, response.usage);
  return [`artifacts/ai/diary_drafts/${itemId}.json`, `artifacts/raw/ai.write_diary_entry/${itemId}.raw.json`];
}

async function handleRewriteEntry(runtime, itemId, meta) {
  const response = await askForJson(runtime, "ai.rewrite_diary_entry", itemId, `entry-final-${itemId}`, meta);
  const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`) || {};
  writeArtifact(runtime, `artifacts/ai/diary_entries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: draft.date, title: response.parsed.title || draft.title, markdownBody: response.parsed.markdownBody || draftToMarkdown(draft), images: Array.isArray(response.parsed.images) ? response.parsed.images : draft.images || [], aiMeta: buildAiMeta(runtime, meta, response) });
  writeRaw(runtime, "ai.rewrite_diary_entry", itemId, response.text, response.usage);
  return [`artifacts/ai/diary_entries/${itemId}.json`, `artifacts/raw/ai.rewrite_diary_entry/${itemId}.raw.json`];
}

async function handleWriteWeeklySummary(runtime, itemId, meta) {
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

function handleRenderMarkdown(runtime) {
  const entries = loadDiaryEntries(runtime).sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
  const posts = writeRenderPostsMarkdown(runtime, entries);
  const archives = writeRenderArchivesMarkdown(runtime, posts);
  writeArtifact(runtime, "artifacts/render/diary.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, grouping: runtime.config.grouping, entries, posts, weeks: archives.weeks, months: archives.months, years: archives.years });
  writeArtifact(runtime, "artifacts/render/posts.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, posts });
  writeArtifact(runtime, "artifacts/render/weeks.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, weeks: archives.weeks });
  writeArtifact(runtime, "artifacts/render/months.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, months: archives.months });
  writeArtifact(runtime, "artifacts/render/years.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, years: archives.years });
  const markdown = ["# Nikki Diary", "", `- 生成日時: ${isoJst()}`, `- 集計単位: ${runtime.config.grouping}`, "", ...entries.flatMap((entry) => [`## ${entry.title || entry.itemId}`, "", entry.date ? `- 日付: ${entry.date}` : "", entry.date ? "" : "", entry.markdownBody || "", ""])].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.md"), markdown, "utf8");
  const indexMarkdown = buildRenderIndexMarkdown(posts, archives.weeks, archives.months, archives.years);
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "index.md"), indexMarkdown, "utf8");
  return ["artifacts/render/diary.json", "artifacts/render/posts.json", "artifacts/render/weeks.json", "artifacts/render/months.json", "artifacts/render/years.json", "artifacts/render/diary.md", "artifacts/render/index.md", ...posts.map((post) => post.markdownPath), ...archives.weeks.map((week) => week.markdownPath), ...archives.months.map((month) => month.markdownPath), ...archives.years.map((year) => year.markdownPath)];
}

function handleRenderHtml(runtime) {
  const markdown = fs.readFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.md"), "utf8");
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.html"), wrapHtml(marked.parse(markdown)), "utf8");
  const posts = readArtifact(runtime, "artifacts/render/posts.json")?.posts || [];
  const weeks = readArtifact(runtime, "artifacts/render/weeks.json")?.weeks || [];
  const months = readArtifact(runtime, "artifacts/render/months.json")?.months || [];
  const years = readArtifact(runtime, "artifacts/render/years.json")?.years || [];
  const changedEntryIds = getChangedEntryIds(runtime);
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "index.html"), wrapBlogIndexHtml(posts, weeks, months, years), "utf8");
  for (const post of posts) {
    if (changedEntryIds.size > 0 && !changedEntryIds.has(post.entryId) && fs.existsSync(path.join(runtime.paths.root, post.htmlPath))) {
      continue;
    }
    const entry = readArtifact(runtime, `artifacts/ai/diary_entries/${post.entryId}.json`) || {};
    fs.writeFileSync(path.join(runtime.paths.root, post.htmlPath), wrapBlogPostHtml(post, entry, posts, weeks, months, years), "utf8");
  }
  for (const week of weeks) {
    fs.writeFileSync(path.join(runtime.paths.root, week.htmlPath), wrapBlogWeekHtml(week, posts, weeks, months, years), "utf8");
  }
  for (const month of months) {
    fs.writeFileSync(path.join(runtime.paths.root, month.htmlPath), wrapBlogMonthHtml(month, posts, weeks, months, years), "utf8");
  }
  for (const year of years) {
    fs.writeFileSync(path.join(runtime.paths.root, year.htmlPath), wrapBlogYearHtml(year, posts, weeks, months, years), "utf8");
  }
  return ["artifacts/render/diary.html", "artifacts/render/index.html", ...posts.map((post) => post.htmlPath), ...weeks.map((week) => week.htmlPath), ...months.map((month) => month.htmlPath), ...years.map((year) => year.htmlPath)];
}

async function handleRenderPdf(runtime) {
  const htmlPath = path.join(runtime.paths.root, "artifacts", "render", "diary.html");
  const pdfPath = path.join(runtime.paths.root, "artifacts", "render", "diary.pdf");
  const browserPath = await findChromiumBrowser();
  let pdfGenerated = false;
  let pdfError = null;
  if (browserPath) {
    try {
      await execFileAsync(browserPath, ["--headless", "--disable-gpu", `--print-to-pdf=${pdfPath}`, fileUrl(htmlPath)], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 * 16 });
      pdfGenerated = fs.existsSync(pdfPath);
    } catch (error) {
      pdfError = error instanceof Error ? error.message : String(error);
    }
  } else {
    pdfError = "Edge / Chrome が見つからなかったため PDF は未生成です。";
  }
  writeArtifact(runtime, "artifacts/render/render-info.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, pdfGenerated, pdfError });
  return pdfGenerated ? ["artifacts/render/render-info.json", "artifacts/render/diary.pdf"] : ["artifacts/render/render-info.json"];
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

async function askForJson(runtime, taskKey, itemId, name, meta) {
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

function isContextOverflowFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(prompt token count .* exceeds the limit|maximum context length|context length|too many tokens|token limit|input too long|request too large|exceeds the limit|AI プロンプトが長すぎます)/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function uniqueStrings(values) { return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))]; }
function dedupeObjects(values, keyFn) { const seen = new Set(); const items = []; for (const value of values || []) { const key = keyFn(value); if (seen.has(key)) continue; seen.add(key); items.push(value); } return items; }
function normalizeQuestionKey(text) { return String(text || "").trim().toLowerCase(); }
function normalizeQuestionStatus(status) { return ["resolved", "partially_resolved", "unresolved"].includes(status) ? status : "unresolved"; }
function compareQuestionStatus(left, right) { const rank = { unresolved: 0, partially_resolved: 1, resolved: 2 }; return (rank[normalizeQuestionStatus(left)] || 0) - (rank[normalizeQuestionStatus(right)] || 0); }
function readArtifact(runtime, relativePath) { return readJson(path.join(runtime.paths.root, relativePath)); }
function writeArtifact(runtime, relativePath, value) { writeJson(path.join(runtime.paths.root, relativePath), value); }
function writeRaw(runtime, taskKey, itemId, text, usage = null) {
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
function draftToMarkdown(draft) { return [draft.lead || "", ...(draft.sections || []).flatMap((section) => [section.heading ? `### ${section.heading}` : "", section.body || "", ""]), draft.closing || ""].filter(Boolean).join("\n\n"); }
function renderPostSlug(entry) { return sanitizeId(entry.date || entry.itemId || "entry"); }
function buildEntryMarkdown(runtime, post, entry, navigation = {}) {
  const navLinks = [
      navigation.previousPost ? `[前の日: ${navigation.previousPost.date || navigation.previousPost.title}](./${path.posix.basename(navigation.previousPost.htmlPath)})` : null,
      `[一覧へ](../index.html)`,
      navigation.nextPost ? `[次の日: ${navigation.nextPost.date || navigation.nextPost.title}](./${path.posix.basename(navigation.nextPost.htmlPath)})` : null
    ].filter(Boolean);
    const imageBlocks = buildEntryImageMarkdown(runtime, post, entry);
    return [
      `# ${entry.title || entry.itemId}`,
      "",
      entry.date ? `- 日付: ${entry.date}` : null,
      entry.itemId ? `- entryId: ${entry.itemId}` : null,
      "",
      navLinks.length ? navLinks.join(" | ") : null,
      navLinks.length ? "" : null,
      entry.markdownBody || "",
      imageBlocks.length ? "" : null,
      imageBlocks.length ? "## 生成画像" : null,
      imageBlocks.length ? "" : null,
      ...imageBlocks,
      post.threads?.length ? "" : null,
      post.threads?.length ? "## 関連スレッド" : null,
      post.threads?.length ? "" : null,
      ...(post.threads || []).map((thread) => `- ${thread.itemId}: ${thread.title}${thread.categoryLabel ? ` [${thread.categoryLabel}]` : ""}${thread.chatgptUrl ? ` ([ChatGPTで開く](${thread.chatgptUrl}))` : ""}`)
    ].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
function writeRenderPostsMarkdown(runtime, entries) {
  const postsDir = path.join(runtime.paths.root, "artifacts", "render", "posts");
  ensureDir(postsDir);
  const categoryMap = new Map((readCategoryMaster(runtime)?.categories || []).map((category) => [category.id, category.label]));
  const units = readArtifact(runtime, "artifacts/units/units.json")?.items || [];
  const changedEntryIds = getChangedEntryIds(runtime);
  const existingPosts = new Map(((readArtifact(runtime, "artifacts/render/posts.json")?.posts) || []).map((post) => [post.entryId, post]));
  const posts = entries.map((entry) => {
    const slug = renderPostSlug(entry);
      const markdownPath = `artifacts/render/posts/${slug}.md`;
      const htmlPath = `artifacts/render/posts/${slug}.html`;
      const threadItemIds = units.filter((unit) => unit.entryId === entry.itemId).flatMap((unit) => unit.threadItemIds || []);
      const categories = buildRenderPostCategories(runtime, threadItemIds, categoryMap);
      const threads = buildRenderPostThreads(runtime, threadItemIds, categoryMap);
      const existing = existingPosts.get(entry.itemId);
      return existing && !changedEntryIds.has(entry.itemId)
        ? { ...existing, slug, date: entry.date || null, title: entry.title || entry.itemId, markdownPath, htmlPath, categories, threads }
        : { slug, entryId: entry.itemId, date: entry.date || null, title: entry.title || entry.itemId, markdownPath, htmlPath, categories, threads };
    });
  posts.forEach((post, index) => {
    const entry = entries[index];
    const previousPost = index > 0 ? posts[index - 1] : null;
    const nextPost = index < posts.length - 1 ? posts[index + 1] : null;
    if (!existingPosts.has(post.entryId) || changedEntryIds.has(post.entryId)) {
        fs.writeFileSync(path.join(runtime.paths.root, post.markdownPath), buildEntryMarkdown(runtime, post, entry, { previousPost, nextPost }), "utf8");
      }
    });
    return posts;
  }
function threadItemIdsForEntry(runtime, entryId) {
  return (readArtifact(runtime, "artifacts/units/units.json")?.items || [])
    .filter((unit) => unit.entryId === entryId)
    .flatMap((unit) => unit.threadItemIds || []);
}
function buildArchiveStatsFromEntries(runtime, entries, options = {}) {
  const categoryMap = new Map((readCategoryMaster(runtime)?.categories || []).map((category) => [category.id, category.label]));
  const posts = (entries || []).map((entry) => {
    const threadItemIds = threadItemIdsForEntry(runtime, entry.itemId);
    return {
      entryId: entry.itemId,
      date: entry.date || null,
      categories: buildRenderPostCategories(runtime, threadItemIds, categoryMap),
      threads: buildRenderPostThreads(runtime, threadItemIds, categoryMap)
    };
  });
  return buildArchiveStats(runtime, posts, options);
}
function buildArchiveStats(runtime, posts, options = {}) {
  const threadIndex = new Map((readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => [thread.itemId, thread]));
  const uniqueThreads = new Map();
  const categoryCounts = new Map();
  const primaryCategoryCounts = new Map();
  const days = new Set();
  for (const post of posts || []) {
    if (post.date) {
      days.add(post.date);
    }
    for (const category of post.categories || []) {
      incrementCategoryCount(categoryCounts, category);
    }
    for (const thread of post.threads || []) {
      if (!thread?.itemId || uniqueThreads.has(thread.itemId)) {
        continue;
      }
      const indexed = threadIndex.get(thread.itemId) || {};
      uniqueThreads.set(thread.itemId, { ...indexed, ...thread });
      if (thread.categoryId) {
        incrementCategoryCount(primaryCategoryCounts, { id: thread.categoryId, label: thread.categoryLabel || thread.categoryId });
      }
    }
  }
  const threadValues = [...uniqueThreads.values()];
  const tokenEstimate = estimateArchiveConversationTokens(runtime, threadValues);
  return {
    dayCount: days.size || (posts || []).length,
    weekCount: Number(options.weekCount || 0),
    monthCount: Number(options.monthCount || 0),
    threadCount: threadValues.length,
    messageCount: sumThreadMetric(threadValues, "messageCount"),
    userMessageCount: sumThreadMetric(threadValues, "userMessageCount"),
    assistantMessageCount: sumThreadMetric(threadValues, "assistantMessageCount"),
    estimatedInputTokens: tokenEstimate.inputTokens,
    estimatedOutputTokens: tokenEstimate.outputTokens,
    estimatedTotalTokens: tokenEstimate.inputTokens + tokenEstimate.outputTokens,
    generatedImageCount: sumThreadMetric(threadValues, "generatedImageCount"),
    topCategories: sortCategoryCounts(categoryCounts),
    topPrimaryCategories: sortCategoryCounts(primaryCategoryCounts)
  };
}
function estimateArchiveConversationTokens(runtime, threads) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const thread of threads || []) {
    const normalized = readArtifact(runtime, `artifacts/normalized/${thread.itemId}.json`) || {};
    for (const message of normalized.messages || []) {
      const tokens = estimateInputTokens(message?.text || "");
      if (message?.role === "user") {
        inputTokens += tokens;
      } else if (message?.role === "assistant") {
        outputTokens += tokens;
      }
    }
  }
  return { inputTokens, outputTokens };
}
function incrementCategoryCount(map, category) {
  const id = category?.id || category?.categoryId || "uncategorized";
  const label = category?.label || category?.categoryLabel || id;
  if (!map.has(id)) {
    map.set(id, { id, label, count: 0 });
  }
  map.get(id).count += 1;
}
function sortCategoryCounts(map) {
  return [...map.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "ja"));
}
function sumThreadMetric(threads, key) {
  return (threads || []).reduce((sum, thread) => sum + Number(thread?.[key] || 0), 0);
}
function writeRenderArchivesMarkdown(runtime, posts) {
  const weeksDir = path.join(runtime.paths.root, "artifacts", "render", "weeks");
  const monthsDir = path.join(runtime.paths.root, "artifacts", "render", "months");
  const yearsDir = path.join(runtime.paths.root, "artifacts", "render", "years");
  ensureDir(weeksDir);
  ensureDir(monthsDir);
  ensureDir(yearsDir);
  const weeks = buildRenderWeeks(runtime, posts);
  const months = buildRenderMonths(runtime, weeks);
  const years = buildRenderYears(runtime, months);
  for (const week of weeks) {
    fs.writeFileSync(path.join(runtime.paths.root, week.markdownPath), buildRenderWeekMarkdown(week), "utf8");
  }
  for (const month of months) {
    fs.writeFileSync(path.join(runtime.paths.root, month.markdownPath), buildRenderMonthMarkdown(month), "utf8");
  }
  for (const year of years) {
    fs.writeFileSync(path.join(runtime.paths.root, year.markdownPath), buildRenderYearMarkdown(year), "utf8");
  }
  return { weeks, months, years };
}
function buildRenderWeeks(runtime, posts) {
  const buckets = new Map();
  for (const post of posts || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(post.date || ""))) {
      continue;
    }
    const weekId = monthWeekKey(post.date);
    if (!weekId) {
      continue;
    }
    if (!buckets.has(weekId)) {
      buckets.set(weekId, { itemId: `week_${weekId}`, week: weekId, month: weekId.slice(0, 7), title: `${weekId} の日記`, markdownPath: `artifacts/render/weeks/${weekId}.md`, htmlPath: `artifacts/render/weeks/${weekId}.html`, posts: [] });
    }
    buckets.get(weekId).posts.push(post);
  }
  return [...buckets.values()]
    .map((week) => {
      const sortedPosts = week.posts.sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
      return { ...week, summary: readArtifact(runtime, `artifacts/ai/weekly_summaries/${week.itemId}.json`) || null, stats: buildArchiveStats(runtime, sortedPosts, { weekCount: 1 }), posts: sortedPosts };
    })
    .sort((a, b) => a.week.localeCompare(b.week, "ja"));
}
function buildRenderMonths(runtime, weeks) {
  const buckets = new Map();
  for (const week of weeks || []) {
    const monthId = week.month || week.week.slice(0, 7);
    if (!buckets.has(monthId)) {
      buckets.set(monthId, { itemId: `month_${monthId}`, month: monthId, title: `${monthId} の日記`, markdownPath: `artifacts/render/months/${monthId}.md`, htmlPath: `artifacts/render/months/${monthId}.html`, weeks: [], posts: [] });
    }
    buckets.get(monthId).weeks.push(week);
    buckets.get(monthId).posts.push(...(week.posts || []));
  }
  return [...buckets.values()]
    .map((month) => {
      const sortedWeeks = month.weeks.sort((a, b) => a.week.localeCompare(b.week, "ja"));
      const sortedPosts = month.posts.sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
      return { ...month, summary: readArtifact(runtime, `artifacts/ai/monthly_summaries/${month.itemId}.json`) || null, stats: buildArchiveStats(runtime, sortedPosts, { monthCount: 1, weekCount: sortedWeeks.length }), weeks: sortedWeeks, posts: sortedPosts };
    })
    .sort((a, b) => a.month.localeCompare(b.month, "ja"));
}
function buildRenderYears(runtime, months) {
  const buckets = new Map();
  for (const month of months || []) {
    const yearId = month.month.slice(0, 4);
    if (!buckets.has(yearId)) {
      buckets.set(yearId, { itemId: `year_${yearId}`, year: yearId, title: `${yearId} 年の日記`, markdownPath: `artifacts/render/years/${yearId}.md`, htmlPath: `artifacts/render/years/${yearId}.html`, months: [], postCount: 0 });
    }
    buckets.get(yearId).months.push(month);
    buckets.get(yearId).postCount += month.posts.length;
  }
  return [...buckets.values()]
    .map((year) => {
      const sortedMonths = year.months.sort((a, b) => a.month.localeCompare(b.month, "ja"));
      return { ...year, summary: readArtifact(runtime, `artifacts/ai/yearly_summaries/${year.itemId}.json`) || null, stats: buildArchiveStats(runtime, sortedMonths.flatMap((month) => month.posts || []), { weekCount: sortedMonths.reduce((sum, month) => sum + (month.weeks?.length || 0), 0), monthCount: sortedMonths.length }), months: sortedMonths };
    })
    .sort((a, b) => a.year.localeCompare(b.year, "ja"));
}
function buildRenderWeekMarkdown(week) {
  const summary = week.summary ? buildWeeklySummaryMarkdown(week.summary) : "";
  const stats = buildArchiveStatsMarkdown(week.stats);
  return [
    `# ${week.summary?.title || week.title}`,
    "",
    `- 週: ${week.week}`,
    `- 日数: ${week.posts.length}`,
    "",
    stats,
    stats ? "" : null,
    summary,
    summary ? "" : null,
    "## 日別",
    "",
    ...week.posts.map((post) => `- [${post.date || "unknown"} | ${post.title}](../posts/${path.posix.basename(post.htmlPath)})`)
  ].filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function buildRenderMonthMarkdown(month) {
  const summary = month.summary ? buildMonthlySummaryMarkdown(month.summary) : "";
  const stats = buildArchiveStatsMarkdown(month.stats);
  return [
    `# ${month.summary?.title || month.title}`,
    "",
    `- 日数: ${month.posts.length}`,
    "",
    stats,
    stats ? "" : null,
    summary,
    summary ? "" : null,
    "## 週別",
    "",
    ...month.weeks.map((week) => `- [${week.week} (${week.posts.length}日)](../weeks/${path.posix.basename(week.htmlPath)})`)
  ].filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function buildRenderYearMarkdown(year) {
  const summary = year.summary ? buildYearlySummaryMarkdown(year.summary) : "";
  const stats = buildArchiveStatsMarkdown(year.stats);
  return [
    `# ${year.summary?.title || year.title}`,
    "",
    `- 月数: ${year.months.length}`,
    `- 日数: ${year.postCount}`,
    "",
    stats,
    stats ? "" : null,
    summary,
    summary ? "" : null,
    ...year.months.map((month) => `- [${month.month} (${month.posts.length}日)](../months/${path.posix.basename(month.htmlPath)})`)
  ].filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function buildArchiveStatsMarkdown(stats) {
  if (!stats) {
    return "";
  }
  return [
    "## 統計",
    "",
    `- 日数: ${stats.dayCount}`,
    stats.weekCount ? `- 週数: ${stats.weekCount}` : null,
    stats.monthCount ? `- 月数: ${stats.monthCount}` : null,
    `- スレッド数: ${stats.threadCount}`,
    `- メッセージ数: ${stats.messageCount}`,
    `- ユーザー発話数: ${stats.userMessageCount}`,
    `- アシスタント発話数: ${stats.assistantMessageCount}`,
    `- 推定入力トークン数: ${formatInteger(stats.estimatedInputTokens)}`,
    `- 推定出力トークン数: ${formatInteger(stats.estimatedOutputTokens)}`,
    `- 推定合計トークン数: ${formatInteger(stats.estimatedTotalTokens)}`,
    `- 生成画像数: ${stats.generatedImageCount}`,
    stats.topCategories?.length ? `- 多かった話題: ${stats.topCategories.slice(0, 8).map((category) => `${category.label} (${category.count})`).join("、")}` : null,
    stats.topPrimaryCategories?.length ? `- 主話題: ${stats.topPrimaryCategories.slice(0, 8).map((category) => `${category.label} (${category.count})`).join("、")}` : null
  ].filter(Boolean).join("\n");
}
function buildWeeklySummaryMarkdown(summary) {
  return [
    summary.overview || "",
    ...(summary.themes || []).flatMap((theme) => [theme.heading ? `## ${theme.heading}` : "", theme.body || "", ""]),
    summary.notableDays?.length ? "## 印象に残った日" : "",
    ...(summary.notableDays || []).map((day) => `- ${day.date || "unknown"}: ${day.title || ""}${day.note ? ` - ${day.note}` : ""}`),
    summary.closing ? "" : null,
    summary.closing || ""
  ].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
function buildMonthlySummaryMarkdown(summary) {
  return [
    summary.overview || "",
    ...(summary.themes || []).flatMap((theme) => [theme.heading ? `## ${theme.heading}` : "", theme.body || "", ""]),
    summary.notableWeeks?.length ? "## 印象に残った週" : "",
    ...(summary.notableWeeks || []).map((week) => `- ${week.week || "unknown"}: ${week.title || ""}${week.note ? ` - ${week.note}` : ""}`),
    summary.closing ? "" : null,
    summary.closing || ""
  ].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
function buildYearlySummaryMarkdown(summary) {
  return [
    summary.overview || "",
    ...(summary.themes || []).flatMap((theme) => [theme.heading ? `## ${theme.heading}` : "", theme.body || "", ""]),
    summary.notableMonths?.length ? "## 印象に残った月" : "",
    ...(summary.notableMonths || []).map((month) => `- ${month.month || "unknown"}: ${month.title || ""}${month.note ? ` - ${month.note}` : ""}`),
    summary.closing ? "" : null,
    summary.closing || ""
  ].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
function buildRenderIndexMarkdown(posts, weeks = [], months = [], years = []) {
  return [
    "# Nikki Blog",
    "",
    `- 生成日時: ${isoJst()}`,
    "",
    "## 年別",
    "",
    ...years.map((year) => `- [${year.year} (${year.postCount}日)](./years/${path.posix.basename(year.htmlPath)})`),
    "",
    "## 月別",
    "",
    ...months.map((month) => `- [${month.month} (${month.posts.length}日)](./months/${path.posix.basename(month.htmlPath)})`),
    "",
    "## 週別",
    "",
    ...weeks.map((week) => `- [${week.week} (${week.posts.length}日)](./weeks/${path.posix.basename(week.htmlPath)})`),
    "",
    "## 日別",
    "",
    ...posts.map((post) => `- [${post.date || "unknown"} | ${post.title}](./posts/${path.posix.basename(post.htmlPath)})`)
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
  function buildRenderPostCategories(runtime, threadItemIds, categoryMap) {
  const categories = [];
  const seen = new Set();
  for (const threadItemId of threadItemIds || []) {
    const classification = readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`);
    const ids = [classification?.primaryCategory || classification?.primary, ...((classification?.secondaryCategories || classification?.secondary || []))].filter(Boolean);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      categories.push({ id, label: categoryMap.get(id) || id });
    }
    }
    return categories;
  }
  function buildRenderPostThreads(runtime, threadItemIds, categoryMap) {
      return (threadItemIds || []).map((threadItemId) => {
        const thread = readArtifact(runtime, `artifacts/normalized/${threadItemId}.json`) || {};
        const classification = readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`) || {};
        const categoryId = classification.primaryCategory || classification.primary || null;
        return {
          itemId: threadItemId,
          title: thread.title || thread.preview || threadItemId,
          primaryDate: thread.primaryDate || null,
          sourceThreadId: thread.sourceThreadId || null,
          chatgptUrl: thread.sourceThreadId ? `https://chatgpt.com/c/${thread.sourceThreadId}` : null,
          categoryId,
          categoryLabel: categoryId ? (categoryMap.get(categoryId) || categoryId) : null
        };
      });
    }
  function buildEntryImageMarkdown(runtime, post, entry) {
    const images = normalizeEntryImages(entry);
    if (!images.length) {
      return [];
    }
    return images.flatMap((image) => {
      const relativePath = toPostRelativePath(runtime, post, image.path);
      if (!relativePath) {
        return [`- ${image.caption || "画像"}: ${image.path}`];
      }
      return [
        image.caption ? `### ${image.caption}` : "### 画像",
        "",
        `![${image.caption || "generated image"}](${relativePath})`,
        ""
      ];
    });
  }
  function normalizeEntryImages(entry) {
    return (Array.isArray(entry?.images) ? entry.images : [])
      .filter((image) => image?.path && fs.existsSync(image.path))
      .map((image) => ({ path: image.path, caption: image.caption || image.note || "" }));
  }
  function toPostRelativePath(runtime, post, targetPath) {
    if (!targetPath) {
      return null;
    }
    const fromDir = path.join(runtime.paths.root, path.dirname(post.markdownPath || post.htmlPath));
    return path.relative(fromDir, targetPath).replaceAll("\\", "/");
  }
  function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
function archiveHrefFromContext(relativePath, currentKind) {
  if (currentKind === "post" || currentKind === "week" || currentKind === "month" || currentKind === "year") {
    return `../${relativePath}`;
  }
  return `./${relativePath}`;
}
function buildBlogSidebarHtml(posts, currentSlug = null, weeks = [], months = [], years = [], currentKind = "index") {
  return [
    `<aside class="blog-sidebar">`,
    `<div class="blog-sidebar-panel">`,
    `<h1>Nikki Blog</h1>`,
    `<p class="blog-sidebar-meta">生成日時: ${escapeHtml(isoJst())}</p>`,
    years.length ? `<nav class="blog-archive-nav"><h2>年別</h2><ul>` : "",
    ...years.map((year) => `<li><a href="${escapeHtml(archiveHrefFromContext(year.htmlPath.replace(/^artifacts\/render\//, ""), currentKind))}"><span class="blog-post-date">${escapeHtml(year.year)}</span><span class="blog-post-title">${year.postCount}日</span></a></li>`),
    years.length ? `</ul></nav>` : "",
    months.length ? `<nav class="blog-archive-nav"><h2>月別</h2><ul>` : "",
    ...months.map((month) => `<li><a href="${escapeHtml(archiveHrefFromContext(month.htmlPath.replace(/^artifacts\/render\//, ""), currentKind))}"><span class="blog-post-date">${escapeHtml(month.month)}</span><span class="blog-post-title">${month.posts.length}日</span></a></li>`),
    months.length ? `</ul></nav>` : "",
    weeks.length ? `<nav class="blog-archive-nav"><h2>週別</h2><ul>` : "",
    ...weeks.map((week) => `<li><a href="${escapeHtml(archiveHrefFromContext(week.htmlPath.replace(/^artifacts\/render\//, ""), currentKind))}"><span class="blog-post-date">${escapeHtml(week.week)}</span><span class="blog-post-title">${week.posts.length}日</span></a></li>`),
    weeks.length ? `</ul></nav>` : "",
    `<nav class="blog-sidebar-nav"><ul>`,
    ...posts.map((post) => {
      const isCurrent = currentSlug && post.slug === currentSlug;
      const href = currentKind === "post" ? `${path.posix.basename(post.htmlPath)}` : archiveHrefFromContext(`posts/${path.posix.basename(post.htmlPath)}`, currentKind);
      return `<li class="${isCurrent ? "is-current" : ""}"><a href="${href}"><span class="blog-post-date">${escapeHtml(post.date || "unknown")}</span><span class="blog-post-title">${escapeHtml(post.title)}</span></a></li>`;
    }),
    `</ul></nav>`,
    `</div>`,
    `</aside>`
  ].join("");
}
function buildBlogCategorySidebarHtml(posts, currentPost = null) {
  const aggregate = new Map();
  for (const post of posts) {
    for (const category of post.categories || []) {
      if (!aggregate.has(category.id)) {
        aggregate.set(category.id, { ...category, count: 0 });
      }
      aggregate.get(category.id).count += 1;
    }
  }
  const currentIds = new Set((currentPost?.categories || []).map((category) => category.id));
  const items = [...aggregate.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "ja"));
  return [
    `<aside class="blog-taxonomy">`,
    `<div class="blog-taxonomy-panel">`,
    `<h2>カテゴリ</h2>`,
    `<ul class="blog-taxonomy-list">`,
    ...items.map((category) => `<li class="${currentIds.has(category.id) ? "is-current" : ""}"><span class="blog-taxonomy-label">${escapeHtml(category.label)}</span><span class="blog-taxonomy-count">${category.count}</span></li>`),
    `</ul>`,
    `</div>`,
    `</aside>`
  ].join("");
}
function buildBlogNavHtml(previousPost, nextPost) {
  const links = [
    previousPost ? `<a href="./${path.posix.basename(previousPost.htmlPath)}">前の日: ${escapeHtml(previousPost.date || previousPost.title)}</a>` : `<span class="is-disabled">前の日: なし</span>`,
    `<a href="../index.html">一覧へ</a>`,
    nextPost ? `<a href="./${path.posix.basename(nextPost.htmlPath)}">次の日: ${escapeHtml(nextPost.date || nextPost.title)}</a>` : `<span class="is-disabled">次の日: なし</span>`
  ];
  return `<nav class="blog-post-nav">${links.join("<span class=\"sep\">|</span>")}</nav>`;
}
function wrapBlogLayoutHtml(sidebarHtml, contentHtml, taxonomyHtml, pageTitle) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(pageTitle)}</title><style>:root{--bg:#efe4d1;--panel:#fbf7f0;--ink:#1f1a17;--accent:#a54b2a;--line:#ddcdbd;--muted:#6f6257}*{box-sizing:border-box}body{margin:0;font-family:"Yu Mincho","Hiragino Mincho ProN",serif;color:var(--ink);background:radial-gradient(circle at top left,rgba(165,75,42,.12),transparent 24%),linear-gradient(180deg,#f5ede2 0%,#eadfcd 100%)}a{color:#5a45c6;text-decoration:underline}a:hover{text-decoration:none}.blog-layout{display:grid;grid-template-columns:320px minmax(0,1fr) 260px;gap:28px;max-width:1720px;margin:0 auto;padding:44px 28px 72px}.blog-sidebar,.blog-taxonomy{position:sticky;top:24px;align-self:start}.blog-sidebar-panel,.blog-content-panel,.blog-taxonomy-panel{background:var(--panel);border:1px solid var(--line);border-radius:24px;box-shadow:0 18px 42px rgba(53,37,24,.10)}.blog-sidebar-panel,.blog-taxonomy-panel{padding:34px 28px}.blog-sidebar-panel h1{margin:0 0 20px;font-size:3rem;line-height:1.05;border-bottom:2px solid var(--accent);padding-bottom:.4em}.blog-sidebar-panel h2,.blog-taxonomy-panel h2{margin:0 0 12px;font-size:1.35rem;line-height:1.25;border-bottom:1px solid var(--line);padding-bottom:.35em}.blog-taxonomy-panel h2{margin-bottom:20px;font-size:2rem;line-height:1.1;border-bottom:2px solid var(--accent);padding-bottom:.4em}.blog-sidebar-meta{margin:0 0 24px;color:var(--muted);font-size:1rem;line-height:1.8}.blog-sidebar-nav ul,.blog-archive-nav ul,.blog-taxonomy-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}.blog-archive-nav{margin:0 0 24px}.blog-sidebar-nav li a,.blog-archive-nav li a{display:flex;flex-direction:column;gap:3px;color:inherit;text-decoration:none;padding:10px 12px;border-radius:12px}.blog-sidebar-nav li a:hover,.blog-sidebar-nav li.is-current a,.blog-archive-nav li a:hover,.blog-taxonomy-list li.is-current{background:rgba(165,75,42,.08)}.blog-post-date{font-size:.92rem;color:var(--accent)}.blog-post-title{font-size:1.05rem;line-height:1.6}.blog-main{min-width:0}.blog-content-panel{padding:28px 44px 40px}.blog-post-nav{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;align-items:center;margin:0 0 22px;font-size:1rem}.blog-post-nav.bottom{margin:28px 0 0}.blog-post-nav .sep{color:var(--muted)}.blog-post-nav .is-disabled{color:var(--muted)}.blog-article h1,.blog-index-copy h1{font-size:3rem;line-height:1.15;margin:0 0 20px;padding-bottom:.4em;border-bottom:2px solid var(--accent)}.blog-article h2,.blog-article h3{line-height:1.35;margin-top:2.2em}.blog-article p,.blog-article li,.blog-index-copy p,.blog-index-copy li{font-size:1.15rem;line-height:2}.blog-article ul,.blog-index-copy ul{padding-left:1.4em}.blog-meta{margin:0 0 20px;padding-left:1.2em}.blog-index-copy{min-height:70vh}.blog-taxonomy-list li{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px}.blog-taxonomy-label{line-height:1.5}.blog-taxonomy-count{color:var(--muted)}.blog-post-categories{margin-top:32px;padding-top:24px;border-top:1px solid var(--line)}.blog-post-categories h2{margin:0 0 16px;font-size:1.4rem}.blog-category-chips{display:flex;flex-wrap:wrap;gap:10px}.blog-category-chip{display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;background:rgba(165,75,42,.10);border:1px solid rgba(165,75,42,.18);font-size:1rem;color:var(--ink)}@media (max-width:1280px){.blog-layout{grid-template-columns:300px minmax(0,1fr)}.blog-taxonomy{position:static;grid-column:1 / -1}}@media (max-width:980px){.blog-layout{grid-template-columns:1fr;padding:20px 14px 40px}.blog-sidebar,.blog-taxonomy{position:static}.blog-sidebar-panel h1,.blog-article h1,.blog-index-copy h1{font-size:2.2rem}.blog-taxonomy-panel h2{font-size:1.8rem}.blog-content-panel{padding:22px 20px 28px}}</style></head><body><div class="blog-layout">${sidebarHtml}<main class="blog-main">${contentHtml}</main>${taxonomyHtml}</div></body></html>`;
}
function wrapBlogIndexHtml(posts, weeks = [], months = [], years = []) {
  const sidebar = buildBlogSidebarHtml(posts, null, weeks, months, years, "index");
  const taxonomy = buildBlogCategorySidebarHtml(posts);
  const content = [`<section class="blog-content-panel blog-index-copy">`,`<h1>Nikki Blog</h1>`,`<p>日別、週別、月別、年別のまとまりから記事を選べます。</p>`,`<h2>年別</h2>`,`<ul>${years.map((year) => `<li><a href="./years/${path.posix.basename(year.htmlPath)}">${escapeHtml(year.year)} (${year.postCount}日)</a></li>`).join("")}</ul>`,`<h2>月別</h2>`,`<ul>${months.map((month) => `<li><a href="./months/${path.posix.basename(month.htmlPath)}">${escapeHtml(month.month)} (${month.posts.length}日)</a></li>`).join("")}</ul>`,`<h2>週別</h2>`,`<ul>${weeks.map((week) => `<li><a href="./weeks/${path.posix.basename(week.htmlPath)}">${escapeHtml(week.week)} (${week.posts.length}日)</a></li>`).join("")}</ul>`,`</section>`].join("");
  return wrapBlogLayoutHtml(sidebar, content, taxonomy, "Nikki Blog");
}
function wrapBlogPostHtml(post, entry, posts, weeks = [], months = [], years = []) {
    const currentIndex = posts.findIndex((candidate) => candidate.slug === post.slug);
    const previousPost = currentIndex > 0 ? posts[currentIndex - 1] : null;
    const nextPost = currentIndex >= 0 && currentIndex < posts.length - 1 ? posts[currentIndex + 1] : null;
    const sidebar = buildBlogSidebarHtml(posts, post.slug, weeks, months, years, "post");
    const taxonomy = buildBlogCategorySidebarHtml(posts, post);
    const bodyHtml = marked.parse(entry.markdownBody || "");
    const imageGalleryHtml = buildBlogImageGalleryHtml(post, entry);
    const content = [
      `<section class="blog-content-panel">`,
      buildBlogNavHtml(previousPost, nextPost),
      `<article class="blog-article">`,
      `<h1>${escapeHtml(entry.title || post.title)}</h1>`,
      `<ul class="blog-meta"><li>日付: ${escapeHtml(entry.date || post.date || "unknown")}</li><li>entryId: ${escapeHtml(entry.itemId || post.entryId)}</li></ul>`,
      bodyHtml,
      imageGalleryHtml,
      buildBlogThreadListHtml(post),
      `<section class="blog-post-categories"><h2>カテゴリ</h2><div class="blog-category-chips">${(post.categories || []).map((category) => `<span class="blog-category-chip">${escapeHtml(category.label)}</span>`).join("") || `<span class="blog-category-chip">未分類</span>`}</div></section>`,
      `</article>`,
      buildBlogNavHtml(previousPost, nextPost).replace("blog-post-nav", "blog-post-nav bottom"),
      `</section>`
    ].join("");
    return wrapBlogLayoutHtml(sidebar, content, taxonomy, entry.title || post.title || "Nikki Blog");
  }
  function wrapBlogWeekHtml(week, posts, weeks = [], months = [], years = []) {
    const sidebar = buildBlogSidebarHtml(posts, null, weeks, months, years, "week");
    const taxonomy = buildBlogCategorySidebarHtml(week.posts || []);
    const statsHtml = marked.parse(buildArchiveStatsMarkdown(week.stats));
    const summaryHtml = week.summary ? marked.parse(buildWeeklySummaryMarkdown(week.summary)) : "";
    const content = [
      `<section class="blog-content-panel blog-index-copy">`,
      `<h1>${escapeHtml(week.summary?.title || week.title)}</h1>`,
      `<p>${escapeHtml(week.posts.length)}日分の記録</p>`,
      statsHtml ? `<article class="blog-article">${statsHtml}</article>` : "",
      summaryHtml ? `<article class="blog-article">${summaryHtml}</article>` : "",
      `<h2>日別</h2>`,
      `<ul>`,
      ...(week.posts || []).map((post) => `<li><a href="../posts/${path.posix.basename(post.htmlPath)}">${escapeHtml(post.date || "unknown")} | ${escapeHtml(post.title)}</a></li>`),
      `</ul>`,
      `</section>`
    ].join("");
    return wrapBlogLayoutHtml(sidebar, content, taxonomy, week.summary?.title || week.title || "Nikki Blog");
  }
  function wrapBlogMonthHtml(month, posts, weeks = [], months = [], years = []) {
    const sidebar = buildBlogSidebarHtml(posts, null, weeks, months, years, "month");
    const taxonomy = buildBlogCategorySidebarHtml(month.posts || []);
    const statsHtml = marked.parse(buildArchiveStatsMarkdown(month.stats));
    const summaryHtml = month.summary ? marked.parse(buildMonthlySummaryMarkdown(month.summary)) : "";
    const content = [
      `<section class="blog-content-panel blog-index-copy">`,
      `<h1>${escapeHtml(month.summary?.title || month.title)}</h1>`,
      `<p>${escapeHtml(month.posts.length)}日分の記録</p>`,
      statsHtml ? `<article class="blog-article">${statsHtml}</article>` : "",
      summaryHtml ? `<article class="blog-article">${summaryHtml}</article>` : "",
      `<h2>週別</h2>`,
      `<ul>`,
      ...(month.weeks || []).map((week) => `<li><a href="../weeks/${path.posix.basename(week.htmlPath)}">${escapeHtml(week.week)} (${escapeHtml(week.posts.length)}日)</a></li>`),
      `</ul>`,
      `</section>`
    ].join("");
    return wrapBlogLayoutHtml(sidebar, content, taxonomy, month.summary?.title || month.title || "Nikki Blog");
  }
  function wrapBlogYearHtml(year, posts, weeks = [], months = [], years = []) {
    const sidebar = buildBlogSidebarHtml(posts, null, weeks, months, years, "year");
    const yearMonths = months.filter((month) => month.month.startsWith(year.year));
    const taxonomy = buildBlogCategorySidebarHtml(yearMonths.flatMap((month) => month.posts || []));
    const statsHtml = marked.parse(buildArchiveStatsMarkdown(year.stats));
    const summaryHtml = year.summary ? marked.parse(buildYearlySummaryMarkdown(year.summary)) : "";
    const content = [
      `<section class="blog-content-panel blog-index-copy">`,
      `<h1>${escapeHtml(year.summary?.title || year.title)}</h1>`,
      `<p>${escapeHtml(yearMonths.length)}か月、${escapeHtml(year.postCount)}日分の記録</p>`,
      statsHtml ? `<article class="blog-article">${statsHtml}</article>` : "",
      summaryHtml ? `<article class="blog-article">${summaryHtml}</article>` : "",
      `<h2>月別</h2>`,
      `<ul>`,
      ...yearMonths.map((month) => `<li><a href="../months/${path.posix.basename(month.htmlPath)}">${escapeHtml(month.month)} (${escapeHtml(month.posts.length)}日)</a></li>`),
      `</ul>`,
      `</section>`
    ].join("");
    return wrapBlogLayoutHtml(sidebar, content, taxonomy, year.summary?.title || year.title || "Nikki Blog");
  }
  function buildBlogImageGalleryHtml(post, entry) {
    const images = normalizeEntryImages(entry);
    if (!images.length) {
      return "";
    }
    return [
      `<section class="blog-image-gallery">`,
      `<h2>生成画像</h2>`,
      `<div class="blog-image-grid">`,
      ...images.map((image) => {
        const href = escapeHtml(fileUrl(image.path));
        const caption = escapeHtml(image.caption || "生成画像");
        return `<figure class="blog-image-card"><a href="${href}" target="_blank" rel="noreferrer"><img src="${href}" alt="${caption}" loading="lazy" /></a><figcaption>${caption}</figcaption></figure>`;
      }),
      `</div>`,
      `</section>`
      ].join("");
  }
  function buildBlogThreadListHtml(post) {
    if (!post?.threads?.length) {
      return "";
    }
    return [
      `<section class="blog-thread-list">`,
      `<h2>関連スレッド</h2>`,
      `<ul>`,
        ...post.threads.map((thread) => `<li><strong>${escapeHtml(thread.itemId)}</strong>: ${escapeHtml(thread.title || thread.itemId)}${thread.categoryLabel ? ` <span class="blog-thread-category">[${escapeHtml(thread.categoryLabel)}]</span>` : ""}${thread.chatgptUrl ? ` <a class="blog-thread-link" href="${escapeHtml(thread.chatgptUrl)}" target="_blank" rel="noreferrer">ChatGPTで開く</a>` : ""}</li>`),
        `</ul>`,
        `</section>`
      ].join("");
    }
    function wrapHtml(bodyHtml) { return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Nikki Diary</title><style>:root{--bg:#f5f0e8;--panel:#fffaf3;--ink:#1f1a17;--accent:#a54b2a;--line:#ddcdbd}body{margin:0;font-family:"Yu Mincho","Hiragino Mincho ProN",serif;color:var(--ink);background:radial-gradient(circle at top left,rgba(165,75,42,.10),transparent 28%),linear-gradient(180deg,#f7efe4 0%,#efe5d6 100%)}main{max-width:900px;margin:0 auto;padding:48px 20px 80px}article{background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(53,37,24,.08);padding:40px}h1,h2,h3{line-height:1.3}h1{font-size:2.2rem;border-bottom:2px solid var(--accent);padding-bottom:.4em}h2{margin-top:2.4em;color:var(--accent)}p,li{font-size:1rem;line-height:1.9}ul{padding-left:1.4em}.blog-image-gallery,.blog-thread-list{margin-top:32px;padding-top:20px;border-top:1px solid var(--line)}.blog-image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.blog-image-card{margin:0}.blog-image-card img{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--line)}.blog-image-card figcaption{margin-top:8px;font-size:.95rem;line-height:1.7}.blog-thread-category{color:var(--accent)}.blog-thread-link{margin-left:.5em}@media print{body{background:#fff}main{padding:0}article{box-shadow:none;border:none;border-radius:0;padding:0}}</style></head><body><main><article>${bodyHtml}</article></main></body></html>`; }
function emitEvent(runtime, payload) { fs.appendFileSync(runtime.paths.events, `${JSON.stringify({ at: isoJst(), runId: runtime.config.runId, ...payload })}\n`, "utf8"); runtime.current.lastEvent = payload.type || null; runtime.current.note = payload.note || null; }
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
async function getAppServerClient(config) { if (!appServerClientPromise) appServerClientPromise = createAgentClient(config); return appServerClientPromise; }
async function closeAppServerClient() { if (!appServerClientPromise) return; const client = await appServerClientPromise.catch(() => null); appServerClientPromise = null; if (client) await client.close(); }
async function resolveCodexCommand() { return resolveCommand("codex", ["codex.exe", "codex.cmd", "codex"]); }
async function resolveCopilotCommand() { return resolveCommand("github-copilot-cli", ["github-copilot-cli.exe", "github-copilot-cli.cmd", "github-copilot-cli"]); }

async function createAgentClient(config) {
  const provider = resolveRuntimeProvider(config);
  if (provider === "copilot") {
    return CopilotAppServerClient.create(config);
  }
  if (provider === "ollama") {
    return OllamaClient.create(config);
  }
  return AppServerClient.create(config);
}

function resolveRuntimeProvider(config) {
  if (config.runtime?.provider === "copilot" || config.provider === "copilot") {
    return "copilot";
  }
  if (config.runtime?.provider === "ollama" || config.provider === "ollama") {
    return "ollama";
  }
  return "codex";
}

function normalizeAgentRuntimeConfig(config, provider) {
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

function getOllamaSystemPrompt(config) {
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
