# 04-1_data_artifacts.md

## 1. 目的

本ドキュメントは、日記生成パイプラインにおける**成果物（artifact）仕様**の正本を定義する。  
対象は以下である。

- 中間成果物(JSON)
- 最終成果物（Markdown / HTML / PDF）の元となる JSON
- AI処理の parsed 成果物
- AI処理の raw 成果物

本ドキュメントは **artifact の構造と意味** を扱う。  
以下は本ドキュメントの対象外とし、別ドキュメントで扱う。

- `task-state/<taskKey>__<itemId>.json`
- `progress.json`
- `events.jsonl`
- `cache/ai/<hash>.json`
- `inputHash` / `promptHash` / invalidation 条件の詳細

本仕様の目的は以下である。

1. 実装時の成果物入出力の曖昧さを排除する
2. 後段タスクが何を入力として読むべきかを固定する
3. AI成果物を細粒度で再利用可能にする
4. 最終出力へ至る artifact 系譜を明確化する

---

## 2. 適用範囲

本ドキュメントが対象とするファイルは以下である。

- `artifacts/manifest/export-manifest.json`
- `artifacts/manifest/file-inventory.json`（任意 / 推奨）
- `artifacts/indexes/thread-index.json`
- `artifacts/indexes/message-index.json`（任意）
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

最終ファイルとして以下も生成対象に含まれるが、これらは JSON 正本ではなく最終出力である。

- `artifacts/render/diary.md`
- `artifacts/render/diary.html`
- `artifacts/render/diary.pdf`

---

## 3. 設計原則

### 3.1 すべての内部成果物は JSON を正本とする

Markdown / HTML / PDF は最終出力であり、内部処理の正本ではない。  
内部で再利用・検証・再実行に使う成果物は必ず JSON とする。

### 3.2 AI成果物は raw と parsed を分離する

AIレスポンスは以下を分離して保存する。

- raw: モデルから返った元レスポンス
- parsed: 後段が読む構造化 JSON

### 3.3 後段は上流成果物のみを読む

`unit_summary` 以降は原則として元会話全文を再読込しない。  
後段は以下を主入力とする。

- normalized thread
- thread classification
- thread findings
- image notes
- unit definitions

### 3.4 すべての AI 成果物は provenance を保持する

どの入力・どのプロンプト・どのモデルで作られた成果物か追跡可能にする。

### 3.5 スキーマ変更とロジック変更は別管理とする

本ドキュメントでは artifact の `schemaVersion` を定義する。  
`taskVersion` や invalidation 条件の詳細は別ドキュメントで扱う。

### 3.6 thread 成果物を最重要とする

本システムは thread 単位成果物を基礎に構成する。  
unit 系・entry 系は、可能な限り thread 成果物のみを入力にする。

---

## 4. 用語定義

| 用語 | 意味 |
|---|---|
| run | 1回の実行単位 |
| task | 実行可能な処理単位 |
| item | task の対象単位。`run` `thread` `unit` `entry` のいずれか |
| artifact | task が生成する成果物 |
| normalized thread | 元会話を後段処理向けに整形したスレッドJSON |
| findings | スレッドから抽出した興味・疑問・解決・結末 |
| unit | 集約単位。初期実装では主に日付単位 |
| entry | 最終日記単位。初期実装では1日1件 |
| parsed artifact | 後段が読む構造化済み AI 成果物 |
| raw artifact | 実行基盤依存の元レスポンス保存 |

---

## 5. 共通メタスキーマ

すべての成果物 JSON は、以下の共通メタフィールドを持つ。

### 5.1 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `schemaVersion` | integer | 必須 | 当該成果物スキーマの版 |
| `generatedAt` | string | 必須 | 生成時刻。ISO 8601, JST オフセット付き |
| `runId` | string | 必須 | 実行識別子 |

### 5.2 制約

