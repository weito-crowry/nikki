## 1. 目的

本ドキュメントは、日記生成パイプライン CLI の実行仕様を定義する。  
ここで定義する内容は、ユーザー操作・開発時の部分実行・再実行・失敗リカバリの基準となる。

本ドキュメントは「CLI 挙動の正本」であり、以下を固定する。

- コマンド一覧
- オプション一覧
- オプションの意味と優先順位
- 実行対象の解決規則
- レジュームおよび再実行規則
- cache hit 時の扱い
- 進捗・イベント更新との関係
- エラー時の終了コード

---

## 2. 適用範囲

本仕様は以下のコマンドに適用する。

- `inspect`
- `run`

初版では `resume` を独立コマンドとしては持たず、**`run` が自動的に resume 判定を行う**。  
将来的に `resume` コマンドを追加する場合も、本仕様では `run` を正本とし、`resume` はその糖衣構文として扱う。

---

## 3. 基本方針

CLI は以下の思想で設計する。

- 実行の中心は `run` コマンドとする
- レジュームは独立コマンドではなく `run` 内で処理する
- 非AIタスクは大きめ、AIタスクは細かめに扱う
- 実行対象は task instance 単位で確定する
- `progress.json` は表示用、`task-state` は制御用とする
- `events.jsonl` は append-only とする
- `task-state` が制御の正本である

---

## 4. 前提用語

### 4.1 run

1回の実行単位。  
1つの run は、入力ZIP・出力先・実行オプション群に対応する。

### 4.2 task

実行可能な処理単位。  
例:

- `prepare.extract_export`
- `ai.extract_findings`
- `render.pdf`

### 4.3 item

task が処理対象とする個別単位。  
itemType は以下のいずれか。

- `run`
- `thread`
- `unit`
- `entry`

### 4.4 artifact

各 task の成果物ファイル。

### 4.5 task instance

`taskKey` と `itemId` の組で識別される実行対象。  
CLI が最終的に実行・skip・retry 判定を行う単位は task instance である。

### 4.6 completed / failed / invalidated

- `completed`: 正常終了済み
- `failed`: 失敗終了
- `invalidated`: 上流変更・入力差分等により再利用不可

---

## 5. コマンド一覧

| コマンド | 役割 |
|---|---|
| `inspect` | 入力エクスポートの構造確認 |
| `run` | パイプライン実行・部分実行・再実行 |

---

## 6. inspect コマンド

### 6.1 目的

入力ZIPまたは解凍済みデータの構造を確認し、実行前の妥当性チェックを行う。

### 6.2 基本形式

```bash
node src/cli.js inspect <input>
```

### 6.3 引数

| 引数 | 必須 | 内容 |
|---|---|---|
| `<input>` | 必須 | エクスポートZIPファイルまたは解凍済みディレクトリ |

### 6.4 動作

`inspect` は以下を行う。

- 入力パス存在確認
- ZIP / directory 判定
- conversations ファイル検出
- 画像ディレクトリ検出
- 基本件数集計
- 実行可能性の概況出力

### 6.5 出力

標準出力には人間向けサマリを出す。  
必要に応じて `--json` を付けた場合は JSON を返す。

### 6.6 オプション

| オプション | 内容 |
|---|---|
| `--json` | JSON形式で出力する |

### 6.7 exit code

- `0`: 正常
- `2`: 入力不正または解析不能

---

## 7. run コマンド

### 7.1 目的

パイプライン全体実行、部分実行、失敗再試行、強制再実行を行う。

### 7.2 基本形式

```bash
node src/cli.js run <input> <outputDir> [options]
```

### 7.3 必須引数

| 引数 | 必須 | 内容 |
|---|---|---|
| `<input>` | 必須 | エクスポートZIPファイルまたは解凍済みディレクトリ |
| `<outputDir>` | 必須 | run 出力先ディレクトリ |

### 7.4 基本動作

`run` は以下の順で処理する。

1. 入力を検証する
2. 出力先 run を初期化または再利用する
3. task を列挙する
4. 実行対象 item を解決する
5. task instance を生成する
6. 既存 task-state を読み込む
7. resume / skip / retry / invalidate 判定を行う
8. 対象 task を順次実行する
9. progress / events / task-state を更新する
10. 最終ステータスを出力する

