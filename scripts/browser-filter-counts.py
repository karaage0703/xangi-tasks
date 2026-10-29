"""Check that tab counts use the same category filter and exclude Inbox candidates as the list."""
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
const category = await store.saveCollection('categories', {name:'音声配信'});
await store.create({title:'他のカテゴリ'});
await store.create({title:'音声の対象', categoryId:category.id});
const closed = await store.create({title:'音声の完了', categoryId:category.id});
await store.complete(closed.id);
await store.createInboxItem({title:'分類済みの候補', sourceText:'候補を確認', categoryId:category.id});
await store.createInboxItem({title:'未分類の候補', sourceText:'未分類を確認'});
const app = createTaskServer({auth:{token:'test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server failed'
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (375, 1280):
                    context = browser.new_context(viewport={'width':width,'height':850}, extra_http_headers={'Authorization':'Bearer test-token-with-at-least-32-characters'})
                    page = context.new_page()
                    page.goto('http://127.0.0.1:'+port)
                    expect(page.locator('#count-open')).to_have_text('2')
                    if width == 375: page.locator('#open-categories').click()
                    page.locator('.category-choice', has_text='音声配信').click()
                    expect(page.locator('#count-open')).to_have_text('1')
                    expect(page.locator('#count-closed')).to_have_text('1')
                    expect(page.locator('#count-all')).to_have_text('2')
                    expect(page.locator('.task-card')).to_have_count(1)
                    page.locator('[data-filter=closed]').click()
                    expect(page.locator('.task-card')).to_have_count(1)
                    page.reload()
                    expect(page.locator('#count-open')).to_have_text('1')
                    expect(page.locator('#count-closed')).to_have_text('1')
                    expect(page.locator('#count-all')).to_have_text('2')
                    expect(page.locator('#label-filter')).to_have_count(0)
                    if width == 375: page.locator('#open-categories').click()
                    page.locator('#inbox-view').click()
                    expect(page.locator('.task-card')).to_have_count(2)
                    expect(page.locator('.filters')).to_be_hidden()
                    if width == 375: page.locator('#open-categories').click()
                    page.get_by_role('button', name='未分類', exact=True).click()
                    expect(page.locator('#count-open')).to_have_text('1')
                    expect(page.locator('#count-closed')).to_have_text('0')
                    expect(page.locator('#count-all')).to_have_text('1')
                    expect(page.locator('.task-card')).to_have_count(1)
                    context.close()
                print('PASS: category, status, reload and independent Inbox at 375/1280px')
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
