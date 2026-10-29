"""Check repeat/sort UI. Optional TASKS_TEST_URL + TASKS_TEST_API target a live instance."""
import json, os, subprocess, tempfile, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 server=None
 if not os.getenv('TASKS_TEST_URL'):
  server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init();
const app=createTaskServer({auth:{token:'repeat-fixture-token-with-32-characters'},store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
  url='http://127.0.0.1:'+server.stdout.readline().strip()
 else: url=os.environ['TASKS_TEST_URL']
 api=os.getenv('TASKS_TEST_API',url)
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(args=['--no-sandbox'])
   try:
    for width in (1180,375):
     marker='UI確認-'+uuid.uuid4().hex[:8]
     page=browser.new_page(viewport={'width':width,'height':950},extra_http_headers={} if os.getenv('TASKS_TEST_URL') else {'Authorization':'Bearer repeat-fixture-token-with-32-characters'})
     errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
     try:
      page.goto(url,wait_until='networkidle')
      page.locator('#open-create').click()
      form=page.locator('#task-form')
      form.locator('[name=title]').fill(marker+'-繰り返し')
      form.locator('[name=dueDate]').fill('2030-01-31')
      form.locator('[name=repeatPreset]').select_option('month')
      form.get_by_role('button',name='追加',exact=True).click()
      for suffix,due in [('早い','2029-01-01'),('なし','')]:
       res=page.request.post(api+'/api/tasks',data={'title':marker+'-'+suffix,'dueDate':due})
       assert res.ok
      page.locator('#refresh').click()
      page.locator('[data-filter=open]').click()
      page.locator('#list-options-summary').click()
      page.locator('#task-sort').select_option('due-asc')
      headings=page.locator('.task-card h3')
      from playwright.sync_api import expect
      expect(headings).to_have_text([marker+'-早い',marker+'-繰り返し',marker+'-なし'])
      page.locator('#task-sort').select_option('due-desc')
      expect(headings).to_have_text([marker+'-繰り返し',marker+'-早い',marker+'-なし'])
      page.reload(wait_until='networkidle'); page.locator('[data-filter=open]').click()
      expect(headings).to_have_text([marker+'-繰り返し',marker+'-早い',marker+'-なし'])
      card=page.locator('.task-card').filter(has=page.get_by_role('heading',name=marker+'-繰り返し',exact=True))
      card.locator('.task-check').click()
      expect(card).to_contain_text('2030-02-28')
      card.locator('.task-open').click()
      page.locator('#detail-actions [data-action=edit]').click()
      edit=page.locator('#edit-form')
      edit.locator('[name=repeatPreset]').select_option('custom')
      edit.locator('[name=repeatInterval]').fill('2')
      edit.locator('[name=repeatUnit]').select_option('week')
      edit.locator('[name=repeatDay][value="1"]').check()
      edit.locator('[name=repeatDay][value="3"]').check()
      page.screenshot(path=f'/tmp/tasks-repeat-editor-{width}.png')
      edit.get_by_role('button',name='保存',exact=True).click()
      edit.wait_for(state='hidden')
      if not page.locator('#task-dialog').is_visible(): card.locator('.task-open').click()
      expect(page.locator('#detail-properties')).to_contain_text('2週ごと（月・水）')
      page.locator('#close-detail').click()
      page.reload(wait_until='networkidle'); page.locator('[data-filter=open]').click()
      if not page.locator('#task-dialog').is_visible(): card.locator('.task-open').click()
      expect(page.locator('#detail-properties')).to_contain_text('2週ごと（月・水）')
      page.locator('#close-detail').click()
      card.locator('.task-open').click()
      page.locator('#detail-actions [data-action=edit]').click()
      edit.locator('[name=repeatPreset]').select_option('none')
      edit.get_by_role('button',name='保存',exact=True).click(); edit.wait_for(state='hidden')
      page.locator('#close-detail').click()
      card.locator('.task-check').click()
      expect(card).to_have_count(0)
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
      assert not errors,errors
      page.screenshot(path=f'/tmp/tasks-repeat-list-{width}.png',full_page=True)
      print(f'{width}px: create/monthly completion/custom weekly edit/disable/sort/reload passed',flush=True)
     finally:
      tasks=page.request.get(api+'/api/tasks').json()['tasks']
      for t in tasks:
       if t['title'].startswith(marker):
        assert page.request.delete(api+'/api/tasks/'+t['id']).ok
      page.close()
   finally: browser.close()
 finally:
  if server: server.terminate(); server.wait(timeout=10)
