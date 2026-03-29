# 07_current_pipeline_implementation.md

## 1. 目的

本ドキュメントは、`2026-03-26` 時点の `nikki` 実装が**実際にどう動いているか**を整理したものである。  
対象は主に以下。

- `src/cli.js`
- `src/pipeline.js`
- `src/task-definitions.js`

これは理想仕様ではなく、**現行実装の挙動説明**である。  
仕様書との差分確認、改善議論、運用判断の基礎資料として使う。

---

## 2. 全体像

現行実装は、OpenAI エクスポート ZIP を入力として、以下を順に行う。

1. ZIP 解凍
2. エクスポート構造走査
3. スレッド索引生成
4. スレッド正規化
5. 画像情報整理
6. カテゴリ候補生成
7. スレッド分類
8. スレッド findings 抽出
9. unit 生成
10. unit 要約
11. 日記草稿生成
12. 日記整形
13. Markdown 生成
14. HTML 生成
15. PDF 生成

内部的には task instance 単位で動作する。  
task definition は `src/task-definitions.js` で静的定義され、runtime は `src/pipeline.js` 内にある。

---

## 3. CLI

## 3.1 コマンド

- `inspect`
- `run`

### `inspect`

ZIP を開き、以下を JSON で返す。

- 総エントリ数
- `conversations-*.json` 件数
- 画像ファイル件数
- `chat.html` 有無
- `user.json` 有無
- `shared_conversations.json` 有無

### `run`

パイプライン本体を実行する。

---

## 3.2 主なオプション

現行実装で扱っている主な設定は以下。

- `zipPath`
- `outputDir`
- `grouping`
- `model`
- `taskModels`
- `maxCategories`
- `categoriesPerMessage`
- `summaryLanguage`
- `force`
- `retryFailed`
- `skipCompleted`
- `only`
- `itemIds`
- `date`
- `limit`

---

## 3.3 モデル解決

AI task のモデルは以下で決まる。

1. `taskModels[taskKey]`
2. なければ `model`

例:

- `ai.classify_thread` だけ `gpt-5.4-mini`
- `ai.write_diary_entry` だけ `gpt-5.4`

---

## 4. Task 定義

現行 task は以下の 15 個。

| Stage | taskKey | itemType | AI |
|---|---|---|---|
| prepare | `prepare.extract_export` | `run` | いいえ |
| prepare | `prepare.scan_export` | `run` | いいえ |
| prepare | `prepare.build_thread_index` | `run` | いいえ |
| analyze | `analyze.normalize_threads` | `run` | いいえ |
| analyze | `analyze.attach_images` | `run` | いいえ |
| ai.catalog | `ai.generate_category_candidates` | `run` | はい |
| ai.thread | `ai.classify_thread` | `thread` | はい |
| ai.thread | `ai.extract_findings` | `thread` | はい |
| analyze | `analyze.group_units` | `run` | いいえ |
| ai.unit | `ai.summarize_unit` | `unit` | はい |
| ai.entry | `ai.write_diary_entry` | `entry` | はい |
| ai.entry | `ai.rewrite_diary_entry` | `entry` | はい |
| render | `render.markdown` | `run` | いいえ |
| render | `render.html` | `run` | いいえ |
| render | `render.pdf` | `run` | いいえ |

---

## 5. itemType ごとの列挙元

### `run`

- 固定値 `run`

### `thread`

- `artifacts/indexes/thread-index.json`

### `unit`

- `artifacts/units/units.json`

### `entry`

- `artifacts/units/units.json` の `entryId`

---

## 6. 実行順序と依存

現行実装は task 定義順で順次処理する。  
依存関係は task ごとにコードで固定している。

代表例:

- `prepare.scan_export` → `prepare.extract_export`
- `analyze.normalize_threads` → `prepare.build_thread_index`
- `ai.generate_category_candidates` → `analyze.attach_images`
- `ai.classify_thread` → `analyze.attach_images`, `ai.generate_category_candidates`
- `ai.extract_findings` → `analyze.attach_images`
- `ai.summarize_unit` → `analyze.group_units`, `ai.classify_thread`, `ai.extract_findings`
- `ai.write_diary_entry` → `ai.summarize_unit`
- `ai.rewrite_diary_entry` → `ai.write_diary_entry`
- `render.html` → `render.markdown`
- `render.pdf` → `render.html`

---

## 7. 出力構成

run の出力先は `outputDir` で指定したディレクトリ。  
内部構成は以下。

```text
<outputDir>/
  run-config.json
  progress.json
  events.jsonl
  logs/
  cache/ai/
  task-state/
  work/extracted/
  artifacts/
```