- `schemaVersion >= 1`
- `generatedAt` は `YYYY-MM-DDTHH:mm:ss+09:00` を推奨
- `runId` はファイル名安全な文字列のみを使用する
- `runId` にスペース、バックスラッシュは使用しない

### 5.3 共通例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001"
}
```

---

## 6. AI共通メタスキーマ

AIを利用して生成した成果物は以下の `aiMeta` を持つ。

### 6.1 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `aiMeta.model` | string | 必須 | 使用モデルID |
| `aiMeta.promptHash` | string | 必須 | プロンプト定義のハッシュ |
| `aiMeta.inputHash` | string | 必須 | モデル投入入力のハッシュ |

### 6.2 任意フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `aiMeta.provider` | string | 任意 | 例: `codex-app-server` |
| `aiMeta.temperature` | number | 任意 | 温度パラメータ |
| `aiMeta.maxTokens` | integer | 任意 | 上限トークン |
| `aiMeta.cacheHit` | boolean | 任意 | AIキャッシュ利用有無 |

### 6.3 例

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

### 6.4 `aiMeta.cacheHit` の扱い

- 型: boolean
- `true`: キャッシュ利用
- `false`: API実行
- 初期実装では任意だが、実装段階では保存を推奨する

---

## 7. enum 定義

### 7.1 QuestionStatus

`thread_findings.questions[].status` に使用する。

| 値 | 説明 |
|---|---|
| `unresolved` | 未解決 |
| `partially_resolved` | 一部解決 |
| `resolved` | 解決済み |

### 7.2 UnitStrategy

| 値 | 説明 |
|---|---|
| `date` | 日付単位 |
| `date_category` | 日付×カテゴリ単位 |
| `category` | カテゴリ単位 |

### 7.3 ImageKind

| 値 | 説明 |
|---|---|
| `generated` | 生成画像 |
| `attachment` | 添付画像 |

---

## 8. 成果物一覧と生成元

| 成果物 | 主パス | 生成タスク | 主な用途 |
|---|---|---|---|
| export manifest | `artifacts/manifest/export-manifest.json` | `prepare.scan_export` | エクスポート全体概要 |
| file inventory | `artifacts/manifest/file-inventory.json` | `prepare.scan_export` | 走査済みファイル一覧 |
| thread index | `artifacts/indexes/thread-index.json` | `prepare.build_thread_index` | thread item 列挙 |
| message index | `artifacts/indexes/message-index.json` | `prepare.build_thread_index` | message 逆引き（任意） |
| normalized thread | `artifacts/normalized/thread_<id>.json` | `analyze.normalize_threads`, `analyze.attach_images` | 後段処理の主入力 |
| categories | `artifacts/ai/categories.json` | `ai.generate_category_candidates` | 分類候補 |
| thread classification | `artifacts/ai/thread_classification/thread_<id>.json` | `ai.classify_thread` | thread カテゴリ結果 |
| thread findings | `artifacts/ai/thread_findings/thread_<id>.json` | `ai.extract_findings` | 興味・疑問・解決・結末 |
| image notes | `artifacts/ai/image_notes/thread_<id>.json` | `ai.describe_images` | 画像説明 |
| units | `artifacts/units/units.json` | `analyze.group_units` | unit item 列挙 |
| unit summary | `artifacts/ai/unit_summaries/unit_<id>.json` | `ai.summarize_unit` | unit 要約 |
| diary draft | `artifacts/ai/diary_drafts/entry_<id>.json` | `ai.write_diary_entry` | 日記草稿 |
| diary entry | `artifacts/ai/diary_entries/entry_<id>.json` | `ai.rewrite_diary_entry` | 最終日記本文 |
| combined diary | `artifacts/render/diary.json` | `render.markdown` | レンダリング元 |
| raw ai response | `artifacts/raw/<taskKey>/<itemId>.raw.json` | 各 AI task | デバッグ・再パース用 |

---

## 9. export-manifest.json

**パス**  
`artifacts/manifest/export-manifest.json`

**生成タスク**  
`prepare.scan_export`

**目的**  
エクスポート全体の概要、ソース位置、件数を保持する。

### 9.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `exportRoot` | string | 解凍済みルート |
| `sources` | object | ソース構造情報 |
| `counts` | object | 件数統計 |

### 9.2 `sources` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `conversationsFiles` | string[] | 必須 | 会話JSONファイル一覧 |
| `dalleGenerationsDir` | string \| null | 任意 | 生成画像ディレクトリ |
| `attachmentsDir` | string \| null | 任意 | 添付ディレクトリ |

### 9.3 `counts` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `conversationFiles` | integer | 必須 | 会話ファイル数 |
| `threads` | integer | 必須 | スレッド数 |
| `messages` | integer | 必須 | メッセージ数 |
| `generatedImages` | integer | 必須 | 生成画像数 |
| `attachedImages` | integer | 必須 | 添付画像数 |

### 9.4 制約

- すべての件数は `>= 0`
- `conversationsFiles` は重複不可

### 9.5 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "exportRoot": "work/runs/run_2026-03-26_001/extracted",
  "sources": {
    "conversationsFiles": [
      "conversations-000.json",
      "conversations-001.json"
    ],
    "dalleGenerationsDir": "dalle-generations",
    "attachmentsDir": "attachments"
  },
  "counts": {
    "conversationFiles": 2,
    "threads": 2254,
    "messages": 184321,
    "generatedImages": 1187,
    "attachedImages": 525
  }
}
```

