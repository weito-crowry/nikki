import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

let renderDeps = null;

export function configureRenderHandlers(deps) {
  renderDeps = deps;
}

function deps() {
  if (!renderDeps) {
    throw new Error('render handlers are not configured');
  }
  return renderDeps;
}

function readArtifact(...args) { return deps().readArtifact(...args); }
function writeArtifact(...args) { return deps().writeArtifact(...args); }
function isoJst(...args) { return deps().isoJst(...args); }
function loadDiaryEntries(...args) { return deps().loadDiaryEntries(...args); }
function loadWeeklySummaries(...args) { return deps().loadWeeklySummaries(...args); }
function loadMonthlySummaries(...args) { return deps().loadMonthlySummaries(...args); }
function loadYearlySummaries(...args) { return deps().loadYearlySummaries(...args); }
function readCategoryMaster(...args) { return deps().readCategoryMaster(...args); }
function ensureDir(...args) { return deps().ensureDir(...args); }
function findChromiumBrowser(...args) { return deps().findChromiumBrowser(...args); }
function execFileAsync(...args) { return deps().execFileAsync(...args); }
function fileStat(...args) { return deps().fileStat(...args); }
function estimateInputTokens(...args) { return deps().estimateInputTokens(...args); }
function sanitizeId(...args) { return deps().sanitizeId(...args); }
function getChangedEntryIds(...args) { return deps().getChangedEntryIds(...args); }
function monthWeekKey(...args) { return deps().monthWeekKey(...args); }
function fileUrl(...args) { return deps().fileUrl(...args); }
function formatInteger(...args) { return deps().formatInteger(...args); }

export function handleRenderMarkdown(runtime) {
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

export function handleRenderHtml(runtime) {
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

export async function handleRenderPdf(runtime) {
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

export function draftToMarkdown(draft) { return [draft.lead || "", ...(draft.sections || []).flatMap((section) => [section.heading ? `### ${section.heading}` : "", section.body || "", ""]), draft.closing || ""].filter(Boolean).join("\n\n"); }
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
export function buildArchiveStatsFromEntries(runtime, entries, options = {}) {
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
