# 04-2_execution_state.md

## 1. 目的

本ドキュメントは、日記生成パイプラインにおける**実行状態データの仕様**を定義する。  
対象は以下である。

- `task-state/<taskKey>__<itemId>.json`
- `progress.json`
- `events.jsonl`

本仕様の目的は次の通りである。

1. 実行制御の正本となる状態ファイル構造を固定する
2. レジューム・再実行・進捗表示の挙動を安定化する
3. CLI仕様・runtime仕様と整合する形で、状態更新対象を明確化する

本ドキュメントは**状態ファイルの構造**を扱う。  
実行順序・依存解決・レジューム判定ロジックの詳細は `05_runtime_spec.md`、  
CLIオプションや優先順位は `03_cli_spec.md`、  
成果物JSONやキャッシュ/無効化条件は `04-1_data_artifacts.md` および `04-3_cache_invalidation.md` で扱う。

---

## 2. 適用範囲

本仕様が対象とするファイルは以下である。

- `task-state/<taskKey>__<itemId>.json`
- `progress.json`
- `events.jsonl`

対象外:

- `artifacts/*` 配下の成果物JSON
- `cache/ai/<hash>.json`
- `artifacts/raw/<taskKey>/<itemId>.raw.json`

---

## 3. 設計原則

### 3.1 `task-state` を制御の正本とする

実行制御・レジューム・再利用判定の正本は `task-state` である。  
`progress.json` は表示用であり、制御の正本ではない。

### 3.2 `progress.json` は現在状態のスナップショットとする

`progress.json` は、現在の run の見やすい状態を保持する。  
監視スクリプト・CLI表示・ログ確認のためのファイルであり、  
再開判定や依存解決には用いない。

### 3.3 `events.jsonl` は append-only とする

イベントログは追記専用とし、過去イベントを更新しない。  
これにより、後から実行履歴・エラー発生箇所・キャッシュヒット・スキップ理由を追跡しやすくする。

### 3.4 すべての状態ファイルは run 単位で閉じる

`task-state`、`progress.json`、`events.jsonl` は特定 run に属する。  
他 run と共有しない。

### 3.5 進捗件数と入力件数を混同しない

入力データの件数統計は `export-manifest.json` が保持する。  
`progress.json.counts.total` は**実行対象として確定した task instance 数**であり、入力件数とは意味が異なる。

---

## 4. 用語定義

| 用語 | 意味 |
|---|---|
| task | 実行可能な処理単位。例: `ai.extract_findings` |
| item | task が対象とする単位。`run` / `thread` / `unit` / `entry` |
| task instance | `taskKey` と `itemId` の組で表される実行対象 |
| task-state | task instance の状態を保存するJSON |
| progress | run 全体の現在進捗を保存するJSON |
| event | 実行中に発生した時系列記録 |
| completed | 正常完了済み |
| failed | 失敗終了 |
| skipped | 実行不要として明示スキップ |
| invalidated | 既存成果物を再利用せず再実行すべき状態 |

---

## 5. 共通ルール

### 5.1 時刻形式

状態ファイル内の日時は、原則として ISO 8601 / JST オフセット付きとする。

例:

```text
2026-03-26T12:00:00+09:00
```

### 5.2 識別子

- `runId` はファイル名安全な文字列とする
- `taskKey` は pipeline 仕様で定義されたキーを使う
- `itemId` は決定的に生成する
- `taskInstanceId` は以下で構成する

```text
<taskKey>__<itemId>
```

例:

```text
prepare.scan_export__run
ai.classify_thread__thread_000123
ai.summarize_unit__unit_date_2026-03-25
ai.write_diary_entry__entry_2026-03-25
```

### 5.3 パス表記

`artifactPaths` などの参照パスは、run ルートからの**相対パス**を推奨する。

### 5.4 バージョニング

状態ファイル自体も `schemaVersion` を持つ。  
`task-state` にはさらに、再利用判定のため `taskVersion` と `outputSchemaVersion` を持たせる。

---

## 6. enum 定義

### 6.1 TaskStatus

| 値 | 説明 |
|---|---|
| `pending` | 未実行、または再実行待ち |
| `running` | 実行中 |
| `completed` | 正常完了 |
| `failed` | 失敗 |
| `skipped` | 明示的にスキップ |
| `invalidated` | 上流変更等により再実行対象 |

### 6.2 ItemType

| 値 | 説明 |
|---|---|
| `run` | 実行全体 |
| `thread` | 1スレッド |
| `unit` | 集約単位 |
| `entry` | 日記1件 |

### 6.3 ProgressStatus

`progress.json.status` に使用する。

