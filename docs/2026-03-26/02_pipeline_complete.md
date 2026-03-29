# 02_pipeline.md

## 1. 目的

本ドキュメントは、日記生成パイプラインの**処理構造**、**タスク分解**、**依存関係**、**入出力責務**を定義する。  
実装時に参照する正本であり、特に以下を明確化することを目的とする。

- どの Stage / Task が存在するか
- 各 Task の責務は何か
- 各 Task の入力と出力は何か
- どの Task がどの Task に依存するか
- 非AI処理とAI処理で、どの粒度で分割するか
- タスクインスタンスがどのように生成されるか

本ドキュメントは**処理構造の仕様**を扱う。  
CLI オプション、JSON スキーマ詳細、レジューム判定詳細は別ドキュメントで扱う。

---

## 2. 設計方針

### 2.1 基本方針

本パイプラインは、以下の方針で構成する。

- 非AI処理は大きめのタスク単位で扱う
- AI処理は細かいタスク単位で扱う
- 各タスクは明確な成果物（artifact）を出力する
- 後段は可能な限り前段成果物を入力として利用する
- 元データ全文の再読込・再投入は最小限に抑える
- レジュームは「途中地点から再開」ではなく「未完了または無効化されたタスクだけを再評価する」方式を前提とする

### 2.2 粒度方針

#### 非AI処理
以下は原則として粗い粒度で扱う。

- ZIP 解凍
- エクスポート構造解析
- 会話一覧の走査
- スレッド索引生成
- 正規化
- 集約単位定義
- Markdown / HTML / PDF 出力

理由は以下の通り。

- 決定的である
- コストが低い
- 失敗時の原因が比較的明確である
- 部分再実行の必要性が低い

#### AI処理
以下は原則として細かい粒度で扱う。

- カテゴリ候補生成
- スレッド分類
- 興味・疑問・解決・結末の抽出
- 単位別要約
- 日記本文生成
- 日記本文整形

理由は以下の通り。

- コストが高い
- 開発中に再実行対象が局所化しやすい
- プロンプトや出力形式の見直しが発生しやすい
- 利用枠節約のため、最小単位で再実行できる必要がある

---

## 3. パイプライン全体像

全体は以下の Stage で構成する。

```text
prepare
analyze
ai.catalog
ai.thread
ai.unit
ai.entry
render
```

各 Stage の役割は以下の通り。

| Stage | 役割 |
|---|---|
| prepare | 入力 ZIP の解凍、構造走査、索引生成 |
| analyze | 会話正規化、画像紐付け、集約単位定義 |
| ai.catalog | 全体カテゴリ候補の生成 |
| ai.thread | スレッド単位のAI抽出・分類 |
| ai.unit | unit 単位の要約生成 |
| ai.entry | 日記本文の生成・整形 |
| render | Markdown / HTML / PDF の最終出力 |

---

## 4. itemType 定義

本パイプラインでは、Task の実行対象を `itemType` で分類する。

| itemType | 意味 |
|---|---|
| run | 実行全体に対して1回だけ動くタスク |
| thread | 1スレッドごとに独立して動くタスク |
| unit | 集約単位ごとに独立して動くタスク |
| entry | 日記エントリ単位で独立して動くタスク |

### 4.1 run
単一実行全体に対して1回だけ実行される。  
例: `prepare.extract_export`

### 4.2 thread
1スレッドごとに独立実行される。  
例: `ai.extract_findings`

### 4.3 unit
日単位などの集約単位ごとに独立実行される。  
例: `ai.summarize_unit`

### 4.4 entry
最終的な日記1件ごとに独立実行される。  
例: `ai.write_diary_entry`

---

## 5. Stage 詳細

### 5.1 prepare

#### 目的
入力 ZIP を処理可能な作業状態へ変換し、後段が参照する基礎索引を生成する。

#### 特徴
- 非AI
- 粗い粒度
- run 単位中心

#### 含まれる Task
- `prepare.extract_export`
- `prepare.scan_export`
- `prepare.build_thread_index`

---

### 5.2 analyze

#### 目的
会話データを後段AI処理に適した形へ正規化し、unit 定義を構築する。

#### 特徴
- 非AI
- 粗い〜中粒度
- 初版では run 単位中心

#### 含まれる Task
- `analyze.normalize_threads`
- `analyze.attach_images`
- `analyze.group_units`

---

### 5.3 ai.catalog

#### 目的
全体カテゴリ候補を生成する。

#### 特徴
- AI
- run 単位
- 全体方針に関わるため独立タスク化する

#### 含まれる Task
- `ai.generate_category_candidates`

