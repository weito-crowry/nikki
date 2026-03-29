import fs from "node:fs";
import path from "node:path";
import { runPipeline, inspectZip } from "./pipeline.js";

function parseArgs(argv) {
  const [command = "run", ...rest] = argv;
  const options = {};
  const positionals = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { command, options, positionals };
}

function resolveConfig(options, positionals = []) {
  const configPath = options.config ? path.resolve(options.config) : null;
  const fileConfig = configPath && fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};

  const merged = {
    zipPath: options.zip ?? positionals[0] ?? fileConfig.zipPath,
    outputDir: options.output ?? positionals[1] ?? fileConfig.outputDir,
    provider: options.provider ?? fileConfig.provider ?? fileConfig.runtime?.provider ?? "codex",
    runtime: normalizeRuntimeConfig(fileConfig.runtime),
    grouping: options["group-by"] ?? fileConfig.grouping ?? "thread-start-day",
    model: options.model ?? fileConfig.model ?? "gpt-5.4",
    taskModels: normalizeTaskModels(fileConfig.taskModels),
    maxCategories: Number(options["max-categories"] ?? fileConfig.maxCategories ?? 12),
    categoriesPerMessage: Number(options["categories-per-message"] ?? fileConfig.categoriesPerMessage ?? 2),
    summaryLanguage: options.language ?? fileConfig.summaryLanguage ?? "ja",
    freezeCategories: Boolean(options["freeze-categories"] ?? fileConfig.freezeCategories ?? false),
    force: Boolean(options.force ?? fileConfig.force ?? false),
    retryFailed: Boolean(options["retry-failed"] ?? fileConfig.retryFailed ?? false),
    skipCompleted: Boolean(options["skip-completed"] ?? fileConfig.skipCompleted ?? false),
    only: splitList(options.only ?? fileConfig.only ?? null),
    rerunScopes: splitList(options["rerun-scope"] ?? fileConfig.rerunScopes ?? null),
    itemIds: splitList(options["item-id"] ?? fileConfig.itemIds ?? null),
    targetThreadItemIds: splitList(options["thread-id"] ?? fileConfig.targetThreadItemIds ?? null),
    date: options.date ?? fileConfig.date ?? null,
    limit: toOptionalNumber(options.limit ?? fileConfig.limit ?? null)
  };

  if (merged.zipPath) {
    merged.zipPath = path.resolve(merged.zipPath);
  }

  if (merged.outputDir) {
    merged.outputDir = path.resolve(merged.outputDir);
  }

  return merged;
}

function printUsage() {
  console.log(`使い方:
  node src/cli.js run --zip <zip> --output <dir> [--group-by thread-start-day|message-day|category] [--force]
    [--only <taskKey[,taskKey...]>] [--rerun-scope <thread[,unit]>] [--item-id <id[,id...]>] [--thread-id <id[,id...]>] [--date YYYY-MM-DD] [--limit N]
    [--retry-failed] [--skip-completed] [--freeze-categories]
  node src/cli.js inspect --zip <zip>
  node src/cli.js run --config ./nikki.config.json`);
}

function splitList(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function toOptionalNumber(value) {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTaskModels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, model]) => key && model)
      .map(([key, model]) => [String(key), String(model)])
  );
}

function normalizeRuntimeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    provider: value.provider === "copilot" ? "copilot" : "codex",
    codex: normalizeProviderOptions(value.codex),
    copilot: normalizeProviderOptions(value.copilot)
  };
}

function normalizeProviderOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      result[key] = entry;
      continue;
    }
    if (Array.isArray(entry)) {
      result[key] = entry.map((item) => String(item));
      continue;
    }
    if (entry && typeof entry === "object") {
      result[key] = Object.fromEntries(
        Object.entries(entry)
          .filter(([, nested]) => typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean")
          .map(([nestedKey, nested]) => [nestedKey, String(nested)])
      );
    }
  }
  return result;
}

async function main() {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));
  const config = resolveConfig(options, positionals);

  if (!config.zipPath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "inspect") {
    const result = await inspectZip(config.zipPath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!config.outputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runPipeline(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
