# xangi拡張への登録

Node.js 22以降とWeb Chatを有効にしたxangiが必要です。xangiがxangi-tasks本体を起動・停止し、画面とAPIはxangiと同じURL・ポートから利用できます。

```bash
npm ci
cp .env.example .env # 初回のみ。接続先と保存先を設定
xangi extension link /absolute/path/to/xangi-tasks/xangi-extension.json
xangi extension start xangi-tasks
xangi extension doctor xangi-tasks
```

xangiの「拡張」からxangi-tasksを開きます。拡張の停止・再起動で本体と実行状態の同期処理も停止・再起動します。

## 接続・保存・認証

起動スクリプトはアプリルートの`.env`を読みます。xangiから引き継いだ同名の環境変数が優先されます。`XANGI_URL`で依頼先を指定し、省略時はxangiから渡される接続先を使います。`XANGI_TOKEN`または`XANGI_EVEN_TERMINAL_TOKEN`には依頼先APIの認証情報が必要です。

`XANGI_TASKS_DATA`でタスク保存先を指定します。既定はアプリルートの`.data/tasks.json`です。

拡張への認証キーはxangiが起動ごとに渡します。ブラウザにキーは渡さず、利用者の認証はxangiの入口で行います。xangi Web UIのアクセス制限を維持してください。

## コピーされたタスクを取得・更新する

ユーザーがxangi-tasksのURLを貼り付けた場合は`task`クエリからタスクIDを取得します。拡張IDは`xangi-tasks`、capabilityは`xangi-tasks.manage`です。

- 取得: `GET /api/tasks/<ID>`、query `{"history":"0"}`
- 編集: `PUT /api/tasks/<ID>`、bodyに変更する`title`、`description`、`notes`等
- 状態: `POST /api/tasks/<ID>/open`、`/close`、`/execution/start`、`/execution/reset`

`extension_request`で認証付きの経路を使います。更新後は再取得して反映を確認します。リンクだけ渡された場合はまず取得し、変更は本人の依頼に沿って行います。

## タスク操作スキルの導入

同梱の `skills/xs-xangi-tasks/` を、利用先workspaceの既存のスキル配置規則に沿って追加できます。リンクの取得・編集・完了・カテゴリ整理・エージェントへの依頼に対応します。同名スキルがある場合は差分を確認して統合してください。Codex向け索引やClaude向けリンクがあるworkspaceでは、その同期手順に従います。

「タスク用スキルを入れて」と依頼された場合は、その範囲で配置・登録・frontmatter検証まで行います。AGENTS.mdへの追記は必須ではありません。
