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

## 主な設定

設定ファイルでは主に以下を使います。

- `zipPath`
- `outputDir`
- `provider`
- `runtime`
- `grouping`
- `model`
- `taskModels`
- `maxCategories`
- `summaryLanguage`
- `freezeCategories`
- `targetThreadItemIds`

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
  "model": "gpt-5-mini",
  "taskModels": {
    "ai.classify_thread": "gpt-5-mini",
    "ai.extract_findings": "gpt-5-mini",
    "ai.summarize_unit": "gpt-5-mini",
    "ai.write_diary_entry": "gpt-5-mini",
    "ai.rewrite_diary_entry": "gpt-5-mini"
  },
  "freezeCategories": true,
  "targetThreadItemIds": [
    "thread_000001",
    "thread_000002"
  ]
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
6. `ai.generate_category_candidates`
7. `ai.classify_thread`
8. `ai.extract_findings`
9. `analyze.group_units`
10. `ai.summarize_unit`
11. `ai.write_diary_entry`
12. `ai.rewrite_diary_entry`
13. `render.markdown`
14. `render.html`
15. `render.pdf`

各 task は `task-state/<taskKey>__<itemId>.json` で状態管理されます。

### カテゴリ運用

カテゴリは `outputDir` 単位のマスターで運用します。

- 正式マスター:
  `artifacts/ai/category_master.json`
- 互換出力:
  `artifacts/ai/categories.json`

`freezeCategories: true` の場合は既存 master を固定再利用します。  
`ai.classify_thread` は必要時に `proposedCategories` を返し、master に新カテゴリを自動追加します。追加履歴は `artifacts/ai/category_suggestions.json` に残ります。

### 増分実行

AI の再実行は極力抑える前提です。

- thread classification / findings は artifact と AI cache を再利用
- split plan も再利用
- `targetThreadItemIds` で対象 thread を絞れる
- `group_units` は影響日だけ差し替える方向
- render は日付別 post を持ち、変更 entry を中心に更新

ただし、完全な部分更新ではなく、一部 task はまだ全体再構成寄りです。

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
      index.md
      index.html
      posts/
        YYYY-MM-DD.md
        YYYY-MM-DD.html
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
