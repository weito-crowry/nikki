import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { marked } from "marked";
import { TASK_DEFINITIONS } from "./task-definitions.js";

const execFileAsync = promisify(execFile);
let appServerClientPromise = null;

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
  emitEvent(runtime, { type: "run.started", note: "run を開始しました" });
  writeProgress(runtime, { status: "running", note: "初期化完了", lastEvent: "run.started" });

  try {
    for (const definition of TASK_DEFINITIONS) {
      const items = enumerateItems(runtime, definition.itemType);
      const runnableItems = registerPlanned(runtime, definition, items);
      for (const item of runnableItems) {
        await executeTask(runtime, definition, item);
      }
    }
    emitEvent(runtime, { type: "run.completed", note: "完了" });
    writeProgress(runtime, { status: "completed", note: "完了", lastEvent: "run.completed", stage: null, taskKey: null, itemType: null, currentItemId: null, currentTaskInstanceId: null });
    console.log("\n完了");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent(runtime, { type: "run.failed", note: message });
    writeProgress(runtime, { status: "failed", note: message, lastEvent: "run.failed" });
    throw error;
  } finally {
    await closeAppServerClient();
    releaseRunLock(runtime);
  }
}

function createRuntime(config) {
  const runId = sanitizeId(config.runId || path.basename(config.outputDir || "run"));
  const now = isoJst();
  const provider = config.provider === "copilot" ? "copilot" : "codex";
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
    counts: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    current: { stage: null, taskKey: null, itemType: null, itemId: null, taskInstanceId: null, promptPreview: null, sentAt: null, lastEvent: null, note: null },
    lock: null
  };
}

function initRun(runtime) {
  ensureDir(runtime.paths.root);
  for (const relative of [
    "work/extracted",
    "artifacts/manifest",
    "artifacts/indexes",
    "artifacts/normalized",
    "artifacts/ai/thread_classification",
    "artifacts/ai/thread_findings",
    "artifacts/ai/unit_summaries",
    "artifacts/ai/diary_drafts",
    "artifacts/ai/diary_entries",
    "artifacts/chunks/ai.classify_thread",
    "artifacts/chunks/ai.extract_findings",
    "artifacts/raw",
    "artifacts/units",
    "artifacts/render",
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
  return [];
}

function registerPlanned(runtime, definition, items) {
  const filteredItems = applyItemFilters(runtime, definition, items);
  for (const item of filteredItems) runtime.planned.add(taskInstanceId(definition.taskKey, item.itemId));
  runtime.counts.total = runtime.planned.size;
  runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
  return filteredItems;
}

async function executeTask(runtime, definition, item) {
  const instanceId = taskInstanceId(definition.taskKey, item.itemId);
  runtime.current = { stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, promptPreview: null, sentAt: null, lastEvent: null, note: null };
  const meta = await buildTaskMeta(runtime, definition, item);
  const state = readState(runtime, definition.taskKey, item.itemId);
  const dependsOn = resolveDependsOn(runtime, definition.taskKey, item.itemId);
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
  emitEvent(runtime, { type: "task.started", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, note: "task を開始しました" });
  writeState(runtime, definition, item.itemId, { status: "running", dependsOn, inputHash: meta.inputHash, promptHash: meta.promptHash, model: meta.model, artifactPaths: state?.artifactPaths || [], startedAt: isoJst(), finishedAt: null, retryCount: Number(state?.retryCount || 0), error: null });
  writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, promptPreview: meta.promptPreview, note: "実行中", lastEvent: "task.started" });

  try {
    const artifactPaths = await runHandler(runtime, definition.taskKey, item.itemId, meta);
    runtime.changed.add(instanceId);
    runtime.invalidated.delete(instanceId);
    runtime.counts.running -= 1;
    runtime.counts.completed += 1;
    runtime.counts.pending = Math.max(runtime.counts.total - runtime.counts.completed - runtime.counts.failed - runtime.counts.skipped - runtime.counts.running, 0);
    writeState(runtime, definition, item.itemId, { status: "completed", dependsOn, inputHash: meta.inputHash, promptHash: meta.promptHash, model: meta.model, artifactPaths, startedAt: readState(runtime, definition.taskKey, item.itemId)?.startedAt || isoJst(), finishedAt: isoJst(), retryCount: Number(state?.retryCount || 0), error: null });
    emitEvent(runtime, { type: "task.completed", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, itemId: item.itemId, taskInstanceId: instanceId, artifactPaths, note: "task が完了しました" });
    writeProgress(runtime, { status: "running", stage: definition.stage, taskKey: definition.taskKey, itemType: definition.itemType, currentItemId: item.itemId, currentTaskInstanceId: instanceId, promptPreview: meta.promptPreview, sentAt: runtime.current.sentAt, note: "完了", lastEvent: "task.completed" });
    logConsole("done", instanceId);
  } catch (error) {
    runtime.counts.running -= 1;
    runtime.counts.failed += 1;
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
      return { inputHash: hashJson(readArtifact(runtime, "artifacts/manifest/export-manifest.json") || {}), promptHash: null, model: null, promptPreview: null };
    case "analyze.normalize_threads":
      return { inputHash: hashJson(readArtifact(runtime, "artifacts/indexes/thread-index.json") || {}), promptHash: null, model: null, promptPreview: null };
    case "analyze.attach_images":
      return { inputHash: hashJson(loadThreads(runtime).map((thread) => ({ itemId: thread.itemId, attachments: thread.messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0), generatedImages: thread.messages.reduce((sum, message) => sum + (message.generatedImages?.length || 0), 0) }))), promptHash: null, model: null, promptPreview: null };
    case "ai.generate_category_candidates": {
      if (runtime.config.freezeCategories) {
        const categories = readCategoryMaster(runtime) || {};
        return { inputHash: hashJson({ frozen: true, categories }), promptHash: hashText("ai.generate_category_candidates/frozen/v1"), model: resolveModelForTask(runtime, "ai.generate_category_candidates"), promptPreview: "カテゴリ候補生成（固定カテゴリ再利用）" };
      }
      const sample = loadScopedThreads(runtime).slice(0, 200).map((thread) => ({ itemId: thread.itemId, title: thread.title, primaryDate: thread.primaryDate, preview: thread.preview, generatedImageCount: thread.generatedImageCount }));
      const prompt = ["以下は OpenAI エクスポートから抽出した会話スレッド一覧です。", "ユーザーの関心や疑問を日記にしやすいカテゴリを作ってください。", `カテゴリ数は最大 ${runtime.config.maxCategories} 個。`, "出力は JSON のみ。", '{"categories":[{"id":"short-id","label":"表示名","description":"分類方針","keywords":["語1","語2"]}]}', JSON.stringify(sample, null, 2)].join("\n\n");
      return aiMeta(runtime, prompt, { maxCategories: runtime.config.maxCategories, sample });
    }
    case "ai.classify_thread": {
      const thread = readThread(item.itemId);
      const categories = readCategoryMaster(runtime) || {};
      return { inputHash: hashJson({ categories, thread }), promptHash: hashText("ai.classify_thread/adaptive-split/v1"), model: resolveModelForTask(runtime, "ai.classify_thread"), promptPreview: "スレッド分類（コンテキスト超過時のみ adaptive split）" };
    }
    case "ai.extract_findings": {
      const thread = readThread(item.itemId);
      return { inputHash: hashJson(thread), promptHash: hashText("ai.extract_findings/adaptive-split/v1"), model: resolveModelForTask(runtime, "ai.extract_findings"), promptPreview: "スレッド findings 抽出（コンテキスト超過時のみ adaptive split）" };
    }
    case "analyze.group_units":
      return { inputHash: hashJson({ grouping: runtime.config.grouping, targetThreadItemIds: runtime.config.targetThreadItemIds || null, threads: loadScopedThreadIndex(runtime), classifications: [...loadScopedClassifications(runtime).entries()] }), promptHash: null, model: null, promptPreview: null };
    case "ai.summarize_unit": {
      const unit = readUnit(runtime, item.itemId);
      const payload = { grouping: runtime.config.grouping, unit, threads: unit.threadItemIds.map((threadItemId) => readThread(threadItemId)), classifications: unit.threadItemIds.map((threadItemId) => readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`)), findings: unit.threadItemIds.map((threadItemId) => readArtifact(runtime, `artifacts/ai/thread_findings/${threadItemId}.json`)) };
      const prompt = [`単位: ${unit.itemId}`, `表示名: ${unit.label}`, "以下の情報から日記用の unit 要約を作成してください。", "出力は JSON のみ。", '{"summaryTitle":"見出し","interests":["..."],"questions":["..."],"outcomes":["..."],"images":[{"path":"...","prompt":"...","note":"..."}],"narrative":"2-5文の要約"}', JSON.stringify(payload, null, 2)].join("\n\n");
      return aiMeta(runtime, prompt, payload);
    }
    case "ai.write_diary_entry": {
      const entry = readEntry(runtime, item.itemId);
      const prompt = [`日記エントリID: ${entry.itemId}`, `対象日付: ${entry.date}`, "以下の unit 要約から、その日の日記本文草稿を作ってください。", "出力は JSON のみ。", '{"title":"見出し","lead":"導入","sections":[{"heading":"見出し","body":"本文"}],"closing":"締め","images":[{"path":"...","caption":"..."}]}', JSON.stringify(entry, null, 2)].join("\n\n");
      return aiMeta(runtime, prompt, entry);
    }
    case "ai.rewrite_diary_entry": {
      const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${item.itemId}.json`) || {};
      const prompt = ["次の日記草稿を自然な日本語の日記として整形してください。", "事実は変えず、冗長さだけを減らしてください。", "出力は JSON のみ。", '{"title":"見出し","markdownBody":"Markdown 本文","images":[{"path":"...","caption":"..."}]}', JSON.stringify(draft, null, 2)].join("\n\n");
      return aiMeta(runtime, prompt, draft);
    }
    case "render.markdown":
      return { inputHash: hashJson({ grouping: runtime.config.grouping, entries: loadDiaryEntries(runtime) }), promptHash: null, model: null, promptPreview: null };
    case "render.html":
      return { inputHash: hashJson(readArtifact(runtime, "artifacts/render/diary.json") || {}), promptHash: null, model: null, promptPreview: null };
    case "render.pdf":
      return { inputHash: hashJson(fileStat(path.join(runtime.paths.root, "artifacts", "render", "diary.html"))), promptHash: null, model: null, promptPreview: null };
    default:
      return { inputHash: hashJson({ taskKey: definition.taskKey, itemId: item.itemId }), promptHash: null, model: null, promptPreview: null };
  }
}