| 値 | 説明 |
|---|---|
| `running` | 実行中 |
| `completed` | 全体完了 |
| `failed` | 全体失敗 |
| `dry_run` | 実行せず対象列挙のみ行った |
| `stopped` | ユーザー停止または異常中断後の停止状態 |

---

## 7. task-state 仕様

### 7.1 パス

```text
task-state/<taskKey>__<itemId>.json
```

例:

```text
task-state/ai.extract_findings__thread_000123.json
```

### 7.2 目的

各 task instance の状態を保持する。  
レジューム・再実行・skip 判定・invalidated 判定・成果物参照の正本とする。

### 7.3 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `schemaVersion` | integer | 必須 | task-state スキーマ版 |
| `runId` | string | 必須 | 実行識別子 |
| `taskKey` | string | 必須 | 例: `ai.extract_findings` |
| `itemType` | string | 必須 | `run` / `thread` / `unit` / `entry` |
| `itemId` | string | 必須 | 例: `thread_000123` |
| `status` | string | 必須 | `TaskStatus` |
| `dependsOn` | string[] | 必須 | 依存する taskInstanceId 一覧 |
| `inputHash` | string \| null | 必須 | 入力差分判定用 |
| `promptHash` | string \| null | 必須 | AIタスクのみ使用 |
| `model` | string \| null | 必須 | AIタスクのみ使用 |
| `taskVersion` | integer | 必須 | 実行ロジック版 |
| `outputSchemaVersion` | integer | 必須 | 出力スキーマ版 |
| `artifactPaths` | string[] | 必須 | 成果物相対パス一覧 |
| `startedAt` | string \| null | 必須 | 実行開始時刻 |
| `finishedAt` | string \| null | 必須 | 実行終了時刻 |
| `retryCount` | integer | 必須 | 再試行回数 |
| `error` | object \| null | 必須 | エラー情報 |

### 7.4 `dependsOn`

`dependsOn` は task instance ID の配列とする。  
値の形式は以下。

```text
<taskKey>__<itemId>
```

例:

```json
[
  "analyze.attach_images__run",
  "ai.generate_category_candidates__run"
]
```

### 7.5 `error` オブジェクト

`status = failed` の場合、`error` は原則非nullとする。

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `code` | string | 必須 | エラー種別 |
| `message` | string | 必須 | 人間向けメッセージ |
| `retryable` | boolean | 必須 | 再試行可能か |

例:

```json
{
  "code": "MODEL_TIMEOUT",
  "message": "app-server からの応答がタイムアウトした",
  "retryable": true
}
```

### 7.6 制約

- `retryCount >= 0`
- `status = running` の場合、`startedAt` は非null
- `status = completed` の場合、`finishedAt` は非null
- `status = completed` で `artifactPaths` が空の場合は原則不正
- 非AIタスクでは `promptHash` / `model` は `null`
- AIタスクでは `promptHash` / `model` は原則非null

### 7.7 例

```json
{
  "schemaVersion": 1,
  "runId": "run_2026-03-26_001",
  "taskKey": "ai.extract_findings",
  "itemType": "thread",
  "itemId": "thread_000123",
  "status": "completed",
  "dependsOn": [
    "analyze.attach_images__run"
  ],
  "inputHash": "sha256:aaaa...",
  "promptHash": "sha256:bbbb...",
  "model": "gpt-5.4",
  "taskVersion": 1,
  "outputSchemaVersion": 1,
  "artifactPaths": [
    "artifacts/ai/thread_findings/thread_000123.json",
    "artifacts/raw/ai.extract_findings/thread_000123.raw.json"
  ],
  "startedAt": "2026-03-26T12:00:00+09:00",
  "finishedAt": "2026-03-26T12:00:12+09:00",
  "retryCount": 0,
  "error": null
}
```

---

## 8. progress.json 仕様

### 8.1 パス

```text
progress.json
```

### 8.2 目的

現在の run の進捗を、人間および監視ツール向けに保持する。  
制御の正本ではなく、現在状態の表示用スナップショットである。

### 8.3 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `schemaVersion` | integer | 必須 | progress スキーマ版 |
| `runId` | string | 必須 | 実行識別子 |
| `status` | string | 必須 | `ProgressStatus` |
| `stage` | string \| null | 必須 | 現在の Stage |
| `taskKey` | string \| null | 必須 | 現在の taskKey |
| `itemType` | string \| null | 必須 | `run` / `thread` / `unit` / `entry` |
| `currentItemId` | string \| null | 必須 | 現在対象 |
| `counts` | object | 必須 | 件数情報 |
| `startedAt` | string | 必須 | run 開始時刻 |
| `updatedAt` | string | 必須 | 最終更新時刻 |
| `elapsedSec` | integer | 必須 | 開始からの経過秒数 |
| `lastEvent` | string \| null | 必須 | 最後に処理したイベント種別 |
| `promptPreview` | string \| null | 必須 | 現在送信中または直近送信プロンプトの先頭要約 |
| `sentAt` | string \| null | 必須 | 現在または直近のAI送信時刻 |
| `note` | string \| null | 必須 | 現在状態の補足 |
| `currentTaskInstanceId` | string \| null | 必須 | 現在処理対象の taskInstanceId |

