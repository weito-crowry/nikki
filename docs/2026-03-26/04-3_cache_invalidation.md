# 04-3_cache_invalidation.md

## 1. 目的

本ドキュメントは、日記生成パイプラインにおける **AIキャッシュ**、**ハッシュ仕様**、**無効化（invalidation）条件**、**キャッシュヒット時の挙動** を定義する。

本仕様は、以下を正本として固定することを目的とする。

- `cache/ai/<hash>.json` の保存形式
- `inputHash` / `promptHash` の意味と計算対象
- `taskVersion` / `outputSchemaVersion` の役割
- cache hit 時の runtime / task-state / events / progress の更新ルール
- invalidation の判定条件
- invalidation の下流伝播との関係
- raw / parsed artifact と cache の整合要件

本ドキュメントは **再利用判定の仕様** を扱う。  
成果物 JSON 自体のスキーマ詳細は `04-1_data_artifacts.md`、  
実行状態ファイル (`task-state`, `progress.json`, `events.jsonl`) のスキーマは `04-2_execution_state.md`、  
実行フローや状態遷移の runtime 挙動は `05_runtime_spec.md` を参照する。

---

## 2. 適用範囲

本仕様が対象とするファイルおよび概念は以下である。

- `cache/ai/<hash>.json`
- `artifacts/raw/<taskKey>/<itemId>.raw.json`
- AI task の parsed artifact
- `task-state/<taskKey>__<itemId>.json` に保存される以下の項目
  - `inputHash`
  - `promptHash`
  - `model`
  - `taskVersion`
  - `outputSchemaVersion`
  - `artifactPaths`
- cache hit / invalidated に関する `events.jsonl`
- AI task 再利用時の `progress.json`

---

## 3. 設計原則

### 3.1 cache は task-state の代替ではない

cache は AI 応答の再利用手段であり、制御の正本ではない。  
再利用判定および resume 判定の正本は **task-state** とする。

### 3.2 再利用判定は意味的入力で行う

単純なファイル存在や mtime ではなく、意味的に同一であることを `inputHash` / `promptHash` / `model` / version 群で判定する。

### 3.3 raw と parsed は分離する

AI応答は以下を分離して扱う。

- raw: モデルから返った元レスポンス
- parsed: 後段が読む構造化成果物

cache は raw / parsed の参照先を保持するが、後段の通常処理は parsed を読む。

### 3.4 invalidation は skip と異なる

- `skip`: 現在条件で実行不要
- `invalidated`: 既存成果物を再利用してはならず、再計算が必要

runtime はこの2つを混同してはならない。

### 3.5 invalidation は下流へ伝播しうる

上流 task instance の成果物が再利用不可になった場合、依存する下流 task instance も再利用不可になりうる。  
伝播の runtime 規則は `05_runtime_spec.md` に従うが、本ドキュメントではその判定根拠を定義する。

---

## 4. 用語定義

| 用語 | 意味 |
|---|---|
| cache | 同一入力・同一プロンプト・同一モデル時のAI応答再利用情報 |
| cache hit | 既存 cache を用いて AI 呼び出しをスキップできる状態 |
| inputHash | モデルまたはタスクに渡す意味的入力のハッシュ |
| promptHash | プロンプト定義のハッシュ |
| taskVersion | 実行ロジックの互換性を表す版 |
| outputSchemaVersion | 出力スキーマ互換性を表す版 |
| invalidated | 既存成果物を再利用せず再実行すべき状態 |
| raw artifact | AI 元レスポンス保存ファイル |
| parsed artifact | 後段が読む構造化成果物 |

---

## 5. cache/ai の保存形式

### 5.1 パス

```text
cache/ai/<hash>.json
```

### 5.2 目的

同一入力・同一プロンプト・同一モデル時に AI 呼び出しを回避し、既存の raw / parsed artifact を再利用する。

