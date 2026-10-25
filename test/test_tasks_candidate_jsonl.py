import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'skills/xs-xangi-tasks/scripts/collect_candidates.py'
spec = importlib.util.spec_from_file_location('collect_candidates', SCRIPT)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class ConversationJsonlTest(unittest.TestCase):
    def test_unicode_separators_inside_content_preserve_messages_and_context(self):
        now = datetime.now(timezone.utc)
        body = '資料を\u2028確認して\u2029ください\x85。'
        rows = [
            {'id': 'user1', 'role': 'user', 'createdAt': now.isoformat(),
             'content': '[発言者: test (ID: 123)]\n[現在時刻: test]\n' + body},
            {'id': 'reply1', 'role': 'assistant', 'createdAt': now.isoformat(),
             'content': '確認\u2028完了'},
            {'id': 'user2', 'role': 'user', 'createdAt': now.isoformat(),
             'content': '[発言者: test (ID: 123)]\n[現在時刻: test]\n次の依頼'},
        ]
        for newline in ('\n', '\r\n'):
            with self.subTest(newline=repr(newline)), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'session.jsonl'
                # Include blank lines and a final record without a trailing newline.
                path.write_bytes((newline + (newline * 2).join(
                    json.dumps(row, ensure_ascii=False) for row in rows)).encode())
                sources = list(collector.conversation_sources(
                    Path(directory), '123', now - timedelta(hours=1)))
                self.assertEqual([s['text'] for s in sources], [body, '次の依頼'])
                self.assertIn('確認\u2028完了', sources[0]['context'])


if __name__ == '__main__':
    unittest.main()
