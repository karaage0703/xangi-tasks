"""Capture the real UI with fictional tasks in a temporary, isolated store.

Run: uv run --with playwright python scripts/readme-screenshots.py
"""
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs' / 'images'
TOKEN = 'readme-fixture-token-not-a-real-credential'
FIXTURE = r"""
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2030-04-15T00:00:00Z'])); }
  static now() { return new RealDate('2030-04-15T00:00:00Z').getTime(); }
};
const store = new TaskStore(process.env.README_DATA);
await store.init();
const work = await store.saveCollection('folders', {name: 'つくる'});
const life = await store.saveCollection('folders', {name: '暮らし'});
const project = await store.saveCollection('categories', {name: 'ノートアプリ', folderId: work.id});
const ideas = await store.saveCollection('categories', {name: 'アイデア', folderId: work.id});
const personal = await store.saveCollection('categories', {name: '日々のこと', folderId: life.id});
const featured = await store.create({
  title: 'ノートアプリの使い方をまとめる', categoryId: project.id,
  description: '初めて使う人が、最初のノートを保存できるまでの手順をまとめる。\n\n・ノートの作成と保存を説明する\n・画面例を添える\n・公開前に手順をひと通り試す',
  notes: '作成 → 編集 → 保存の順で説明する。\n専門用語はできるだけ使わない。',
  targetDate: '2030-04-15', deadlineAt: '2030-04-18', deadlineStatus: 'confirmed',
  deadlineEvidence: '架空プロジェクトの公開予定日',
});
// Stable demo ID keeps the detail screenshot independent of generated UUIDs.
await store.update(featured.id, {id: 'demo-note-guide'});
await store.create({title: '検索画面の見やすさを確認する', categoryId: project.id, targetDate: '2030-04-16'});
await store.create({title: '週末につくるものを考える', categoryId: ideas.id, targetDate: '2030-04-17'});
await store.create({title: '読書メモを整理する', categoryId: personal.id, targetDate: '2030-04-19'});
await store.create({title: '写真のバックアップを確認する', categoryId: personal.id, targetDate: '2030-04-20'});
await store.create({title: '次に試したいアイデアをメモする', categoryId: ideas.id});
await store.createInboxItem({title: '新しいアイコンの案を考える', sourceText: '架空の打ち合わせメモからの候補です。'});
const done = await store.create({title: 'ノート一覧のレイアウトを整える', categoryId: project.id});
await store.complete(done.id);
const app = createTaskServer({
  store, publicDir: process.cwd() + '/public', auth: {token: process.env.README_TOKEN},
  connector: {health: async () => ({version: 'demo'}), readHistory: async () => []},
});
// No poller, real xangi connector, Notion client, or external services.
app.server.listen(0, '127.0.0.1', () => console.log(app.server.address().port));
"""


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tasks-readme-') as data:
        server = subprocess.Popen(
            ['node', '--input-type=module', '-e', FIXTURE], cwd=ROOT,
            env={**os.environ, 'README_DATA': str(Path(data) / 'tasks.json'), 'README_TOKEN': TOKEN},
            stdout=subprocess.PIPE, text=True,
        )
        try:
            port = server.stdout.readline().strip()
            assert port.isdigit(), 'Fixture server did not start'
            base = f'http://127.0.0.1:{port}'
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    executable_path=os.environ.get('BROWSER_EXECUTABLE', '/snap/bin/chromium'),
                    args=['--no-sandbox', '--lang=ja-JP'],
                    env={**os.environ, 'LANG': 'ja_JP.UTF-8', 'LC_ALL': 'ja_JP.UTF-8'},
                )
                try:
                    for name, width, height in [('desktop', 1440, 960), ('mobile', 390, 844)]:
                        context = browser.new_context(
                            viewport={'width': width, 'height': height}, device_scale_factor=1,
                            locale='ja-JP', timezone_id='Asia/Tokyo', color_scheme='light',
                            extra_http_headers={'Authorization': f'Bearer {TOKEN}'},
                        )
                        # Fail on unexpected outbound traffic or browser errors.
                        external, errors = [], []

                        def local_only(route):
                            if route.request.url.startswith(base + '/'):
                                route.continue_()
                            else:
                                external.append(route.request.url)
                                route.abort()

                        context.route('**/*', local_only)
                        page = context.new_page()
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.clock.set_fixed_time(datetime(2030, 4, 15, tzinfo=timezone.utc))
                        page.goto(base, wait_until='networkidle')
                        expect(page.locator('.task-card')).to_have_count(6)
                        expect(page.locator('#count-open')).to_have_text('6')
                        expect(page.locator('#count-closed')).to_have_text('1')
                        if name == 'desktop':
                            page.locator('.task-open[data-id="demo-note-guide"]').click()
                            expect(page.locator('#detail-title')).to_have_value('ノートアプリの使い方をまとめる')
                            expect(page.locator('#quick-edit [name="targetDate"]')).to_have_value('2030-04-15')
                            expect(page.locator('#quick-edit [name="deadlineAt"]')).to_have_value('2030-04-18')
                            expect(page.locator('#detail-notes')).to_have_value('作成 → 編集 → 保存の順で説明する。\n専門用語はできるだけ使わない。')
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
                        page.evaluate('document.fonts.ready')
                        page.screenshot(path=str(OUTPUT / f'tasks-{name}.png'), animations='disabled')
                        assert not errors, errors
                        assert not external, external
                        print(f'PASS {name}: {width}x{height}, real UI, 6 open / 1 closed, no browser errors or external requests')
                        context.close()
                finally:
                    browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
