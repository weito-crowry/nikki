let deterministicDeps = null;

export function configureDeterministicHandlers(deps) {
  deterministicDeps = deps;
}

function deps() {
  if (!deterministicDeps) {
    throw new Error('deterministic handlers are not configured');
  }
  return deterministicDeps;
}

function readTurn(...args) { return deps().readTurn(...args); }
function readArtifact(...args) { return deps().readArtifact(...args); }
function writeArtifact(...args) { return deps().writeArtifact(...args); }
function isoJst(...args) { return deps().isoJst(...args); }
function buildLocalAiMeta(...args) { return deps().buildLocalAiMeta(...args); }
function writeRaw(...args) { return deps().writeRaw(...args); }
function readCategoryMaster(...args) { return deps().readCategoryMaster(...args); }
function mergeClassificationResults(...args) { return deps().mergeClassificationResults(...args); }
function buildThreadMergeContext(...args) { return deps().buildThreadMergeContext(...args); }
function readUnit(...args) { return deps().readUnit(...args); }
function hasThreadSummaryInputs(...args) { return deps().hasThreadSummaryInputs(...args); }
function compactThreadInputsForUnit(...args) { return deps().compactThreadInputsForUnit(...args); }
function readEntry(...args) { return deps().readEntry(...args); }
function draftToMarkdown(...args) { return deps().draftToMarkdown(...args); }
function readWeekInput(...args) { return deps().readWeekInput(...args); }
function readMonthInput(...args) { return deps().readMonthInput(...args); }
function readYearInput(...args) { return deps().readYearInput(...args); }
function loadDiaryEntries(...args) { return deps().loadDiaryEntries(...args); }
function defaultCategoryGroups(...args) { return deps().defaultCategoryGroups(...args); }
function uniqueStrings(...args) { return deps().uniqueStrings(...args); }
function clip(...args) { return deps().clip(...args); }
function dedupeObjects(...args) { return deps().dedupeObjects(...args); }

export function handleSummarizeTurnDeterministic(runtime, itemId, meta) {
  const turn = readTurn(runtime, itemId);
  const userIntent = summarizeMessagesForDeterministic(turn.promptMessages, "ユーザー発言");
  const assistantResponse = summarizeMessagesForDeterministic(turn.responseMessages, "応答");
  const outcome = assistantResponse ? `応答あり: ${clip(assistantResponse, 180)}` : "";
  const parsed = { userIntent, assistantResponse, outcome };
  writeArtifact(runtime, `artifacts/ai/turn_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    threadItemId: turn.threadItemId,
    date: turn.date,
    turnIndex: turn.turnIndex,
    ...parsed,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.summarize_turn", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/turn_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_turn/${itemId}.raw.json`];
}

export function handleClassifyTurnDeterministic(runtime, itemId, meta) {
  const turn = readTurn(runtime, itemId);
  const categories = readCategoryMaster(runtime) || {};
  const choice = classifyTextDeterministically(categories, textForDeterministicClassification(turn));
  const groupLabels = new Map((categories.groups || []).map((group) => [group.id, group.label]));
  const categoryLabels = new Map((categories.categories || []).map((category) => [category.id, category.label]));
  const parsed = {
    primaryGroup: choice.primaryGroup,
    primaryCategory: choice.primaryCategory,
    secondaryCategories: choice.secondaryCategories,
    reason: choice.reason,
    proposedCategories: []
  };
  writeArtifact(runtime, `artifacts/ai/turn_classification/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    threadItemId: turn.threadItemId,
    date: turn.date,
    turnIndex: turn.turnIndex,
    primaryGroup: parsed.primaryGroup,
    primaryGroupLabel: groupLabels.get(parsed.primaryGroup) || parsed.primaryGroup,
    primaryCategory: parsed.primaryCategory,
    primaryCategoryLabel: categoryLabels.get(parsed.primaryCategory) || parsed.primaryCategory,
    secondaryCategories: parsed.secondaryCategories,
    secondaryCategoryLabels: parsed.secondaryCategories.map((categoryId) => categoryLabels.get(categoryId) || categoryId),
    reason: parsed.reason,
    proposedCategories: [],
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.classify_turn", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/turn_classification/${itemId}.json`, `artifacts/raw/ai.classify_turn/${itemId}.raw.json`];
}

