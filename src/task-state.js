import fs from "node:fs";
import path from "node:path";

let taskStateDeps = null;

export function configureTaskState(deps) {
  taskStateDeps = deps;
}

function deps() {
  if (!taskStateDeps) {
    throw new Error('task-state is not configured');
  }
  return taskStateDeps;
}

function taskInstanceId(...args) { return deps().taskInstanceId(...args); }
function readTurn(...args) { return deps().readTurn(...args); }
function loadTurnsForThread(...args) { return deps().loadTurnsForThread(...args); }
function readArtifact(...args) { return deps().readArtifact(...args); }
function threadMatchesTargetScopes(...args) { return deps().threadMatchesTargetScopes(...args); }
function hasThreadSummaryInputs(...args) { return deps().hasThreadSummaryInputs(...args); }
function readUnit(...args) { return deps().readUnit(...args); }
function readEntry(...args) { return deps().readEntry(...args); }
function readWeekInput(...args) { return deps().readWeekInput(...args); }
function readMonthInput(...args) { return deps().readMonthInput(...args); }
function readYearInput(...args) { return deps().readYearInput(...args); }
function loadDiaryEntries(...args) { return deps().loadDiaryEntries(...args); }
function enumerateWeekItems(...args) { return deps().enumerateWeekItems(...args); }
function enumerateMonthItems(...args) { return deps().enumerateMonthItems(...args); }
function enumerateYearItems(...args) { return deps().enumerateYearItems(...args); }
function sameArray(...args) { return deps().sameArray(...args); }
function writeState(...args) { return deps().writeState(...args); }
function readCategoryMaster(...args) { return deps().readCategoryMaster(...args); }
function threadItemMatchesTargetScopes(...args) { return deps().threadItemMatchesTargetScopes(...args); }
function hasThreadFilterScope(...args) { return deps().hasThreadFilterScope(...args); }
function monthWeekKey(...args) { return deps().monthWeekKey(...args); }

export function resolveDependsOn(runtime, taskKey, itemId) {
  if (taskKey === "prepare.extract_export") return [];
  if (taskKey === "prepare.scan_export") return [taskInstanceId("prepare.extract_export", "run")];
  if (taskKey === "prepare.build_thread_index") return [taskInstanceId("prepare.scan_export", "run")];
  if (taskKey === "analyze.normalize_threads") return [taskInstanceId("prepare.build_thread_index", "run")];
  if (taskKey === "analyze.attach_images") return [taskInstanceId("analyze.normalize_threads", "run")];
  if (taskKey === "ai.generate_category_candidates") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "analyze.split_thread_turns") return [taskInstanceId("analyze.attach_images", "run")];
  if (taskKey === "ai.summarize_turn") return [taskInstanceId("analyze.split_thread_turns", readTurn(runtime, itemId).threadItemId)];
  if (taskKey === "ai.classify_turn") return [taskInstanceId("analyze.split_thread_turns", readTurn(runtime, itemId).threadItemId), taskInstanceId("ai.generate_category_candidates", "run"), taskInstanceId("ai.summarize_turn", itemId)];
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

export function reusable(state, runtime, definition, item, meta, dependsOn, invalidation) {
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

export function getInvalidation(runtime, definition, item, state, meta, dependsOn) {
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
  if (state.status === "completed" && definition.taskKey === "ai.classify_turn" && (state.model === null) !== (meta.model === null)) {
    return { reason: "classificationMode が変化したため再実行します" };
  }
  if (state.status === "completed" && definition.taskKey === "ai.classify_turn" && runtime.config.classificationMode === "keyword" && state.inputHash !== meta.inputHash) {
    return { reason: "keyword classification inputHash が変化したため再実行します" };
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

export function migrateReusableState(runtime, definition, item, state, meta, dependsOn) {
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

export function validateRunOptions(runtime) {
  if (!["task", "date"].includes(runtime.config.executionOrder || "task")) {
    throw new Error(`executionOrder は task または date で指定してください: ${runtime.config.executionOrder}`);
  }
  if (!["ai", "deterministic"].includes(runtime.config.aiMode || "ai")) {
    throw new Error(`aiMode は ai または deterministic で指定してください: ${runtime.config.aiMode}`);
  }
  if (!["ai", "keyword"].includes(runtime.config.classificationMode || "ai")) {
    throw new Error(`classificationMode は ai または keyword で指定してください: ${runtime.config.classificationMode}`);
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

export function applyItemFilters(runtime, definition, items) {
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