---

## 8. run 対象 task 一覧

初期実装で対象とする taskKey は以下とする。

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

## 9. task ごとの itemType

| taskKey | itemType |
|---|---|
| `prepare.extract_export` | `run` |
| `prepare.scan_export` | `run` |
| `prepare.build_thread_index` | `run` |
| `analyze.normalize_threads` | `run` |
| `analyze.attach_images` | `run` |
| `ai.generate_category_candidates` | `run` |
| `ai.classify_thread` | `thread` |
| `ai.extract_findings` | `thread` |
| `analyze.group_units` | `run` |
| `ai.summarize_unit` | `unit` |
| `ai.write_diary_entry` | `entry` |
| `ai.rewrite_diary_entry` | `entry` |
| `render.markdown` | `run` |
| `render.html` | `run` |
| `render.pdf` | `run` |

---

## 10. run オプション一覧

### 10.1 実行範囲指定

| オプション | 値 | 役割 |
|---|---|---|
| `--only` | `<taskKey>` | 指定 task のみ実行する |
| `--from` | `<taskKey>` | 指定 task 以降を実行する |
| `--to` | `<taskKey>` | 指定 task までを実行する |

### 10.2 item 指定

| オプション | 値 | 役割 |
|---|---|---|
| `--item-id` | `<id>` | 特定 item のみ対象にする |
| `--date` | `YYYY-MM-DD` | 日付に対応する unit / entry / thread を対象にする |
| `--limit` | `<n>` | task ごとの最大 item 数を制限する |

### 10.3 再実行制御

| オプション | 役割 |
|---|---|
| `--retry-failed` | `failed` のみ再試行する |
| `--force` | `completed` を含めて強制再実行する |
| `--skip-completed` | `completed` を常にスキップする |

### 10.4 実行補助

| オプション | 役割 |
|---|---|
| `--group-by` | unit 戦略指定 |
| `--dry-run` | 実行せず対象 task/item のみ表示する |
| `--json` | 最終結果を JSON で出力する |
| `--verbose` | 詳細ログを表示する |

### 10.5 AI制御系（任意）

| オプション | 役割 |
|---|---|
| `--model` | AI task に用いるモデルを明示する |
| `--no-ai` | AI task を実行しない |

`--no-ai` は初版では**開発補助用途**であり、`prepare` / `analyze` / `render` のみを検証するために使用する。

---

## 11. group-by と unitStrategy の対応

CLI の `--group-by` は内部の `unitStrategy` に対応する。

| `--group-by` | `unitStrategy` |
|---|---|
| `thread-start-day` | `date` |
| `date` | `date` |
| `date-category` | `date_category` |
| `category` | `category` |

### 規則

- 指定がない場合の既定値は `thread-start-day` とする
- `thread-start-day` は「複数日に跨るスレッドを最初の日に寄せる」戦略を意味する
- 初期実装の完全対応対象は `thread-start-day` / `date` とする
- `date_category` と `category` は CLI 仕様上は予約値とする
- 未対応値を初期実装で指定した場合はエラーとする
- `analyze.group_units` の inputHash に `unitStrategy` を含める

---

## 12. オプションの優先順位

競合時の解釈順は以下とする。

### 12.1 範囲指定の優先順位

1. `--only`
2. `--from` / `--to`
3. 指定なし = 全体

#### 規則

- `--only` 指定時は `--from` / `--to` と併用不可
- `--from` のみ指定時はその task 以降すべてを対象にする
- `--to` のみ指定時は先頭からその task までを対象にする
- `--from` と `--to` を併用した場合は閉区間とする

### 12.2 item 指定の優先順位

1. `--item-id`
2. `--date`
3. `--limit`

#### 規則

- `--item-id` 指定時は単一 item を最優先対象とする
- `--date` は task の itemType および `unitStrategy` に応じて対象を解決する
- `--limit` は最終的に解決された item 列に適用する

### 12.3 再実行制御の優先順位

1. `--force`
2. `--retry-failed`
3. `--skip-completed`
4. 指定なし = 通常 resume 判定

