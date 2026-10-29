"""Inbox navigation, provisional categories and acceptance with an isolated store."""
import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('TEST_ARTIFACTS','/tmp/inbox-browser'));out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as data:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js';import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA);await store.init();
const work=await store.saveCollection('categories',{name:'仕事'});
const personal=await store.saveCollection('categories',{name:'個人'});
await store.create({title:'採用済みの仕事',categoryId:work.id});
await store.createInboxItem({title:'資料を準備する',sourceText:'発表資料の準備をお願いします',categoryId:work.id});
await store.createInboxItem({title:'買い物を確認する',sourceText:'週末の買い物を確認する',categoryId:personal.id});
const app=createTaskServer({auth:{token:'inbox-browser-fixture-token-32-characters'},store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':data+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  port=server.stdout.readline().strip();assert port.isdigit();base='http://127.0.0.1:'+port
  with sync_playwright() as p:
   browser=p.chromium.launch(args=['--no-sandbox'])
   try:
    for width in (375,1280):
     page=browser.new_page(viewport={'width':width,'height':900},extra_http_headers={'Authorization':'Bearer inbox-browser-fixture-token-32-characters'})
     errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.goto(base,wait_until='networkidle')
     def menu():
      if width<901:page.locator('#open-categories').click()
     menu();page.get_by_role('button',name='仕事',exact=True).click()
     expect(page.locator('.task-card')).to_have_count(1)
     page.locator('[data-filter=all]').click();expect(page.locator('.task-card')).to_have_count(1)
     menu();page.locator('#inbox-view').click()
     expect(page.locator('.task-card')).to_have_count(2)
     expect(page.locator('.filters')).to_be_hidden()
     expect(page.locator('.proposed-category')).to_have_count(2)
     page.reload();expect(page.locator('.task-card')).to_have_count(2)
     menu();page.screenshot(path=str(out/f'inbox-menu-{width}.png'))
     if width<901:page.locator('#close-categories').click()
     page.screenshot(path=str(out/f'inbox-list-{width}.png'))
     page.get_by_role('button',name='資料を準備するの詳細を開く').click()
     task_id=page.locator('.task-card.selected').get_attribute('data-id')
     page.locator('#quick-category').select_option(label='個人')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     task=page.request.get(base+'/api/tasks/'+task_id+'?history=0').json()['task'];assert task['status']=='inbox';category=task['categoryId']
     page.screenshot(path=str(out/f'inbox-detail-{width}.png'))
     page.locator('#detail-actions [data-action=open]').click()
     expect(page.locator('#detail-status')).to_contain_text('Open')
     task=page.request.get(base+'/api/tasks/'+task_id+'?history=0').json()['task'];assert task['status']=='open' and task['categoryId']==category
     page.locator('#close-detail').click();expect(page.locator('.task-card')).to_have_count(1)
     # Restore fixture candidate through a fresh item for the next viewport.
     page.request.delete(base+'/api/tasks/'+task_id)
     page.request.post(base+'/api/inbox',data={'title':'資料を準備する','sourceText':'発表資料の準備をお願いします','categoryId':category})
     menu();page.get_by_role('button',name='仕事',exact=True).click()
     expect(page.locator('.filters')).to_be_visible();expect(page.locator('[data-filter=open]')).to_have_class('nav-item active')
     expect(page.locator('.task-card')).to_have_count(1)
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
     assert not errors,errors
     page.close();print('PASS Inbox category independence, restore, correction and acceptance',width,flush=True)
   finally:browser.close()
 finally:server.terminate();server.wait(timeout=10)
