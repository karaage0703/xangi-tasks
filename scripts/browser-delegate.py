import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js'; import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init();
await store.create({title:'指示の確認',description:'元の完了条件'});
const connector={health:async()=>({version:'test'}),listAgents:async()=>[{id:'local',name:'ローカル調査',model:'test-model'}],sendTask:async t=>({sessionId:'test'}),readHistory:async()=>[]};
const app=createTaskServer({store,connector,publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for width in (375,1180):
     page=browser.new_page(viewport={'width':width,'height':812},is_mobile=width<500)
     errors=[]; page.on('pageerror',lambda e: errors.append(str(e)))
     page.goto(base)
     expect(page.locator('#view-title')).to_have_text('未着手')
     expect(page.locator('[data-filter=open]')).to_have_class('nav-item active')
     if not page.locator('#task-dialog').is_visible(): page.locator('.task-open').click()
     page.locator('#detail-actions [data-action=delegate]').click()
     expect(page.locator('#delegate-dialog')).to_be_visible()
     expect(page.locator('#delegate-agent')).to_be_enabled()
     page.locator('#delegate-agent').select_option('local')
     page.locator('#delegate-instructions').fill('送信せず調査結果だけまとめて')
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
     assert page.locator('#delegate-dialog').evaluate('(d)=>d.scrollWidth <= d.clientWidth')
     page.screenshot(path=f'/tmp/tasks-agent-{width}.png')
     page.locator('#close-delegate').click()
     expect(page.locator('#delegate-dialog')).not_to_be_visible()
     if not page.locator('#task-dialog').is_visible(): page.locator('.task-open').click()
     page.locator('#detail-actions [data-action=delegate]').click()
     expect(page.locator('#delegate-agent')).to_be_enabled()
     page.locator('#delegate-agent').select_option('local')
     page.locator('#delegate-instructions').fill('送信せず調査結果だけまとめて')
     page.route('**/delegate',lambda r:r.fulfill(status=400,json={'error':'依頼エラーの検証'}))
     page.locator('#delegate-form [type=submit]').click()
     expect(page.locator('#delegate-error')).to_have_text('依頼エラーの検証')
     expect(page.locator('#delegate-instructions')).to_have_value('送信せず調査結果だけまとめて')
     page.unroute('**/delegate')
     if width==375:
      page.locator('#close-delegate').click()
      page.route('**/api/agents',lambda r:r.fulfill(status=503,json={'error':'offline'}))
      page.locator('#detail-actions [data-action=delegate]').click()
      expect(page.locator('#delegate-agent-hint')).to_contain_text('一覧を取得できませんでした')
      expect(page.locator('#delegate-form [type=submit]')).to_be_disabled()
      page.locator('#close-delegate').click()
      page.unroute('**/api/agents')
      page.route('**/api/agents',lambda r:r.fulfill(json={'agents':[]}))
      page.locator('#detail-actions [data-action=delegate]').click()
      expect(page.locator('#delegate-agent-hint')).to_contain_text('登録済みエージェントはありません')
      expect(page.locator('#delegate-form [type=submit]')).to_be_enabled()
      page.unroute('**/api/agents')

     if width==1180:
      with page.expect_response('**/delegate') as response:
       page.locator('#delegate-form [type=submit]').click()
      assert response.value.json()['task']['agentId']=='local'
      assert response.value.json()['task']['delegationInstructions']=='送信せず調査結果だけまとめて'
      expect(page.locator('#delegate-dialog')).not_to_be_visible()
     else:
      page.keyboard.press('Escape')
      page.reload()
      expect(page.locator('#view-title')).to_have_text('未着手')
     assert not errors,errors
     page.close()
    print('PASS: 375/1180px default Todo, instructions, cancel, error preservation, actual submission, reload')
   finally: browser.close()
 finally: server.terminate(); server.wait(timeout=10)
