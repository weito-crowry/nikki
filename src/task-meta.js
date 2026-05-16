import path from "node:path";

let taskMetaDeps = null;

export function configureTaskMeta(deps) {
  taskMetaDeps = deps;
}

function deps() {
  if (!taskMetaDeps) {
    throw new Error('task-meta is not configured');
  }
  return taskMetaDeps;
}

function readArtifact(...args) { return deps().readArtifact(...args); }
function hashJson(...args) { return deps().hashJson(...args); }
function fileStat(...args) { return deps().fileStat(...args); }
function walkFiles(...args) { return deps().walkFiles(...args); }
function loadThreads(...args) { return deps().loadThreads(...args); }
function normalizeCategoryGroups(...args) { return deps().normalizeCategoryGroups(...args); }
function readTurn(...args) { return deps().readTurn(...args); }
function compactTurnForAi(...args) { return deps().compactTurnForAi(...args); }
function renderPromptTemplate(...args) { return deps().renderPromptTemplate(...args); }
function readCategoryMaster(...args) { return deps().readCategoryMaster(...args); }
function buildThreadMergeContext(...args) { return deps().buildThreadMergeContext(...args); }
function buildMergeThreadTurnsPrompt(...args) { return deps().buildMergeThreadTurnsPrompt(...args); }
function buildPromptStats(...args) { return deps().buildPromptStats(...args); }
function getOllamaSystemPrompt(...args) { return deps().getOllamaSystemPrompt(...args); }
function threadMergeInputTokenLimit(...args) { return deps().threadMergeInputTokenLimit(...args); }
function hashText(...args) { return deps().hashText(...args); }
function threadMergeChunkSize(...args) { return deps().threadMergeChunkSize(...args); }
function loadScopedThreadIndex(...args) { return deps().loadScopedThreadIndex(...args); }
function loadScopedClassifications(...args) { return deps().loadScopedClassifications(...args); }
function readUnit(...args) { return deps().readUnit(...args); }
function hasThreadSummaryInputs(...args) { return deps().hasThreadSummaryInputs(...args); }
function compactUnitForAi(...args) { return deps().compactUnitForAi(...args); }
function compactThreadInputsForUnit(...args) { return deps().compactThreadInputsForUnit(...args); }
function readEntry(...args) { return deps().readEntry(...args); }
function compactEntryForAi(...args) { return deps().compactEntryForAi(...args); }
function compactDiaryDraftForAi(...args) { return deps().compactDiaryDraftForAi(...args); }
function readWeekInput(...args) { return deps().readWeekInput(...args); }
function compactArchiveStatsForAi(...args) { return deps().compactArchiveStatsForAi(...args); }
function compactDiaryEntryForArchiveSummary(...args) { return deps().compactDiaryEntryForArchiveSummary(...args); }
function readMonthInput(...args) { return deps().readMonthInput(...args); }
function compactWeekSummaryForMonthlySummary(...args) { return deps().compactWeekSummaryForMonthlySummary(...args); }
function readYearInput(...args) { return deps().readYearInput(...args); }
function compactMonthSummaryForYearlySummary(...args) { return deps().compactMonthSummaryForYearlySummary(...args); }
function loadDiaryEntries(...args) { return deps().loadDiaryEntries(...args); }
function loadWeeklySummaries(...args) { return deps().loadWeeklySummaries(...args); }
function loadMonthlySummaries(...args) { return deps().loadMonthlySummaries(...args); }
function loadYearlySummaries(...args) { return deps().loadYearlySummaries(...args); }
function resolveModelForTask(...args) { return deps().resolveModelForTask(...args); }
function resolveThinkForTask(...args) { return deps().resolveThinkForTask(...args); }
function clip(...args) { return deps().clip(...args); }

export async function buildTaskMeta(runtime, definition, item) {
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
  if (isDeterministicAiMode(runtime)) {
    return deterministicMeta(input);
  }
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

function isDeterministicAiMode(runtime) {
  return runtime.config.aiMode === "deterministic";
}

function deterministicMeta(input) {
  return {
    input,
    inputHash: hashJson({ mode: "deterministic-v1", input }),
    promptHash: null,
    model: null,
    think: null,
    promptPreview: "deterministic local transformation"
  };
}
