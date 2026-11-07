"""Isolated pane, save round-trip and row reuse regression checks (no host access)."""
import os, subprocess, tempfile, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(os.environ.get('TASK_REPO_ROOT', Path(__file__).resolve().parents[1]))
out=Path(os.environ.get('SCREENSHOT_DIR','/tmp/tasks-pane-response'));out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e','''
import {TaskStore} from './src/task-store.js'; import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init();
for(let i=0;i<200;i++) await store.create({title:`タスク ${i}`,notes:'AIから取得するメモ'});
const app=createTaskServer({auth:{token:'pane-test-token-with-32-characters'},store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    page=b.new_page(extra_http_headers={'Authorization':'Bearer pane-test-token-with-32-characters'},viewport={'width':1440,'height':900}); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(base);expect(page.locator('.task-card')).to_have_count(200)
    page.evaluate("window.oldRows=[...document.querySelectorAll('.task-card')]")
    page.locator('.task-open').first.click();expect(page.locator('#detail-notes')).to_have_value('AIから取得するメモ')
    reused=page.evaluate("window.oldRows.filter(e=>document.querySelector(`[data-id='${e.dataset.id}'].task-card`)===e).length")
    requests=[]
    page.on('request',lambda r: requests.append(r.method+' '+r.url.split(base)[-1]))
    page.locator('#detail-notes').fill('編集したメモ');page.locator('#detail-title').click()
    expect(page.locator('#quick-save-status')).to_have_text('保存しました');page.wait_for_timeout(150)
    gets=[r for r in requests if r.startswith('GET ')];print(json.dumps({'reusedRows':reused,'rows':200,'saveRequests':requests,'saveExtraGets':len(gets)},ensure_ascii=False),flush=True)
    if os.environ.get('BASELINE'): print('baseline measured',flush=True)
    else:
     assert reused==199,reused
     assert not gets, gets
     def size(selector): return page.locator(selector).bounding_box()['width']
     def drag(selector,dx):
      box=page.locator(selector).bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+100);page.mouse.down();page.mouse.move(box['x']+box['width']/2+dx,box['y']+100,steps=12);page.mouse.up()
     before=size('#category-sidebar');drag('#resize-categories',70);assert abs(size('#category-sidebar')-before-70)<2
     before=size('#task-dialog');drag('#resize-detail',-80);assert abs(size('#task-dialog')-before-80)<2
     page.locator('#resize-detail').focus();page.keyboard.press('ArrowLeft');expect(page.locator('#resize-detail')).to_have_attribute('aria-valuenow',str(round(before+90)))
     widths=[size('#category-sidebar'),size('#task-dialog')];page.screenshot(path=str(out/'desktop.png'))
     page.reload();page.locator('.task-open').first.click();expect(page.locator('#detail-notes')).to_have_value('編集したメモ')
     assert [size('#category-sidebar'),size('#task-dialog')]==widths
     # Pointer cancellation restores the width and does not persist a partial drag.
     box=page.locator('#resize-categories').bounding_box();page.mouse.move(box['x']+6,box['y']+100);page.mouse.down();page.mouse.move(box['x']+50,box['y']+100);page.keyboard.press('Escape');page.mouse.up();assert size('#category-sidebar')==widths[0]
     page.locator('#resize-categories').dblclick();expect(page.locator('#resize-categories')).to_have_attribute('aria-valuenow','210')
     for width in (901,1000,1180,1920):
      page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(100)
      assert size('.workspace')>=239
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     page.set_viewport_size({'width':375,'height':812});expect(page.locator('#task-dialog')).to_be_visible();expect(page.locator('#resize-categories')).to_be_hidden()
     page.locator('#detail-notes').fill('モバイルのメモ');page.locator('#detail-title').click();expect(page.locator('#quick-save-status')).to_have_text('保存しました');page.screenshot(path=str(out/'mobile.png'))
     page.locator('#close-detail').click();page.locator('#open-categories').click();expect(page.locator('#category-sidebar')).to_be_visible();page.locator('#close-categories').click();page.locator('.task-open').first.click();expect(page.locator('#detail-notes')).to_have_value('モバイルのメモ')
     assert not errors,errors
     print('PASS: drag, keyboard, persist, cancel, reset, narrow window, mobile edit/drawer/reopen; 200-row reuse and save request counts',flush=True)
   finally:b.close()
 finally:server.terminate();server.wait(timeout=10)
