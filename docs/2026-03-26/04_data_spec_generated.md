# 04_data_spec.md

## 1. 目的

本ドキュメントは、日記生成パイプラインにおける**データ仕様群の親ドキュメント**であり、データ仕様全体の責務分割、共通ルール、参照関係、命名規則、バージョニング規則を定義する。

本ドキュメント自体は、以下の 3 系統の仕様を束ねる**ルート仕様**として機能する。

- 成果物仕様
- 実行状態仕様
- キャッシュ / 無効化仕様

本ドキュメントの目的は以下である。

1. データ仕様全体の責務境界を明確化する
2. サブドキュメント間で共通化すべきルールを一元化する
3. 分割後も情報落ち・責務重複・参照迷子を防ぐ
4. 実装者が「どの仕様をどこで見るべきか」を即座に判断できるようにする

---

## 2. 分割方針

`04_data_spec.md` は肥大化しやすいため、以下の 3 つに責務分割する。

- `04-1_data_artifacts.md`
- `04-2_execution_state.md`
- `04-3_cache_invalidation.md`

### 2.1 分割理由

単一ドキュメントに以下が同居すると、変更頻度・責務・参照先が混在し、保守性が低下する。

- 中間成果物 JSON
- 最終成果物の元 JSON
- task-state / progress / events
- inputHash / promptHash / cache / invalidation

そのため、本仕様では以下の原則で分割する。

| 区分 | 主題 | 変更頻度 | 正本 |
|---|---|---:|---|
| 04-1 | 成果物 JSON | 中 | 成果物仕様の正本 |
| 04-2 | 実行状態 JSON | 高 | 実行状態仕様の正本 |
| 04-3 | キャッシュ / 差分判定 | 高 | 再利用判定仕様の正本 |

---

## 3. サブドキュメント一覧

## 3.1 04-1_data_artifacts.md

成果物仕様を定義する。

対象:

- `artifacts/manifest/export-manifest.json`
- `artifacts/indexes/thread-index.json`
- `artifacts/normalized/thread_<id>.json`
- `artifacts/ai/categories.json`
- `artifacts/ai/thread_classification/thread_<id>.json`
- `artifacts/ai/thread_findings/thread_<id>.json`
- `artifacts/ai/image_notes/thread_<id>.json`
- `artifacts/units/units.json`
- `artifacts/ai/unit_summaries/unit_<id>.json`
- `artifacts/ai/diary_drafts/entry_<id>.json`
- `artifacts/ai/diary_entries/entry_<id>.json`
- `artifacts/render/diary.json`
- `artifacts/raw/<taskKey>/<itemId>.raw.json`

役割:

- 各 task の artifact 仕様の正本
- 後段タスクが参照する入力 JSON の正本
- AI raw / parsed の責務分離の正本

---

## 3.2 04-2_execution_state.md

実行制御用データ仕様を定義する。

対象:

- `task-state/<taskKey>__<itemId>.json`
- `progress.json`
- `events.jsonl`

役割:

- task 実行状態の正本
- 進捗表示データの正本
- イベント記録の正本

特に以下は **04-2 の責務** とする。

- `progress.counts.total`
- `task-state.status`
- `events.jsonl` のイベント種別
- `cache_hit` / `task_skipped` のイベント記録

---

## 3.3 04-3_cache_invalidation.md

キャッシュと差分判定仕様を定義する。

対象:

- `cache/ai/<hash>.json`
- `inputHash`
- `promptHash`
- `taskVersion`
- `outputSchemaVersion`
- invalidation 条件
- cache hit 時の扱い

役割:

- AI再利用判定の正本
- 差分検知の正本
- invalidated 判定条件の正本

---

## 4. 参照順序

データ仕様群は以下の順で参照することを推奨する。

1. `04_data_spec.md`
2. `04-1_data_artifacts.md`
3. `04-2_execution_state.md`
4. `04-3_cache_invalidation.md`

### 4.1 参照ルール

- artifact の内容を知りたい場合は `04-1` を参照する
- task-state / progress / events を知りたい場合は `04-2` を参照する
- hash / cache / invalidation を知りたい場合は `04-3` を参照する
- 共通ルール・命名規則・責務境界を知りたい場合は本書を参照する

---

## 5. データ仕様全体の対象範囲

本データ仕様群が対象とするファイル群は以下である。

### 5.1 artifact 系

- `artifacts/manifest/export-manifest.json`
- `artifacts/indexes/thread-index.json`
- `artifacts/normalized/thread_<id>.json`
- `artifacts/ai/categories.json`
- `artifacts/ai/thread_classification/thread_<id>.json`
- `artifacts/ai/thread_findings/thread_<id>.json`
- `artifacts/ai/image_notes/thread_<id>.json`
- `artifacts/units/units.json`
- `artifacts/ai/unit_summaries/unit_<id>.json`
- `artifacts/ai/diary_drafts/entry_<id>.json`
- `artifacts/ai/diary_entries/entry_<id>.json`
- `artifacts/render/diary.json`
- `artifacts/raw/<taskKey>/<itemId>.raw.json`