#### 規則

- `--force` は resume 判定と cache 使用を上書きする
- `--retry-failed` は `failed` のみ対象とし、`completed` は再利用する
- `--skip-completed` は通常 resume 判定を明示的に強化する

---

## 13. 不正な組み合わせ

以下はエラーとする。

| 組み合わせ | 理由 |
|---|---|
| `--only` + `--from` | 実行範囲指定が競合する |
| `--only` + `--to` | 実行範囲指定が競合する |
| `--force` + `--retry-failed` | 再実行方針が競合する |
| `--force` + `--skip-completed` | 意味が矛盾する |
| `--item-id` + `--date` | item 解決対象が競合する |
| `--no-ai` + `--only ai.*` | 実行対象と抑止指定が矛盾する |

エラー時は以下とする。

- 標準エラーへ理由を表示
- exit code は `2`

---

## 14. run の実行対象解決手順

`run` コマンドは以下の順で実行対象を確定する。

1. task 範囲を決定する
2. itemType ごとに item を列挙する
3. `--item-id` を適用する
4. `--date` を適用する
5. `--retry-failed` / `--skip-completed` / `--force` を適用する
6. `--limit` を適用する
7. task instance 一覧を確定する

---

## 15. task instance 生成ルール

task instance は以下の順で生成する。

1. run task を生成する
2. `thread-index.json` を読み込み thread item を列挙する
3. thread task instance を生成する
4. `units.json` を読み込み unit item を列挙する
5. unit task instance を生成する
6. entry item を生成する
7. entry task instance を生成する

### 補足

- thread は `thread-index.json` を正本とする
- unit は `units.json` を正本とする
- entry は unit から決定的に生成する
- `progress.total` は **この task instance 確定後に固定する**

---

## 16. item 解決ルール

### 16.1 run

- 固定で `itemId = run`

### 16.2 thread

- `thread-index.json` を正本として列挙する

### 16.3 unit

- `units.json` を正本として列挙する

### 16.4 entry

- unit から決定的に生成する
- 初期実装では `entry_<YYYY-MM-DD>` を採用する

---

## 17. --item-id の解決規則

`--item-id` は task の `itemType` に応じて解決する。

### 例

- `thread_000123`
- `unit_date_2026-03-25`
- `entry_2026-03-25`

### 規則

- 対象 task の itemType と整合しない `itemId` はエラーとする
- 複数 task が対象で、itemType が一致しない場合はエラーとする
- 存在しない item はエラーとする

---

## 18. --date の解決規則

`--date` の解決は `unitStrategy` と task の `itemType` に依存する。

| unitStrategy | itemType | 解決方法 |
|---|---|---|
| `date` | `unit` | `unit_date_<YYYY-MM-DD>` に解決する |
| `date` | `entry` | `entry_<YYYY-MM-DD>` に解決する |
| `date` | `thread` | `primaryDate == <date>` の thread 群に解決する |
| `date` | `run` | エラーとする |
| `date_category` | `unit` | 指定日付に属する複数 unit に解決する |
| `date_category` | `entry` | 指定日付に対応する entry に解決する |
| `date_category` | `thread` | `primaryDate == <date>` の thread 群に解決する |
| `date_category` | `run` | エラーとする |
| `category` | `unit` | エラーとする |
| `category` | `entry` | エラーとする |
| `category` | `thread` | エラーとする |
| `category` | `run` | エラーとする |

### 規則

- 複数 unit が解決される場合、すべてを対象とする
- 解決結果が 0 件の場合はエラーとする
- 初期実装で未対応の `unitStrategy` が指定された場合はエラーとする

---

## 19. --limit の適用範囲

`--limit` は **task 単位** で適用する。

### 規則

- 各 task の item 列挙後に適用する
- thread / unit / entry はそれぞれ独立して制限する
- `--item-id` 指定時は `--limit` を無視する
- `run` itemType に対しては `--limit` を適用しない
- 並び順は task ごとの既定順に従う
- 初版では thread / unit / entry ともに ID 昇順または日付昇順を既定とする

### 例

`--only ai.extract_findings --limit 10` の場合:

- `ai.extract_findings` の thread item を最大 10 件まで対象にする

