# 設計 — xangi-tasks

## 責務とデータの流れ

xangi-tasksはタスク・分類・設定を保存し、xangiへ作業を依頼します。AIの応答終了とタスクの完了は別です。応答終了後もタスクはOpenに残り、本人の操作でClosedになります。

```text
ブラウザ / 同梱スキル
  → xangi-tasks API → JSON保存
  → xangi /api/sessions → /api/chat または各platformのcontinue API
```

拡張IDとcapabilityは `xangi-tasks` / `xangi-tasks.manage` です。xangiが拡張プロセスとして本体を起動し、タスクAPI・JSON保存・同期処理をそのプロセス内で実行します。内部ポートは自動割当、画面とAPIの入口はxangiのポートです。メール取得には `xangi-mail` / `xangi-mail.read` を使います。

## タスク状態と実行状態

API・保存データ・画面で同じ名前を使います。画面のAllは一覧の表示条件であり、保存する状態ではありません。

- `status: inbox`（Inbox）: 採用前の候補。実行しません。
- `status: open`（Open）: 採用済みで未完了。手入力はここから始まります。
- `status: closed`（Closed）: 完了または却下。`closedReason`で区別します。

`executionStatus`は別の項目です。InboxとClosedでは`idle`、Openでは次の値を使います。

- `idle`: 未着手。
- `working`: 本人が手動で着手。
- `delegating`: xangiへ依頼を送る準備中。
- `running`: xangiが実行中。
- `review`: AIの処理終了または送信結果が不確かなため確認待ち。
- `completing`: 会話終了の確認を伴う完了処理中。
- `failed`: 接続・送信・実行の失敗。確認して再依頼できます。

`closedReason`はClosedなら`completed`または`dismissed`、それ以外は`null`です。却下もClosedとAllに表示し、削除とは区別します。削除は`deletedAt`による非表示で、タスクの状態やxangi会話を変更しません。

```text
Inbox --open--> Open --close--> Closed (completed)
Inbox --dismiss-------------> Closed (dismissed)
Closed --open--> Open

Openの実行状態:
idle --execution/start--> working
idle / working / review / failed --delegate--> delegating → running → review / failed
working / review / failed --execution/reset--> idle
```

状態の定義・検証は`public/task-state.js`をサーバーと画面で共有します。`taskPhase`は操作可否を判定するための関数で、保存フィールドではありません。不正な状態の組合せは起動・Import時に拒否し、黙ってレコードを捨てません。

## API

- `GET /api/health`: xangi-tasksとxangiの接続状態。
- `GET /api/tasks`: 削除済み以外の全タスク。各タスクは`status`・`executionStatus`・`closedReason`を返します。
- `POST /api/tasks`: Open / idleで新規作成。
- `GET /api/inbox`: Inboxだけの一覧。
- `POST /api/inbox`: 根拠付き候補をInboxへ登録。
- `GET /api/inbox/capabilities`: `sourceKeys: true`と`statusModel: 2`を返します。
- `GET /api/tasks/:id?history=0`: 会話履歴を取得せずタスクを取得。
- `PUT /api/tasks/:id`: タイトル・説明・メモ・期限・繰り返し・カテゴリを編集。状態は専用APIで変更します。
- `POST /api/tasks/:id/open`: Inboxの採用、またはClosedの再オープン。Open / idleへ移します。
- `POST /api/tasks/:id/dismiss`: Inboxを却下。Closed / idle、理由はdismissed。
- `POST /api/tasks/:id/close`: 完了。Closed / idle、理由はcompleted。
- `POST /api/tasks/:id/execution/start`: Openをworkingへ。
- `POST /api/tasks/:id/execution/reset`: Openをidleへ。タスクの再オープンとは別の操作です。
- `POST /api/tasks/:id/delegate`: エージェントまたはProjectへ依頼。
- `POST /api/tasks/:id/sync`: 実行状態を再取得。
- `DELETE /api/tasks/:id`: 非表示化。拡張中継ではPOSTの`/delete`も使用できます。

## 会話と実行の競合

Projectなしでは選択したエージェント、ProjectありではそのProjectの担当と会話先を使います。開いた会話は再利用し、クローズ済みなら新しい会話を作ります。依頼先変更には既存会話のクローズが必要です。