---

### 5.4 ai.thread

#### 目的
各スレッドから、日記生成に必要な構造化情報を抽出する。

#### 特徴
- AI
- 細粒度
- thread 単位
- 再実行需要が最も高い

#### 含まれる Task
- `ai.classify_thread`
- `ai.extract_findings`
- `ai.describe_images`（初版では任意）

---

### 5.5 ai.unit

#### 目的
複数 thread の抽出結果を束ね、日記生成前の集約要約を作る。

#### 特徴
- AI
- unit 単位
- 元会話全文ではなく thread 成果物を入力とする

#### 含まれる Task
- `ai.summarize_unit`

---

### 5.6 ai.entry

#### 目的
unit 要約から日記本文を作成し、必要に応じて整形する。

#### 特徴
- AI
- entry 単位
- 「生成」と「整形」を分離する

#### 含まれる Task
- `ai.write_diary_entry`
- `ai.rewrite_diary_entry`

---

### 5.7 render

#### 目的
構造化済み日記成果物から最終出力を生成する。

#### 特徴
- 非AI
- 粗い粒度
- run 単位中心

#### 含まれる Task
- `render.markdown`
- `render.html`
- `render.pdf`

---

## 6. Task 一覧

### 6.1 Task 定義表

| taskKey | itemType | 説明 | 主入力 | 主出力 | dependsOn |
|---|---|---|---|---|---|
| prepare.extract_export | run | ZIP を解凍し作業ディレクトリを準備する | export zip | extracted dir | - |
| prepare.scan_export | run | エクスポート構造を走査し manifest を作る | extracted dir | export manifest | prepare.extract_export |
| prepare.build_thread_index | run | スレッド一覧とメッセージ索引を作る | raw conversations | thread index | prepare.scan_export |
| analyze.normalize_threads | run | 会話を正規化し thread 単位成果物へ変換する | thread index, raw conversations | normalized threads | prepare.build_thread_index |
| analyze.attach_images | run | 画像生成物・添付画像をスレッドへ紐付ける | normalized threads, image inventory | threads with image refs | analyze.normalize_threads |
| ai.generate_category_candidates | run | 全体カテゴリ候補を生成する | normalized thread sample | categories | analyze.attach_images |
| ai.classify_thread | thread | スレッドをカテゴリ分類する | normalized thread, categories | thread classification | analyze.attach_images, ai.generate_category_candidates |
| ai.extract_findings | thread | 興味・疑問・解決・結末を抽出する | normalized thread | thread findings | analyze.attach_images |
| ai.describe_images | thread | 画像の日記向け説明を生成する | normalized thread, image refs | image notes | analyze.attach_images |
| analyze.group_units | run | 集約単位を定義する | normalized threads, thread classification | units | analyze.normalize_threads |
| ai.summarize_unit | unit | unit 単位で thread 成果物を要約する | unit definition, thread findings, thread classification | unit summary | analyze.group_units, ai.extract_findings, ai.classify_thread |
| ai.write_diary_entry | entry | unit summary から日記本文草稿を生成する | unit summary | diary draft | ai.summarize_unit |
| ai.rewrite_diary_entry | entry | 日記草稿を整形・重複除去する | diary draft | diary entry | ai.write_diary_entry |
| render.markdown | run | diary entry 群を統合して Markdown を作る | diary entries | diary.md | ai.rewrite_diary_entry |
| render.html | run | Markdown から HTML を作る | diary.md | diary.html | render.markdown |
| render.pdf | run | HTML から PDF を作る | diary.html | diary.pdf | render.html |

---

## 7. Task 詳細

### 7.1 `prepare.extract_export`

#### 役割
入力 ZIP を解凍し、作業用ディレクトリを構築する。

#### 入力
- export ZIP ファイル

#### 出力
- 解凍済みディレクトリ
- 解凍結果メタ情報

#### 備考
- run 単位
- 原則 AI 非依存
- 失敗時の再実行は単純

---

### 7.2 `prepare.scan_export`

#### 役割
解凍済みエクスポートを走査し、会話ファイル・画像ディレクトリ・添付ファイルを検出する。

#### 入力
- 解凍済みディレクトリ

#### 出力
- `export-manifest.json`
- file inventory

#### 備考
- 後続の索引生成の土台になる

---

### 7.3 `prepare.build_thread_index`

#### 役割
会話ファイルから thread と message の索引を生成する。

#### 入力
- raw conversations
- export manifest

#### 出力
- `thread-index.json`
- 必要に応じて `message-index.json`

