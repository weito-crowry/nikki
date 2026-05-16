let categoryDeps = null;

export function configureCategoryHelpers(deps) {
  categoryDeps = deps;
}

function deps() {
  if (!categoryDeps) {
    throw new Error('category helpers are not configured');
  }
  return categoryDeps;
}

function readArtifact(...args) { return deps().readArtifact(...args); }
function writeArtifact(...args) { return deps().writeArtifact(...args); }
function isoJst(...args) { return deps().isoJst(...args); }
function sanitizeId(...args) { return deps().sanitizeId(...args); }
function uniqueStrings(...args) { return deps().uniqueStrings(...args); }
function emitEvent(...args) { return deps().emitEvent(...args); }
function logConsole(...args) { return deps().logConsole(...args); }

export function readCategoryMaster(runtime) {
  const value = readArtifact(runtime, "artifacts/ai/category_master.json") || readArtifact(runtime, "artifacts/ai/categories.json") || null;
  return value ? normalizeCategoryMaster(runtime, value) : null;
}

export function writeCategoryMaster(runtime, value) {
  const normalized = normalizeCategoryMaster(runtime, value);
  writeArtifact(runtime, "artifacts/ai/category_master.json", normalized);
  writeArtifact(runtime, "artifacts/ai/categories.json", normalized);
}

export function readCategorySuggestions(runtime) {
  return readArtifact(runtime, "artifacts/ai/category_suggestions.json") || { schemaVersion: 1, generatedAt: isoJst(), runId: runtime.config.runId, items: [] };
}

export function writeCategorySuggestions(runtime, value) {
  writeArtifact(runtime, "artifacts/ai/category_suggestions.json", value);
}

export function defaultCategoryGroups() {
  return [
    { id: "work", label: "仕事", description: "仕事として進めた依頼、業務、調査、制作に関するまとまり。", keywords: ["仕事", "業務", "依頼"] },
    { id: "technology", label: "技術", description: "プログラミング、ツール、AI、システム利用に関するまとまり。", keywords: ["技術", "開発", "AI"] },
    { id: "research-learning", label: "調査・学習", description: "概念の理解、比較、調査、知識整理に関するまとまり。", keywords: ["調査", "学習", "理解"] },
    { id: "creative-media", label: "創作・メディア", description: "物語、作品、文章、表現の検討に関するまとまり。", keywords: ["創作", "作品", "文章"] },
    { id: "life", label: "生活", description: "日常生活、健康、買い物、趣味に関するまとまり。", keywords: ["生活", "健康", "趣味"] },
    { id: "other", label: "その他", description: "上記の大カテゴリに明確に収まらないまとまり。", keywords: ["その他"] }
  ];
}

export function normalizeCategoryGroups(groups) {
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

export function normalizeCategoryMaster(runtime, value) {
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

export function normalizeProposedCategories(items) {
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

export function mergeCategoryMaster(runtime, proposedCategories, itemId = null) {
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