function aiMeta(runtime, prompt, input) {
  return { prompt, input, inputHash: hashJson(input), promptHash: hashText(prompt), model: resolveModelForTask(runtime, runtime.current.taskKey), promptPreview: clip(prompt.replace(/\s+/g, " "), 220) };
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
    return [{ parsed: response.parsed, text: response.text, cacheHit: response.cacheHit, path: pathKey, groups }];
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
  return ["次のスレッド全体を主カテゴリ 1 件と補助カテゴリ最大 2 件に分類してください。", "長いスレッドは複数チャンクの一部である可能性があります。与えられた内容だけから妥当な分類をしてください。", "既存カテゴリで収まりが悪い場合のみ、新カテゴリ候補を proposedCategories に追加してください。", "新カテゴリ候補は最小限にしてください。", "出力は JSON のみ。", '{"primary":"category-id","secondary":["category-id"],"reason":"短い理由","proposedCategories":[{"id":"new-category-id","label":"表示名","description":"分類方針","keywords":["語1","語2"]}]}', "カテゴリ定義:", JSON.stringify(categories.categories || [], null, 2), "対象スレッド:", JSON.stringify(payload, null, 2)].join("\n\n");
}

function buildExtractFindingsPrompt(payload) {
  return ["次の会話スレッドから日記に必要な構造化情報を抽出してください。", "長いスレッドは複数チャンクの一部である可能性があります。与えられた内容だけから抽出してください。", "重視点: interests, questions, outcomes, images, narrative", "出力は JSON のみ。", '{"interests":["..."],"questions":[{"text":"...","status":"resolved|partially_resolved|unresolved"}],"outcomes":["..."],"images":[{"path":"...","note":"..."}],"narrative":"2-5文の要約"}', JSON.stringify(payload, null, 2)].join("\n\n");
}

function mergeClassificationResults(items) {
  const primaryCounts = new Map();
  const secondaryCounts = new Map();
  const reasons = [];
  const proposedCategories = [];
  for (const item of items) {
    const primary = item?.primary || "uncategorized";
    primaryCounts.set(primary, (primaryCounts.get(primary) || 0) + 1);
    for (const secondary of Array.isArray(item?.secondary) ? item.secondary : []) {
      secondaryCounts.set(secondary, (secondaryCounts.get(secondary) || 0) + 1);
    }
    if (item?.reason) {
      reasons.push(String(item.reason));
    }
    if (Array.isArray(item?.proposedCategories)) {
      proposedCategories.push(...item.proposedCategories);
    }
  }
  const primary = [...primaryCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "uncategorized";
  const secondary = [...secondaryCounts.entries()].filter(([value]) => value && value !== primary).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([value]) => value);
  return { primary, secondary, reason: reasons[0] || "", proposedCategories: normalizeProposedCategories(proposedCategories) };
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
  return readArtifact(runtime, "artifacts/ai/category_master.json") || readArtifact(runtime, "artifacts/ai/categories.json") || null;
}

function writeCategoryMaster(runtime, value) {
  writeArtifact(runtime, "artifacts/ai/category_master.json", value);
  writeArtifact(runtime, "artifacts/ai/categories.json", value);
}

function readCategorySuggestions(runtime) {
  return readArtifact(runtime, "artifacts/ai/category_suggestions.json") || { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, items: [] };
}

