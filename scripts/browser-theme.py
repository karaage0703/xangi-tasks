"""Verify responsive xangi shell, native home link and cross-tab theme synchronization."""
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
    context=b.new_context(color_scheme='light')
    page=context.new_page(); other=context.new_page()
    page.goto(base); other.goto(base)
    expect(page.locator('#xangi-home')).to_be_hidden()
    other.evaluate("localStorage.setItem('xangi-theme','dark')")
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    expect(page.locator('#theme-select')).to_have_value('dark')
    other.evaluate("localStorage.setItem('xangi-theme','auto')")
    expect(page.locator('#theme-select')).to_have_value('system')
    page.emulate_media(color_scheme='dark')
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    page.locator('#theme-select').select_option('light')
    expect(other.locator('html')).to_have_attribute('data-theme','light')
    # Simulate the host's base injection while keeping real API and assets.
    html=(root/'public/index.html').read_text().replace('<head>',f'<head><base href="{base}/">')
    page.route('**/api/extensions/xangi-tasks/ui',lambda route:route.fulfill(body=html,content_type='text/html'))
    page.goto(base+'/api/extensions/xangi-tasks/ui')
    expect(page.locator('#xangi-home')).to_be_visible()
    assert page.locator('#xangi-home').evaluate('(a)=>a.href')==base+'/'
    for width in (320,375,414,768,1180):
     page.set_viewport_size({'width':width,'height':900})
     page.locator('[data-filter=open]').click()
     for theme in ('light','dark'):
      page.locator('#theme-select').select_option(theme)
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
      expect(page.get_by_role('heading',name='xangi-tasks',exact=True)).to_be_visible()
      page.screenshot(path=f'/tmp/tasks-unified-{width}-{theme}.png',full_page=True,animations="disabled")
     page.get_by_role('button',name='編集',exact=True).click()
     page.locator('#edit-form [name=description]').fill('編集確認')
     page.locator('#edit-form').get_by_role('button',name='保存',exact=True).click()
     expect(page.locator('#edit-dialog')).not_to_be_visible()
     expect(page.locator('.task-description')).to_contain_text('編集確認')
     print(f'{width}px light/dark: overflow, edit/save OK',flush=True)
    page.locator('#xangi-home').click()
    expect(page).to_have_url(base+'/')
    print('home navigation, system preference and cross-tab theme sync OK',flush=True)
   finally:b.close()
 finally:server.terminate();server.wait(timeout=10)