### 8.4 `counts` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `completed` | integer | 必須 | 完了済み task instance 数 |
| `total` | integer | 必須 | 実行対象として確定した task instance 数 |
| `success` | integer | 必須 | 正常完了件数 |
| `failed` | integer | 必須 | 失敗件数 |
| `skipped` | integer | 必須 | スキップ件数 |

### 8.5 `counts.total` の定義

`counts.total` は以下で定義する。

```text
total = 実行対象として確定した task instance 数
```

#### 決定タイミング

- オプション解決後
- item 解決後
- 実行開始前

#### 補足

- 実行中に `total` は変化しない
- 入力データ件数ではない
- `export-manifest.json` の `counts` と混同しない

### 8.6 制約

- すべての件数は `>= 0`
- `counts.completed <= counts.total`
- `counts.success + counts.failed + counts.skipped <= counts.total`
- `elapsedSec >= 0`
- `status = running` の場合、`updatedAt` は逐次更新する

### 8.7 例

```json
{
  "schemaVersion": 1,
  "runId": "run_2026-03-26_001",
  "status": "running",
  "stage": "ai.thread",
  "taskKey": "ai.extract_findings",
  "itemType": "thread",
  "currentItemId": "thread_000123",
  "counts": {
    "completed": 182,
    "total": 2254,
    "success": 180,
    "failed": 1,
    "skipped": 1
  },
  "startedAt": "2026-03-26T11:00:00+09:00",
  "updatedAt": "2026-03-26T12:00:12+09:00",
  "elapsedSec": 3612,
  "lastEvent": "task_completed",
  "promptPreview": "会話からユーザーの興味、疑問、解決済み事項、結末を抽出する",
  "sentAt": "2026-03-26T12:00:02+09:00",
  "note": "thread_000123 completed",
  "currentTaskInstanceId": "ai.extract_findings__thread_000123"
}
```

---

## 9. events.jsonl 仕様

### 9.1 パス

```text
events.jsonl
```

### 9.2 目的

run 中に発生したイベントを時系列で保存する。  
debugging、進捗監視、障害解析、resume 挙動確認のための補助ログとする。

### 9.3 形式

- 1行1JSON
- append-only
- 過去行は更新しない

### 9.4 共通フィールド

すべてのイベントは、少なくとも以下を持つ。

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `ts` | string | 必須 | 発生時刻 |
| `type` | string | 必須 | イベント種別 |
| `runId` | string | 必須 | 実行識別子 |

### 9.5 task 関連イベントの追加フィールド

task 関連イベントでは、必要に応じて以下を含む。

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `taskKey` | string | 任意 | taskKey |
| `itemId` | string | 任意 | itemId |
| `taskInstanceId` | string | 任意 | task instance ID |
| `note` | string | 任意 | 補足メッセージ |
| `reason` | string | 任意 | スキップや失敗理由 |
| `promptPreview` | string | 任意 | 送信プロンプト要約 |

### 9.6 イベント種別

初版で定義するイベントは以下とする。

- `run_started`
- `run_resumed`
- `task_started`
- `prompt_sent`
- `model_event`
- `cache_hit`
- `task_completed`
- `task_failed`
- `task_skipped`
- `task_invalidated`
- `run_completed`

### 9.7 代表例

#### run 開始

```json
{"ts":"2026-03-26T11:00:00+09:00","type":"run_started","runId":"run_2026-03-26_001"}
```

#### task 開始

```json
{"ts":"2026-03-26T11:00:01+09:00","type":"task_started","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000123","taskInstanceId":"ai.extract_findings__thread_000123"}
```

#### prompt 送信

```json
{"ts":"2026-03-26T11:00:02+09:00","type":"prompt_sent","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000123","taskInstanceId":"ai.extract_findings__thread_000123","promptPreview":"会話から興味・疑問・解決を抽出"}
```

#### cache hit

```json
{"ts":"2026-03-26T11:00:02+09:00","type":"cache_hit","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000123","taskInstanceId":"ai.extract_findings__thread_000123","note":"ai cache reused"}
```