---

## 10. file-inventory.json

**パス**  
`artifacts/manifest/file-inventory.json`

**生成タスク**  
`prepare.scan_export`

**目的**  
走査時に検出したファイル一覧を保持する。`export-manifest.json` より詳細な検査・デバッグ用成果物である。

### 10.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `files` | array | 検出ファイル一覧 |

### 10.2 `files[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `path` | string | 必須 | 相対パス |
| `kind` | string | 必須 | `conversation` `generated_image` `attachment` `other` |
| `size` | integer | 必須 | バイト数 |

### 10.3 備考

- 初版では任意だが推奨する
- `prepare.scan_export` の診断性を高める

### 10.4 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "files": [
    {
      "path": "conversations-000.json",
      "kind": "conversation",
      "size": 12345678
    },
    {
      "path": "dalle-generations/img-0001.png",
      "kind": "generated_image",
      "size": 456789
    }
  ]
}
```

---

## 11. thread-index.json

**パス**  
`artifacts/indexes/thread-index.json`

**生成タスク**  
`prepare.build_thread_index`

**目的**  
スレッド一覧の最小索引を保持する。

### 11.1 `threads[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `threadId` | string | 必須 | 正規化後スレッドID |
| `sourceConversationId` | string | 必須 | 元会話ID |
| `title` | string | 必須 | スレッドタイトル |
| `startedAt` | string | 必須 | 開始時刻 |
| `lastMessageAt` | string | 必須 | 最終発言時刻 |
| `messageCount` | integer | 必須 | 総メッセージ数 |
| `userMessageCount` | integer | 必須 | user発言数 |
| `assistantMessageCount` | integer | 必須 | assistant発言数 |
| `hasGeneratedImages` | boolean | 必須 | 生成画像有無 |
| `hasAttachedImages` | boolean | 必須 | 添付画像有無 |

### 11.2 制約

- `threadId` は run 内一意
- 件数は `>= 0`
- `startedAt <= lastMessageAt`

### 11.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "threads": [
    {
      "threadId": "thread_000001",
      "sourceConversationId": "abc123",
      "title": "液晶応答速度について",
      "startedAt": "2026-03-25T21:18:00+09:00",
      "lastMessageAt": "2026-03-25T21:42:00+09:00",
      "messageCount": 14,
      "userMessageCount": 7,
      "assistantMessageCount": 7,
      "hasGeneratedImages": false,
      "hasAttachedImages": false
    }
  ]
}
```

---

## 12. message-index.json

**パス**  
`artifacts/indexes/message-index.json`

**生成タスク**  
`prepare.build_thread_index`

**目的**  
message 単位の逆引きや診断を容易にする補助索引。

### 12.1 方針

- 初版では任意
- 後段の主入力にはしない
- デバッグ・将来拡張向け

### 12.2 最小フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `messages` | array | メッセージ索引 |

| `messages[].messageId` | string | メッセージID |
| `messages[].threadId` | string | 所属 thread |
| `messages[].role` | string | `user` / `assistant` / `system` など |
| `messages[].createdAt` | string \| null | 作成時刻 |

### 12.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "messages": [
    {
      "messageId": "msg_000001",
      "threadId": "thread_000001",
      "role": "user",
      "createdAt": "2026-03-25T21:18:00+09:00"
    }
  ]
}
```