export function handleMergeThreadTurnsDeterministic(runtime, itemId, meta) {
  const context = buildThreadMergeContext(runtime, itemId);
  const categories = readCategoryMaster(runtime) || {};
  const categoryLabels = new Map((categories.categories || []).map((category) => [category.id, category.label]));
  const groupLabels = new Map((categories.groups || []).map((group) => [group.id, group.label]));
  const mergedClassification = context.mergedClassificationRaw;
  const primaryGroup = mergedClassification.primaryGroup || "other";
  const primaryCategory = mergedClassification.primaryCategory || mergedClassification.primary || "uncategorized";
  const secondaryCategories = Array.isArray(mergedClassification.secondaryCategories) ? mergedClassification.secondaryCategories : [];
  const parsed = deterministicThreadSummary(context);
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
    reason: parsed.reason,
    proposedCategories: [],
    aiMeta: buildLocalAiMeta(runtime, meta, { classificationMergedInCode: true })
  });
  writeArtifact(runtime, `artifacts/ai/thread_findings/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    interests: parsed.interests,
    questions: parsed.questions,
    outcomes: parsed.outcomes,
    images: parsed.images,
    narrative: parsed.narrative,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeArtifact(runtime, `artifacts/ai/thread_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    summaryTitle: parsed.summaryTitle,
    narrative: parsed.narrative,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.merge_thread_turns", itemId, JSON.stringify(parsed), null);
  return [
    `artifacts/ai/thread_classification/${itemId}.json`,
    `artifacts/ai/thread_findings/${itemId}.json`,
    `artifacts/ai/thread_summaries/${itemId}.json`,
    `artifacts/raw/ai.merge_thread_turns/${itemId}.raw.json`
  ];
}

export function handleSummarizeUnitDeterministic(runtime, itemId, meta) {
  const unit = readUnit(runtime, itemId);
  const availableThreadItemIds = (unit.threadItemIds || []).filter((threadItemId) => hasThreadSummaryInputs(runtime, threadItemId));
  const threads = availableThreadItemIds.map((threadItemId) => compactThreadInputsForUnit(runtime, threadItemId)).filter(Boolean);
  const parsed = deterministicUnitSummary(unit, threads);
  writeArtifact(runtime, `artifacts/ai/unit_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    label: unit.label,
    date: unit.date,
    category: unit.category,
    ...parsed,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.summarize_unit", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/unit_summaries/${itemId}.json`, `artifacts/raw/ai.summarize_unit/${itemId}.raw.json`];
}

export function handleWriteEntryDeterministic(runtime, itemId, meta) {
  const entry = readEntry(runtime, itemId);
  const parsed = deterministicDiaryDraft(entry);
  writeArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    date: entry.date,
    ...parsed,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.write_diary_entry", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/diary_drafts/${itemId}.json`, `artifacts/raw/ai.write_diary_entry/${itemId}.raw.json`];
}

export function handleRewriteEntryDeterministic(runtime, itemId, meta) {
  const draft = readArtifact(runtime, `artifacts/ai/diary_drafts/${itemId}.json`) || {};
  const parsed = {
    title: draft.title || `${draft.date || itemId.replace(/^entry_/, "")} の日記`,
    markdownBody: draftToMarkdown(draft),
    images: Array.isArray(draft.images) ? draft.images : []
  };
  writeArtifact(runtime, `artifacts/ai/diary_entries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    date: draft.date,
    ...parsed,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.rewrite_diary_entry", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/diary_entries/${itemId}.json`, `artifacts/raw/ai.rewrite_diary_entry/${itemId}.raw.json`];
}