---

## 20. 既定挙動とレジューム規則

### 20.1 既定動作

既定では、completed かつ再利用可能な task instance は再実行しない。  
すなわち、`run` は **既定で resume-aware** とする。

### 20.2 通常時の task 実行判定

- `completed` かつ再利用可能 → skip
- `failed` → 再実行対象
- `pending` → 実行対象
- `invalidated` → 実行対象
- `running` のまま中断 → 再実行対象

### 20.3 `--retry-failed`

- `failed` の task instance のみ再試行する
- `pending` / `completed` / `invalidated` / `running中断` は対象外

### 20.4 `--force`

- 対象 task instance を status に関係なく再実行対象とする
- cache の有無にかかわらず executor を起動する

### 20.5 `--skip-completed`

- `completed` は必ず skip する
- `failed` / `pending` / `invalidated` / `running中断` のみ実行対象とする

### 20.6 resume コマンドの扱い

初版では `resume` を独立コマンドにしない。  
再開は常に `run` の既定挙動または `--retry-failed` / `--only` / `--force` によって行う。

---

## 21. `--only` の依存解決方針

初版では `--only` は **指定 task だけを対象** とし、依存 task を暗黙実行しない。  
依存 artifact が存在しない場合はエラーとする。

### 理由

- 部分実行の対象を明確にするため
- 開発中に意図しない大規模再計算を避けるため

---

## 22. `--no-ai` の扱い

`--no-ai` 指定時は以下を実行しない。

```text
ai.generate_category_candidates
ai.classify_thread
ai.extract_findings
ai.summarize_unit
ai.write_diary_entry
ai.rewrite_diary_entry
```

### 規則

- `--only ai.*` と併用不可
- 依存先が AI task のみで成立する task は実行不可とする
- `render.*` を実行するのに必要な AI成果物が無ければエラーとする
- `--model` は AI task が存在しない場合は無視する

---

## 23. cache hit の扱い

AI task においてキャッシュがヒットした場合、以下のように扱う。

- executor は起動しない
- 当該 task instance は `completed` として扱う
- `task-state` を更新する
- `events.jsonl` に `cache_hit` を記録する
- `progress.json` の counters を更新する

### 補足

- `--force` 指定時は cache を使用しない
- cache hit は「成功済みの再利用」であり `skipped` ではない

---

## 24. dry-run の仕様

### 24.1 目的

実際には実行せず、対象 task / item を確認する。

### 24.2 動作

- 入力検証を行う
- task 列挙を行う
- item 解決を行う
- task-state を参照する
- 実行予定一覧を表示する
- 実際の executor 起動は行わない
- artifact 更新は行わない
- task-state 更新は行わない
- progress 更新は行わない
- events 追記は行わない

### 24.3 出力内容

最低限以下を表示する。

- 対象 run
- 対象 task
- 対象 item 数
- `completed` / `failed` / `pending` / `invalidated` の件数
- 実行対象件数

---

## 25. 進捗表示との関係

`run` 実行時は、以下のファイルを更新対象とする。

- `progress.json`
- `events.jsonl`
- `task-state/*.json`

### 25.1 progress 更新タイミング

少なくとも以下で更新する。

- run 開始時
- run 再開判定完了時
- task 開始時
- prompt 送信時
- model event 受信時
- task 完了時
- task 失敗時
- task skip 時
- task invalidated 判定時
- run 完了時

### 25.2 progress.total の定義

`total` は以下で定義する。

> 実行対象として確定した task instance 数

#### 決定タイミング

- オプション解決後
- item 解決後
- task instance 生成後
- 実行開始前

#### 規則

- 実行中に `total` は変化しない

### 25.3 events 追記タイミング

以下を append-only で追記する。

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

---

## 26. 終了コード

| code | 意味 |
|---|---|
| `0` | 正常終了 |
| `1` | 実行中に失敗が発生 |
| `2` | CLI引数不正、入力不正、組み合わせ不正 |
| `3` | 解決対象なし |
| `4` | 依存不足 |
| `5` | 内部状態不整合 |

### 26.1 `1` を返す条件