---

## 13. normalized thread

**パス**  
`artifacts/normalized/thread_<id>.json`

**生成タスク**  
`analyze.normalize_threads`  
`analyze.attach_images`

**目的**  
会話データを後段が扱いやすい thread 単位構造へ変換し、画像参照を統合した主入力成果物とする。

### 13.1 基本方針

- 1 thread = 1 JSON
- `primaryDate` をここで確定する
- 複数日に跨るスレッドも最初の日へ寄せる
- 後段は原則 `primaryDate` を信頼する

### 13.2 必須フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `threadId` | string | 必須 | 正規化後 thread ID |
| `sourceConversationId` | string | 必須 | 元会話 ID |
| `title` | string | 必須 | thread タイトル |
| `startedAt` | string | 必須 | 開始時刻 |
| `lastMessageAt` | string | 必須 | 最終発言時刻 |
| `primaryDate` | string | 必須 | 日記上の所属日。`YYYY-MM-DD` |
| `messageCount` | integer | 必須 | 総メッセージ数 |
| `messages` | array | 必須 | 正規化メッセージ列 |
| `imageRefs` | object | 必須 | 画像参照 |

### 13.3 `messages[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `messageId` | string | 必須 | メッセージID |
| `role` | string | 必須 | `user` / `assistant` / `system` など |
| `createdAt` | string \| null | 必須 | JST 文字列または `null` |
| `text` | string | 必須 | 抽出本文 |
| `attachments` | array | 必須 | 添付参照 |
| `generatedImages` | array | 必須 | 生成画像参照 |

### 13.4 `imageRefs` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `generated` | array | 必須 | thread 全体の生成画像参照 |
| `attachments` | array | 必須 | thread 全体の添付参照 |

