"""Tiptap document editing, source preservation, and failure recovery on an isolated store."""
import os, subprocess, tempfile, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('SCREENSHOT_DIR','/tmp/tasks-tiptap-preview'));out.mkdir(parents=True,exist_ok=True)
original='説明の一行目\n説明の二行目\n\n- [x] 初回校正の返信\n- [ ] 振込確認\n\n[公開記事](https://example.test/article) と **補足**\n\n| 項目 | 状態 |\n| --- | --- |\n| 公開 | 済 |\n\n```js\nconst answer = 42;\n```\n\n![参考画像](https://example.test/private.png)'
token='synthetic-browser-test-token-32-characters'
with tempfile.TemporaryDirectory() as temp:
 embedded=subprocess.check_output(['node','--input-type=module','-e',"import {renderExtensionHtml} from './src/extension.js';console.log(await renderExtensionHtml(process.cwd()+'/public'));"],cwd=root,text=True)
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js';import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA);await store.init();
await store.create({title:'寄稿：校正と振込確認',description:process.env.TEST_DESCRIPTION});
await store.create({title:'文章のみ',description:'通常の内容'});
await store.create({title:'HTMLの扱い',description:'補足 <script>alert(1)</script> と <b>文字</b><!--keep-comment-->'});
const app=createTaskServer({auth:{token:'synthetic-browser-test-token-32-characters'},store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json','TEST_DESCRIPTION':original},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   b=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for embedded_mode,width in ((False,1440),(True,390)):
     page=b.new_page(viewport={'width':width,'height':1100},extra_http_headers={'Authorization':'Bearer '+token});errors=[];updates=[];remote_images=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.on('request',lambda r:updates.append(r) if r.method=='PUT' else None)
     page.on('request',lambda r:remote_images.append(r.url) if 'private.png' in r.url else None)
     if embedded_mode:page.route('**/__embedded',lambda r:r.fulfill(body=embedded,content_type='text/html'))
     page.goto(base+('/__embedded' if embedded_mode else '/'))
     page.get_by_role('button',name='寄稿：校正と振込確認の詳細を開く',exact=True).click()
     editor=page.get_by_role('textbox',name='タスクの内容',exact=True)
     checks=editor.locator('input[type=checkbox]')
     expect(checks).to_have_count(2)
     assert editor.locator('textarea').count()==0
     expect(editor.locator('table')).to_contain_text('公開')
     expect(editor.locator('pre')).to_have_text('const answer = 42;')
     assert editor.locator('br').count()>=1
     assert not remote_images,remote_images
     page.wait_for_timeout(4200 if width==1440 else 1200)
     assert not updates,'Opening an editor must not normalize or save its Markdown'
     expect(page.locator('#detail-description')).to_have_value(original if width==1440 else page.locator('#detail-description').input_value())
     # Source syntax and data remain unchanged before editing (first viewport).
     checks.nth(1).check()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     page.reload();page.get_by_role('button',name='寄稿：校正と振込確認の詳細を開く',exact=True).click()
     editor=page.get_by_role('textbox',name='タスクの内容',exact=True)
     expect(editor.locator('input[type=checkbox]').nth(1)).to_be_checked()
     expect(page.locator('#detail-status')).to_contain_text('未着手')
     keyboard_check=editor.locator('input[type=checkbox]').nth(1)
     expect(keyboard_check).to_be_enabled();keyboard_check.focus();keyboard_check.press('Space')
     expect(keyboard_check).not_to_be_checked()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(keyboard_check).to_be_enabled();keyboard_check.press('Space')
     expect(keyboard_check).to_be_checked()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     # Whole-document typing, list continuation, and undo are library operations.
     item=editor.locator('li[data-type=taskItem]').nth(1).locator('p').first
     item.click();page.keyboard.press('End');page.keyboard.insert_text('済');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(item).to_have_text('振込確認済')
     expect(editor).to_have_attribute('contenteditable','true')
     item.click()
     page.keyboard.press('End')
     page.keyboard.press('Enter');page.keyboard.insert_text('追加項目')
     expect(editor.locator('input[type=checkbox]')).to_have_count(3)
     page.keyboard.press('Enter');expect(editor.locator('input[type=checkbox]')).to_have_count(4)
     page.keyboard.press('Backspace');expect(editor.locator('input[type=checkbox]')).to_have_count(3)
     page.keyboard.press('Control+Enter');expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(editor).to_have_attribute('contenteditable','true')
     page.keyboard.insert_text('UNDO確認');expect(editor).to_contain_text('UNDO確認')
     page.keyboard.press('Control+z');expect(editor).not_to_contain_text('UNDO確認')
     page.keyboard.press('Control+Enter');expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     saved=page.locator('#detail-description').input_value()
     for expected in ['https://example.test/article','const answer = 42;','https://example.test/private.png','公開','補足','説明の二行目']:
      assert expected in saved,(expected,saved)
     # Composition transactions cannot trigger a save/re-render in the middle of IME.
     before=len(updates)
     editor.dispatch_event('compositionstart',{'data':'に'})
     editor.dispatch_event('keydown',{'key':'Enter','ctrlKey':True,'isComposing':True,'keyCode':229})
     assert len(updates)==before
     editor.dispatch_event('compositionend',{'data':'に'})
     page.wait_for_timeout(100)
     # A failed save and subsequent polling must keep user input and undo state.
     page.route('**/api/tasks/*',lambda r:r.fulfill(status=500,json={'error':'保存の検証エラー'}) if r.request.method=='PUT' else r.continue_())
     item=editor.locator('li[data-type=taskItem]').nth(1).locator('p').first
     item.click();page.keyboard.press('End');page.keyboard.insert_text('再試行');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_contain_text('保存できませんでした')
     page.wait_for_timeout(4200);expect(editor).to_contain_text('再試行')
     page.unroute('**/api/tasks/*');page.locator('#quick-retry').click()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     page.reload();page.get_by_role('button',name='寄稿：校正と振込確認の詳細を開く',exact=True).click()
     editor=page.get_by_role('textbox',name='タスクの内容',exact=True)
     expect(editor).to_contain_text('再試行')
     assert page.locator('#task-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
     page.locator('#description-checklist').screenshot(path=str(out/f'editor-{width}.png'))
     page.get_by_role('button',name='文章のみの詳細を開く',exact=True).click() if width>900 else page.locator('#close-detail').click()
     if width<=900:page.get_by_role('button',name='文章のみの詳細を開く',exact=True).click()
     plain=page.get_by_role('textbox',name='タスクの内容',exact=True)
     expect(plain).to_have_text('通常の内容')
     plain.click();page.keyboard.press('Control+a');page.keyboard.insert_text('文章の更新');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(plain).to_have_attribute('contenteditable','true')
     if width<=900:page.locator('#close-detail').click()
     page.get_by_role('button',name='HTMLの扱いの詳細を開く',exact=True).click()
     html_editor=page.get_by_role('textbox',name='タスクの内容',exact=True)
     expect(page.locator('#description-checklist')).to_be_hidden()
     expect(html_editor).to_have_value('補足 <script>alert(1)</script> と <b>文字</b><!--keep-comment-->')
     html_editor.fill(html_editor.input_value()+'追記');html_editor.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     html_saved=page.locator('#detail-description').input_value()
     assert 'keep-comment' in html_saved and 'alert(1)' in html_saved and '文字' in html_saved
     assert not errors,errors
     # Reset the synthetic fixture using the API before testing the next viewport.
     page.evaluate('''async original=>{const response=await fetch('/api/tasks');const data=await response.json();for(const task of data.tasks){if(task.title==='寄稿：校正と振込確認')await fetch('/api/tasks/'+task.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:original})});if(task.title==='HTMLの扱い')await fetch('/api/tasks/'+task.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:'補足 <script>alert(1)</script> と <b>文字</b><!--keep-comment-->'})});if(task.title==='文章のみ')await fetch('/api/tasks/'+task.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:'通常の内容'})})}}''',original)
     print(f'PASS {width}px embedded={embedded_mode}: no load writes, check/text, Enter/Backspace/Undo, Markdown features, IME guard, retry/poll, switch, plain text, no image fetch',flush=True)
     page.close()
   finally:b.close()
 finally:server.terminate();server.wait(timeout=10)
