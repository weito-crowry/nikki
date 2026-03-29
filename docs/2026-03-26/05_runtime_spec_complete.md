# 05_runtime_spec.md

## 1. 概要

本ドキュメントは、日記生成パイプラインの**実行・再開・進捗管理・イベント記録・エラーハンドリング・AIキャッシュ利用**の仕様を定義する。

対象範囲は以下とする。

- 実行フロー
- タスクインスタンス生成
- タスク状態遷移
- レジュームロジック
- 実行対象決定
- 進捗更新仕様
- イベントログ仕様
- AIキャッシュ挙動
- エラーハンドリング
- 実行保証

本仕様は、CLI 仕様およびデータ仕様と整合することを前提とする。  
特に以下と対応する。

- `03_cli_spec.md`: コマンド、オプション、優先順位、エラー条件
- `04_data_spec.md`: `task-state`, `progress.json`, `events.jsonl`, `cache/ai/*` のデータ構造
- `02_pipeline.md`: taskKey、dependsOn、itemType、stage 構成

---

## 2. 実行フロー

### 2.1 全体フロー

`run` 実行時の全体フローは以下とする。

1. run 開始
2. 入力検証
3. task 定義ロード
4. タスクインスタンス生成
5. 依存関係解決
6. 実行対象決定
7. task 実行
8. 状態更新
9. 次 task へ遷移
10. run 完了

### 2.2 実行単位

| 単位 | 説明 |
|---|---|
| run | 全体実行 |
| task | 処理単位 |
| item | task の対象単位。`run` / `thread` / `unit` / `entry` |

### 2.3 Stage と task の関係

初版の Stage は以下を前提とする。

```text
prepare
analyze
ai.catalog
ai.thread
ai.unit
ai.entry
render
```

初版の taskKey は以下を前提とする。

```text
prepare.extract_export
prepare.scan_export
prepare.build_thread_index
analyze.normalize_threads
analyze.attach_images
ai.generate_category_candidates
ai.classify_thread
ai.extract_findings
analyze.group_units
ai.summarize_unit
ai.write_diary_entry
ai.rewrite_diary_entry
render.markdown
render.html
render.pdf
```

---

## 3. タスクインスタンス生成

### 3.1 基本方針

runtime は task 定義そのものではなく、**task definition × item** から生成される **task instance** を実行単位とする。

例:

- `prepare.extract_export__run`
- `ai.extract_findings__thread_000123`
- `ai.summarize_unit__unit_date_2026-03-25`
- `ai.write_diary_entry__entry_2026-03-25`

### 3.2 生成順序

タスクインスタンスは以下の順で生成する。

1. run task instance を生成する
2. `thread-index.json` を読み込み thread item を列挙する
3. thread task instance を生成する
4. `units.json` を読み込み unit item を列挙する
5. unit task instance を生成する
6. entry item を生成する
7. entry task instance を生成する

### 3.3 item 列挙の正本

各 itemType の列挙元は以下とする。

| itemType | 正本 |
|---|---|
| `run` | 固定値 `run` |
| `thread` | `artifacts/indexes/thread-index.json` |
| `unit` | `artifacts/units/units.json` |
| `entry` | `units.json` から決定的に導出 |

### 3.4 entry 生成規則

初版では `unitStrategy = date` を前提とし、entry は日付単位で生成する。

- `unit_date_2026-03-25` → `entry_2026-03-25`

将来的に `date_category` を導入する場合でも、初版 runtime では **最終 entry は日付単位** を維持する。  
その場合、複数 unit から 1 entry を構成するのは `ai.write_diary_entry` 側の入力解決責務とする。

### 3.5 タスクインスタンスID

task instance の識別子は以下とする。

```text
<taskKey>__<itemId>
```

例:

- `prepare.scan_export__run`
- `ai.classify_thread__thread_000123`
- `ai.summarize_unit__unit_date_2026-03-25`

この識別子は `task-state.dependsOn[]` でも使用する。

---

## 4. タスク状態遷移

### 4.1 ステータス定義

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`
- `invalidated`

### 4.2 状態遷移

```text
pending → running → completed
                 → failed