### 5.3 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `cacheKey` | string | キャッシュキー |
| `taskKey` | string | 対象タスク |
| `model` | string | 使用モデル |
| `promptHash` | string | プロンプトハッシュ |
| `inputHash` | string | 入力ハッシュ |
| `createdAt` | string | 作成時刻 |
| `rawPath` | string | raw 応答参照パス |
| `parsedPath` | string | parsed 応答参照パス |

### 5.4 推奨追加フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `provider` | string | 例: `codex-app-server` |
| `taskVersion` | integer | ロジック版の固定化に利用 |
| `outputSchemaVersion` | integer | 出力スキーマ版の固定化に利用 |
| `note` | string \| null | 補足 |

### 5.5 例

```json
{
  "cacheKey": "sha256:cachekey...",
  "taskKey": "ai.extract_findings",
  "model": "gpt-5.4",
  "promptHash": "sha256:bbbb...",
  "inputHash": "sha256:aaaa...",
  "createdAt": "2026-03-26T12:00:12+09:00",
  "rawPath": "artifacts/raw/ai.extract_findings/thread_000001.raw.json",
  "parsedPath": "artifacts/ai/thread_findings/thread_000001.json",
  "provider": "codex-app-server",
  "taskVersion": 1,
  "outputSchemaVersion": 1
}
```

---

## 6. raw AI response の保存方針

### 6.1 パス

```text
artifacts/raw/<taskKey>/<itemId>.raw.json
```

### 6.2 目的

AI の元レスポンスを保存する。  
デバッグ、再パース、障害解析、将来の parser 改修時の再利用に用いる。

### 6.3 方針

- 構造は実行基盤依存でよい
- ただし最低限のメタは付与する
- 後段は raw を直接読まない
- 通常処理は parsed artifact を読む