### 13.5 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "threadId": "thread_000001",
  "sourceConversationId": "abc123",
  "title": "液晶応答速度について",
  "startedAt": "2026-03-25T21:18:00+09:00",
  "lastMessageAt": "2026-03-25T21:42:00+09:00",
  "primaryDate": "2026-03-25",
  "messageCount": 14,
  "messages": [
    {
      "messageId": "msg_0001",
      "role": "user",
      "createdAt": "2026-03-25T21:18:00+09:00",
      "text": "液晶の反応速度ってどのくらい？",
      "attachments": [],
      "generatedImages": []
    },
    {
      "messageId": "msg_0002",
      "role": "assistant",
      "createdAt": "2026-03-25T21:18:10+09:00",
      "text": "一般的には...",
      "attachments": [],
      "generatedImages": []
    }
  ],
  "imageRefs": {
    "generated": [],
    "attachments": []
  }
}
```

---

## 14. categories.json

**パス**  
`artifacts/ai/categories.json`

**生成タスク**  
`ai.generate_category_candidates`

**目的**  
全体カテゴリ候補一覧を保持する。

### 14.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `categories` | array | カテゴリ候補一覧 |

### 14.2 `categories[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `name` | string | 必須 | カテゴリ名 |
| `description` | string | 必須 | 分類方針 |

### 14.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "categories": [
    {
      "name": "AI",
      "description": "AIモデル、生成AI、推論、ツール利用に関する話題"
    },
    {
      "name": "開発",
      "description": "実装、CLI、環境構築、デバッグに関する話題"
    },
    {
      "name": "金融",
      "description": "FX、経済、相場、金利に関する話題"
    }
  ]
}
```

---

## 15. thread_classification

**パス**  
`artifacts/ai/thread_classification/thread_<id>.json`

**生成タスク**  
`ai.classify_thread`

**目的**  
各 thread のカテゴリ分類結果を保持する。

### 15.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `threadId` | string | thread ID |
| `primaryCategory` | string \| null | 主カテゴリ |
| `secondaryCategories` | array | 副カテゴリ |
| `scores` | array | 候補ごとのスコア |
| `reasonSummary` | string | 短い分類理由 |

### 15.2 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "threadId": "thread_000001",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "primaryCategory": "開発",
  "secondaryCategories": [
    {
      "name": "AI",
      "score": 0.63
    }
  ],
  "scores": [
    {
      "name": "開発",
      "score": 0.91
    },
    {
      "name": "AI",
      "score": 0.63
    }
  ],
  "reasonSummary": "CLI設計と進捗表示の改善に関する会話が中心"
}
```

---

## 16. thread_findings

**パス**  
`artifacts/ai/thread_findings/thread_<id>.json`

**生成タスク**  
`ai.extract_findings`

**目的**  
thread から興味・疑問・解決・結末を抽出した、後段の最重要成果物。

### 16.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `threadId` | string | thread ID |
| `primaryDate` | string | 日記上の所属日 |
| `title` | string | thread タイトル |
| `interests` | array | 興味対象 |
| `questions` | array | 疑問一覧 |
| `resolved` | array | 解決済み事項 |
| `outcomes` | array | 結果・結論 |
| `notableFacts` | array | 日記補助情報 |
| `hasDiaryValue` | boolean | 日記価値有無 |
| `diaryPriority` | number | 優先度 |

### 16.2 `questions[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `text` | string | 必須 | 疑問文 |
| `status` | string | 必須 | `unresolved` / `partially_resolved` / `resolved` |