- 少なくとも1つの task が最終的に `failed`
- 必須 artifact が生成されなかった

### 26.2 `2` を返す条件

- 入力ZIP未存在
- 不正な taskKey
- 不正なオプション組み合わせ
- 存在しない itemId
- 不正な日付形式
- 未対応 `group-by` 指定

### 26.3 `3` を返す条件

- task / item 解決後に対象が 0 件

### 26.4 `4` を返す条件

- `--only` 実行時などに必要 artifact が不足している

### 26.5 `5` を返す条件

- task-state と artifact の整合が取れない
- item 解決の正本が欠損している
- 内部的に矛盾した状態を検出した

---

## 27. 出力形式

### 27.1 人間向け標準出力

既定では、以下のような簡潔なログを出す。

```text
[run ] prepare.extract_export
[done] prepare.extract_export
[run ] ai.extract_findings thread_000123
[done] ai.extract_findings thread_000123
```

### 27.2 JSON出力

`--json` 指定時は、最終結果を JSON で返す。

例:

```json
{
  "runId": "run_2026-03-26_001",
  "status": "completed",
  "counts": {
    "completed": 120,
    "failed": 0,
    "skipped": 45
  }
}
```

詳細進捗は `progress.json` / `events.jsonl` を参照する。

---

## 28. 代表的な実行例

### 28.1 全体実行

```bash
node src/cli.js run "./export.zip" "./output/run-001"
```

### 28.2 構造確認

```bash
node src/cli.js inspect "./export.zip"
```

### 28.3 特定 task のみ

```bash
node src/cli.js run "./export.zip" "./output/run-001" --only ai.extract_findings
```

### 28.4 特定 thread のみ

```bash
node src/cli.js run "./export.zip" "./output/run-001" --only ai.extract_findings --item-id thread_000123
```

### 28.5 特定日の日記生成のみ

```bash
node src/cli.js run "./export.zip" "./output/run-001" --only ai.write_diary_entry --date 2026-03-25
```

### 28.6 失敗分のみ再試行

```bash
node src/cli.js run "./export.zip" "./output/run-001" --retry-failed
```

### 28.7 強制再実行

```bash
node src/cli.js run "./export.zip" "./output/run-001" --only ai.classify_thread --item-id thread_000123 --force
```

### 28.8 実行予定確認

```bash
node src/cli.js run "./export.zip" "./output/run-001" --only ai.summarize_unit --dry-run
```

### 28.9 非AIのみ確認

```bash
node src/cli.js run "./export.zip" "./output/run-001" --no-ai --to analyze.group_units
```

---

## 29. 実装上の拘束事項

本仕様に基づく実装では、以下を満たす必要がある。

1. `run` は task-state を必ず参照すること
2. `--only` は依存 task を自動実行しないことを既定とし、必要 artifact 不足時は失敗させること
3. `--date` 解決は task の itemType と `unitStrategy` に依存すること
4. `--force` は対象 item に対してのみ作用すること
5. `progress.json` は表示専用とし、制御の正本にしないこと
6. `events.jsonl` は append-only とすること
7. `progress.total` は task instance 確定後に固定すること
8. cache hit 時も task-state / progress / events を更新すること

---

## 30. 将来拡張

将来的に以下を追加可能とする。

- `resume` 独立コマンド
- `clean` コマンド
- `list-tasks` コマンド
- `list-items` コマンド
- `--sample latest|random|images`
- `--depends` による依存 task 自動実行
- `date_category` の完全対応
- `category` grouping の完全対応
- `watch-progress` 連携出力の整備

ただし初版では、仕様複雑化を避けるため対象外とする。

---

## 31. 仕様の決定事項まとめ

- `run` が resume-aware な主コマンドである
- `resume` は初版では独立コマンドにしない
- 非AIは粗く、AIは細かく task を切る
- `--only` は依存を自動実行しない
- `--item-id` が item 解決の最優先
- `--date` は task の itemType と `unitStrategy` に従って解決する
- `--force` と `--retry-failed` は排他
- `progress.json` は表示用、task-state が制御の正本
- `events.jsonl` は append-only
- `progress.total` は task instance 確定後に固定する
- cache hit は completed 扱いで再利用する