通常のProject/エージェント依頼では会話IDを保存してHTTP 202を返し、画面は同じタブで会話へ移動します。202は依頼受付であり、AI処理や外部チャンネルへの投稿の完了ではありません。会話を使うタスクの完了操作はxangi側の会話を閉じません。

送信中はタスク単位のロックを保持し、早すぎる同期や二重依頼を防ぎます。遅れて届いた応答・エラーはClosedをOpenへ戻しません。再起動後は保存した実行状態を同期し、依頼本文を再送しません。

保存された会話方式が終了確認を必要とする場合は、`completing`と`completionOriginPhase`を保存します。会話が実行中なら202・`completionPending: true`を返し、同期で終了を再確認します。終了確認前はClosedにしません。この間は削除・再依頼・実行状態の手動変更を拒否します。

## 保存・繰り返し・Import

書込みはキューで直列化し、一時ファイルからatomic renameします。分類・設定はタスクJSONの`.collections.json`・`.settings.json`へ保存します。失敗時はメモリの変更も戻します。複数プロセスが同じデータを書く構成は対象外です。

繰り返しは`repeat={unit,interval,daysOfWeek}`、未指定はnullです。期限計算はJST、週は月曜始まり、月末・閏年を補正します。完了と次回Open / idleの生成を一度の保存で行い、`nextTaskId`により再完了・再オープン・次回削除後の二重生成を防ぎます。

Export形式は`xangi-tasks-backup`、`version: 2`です。候補・却下・完了を含み、削除済みと認証キーは除きます。Importは内容と現在の保存データに結び付いた確認tokenを使い、確認後の変更や実行中タスクがあれば拒否します。取り込む実行中タスクはOpen / reviewにして、自動再実行しません。

置換前にバックアップを保存し、`.import.json`を確定点としてタスク・分類・設定を反映します。途中終了は次回起動で完了させます。

## UI

Inboxはカテゴリ一覧の独立項目、通常のタブはOpen / Closed / All。詳細では状態と進捗を小さく自動表示し、どちらも選択欄は置きません。手動の着手・リセットボタンも置きません。完了と再オープンは一覧のチェック、候補の採用は詳細の「採用してOpenへ」で行えます。カテゴリ・フォルダ開閉・タブ・並び順は同じブラウザで復元します。削除されたカテゴリは全カテゴリへ戻します。

デスクトップは分類・一覧・詳細、モバイルは詳細と分類を必要時に開きます。タイトルと説明は直接編集し、メタデータは変更時に保存します。画面はxangiの配色・テーマを使い、テーマはlight / dark / systemです。タスクや分類のドラッグ移動は同じ更新APIを使い、失敗時は保存内容を再取得します。

## 候補収集とNotion

同梱スキルがxangi-mailの重要メール、本人の会話、指定Googleカレンダーを読み、原文と既存タスクを照合してInboxへ登録します。`sourceKey`で採用・却下・削除後も同じ出典の重複を防ぎます。取得失敗・判断保留は再確認対象として残し、自動承認・実行はしません。

Notion親ページ設定は`PUT /api/settings/notion`、タスク別ページは`POST/PUT /api/tasks/:id/notion`、添付は`POST /api/tasks/:id/notion/files`です。認証情報はサーバーだけで扱い、結果が不確かな作成・添付を自動再送しません。全体バックアップはNotionではなくExport / Importを使います。

一覧の選択中タブ名はタブ内だけに表示し、上の見出しにはカテゴリを12pxで表示します。タブと更新ボタンは同じ行に置きます。設定ボタンと表示テーマの文字は16pxに統一します。一覧は14pxのタイトルと44px以上の操作領域を使い、編集欄は16px・高さ44pxへ統一します。

期限とカテゴリを横並びに配置します。

Inboxはカテゴリ一覧先頭の独立した受信箱です。カテゴリの絞り込みを適用せず全候補を表示し、通常のカテゴリのOpen/Closed/Allには候補を混ぜません。候補のcategoryIdは仮分類で、変更してもInboxのままです。「採用してOpenへ」で仮分類を保持してOpenへ移ります。