#### 備考
- 後段が thread 単位でタスク列挙するための基礎情報

---

### 7.4 `analyze.normalize_threads`

#### 役割
会話データを後段が扱いやすい thread 単位構造へ変換する。

#### 正規化内容
- 発言順整列
- role 整理
- title 設定
- `primaryDate` 決定
- message 本文の抽出
- thread 単位ファイル化

#### 出力
- `normalized/thread_*.json`

#### 備考
- 複数日に跨るスレッドは最初の日を `primaryDate` とする

---

### 7.5 `analyze.attach_images`

#### 役割
画像生成物および添付画像を、各 thread に紐付ける。

#### 入力
- normalized threads
- image inventory

#### 出力
- 画像参照付き normalized thread

#### 備考
- 画像説明生成の前提になる

---

### 7.6 `ai.generate_category_candidates`

#### 役割
全体カテゴリ候補を生成する。

#### 入力
- representative thread sample

#### 出力
- `categories.json`

#### 備考
- 全体 run に対して1回実行で十分
- スレッドごとの分類より先に実行する

---

### 7.7 `ai.classify_thread`

#### 役割
各 thread をカテゴリ分類する。

#### 入力
- normalized thread
- categories

#### 出力
- `thread_classification/thread_*.json`

#### 備考
- thread 単位
- 再実行需要が高い
- `analyze.group_units` の前提になりうる

---

### 7.8 `ai.extract_findings`

#### 役割
各 thread から日記生成に必要な主要事実を抽出する。

#### 抽出対象
- interest
- question
- resolved
- outcome
- notable fact
- diary priority

#### 入力
- normalized thread

#### 出力
- `thread_findings/thread_*.json`

#### 備考
- 日記品質の中核
- 後段は原則この成果物だけを読む

---

### 7.9 `ai.describe_images`

#### 役割
thread に紐付く画像について日記向けメモを生成する。

#### 入力
- normalized thread
- image refs

#### 出力
- `image_notes/thread_*.json`

#### 備考
- 初版ではオプション扱い
- 画像対応を強化する際に有効

---

### 7.10 `analyze.group_units`

#### 役割
日記生成用の集約単位を定義する。

#### 初期戦略
- `date`

#### 将来拡張
- `date_category`
- `category`

#### 入力
- normalized threads
- thread classification（利用可能な場合）

#### 出力
- `units.json`
- unit membership

#### 備考
- 初版では日付単位を基本とする
- `date` 戦略では分類結果を必須としない
- `date_category` / `category` 戦略では分類結果を利用する

---

### 7.11 `ai.summarize_unit`

#### 役割
unit 内の複数 thread 成果物を束ね、unit 要約を生成する。

#### 入力
- unit definition
- thread findings
- thread classification
- image notes（利用する場合）

#### 出力
- `unit_summaries/unit_*.json`

#### 備考
- 元会話全文を再投入しない
- 上流 AI 成果物を再利用する

---

### 7.12 `ai.write_diary_entry`

#### 役割
unit summary をもとに、日記本文の草稿を生成する。

#### 入力
- unit summary

#### 出力
- `diary_drafts/entry_*.json`

#### 備考
- 1日 = 1 entry を基本とする
- 草稿生成に責務を限定する

---

### 7.13 `ai.rewrite_diary_entry`

#### 役割
草稿の整形、冗長削除、可読性向上を行う。

#### 入力
- diary draft

#### 出力
- `diary_entries/entry_*.json`

#### 備考
- 本文生成と整形を分離することで再実行範囲を局所化する

---

### 7.14 `render.markdown`

#### 役割
全 diary entry を統合し、単一の Markdown として出力する。

#### 入力
- diary entries

#### 出力
- `diary.md`

---

### 7.15 `render.html`

#### 役割
Markdown から HTML を生成する。

#### 入力
- `diary.md`

#### 出力
- `diary.html`

---

### 7.16 `render.pdf`

#### 役割
HTML から PDF を生成する。

#### 入力
- `diary.html`

#### 出力
- `diary.pdf`

---

## 8. 依存関係

### 8.1 依存関係テキスト表現

```text
prepare.extract_export
  -> prepare.scan_export
  -> prepare.build_thread_index
  -> analyze.normalize_threads
  -> analyze.attach_images

analyze.attach_images
  -> ai.generate_category_candidates
  -> ai.classify_thread (threadごと)
  -> ai.extract_findings (threadごと)
  -> ai.describe_images (threadごと, 任意)

analyze.normalize_threads
  -> analyze.group_units

ai.classify_thread + analyze.attach_images
  -> analyze.group_units（分類を利用する場合）

analyze.group_units + ai.extract_findings + ai.classify_thread (+ ai.describe_images)
  -> ai.summarize_unit (unitごと)

ai.summarize_unit
  -> ai.write_diary_entry (entryごと)
  -> ai.rewrite_diary_entry (entryごと)

ai.rewrite_diary_entry
  -> render.markdown
  -> render.html
  -> render.pdf
```