export function handleWriteWeeklySummaryDeterministic(runtime, itemId, meta) {
  const weekInput = readWeekInput(runtime, itemId);
  const parsed = deterministicArchiveSummary({
    label: weekInput.week,
    entries: weekInput.entries,
    stats: weekInput.stats,
    kind: "week"
  });
  writeArtifact(runtime, `artifacts/ai/weekly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    week: weekInput.week,
    entryIds: weekInput.entries.map((entry) => entry.itemId),
    stats: weekInput.stats,
    title: parsed.title,
    overview: parsed.overview,
    themes: parsed.themes,
    notableDays: parsed.notableDays,
    closing: parsed.closing,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.write_weekly_summary", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/weekly_summaries/${itemId}.json`, `artifacts/raw/ai.write_weekly_summary/${itemId}.raw.json`];
}

export function handleWriteMonthlySummaryDeterministic(runtime, itemId, meta) {
  const monthInput = readMonthInput(runtime, itemId);
  const parsed = deterministicArchiveSummary({
    label: monthInput.month,
    entries: monthInput.entries,
    stats: monthInput.stats,
    kind: "month",
    childSummaries: monthInput.weeklySummaries
  });
  writeArtifact(runtime, `artifacts/ai/monthly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    month: monthInput.month,
    weekIds: monthInput.weeks.map((week) => `week_${week}`),
    entryIds: monthInput.entries.map((entry) => entry.itemId),
    stats: monthInput.stats,
    title: parsed.title,
    overview: parsed.overview,
    themes: parsed.themes,
    notableWeeks: parsed.notableWeeks,
    closing: parsed.closing,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.write_monthly_summary", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/monthly_summaries/${itemId}.json`, `artifacts/raw/ai.write_monthly_summary/${itemId}.raw.json`];
}

export function handleWriteYearlySummaryDeterministic(runtime, itemId, meta) {
  const yearInput = readYearInput(runtime, itemId);
  const parsed = deterministicArchiveSummary({
    label: yearInput.year,
    entries: loadDiaryEntries(runtime).filter((entry) => String(entry.date || "").startsWith(`${yearInput.year}-`)),
    stats: yearInput.stats,
    kind: "year",
    childSummaries: yearInput.monthlySummaries
  });
  writeArtifact(runtime, `artifacts/ai/yearly_summaries/${itemId}.json`, {
    schemaVersion: 1,
    generatedAt: isoJst(),
    runId: runtime.config.runId,
    itemId,
    year: yearInput.year,
    monthIds: yearInput.months.map((month) => `month_${month}`),
    stats: yearInput.stats,
    title: parsed.title,
    overview: parsed.overview,
    themes: parsed.themes,
    notableMonths: parsed.notableMonths,
    closing: parsed.closing,
    aiMeta: buildLocalAiMeta(runtime, meta)
  });
  writeRaw(runtime, "ai.write_yearly_summary", itemId, JSON.stringify(parsed), null);
  return [`artifacts/ai/yearly_summaries/${itemId}.json`, `artifacts/raw/ai.write_yearly_summary/${itemId}.raw.json`];
}

function summarizeMessagesForDeterministic(messages, fallback) {
  const texts = (messages || []).map((message) => String(message?.text || "").trim()).filter(Boolean);
  if (!texts.length) {
    const imageCount = (messages || []).reduce((sum, message) => sum + Number(message?.attachmentCount || message?.generatedImageCount || 0), 0);
    return imageCount > 0 ? `${fallback}: 画像または添付を含む` : "";
  }
  return clip(texts.join("\n").replace(/\s+/g, " "), 260);
}

function textForDeterministicClassification(turn) {
  return [
    ...(turn?.promptMessages || []),
    ...(turn?.responseMessages || [])
  ].map((message) => String(message?.text || "")).join("\n");
}