### 5.2 execution state 系

- `task-state/<taskKey>__<itemId>.json`
- `progress.json`
- `events.jsonl`

### 5.3 cache / invalidation 系

- `cache/ai/<hash>.json`

---

## 6. 共通設計原則

## 6.1 すべての内部成果物は JSON を正本とする

Markdown / HTML / PDF は最終出力であり、内部処理の正本ではない。  
内部で再利用・再実行・検証に用いる成果物は必ず JSON とする。

## 6.2 AI成果物は raw と parsed を分離する

AIレスポンスは以下を分離して保存する。

- raw: モデルから返った元レスポンス
- parsed: 後段が読む構造化 JSON

## 6.3 後段は上流成果物のみを読む

`unit_summary` 以降は原則として元会話全文を再読込しない。  
後段は以下を主入力とする。

- normalized thread
- thread classification
- thread findings
- image notes
- unit definitions

## 6.4 すべての AI タスクは provenance を保持する

どの入力・どのプロンプト・どのモデルで作られた成果物か追跡可能にする。

## 6.5 スキーマ変更とロジック変更は別管理とする

- `schemaVersion`: 出力構造の互換性
- `taskVersion`: 実行ロジックの互換性

## 6.6 表示用データと制御用データは分離する

- `progress.json` は表示用
- `task-state` は制御用

この原則は固定とする。

## 6.7 task instance 総数は execution state の責務とする

`counts.total` は **実行対象として確定した task instance 数** を意味する。  
これは入力エクスポートの件数統計ではない。

したがって、以下を原則とする。

- `export-manifest.json` に `counts.total` を持たせない
- `progress.json` の `counts.total` として管理する

---

## 7. 共通メタ項目

すべての成果物 JSON は、以下の共通メタフィールドを持つ。

### 7.1 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `schemaVersion` | integer | 必須 | 当該成果物スキーマの版 |
| `generatedAt` | string | 必須 | 生成時刻。ISO 8601, JST オフセット付き |
| `runId` | string | 必須 | 実行識別子 |

### 7.2 制約

- `schemaVersion >= 1`
- `generatedAt` は `YYYY-MM-DDTHH:mm:ss+09:00` を推奨
- `runId` はファイル名安全な文字列のみを使用する
- `runId` にスペース、バックスラッシュは使用しない

