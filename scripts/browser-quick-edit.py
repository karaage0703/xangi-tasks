"""Quick editing, failed saves, and one-click reopening using an isolated store."""
import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('SCREENSHOT_DIR','/tmp/tasks-quick-preview'));out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js'; import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init(); await store.create({title:'週末の予定を整理する',description:'必要なことを書き出す',dueDate:'2030-01-31'});
const app=createTaskServer({store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for width in (320,375,414,768,1180):
     page=b.new_page(viewport={'width':width,'height':812}); errors=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.goto(base);page.locator('.task-open').click()
     expect(page.locator('#quick-due')).to_be_in_viewport()
     page.locator('#quick-due').fill('2030-02-20');page.locator('#detail-title').click()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     page.locator('#detail-notes').fill('途中経過のメモ');page.locator('#detail-title').click()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(page.locator('#quick-execution,[data-action=start],[data-action=reset]')).to_have_count(0)
     expect(page.locator('#detail-status')).to_contain_text('未着手')
     page.screenshot(path=str(out/f'quick-{width}.png'))
     assert page.locator('#task-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
     page.reload();page.locator('.task-open').click()
     expect(page.locator('#quick-due')).to_have_value('2030-02-20')
     expect(page.locator('#detail-notes')).to_have_value('途中経過のメモ')
     page.route('**/api/tasks/*',lambda r:r.fulfill(status=500,json={'error':'保存の検証エラー'}) if r.request.method=='PUT' else r.continue_())
     page.locator('#detail-notes').fill('再試行する入力');page.locator('#detail-title').click()
     expect(page.locator('#quick-save-status')).to_contain_text('保存できませんでした')
     expect(page.locator('#detail-notes')).to_have_value('再試行する入力')
     # A poll must not overwrite unsaved input.
     page.wait_for_timeout(4200)
     expect(page.locator('#detail-notes')).to_have_value('再試行する入力')
     page.unroute('**/api/tasks/*');page.locator('#quick-retry').click()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     page.locator('#detail-actions [data-action=close]').click()
     expect(page.locator('#detail-status')).to_have_text('Closed')
     page.locator('#detail-actions [data-action=open]').click()
     expect(page.locator('#quick-execution,[data-action=start],[data-action=reset]')).to_have_count(0)
     expect(page.locator('#detail-status')).to_contain_text('未着手')
     page.locator('#detail-actions [data-action=close]').click()
     expect(page.locator('#detail-status')).to_have_text('Closed')
     page.locator('#close-detail').click();page.locator('[data-filter=closed]').click()
     check=page.locator('.task-check');expect(check).to_be_enabled()
     expect(check).to_have_attribute('aria-label','週末の予定を整理するを未着手に戻す')
     check.click();expect(page.locator('.task-card')).to_have_count(0)
     page.locator('[data-filter=open]').click();expect(page.locator('.task-card')).to_have_count(1)
     page.reload();expect(page.locator('.task-card')).to_have_count(1)
     assert not errors,errors
     print(f'PASS {width}px: direct edit, persisted metadata, status, save failure/poll/retry, done reset in detail and one list click',flush=True)
     page.close()
   finally:b.close()
 finally:server.terminate();server.wait(timeout=10)