---

## 7.1 artifacts

主な成果物は以下。

### manifest

- `artifacts/manifest/extract-result.json`
- `artifacts/manifest/export-manifest.json`
- `artifacts/manifest/file-inventory.json`

### indexes

- `artifacts/indexes/thread-index.json`
- `artifacts/indexes/message-index.json`

### normalized

- `artifacts/normalized/thread_<id>.json`

### ai

- `artifacts/ai/category_master.json`
- `artifacts/ai/categories.json`
- `artifacts/ai/thread_classification/thread_<id>.json`
- `artifacts/ai/thread_findings/thread_<id>.json`
- `artifacts/ai/unit_summaries/unit_<id>.json`
- `artifacts/ai/diary_drafts/entry_<id>.json`
- `artifacts/ai/diary_entries/entry_<id>.json`

### units

- `artifacts/units/units.json`

### render

- `artifacts/render/diary.json`
- `artifacts/render/diary.md`
- `artifacts/render/diary.html`
- `artifacts/render/diary.pdf`
- `artifacts/render/render-info.json`

### raw

- `artifacts/raw/<taskKey>/<itemId>.raw.json`

---

## 7.2 task-state

各 task instance ごとに 1 ファイル出る。

```text
task-state/<taskKey>__<itemId>.json
```

主な項目:

- `status`
- `dependsOn`
- `inputHash`
- `promptHash`
- `model`
- `artifactPaths`
- `startedAt`
- `finishedAt`
- `retryCount`
- `error`

---

## 7.3 progress

`progress.json` は現在のスナップショット。

主な項目:

- `status`
- `stage`
- `taskKey`
- `itemType`
- `currentItemId`
- `currentTaskInstanceId`
- `counts`
- `lastEvent`
- `promptPreview`
- `sentAt`
- `note`

---

## 7.4 events

`events.jsonl` は append-only の時系列ログ。

主なイベント:

- `run.started`
- `run.completed`
- `run.failed`
- `task.started`
- `task.completed`
- `task.failed`
- `task.skipped`
- `task.invalidated`
- `task.cache_hit`

---

## 8. 各 task の役割

## 8.1 `prepare.extract_export`

- ZIP を `work/extracted/` に解凍
- `extract-result.json` を出力

## 8.2 `prepare.scan_export`

- 解凍済みファイル一覧を走査
- manifest と inventory を出力

## 8.3 `prepare.build_thread_index`

- `conversations-*.json` から thread item を列挙
- message index も出力

## 8.4 `analyze.normalize_threads`

- 会話 mapping を message 配列へ正規化
- 各 thread を `artifacts/normalized/` に保存

## 8.5 `analyze.attach_images`

- 画像参照件数などを normalized thread へ付加
- 実際には既存 normalized thread の更新に近い

## 8.6 `ai.generate_category_candidates`

- 対象 thread 群からカテゴリ候補を生成する
- 現在は `category_master.json` と `categories.json` の両方へ保存する
- `freezeCategories=true` の場合は既存 master を再利用し、新規生成しない

## 8.7 `ai.classify_thread`

- 各 thread をカテゴリへ分類する
- コンテキスト超過時は adaptive split で分割実行する
- 必要時は `proposedCategories` を返し、outputDir 配下の category master に追記する

## 8.8 `ai.extract_findings`

- 各 thread から interests / questions / outcomes / images / narrative を抽出する
- コンテキスト超過時は adaptive split で分割実行する

---

## 9. カテゴリ運用の現状

現行実装のカテゴリ運用は、完全な「毎回全再生成」から一歩進み、  
**outputDir 単位の category master を持つ方式** へ移行し始めている。

現状の要点:

- 正式なカテゴリ集合は `artifacts/ai/category_master.json`
- 後方互換のため `artifacts/ai/categories.json` にも同内容を書く
- `freezeCategories=true` のときは既存 master を固定再利用する
- `ai.classify_thread` は必要時のみ `proposedCategories` を返し、master に自動追記する

ただし、現時点ではまだ `unit` / `entry` / `render` は full recompute 寄りであり、  
AI 再実行最小化の観点では改善余地がある。

---

## 10. AI 再実行最小化の観点での現状評価

現行実装では以下までは成立している。

- thread 単位の classification / findings は artifact と cache により再利用できる
- split plan も再利用できる
- category master を outputDir ごとに持てる

一方で、以下はまだ増分最適化が弱い。

- `analyze.group_units` は run 全体再構成になりやすい
- `ai.summarize_unit` は影響 unit 単位の更新にまだ寄り切っていない
- `render` も posts 増分追加より全体再出力寄り

