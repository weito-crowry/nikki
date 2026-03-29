# 06_implementation_tasks.md

## 1. 目的

本ドキュメントは、`2026-03-26` 時点の仕様書群を、実装可能な単位のタスクへ分解したものである。  
対象仕様は以下。

- `01_overview.md`
- `02_pipeline_complete.md`
- `03_cli_spec_complete.md`
- `04_data_spec_generated.md`
- `04-1_data_artifacts.md`
- `04-2_execution_state.md`
- `04-3_cache_invalidation.md`
- `05_runtime_spec_complete.md`

本ドキュメントは以下を目的とする。

1. 現状実装と仕様との差分を明確化する
2. 実装順序を固定する
3. 各タスクの完了条件を明文化する

---

## 2. 現状実装の要約

現状の `src/cli.js` / `src/pipeline.js` では、以下はすでに実装済みである。

- `inspect` / `run` の最小 CLI
- ZIP 解凍
- 会話スレッド抽出
- AI によるカテゴリ候補生成
- AI による発言分類
- AI による単位要約
- Markdown / HTML / PDF 出力
- 単純な `progress.json` 更新
- ステップ単位の再実行スキップ

一方で、仕様との差分として以下が大きい。

- pipeline が仕様上の task instance モデルになっていない
- `artifacts/*` / `task-state/*` / `cache/ai/*` の構造が未実装
- resume が「出力ファイルの有無」でしか判定されていない
- invalidation / downstream 伝播がない
- `events.jsonl` が未実装
- CLI オプション体系が仕様未準拠
- runtime の状態遷移が未整理
- テストと検証基盤が不足している

---

## 3. 実装方針

実装は以下の順で進める。

1. データ構造と task model を先に固定する
2. その上に runtime と resume を載せる
3. CLI を runtime に合わせて整理する
4. 最後にキャッシュ、invalidations、検証を固める

理由:

- 仕様の中心は `run` コマンドではなく task instance 実行モデルにある
- CLI だけ先に増やすと、内部制御が追いつかず再設計になる
- cache / resume は artifact と state schema が固まらないと正しく実装できない

---

## 4. 実装タスク一覧

## T01. 仕様準拠のディレクトリ構成を導入する

### 目的

現状の `01-unzip` 形式中心の出力構造を、仕様上の責務別構造へ移行する。

### 実装内容

- `artifacts/`
- `task-state/`
- `cache/ai/`
- `logs/` または仕様準拠のイベント出力先
- `progress.json`
- `events.jsonl`
- `run-config.json`

を runtime 初期化時に生成する。

### 完了条件

- 新規 run で必要ディレクトリが自動生成される
- 既存 output に対する再実行でも破壊的変更なしに動作する
- 以後の処理が旧ステップディレクトリ前提でなくなる

### 依存

- なし

---

## T02. Task 定義モデルを導入する

### 目的

`02_pipeline_complete.md` に沿って、各処理を stage / taskKey / itemType / dependsOn を持つ定義として表現する。

### 実装内容

- task definition の静的定義ファイルを作る
- 非AIタスクと AI タスクを区別できるようにする
- task instance 生成器を実装する
- taskKey と itemId の命名規則を固定する

### 完了条件

- `run` 前に task definition をロードできる
- 入力データから task instance 一覧を生成できる
- 依存関係グラフを runtime が参照できる

### 依存

- T01

---

## T03. Artifact schema を実装する

### 目的

`04-1_data_artifacts.md` に定義された成果物 JSON を出力可能にする。

### 実装内容

- manifest 系 artifact の出力
- indexes 系 artifact の出力
- normalized thread / message 系 artifact の出力
- AI raw / parsed artifact の分離
- 最終 diary 用 JSON の出力

### 完了条件

- 後続タスクが中間結果を artifact から読み取れる
- 現在の `threads.json` や `unit-summaries.json` 相当の情報が仕様上の配置へ再配置される
- 各 artifact に schema version または互換性管理の足場がある

