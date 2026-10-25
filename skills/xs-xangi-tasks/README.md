# xangi-tasksスキル

タスクのリンクをxangiへ貼り付けて、内容の確認、追加、編集、完了、カテゴリ整理、エージェントへの依頼を行えます。

「このタスクを見て」「メモに追記して」「調査エージェントに任せて」のように依頼してください。詳しい手順は[SKILL.md](SKILL.md)を参照。

登録・起動済みのxangi-tasks拡張と、`extension_request`が使えるxangiが必要です。CLIの場所は利用するインスタンスのsystem contextに合わせます。Project連携APIは対応版のxangi-tasksとxangi本体が必要です。Projectに設定されたDiscord・Slackのチャンネルへ依頼を送れます。結果はxangiの会話リンクから確認します。開いた会話は再利用し、クローズ後の依頼は新しい会話になります。

接続エラー時は拡張の登録・起動とxangi-tasks本体を確認してください。リンクの接続先と、利用中のxangiが接続するxangi-tasksが異なる場合は、その接続先で操作します。

構成は同梱スキルを配布する[xangi-search](https://github.com/karaage0703/xangi-search)を参考にしています。登録済みエージェントを選択して実行する流れは[xangi-mail](https://github.com/karaage0703/xangi-mail)に合わせています。

## 候補の収集

「重要メール・会話・カレンダーから候補を拾って」で、原文を確認して候補を追加できます。xangi-mailは任意です。xangi-mailがない環境では本人の会話だけを使えます。カレンダーも単独で利用でき、認証済みgogcliと対象アカウント・カレンダーのJSON設定が必要です。予定の準備・締切などを候補としてInboxに追加します。会話の自動収集はplatformの本人ID付きログが対象です。

Python標準ライブラリとuv、認証済みのxangi CLIを使います。collect_candidates.pyのcollectで材料を保存し、スキルが判断したJSONをapplyへ渡します。候補化する判断をスクリプトのキーワード判定で代用しません。定期実行の設定例・出典重複防止・失敗時の再開は[候補収集手順](references-candidates.md)を参照してください。

状態ファイルとスナップショットには私的な内容を含むため非公開directoryに保存します。xangi-tasksの状態モデル2・sourceKey対応版が必要で、メールを読む場合はxangi-mailの取得APIも必要です。旧版・認証失敗では停止し、タスクの直接未実施登録へ迂回しません。