function classifyTextDeterministically(master, text) {
  const groups = master?.groups?.length ? master.groups : defaultCategoryGroups().map((group) => ({ ...group, categories: [] }));
  const scoredGroups = groups.map((group) => ({ group, score: scoreCategoryCandidate(group, text) })).sort((left, right) => right.score - left.score);
  const group = scoredGroups[0]?.score > 0 ? scoredGroups[0].group : groups.find((candidate) => candidate.id === "other") || groups[0];
  const childCategories = Array.isArray(group?.categories) ? group.categories : [];
  const scoredCategories = childCategories
    .map((category) => ({ category, score: scoreCategoryCandidate(category, text) }))
    .sort((left, right) => right.score - left.score);
  const primaryCategory = scoredCategories[0]?.score > 0 ? scoredCategories[0].category.id : childCategories[0]?.id || "uncategorized";
  const secondaryCategories = scoredCategories
    .filter((entry) => entry.category.id !== primaryCategory && entry.score > 0)
    .slice(0, 2)
    .map((entry) => entry.category.id);
  return {
    primaryGroup: group?.id || "other",
    primaryCategory,
    secondaryCategories,
    reason: "キーワード一致によるローカル分類"
  };
}

function scoreCategoryCandidate(candidate, text) {
  const normalized = String(text || "").toLowerCase();
  const terms = uniqueStrings([
    candidate?.label,
    candidate?.description,
    ...(candidate?.keywords || [])
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  return terms.reduce((score, term) => {
    if (!term) return score;
    return score + (normalized.includes(term) ? Math.max(1, Math.min(term.length, 8)) : 0);
  }, 0);
}

function deterministicThreadSummary(context) {
  const summaries = context.turnSummaries || [];
  const threadTitle = context.payload?.thread?.title || context.payload?.thread?.itemId || "thread";
  const interests = uniqueStrings(summaries.map((summary) => summary.userIntent).filter(Boolean)).slice(0, 8);
  const outcomes = uniqueStrings(summaries.map((summary) => summary.outcome || summary.assistantResponse).filter(Boolean)).slice(0, 8);
  const questions = uniqueStrings(summaries.map((summary) => summary.userIntent).filter((text) => looksLikeQuestion(text))).slice(0, 8)
    .map((text) => ({ text: clip(text, 160), status: "resolved" }));
  const images = deterministicImagesFromTurns(context.turns || []);
  const narrativeParts = summaries.slice(0, 6).map((summary) => {
    const intent = summary.userIntent ? `依頼: ${summary.userIntent}` : "";
    const outcome = summary.outcome ? `結果: ${summary.outcome}` : "";
    return [intent, outcome].filter(Boolean).join(" / ");
  }).filter(Boolean);
  return {
    summaryTitle: clip(threadTitle, 120),
    reason: "turn分類の多数決を利用",
    interests,
    questions,
    outcomes,
    images,
    narrative: clip(narrativeParts.join("\n"), 1200)
  };
}

function deterministicImagesFromTurns(turns) {
  const images = [];
  for (const turn of turns || []) {
    for (const message of [...(turn.promptMessages || []), ...(turn.responseMessages || [])]) {
      for (const image of [...(message.attachments || []), ...(message.generatedImages || [])]) {
        const pathValue = image?.path || image?.filePath || image?.name || "";
        if (pathValue) {
          images.push({ path: pathValue, note: "会話に含まれる画像" });
        }
      }
    }
  }
  return dedupeObjects(images, (image) => image.path).slice(0, 12);
}

function looksLikeQuestion(text) {
  return /[?？]|どう|なぜ|何|どれ|できる|でしょう|ですか|ますか/.test(String(text || ""));
}

function deterministicUnitSummary(unit, threads) {
  const summaryTitle = unit.label || unit.itemId;
  const interests = uniqueStrings(threads.flatMap((thread) => thread.findings?.interests || []).filter(Boolean)).slice(0, 12);
  const questions = uniqueStrings(threads.flatMap((thread) => thread.findings?.questions || []).map((question) => typeof question === "string" ? question : question?.text).filter(Boolean)).slice(0, 12);
  const outcomes = uniqueStrings(threads.flatMap((thread) => thread.findings?.outcomes || []).filter(Boolean)).slice(0, 12);
  const images = dedupeObjects(threads.flatMap((thread) => thread.findings?.images || []), (image) => `${image?.path || ""}|${image?.note || ""}`).slice(0, 12);
  const narrative = threads.map((thread) => {
    const title = thread.summary?.summaryTitle || thread.title || thread.itemId;
    const body = thread.summary?.narrative || thread.findings?.narrative || "";
    return body ? `${title}: ${body}` : title;
  }).filter(Boolean).join("\n");
  return {
    summaryTitle,
    interests,
    questions,
    outcomes,
    images,
    narrative: clip(narrative, 1800)
  };
}

function deterministicDiaryDraft(entry) {
  const summaries = entry.unitSummaries || [];
  const title = `${entry.date} の日記`;
  const lead = summaries.length
    ? `${entry.date} は ${summaries.length} 件のまとまりを整理した。`
    : `${entry.date} の記録。`;
  const sections = summaries.map((summary) => ({
    heading: summary.summaryTitle || summary.label || summary.itemId,
    body: deterministicSectionBody(summary)
  })).filter((section) => section.heading || section.body);
  const images = dedupeObjects(summaries.flatMap((summary) => summary.images || []).map((image) => ({
    path: image?.path || "",
    caption: image?.caption || image?.note || image?.prompt || ""
  })).filter((image) => image.path || image.caption), (image) => `${image.path}|${image.caption}`);
  return {
    title,
    lead,
    sections,
    closing: "以上をこの日の記録として残す。",
    images
  };
}

function deterministicSectionBody(summary) {
  const parts = [];
  if (summary.narrative) parts.push(summary.narrative);
  if (summary.interests?.length) parts.push(`扱ったこと: ${summary.interests.slice(0, 5).join("、")}`);
  if (summary.questions?.length) parts.push(`確認したこと: ${summary.questions.slice(0, 5).map((question) => typeof question === "string" ? question : question?.text).filter(Boolean).join("、")}`);
  if (summary.outcomes?.length) parts.push(`結果: ${summary.outcomes.slice(0, 5).join("、")}`);
  return parts.filter(Boolean).join("\n\n");
}

function deterministicArchiveSummary({ label, entries, stats, kind, childSummaries = [] }) {
  const unitLabel = kind === "year" ? `${label} 年` : `${label} の記録`;
  const themes = buildDeterministicThemes(entries, childSummaries, stats);
  const notableDays = (entries || []).slice(0, 10).map((entry) => ({
    date: entry.date || "",
    title: entry.title || entry.itemId,
    note: clip(firstParagraph(entry.markdownBody), 240)
  }));
  const notableWeeks = (childSummaries || []).slice(0, 10).map((summary) => ({
    week: summary.week || summary.itemId || "",
    title: summary.title || summary.itemId || "",
    note: clip(summary.overview || summary.closing || "", 240)
  }));
  const notableMonths = (childSummaries || []).slice(0, 12).map((summary) => ({
    month: summary.month || summary.itemId || "",
    title: summary.title || summary.itemId || "",
    note: clip(summary.overview || summary.closing || "", 240)
  }));
  return {
    title: unitLabel,
    overview: `${unitLabel}では ${stats?.dayCount || (entries || []).length} 日分、${stats?.threadCount || 0} 件のスレッドを整理した。`,
    themes,
    notableDays,
    notableWeeks,
    notableMonths,
    closing: "ローカル集計により、期間内の記録をまとめた。"
  };
}

function buildDeterministicThemes(entries, childSummaries, stats) {
  const categoryThemes = (stats?.topCategories || stats?.topPrimaryCategories || []).slice(0, 6).map((category) => ({
    heading: category.label || category.id || "カテゴリ",
    body: `${category.count || 0} 件の関連記録があった。`
  }));
  if (categoryThemes.length) {
    return categoryThemes;
  }
  const titles = uniqueStrings([...(entries || []).map((entry) => entry.title), ...(childSummaries || []).map((summary) => summary.title)].filter(Boolean)).slice(0, 6);
  return titles.map((title) => ({ heading: title, body: "この期間の記録として扱った。" }));
}

function firstParagraph(markdown) {
  return String(markdown || "").split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/gm, "").trim()).find(Boolean) || "";
}