### 依存

- T01
- T02

---

## T04. Task state 永続化を実装する

### 目的

`04-2_execution_state.md` に沿って、task instance 単位の状態ファイルを持たせる。

### 実装内容

- `task-state/<taskKey>__<itemId>.json` 出力
- 状態 `pending / running / completed / failed / skipped / invalidated` の整理
- startedAt / completedAt / error / artifactPaths などの保持
- state 更新ヘルパー作成

### 完了条件

- すべての task instance が独立した状態ファイルを持つ
- step 単位ではなく item 単位で resume 判定できる
- 失敗時にどの task が落ちたか状態から分かる

### 依存

- T02
- T03

---

## T05. Progress と events の仕様準拠化

### 目的

単純な `progress.json` 上書きのみの実装を、表示用 progress と append-only event ログに分離する。

### 実装内容

- `progress.json` の表示向け集計出力
- `events.jsonl` の append-only 出力
- run start / task queued / task started / task completed / task failed / cache hit / invalidated 等のイベント記録
- app-server 進捗通知の要約記録

### 完了条件

- progress は集計用、events は監査ログ用として責務分離される
- 途中失敗時もイベント履歴が残る
- 既存の `watch-progress.ps1` が壊れないか、必要なら更新される

### 依存

- T04

---

## T06. Runtime 実行エンジンを導入する

### 目的

`05_runtime_spec_complete.md` に従い、task instance ベースで依存解決しながら実行する。

### 実装内容

- 実行対象決定ロジック
- dependsOn 解決
- 実行可能 task の列挙
- 実行ループ
- task handler の registry 化
- エラー伝播と終了コードの整理

### 完了条件

- 現在の直列 `runStep()` 依存から脱却できる
- task instance 単位で順次処理される
- runtime が task definition と task state を正として動く

### 依存

- T02
- T03
- T04
- T05

---

## T07. Resume / Re-run 判定を仕様準拠にする

### 目的

「出力ファイルがあるから skip」ではなく、状態・入力・依存関係に基づいて再開判定する。

### 実装内容

- completed task の再利用条件実装
- failed / partial 実行時の再開ロジック
- `--force` の全再実行
- taskKey / itemId 単位の部分再実行

### 完了条件

- 一部 task が失敗した output でも安全に再開できる
- 再実行時に不要 task が実行されない
- 依存先の変化がある場合は適切に再評価される

### 依存

- T04
- T05
- T06

---

## T08. CLI 仕様を整理する

### 目的

`03_cli_spec_complete.md` に合わせて CLI の引数体系と優先順位を整理する。

### 実装内容

- `inspect` / `run` の引数バリデーション強化
- config file と CLI option の優先順位整理
- 対象 task / stage 指定オプションの追加
- `--force`, `--resume` 相当の仕様反映
- 終了コード定義
- usage / help 整備

### 完了条件

- 不正なオプション組み合わせで適切なエラー終了になる
- 実行対象の絞り込みが仕様通りに動く
- README の実行例を CLI 実装に合わせて更新できる

### 依存

- T06
- T07

---

## T09. AI タスク入出力を raw / parsed / cache 対応にする

### 目的

AI 系 task を仕様上の raw artifact、parsed artifact、cache entry と整合させる。

### 実装内容

- AI 応答 raw 保存
- parsed JSON 保存
- raw と parsed の artifactPaths 連携
- JSON 解析失敗時の state / event 記録
- prompt metadata の保存

### 完了条件

- AI 由来の出力が追跡可能になる
- parsed 再生成やデバッグが可能になる
- cache 実装の前提情報が揃う

### 依存

- T03
- T04
- T06

---

## T10. AI cache を実装する

### 目的

`04-3_cache_invalidation.md` の `cache/ai/<hash>.json` を導入し、同一入力での再利用を可能にする。

### 実装内容

