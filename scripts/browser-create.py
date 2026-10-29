"""Verify the floating task composer, draft retention, focus and submission recovery."""
import os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA); await store.init();
await store.create({title:'企画書を確認する',description:'構成を確認してフィードバックする',dueDate:'2030-01-31'});
const app=createTaskServer({store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json'},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    page=b.new_page()
    errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
    for width in (320,375,414,768,1180):
     page.set_viewport_size({'width':width,'height':812})
     page.goto(base)
     launcher=page.locator('#open-create'); dialog=page.locator('#create-dialog')
     expect(dialog).not_to_be_visible()
     expect(page.locator('#view-title')).to_be_in_viewport()
     expect(launcher).to_be_in_viewport()
     page.keyboard.press('Control+Enter')
     expect(dialog).not_to_be_visible()
     for theme in ('light','dark'):
      page.locator('#theme-select').select_option(theme)
      page.screenshot(path=f'/tmp/tasks-floating-{width}-{theme}-list.png')
      launcher.click()
      expect(page.locator('#task-title')).to_be_focused()
      page.locator('#task-title').fill(f'新規タスク-{width}')
      page.locator('#task-description').fill('閉じても入力を保持')
      page.screenshot(path=f'/tmp/tasks-floating-{width}-{theme}-form.png')
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
      assert dialog.evaluate('(d)=>d.scrollWidth <= d.clientWidth')
      page.keyboard.press('Escape')
      expect(launcher).to_be_focused()
      launcher.click()
      expect(page.locator('#task-description')).to_have_value('閉じても入力を保持')
      page.locator('#close-create').click()
     launcher.click()
     page.route('**/api/tasks',lambda r: r.fulfill(status=500,json={'error':'追加テストエラー'}) if r.request.method=='POST' else r.continue_())
     page.locator('#task-form [type=submit]').click()
     expect(page.locator('#create-error')).to_contain_text('追加テストエラー')
     expect(dialog).to_be_visible()
     expect(page.locator('#task-title')).to_have_value(f'新規タスク-{width}')
     page.unroute('**/api/tasks')
     page.keyboard.press('Control+Enter')
     expect(dialog).not_to_be_visible()
     expect(page.locator('#view-title')).to_have_text('未着手')
     expect(page.locator('[data-filter=open]')).to_have_class('nav-item active')
     expect(page.get_by_role('heading',name=f'新規タスク-{width}',exact=True)).to_be_visible()
     expect(launcher).to_be_focused()
     launcher.click()
     expect(page.locator('#task-title')).to_have_value('')
     page.keyboard.press('Escape')
     print(f'{width}px: light/dark, open/close, focus, draft, failure/retry, create/list passed',flush=True)
    # Touch emulation covers focus policy and control sizing, not native iOS zoom.
    mobile=b.new_context(is_mobile=True,has_touch=True,device_scale_factor=3)
    touch=mobile.new_page()
    for width in (320,375,430):
     touch.set_viewport_size({'width':width,'height':812})
     touch.goto(base)
     touch.locator('#open-create').tap()
     expect(touch.locator('#close-create')).to_be_focused()
     controls=touch.locator('#create-dialog input, #create-dialog textarea, #create-dialog select')
     assert controls.evaluate_all('(els)=>els.every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)')
     touch.locator('#task-title').tap()
     expect(touch.locator('#task-title')).to_be_focused()
     touch.locator('#task-title').fill(f'touch-{width}')
     for height in (812,400):
      touch.set_viewport_size({'width':width,'height':height})
      rect=touch.locator('#create-dialog').bounding_box()
      assert rect['x']>=0 and rect['x']+rect['width']<=width
      assert rect['y']>=0 and rect['y']+rect['height']<=height
      touch.locator('#task-form [type=submit]').scroll_into_view_if_needed()
      expect(touch.locator('#task-form [type=submit]')).to_be_in_viewport()
     touch.locator('#task-form [type=submit]').tap()
     expect(touch.locator('#create-dialog')).not_to_be_visible()
     expect(touch.get_by_role('heading',name=f'touch-{width}',exact=True)).to_be_visible()
     print(f'{width}px touch: non-input initial focus, 16px controls, short viewport, submit passed',flush=True)
    mobile.close()
    assert not errors,errors
   finally:b.close()
 finally:server.terminate();server.wait(timeout=10)