### 7.3 共通例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001"
}
```

---

## 8. AI 共通メタ項目

AI を利用して生成した成果物は以下の `aiMeta` を持つ。

### 8.1 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `aiMeta.model` | string | 必須 | 使用モデル ID |
| `aiMeta.promptHash` | string | 必須 | プロンプト定義のハッシュ |
| `aiMeta.inputHash` | string | 必須 | モデル投入入力のハッシュ |

### 8.2 任意フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `aiMeta.provider` | string | 任意 | 例: `codex-app-server` |
| `aiMeta.temperature` | number | 任意 | 温度パラメータ |
| `aiMeta.maxTokens` | integer | 任意 | 上限トークン |
| `aiMeta.cacheHit` | boolean | 任意 | AIキャッシュ利用有無 |

### 8.3 `aiMeta.cacheHit` の扱い

- 型: boolean
- `true`: キャッシュ利用
- `false`: API 実行
- 初期実装では任意だが、実装段階では保存を推奨する

### 8.4 例

```json
{
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:abcd...",
    "inputHash": "sha256:1234...",
    "provider": "codex-app-server",
    "cacheHit": false
  }
}
```

---

## 9. 共通 enum 定義

## 9.1 TaskStatus

| 値 | 説明 |
|---|---|
| `pending` | 未実行 |
| `running` | 実行中 |
| `completed` | 正常完了 |
| `failed` | 失敗 |
| `skipped` | 明示的にスキップ |
| `invalidated` | 上流変更等により再実行対象 |

## 9.2 QuestionStatus

`thread_findings.questions[].status` に使用する。

| 値 | 説明 |
|---|---|
| `unresolved` | 未解決 |
| `partially_resolved` | 一部解決 |
| `resolved` | 解決済み |

## 9.3 ItemType

| 値 | 説明 |
|---|---|
| `run` | 実行全体 |
| `thread` | 1スレッド |
| `unit` | 集約単位 |
| `entry` | 日記1件 |

## 9.4 UnitStrategy

| 値 | 説明 |
|---|---|
| `date` | 日付単位 |
| `date_category` | 日付×カテゴリ単位 |
| `category` | カテゴリ単位 |

## 9.5 ImageKind

| 値 | 説明 |
|---|---|
| `generated` | 生成画像 |
| `attachment` | 添付画像 |

---

## 10. 共通命名規則

## 10.1 itemId

| itemType | 形式 | 例 |
|---|---|---|
| `run` | 固定 | `run` |
| `thread` | `thread_<nnnnnn>` | `thread_000123` |
| `unit` | `unit_<strategy>_<key>` | `unit_date_2026-03-25` |
| `entry` | `entry_<date>` | `entry_2026-03-25` |

## 10.2 task instance 識別子

形式:

```text
<taskKey>__<itemId>
```

例:

- `prepare.scan_export__run`
- `ai.classify_thread__thread_000123`
- `ai.summarize_unit__unit_date_2026-03-25`

## 10.3 raw artifact パス

形式:

```text
artifacts/raw/<taskKey>/<itemId>.raw.json
```

## 10.4 task-state パス

形式:

```text
task-state/<taskKey>__<itemId>.json
```

---

## 11. 共通バージョニング規則

## 11.1 schemaVersion

- 各成果物 JSON の構造互換性を表す
- 出力構造に非互換変更が入る場合は増分する

## 11.2 taskVersion

- 実行ロジック互換性を表す
- 同じ出力形でも、生成ロジックや意味解釈が変わる場合は増分する

## 11.3 outputSchemaVersion

- `task-state` 側が追跡する出力スキーマ版
- 実行時の invalidation 判定に利用する

---

## 12. ドキュメント間の責務境界

## 12.1 本書で定義するもの

- データ仕様群の分割方針
- 共通メタ項目
- 共通 enum
- 共通命名規則
- 共通バージョニング規則
- サブドキュメントの責務境界
- `counts.total` の所属先ルール

## 12.2 04-1_data_artifacts.md で定義するもの

- artifact JSON の詳細フィールド
- artifact ごとの制約
- artifact の例
- raw / parsed の関係

## 12.3 04-2_execution_state.md で定義するもの

- `task-state` 詳細
- `progress.json` 詳細
- `events.jsonl` 詳細
- `progress.counts.total` の定義
- イベント種別一覧
- `cache_hit` / `task_skipped` のイベント仕様

## 12.4 04-3_cache_invalidation.md で定義するもの

- cache JSON 形式
- `inputHash`
- `promptHash`
- cache key 構成
- invalidation 条件
- invalidation の伝播との関係
- cache hit 時の task-state / events 更新規則

---

## 13. 情報移管マップ

旧 `04_data_spec.md` に含まれていた内容は、分割後に以下へ移管する。

| 旧内容 | 新しい所在 |
|---|---|
| export-manifest | `04-1_data_artifacts.md` |
| thread-index | `04-1_data_artifacts.md` |
| normalized thread | `04-1_data_artifacts.md` |
| categories | `04-1_data_artifacts.md` |
| thread_classification | `04-1_data_artifacts.md` |
| thread_findings | `04-1_data_artifacts.md` |
| image_notes | `04-1_data_artifacts.md` |
| units | `04-1_data_artifacts.md` |
| unit_summary | `04-1_data_artifacts.md` |
| diary_draft | `04-1_data_artifacts.md` |
| diary_entry | `04-1_data_artifacts.md` |
| render/diary.json | `04-1_data_artifacts.md` |
| task-state | `04-2_execution_state.md` |
| progress.json | `04-2_execution_state.md` |
| events.jsonl | `04-2_execution_state.md` |
| cache/ai | `04-3_cache_invalidation.md` |
| inputHash / promptHash | `04-3_cache_invalidation.md` |
| invalidation 条件 | `04-3_cache_invalidation.md` |

---

## 14. 実装上の重要注意

## 14.1 `export-manifest.json` は入力統計のみを扱う

`export-manifest.json` の `counts` は以下のみを扱う。

- conversationFiles
- threads
- messages
- generatedImages
- attachedImages

task instance 数や進捗総数は含めない。

## 14.2 `progress.json` は表示用である

制御の正本は `task-state` とし、`progress.json` は表示用途に限定する。

## 14.3 cache hit は状態遷移を伴う

AIキャッシュがヒットした場合でも、以下は必ず更新する。

- task-state
- progress
- events

## 14.4 raw は削除前提にしない

raw レスポンスはデバッグ・パース修正・再検証で必要になるため、初版では保持を前提とする。

---

## 15. 今後の分割運用ルール

- 新しい artifact を追加する場合は `04-1` に追記する
- 新しい state フィールドや event 種別を追加する場合は `04-2` に追記する
- 新しい hash ルールや cache key 変更を行う場合は `04-3` に追記する
- 本書は原則として共通ルールの変更時のみ更新する

---

## 16. まとめ

本書は `04` 系仕様の親ドキュメントであり、**共通ルールと責務境界の正本** である。

詳細仕様は以下を参照する。

- `04-1_data_artifacts.md`
- `04-2_execution_state.md`
- `04-3_cache_invalidation.md`

本書の役割は、分割後もデータ仕様全体の整合性を維持し、情報落ち・責務重複・解釈ずれを防ぐことである。
