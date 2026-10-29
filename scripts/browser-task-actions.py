"""Run with uv run --with playwright python scripts/browser-task-actions.py."""
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as state:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store = new TaskStore(process.env.TEST_DATA);
await store.init();
for (const width of [1180,375]) {
  const task=await store.create({title:`会話再開${width}`,description:'LTタイトルを決める。conversation=discord:1559139593775751189'});
  await store.update(task.id,{xangiSessionId:`existing-${width}`});
}
const app = createTaskServer({store, connector:{health:async()=>({version:'test'}),readHistory:async()=>[{role:'assistant',text:'以前のタイトル案'}],sendMessage:async()=>({})}, publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA': str(Path(state)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        base = 'http://127.0.0.1:'+server.stdout.readline().strip()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.getenv('CHROMIUM_EXECUTABLE', '/snap/bin/chromium'), args=['--no-sandbox'])
            try:
                for width in (1180, 375):
                    req = urllib.request.Request(base+'/api/inbox', data=json.dumps({'title':f'候補{width}', 'sourceText':'実施したい用事'}).encode(), headers={'Content-Type':'application/json'})
                    task = json.load(urllib.request.urlopen(req))['task']
                    page = browser.new_page(viewport={'width':width,'height':812})
                    errors=[]
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    page.goto(base, wait_until='networkidle')
                    assert page.locator('.nav-item').evaluate_all('(items)=>items.map(e=>e.dataset.filter)') == ['candidate','todo','running','review','done','all']
                    page.locator('[data-filter=inbox]').click()
                    page.locator('.task-open').click()
                    page.locator(f'[data-action=show][data-id="{task["id"]}"]').click()
                    page.locator('#close-detail').click()
                    page.locator('[data-filter=open]').click()
                    card=page.locator('.task-card').filter(has=page.get_by_role('heading',name=f'候補{width}',exact=True))
                    card.wait_for()
                    card.locator('.task-open').click()
                    page.locator('#detail-actions [data-action=edit]').click()
                    form=page.locator('#edit-form')
                    form.locator('[name=description]').fill('編集した説明')
                    form.locator('[name=dueDate]').fill('2026-10-31')
                    page.screenshot(path=f'/tmp/tasks-editor-{width}.png')
                    form.get_by_role('button',name='保存',exact=True).click()
                    form.wait_for(state='hidden')
                    page.reload(wait_until='networkidle')
                    page.locator('[data-filter=open]').click()
                    card.wait_for()
                    card.locator('.task-open').click()
                    assert '2026-10-31' in card.inner_text()
                    assert '編集した説明' in page.locator('#detail-description').inner_text()
                    page.locator('#detail-actions [data-action=delete]').click()
                    page.locator('#delete-dialog button[value=cancel]').click()
                    assert card.count()==1
                    page.locator('#detail-actions [data-action=delete]').click()
                    page.locator('#delete-dialog button[value=delete]').click()
                    card.wait_for(state='detached')
                    page.reload(wait_until='networkidle')
                    page.locator('[data-filter=all]').click()
                    assert page.get_by_role('heading',name=f'候補{width}',exact=True).count()==0
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.locator('[data-filter=open]').click()
                    page.get_by_role('heading',name=f'会話再開{width}',exact=True).click()
                    assert page.locator('#message-text').is_enabled()
                    assert 'conversation=' not in page.locator('#detail-description').inner_text()
                    page.locator('#message-text').fill('この案の続きを考えて')
                    page.wait_for_timeout(4500)
                    assert page.locator('#message-text').input_value() == 'この案の続きを考えて'
                    page.screenshot(path=f'/tmp/tasks-conversation-{width}.png')
                    page.locator('#message-form button').click()
                    page.wait_for_function("document.querySelector('#detail-status').textContent === '実行中'")
                    assert page.locator('#message-text').is_disabled()
                    page.locator('#close-detail').click()
                    req = urllib.request.Request(base+'/api/inbox', data=json.dumps({'title':f'不要な候補{width}', 'sourceText':'候補の確認'}).encode(), headers={'Content-Type':'application/json'})
                    json.load(urllib.request.urlopen(req))
                    page.reload(wait_until='networkidle')
                    page.locator('[data-filter=inbox]').click()
                    page.get_by_role('heading',name=f'不要な候補{width}',exact=True).click()
                    assert page.get_by_role('button',name='タスクではない',exact=True).count() == 0
                    page.locator('#detail-actions [data-action=delete]').click()
                    page.keyboard.press('Escape')
                    assert page.locator('#task-dialog').is_visible()
                    page.locator('#detail-actions [data-action=delete]').click()
                    page.locator('#delete-dialog button[value=delete]').click()
                    page.locator('#task-dialog').wait_for(state='hidden')
                    page.reload(wait_until='networkidle')
                    page.locator('[data-filter=inbox]').click()
                    assert page.get_by_role('heading',name=f'不要な候補{width}',exact=True).count() == 0
                    assert not errors,errors
                    page.screenshot(path=f'/tmp/tasks-actions-{width}.png')
                    print(f'{width}px: candidate -> todo, delete cancel/confirm/reload passed',flush=True)
                    page.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
