"""xangi-tasksの既存Notionページ連携。Python標準ライブラリのみ。"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote, urlsplit


def page_id(value):
    candidate = value.strip()
    if candidate.startswith('https://'):
        url = urlsplit(candidate)
        host = url.hostname or ''
        if not any(host == domain or host.endswith('.' + domain)
                   for domain in ('notion.so', 'notion.site', 'notion.com')):
            raise ValueError('NotionのURLを指定してください')
        candidate = url.path.rstrip('/').rsplit('/', 1)[-1]
    match = re.search(r'(?:^|-)([a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$', candidate)
    if not match:
        raise ValueError('NotionページのURLまたはIDが不正です')
    return match[1].replace('-', '').lower()


def request(cli, path, body=None):
    args = [cli, 'tool', 'extension_request', '--id', 'xangi-tasks',
            '--capability', 'xangi-tasks.manage', '--path', path]
    if body is None:
        args += ['--query-json', '{"history":"0"}']
    else:
        args += ['--method', 'PUT', '--body-json', json.dumps(body)]
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('通信タイムアウト。更新結果は未確認です。showで確認し、自動再送しないでください') from error
    if result.returncode:
        raise RuntimeError(f'拡張への要求に失敗（exit {result.returncode}）。更新結果は未確認です。接続・権限を確認してください')
    try:
        data = json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError('応答がJSONではありません。更新結果は未確認です') from error
    if not isinstance(data, dict) or data.get('error') or data.get('ok') is False:
        raise RuntimeError('拡張がエラーを返しました。更新結果は未確認です。接続・権限・対象IDを確認してください')
    task = data.get('task')
    if not isinstance(task, dict):
        raise RuntimeError('タスクを取得できません。更新結果は未確認です')
    return task


def execute(cli, action, task_id, page=None):
    if not task_id.strip() or task_id in ('.', '..') or '://' in task_id:
        raise ValueError('接続先を確認したタスクIDを指定してください（タスクURLではありません）')
    path = '/api/tasks/' + quote(task_id, safe='')
    expected = page_id(page) if action == 'link' else None
    task = request(cli, path)
    if task.get('id') != task_id:
        raise RuntimeError('取得したタスクIDが一致しません')
    if action == 'link':
        request(cli, path + '/notion', {'page': expected})
        task = request(cli, path)
        if (task.get('id') != task_id or task.get('notionPageId') != expected
                or task.get('notionPageUrl') != 'https://www.notion.so/' + expected):
            raise RuntimeError('更新後の連携先を確認できませんでした。showで確認してください')
    return {'taskId': task_id, 'title': task.get('title'), 'status': task.get('status'),
            'linked': bool(task.get('notionPageId')), 'notionPageId': task.get('notionPageId'),
            'notionPageUrl': task.get('notionPageUrl'),
            'verified': 'saved-link' if action == 'link' else 'read', 'uiVerified': False}


def main():
    parser = argparse.ArgumentParser(description='xangi-tasksのNotion連携。メモへのURL記載とは別に連携先を登録します。')
    parser.add_argument('--xangi-cli', default=os.environ.get('XANGI_CLI'),
                        help='system context指定のxangi絶対パス（または環境変数XANGI_CLI）')
    commands = parser.add_subparsers(dest='command', required=True)
    notion = commands.add_parser('notion', help='既存Notionページを連携・確認')
    actions = notion.add_subparsers(dest='action', required=True)
    link = actions.add_parser('link', help='既存ページを連携し、保存後に再取得して照合',
                              description='既存の連携先は置き換わります。ページ作成・本文編集・メモ編集は行いません。')
    link.add_argument('task_id', help='接続先を確認済みのタスクID（未エンコード）')
    link.add_argument('page', help='NotionページのHTTPS URLまたはID')
    show = actions.add_parser('show', help='保存されている連携先を確認（読み取りのみ）')
    show.add_argument('task_id', help='接続先を確認済みのタスクID（未エンコード）')
    args = parser.parse_args()
    if not args.xangi_cli or not Path(args.xangi_cli).is_absolute():
        parser.error('--xangi-cli または XANGI_CLI にxangiの絶対パスを指定してください')
    try:
        result = execute(args.xangi_cli, args.action, args.task_id, getattr(args, 'page', None))
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
