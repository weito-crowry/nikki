# Nikki

OpenAI エクスポート ZIP から日記を生成する CLI です。  
現行実装は task instance 単位で動作し、`artifacts/`, `task-state/`, `cache/ai/`, `events.jsonl`, `progress.json` を使って再開と増分実行を行います。

## できること

- ZIP 解凍と構造検査
- `conversations-*.json` から thread / message 抽出
- thread 正規化と画像参照整理
- AI によるカテゴリ分類
- AI による thread findings 抽出
- 日付単位またはカテゴリ単位の unit 生成
- AI による unit 要約
- AI による日記本文生成と整形
- Markdown / HTML / PDF 出力
- 日付別の個別記事 HTML 出力
- AI cache / split plan / category master を使った増分実行

## 前提

- Node.js 22 以上
- `npm install` 済み
- Codex 利用時は `codex` コマンド
- Copilot 利用時は `copilot --acp --stdio` が使えること
- Ollama 利用時は [Ollama](https://ollama.com/) が起動していて `http://127.0.0.1:11434` へ到達できること
- PDF 出力はローカルの Edge / Chrome を自動検出

## インストール

```bash
npm install
```

## コマンド

### inspect

ZIP の構造だけ確認します。

```bash
node src/cli.js inspect --zip ./export.zip
```

### run

基本実行です。

```bash
node src/cli.js run --zip ./export.zip --output ./output/run-001
```

設定ファイルを使う場合:

```bash
node src/cli.js run --config ./nikki.config.json
```

Copilot 設定の実行例:

```bash
npm run run:prod:copilot
```

Ollama 設定ファイルの例:

```bash
node src/cli.js run --config ./nikki.config.ollama.example.json
```

Qwen 3.5 0.8B の試行用:

```bash
ollama pull qwen3.5:0.8b
npm run run:prod:ollama:qwen3.5-0.8b
```

## 主な設定

設定ファイルでは主に以下を使います。

- `zipPath`
- `outputDir`
- `provider`
- `runtime`
- `grouping`
- `aiMode`
- `model`
- `taskModels`
- `taskThinks`
- `maxCategories`
- `summaryLanguage`
- `freezeCategories`
- `targetThreadItemIds`
- `targetDates`
- `targetWeeks`
- `targetMonths`
- `targetYears`
- `excludeThreadItemIds`
- `excludeSourceThreadIds`
- `excludeGroupIds`
- `jsonRetryAttempts`

例:

```json
{
  "zipPath": "./export.zip",
  "outputDir": "./output/prod-main-copilot",
  "provider": "copilot",
  "runtime": {
    "provider": "copilot",
    "copilot": {
      "transport": "stdio",
      "command": "copilot",
      "args": ["--acp", "--stdio"]
    }
  },
  "grouping": "thread-start-day",
  "executionOrder": "task",
  "aiMode": "ai",
  "model": "gpt-5-mini",
  "taskModels": {
    "ai.classify_thread": "gpt-5-mini",
    "ai.extract_findings": "gpt-5-mini",
    "ai.summarize_unit": "gpt-5-mini",
    "ai.write_diary_entry": "gpt-5-mini",
    "ai.rewrite_diary_entry": "gpt-5-mini"
  },
  "freezeCategories": true,
  "targetDates": ["2024-08-16", "2024-08-18"],
  "targetWeeks": ["2024-08-W3"],
  "targetMonths": ["2024-08"],
  "excludeThreadItemIds": ["thread_000003"],
  "excludeGroupIds": ["g-p-692c4c950d748191a6a24fc7e2676e2e"],
  "jsonRetryAttempts": 4,
  "targetThreadItemIds": [
    "thread_000001",
    "thread_000002"
  ]
}
```

Ollama の例:

```json
{
  "zipPath": "./export.zip",
  "outputDir": "./output/run-ollama",
  "provider": "ollama",
  "runtime": {
    "provider": "ollama",
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "keepAlive": "5m",
      "think": false
    }
  },
  "model": "qwen3.5:2b",
  "taskThinks": {
    "ai.classify_thread": false,
    "ai.extract_findings": false,
    "ai.summarize_unit": true,
    "ai.write_diary_entry": true,
    "ai.rewrite_diary_entry": false
  }
}
```

## 現状の実装方針

### task instance 実行

現行 task は以下です。

1. `prepare.extract_export`
2. `prepare.scan_export`
3. `prepare.build_thread_index`
4. `analyze.normalize_threads`
5. `analyze.attach_images`
6. `ai.generate_category_candidates`（非AI。category master を初期化）
7. `analyze.split_thread_turns`
8. `ai.summarize_turn`
9. `ai.classify_turn`
10. `ai.merge_thread_turns`
11. `analyze.group_units`
12. `ai.summarize_unit`
13. `ai.write_diary_entry`
14. `ai.rewrite_diary_entry`
15. `ai.write_weekly_summary`
16. `ai.write_monthly_summary`
17. `ai.write_yearly_summary`
18. `render.markdown`
19. `render.html`
20. `render.pdf`

各 task は `task-state/<taskKey>__<itemId>.json` で状態管理されます。

### カテゴリ運用

カテゴリは `outputDir` 単位のマスターで運用します。

- 正式マスター:
  `artifacts/ai/category_master.json`
- 互換出力:
  `artifacts/ai/categories.json`

`freezeCategories: true` の場合は既存 master を固定再利用します。  
`ai.generate_category_candidates` は設定済みの `categoryGroups` またはデフォルト大カテゴリから category master を初期化する非AI task です。  
`ai.classify_thread` は必要時に `proposedCategories` を返し、master に新カテゴリを自動追加します。追加履歴は `artifacts/ai/category_suggestions.json` に残ります。

### 増分実行

AI の再実行は極力抑える前提です。

- thread classification / findings は artifact と AI cache を再利用
- split plan も再利用
- Ollama 実行分は取得できた場合のみ `aiMeta.usage` / raw artifact / `events.jsonl` に token usage を保存
- `jsonRetryAttempts` で JSON 解析失敗時の再実行回数を増やせる。未指定時は従来通り 2 回
- `targetThreadItemIds` で対象 thread を絞れる
- `targetDates` / `targetWeeks` / `targetMonths` / `targetYears` でも `primaryDate` ベースで対象 thread を絞れる
- `excludeThreadItemIds` / `excludeSourceThreadIds` / `excludeGroupIds` で特定 thread や ChatGPT Project/Gizmo ID を除外できる
- `targetWeeks` は `2024-08-W3` のような「2024年8月の第3週」形式
- 週は月曜始まり・日曜終わりで、各月の1日を含む週を第1週とする
- 例: `2026-03-31` は `2026-04-W1`
- `--target-date 2024-08-16,2024-08-18` のように複数指定できる
- `--date` は再実行対象日指定、`--target-date` などは処理対象 thread の絞り込み
- `group_units` は影響日だけ差し替える方向
- render は日付別 post を持ち、変更 entry を中心に更新

ただし、完全な部分更新ではなく、一部 task はまだ全体再構成寄りです。

### 実行順序

既定は従来通り task 単位で全 item を処理します。

- `executionOrder: "task"`
  - `ai.summarize_turn` を全 turn、`ai.classify_turn` を全 turn、という順で task ごとに処理
- `executionOrder: "date"`
  - prepare / index 作成後、対象日付ごとに thread / turn / unit / entry を処理
  - 日次処理が終わった後に週次・月次・年次まとめと render を処理

CLI でも指定できます。

```bash
node src/cli.js run --config ./nikki.config.json --execution-order date --skip-completed
```

## よく使うオプション

- `--skip-completed`
  既存成果物を再利用しつつ、inputHash / dependsOn が変わったものだけ再実行
- `--retry-failed`
  failed task を再試行
- `--force`
  全再実行
- `--only <taskKey>`
  特定 task だけ実行
- `--item-id <id>`
  特定 item を再実行
- `--thread-id <id[,id...]>`
  config の `targetThreadItemIds` と同じ用途の簡易指定
- `--freeze-categories`
  category master を固定再利用

例:

```bash
node src/cli.js run --config ./nikki.config.prod.copilot.json --skip-completed --freeze-categories
```

特定 thread の分類だけやり直す:

```bash
node src/cli.js run --config ./nikki.config.prod.copilot.json --skip-completed --only ai.classify_thread --item-id thread_001134
```

### 非AI deterministic 実行

`aiMode: "deterministic"` または `--ai-mode deterministic` を指定すると、主要な `ai.*` task はモデルを呼ばず、同じ artifact schema のローカル変換で実行します。カテゴリ分類はキーワード一致、要約と日記本文は既存 artifact からのテンプレ生成です。

```bash
node src/cli.js run --zip ./export.zip --output ./output/run-local --ai-mode deterministic
```

## 進捗とログ

進捗監視:

```powershell
pwsh .\watch-progress.ps1 -ProgressPath .\output\run-001\progress.json
```

見る場所:

- `progress.json`
  現在の状態
- `events.jsonl`
  append-only の時系列ログ
- `task-state/*.json`
  task 単位の状態
- `artifacts/raw/...`
  AI 生応答

## 出力構成

主な出力は以下です。

```text
output/run-001/
  run-config.json
  progress.json
  events.jsonl
  logs/
  cache/ai/
  task-state/
  work/extracted/
  artifacts/
    manifest/
    indexes/
    normalized/
    ai/
      category_master.json
      categories.json
      category_suggestions.json
      thread_classification/
      thread_findings/
      unit_summaries/
      diary_drafts/
      diary_entries/
      weekly_summaries/
      monthly_summaries/
      yearly_summaries/
    chunks/
    raw/
    units/
      units.json
    render/
      diary.json
      diary.md
      diary.html
      diary.pdf
      posts.json
      weeks.json
      months.json
      years.json
      index.md
      index.html
      posts/
        YYYY-MM-DD.md
        YYYY-MM-DD.html
      weeks/
        YYYY-MM-Wn.md
        YYYY-MM-Wn.html
      months/
        YYYY-MM.md
        YYYY-MM.html
      years/
        YYYY.md
        YYYY.html
```

## 最終成果物

最終出力は 2 系統あります。

- 全体まとめ
  - `artifacts/render/diary.md`
  - `artifacts/render/diary.html`
  - `artifacts/render/diary.pdf`
- ブログ風の個別記事
  - `artifacts/render/index.html`
  - `artifacts/render/posts/*.html`
  - `artifacts/render/weeks/*.html`
  - `artifacts/render/months/*.html`
  - `artifacts/render/years/*.html`

個別記事 HTML は、

- 左ペイン: 日付 + タイトルのインデックス
- 中央ペイン: 本文
- 右ペイン: カテゴリ一覧
- 本文上下: 前の日 / 一覧 / 次の日

というレイアウトです。

## テスト用 fixture

最小 fixture で確認する場合:

```bash
npm run test:fixture:inspect
npm run test:fixture:run
npm run test:fixture:resume
```

## 注意点

- 長い thread は adaptive split で分割実行します
- Copilot 応答はまれに軽微な JSON 破損を含むため、補修しつつ parse しています
- 同じ `outputDir` への二重起動は lock で防止します
- stale lock は自動解除します

## 関連ドキュメント

- [実装タスク](/D:/weito/Documents/src/codexapp/nikki/docs/2026-03-26/06_implementation_tasks.md)
- [現行実装の説明](/D:/weito/Documents/src/codexapp/nikki/docs/2026-03-26/07_current_pipeline_implementation.md)