### 6.4 最小例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:12+09:00",
  "runId": "run_2026-03-26_001",
  "taskKey": "ai.extract_findings",
  "itemId": "thread_000001",
  "model": "gpt-5.4",
  "provider": "codex-app-server",
  "raw": {
    "content": "..."
  }
}
```

---

## 7. ハッシュ仕様

### 7.1 基本方針

ハッシュは「ファイルが存在するか」ではなく、「再利用可能な意味的同一性」を判定するために用いる。  
mtime やファイルサイズのみで判定してはならない。

### 7.2 ハッシュ形式

- 文字列形式は `sha256:<hex>` を推奨
- 初版は SHA-256 固定でよい

---

## 8. inputHash

### 8.1 目的

処理対象の **意味的入力** が同一かどうかを判定する。

### 8.2 非AIタスクにおける inputHash

入力JSONやソース一覧の正規化文字列から計算する。

例:

- `thread-index.json`
- `units.json`
- conversations ファイル一覧
- 画像参照一覧

### 8.3 AIタスクにおける inputHash

モデルに渡す意味的入力から計算する。

例:

- `threadId`
- `title`
- `messages[].role`
- `messages[].text`
- `imageRefs` の要約
- thread findings / classification / unit membership など後段AIタスクが読む構造化入力

### 8.4 注意点

- 入力の順序が意味を持つ場合は順序を維持して正規化する
- 空配列と `null` を混同しない
- キャッシュキー生成前に正規化手順を固定する

---

## 9. promptHash

### 9.1 目的

AI task における **プロンプト定義の同一性** を判定する。

### 9.2 計算対象

以下を正規化して計算する。

- system prompt
- instruction template
- expected output schema
- parsing mode
- optional params
- 実行基盤依存の出力制約（必要であれば）

### 9.3 注意点

- 文言変更が意味を持つ場合は必ず hash を変える
- 出力 schema を変えた場合、promptHash と outputSchemaVersion の両方を見直す
- runtime 実装では promptHash の生成処理を一箇所に集約することを推奨する

---

## 10. model / provider の扱い

### 10.1 model

AI task の再利用判定には `model` を含める。  
同一 `inputHash` / `promptHash` でも `model` が異なる場合は再利用しない。

### 10.2 provider

`provider` は provenance として保存を推奨する。  
ただし初版では cache 再利用判定の必須条件とはしなくてもよい。

### 10.3 例

- `model` が `gpt-5.4` → `gpt-5.4` なら再利用候補
- `model` が `gpt-5.4` → `gpt-5-mini` に変わった場合は invalidated

---

## 11. taskVersion

### 11.1 目的

実行ロジックの互換性を表す。  
コード変更により同じ入力・同じプロンプトでも挙動が変わる場合に更新する。

### 11.2 使用場面

以下のような場合に taskVersion を上げる。

- executor の内部ロジック変更
- parser の解釈変更
- 正規化手順変更
- 後処理ロジック変更

### 11.3 規則

- 既存成果物との互換性が保てない場合は必ず更新する
- task ごとに独立して管理してよい
- cache / task-state の両方で参照可能にするのが望ましい

---

## 12. outputSchemaVersion

### 12.1 目的

出力 JSON スキーマの互換性を表す。

### 12.2 使用場面

以下のような場合に更新する。

- フィールド追加で後段互換性が崩れる
- フィールド名変更
- enum 追加/変更で解釈が変わる
- required / optional の扱い変更

### 12.3 規則

- 後段が誤読する可能性がある変更では必ず更新する
- `schemaVersion` は各成果物 JSON の版、
  `outputSchemaVersion` は task-state / runtime が再利用判定で使う版として区別する

---

## 13. task-state に保持すべき再利用判定情報

task-state には少なくとも以下を持たせる。

| フィールド | 説明 |
|---|---|
| `inputHash` | 入力の意味的同一性判定 |
| `promptHash` | プロンプト同一性判定（AI） |
| `model` | 使用モデル（AI） |
| `taskVersion` | ロジック版 |
| `outputSchemaVersion` | 出力スキーマ版 |
| `artifactPaths` | 生成成果物参照 |

### 補足

- AIを使わないタスクでは `promptHash = null`, `model = null` を許容する
- `artifactPaths` は相対パスを推奨する

---

## 14. invalidation 条件

既存成果物を再利用せず、再実行対象とする条件は以下。

### 14.1 必須 invalidation 条件

- `inputHash` 不一致
- `promptHash` 不一致（AI task）
- `model` 不一致（AI task）
- `taskVersion` 不一致
- `outputSchemaVersion` 不一致
- 依存 task instance の変更
- 必須 artifact 欠落
- cache と artifact の参照不整合

### 14.2 補足条件

以下も invalidation 根拠となりうる。

- parser 変更により parsed artifact の意味が変わる
- 上流 artifact の構造変更により後段解釈が変わる
- raw / parsed のどちらか片方のみ存在して整合が取れない

---

## 15. invalidation の伝播との関係

本ドキュメントは invalidation **条件** を定義する。  
下流への伝播そのものの runtime 規則は `05_runtime_spec.md` に従う。

ただし、次の原則を前提とする。

- 上流 task instance が invalidated になった場合、依存する下流 task instance も再利用不可になりうる
- 伝播単位は task instance 単位で扱う
- `dependsOn[]` による依存グラフを用いる

例:

- `analyze.attach_images__run` が invalidated
- 依存する `ai.extract_findings__thread_*` は invalidated 候補
- さらに依存する `ai.summarize_unit__unit_*` も invalidated 候補
- さらに `ai.write_diary_entry__entry_*` も invalidated 候補

---

## 16. cache hit 時の挙動

### 16.1 基本挙動

キャッシュヒット時は以下とする。

- AI 呼び出しをスキップする
- cache が参照する parsed / raw artifact を利用する
- task instance は `completed` として扱う
- `task-state` を更新する
- `events.jsonl` に `cache_hit` を記録する
- `progress.json` の counts / note を更新する

### 16.2 補足

cache hit は **成功済みの再利用** であり `skipped` ではない。

### 16.3 `--force` との関係

`--force` 指定時は cache を使用しない。  
強制再実行は resume 判定および cache 使用を上書きする。

---

## 17. cache と task-state の関係

cache は task-state の代替ではない。  
runtime は cache hit 時も **必ず task-state を更新** する。

### 理由

- progress が正しく進まない問題を防ぐ
- resume 判定の正本を task-state に一元化する
- cache file 単体に制御責務を持たせない

---

## 18. cache 不整合時の扱い

以下の場合は cache を利用しない。

- `cache/ai/<hash>.json` は存在するが `parsedPath` が存在しない
- `rawPath` が存在しない
- `rawPath` / `parsedPath` が壊れている
- `taskKey` / `model` / `promptHash` / `inputHash` が一致しない
- `taskVersion` / `outputSchemaVersion` が利用側期待と一致しない

この場合、通常実行へフォールバックし、必要なら `task_invalidated` を記録する。

---

## 19. cacheKey の構成推奨

キャッシュキーは少なくとも以下を含むことを推奨する。

- `taskKey`
- `model`
- `promptHash`
- `inputHash`

必要に応じて以下も含めてよい。

- `taskVersion`
- `outputSchemaVersion`
- `provider`

### 推奨方針

初版では最低構成でもよいが、将来的な誤再利用を避けるため `taskVersion` と `outputSchemaVersion` も含める設計が望ましい。

---

## 20. raw / parsed artifact の整合要件

### 20.1 原則

AI task の再利用可能性は、raw と parsed の **両方または必要十分な片方** の存在だけでなく、**後段が要求する整合性** によって決める。

### 20.2 初版推奨

- parsed artifact は必須
- raw artifact は強く推奨
- raw が欠落しても通常処理が継続できる設計なら、runtime 側で許容してよい
- ただし `cache/ai/<hash>.json` が raw を参照しているなら、参照不整合は invalidation 根拠とする

---

## 21. null / 空配列 / 空文字 の扱い

曖昧さ回避のため、以下を原則とする。

### 原則

- 不存在ではなく「存在するが空」の場合は空配列 `[]` を使う
- 不明・非適用は `null` を使う
- 空文字は「文字列型ではあるが内容なし」の場合のみ使う

### 例

- 画像が無い → `generatedImages: []`
- カテゴリが非適用 → `category: null`
- 本文が空メッセージ → `text: ""`

---

## 22. 実装上の推奨

### 22.1 hash 生成処理の共通化

`inputHash` / `promptHash` / `cacheKey` 生成は共通モジュール化することを推奨する。  
task ごとに実装が分散すると再利用判定が不安定になる。

### 22.2 cache 検証処理の独立化

以下を 1 関数にまとめることを推奨する。

- cache file 読み込み
- フィールド整合確認
- path 存在確認
- task-state と比較
- 利用可否の判定

### 22.3 ログの明示

cache 不整合や invalidation 判定時には、ユーザー向けの簡潔な理由と、events 用の機械可読な記録を分けて持つとよい。

---

## 23. 本ドキュメントと他仕様の関係

- `02_pipeline.md`
  - どの task が存在するか
  - 依存関係がどうなっているか
- `03_cli_spec.md`
  - `--force`
  - `--retry-failed`
  - cache hit の CLI 上の扱い
- `04-1_data_artifacts.md`
  - raw / parsed artifact を含む成果物スキーマ
- `04-2_execution_state.md`
  - task-state / progress / events のスキーマ
- `05_runtime_spec.md`
  - invalidation 伝播
  - cache hit 時の runtime 挙動
  - resume 判定フロー

---

## 24. まとめ

本仕様で固定する重要点は以下である。

1. 再利用判定は `inputHash` / `promptHash` / `model` / version 群で行う
2. cache は task-state の代替ではない
3. cache hit は `completed` 扱いであり `skipped` ではない
4. invalidation 条件は下流伝播の起点になりうる
5. raw / parsed / cache / task-state の整合を崩さない
