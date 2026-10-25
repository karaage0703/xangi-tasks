import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js'; import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init(); await store.create({title:'手動作業'});
const app=createTaskServer({store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for width in (375,1180):
     page=b.new_page(viewport={'width':width,'height':812}); errors=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.goto(base)
     page.locator('.task-open').click()
     page.locator('#detail-actions [data-action=start]').click()
     expect(page.locator('#count-open')).to_have_text('1')
     expect(page.locator('#detail-status')).to_contain_text('作業中')
     expect(page.locator('#detail-actions [data-action=reset]')).to_have_text('未着手に戻す')
     expect(page.locator('#detail-actions [data-action=close]')).to_have_text('完了')
     page.screenshot(path=f'/tmp/tasks-manual-{width}.png')
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     page.locator('#detail-actions [data-action=reset]').click()
     expect(page.locator('#detail-status')).to_contain_text('未着手')
     page.locator('#close-detail').click()
     page.reload()
     expect(page.locator('#count-open')).to_have_text('1')
     assert not errors,errors
     page.close()
    print('PASS: card/detail manual start/reset, counts, reload at 375/1180px')
   finally: b.close()
 finally: server.terminate();server.wait(timeout=10)