#### task スキップ

```json
{"ts":"2026-03-26T11:00:03+09:00","type":"task_skipped","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000123","taskInstanceId":"ai.extract_findings__thread_000123","reason":"completed and reusable"}
```

#### task 完了

```json
{"ts":"2026-03-26T11:00:12+09:00","type":"task_completed","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000123","taskInstanceId":"ai.extract_findings__thread_000123"}
```

---

## 10. 状態ファイル間の関係

### 10.1 task-state と progress

- `task-state` は制御の正本
- `progress` は現在状態の表示用スナップショット

したがって、再開判定・skip判定・invalidated判定は `task-state` を参照する。

### 10.2 task-state と events

- `task-state` は現在状態
- `events` は履歴

`events` だけで現在状態を再構築することは想定しない。

### 10.3 progress と events

- `progress` は最新1件の集約状態
- `events` は時系列ログ

監視スクリプトやCLI表示では、必要に応じて両方を読む。

---

## 11. cache hit 時の状態反映

AIタスクにおいてキャッシュがヒットした場合、以下とする。

- API呼び出しを行わない
- task は `completed` として扱う
- `task-state` を更新する
- `events.jsonl` に `cache_hit` を記録する
- 必要に応じて `progress.json.lastEvent = "cache_hit"` とする

`task-state` 上は、通常完了との差異を `artifactPaths` および上流の provenance で追跡する。  
追加で出力成果物側に `aiMeta.cacheHit = true` を持たせてもよい。

---

## 12. 状態更新タイミング

状態更新は最低限以下のタイミングで行う。

- run 開始時
- task 開始時
- prompt 送信時
- model event 受信時
- cache hit 時
- task 完了時
- task 失敗時
- task スキップ時
- run 完了時

### 12.1 task 開始時

- `task-state.status = running`
- `task-state.startedAt` 更新
- `progress.taskKey` 更新
- `progress.currentItemId` 更新
- `events` に `task_started` 追記

### 12.2 prompt 送信時

- `progress.promptPreview` 更新
- `progress.sentAt` 更新
- `events` に `prompt_sent` 追記

### 12.3 cache hit 時

- `task-state.status = completed`
- `task-state.finishedAt` 更新
- `progress.lastEvent = "cache_hit"`
- `events` に `cache_hit` 追記

### 12.4 task 完了時

- `task-state.status = completed`
- `task-state.finishedAt` 更新
- `progress.counts.completed` 更新
- `progress.counts.success` 更新
- `progress.lastEvent = "task_completed"`
- `events` に `task_completed` 追記

### 12.5 task 失敗時

- `task-state.status = failed`
- `task-state.finishedAt` 更新
- `task-state.error` 設定
- `progress.counts.failed` 更新
- `progress.lastEvent = "task_failed"`
- `events` に `task_failed` 追記

### 12.6 task スキップ時

- `task-state.status = skipped`
- `task-state.finishedAt` 更新可
- `progress.counts.skipped` 更新
- `progress.lastEvent = "task_skipped"`
- `events` に `task_skipped` 追記

---

## 13. 実装上の注意

### 13.1 `running` のまま終了した状態

前回実行で `running` のまま残っている `task-state` は、次回 run 時に異常中断扱いとする。  
再開時の具体的な再試行判定は runtime 側で定義するが、本仕様上は `running` を永続安定状態として扱わない。

### 13.2 `progress.json` を正本にしない

`progress.json` のみを読んで再開判定してはならない。  
進捗と制御を混ぜると、表示用変更で再開挙動が壊れる。

### 13.3 `events.jsonl` を正本にしない

`events.jsonl` は履歴追跡用であり、再利用判定の正本ではない。

### 13.4 `counts.total` を入力件数にしない

`counts.total` は task instance 数であり、スレッド数・画像数・メッセージ数ではない。  
入力件数は `export-manifest.json` を参照する。

---

## 14. 変更指針

以下の場合、本ドキュメントの更新を検討する。

- `task-state` の必須項目を追加/削除する場合
- `progress.json` の表示粒度を変える場合
- `events.jsonl` のイベント種別を増減する場合
- `taskInstanceId` の命名規則を変更する場合
- cache hit や skipped の扱いを変更する場合

---

## 15. 要約

本仕様では、実行状態を以下の3層に分離する。

1. `task-state`: 制御の正本
2. `progress.json`: 現在状態の表示
3. `events.jsonl`: 時系列履歴

この分離により、以下を実現する。

- 安定したレジューム
- 信頼できる進捗表示
- 障害時の追跡容易性
- AIタスクの再利用・スキップ・キャッシュヒットの可視化
