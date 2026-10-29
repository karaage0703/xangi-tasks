"""Verify navigation persistence using an isolated server and browser profile."""
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
const folder = await store.saveCollection('folders', {name:'Work'});
const category = await store.saveCollection('categories', {name:'Selected', folderId:folder.id});
await store.create({title:'Category task', categoryId:category.id});
await store.create({title:'Other task'});
const app = createTaskServer({auth:{token:'navigation-test-token-32-characters'},store,connector:{health:async()=>({version:'fixture'})},publicDir:process.env.TEST_PUBLIC || process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit()
        base = 'http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (1280,375):
                    context = browser.new_context(viewport={'width':width,'height':900}, extra_http_headers={'Authorization':'Bearer navigation-test-token-32-characters'})
                    page=context.new_page(); errors=[]
                    page.on('pageerror',lambda e: errors.append(str(e)))
                    page.goto(base,wait_until='networkidle')
                    def sidebar():
                        if width==375: page.locator('#open-categories').click()
                    sidebar()
                    page.get_by_role('button',name='Selected',exact=True).click()
                    expect(page.locator('.task-open')).to_have_count(1)
                    expect(page.locator('#selected-category')).to_have_text('Selected')
                    page.locator('[data-filter=all]').click()
                    page.locator('#list-options-summary').click()
                    page.locator('#task-sort').select_option('due-asc')
                    page.reload(wait_until='networkidle')
                    expect(page.locator('#selected-category')).to_have_text('Selected')
                    expect(page.locator('#task-sort')).to_have_value('due-asc')
                    page.locator('#list-options-summary').click()
                    expect(page.locator('.task-open')).to_have_count(1)
                    expect(page.locator('[data-filter=all]')).to_have_class('nav-item active')
                    sidebar()
                    page.locator('.category-folder > summary').click()
                    expect(page.locator('.category-folder')).not_to_have_attribute('open','')
                    page.wait_for_function("localStorage.getItem('tasks-closed-folders') !== null")
                    page.reload(wait_until='networkidle'); sidebar()
                    expect(page.locator('.category-folder')).not_to_have_attribute('open','')
                    page.get_by_role('button',name='未分類',exact=True).click()
                    page.reload(wait_until='networkidle')
                    expect(page.locator('#selected-category')).to_have_text('未分類')
                    page2=context.new_page();page2.goto(base,wait_until='networkidle')
                    expect(page2.locator('#selected-category')).to_have_text('未分類');page2.close()
                    page.evaluate("localStorage.setItem('tasks-category','deleted-id');localStorage.setItem('tasks-closed-folders','{broken')")
                    page.reload(wait_until='networkidle')
                    expect(page.locator('#selected-category')).to_have_text('すべてのカテゴリ')
                    expect(page.locator('.task-open')).to_have_count(2)
                    assert page.evaluate("localStorage.getItem('tasks-category')") == ''
                    sidebar();expect(page.locator('.category-folder')).to_have_attribute('open','')
                    assert not errors, errors
                    context.close()
                    print('PASS category/tab/folder reload, new page, uncategorized, deleted category, invalid storage:',width)
                context=browser.new_context(extra_http_headers={'Authorization':'Bearer navigation-test-token-32-characters'})
                context.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}})")
                page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(base,wait_until='networkidle');expect(page.locator('.task-open')).to_have_count(2)
                page.get_by_role('button',name='Selected',exact=True).click()
                expect(page.locator('.task-open')).to_have_count(1)
                assert not errors, errors
                context.close();print('PASS blocked localStorage')
            finally:
                browser.close()
    finally:
        server.terminate();server.wait(timeout=10)