### 16.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "threadId": "thread_000001",
  "primaryDate": "2026-03-25",
  "title": "液晶応答速度について",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "interests": [
    {
      "text": "液晶の応答速度と偏光制御の仕組み",
      "confidence": 0.94
    }
  ],
  "questions": [
    {
      "text": "素子単位では偏光状態と非偏光状態の切替速度はどの程度か",
      "status": "partially_resolved"
    },
    {
      "text": "光を制御するのに液晶以外で使えるものは何か",
      "status": "resolved"
    }
  ],
  "resolved": [
    {
      "question": "光を制御するのに液晶以外で使えるものは何か",
      "outcome": "電気光学変調器、MEMS、PLZT など代替方式の存在を把握",
      "confidence": 0.82
    }
  ],
  "outcomes": [
    {
      "text": "液晶の物理的な限界と代替技術の方向性を整理した",
      "confidence": 0.79
    }
  ],
  "notableFacts": [
    "ユーザーは液晶の速度を素子レベルで理解したい意図がある"
  ],
  "hasDiaryValue": true,
  "diaryPriority": 0.76
}
```

---

## 17. image_notes

**パス**  
`artifacts/ai/image_notes/thread_<id>.json`

**生成タスク**  
`ai.describe_images`

**目的**  
thread に紐づく画像について日記向け説明を保持する。

### 17.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `threadId` | string | thread ID |
| `images` | array | 画像説明一覧 |

### 17.2 `images[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `imageId` | string | 必須 | 画像識別子 |
| `kind` | string | 必須 | `generated` / `attachment` |
| `summary` | string | 必須 | 短い画像説明 |
| `diaryNote` | string | 必須 | 日記向け補足 |

### 17.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "threadId": "thread_000001",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "images": [
    {
      "imageId": "img_0001",
      "kind": "generated",
      "summary": "回路図風の図解画像を生成",
      "diaryNote": "関連する話題の補足図として画像を生成した"
    }
  ]
}
```

---

## 18. units.json

**パス**  
`artifacts/units/units.json`

**生成タスク**  
`analyze.group_units`

**目的**  
unit 一覧と membership を保持し、unit item 列挙の正本とする。

### 18.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `unitStrategy` | string | `date` / `date_category` / `category` |
| `units` | array | unit 一覧 |

### 18.2 `units[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `unitId` | string | 必須 | unit ID |
| `unitType` | string | 必須 | unit 種別 |
| `date` | string \| null | 任意 | 日付 |
| `category` | string \| null | 任意 | カテゴリ |
| `threadIds` | string[] | 必須 | 所属 thread |

### 18.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "unitStrategy": "date",
  "units": [
    {
      "unitId": "unit_date_2026-03-25",
      "unitType": "date",
      "date": "2026-03-25",
      "category": null,
      "threadIds": [
        "thread_000001",
        "thread_000002"
      ]
    }
  ]
}
```

---

## 19. unit_summary

**パス**  
`artifacts/ai/unit_summaries/unit_<id>.json`

**生成タスク**  
`ai.summarize_unit`

**目的**  
unit 内 thread 成果物を束ねた日記前段要約。

### 19.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `unitId` | string | unit ID |
| `unitType` | string | unit 種別 |
| `date` | string \| null | 日付 |
| `threadIds` | string[] | 対象 thread |
| `highlights` | array | 要点 |
| `interests` | array | 興味一覧 |
| `questions` | array | 疑問一覧 |
| `resolved` | array | 解決事項 |
| `generatedImages` | array | 画像要約 |
| `toneNotes` | array | 文体補助 |

### 19.2 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "unitId": "unit_date_2026-03-25",
  "unitType": "date",
  "date": "2026-03-25",
  "threadIds": [
    "thread_000001",
    "thread_000002"
  ],
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "highlights": [
    "液晶の応答速度と光制御方式について理解を深めた",
    "表示素子の切替速度を素子レベルで把握しようとしていた"
  ],
  "interests": [
    "液晶の物理特性",
    "光制御デバイスの代替手段"
  ],
  "questions": [
    {
      "text": "偏光状態の切替速度の理論限界はどの程度か",
      "status": "partially_resolved"
    }
  ],
  "resolved": [
    "液晶以外にも複数の光制御方式があることを整理した"
  ],
  "generatedImages": [],
  "toneNotes": [
    "技術的理解を深める目的の探索が中心"
  ]
}
```

---

## 20. diary_draft

**パス**  
`artifacts/ai/diary_drafts/entry_<id>.json`

**生成タスク**  
`ai.write_diary_entry`

**目的**  
entry 単位の日記草稿を保持する。

### 20.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `entryId` | string | entry ID |
| `date` | string | 日付 |
| `title` | string | タイトル |
| `markdown` | string | 日記草稿本文 |
| `summary` | string | 短い要約 |

### 20.2 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "entryId": "entry_2026-03-25",
  "date": "2026-03-25",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "title": "液晶の応答速度と光制御方式を整理",
  "markdown": "## 2026-03-25\n\n今日は液晶の応答速度や偏光制御について整理した。...",
  "summary": "液晶の応答速度と代替光制御方式を調べた日"
}
```

---

## 21. diary_entry

**パス**  
`artifacts/ai/diary_entries/entry_<id>.json`

**生成タスク**  
`ai.rewrite_diary_entry`

**目的**  
整形後の最終日記本文を保持する。

### 21.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `entryId` | string | entry ID |
| `date` | string | 日付 |
| `sourceDraftId` | string | 元 draft ID |
| `title` | string | タイトル |
| `markdown` | string | 最終本文 |
| `summary` | string | 短い要約 |

### 21.2 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "entryId": "entry_2026-03-25",
  "date": "2026-03-25",
  "sourceDraftId": "entry_2026-03-25",
  "aiMeta": {
    "model": "gpt-5.4",
    "promptHash": "sha256:...",
    "inputHash": "sha256:..."
  },
  "title": "液晶の応答速度と光制御方式を整理",
  "markdown": "## 2026-03-25\n\n今日は液晶の応答速度と光制御方式について集中的に確認した。...",
  "summary": "液晶の特性と代替光制御技術の理解を進めた"
}
```

