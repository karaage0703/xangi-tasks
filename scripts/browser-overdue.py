"""Verify overdue dates in the list, including the Japan date boundary."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store = new TaskStore(process.env.TEST_DATA); await store.init();
await store.create({title:'昨日', dueDate:'2026-10-27'});
await store.create({title:'今日', dueDate:'2026-10-28'});
await store.create({title:'明日', dueDate:'2026-10-29'});
await store.create({title:'期限なし'});
const closed = await store.create({title:'完了', dueDate:'2026-10-27'});
await store.complete(closed.id);
const app = createTaskServer({auth:{token:'test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server failed'
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width, theme in ((375, 'light'), (1280, 'dark')):
                    context = browser.new_context(viewport={'width':width,'height':850}, timezone_id='America/Los_Angeles', extra_http_headers={'Authorization':'Bearer test-token-with-at-least-32-characters'})
                    page = context.new_page()
                    page.clock.install(time='2026-10-27T15:00:00Z')
                    page.goto('http://127.0.0.1:'+port)
                    page.locator('#theme-select').select_option(theme)
                    yesterday = page.locator('.task-card', has=page.get_by_role('heading', name='昨日', exact=True))
                    today = page.locator('.task-card', has=page.get_by_role('heading', name='今日', exact=True))
                    tomorrow = page.locator('.task-card', has=page.get_by_role('heading', name='明日', exact=True))
                    expect(yesterday.locator('.row-due.overdue')).to_have_text('期限切れ 2026-10-27')
                    expect(yesterday.locator('.task-open')).to_have_attribute('aria-label', '昨日、期限切れ 2026-10-27、詳細を開く')
                    expect(today.locator('.row-due.overdue')).to_have_count(0)
                    expect(tomorrow.locator('.row-due.overdue')).to_have_count(0)
                    expect(page.locator('.task-card', has=page.get_by_role('heading', name='期限なし', exact=True)).locator('.row-due')).to_have_count(0)
                    page.locator('[data-filter=all]').click()
                    expect(page.locator('.task-card', has=page.get_by_role('heading', name='完了', exact=True)).locator('.row-due.overdue')).to_have_count(0)
                    if os.environ.get('OVERDUE_SCREENSHOTS'):
                        page.screenshot(path=str(Path(os.environ['OVERDUE_SCREENSHOTS']) / f'{width}-{theme}.png'))
                    page.clock.fast_forward('24:00:05')
                    expect(today.locator('.row-due.overdue')).to_have_text('期限切れ 2026-10-28')
                    expect(tomorrow.locator('.row-due.overdue')).to_have_count(0)
                    context.close()
                print('PASS: open/closed, date boundary, accessible label, light/dark, 375/1280px')
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