### 8.2 依存の意図

#### `ai.extract_findings` を早めに独立させる理由
後段の日記生成は thread 単位抽出結果を入力として使うため。  
これにより、同じ thread を複数回 LLM に再投入することを避ける。

#### `analyze.group_units` の依存関係
`analyze.group_units` は `analyze.normalize_threads` を必須依存とし、`ai.classify_thread` は任意依存とする。  
初版の `date` 戦略では分類なしでも成立し、将来的な `date_category` / `category` では分類結果を利用する。

#### `ai.write_diary_entry` と `ai.rewrite_diary_entry` を分離する理由
本文生成と整形は失敗・再調整パターンが異なるため。  
分離により、文体調整だけの再実行が可能になる。

---

## 9. タスクインスタンス生成ルール

### 9.1 生成順序

タスクインスタンスは以下の順で生成する。

1. run タスク生成
2. `thread-index.json` を読み込み thread item を列挙
3. thread タスクインスタンス生成
4. `units.json` を読み込み unit item を列挙
5. unit タスクインスタンス生成
6. entry item を生成
7. entry タスクインスタンス生成

### 9.2 正本ルール

- thread は `thread-index.json` を正本とする
- unit は `units.json` を正本とする
- entry は unit から決定的に生成する

### 9.3 補足

- run item は常に1件である
- thread item は `thread-index.json` の列挙結果に一致する
- unit item は `units.json` の列挙結果に一致する
- entry item は unit 戦略に応じて生成されるが、初版では `date` 単位で 1日 = 1 entry とする

---

## 10. unit 戦略

### 10.1 初版
初版は以下を採用する。

- `unitStrategy = date`

つまり、`primaryDate` ごとに 1 unit を作る。

例:

```text
unit_date_2026-03-25
unit_date_2026-03-26
```

### 10.2 将来拡張
将来的には以下を候補とする。

- `date_category`
- `category`

例:

```text
unit_date_category_2026-03-25_AI
unit_date_category_2026-03-25_開発
```

ただし初版では、複雑化を避けるため date のみを採用する。

---

## 11. タスク分割の判断基準

### 11.1 追加分割しない領域
初版では、以下のような過分割は行わない。

- `ai.extract_findings` を interest/question/resolved ごとに分離する
- `ai.summarize_unit` を highlights/questions/resolved ごとに分離する
- message 単位で AI タスク化する

理由は以下の通り。

- タスク数が過剰になる
- 実行管理コストが上がる
- 初期実装の複雑度が高すぎる

### 11.2 将来分割候補
以下の問題が顕在化した場合は再分割を検討する。

- 画像説明だけ頻繁に再実行したい
- 質問抽出だけ品質を独立改善したい
- unit 要約が大きすぎて不安定
- 日記タイトルだけ別に生成したい

---

## 12. 初版スコープ

### 12.1 初版に含める Task
以下を初版対象とする。

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

### 12.2 初版で後回しにするもの
- 画像説明強化
- category / date_category の複合 unit
- findings の更なる細分化
- 複数段階の要約戦略
- 高度な重み付けロジック

---

## 13. データフロー原則

- ai.unit は元会話を参照しない
- thread_findings を主入力とする
- 再実行は thread 単位で局所化される
- unit は thread 成果物のみを読む
- entry は unit 成果物のみを読む
- 元データの再投入はコスト最適化の観点から禁止する

---

## 14. 実装上の重要原則

1. thread成果物を最優先とする
2. unitはthread成果物のみを読む
3. entryはunit成果物のみを読む
4. 元データ再投入は禁止（コスト最適化）
5. タスクは冪等であること

---

## 15. このドキュメントの位置付け

本ドキュメントは、**パイプライン構造の正本**である。  
以下の事項は別ドキュメントで扱う。

- CLI コマンド仕様 → `03_cli_spec.md`
- JSON スキーマ詳細 → `04_data_spec.md`
- 状態遷移、レジューム、進捗、イベント → `05_runtime_spec.md`

本ドキュメント変更時は、少なくとも以下への影響確認を行うこと。

- taskKey 追加・削除による CLI 影響
- 依存関係変更による runtime 影響
- 成果物変更による data spec 影響