- `inputHash` 算出
- `promptHash` 算出
- `taskVersion` / `outputSchemaVersion` 管理
- cache hit 時の task-state / progress / events 更新
- cache save / load 実装

### 完了条件

- 同一 AI task を再実行しても再問い合わせせず再利用できる
- cache hit が event に残る
- state に再利用根拠が記録される

### 依存

- T09

---

## T11. Invalidation と downstream 伝播を実装する

### 目的

入力・プロンプト・バージョン変更時に、影響を受ける task だけを invalid にする。

### 実装内容

- invalidation 判定器
- upstream 変更検知
- downstream task の再評価対象化
- unchanged task の温存

### 完了条件

- categories が変わった場合に message categories 以降が再評価される
- summary prompt 変更時に summary 以降だけ無効化できる
- invalidated 状態が task-state / events に残る

### 依存

- T06
- T07
- T10

---

## T12. Pipeline 各 task handler を仕様に寄せる

### 目的

現在の処理本体を、仕様上の artifact / task model / state model に沿って再配置する。

### 実装内容

- unzip handler 改修
- export inspect / manifest 生成改修
- thread normalize 改修
- category candidate 生成改修
- message categorization 改修
- unit summary 生成改修
- final diary assemble 改修
- render 改修

### 完了条件

- 現在の機能を維持したまま新 runtime 上で動作する
- task handler が output path 直書きではなく runtime 管理に従う

### 依存

- T03
- T06
- T09

---

## T13. 出力フォーマットの最終仕様を固める

### 目的

Markdown / HTML / PDF 出力を overview と artifact 設計に整合させる。

### 実装内容

- 最終 diary JSON から Markdown を生成
- HTML テンプレート責務を分離
- PDF 生成失敗時の扱いを state / event に反映
- 画像埋め込み方針の整理

### 完了条件

- 最終成果物生成が task として分離される
- PDF 未生成でも run 全体の成否を仕様通り判断できる

### 依存

- T12

---

## T14. テストフィクスチャと検証基盤を追加する

### 目的

resume / cache / invalidation は手動確認だけでは壊れやすいため、自動検証を導入する。

### 実装内容

- 最小 export fixture 作成
- inspect の smoke test
- run の integration test
- resume test
- cache hit test
- invalidation test
- HTML / PDF 生成の分岐 test

### 完了条件

- 主要仕様変更時に回帰を検出できる
- 少なくとも正常系と再開系が CI 相当で確認できる

### 依存

- T08
- T10
- T11
- T13

---

## T15. 運用ドキュメントを更新する

### 目的

実装完了後に README とサンプル設定を仕様準拠へ更新する。

### 実装内容

- `README.md` 更新
- `nikki.config.example.json` 更新
- 出力例更新
- resume / cache / force の説明追加

### 完了条件

- 実装済み挙動と README の差分がなくなる

### 依存

- T08
- T13

---

## T16. 指定スレッド限定実行モードを導入する

### 目的

開発時に 2000 件超の thread 全体を毎回流すのは非現実的なため、  
指定 thread だけを安全に処理できるモードを整備する。

### 実装内容

- CLI に「対象 thread 群のみ」を明示する実行モードを追加する
- `thread` task だけでなく、その thread に必要な upstream / downstream task の扱いを整理する
- 対象 thread のみで unit / entry を再構成するか、thread 段までで止めるかを選べるようにする
- 対象外 thread を index から除外するのではなく、runtime 上の実行対象集合として制御する
- `progress.json` / `events.jsonl` に「部分実行」であることを残す
- split plan / cache / task-state が部分実行でも破綻しないことを確認する

### 完了条件

- 1 件または少数 thread を指定して、`ai.classify_thread` / `ai.extract_findings` を高速に検証できる
- 必要に応じて、その thread に関連する `unit` / `entry` だけを下流まで流せる
- 部分実行結果が full run の state / cache と競合しない
- README と設定例に開発用の部分実行方法が追記される

### 依存

- T07
- T08
- T10
- T11