failed → pending
completed → invalidated
invalidated → pending
running → failed
skipped → pending
```

### 4.3 各状態の意味

| 状態 | 意味 |
|---|---|
| `pending` | 未実行、または再実行待ち |
| `running` | 実行中 |
| `completed` | 正常完了 |
| `failed` | 失敗終了 |
| `skipped` | 実行不要として明示的にスキップ |
| `invalidated` | 上流変更等により既存成果物を再利用できない |

### 4.4 `running` の扱い

前回実行で `running` のまま終了していた task instance は、次回 run 時に**異常終了扱い**とし、再試行対象とする。  
内部状態としては次のいずれかで処理してよい。

- 読み込み時に `failed` 相当として扱う
- 読み込み時に `pending` へ戻す

ただしユーザー向け意味としては **「中断されたため再実行される」** で統一する。

---

## 5. レジュームロジック

### 5.1 基本方針

レジュームは「途中地点から実行ポインタを再開する」のではなく、  
**各 task instance の再利用可否を判定し、未完了または再利用不可のものだけを再評価する** 方式とする。

### 5.2 判定ルール

| 状態 | 条件 | 挙動 |
|---|---|---|
| `completed` | hash 一致 | skip |
| `completed` | hash 不一致 | invalidated |
| `failed` | - | 再試行対象 |
| `running` | - | 中断扱い → 再試行対象 |
| `pending` | - | 実行対象 |
| `skipped` | 条件再評価で不要 | skip 維持 |
| `skipped` | 条件変化あり | pending または invalidated |

### 5.3 invalidation 条件

以下のいずれかで invalidated とする。

- `inputHash` 変更
- `promptHash` 変更（AI task）
- `model` 変更（AI task）
- `taskVersion` 変更
- `outputSchemaVersion` 変更
- 依存 task instance の変更
- 必須 artifact 欠落
- cache と artifact の参照不整合

### 5.4 invalidation の伝播

上流 task instance が invalidated になった場合、**依存する下流 task instance も invalidated とする**。

#### 規則

- 伝播単位は task instance 単位
- 同一 run 内で適用する
- `dependsOn[]` により直接依存する task instance を起点に、再帰的に下流へ伝播してよい

例:

- `analyze.attach_images__run` が invalidated
- 依存する `ai.extract_findings__thread_*` は invalidated
- さらに依存する `ai.summarize_unit__unit_*` も invalidated
- さらに `ai.write_diary_entry__entry_*` も invalidated

### 5.5 skip と invalidated の違い

- `skip`: 現在条件で実行不要
- `invalidated`: 既存成果物を再利用してはならず、再計算が必要

runtime はこの2つを混同しないこと。

---

## 6. 実行対象決定

### 6.1 オプション優先順位

CLI の優先順位は以下と整合する。

1. `--only`
2. `--item-id`
3. `--date`
4. `--limit`

再実行制御の優先順位は以下とする。

1. `--force`
2. `--retry-failed`
3. `--skip-completed`
4. 指定なし = 通常 resume 判定

### 6.2 実行対象の決定順

runtime は以下の順で実行対象を決定する。

1. task 範囲を解決する
2. task ごとの item 列を解決する
3. `--item-id` / `--date` / `--limit` を適用する
4. task instance を生成する
5. 既存 `task-state` を読み込む
6. invalidation を判定する
7. `--force` / `--retry-failed` / `--skip-completed` を適用する
8. 最終実行対象を確定する

### 6.3 `--date` と unitStrategy の関係

`--date` の解決は `unitStrategy` に依存する。

| unitStrategy | `unit` 解決 | `entry` 解決 |
|---|---|---|
| `date` | `unit_date_<date>` | `entry_<date>` |
| `date_category` | `unit_date_category_<date>_*` 複数 | `entry_<date>` |
| `category` | エラー | エラー |

#### 規則

- `thread` task に対する `--date` は `primaryDate == <date>` の thread 群へ解決する
- `run` task に対する `--date` はエラーとする
- 複数 unit に解決される場合は、その全件を対象とする

### 6.4 `--limit` の適用範囲

`--limit` は **task 単位** で適用する。

#### 規則

- 各 task の item 列挙後に適用する
- `thread` / `unit` / `entry` はそれぞれ独立して適用する
- `--item-id` 指定時は無視する
- 並び順は CLI 仕様に従う

---

## 7. progress 更新仕様

### 7.1 目的

`progress.json` は**人間向けの現在値**を保持する。  
再実行判定の正本ではなく、可観測性のためのファイルである。

### 7.2 更新タイミング

少なくとも以下のタイミングで更新する。

- run 開始時
- task 開始時
- prompt 送信時
- model event 受信時
- task 完了時
- task 失敗時
- task スキップ時
- cache hit 時
- run 完了時

### 7.3 `progress.total` の定義

`total` は以下で定義する。

> **実行対象として確定した task instance 数**

#### 決定タイミング

- オプション解決後
- item 解決後
- task instance 生成後
- 実行開始前

#### 規則

- 実行中に `total` は変化しない
- `total` は run 内で固定値
- task 単位の部分実行時も、対象として確定した task instance のみを数える

### 7.4 `counts` の意味

| フィールド | 意味 |
|---|---|
| `completed` | 現在までに completed 済みの task instance 数 |
| `failed` | failed で停止している task instance 数 |
| `skipped` | skip または cache hit 等で未実行完了した task instance 数 |
| `running` | 現在実行中の task instance 数。通常 0 または 1 |
| `pending` | まだ未着手の task instance 数 |
| `total` | 対象として確定した総数 |

### 7.5 最小表示項目

`progress.json` は少なくとも以下を持つ。

- `runId`
- `status`
- `stage`
- `itemType`
- `currentItemId`
- `counts`
- `startedAt`
- `updatedAt`
- `elapsedSec`
- `lastEvent`
- `taskKey`
- `promptPreview`
- `note`

### 7.6 例

```json
{
  "schemaVersion": 1,
  "runId": "run_001",
  "status": "running",
  "stage": "ai.thread",
  "taskKey": "ai.extract_findings",
  "itemType": "thread",
  "currentItemId": "thread_001",
  "counts": {
    "completed": 10,
    "failed": 1,
    "skipped": 2,
    "running": 1,
    "pending": 87,
    "total": 100
  },
  "startedAt": "2026-03-26T11:00:00+09:00",
  "updatedAt": "2026-03-26T12:00:00+09:00",
  "elapsedSec": 3600,
  "lastEvent": "prompt_sent",
  "promptPreview": "会話から興味・疑問・解決を抽出",
  "note": "thread_001 を処理中"
}
```

---

## 8. イベントログ仕様

### 8.1 基本方針

`events.jsonl` は **append-only の監査・デバッグ用イベントログ** とする。  
1行1イベント JSON を追記する。

### 8.2 記録タイミング

少なくとも以下を記録する。

- run 開始
- run 再開
- task 開始
- prompt 送信
- model event 受信
- task 完了
- task 失敗
- task スキップ
- task invalidated
- cache hit
- run 完了

### 8.3 最小イベント種別

- `run_started`
- `run_resumed`
- `task_started`
- `prompt_sent`
- `model_event`
- `task_completed`
- `task_failed`
- `task_skipped`
- `task_invalidated`
- `cache_hit`
- `run_completed`

### 8.4 `task_skipped` の reason

`task_skipped` には `reason` 相当の情報を `note` に含める。

例:

- `completed_reused`
- `outside_scope`
- `retry_failed_mode`
- `no_ai_mode`
- `missing_optional_dependency`

### 8.5 例

```json
{"ts":"2026-03-26T11:00:00+09:00","type":"run_started","runId":"run_2026-03-26_001","taskKey":null,"itemId":null,"note":null,"promptPreview":null}
{"ts":"2026-03-26T11:00:01+09:00","type":"task_started","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000001","note":null,"promptPreview":null}
{"ts":"2026-03-26T11:00:02+09:00","type":"prompt_sent","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000001","note":null,"promptPreview":"会話から興味・疑問・解決を抽出"}
{"ts":"2026-03-26T11:00:10+09:00","type":"model_event","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000001","note":"reasoning","promptPreview":null}
{"ts":"2026-03-26T11:00:12+09:00","type":"task_completed","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000001","note":null,"promptPreview":null}
{"ts":"2026-03-26T11:00:12+09:00","type":"cache_hit","runId":"run_2026-03-26_001","taskKey":"ai.extract_findings","itemId":"thread_000002","note":"reused cached parsed/raw artifacts","promptPreview":null}
```

---

## 9. AIキャッシュ仕様

### 9.1 キャッシュキー

キャッシュキーは少なくとも以下を含む。

- `taskKey`
- `model`
- `promptHash`
- `inputHash`

### 9.2 保存場所

```text
cache/ai/<hash>.json
```

### 9.3 キャッシュヒット時の挙動

キャッシュヒット時は以下とする。

- AI 呼び出しをスキップする
- cache が参照する parsed / raw artifact を利用する
- task instance は `completed` として扱う
- `task-state` を更新する
- `events.jsonl` に `cache_hit` を記録する
- `progress.json` の counts / note を更新する

### 9.4 cache と task-state の関係

cache は task-state の代替ではない。  
runtime は cache hit 時も **必ず task-state を更新** する。

#### 理由

- progress が正しく進まない問題を防ぐ
- resume 判定の正本を task-state に一元化する
- cache file 単体に制御責務を持たせない

### 9.5 cache 不整合時の扱い

以下の場合は cache を利用しない。

- `cache/ai/<hash>.json` は存在するが `parsedPath` が存在しない
- `rawPath` / `parsedPath` が壊れている
- `taskKey` / `model` / `promptHash` / `inputHash` が一致しない

この場合、通常実行へフォールバックし、必要なら `task_invalidated` を記録する。

---

## 10. エラーハンドリング

### 10.1 エラー分類

| 種別 | 内容 |
|---|---|
| `transient_error` | 一時的障害 |
| `invalid_request` | 入力不正、オプション不正、解決不能 |
| `executor_error` | 外部実行基盤の失敗 |
| `manual_intervention_required` | 自動継続不可能 |
| `artifact_error` | 必須 artifact 欠落、破損、不整合 |
| `schema_error` | parse 不可、出力スキーマ不一致 |

### 10.2 再試行ルール

- `transient_error` → 自動リトライ可
- `executor_error` → 設定に応じて retry または失敗
- `invalid_request` → 即失敗
- `artifact_error` → invalidation 判定後に再実行、または失敗
- `schema_error` → raw 保持のうえ失敗、再パースまたは再実行対象

### 10.3 task 失敗時の状態

task 失敗時は最低限以下を行う。

- `task-state.status = failed`
- `error.code`, `error.message`, `error.retryable` を保存
- `events.jsonl` に `task_failed`
- `progress.json` を更新

### 10.4 run 継続可否

初版では、基本方針を以下とする。

- 必須依存 task が失敗した場合、その下流 task は実行しない
- 独立 item の失敗は他 item の継続を許容してよい
- run 最終結果は、1つでも `failed` が残れば失敗扱いとしてよい

---

## 11. 実行保証

### 11.1 冪等性

task は可能な限り冪等であることを前提とする。

- 同一 `inputHash`
- 同一 `promptHash`
- 同一 `model`
- 同一 `taskVersion`
- 同一 `outputSchemaVersion`

であれば、同一成果物を再利用可能でなければならない。

### 11.2 途中停止耐性

途中停止後も以下を保証する。

- 既存 completed 成果物の再利用可否を再判定できる
- 中断時の running を再処理できる
- events により進行状況を追跡できる

### 11.3 正本の分離

- 実行制御の正本: `task-state/*.json`
- 現在値表示: `progress.json`
- 監査・追跡: `events.jsonl`
- AI再利用: `cache/ai/*.json`

runtime はこれらの責務を混同しないこと。

---

## 12. 補足

### 12.1 初版の unitStrategy

初版は `unitStrategy = date` を前提とする。  
`date_category` / `category` は将来拡張とする。

### 12.2 初版の resume

初版では `resume` を独立コマンドにせず、`run` が自動的に resume-aware に動作する前提とする。

### 12.3 本仕様変更時の影響確認

本ドキュメント変更時は少なくとも以下を確認すること。

- `03_cli_spec.md` の優先順位・オプション挙動との整合
- `04_data_spec.md` の `task-state`, `progress.json`, `events.jsonl`, `cache/ai/*` との整合
- `02_pipeline.md` の dependsOn, itemType, unitStrategy との整合
