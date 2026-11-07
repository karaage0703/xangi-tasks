import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/xs-xangi-tasks/scripts/tasks.py'
spec = importlib.util.spec_from_file_location('tasks_notion_cli', SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
PAGE = 'a' * 32
TASK = {'id': 'task/1', 'title': '資料', 'status': 'open'}
LINKED = dict(TASK, notionPageId=PAGE, notionPageUrl='https://www.notion.so/' + PAGE)


class NotionCliTest(unittest.TestCase):
    def test_link_readback_and_encoded_path(self):
        responses = [TASK, LINKED, LINKED]
        with patch.object(cli.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0, json.dumps({'task': t})) for t in responses]) as run:
            result = cli.execute('/xangi', 'link', TASK['id'], 'https://www.notion.so/title-' + PAGE)
        self.assertEqual(result['verified'], 'saved-link')
        self.assertFalse(result['uiVerified'])
        args = run.call_args_list[1].args[0]
        self.assertEqual(args[args.index('--path') + 1], '/api/tasks/task%2F1/notion')
        self.assertEqual(json.loads(args[args.index('--body-json') + 1]), {'page': PAGE})
        self.assertEqual(run.call_count, 3)

    def test_mismatch_is_not_success(self):
        with patch.object(cli, 'request', side_effect=[TASK, LINKED, TASK]):
            with self.assertRaisesRegex(RuntimeError, '更新後'):
                cli.execute('/xangi', 'link', TASK['id'], PAGE)

    def test_wrong_task_stops_before_write(self):
        with patch.object(cli, 'request', return_value={'id': 'other'}) as request:
            with self.assertRaisesRegex(RuntimeError, 'IDが一致'):
                cli.execute('/xangi', 'link', TASK['id'], PAGE)
            self.assertEqual(request.call_count, 1)

    def test_timeout_no_retry(self):
        with patch.object(cli.subprocess, 'run', side_effect=subprocess.TimeoutExpired('xangi', 90)) as run:
            with self.assertRaisesRegex(RuntimeError, 'タイムアウト'):
                cli.request('/xangi', '/api/tasks/id/notion', {'page': PAGE})
            self.assertEqual(run.call_count, 1)

    def test_failed_responses(self):
        for code, body in [(1, 'secret'), (0, 'not-json'), (0, '{"error":"secret"}'), (0, '{}')]:
            with self.subTest(body=body), patch.object(cli.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, body)):
                with self.assertRaises(RuntimeError) as caught:
                    cli.request('/xangi', '/api/tasks/id')
                self.assertNotIn('secret', str(caught.exception))

    def test_show_readonly(self):
        with patch.object(cli, 'request', return_value=TASK) as request:
            result = cli.execute('/xangi', 'show', TASK['id'])
            self.assertFalse(result['linked'])
            request.assert_called_once_with('/xangi', '/api/tasks/task%2F1')

    def test_invalid_page_before_request(self):
        for value in ['https://notion.so.evil.test/' + PAGE, 'https://evilnotion.com/' + PAGE, 'bad']:
            with self.subTest(value=value), patch.object(cli, 'request') as request:
                with self.assertRaises(ValueError):
                    cli.execute('/xangi', 'link', TASK['id'], value)
                request.assert_not_called()

    def test_page_formats(self):
        for value in [PAGE, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'https://app.notion.com/p/' + PAGE + '?x=1#section']:
            self.assertEqual(cli.page_id(value), PAGE)

    def test_real_help_entry(self):
        result = subprocess.run(['uv', 'run', 'python', str(SCRIPT), 'notion', 'link', '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('置き換わります', result.stdout)


if __name__ == '__main__':
    unittest.main()