### 補足設計メモ

- 最初の対象は `thread` itemType に限定する
- `--item-id` の単発再実行だけではなく、「thread 起点の部分 run」を明示的に表現する
- 初期案としては以下の 2 モードが現実的
  - `thread-only`
    - `ai.classify_thread` / `ai.extract_findings` までで止める開発モード
  - `thread-closure`
    - 指定 thread を含む unit / entry だけを下流まで流すモード
- full run 用 outputDir と分けた開発用 outputDir を推奨する

---

## 5. 推奨マイルストーン

### M1. 実行基盤の再設計

- T01
- T02
- T03
- T04
- T05
- T06

### M2. 再開と CLI の仕様準拠

- T07
- T08
- T09

### M3. キャッシュと無効化

- T10
- T11

### M4. 最終成果物と品質保証

- T12
- T13
- T14
- T15

### M5. 開発用の部分実行

- T16

---

## T17. AI 再実行最小化の増分運用モデルへ移行する

### 目的

thread 数が多い本番運用では AI 再実行コストが重すぎるため、  
既存 AI 成果物を極力温存し、新規 thread と影響範囲だけを増分処理するモデルへ移行する。

### 実装内容

- `outputDir` 単位の `category_master.json` を正式なカテゴリマスターとして運用する
- `ai.generate_category_candidates` を「毎回全体再生成」から「master 初期化 / 明示更新」へ寄せる
- `ai.classify_thread` は既存 master を基準に新規 thread を分類する
- 既存カテゴリで収まらない場合だけ新カテゴリ候補を提案し、master に追記する
- `thread classification` / `thread findings` / `unit summary` / `diary entry` を長寿命成果物として扱う
- `group_units` を全再構成ではなく、影響日または影響 unit のみ更新する
- `render` を entry の増減に応じた部分再構成へ寄せる

### 完了条件

- `targetThreadItemIds` を増やして再実行しても、既存 thread の分類・findings は原則再実行されない
- 新規 thread が属する日付の `unit` / `entry` だけ再生成される
- `category_master.json` は outputDir ごとに独立して維持される
- 新カテゴリ追加時も既存 thread 全件の再分類を要求しない

### 依存

- T10
- T11
- T16

### 補足設計メモ

- 現時点では `freezeCategories` により「カテゴリ固定」は可能
- 今後はこれを例外モードではなく通常運用へ昇格させる
- invalidation の方針は「厳密な全整合」より「既存 AI 成果物の温存」を優先する
- 完全自動追記だけではカテゴリ drift の懸念があるため、将来的には `category_suggestions.json` を併用する余地を残す

---

## 6. 実装優先順位

優先順位は以下。

1. T02 Task 定義モデル
2. T04 Task state
3. T06 Runtime 実行エンジン
4. T03 Artifact schema
5. T07 Resume / Re-run
6. T09 AI raw / parsed
7. T10 AI cache
8. T11 Invalidation
9. T08 CLI 整備
10. T12 既存 handler 移行
11. T13 出力調整
12. T14 テスト
13. T15 ドキュメント

`T01` は基盤準備のため最優先で並行実施する。

---

## 7. 最初の実装スプリント候補

最初の 1 スプリントでは以下まで進めるのが妥当。

- T01 仕様準拠ディレクトリ構成
- T02 Task 定義モデル
- T04 Task state 永続化
- T05 Progress / events
- T06 Runtime 実行エンジンの最小版

この時点では cache や invalidation は未実装でもよい。  
まず「task instance 単位で動く」「状態が残る」「途中失敗から再開できる」ことを先に成立させる。

---

## 8. 補足

現状コードはプロトタイプとしては成立しているが、仕様書群が要求しているのは「段階実行できる CLI」ではなく、  
**artifact・state・cache を正として再実行可能な pipeline runtime** である。  
そのため、今後の中心作業は個別機能の追加よりも、`src/pipeline.js` の責務分割と runtime 再構成になる。
