日本語 | [English](README.en.md)

# xangi-tasks

タスクを整理し、必要に応じてxangiへ仕事を依頼できるタスクアプリです。

- Inboxで候補を確認し、Openで未完了、Closedで完了したタスクを管理
- タスク名を押して詳細・操作を表示
- タスクからxangiへ依頼し、リンク先の会話で結果の確認や追加相談
- カテゴリ・タスク・設定をJSONでExport / Import

## はじめる

Node.js 22以降と、Web Chatを有効にしたxangiが必要です。

```bash
npm ci
cp .env.example .env
# .envのXANGI_URL・XANGI_TOKENを設定
xangi extension link /absolute/path/to/xangi-tasks/xangi-extension.json
xangi extension start xangi-tasks
```

xangiの「拡張」からxangi-tasksを開きます。

## ドキュメント

- [使い方・設定・動作確認](docs/usage.md)
- [設計・API](docs/design.md)

## ライセンス

[MIT](LICENSE)
