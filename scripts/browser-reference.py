"""Isolated UI verification: uv run --with playwright python scripts/browser-sidebar.py."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
output = Path(os.environ.get('TEST_ARTIFACTS', '/tmp/tasks-sidebar-artifacts'))
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store = new TaskStore(process.env.TEST_DATA); await store.init();
await store.create({title:'仕様をまとめる', description:'詳細を見ながら一覧を操作する'});
await store.create({title:'次の作業を確認する'});
const app = createTaskServer({auth:{token:'sidebar-test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'}),readHistory:async()=>[]},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA': str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server did not start'
        base = 'http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (1280, 375):
                    context=browser.new_context(viewport={'width':width,'height':900}, permissions=['clipboard-read','clipboard-write'], extra_http_headers={'Authorization':'Bearer sidebar-test-token-with-at-least-32-characters'})
                    page=context.new_page()
                    errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto(base,wait_until='networkidle')
                    expect(page.locator('[data-filter=running]')).to_have_count(0)
                    expect(page.locator('[data-filter=inbox]')).to_be_visible()
                    created=page.request.post(base+'/api/inbox',data={'title':f'候補テスト{width}', 'sourceText':'候補の根拠'})
                    assert created.ok
                    candidate_id=created.json()['task']['id']
                    page.locator('#refresh').click()
                    page.locator('[data-filter=inbox]').click()
                    expect(page.locator('#count-inbox')).to_have_text('1')
                    expect(page.locator('.task-open')).to_have_count(1)
                    page.locator('.task-open').click()
                    expect(page.locator('#detail-source-text')).to_have_text('候補の根拠')
                    page.locator('[data-action=open]').click()
                    expect(page.locator('#count-inbox')).to_have_text('0')
                    assert page.request.get(base+'/api/tasks/'+candidate_id+'?history=0').json()['task']['status']=='open'
                    page.locator('#close-detail').click()
                    page.reload(wait_until='networkidle')
                    page.locator('[data-filter=inbox]').click()
                    expect(page.locator('#empty-state')).to_be_visible()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(output/f'candidates-{width}.png'),full_page=True)
                    page.locator('[data-filter=open]').click()
                    page.locator('.task-open').first.click()
                    task_id=page.locator('.task-card.selected').get_attribute('data-id')
                    expect(page.locator('#message-form, #conversation')).to_have_count(0)
                    expect(page.locator('[data-action=copy-id]')).to_have_count(0)
                    page.locator('[data-action=copy-link]').click()
                    link=page.evaluate('navigator.clipboard.readText()')
                    assert '?task='+task_id in link
                    page.request.post(base+'/api/tasks/'+task_id+'/close',data={})
                    page.goto(link,wait_until='networkidle')
                    expect(page.locator('#task-dialog')).to_be_visible()
                    expect(page.locator('#detail-session')).to_have_text('ID: '+task_id)
                    page.locator('#detail-notes').fill('xangiから取得できるメモ')
                    page.locator('#detail-title').click()
                    expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                    response=page.request.get(base+'/api/tasks/'+task_id+'?history=0')
                    assert response.json()['task']['notes']=='xangiから取得できるメモ'
                    response=page.request.put(base+'/api/tasks/'+task_id,data={'notes':'APIで更新'})
                    assert response.ok
                    page.reload(wait_until='networkidle')
                    expect(page.locator('#detail-notes')).to_have_value('APIで更新')
                    page.screenshot(path=str(output/f'reference-{width}.png'),full_page=True)
                    page.evaluate("Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true})")
                    prompts=[]
                    page.on('dialog',lambda dialog:(prompts.append(dialog.default_value),dialog.dismiss()))
                    page.locator('[data-action=copy-link]').click()
                    assert prompts==[link]
                    page.locator('#close-detail').click()
                    expect(page.locator('#task-dialog')).not_to_be_visible()
                    assert not errors, errors
                    context.close()
                    print('PASS task reference',width)
            finally:
                browser.close()
    finally:
        server.terminate(); server.wait(timeout=10)