そのため、本番運用で AI 再実行を最小化するには、今後は

1. category master の固定運用を通常化する
2. 新規 thread のみ classification / findings する
3. 影響日だけ unit / entry を再生成する
4. render を部分再構成する

方向へ寄せる必要がある。

- thread のサンプルを入力にカテゴリ候補を生成
- `categories.json` を出力

## 8.7 `ai.classify_thread`

- 各 thread を主カテゴリ + 補助カテゴリへ分類
- `thread_classification` を出力

## 8.8 `ai.extract_findings`

- 各 thread から interests / questions / outcomes / images / narrative を抽出
- `thread_findings` を出力

## 8.9 `analyze.group_units`

- `grouping` に基づき unit を構成
- 現行では主に日付単位
- `units.json` を出力

## 8.10 `ai.summarize_unit`

- unit に属する thread の分類結果と findings を束ねて要約
- `unit_summaries` を出力

## 8.11 `ai.write_diary_entry`

- unit summary から日記草稿を生成
- `diary_drafts` を出力

## 8.12 `ai.rewrite_diary_entry`

- 草稿を自然な Markdown 本文に整形
- `diary_entries` を出力

## 8.13 `render.markdown`

- entry 群から最終 diary JSON と Markdown を生成

## 8.14 `render.html`

- Markdown から HTML を生成

## 8.15 `render.pdf`

- Edge / Chrome headless で PDF を生成
- ブラウザが見つからない場合は `render-info.json` に理由を残す

---

## 9. AI 呼び出し

現行実装では AI task ごとに `codex app-server` を使う。  
応答は JSON のみを返すよう developer instructions を付けている。

### 特徴

- raw と parsed を分離保存
- task ごとにモデル切り替え可能
- app-server のイベントは `logs/app-server-events.log` に保存

---

## 10. Resume と skip

現行の resume 判定は `task-state` ベース。

### skip 条件

以下を満たせば completed task を再利用する。

- `status == completed`
- `inputHash` 一致
- AI task では `promptHash` 一致
- AI task では `model` 一致
- `dependsOn` 一致
- 必須 artifact が存在

### invalidation 条件

以下のいずれかで再実行対象になる。

- `--force`
- 以前 `running` のまま中断
- 以前 `failed`
- 上流 task が今回 changed / invalidated
- `inputHash` 変化
- `promptHash` 変化
- `model` 変化
- `dependsOn` 変化
- artifact 欠落

---

## 11. AI cache

現行実装では AI cache を `cache/ai/<hash>.json` に保存する。

キーは概ね以下で構成される。

- `taskKey`
- `model`
- `inputHash`
- `promptHash`
- `taskVersion`
- `outputSchemaVersion`

cache hit 時は:

- app-server へ再送しない
- `task.cache_hit` を記録
- parsed 結果を再利用

---

## 12. フィルタリング

`run` 実行時には以下のフィルタが使える。

- `only`
- `itemIds`
- `date`
- `limit`

### 注意点

- `run` task は `limit` の対象外
- `date` は `category` grouping ではエラー
- `thread` は `primaryDate`、`unit` / `entry` は `date` ベースで絞る

---

## 13. 現状の特性

### 13.1 強み

- 途中失敗後の resume ができる
- task ごとに成果物と状態が残る
- raw AI 応答まで追跡できる
- task ごとにモデルを切り替えられる
- cache hit を利用できる

### 13.2 重い箇所

- `analyze.normalize_threads` は全 thread を正規化するため重い
- `ai.classify_thread` と `ai.extract_findings` が thread ごとに 2 回 AI を使う
- `ai.write_diary_entry` と `ai.rewrite_diary_entry` も 2 段構成

### 13.3 改善候補

- `ai.classify_thread` と `ai.extract_findings` の統合
- `ai.write_diary_entry` と `ai.rewrite_diary_entry` の統合または任意化
- normalize / group の部分実行最適化

---

## 14. 本番設定の現状

`nikki.config.prod.json` では以下の方針になっている。

- 全体デフォルト: `gpt-5.4`
- 分類・抽出・unit 要約: `gpt-5.4-mini`
- 日記本文生成・整形: `gpt-5.4`

このため、品質が効く後段だけ重いモデルを使い、  
thread 件数に比例する前段は mini に寄せる構成になっている。

---

## 15. 参照先

- 現行 task 定義: `src/task-definitions.js`
- 現行 runtime: `src/pipeline.js`
- 現行 CLI: `src/cli.js`
- 目標仕様: `docs/2026-03-26/02_pipeline_complete.md`
- 実装タスク整理: `docs/2026-03-26/06_implementation_tasks.md`
