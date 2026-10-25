"""Verify task creation keeps the all-category list on desktop and mobile."""
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
const category = await store.saveCollection('categories', {name:'仕事'});
await store.create({title:'分類済みタスク',categoryId:category.id});
await store.create({title:'未分類タスク'});
const app = createTaskServer({auth:{token:'test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE,text=True)
    try:
        port=server.stdout.readline().strip()
        assert port.isdigit()
        base='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
            try:
                for width in (375,1280):
                    context=browser.new_context(viewport={'width':width,'height':850},is_mobile=width==375,has_touch=width==375,extra_http_headers={'Authorization':'Bearer test-token-with-at-least-32-characters'})
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(base)
                    expect(page.locator('.task-open',has_text='分類済みタスク')).to_be_visible()
                    before=page.locator('.task-card').count()
                    page.locator('#open-create').click()
                    page.locator('#task-title').fill(f'追加タスク{width}')
                    page.locator('#task-form button[type=submit]').click()
                    expect(page.locator('#create-dialog')).not_to_be_visible()
                    expect(page.locator('#selected-category')).to_have_text('すべてのカテゴリ')
                    expect(page.locator('.task-card')).to_have_count(before+1)
                    expect(page.locator('.task-open',has_text='分類済みタスク')).to_be_visible()
                    # A deliberately selected category still follows the new task's category.
                    if width==375:page.locator('#open-categories').click()
                    page.locator('.category-choice',has_text='仕事').click()
                    expect(page.locator('#selected-category')).to_have_text('仕事')
                    page.locator('#open-create').click()
                    page.locator('#task-title').fill(f'仕事の追加{width}')
                    page.locator('#task-form button[type=submit]').click()
                    expect(page.locator('#create-dialog')).not_to_be_visible()
                    expect(page.locator('#selected-category')).to_have_text('仕事')
                    expect(page.locator('.task-open',has_text=f'仕事の追加{width}')).to_be_visible()
                    page.reload()
                    expect(page.locator('.task-open',has_text=f'仕事の追加{width}')).to_be_visible()
                    assert not errors,errors
                    context.close()
                print('PASS: 375/1280px; all-category list and selected category preserved; persisted after reload')
            finally:browser.close()
    finally:
        server.terminate();server.wait(timeout=10)