---

## 22. render/diary.json

**パス**  
`artifacts/render/diary.json`

**生成タスク**  
`render.markdown`

**目的**  
全 entry を統合したレンダリング元 JSON。

### 22.1 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `entries` | array | 統合済み entry 一覧 |

### 22.2 `entries[]` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---:|---|
| `entryId` | string | 必須 | entry ID |
| `date` | string | 必須 | 日付 |
| `title` | string | 必須 | タイトル |
| `markdown` | string | 必須 | 本文 |

### 22.3 例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-26T12:00:00+09:00",
  "runId": "run_2026-03-26_001",
  "entries": [
    {
      "entryId": "entry_2026-03-25",
      "date": "2026-03-25",
      "title": "液晶の応答速度と光制御方式を整理",
      "markdown": "## 2026-03-25\n\n..."
    }
  ]
}
```

---

## 23. raw AI response

**パス**  
`artifacts/raw/<taskKey>/<itemId>.raw.json`

**生成タスク**  
各 AI task

**目的**  
AIの元レスポンス保存。

### 23.1 方針

- 構造は実行基盤依存でよい
- ただし最低限メタを付与する
- 後段は raw を読まない
- デバッグ・再パース専用

### 23.2 最小フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `taskKey` | string | 生成 taskKey |
| `itemId` | string | 対象 item |
| `model` | string | 使用モデル |
| `provider` | string \| null | 実行基盤 |
| `raw` | object | 生レスポンス本体 |

### 23.3 最小例

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

## 24. null / 空配列 / 空文字 の扱い

曖昧さ回避のため、以下を原則とする。

### 24.1 原則

- 不存在ではなく「存在するが空」の場合は空配列 `[]` を使う
- 不明・非適用は `null` を使う
- 空文字は「文字列型ではあるが内容なし」の場合のみ使う

### 24.2 例

- 画像が無い → `generatedImages: []`
- カテゴリが非適用 → `category: null`
- 本文が空メッセージ → `text: ""`

---

## 25. artifact 間の参照原則

### 25.1 後段入力の原則

- `ai.classify_thread` / `ai.extract_findings` / `ai.describe_images` は `normalized thread` を主入力とする
- `ai.summarize_unit` は `units + thread findings + thread classification (+ image notes)` を主入力とする
- `ai.write_diary_entry` は `unit summary` を主入力とする
- `ai.rewrite_diary_entry` は `diary draft` を主入力とする
- `render.markdown` は `diary entry` 群を主入力とする

### 25.2 元データ再読込の禁止原則

- `unit_summary` 以降は元会話全文を再読込しない
- raw AI response は後段の通常入力に使わない

---

## 26. 最終出力ファイル

以下は artifact ではなく最終出力であるが、パイプライン上の到達物としてここに記載する。

| ファイル | 生成タスク | 役割 |
|---|---|---|
| `artifacts/render/diary.md` | `render.markdown` | Markdown 出力 |
| `artifacts/render/diary.html` | `render.html` | HTML 出力 |
| `artifacts/render/diary.pdf` | `render.pdf` | PDF 出力 |

### 備考

- 正本は `artifacts/render/diary.json` と `artifacts/ai/diary_entries/*.json`
- `.md` / `.html` / `.pdf` は再利用より配布・閲覧を主目的とする

