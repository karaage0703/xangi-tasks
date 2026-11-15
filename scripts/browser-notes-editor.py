"""Independent Tiptap editors for description/notes, using synthetic persisted data."""
import os,subprocess,tempfile,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('SCREENSHOT_DIR','/tmp/tasks-notes-editor'));out.mkdir(parents=True,exist_ok=True)
description='- [x] 本文の確認\n- [ ] 本文の残件'
notes='- [x] メモの完了\n- [ ] メモの未完了\n\n途中の補足\n\n```txt\n- [ ] コードの中は文字\n```'
raw_html='メモ <b>文字</b><!--メモのコメント-->'
token='synthetic-browser-test-token-32-characters'
with tempfile.TemporaryDirectory() as temp:
 embedded=subprocess.check_output(['node','--input-type=module','-e',"import {renderExtensionHtml} from './src/extension.js';console.log(await renderExtensionHtml(process.cwd()+'/public'));"],cwd=root,text=True)
 server=subprocess.Popen(['node','--input-type=module','-e', '''
import {TaskStore} from './src/task-store.js';import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA);await store.init();
await store.create({title:'本文とメモの確認',description:process.env.TEST_DESCRIPTION,notes:process.env.TEST_NOTES});
await store.create({title:'別のタスク',description:'別タスクの本文',notes:'別タスクのメモ'});
await store.create({title:'HTMLのメモ',description:'通常の本文',notes:process.env.TEST_HTML});
const app=createTaskServer({auth:{token:'synthetic-browser-test-token-32-characters'},store,connector:{health:async()=>({version:'test'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''],cwd=root,env={**os.environ,'TEST_DATA':temp+'/tasks.json','TEST_DESCRIPTION':description,'TEST_NOTES':notes,'TEST_HTML':raw_html},stdout=subprocess.PIPE,text=True)
 try:
  base='http://127.0.0.1:'+server.stdout.readline().strip()
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path='/snap/bin/chromium',args=['--no-sandbox'])
   try:
    for width,embedded_mode in ((1440,False),(390,True)):
     page=browser.new_page(viewport={'width':width,'height':1100},extra_http_headers={'Authorization':'Bearer '+token});errors=[];writes=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.on('request',lambda r:writes.append(r.post_data_json) if r.method=='PUT' else None)
     if embedded_mode:page.route('**/__embedded',lambda r:r.fulfill(body=embedded,content_type='text/html'))
     page.goto(base+('/__embedded' if embedded_mode else '/'))
     page.get_by_role('button',name='本文とメモの確認の詳細を開く',exact=True).click()
     body=page.get_by_role('textbox',name='タスクの内容',exact=True);memo=page.get_by_role('textbox',name='メモ',exact=True)
     expect(body.locator('input[type=checkbox]')).to_have_count(2);expect(memo.locator('input[type=checkbox]')).to_have_count(2)
     expect(page.locator('#detail-notes')).to_be_hidden()
     expect(page.locator('#detail-notes')).to_have_value(notes);expect(page.locator('#detail-description')).to_have_value(description)
     page.wait_for_timeout(4200);assert not writes,writes
     memo.locator('input[type=checkbox]').nth(1).check()
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     assert set(writes[-1])=={'notes'},writes
     expect(page.locator('#detail-description')).to_have_value(description)
     check=memo.locator('input[type=checkbox]').first;expect(check).to_be_enabled();check.focus();check.press('Space')
     expect(check).not_to_be_checked();expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(memo).to_have_attribute('contenteditable','true')
     memo.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
     line=memo.locator('li[data-type=taskItem]').nth(1).locator('p').first
     line.click()
     page.keyboard.press('End')
     page.keyboard.press('Enter');page.keyboard.insert_text('メモの追加項目');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(memo.locator('input[type=checkbox]')).to_have_count(3)
     saved_notes=page.locator('#detail-notes').input_value()
     assert saved_notes.splitlines()[:3]==['- [ ] メモの完了','- [x] メモの未完了','- [ ] メモの追加項目'],saved_notes
     for expected in ['コードの中は文字','メモの完了','メモの未完了','メモの追加項目']:assert expected in saved_notes,(expected,saved_notes)
     # Editing the other field cannot rewrite the saved notes.
     body.locator('input[type=checkbox]').nth(1).check();expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     assert set(writes[-1])=={'description'},writes[-1]
     expect(page.locator('#detail-notes')).to_have_value(saved_notes)
     saved_body=page.locator('#detail-description').input_value()
     page.reload();page.get_by_role('button',name='本文とメモの確認の詳細を開く',exact=True).click()
     memo=page.get_by_role('textbox',name='メモ',exact=True);body=page.get_by_role('textbox',name='タスクの内容',exact=True)
     expect(memo.locator('input[type=checkbox]')).to_have_count(3);expect(memo).to_contain_text('メモの追加項目')
     expect(body.locator('input[type=checkbox]').nth(1)).to_be_checked()
     line=memo.locator('li[data-type=taskItem]').nth(2).locator('p').first
     line.click();page.keyboard.press('End');page.keyboard.insert_text('UNDO');page.keyboard.press('Control+z')
     expect(memo).not_to_contain_text('UNDO');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     # Failed saves/polls retain notes and do not change description.
     page.route('**/api/tasks/*',lambda r:r.fulfill(status=500,json={'error':'メモの保存エラー'}) if r.request.method=='PUT' else r.continue_())
     expect(memo).to_have_attribute('contenteditable','true');line.click();page.keyboard.press('End');page.keyboard.insert_text('再試行');page.keyboard.press('Control+Enter')
     expect(page.locator('#quick-save-status')).to_contain_text('保存できませんでした');page.wait_for_timeout(4200)
     expect(memo).to_contain_text('再試行');expect(page.locator('#detail-description')).to_have_value(saved_body)
     for expected in ['メモの完了','メモの未完了','メモの追加項目']:expect(memo).to_contain_text(expected)
     # While notes are composing, neither editor can submit an intermediate draft.
     expect(memo).to_have_attribute('contenteditable','true');memo.dispatch_event('compositionstart',{'data':'に'})
     count=len(writes);memo.dispatch_event('keydown',{'key':'Enter','ctrlKey':True,'isComposing':True,'keyCode':229})
     body.dispatch_event('keydown',{'key':'Enter','ctrlKey':True,'isComposing':False})
     assert len(writes)==count
     memo.dispatch_event('compositionend',{'data':'に'});page.wait_for_timeout(100)
     page.unroute('**/api/tasks/*');page.locator('#quick-retry').click();expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     page.reload();page.get_by_role('button',name='本文とメモの確認の詳細を開く',exact=True).click()
     memo=page.get_by_role('textbox',name='メモ',exact=True);expect(memo).to_contain_text('再試行')
     assert page.locator('#task-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
     assert page.locator('#detail-notes').input_value().splitlines()[:3]==['- [ ] メモの完了','- [x] メモの未完了','- [ ] メモの追加項目再試行']
     (out/f'notes-source-{width}.json').write_text(json.dumps({'notes':page.locator('#detail-notes').input_value(),'html':page.locator('#notes-editor').inner_html()},ensure_ascii=False,indent=2))
     page.locator('#task-dialog').screenshot(path=str(out/f'notes-{width}.png'))
     if width<=900:page.locator('#close-detail').click()
     page.get_by_role('button',name='別のタスクの詳細を開く',exact=True).click()
     expect(page.get_by_role('textbox',name='メモ',exact=True)).to_have_text('別タスクのメモ')
     expect(page.get_by_role('textbox',name='タスクの内容',exact=True)).to_have_text('別タスクの本文')
     if width<=900:page.locator('#close-detail').click()
     page.get_by_role('button',name='HTMLのメモの詳細を開く',exact=True).click()
     raw=page.get_by_role('textbox',name='メモ',exact=True);expect(page.locator('#notes-editor')).to_be_hidden();expect(raw).to_have_value(raw_html)
     raw.fill(raw_html+'追記');raw.press('Control+Enter');expect(page.locator('#quick-save-status')).to_have_text('保存しました')
     expect(raw).to_have_value(raw_html+'追記')
     assert not errors,errors
     page.evaluate('''async args=>{const data=await(await fetch('/api/tasks')).json();for(const task of data.tasks){const payload=task.title==='本文とメモの確認'?{description:args.description,notes:args.notes}:task.title==='HTMLのメモ'?{notes:args.raw}:null;if(payload)await fetch('/api/tasks/'+task.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}}''',{'description':description,'notes':notes,'raw':raw_html})
     print(f'PASS {width}px embedded={embedded_mode}: two editors, no load writes, independent payloads, check/Space, Enter/Undo, reload, retry/poll, notes IME save guard, task switch, raw HTML preservation',flush=True)
     page.close()
   finally:browser.close()
 finally:server.terminate();server.wait(timeout=10)