function writeCategorySuggestions(runtime, value) {
  writeArtifact(runtime, "artifacts/ai/category_suggestions.json", value);
}

function normalizeProposedCategories(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const label = String(item.label || "").trim();
    const rawId = String(item.id || label).trim();
    const id = sanitizeId(rawId).toLowerCase();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push({
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
  const currentSuggestions = readCategorySuggestions(runtime);
  const suggestionItems = Array.isArray(currentSuggestions.items) ? currentSuggestions.items : [];
  for (const category of normalized) {
    suggestionItems.push({
      id: category.id,
      label: category.label,
      description: category.description,
      keywords: category.keywords,
      sourceTaskKey: "ai.classify_thread",
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
  const current = readCategoryMaster(runtime) || { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, categories: [], aiMeta: null };
  const existing = Array.isArray(current.categories) ? current.categories : [];
  const byId = new Map(existing.map((category) => [category.id, category]));
  let changed = false;
  for (const category of normalized) {
    if (byId.has(category.id)) {
      continue;
    }
    existing.push(category);
    byId.set(category.id, category);
    changed = true;
  }
  if (!changed) {
    return false;
  }
  writeCategoryMaster(runtime, {
    ...current,
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    categories: existing,
    updatedBy: itemId ? { taskKey: "ai.classify_thread", itemId, at: isoJst() } : current.updatedBy || null
  });
  if (itemId) {
    const note = `新カテゴリを category master に追加しました (${normalized.map((category) => category.id).join(", ")})`;
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
  return messages.map((message) => ({
    role: message.role,
    date: message.date,
    contentType: message.contentType,
    text: clip(message.text || "", 4000),
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
    generatedImageCount: Array.isArray(message.generatedImages) ? message.generatedImages.length : 0
  }));
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

function resolveDependsOn(runtime, taskKey, itemId) {
  if (taskKey === "prepare.extract_export") return [];
  if (taskKey === "prepare.scan_export") return [taskInstanceId("prepare.extract_export", "run")];
  if (taskKey === "prepare.build_thread_index") return [taskInstanceId("prepare.scan_export", "run")];
  if (taskKey === "analyze.normalize_threads") return [taskInstanceId("prepare.build_thread_index", "run")];
  if (taskKey === "analyze.attach_images") return [taskInstanceId("analyze.normalize_threads", "run")];
  if (taskKey === "ai.generate_category_candidates") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "ai.classify_thread") return runtime.config.freezeCategories
    ? [taskInstanceId("analyze.attach_images", "run")]
    : [taskInstanceId("analyze.attach_images", "run"), taskInstanceId("ai.generate_category_candidates", "run")];
  if (taskKey === "ai.extract_findings") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "analyze.group_units") return (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).filter((thread) => {
    if (!runtime.config.targetThreadItemIds?.length) return true;
    return runtime.config.targetThreadItemIds.includes(thread.itemId);
  }).flatMap((thread) => [taskInstanceId("ai.classify_thread", thread.itemId), taskInstanceId("ai.extract_findings", thread.itemId)]);
  if (taskKey === "ai.summarize_unit") return [taskInstanceId("analyze.group_units", "run"), ...readUnit(runtime, itemId).threadItemIds.flatMap((threadItemId) => [taskInstanceId("ai.classify_thread", threadItemId), taskInstanceId("ai.extract_findings", threadItemId)])];
  if (taskKey === "ai.write_diary_entry") return readEntry(runtime, itemId).unitSummaries.map((unitSummary) => taskInstanceId("ai.summarize_unit", unitSummary.itemId));
  if (taskKey === "ai.rewrite_diary_entry") return [taskInstanceId("ai.write_diary_entry", itemId)];
  if (taskKey === "render.markdown") return loadDiaryEntries(runtime).map((entry) => taskInstanceId("ai.rewrite_diary_entry", entry.itemId));
  if (taskKey === "render.html") return [taskInstanceId("render.markdown", "run")];
  if (taskKey === "render.pdf") return [taskInstanceId("render.html", "run")];
  return [];
}

function reusable(state, runtime, definition, item, meta, dependsOn, invalidation) {
  if (runtime.config.force || !state || state.status !== "completed") return false;
  if (shouldRerunExplicitItem(runtime, item)) return false;
  if (invalidation) return false;
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
  if (shouldRerunExplicitItem(runtime, item)) {
    return { reason: "--item-id 指定により対象 item を再実行します" };
  }
  if (state.status === "running") {
    return { reason: "前回実行が running のまま終了していたため再実行します" };
  }
  if (state.status === "failed") {
    return { reason: runtime.config.retryFailed ? "failed task を再試行します" : "failed task を再実行します" };
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

function hasArtifacts(runtime, artifactPaths) {
  return Array.isArray(artifactPaths) && artifactPaths.length > 0 && artifactPaths.every((relativePath) => fs.existsSync(path.join(runtime.paths.root, relativePath)));
}

function validateRunOptions(runtime) {
  if (runtime.config.date && !/^\d{4}-\d{2}-\d{2}$/.test(runtime.config.date)) {
    throw new Error(`--date の形式が不正です: ${runtime.config.date}`);
  }
  if (runtime.config.limit !== null && runtime.config.limit <= 0) {
    throw new Error(`--limit は 1 以上で指定してください: ${runtime.config.limit}`);
  }
  if (runtime.config.date && runtime.config.grouping === "category") {
    throw new Error("--group-by category では --date は指定できません。");
  }
  if (runtime.config.targetThreadItemIds && !Array.isArray(runtime.config.targetThreadItemIds)) {
    throw new Error("targetThreadItemIds は配列で指定してください。");
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
  if (runtime.config.targetThreadItemIds?.length) {
    filtered = filtered.filter((item) => matchesTargetThreadFilter(definition.itemType, item.meta || item, runtime.config.targetThreadItemIds));
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
  if (!runtime.config.only?.length) {
    return true;
  }
  return runtime.config.only.some((pattern) => taskKey === pattern || taskKey.startsWith(`${pattern}.`) || taskKey.startsWith(pattern));
}

function shouldRerunExplicitItem(runtime, item) {
  return Boolean(item?.itemId && runtime.config.itemIds?.length && runtime.config.itemIds.includes(item.itemId));
}

function matchesTargetThreadFilter(itemType, meta, targetThreadItemIds) {
  const allow = new Set(targetThreadItemIds || []);
  if (!allow.size) {
    return true;
  }
  if (itemType === "run") {
    return true;
  }
  if (itemType === "thread") {
    return allow.has(meta.itemId);
  }
  if (itemType === "unit" || itemType === "entry") {
    return (meta.threadItemIds || []).some((threadItemId) => allow.has(threadItemId));
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
  return meta.date === date || meta.itemId === `entry_${date}` || meta.itemId === `unit_date_${date}`;
}

async function runHandler(runtime, taskKey, itemId, meta) {
  if (taskKey === "prepare.extract_export") return handleExtractExport(runtime);
  if (taskKey === "prepare.scan_export") return handleScanExport(runtime);
  if (taskKey === "prepare.build_thread_index") return handleBuildThreadIndex(runtime);
  if (taskKey === "analyze.normalize_threads") return handleNormalizeThreads(runtime);
  if (taskKey === "analyze.attach_images") return handleAttachImages(runtime);
  if (taskKey === "ai.generate_category_candidates") return handleCategories(runtime, meta);
  if (taskKey === "ai.classify_thread") return handleClassifyThread(runtime, itemId, meta);
  if (taskKey === "ai.extract_findings") return handleExtractFindings(runtime, itemId, meta);
  if (taskKey === "analyze.group_units") return handleGroupUnits(runtime);
  if (taskKey === "ai.summarize_unit") return handleSummarizeUnit(runtime, itemId, meta);
  if (taskKey === "ai.write_diary_entry") return handleWriteEntry(runtime, itemId, meta);
  if (taskKey === "ai.rewrite_diary_entry") return handleRewriteEntry(runtime, itemId, meta);
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
  const threads = rawThreads.map((thread, index) => ({ itemId: `thread_${String(index + 1).padStart(6, "0")}`, sourceThreadId: thread.sourceThreadId, title: thread.title, primaryDate: thread.primaryDate, messageCount: thread.messageCount, userMessageCount: thread.userMessageCount, assistantMessageCount: thread.assistantMessageCount, generatedImageCount: thread.generatedImageCount, preview: thread.preview, sourceFile: thread.sourceFile }));
  const messages = rawThreads.flatMap((thread, index) => thread.messages.map((message) => ({ threadItemId: `thread_${String(index + 1).padStart(6, "0")}`, messageId: message.id, role: message.role, date: message.date })));
  writeArtifact(runtime, "artifacts/indexes/thread-index.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, threads });
  writeArtifact(runtime, "artifacts/indexes/message-index.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, messages });
  return ["artifacts/indexes/thread-index.json", "artifacts/indexes/message-index.json"];
}

function handleNormalizeThreads(runtime) {
  const indexBySource = new Map((readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => [thread.sourceThreadId, thread.itemId]));
  const artifactPaths = [];
  for (const thread of loadRawThreads(runtime.paths.extracted)) {
    const itemId = indexBySource.get(thread.sourceThreadId);
    if (!itemId) continue;
    writeArtifact(runtime, `artifacts/normalized/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, sourceThreadId: thread.sourceThreadId, title: thread.title, primaryDate: thread.primaryDate, createTime: thread.createTime, updateTime: thread.updateTime, messageCount: thread.messageCount, userMessageCount: thread.userMessageCount, assistantMessageCount: thread.assistantMessageCount, generatedImageCount: thread.generatedImageCount, preview: thread.preview, messages: thread.messages });
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

async function handleCategories(runtime, meta) {
  if (runtime.config.freezeCategories) {
    const artifact = readCategoryMaster(runtime);
    if (!artifact) {
      throw new Error("freezeCategories=true ですが artifacts/ai/category_master.json が存在しません。");
    }
    return ["artifacts/ai/category_master.json", "artifacts/ai/categories.json"];
  }
  const response = await askForJson(runtime, "ai.generate_category_candidates", "run", "categories", meta);
  writeCategoryMaster(runtime, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, categories: Array.isArray(response.parsed.categories) ? response.parsed.categories : [], aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: "codex-app-server", cacheHit: response.cacheHit } });
  writeRaw(runtime, "ai.generate_category_candidates", "run", response.text);
  return ["artifacts/ai/category_master.json", "artifacts/ai/categories.json", "artifacts/raw/ai.generate_category_candidates/run.raw.json"];
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
  writeArtifact(runtime, `artifacts/ai/thread_classification/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, primary: response.parsed.primary || "uncategorized", secondary: Array.isArray(response.parsed.secondary) ? response.parsed.secondary : [], reason: response.parsed.reason || "", proposedCategories: Array.isArray(response.parsed.proposedCategories) ? response.parsed.proposedCategories : [], aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: `${runtime.config.provider}-app-server`, cacheHit: response.cacheHit, adaptiveSplit: response.adaptiveSplit, chunkCount: response.chunkCount, categoryMasterUpdated: masterUpdated } });
  writeRaw(runtime, "ai.classify_thread", itemId, response.text);
  return artifactPaths;
}

async function handleExtractFindings(runtime, itemId, meta) {
  const thread = readArtifact(runtime, `artifacts/normalized/${itemId}.json`);
  const response = await askForAdaptiveThreadJson(runtime, { taskKey: "ai.extract_findings", itemId, name: `findings-${itemId}`, model: meta.model, thread, baseInput: { threadId: itemId }, buildPrompt: (payload) => buildExtractFindingsPrompt(payload), mergeParsed: mergeFindingsResults });
  writeArtifact(runtime, `artifacts/ai/thread_findings/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [], questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [], outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [], images: Array.isArray(response.parsed.images) ? response.parsed.images : [], narrative: response.parsed.narrative || "", aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: `${runtime.config.provider}-app-server`, cacheHit: response.cacheHit, adaptiveSplit: response.adaptiveSplit, chunkCount: response.chunkCount } });
  writeRaw(runtime, "ai.extract_findings", itemId, response.text);
  return [`artifacts/ai/thread_findings/${itemId}.json`, `artifacts/raw/ai.extract_findings/${itemId}.raw.json`];
}

function handleGroupUnits(runtime) {
  const classes = loadClassifications(runtime);
  const labels = new Map((readCategoryMaster(runtime)?.categories || []).map((category) => [category.id, category.label]));
  const existing = readArtifact(runtime, "artifacts/units/units.json")?.items || [];
  const allThreads = readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [];
  const targetThreadItemIds = new Set(runtime.config.targetThreadItemIds || []);
  const scopedThreads = targetThreadItemIds.size > 0 ? allThreads.filter((thread) => targetThreadItemIds.has(thread.itemId)) : allThreads;
  const affectedDates = new Set(scopedThreads.map((thread) => thread.primaryDate || "unknown"));
  const preserved = runtime.config.grouping === "category"
    ? []
    : existing.filter((unit) => !affectedDates.has(unit.date || "unknown"));
  const buckets = new Map(preserved.map((unit) => [unit.itemId, { ...unit, threadItemIds: [...(unit.threadItemIds || [])] }]));
  for (const thread of allThreads) {
    const date = thread.primaryDate || "unknown";
    if (runtime.config.grouping !== "category" && affectedDates.size > 0 && !affectedDates.has(date)) {
      continue;
    }
    if (targetThreadItemIds.size > 0 && runtime.config.grouping === "category" && !targetThreadItemIds.has(thread.itemId)) {
      continue;
    }
    const classification = classes.get(thread.itemId);
    const category = runtime.config.grouping === "category" ? (classification?.primary || "uncategorized") : null;
    const itemId = runtime.config.grouping === "category" ? `unit_category_${category}` : `unit_date_${date}`;
    if (!buckets.has(itemId)) buckets.set(itemId, { itemId, label: runtime.config.grouping === "category" ? (labels.get(category) || category) : `${date} の記録`, date, category, entryId: `entry_${date}`, threadItemIds: [] });
    if (!buckets.get(itemId).threadItemIds.includes(thread.itemId)) {
      buckets.get(itemId).threadItemIds.push(thread.itemId);
    }
  }
  writeArtifact(runtime, "artifacts/units/units.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, unitStrategy: runtime.config.grouping === "category" ? "category" : "date", items: [...buckets.values()].sort((a, b) => a.itemId.localeCompare(b.itemId, "ja")) });
  return ["artifacts/units/units.json"];
}

async function handleSummarizeUnit(runtime, itemId, meta) {
  const response = await askForJson(runtime, "ai.summarize_unit", itemId, `unit-${itemId}`, meta);
  const unit = readUnit(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/unit_summaries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, label: unit.label, date: unit.date, category: unit.category, summaryTitle: response.parsed.summaryTitle || unit.label, interests: Array.isArray(response.parsed.interests) ? response.parsed.interests : [], questions: Array.isArray(response.parsed.questions) ? response.parsed.questions : [], outcomes: Array.isArray(response.parsed.outcomes) ? response.parsed.outcomes : [], images: Array.isArray(response.parsed.images) ? response.parsed.images : [], narrative: response.parsed.narrative || "", aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: "codex-app-server", cacheHit: response.cacheHit } });
  writeRaw(runtime, "ai.summarize_unit", itemId, response.text);
  return [`artifacts/ai/unit_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_unit/${itemId}.raw.json`];
}

async function handleWriteEntry(runtime, itemId, meta) {
  const response = await askForJson(runtime, "ai.write_diary_entry", itemId, `entry-draft-${itemId}`, meta);
  const entry = readEntry(runtime, itemId);
  writeArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: entry.date, title: response.parsed.title || `${entry.date} の日記`, lead: response.parsed.lead || "", sections: Array.isArray(response.parsed.sections) ? response.parsed.sections : [], closing: response.parsed.closing || "", images: Array.isArray(response.parsed.images) ? response.parsed.images : [], aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: "codex-app-server", cacheHit: response.cacheHit } });
  writeRaw(runtime, "ai.write_diary_entry", itemId, response.text);
  return [`artifacts/ai/diary_drafts/${itemId}.json`, `artifacts/raw/ai.write_diary_entry/${itemId}.raw.json`];
}

async function handleRewriteEntry(runtime, itemId, meta) {
  const response = await askForJson(runtime, "ai.rewrite_diary_entry", itemId, `entry-final-${itemId}`, meta);
  const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`) || {};
  writeArtifact(runtime, `artifacts/ai/diary_entries/${itemId}.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, itemId, date: draft.date, title: response.parsed.title || draft.title, markdownBody: response.parsed.markdownBody || draftToMarkdown(draft), images: Array.isArray(response.parsed.images) ? response.parsed.images : draft.images || [], aiMeta: { model: meta.model, promptHash: meta.promptHash, inputHash: meta.inputHash, provider: "codex-app-server", cacheHit: response.cacheHit } });
  writeRaw(runtime, "ai.rewrite_diary_entry", itemId, response.text);
  return [`artifacts/ai/diary_entries/${itemId}.json`, `artifacts/raw/ai.rewrite_diary_entry/${itemId}.raw.json`];
}

function handleRenderMarkdown(runtime) {
  const entries = loadDiaryEntries(runtime).sort((a, b) => (a.date || "").localeCompare(b.date || "", "ja"));
  const posts = writeRenderPostsMarkdown(runtime, entries);
  writeArtifact(runtime, "artifacts/render/diary.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, grouping: runtime.config.grouping, entries, posts });
  writeArtifact(runtime, "artifacts/render/posts.json", { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, posts });
  const markdown = ["# Nikki Diary", "", `- 生成日時: ${isoJst()}`, `- 集計単位: ${runtime.config.grouping}`, "", ...entries.flatMap((entry) => [`## ${entry.title || entry.itemId}`, "", entry.date ? `- 日付: ${entry.date}` : "", entry.date ? "" : "", entry.markdownBody || "", ""])].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.md"), markdown, "utf8");
  const indexMarkdown = buildRenderIndexMarkdown(posts);
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "index.md"), indexMarkdown, "utf8");
  return ["artifacts/render/diary.json", "artifacts/render/posts.json", "artifacts/render/diary.md", "artifacts/render/index.md", ...posts.map((post) => post.markdownPath)];
}

function handleRenderHtml(runtime) {
  const markdown = fs.readFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.md"), "utf8");
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "diary.html"), wrapHtml(marked.parse(markdown)), "utf8");
  const posts = readArtifact(runtime, "artifacts/render/posts.json")?.posts || [];
  const changedEntryIds = getChangedEntryIds(runtime);
  fs.writeFileSync(path.join(runtime.paths.root, "artifacts", "render", "index.html"), wrapBlogIndexHtml(posts), "utf8");
  for (const post of posts) {
    if (changedEntryIds.size > 0 && !changedEntryIds.has(post.entryId) && fs.existsSync(path.join(runtime.paths.root, post.htmlPath))) {
      continue;
    }
    const entry = readArtifact(runtime, `artifacts/ai/diary_entries/${post.entryId}.json`) || {};
    fs.writeFileSync(path.join(runtime.paths.root, post.htmlPath), wrapBlogPostHtml(post, entry, posts), "utf8");
  }
  return ["artifacts/render/diary.html", "artifacts/render/index.html", ...posts.map((post) => post.htmlPath)];
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
      threads.push({ sourceThreadId: conversation.conversation_id || conversation.id || `thread-${threads.length + 1}`, title: conversation.title || "Untitled", createTime: conversation.create_time || startTime, updateTime: conversation.update_time || startTime, primaryDate: dateKey(startTime), messageCount: messages.length, userMessageCount: messages.filter((message) => message.role === "user").length, assistantMessageCount: messages.filter((message) => message.role === "assistant").length, generatedImageCount: messages.reduce((sum, message) => sum + message.generatedImages.length, 0), preview: clip(firstUser?.text ?? messages[0]?.text ?? "", 300), sourceFile: path.relative(extractDir, file).replaceAll("\\", "/"), messages });
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
  const promptPath = path.join(dir, `${name.replace(/[^a-zA-Z0-9-_]/g, "_")}.prompt.txt`);
  fs.writeFileSync(promptPath, ["あなたは JSON のみを返す情報整理アシスタントです。", "前置き、説明、コードブロックは禁止です。", "コマンド実行、ファイル変更、ツール使用は禁止です。", "必ず単一の JSON オブジェクトだけを返してください。", "", meta.prompt].join("\n"), "utf8");
  const cacheKey = aiCacheKey(taskKey, meta);
  const cachePath = path.join(runtime.paths.cache, `${cacheKey}.json`);
  const cached = readJson(cachePath);
  if (cached?.text) {
    emitEvent(runtime, { type: "task.cache_hit", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note: "AI cache を再利用しました" });
    writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: meta.promptPreview, sentAt: cached.cachedAt || null, note: "AI cache を再利用しました", lastEvent: "task.cache_hit" });
    return { text: cached.text, parsed: cached.parsed, cacheHit: true };
  }
  const client = await getAppServerClient(runtime.config);
  const text = await runAiWithRetry(runtime, taskKey, itemId, async () => client.runJsonTurn({
    model: meta.model,
    cwd: process.cwd(),
    prompt: meta.prompt,
    onProgress: (event) => {
      runtime.current.sentAt = event.sentAt || runtime.current.sentAt;
      writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: event.promptPreview || runtime.current.promptPreview, sentAt: event.sentAt || runtime.current.sentAt, note: event.note || null, lastEvent: `ai.${event.phase || "progress"}` });
    }
  }));
  writeRaw(runtime, taskKey, itemId, text);
  const normalized = stripFence(text.trim());
  if (/^Error:/i.test(normalized)) {
    throw new Error(normalized);
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    const recovered = recoverJsonObjectText(normalized);
    if (recovered) {
      try {
        parsed = JSON.parse(recovered);
      } catch {}
    }
    if (!parsed) {
      const repaired = repairJsonText(recovered || normalized);
      if (repaired) {
        try {
          parsed = JSON.parse(repaired);
        } catch {}
      }
    }
    if (!parsed) {
      if (/prompt token count .* exceeds the limit/i.test(normalized)) {
        throw new Error(`AI プロンプトが長すぎます: ${clip(normalized, 220)}`);
      }
      throw new Error(`AI が JSON ではない応答を返しました: ${clip(normalized, 220)}`);
    }
  }
  writeJson(cachePath, { schemaVersion: 1, cachedAt: isoJst(), taskKey, itemId, model: meta.model, inputHash: meta.inputHash, promptHash: meta.promptHash, text, parsed });
  return { text, parsed, cacheHit: false };
}

async function runAiWithRetry(runtime, taskKey, itemId, run) {
  const maxAttempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const text = await run();
      if (isRetryableAiText(text)) {
        throw new Error(text.trim());
      }
      return text;
    } catch (error) {
      lastError = error;
      if (!isRetryableAiFailure(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 30000);
      const note = `一時的な AI エラーのため ${delayMs}ms 後に再試行します (${attempt}/${maxAttempts})`;
      emitEvent(runtime, { type: "task.retry_scheduled", stage: runtime.current.stage, taskKey, itemType: runtime.current.itemType, itemId, taskInstanceId: runtime.current.taskInstanceId, note });
      writeProgress(runtime, { status: "running", stage: runtime.current.stage, taskKey: runtime.current.taskKey, itemType: runtime.current.itemType, currentItemId: runtime.current.itemId, currentTaskInstanceId: runtime.current.taskInstanceId, promptPreview: runtime.current.promptPreview, sentAt: runtime.current.sentAt, note, lastEvent: "task.retry_scheduled" });
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("AI 呼び出しに失敗しました");
}

function isRetryableAiText(text) {
  const normalized = String(text || "").trim();
  return /^Error:/i.test(normalized) && /(429|rate limit|temporar|timeout|ECONNRESET|socket hang up|service unavailable|too many requests)/i.test(normalized);
}

function isRetryableAiFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(429|rate limit|temporar|timeout|ECONNRESET|socket hang up|service unavailable|too many requests)/i.test(message);
}

function isContextOverflowFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(prompt token count .* exceeds the limit|maximum context length|context length|too many tokens|token limit|input too long|request too large|exceeds the limit|AI プロンプトが長すぎます)/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recoverJsonObjectText(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1).trim();
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
    .replaceAll("’", "'")
    .replaceAll("‘", "'");
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }
    if (char === "(" || char === ")") {
      continue;
    }
    result += char;
  }

  return result.trim() || null;
}

function stripFence(text) { return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); }
function uniqueStrings(values) { return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))]; }
function dedupeObjects(values, keyFn) { const seen = new Set(); const items = []; for (const value of values || []) { const key = keyFn(value); if (seen.has(key)) continue; seen.add(key); items.push(value); } return items; }
function normalizeQuestionKey(text) { return String(text || "").trim().toLowerCase(); }
function normalizeQuestionStatus(status) { return ["resolved", "partially_resolved", "unresolved"].includes(status) ? status : "unresolved"; }
function compareQuestionStatus(left, right) { const rank = { unresolved: 0, partially_resolved: 1, resolved: 2 }; return (rank[normalizeQuestionStatus(left)] || 0) - (rank[normalizeQuestionStatus(right)] || 0); }
function readArtifact(runtime, relativePath) { return readJson(path.join(runtime.paths.root, relativePath)); }
function writeArtifact(runtime, relativePath, value) { writeJson(path.join(runtime.paths.root, relativePath), value); }
function writeRaw(runtime, taskKey, itemId, text) { writeArtifact(runtime, `artifacts/raw/${taskKey}/${itemId}.raw.json`, { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, taskKey, itemId, rawText: text }); }
function readUnit(runtime, itemId) { const item = (readArtifact(runtime, "artifacts/units/units.json")?.items || []).find((candidate) => candidate.itemId === itemId); if (!item) throw new Error(`unit が見つかりません: ${itemId}`); return item; }
function readEntry(runtime, itemId) { const units = (readArtifact(runtime, "artifacts/units/units.json")?.items || []).filter((unit) => unit.entryId === itemId); if (!units.length) throw new Error(`entry が見つかりません: ${itemId}`); return { itemId, date: units[0].date || itemId.replace(/^entry_/, ""), units, unitSummaries: units.map((unit) => readArtifact(runtime, `artifacts/ai/unit_summaries/${unit.itemId}.json`)).filter(Boolean) }; }
function loadThreads(runtime) { return (readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => readArtifact(runtime, `artifacts/normalized/${thread.itemId}.json`)).filter(Boolean); }
function loadScopedThreads(runtime) {
  const threads = loadThreads(runtime);
  if (!runtime.config.targetThreadItemIds?.length) {
    return threads;
  }
  const allow = new Set(runtime.config.targetThreadItemIds);
  return threads.filter((thread) => allow.has(thread.itemId));
}
function loadScopedThreadIndex(runtime) {
  const threads = readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || [];
  if (!runtime.config.targetThreadItemIds?.length) {
    return threads;
  }
  const allow = new Set(runtime.config.targetThreadItemIds);
  return threads.filter((thread) => allow.has(thread.itemId));
}
function loadClassifications(runtime) { return new Map((readArtifact(runtime, "artifacts/indexes/thread-index.json")?.threads || []).map((thread) => [thread.itemId, readArtifact(runtime, `artifacts/ai/thread_classification/${thread.itemId}.json`)]).filter(([, value]) => value)); }
function loadScopedClassifications(runtime) {
  const entries = [...loadClassifications(runtime).entries()];
  if (!runtime.config.targetThreadItemIds?.length) {
    return new Map(entries);
  }
  const allow = new Set(runtime.config.targetThreadItemIds);
  return new Map(entries.filter(([threadItemId]) => allow.has(threadItemId)));
}
function loadDiaryEntries(runtime) { const entryIds = [...new Set((readArtifact(runtime, "artifacts/units/units.json")?.items || []).map((unit) => unit.entryId).filter(Boolean))]; return entryIds.map((entryId) => readArtifact(runtime, `artifacts/ai/diary_entries/${entryId}.json`)).filter(Boolean); }
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
function buildEntryMarkdown(entry, navigation = {}) {
  const navLinks = [
    navigation.previousPost ? `[前の日: ${navigation.previousPost.date || navigation.previousPost.title}](./${path.posix.basename(navigation.previousPost.htmlPath)})` : null,
    `[一覧へ](../index.html)`,
    navigation.nextPost ? `[次の日: ${navigation.nextPost.date || navigation.nextPost.title}](./${path.posix.basename(navigation.nextPost.htmlPath)})` : null
  ].filter(Boolean);
  return [
    `# ${entry.title || entry.itemId}`,
    "",
    entry.date ? `- 日付: ${entry.date}` : null,
    entry.itemId ? `- entryId: ${entry.itemId}` : null,
    "",
    navLinks.length ? navLinks.join(" | ") : null,
    navLinks.length ? "" : null,
    entry.markdownBody || ""
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
    const existing = existingPosts.get(entry.itemId);
    return existing && !changedEntryIds.has(entry.itemId)
      ? { ...existing, slug, date: entry.date || null, title: entry.title || entry.itemId, markdownPath, htmlPath, categories }
      : { slug, entryId: entry.itemId, date: entry.date || null, title: entry.title || entry.itemId, markdownPath, htmlPath, categories };
  });
  posts.forEach((post, index) => {
    const entry = entries[index];
    const previousPost = index > 0 ? posts[index - 1] : null;
    const nextPost = index < posts.length - 1 ? posts[index + 1] : null;
    if (!existingPosts.has(post.entryId) || changedEntryIds.has(post.entryId)) {
      fs.writeFileSync(path.join(runtime.paths.root, post.markdownPath), buildEntryMarkdown(entry, { previousPost, nextPost }), "utf8");
    }
  });
  return posts;
}
function buildRenderIndexMarkdown(posts) {
  return [
    "# Nikki Blog",
    "",
    `- 生成日時: ${isoJst()}`,
    "",
    ...posts.map((post) => `- [${post.date || "unknown"} | ${post.title}](./posts/${path.posix.basename(post.htmlPath)})`)
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function buildRenderPostCategories(runtime, threadItemIds, categoryMap) {
  const categories = [];
  const seen = new Set();
  for (const threadItemId of threadItemIds || []) {
    const classification = readArtifact(runtime, `artifacts/ai/thread_classification/${threadItemId}.json`);
    const ids = [classification?.primary, ...(classification?.secondary || [])].filter(Boolean);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      categories.push({ id, label: categoryMap.get(id) || id });
    }
  }
  return categories;
}
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
function buildBlogSidebarHtml(posts, currentSlug = null) {
  return [
    `<aside class="blog-sidebar">`,
    `<div class="blog-sidebar-panel">`,
    `<h1>Nikki Blog</h1>`,
    `<p class="blog-sidebar-meta">生成日時: ${escapeHtml(isoJst())}</p>`,
    `<nav class="blog-sidebar-nav"><ul>`,
    ...posts.map((post) => {
      const isCurrent = currentSlug && post.slug === currentSlug;
      const href = currentSlug ? `${path.posix.basename(post.htmlPath)}` : `./posts/${path.posix.basename(post.htmlPath)}`;
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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(pageTitle)}</title><style>:root{--bg:#efe4d1;--panel:#fbf7f0;--ink:#1f1a17;--accent:#a54b2a;--line:#ddcdbd;--muted:#6f6257}*{box-sizing:border-box}body{margin:0;font-family:"Yu Mincho","Hiragino Mincho ProN",serif;color:var(--ink);background:radial-gradient(circle at top left,rgba(165,75,42,.12),transparent 24%),linear-gradient(180deg,#f5ede2 0%,#eadfcd 100%)}a{color:#5a45c6;text-decoration:underline}a:hover{text-decoration:none}.blog-layout{display:grid;grid-template-columns:320px minmax(0,1fr) 260px;gap:28px;max-width:1720px;margin:0 auto;padding:44px 28px 72px}.blog-sidebar,.blog-taxonomy{position:sticky;top:24px;align-self:start}.blog-sidebar-panel,.blog-content-panel,.blog-taxonomy-panel{background:var(--panel);border:1px solid var(--line);border-radius:24px;box-shadow:0 18px 42px rgba(53,37,24,.10)}.blog-sidebar-panel,.blog-taxonomy-panel{padding:34px 28px}.blog-sidebar-panel h1{margin:0 0 20px;font-size:3rem;line-height:1.05;border-bottom:2px solid var(--accent);padding-bottom:.4em}.blog-taxonomy-panel h2{margin:0 0 20px;font-size:2rem;line-height:1.1;border-bottom:2px solid var(--accent);padding-bottom:.4em}.blog-sidebar-meta{margin:0 0 24px;color:var(--muted);font-size:1rem;line-height:1.8}.blog-sidebar-nav ul,.blog-taxonomy-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}.blog-sidebar-nav li a{display:flex;flex-direction:column;gap:3px;color:inherit;text-decoration:none;padding:10px 12px;border-radius:12px}.blog-sidebar-nav li a:hover,.blog-sidebar-nav li.is-current a,.blog-taxonomy-list li.is-current{background:rgba(165,75,42,.08)}.blog-post-date{font-size:.92rem;color:var(--accent)}.blog-post-title{font-size:1.05rem;line-height:1.6}.blog-main{min-width:0}.blog-content-panel{padding:28px 44px 40px}.blog-post-nav{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;align-items:center;margin:0 0 22px;font-size:1rem}.blog-post-nav.bottom{margin:28px 0 0}.blog-post-nav .sep{color:var(--muted)}.blog-post-nav .is-disabled{color:var(--muted)}.blog-article h1,.blog-index-copy h1{font-size:3rem;line-height:1.15;margin:0 0 20px;padding-bottom:.4em;border-bottom:2px solid var(--accent)}.blog-article h2,.blog-article h3{line-height:1.35;margin-top:2.2em}.blog-article p,.blog-article li,.blog-index-copy p,.blog-index-copy li{font-size:1.15rem;line-height:2}.blog-article ul,.blog-index-copy ul{padding-left:1.4em}.blog-meta{margin:0 0 20px;padding-left:1.2em}.blog-index-copy{min-height:70vh}.blog-taxonomy-list li{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px}.blog-taxonomy-label{line-height:1.5}.blog-taxonomy-count{color:var(--muted)}.blog-post-categories{margin-top:32px;padding-top:24px;border-top:1px solid var(--line)}.blog-post-categories h2{margin:0 0 16px;font-size:1.4rem}.blog-category-chips{display:flex;flex-wrap:wrap;gap:10px}.blog-category-chip{display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;background:rgba(165,75,42,.10);border:1px solid rgba(165,75,42,.18);font-size:1rem;color:var(--ink)}@media (max-width:1280px){.blog-layout{grid-template-columns:300px minmax(0,1fr)}.blog-taxonomy{position:static;grid-column:1 / -1}}@media (max-width:980px){.blog-layout{grid-template-columns:1fr;padding:20px 14px 40px}.blog-sidebar,.blog-taxonomy{position:static}.blog-sidebar-panel h1,.blog-article h1,.blog-index-copy h1{font-size:2.2rem}.blog-taxonomy-panel h2{font-size:1.8rem}.blog-content-panel{padding:22px 20px 28px}}</style></head><body><div class="blog-layout">${sidebarHtml}<main class="blog-main">${contentHtml}</main>${taxonomyHtml}</div></body></html>`;
}
function wrapBlogIndexHtml(posts) {
  const sidebar = buildBlogSidebarHtml(posts);
  const taxonomy = buildBlogCategorySidebarHtml(posts);
  const content = [`<section class="blog-content-panel blog-index-copy">`,`<h1>Nikki Blog</h1>`,`<p>左側のインデックスから日付ごとの記事を選べます。</p>`,`<p>各記事ページでは前の日、次の日、一覧へのナビゲーションを上下に配置しています。</p>`,`</section>`].join("");
  return wrapBlogLayoutHtml(sidebar, content, taxonomy, "Nikki Blog");
}
function wrapBlogPostHtml(post, entry, posts) {
  const currentIndex = posts.findIndex((candidate) => candidate.slug === post.slug);
  const previousPost = currentIndex > 0 ? posts[currentIndex - 1] : null;
  const nextPost = currentIndex >= 0 && currentIndex < posts.length - 1 ? posts[currentIndex + 1] : null;
  const sidebar = buildBlogSidebarHtml(posts, post.slug);
  const taxonomy = buildBlogCategorySidebarHtml(posts, post);
  const bodyHtml = marked.parse(entry.markdownBody || "");
  const content = [
    `<section class="blog-content-panel">`,
    buildBlogNavHtml(previousPost, nextPost),
    `<article class="blog-article">`,
    `<h1>${escapeHtml(entry.title || post.title)}</h1>`,
    `<ul class="blog-meta"><li>日付: ${escapeHtml(entry.date || post.date || "unknown")}</li><li>entryId: ${escapeHtml(entry.itemId || post.entryId)}</li></ul>`,
    bodyHtml,
    `<section class="blog-post-categories"><h2>カテゴリ</h2><div class="blog-category-chips">${(post.categories || []).map((category) => `<span class="blog-category-chip">${escapeHtml(category.label)}</span>`).join("") || `<span class="blog-category-chip">未分類</span>`}</div></section>`,
    `</article>`,
    buildBlogNavHtml(previousPost, nextPost).replace("blog-post-nav", "blog-post-nav bottom"),
    `</section>`
  ].join("");
  return wrapBlogLayoutHtml(sidebar, content, taxonomy, entry.title || post.title || "Nikki Blog");
}
function wrapHtml(bodyHtml) { return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Nikki Diary</title><style>:root{--bg:#f5f0e8;--panel:#fffaf3;--ink:#1f1a17;--accent:#a54b2a;--line:#ddcdbd}body{margin:0;font-family:"Yu Mincho","Hiragino Mincho ProN",serif;color:var(--ink);background:radial-gradient(circle at top left,rgba(165,75,42,.10),transparent 28%),linear-gradient(180deg,#f7efe4 0%,#efe5d6 100%)}main{max-width:900px;margin:0 auto;padding:48px 20px 80px}article{background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(53,37,24,.08);padding:40px}h1,h2,h3{line-height:1.3}h1{font-size:2.2rem;border-bottom:2px solid var(--accent);padding-bottom:.4em}h2{margin-top:2.4em;color:var(--accent)}p,li{font-size:1rem;line-height:1.9}ul{padding-left:1.4em}@media print{body{background:#fff}main{padding:0}article{box-shadow:none;border:none;border-radius:0;padding:0}}</style></head><body><main><article>${bodyHtml}</article></main></body></html>`; }
function emitEvent(runtime, payload) { fs.appendFileSync(runtime.paths.events, `${JSON.stringify({ at: isoJst(), runId: runtime.config.runId, ...payload })}\n`, "utf8"); runtime.current.lastEvent = payload.type || null; runtime.current.note = payload.note || null; }
function writeProgress(runtime, override = {}) { const started = new Date(runtime.startedAt); writeJson(runtime.paths.progress, { schemaVersion: 1, runId: runtime.config.runId, status: override.status ?? "running", stage: override.stage ?? runtime.current.stage, taskKey: override.taskKey ?? runtime.current.taskKey, itemType: override.itemType ?? runtime.current.itemType, currentItemId: override.currentItemId ?? runtime.current.itemId, currentTaskInstanceId: override.currentTaskInstanceId ?? runtime.current.taskInstanceId, counts: { ...runtime.counts }, startedAt: runtime.startedAt, updatedAt: isoJst(), elapsedSec: Number.isNaN(started.getTime()) ? 0 : Math.max(Math.floor((Date.now() - started.getTime()) / 1000), 0), lastEvent: override.lastEvent ?? runtime.current.lastEvent, promptPreview: override.promptPreview ?? runtime.current.promptPreview, sentAt: override.sentAt ?? runtime.current.sentAt, note: override.note ?? runtime.current.note }); }
function logConsole(label, target, note = "") { const suffix = note ? ` ${note}` : ""; console.log(`${consoleTime()} [${label}] ${target}${suffix}`); }
function taskInstanceId(taskKey, itemId) { return `${taskKey}__${itemId}`; }
function aiCacheKey(taskKey, meta) { return crypto.createHash("sha256").update(JSON.stringify({ taskKey, model: meta.model, inputHash: meta.inputHash, promptHash: meta.promptHash, taskVersion: 1, outputSchemaVersion: 1 })).digest("hex"); }
function resolveModelForTask(runtime, taskKey) { return runtime.config.taskModels?.[taskKey] || runtime.config.model; }
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
  return AppServerClient.create(config);
}

function resolveRuntimeProvider(config) {
  if (config.runtime?.provider === "copilot" || config.provider === "copilot") {
    return "copilot";
  }
  return "codex";
}

function normalizeAgentRuntimeConfig(config, provider) {
  const runtime = config.runtime && typeof config.runtime === "object" && !Array.isArray(config.runtime) ? config.runtime : {};
  return {
    provider: runtime.provider === "copilot" || provider === "copilot" ? "copilot" : "codex",
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
