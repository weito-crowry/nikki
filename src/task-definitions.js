export const TASK_DEFINITIONS = [
  {
    stage: "prepare",
    taskKey: "prepare.extract_export",
    itemType: "run",
    isAi: false
  },
  {
    stage: "prepare",
    taskKey: "prepare.scan_export",
    itemType: "run",
    isAi: false
  },
  {
    stage: "prepare",
    taskKey: "prepare.build_thread_index",
    itemType: "run",
    isAi: false
  },
  {
    stage: "analyze",
    taskKey: "analyze.normalize_threads",
    itemType: "run",
    isAi: false
  },
  {
    stage: "analyze",
    taskKey: "analyze.attach_images",
    itemType: "run",
    isAi: false
  },
  {
    stage: "ai.catalog",
    taskKey: "ai.generate_category_candidates",
    itemType: "run",
    isAi: true
  },
  {
    stage: "analyze",
    taskKey: "analyze.split_thread_turns",
    itemType: "thread",
    isAi: false
  },
  {
    stage: "ai.turn",
    taskKey: "ai.summarize_turn",
    itemType: "turn",
    isAi: true
  },
  {
    stage: "ai.turn",
    taskKey: "ai.classify_turn",
    itemType: "turn",
    isAi: true
  },
  {
    stage: "ai.thread",
    taskKey: "ai.merge_thread_turns",
    itemType: "thread",
    isAi: true
  },
  {
    stage: "analyze",
    taskKey: "analyze.group_units",
    itemType: "run",
    isAi: false
  },
  {
    stage: "ai.unit",
    taskKey: "ai.summarize_unit",
    itemType: "unit",
    isAi: true
  },
  {
    stage: "ai.entry",
    taskKey: "ai.write_diary_entry",
    itemType: "entry",
    isAi: true
  },
  {
    stage: "ai.entry",
    taskKey: "ai.rewrite_diary_entry",
    itemType: "entry",
    isAi: true
  },
  {
    stage: "render",
    taskKey: "render.markdown",
    itemType: "run",
    isAi: false
  },
  {
    stage: "render",
    taskKey: "render.html",
    itemType: "run",
    isAi: false
  },
  {
    stage: "render",
    taskKey: "render.pdf",
    itemType: "run",
    isAi: false
  }
];

export const TASK_DEFINITION_MAP = new Map(TASK_DEFINITIONS.map((definition) => [definition.taskKey, definition]));
