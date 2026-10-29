"""Exercise compact rows and retained actions against an isolated store and mock connector."""
import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('SCREENSHOT_DIR','/tmp/tasks-compact')); out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js'; import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init();
for (const title of ['買い物リストを整理する','週末の予定を確認する','読みかけの本を読む','写真を整理する','次の記事の構成を考える','資料の内容を確認する','来週の準備をする','気になった技術を試す','メモを見返す','部屋を片付ける']) await store.create({title,description:'背景と完了条件。詳細画面で全文を確認できます。'.repeat(8),dueDate:'2030-01-31'});
const app=createTaskServer({store,connector:{health:async()=>({version:'test'}),sendTask:async()=>({sessionId:'web-test'}),readHistory:async()=>[],completeSession:async()=>({ok:true}),readSession:async()=>({state:'idle',result:'確認済み'})},publicDir:process.env.PUBLIC_DIR||process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for width in (320,375,414,768,1180):
     page=browser.new_page(viewport={'width':width,'height':812}); errors=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.goto(base); expect(page.locator('.task-card')).to_have_count(10)
     page.screenshot(path=str(out/f'list-{width}.png'))
     if os.environ.get('BEFORE'):
      print(width,'before visible rows:',page.locator('.task-card').evaluate_all('(els)=>els.filter(e=>e.getBoundingClientRect().bottom<=innerHeight).length')); page.close();continue
     assert page.locator('#task-grid .task-description, #task-grid .card-actions, #task-grid .session-id').count()==0
     assert page.locator('.task-card').first.bounding_box()['height'] < 85
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     page.locator('.task-open').first.focus(); page.keyboard.press('Enter')
     expect(page.locator('#task-dialog')).to_be_visible()
     expect(page.locator('#detail-description')).to_contain_text('背景と完了条件')
     page.locator('#detail-actions [data-action=edit]').click()
     page.locator('#edit-form [name=description]').fill('編集内容が詳細にも反映される')
     page.locator('#edit-form [type=submit]').click()
     expect(page.locator('#detail-description')).to_have_text('編集内容が詳細にも反映される')
     expect(page.locator('#quick-execution,[data-action=start],[data-action=reset]')).to_have_count(0)
     expect(page.locator('#detail-status')).to_contain_text('未着手')
     page.screenshot(path=str(out/f'detail-{width}.png'))
     page.locator('#close-detail').click()
     expect(page.locator('.task-open').first).to_be_focused()
     page.locator('#list-options-summary').click()
     expect(page.locator('.task-card')).to_have_count(10)
     page.locator('#task-sort').select_option('due-asc')
     page.locator('#list-options-summary').click()
     # A failed completion keeps the row, reports the error, and can be retried.
     page.route('**/close',lambda route:route.fulfill(status=500,json={'error':'完了テストエラー'}))
     page.locator('.task-check').first.click()
     expect(page.locator('#toast')).to_have_text('完了テストエラー')
     expect(page.locator('.task-card')).to_have_count(10)
     page.unroute('**/close')
     page.locator('.task-check').first.click()
     expect(page.locator('.task-card')).to_have_count(9)
     page.reload(); expect(page.locator('.task-card')).to_have_count(9)
     page.locator('[data-filter=closed]').click(); expect(page.locator('.task-card')).to_have_count(1)
     page.locator('.task-open').click()
     page.once('dialog',lambda d:d.accept())
     page.locator('#detail-actions [data-action=delete]').click()
     expect(page.locator('#task-dialog')).not_to_be_visible()
     expect(page.locator('#empty-state')).to_be_visible()
     # Restore 10 rows for the next viewport through the real creation flow.
     page.locator('#open-create').click();page.locator('#task-title').fill('追加したタスク');page.locator('#task-description').fill('背景と完了条件')
     page.locator('#task-form [type=submit]').click()
     expect(page.locator('.task-card')).to_have_count(10)
     page.locator('#theme-select').select_option('dark')
     page.screenshot(path=str(out/f'dark-{width}.png'))
     assert not errors, errors
     print(f'PASS {width}px: compact rows, keyboard detail, edit, start/reset, filter/sort, failed completion/retry, reload, delete, create, dark',flush=True)
     page.close()
   finally:browser.close()
 finally:server.terminate();server.wait(timeout=10)
