"""Native mouse and touch drag/drop checks against an isolated authenticated fixture."""
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
output = Path(os.environ.get('TEST_ARTIFACTS', '/tmp/tasks-drag-artifacts'))
output.mkdir(parents=True, exist_ok=True)
token = 'drag-test-token-with-at-least-32-characters'
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store=new TaskStore(process.env.TEST_DATA);await store.init();
const first=await store.saveCollection('folders',{name:'仕事'});
await store.saveCollection('folders',{name:'個人'});
await store.saveCollection('categories',{name:'開発',folderId:first.id});
await store.saveCollection('categories',{name:'読書'});
await store.create({title:'調査を進める',notes:'残すメモ'});
const app=createTaskServer({store,auth:{token:process.env.TEST_TOKEN},connector:{health:async()=>({version:'fixture'}),readHistory:async()=>[]},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA': str(Path(data)/'tasks.json'), 'TEST_TOKEN': token}, stdout=subprocess.PIPE, text=True)
    try:
        port=server.stdout.readline().strip();assert port.isdigit()
        base='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
            try:
                for width in (1280,375):
                    page=browser.new_page(viewport={'width':width,'height':1000},has_touch=width==375,extra_http_headers={'Authorization':'Bearer '+token})
                    page.set_default_timeout(10000)
                    writes=[]
                    page.on('request', lambda req: writes.append(req.post_data) if req.method=='PUT' else None)
                    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto(base,wait_until='networkidle')
                    task=page.request.get(base+'/api/tasks').json()['tasks'][0]
                    collections=page.request.get(base+'/api/collections').json()
                    category=next(c for c in collections['categories'] if c['name']=='開発')
                    folder=next(f for f in collections['folders'] if f['name']=='個人')
                    category_target=page.locator(f'[data-drop-kind=category][data-drop-id="{category["id"]}"]')
                    folder_target=page.locator(f'[data-drop-kind=folder][data-drop-id="{folder["id"]}"]')
                    task_source=page.locator('.task-open')
                    def saved_task(category_id):
                        page.wait_for_function("async ([id,cat]) => (await (await fetch('api/tasks/'+id)).json()).task.categoryId===cat",arg=[task['id'],category_id])
                        expect(page.locator('#toast')).to_contain_text('カテゴリを変更しました')
                        assert page.request.get(base+'/api/tasks/'+task['id']).json()['task']['categoryId']==category_id
                    def pointer_move(source,target,touch=False,cancel=False):
                        source.scroll_into_view_if_needed()
                        a=source.bounding_box();b=target.bounding_box() or {'x':a['x']+12,'y':a['y'],'width':a['width'],'height':a['height']}
                        start=(a['x']+a['width']/2,a['y']+a['height']/2)
                        end=(b['x']+b['width']/2,b['y']+b['height']/2)
                        if touch:
                            cdp=page.context.new_cdp_session(page)
                            cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':start[0],'y':start[1]}]})
                            for step in range(1,16):
                                cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':start[0]+(end[0]-start[0])*step/15,'y':start[1]+(end[1]-start[1])*step/15}]})
                            target.scroll_into_view_if_needed()
                            b=target.bounding_box()
                            cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':b['x']+b['width']/2,'y':b['y']+b['height']/2}]})
                            if not cancel: expect(target).to_have_class(re.compile('drop-active'))
                            cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel' if cancel else 'touchEnd','touchPoints':[]});cdp.detach()
                        else:
                            page.mouse.move(*start);page.mouse.down();page.mouse.move(*end,steps=15)
                            target.scroll_into_view_if_needed()
                            b=target.bounding_box();page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2,steps=3)
                            if not cancel: expect(target).to_have_class(re.compile('drop-active'))
                            if cancel:page.keyboard.press('Escape')
                            page.mouse.up()
                    if width==1280:
                        task_source.drag_to(category_target)
                    else:
                        pointer_move(page.get_by_role('button',name='調査を進めるの移動',exact=True),category_target,touch=True)
                    saved_task(category['id'])
                    assert page.request.get(base+'/api/tasks/'+task['id']).json()['task']['notes']=='残すメモ'
                    # Return the task to uncategorized, using the dedicated grip.
                    pointer_move(page.get_by_role('button',name='調査を進めるの移動',exact=True),page.locator('[data-drop-kind=category][data-drop-id=""]'),touch=width==375)
                    saved_task('')
                    if width==375: page.locator('#open-categories').click()
                    if width==1280:
                        category_target.drag_to(folder_target)
                    else:
                        pointer_move(page.get_by_role('button',name='開発の移動',exact=True),folder_target,touch=True)
                    page.wait_for_function("async ([id,folder]) => (await (await fetch('api/collections')).json()).categories.find(c=>c.id===id).folderId===folder",arg=[category['id'],folder['id']])
                    expect(page.locator('#toast')).to_have_text('カテゴリを移動しました')
                    page.reload(wait_until='networkidle')
                    if width==375: page.locator('#open-categories').click()

                    expect(page.locator(f'.category-folder[data-id="{folder["id"]}"] [data-move-id="{category["id"]}"]')).to_have_count(1)
                    # The transient root target removes a category from its folder.
                    pointer_move(page.get_by_role('button',name='開発の移動',exact=True),page.locator('.category-root-drop'),touch=width==375)
                    expect(page.locator('#toast')).to_have_text('カテゴリを移動しました')
                    expect(page.locator('#category-tree > .category-row [data-move-id="'+category['id']+'"]')).to_have_count(1)
                    assert next(c for c in page.request.get(base+'/api/collections').json()['categories'] if c['id']==category['id'])['folderId']==''
                    before_writes=len(writes)
                    if width==375:
                        page.locator('#close-categories').click()
                        pointer_move(page.get_by_role('button',name='調査を進めるの移動',exact=True),folder_target,touch=True,cancel=True)
                    else: task_source.drag_to(folder_target)
                    assert len(writes)==before_writes  # Tasks cannot be assigned directly to folders.
                    if width==1280:
                        task_source.click()
                        page.locator('#detail-title').fill('')
                        task_source.drag_to(category_target)
                        expect(page.locator('#toast')).to_contain_text('保存が完了してから')
                        assert page.request.get(base+'/api/tasks/'+task['id']).json()['task']['categoryId']==''
                        expect(page.locator('#detail-title')).to_have_value('')
                        page.locator('#detail-title').fill('調査を進める')
                        page.locator('#detail-title').press('Tab')
                        expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                        expect(page.locator('#detail-title')).to_be_enabled()
                        page.locator('#close-detail').click()
                        expect(page.locator('.task-card.selected')).to_have_count(0)
                    # Touch/native cancellation must not move a task.
                    pointer_move(page.get_by_role('button',name='調査を進めるの移動',exact=True),category_target,touch=width==375,cancel=True)
                    assert page.request.get(base+'/api/tasks/'+task['id']).json()['task']['categoryId']==''
                    # A rejected save must leave the original category unchanged.
                    def reject(route):
                        if route.request.method=='PUT':route.fulfill(status=500,json={'error':'テスト用保存失敗'})
                        else:route.continue_()
                    page.route('**/api/tasks/'+task['id'],reject)
                    pointer_move(page.get_by_role('button',name='調査を進めるの移動',exact=True),category_target,touch=width==375)
                    expect(page.locator('#toast')).to_contain_text('移動できませんでした')
                    assert page.request.get(base+'/api/tasks/'+task['id']).json()['task']['categoryId']==''
                    page.unroute('**/api/tasks/'+task['id'],reject)
                    if width==375: page.locator('#open-categories').click()
                    page.get_by_role('button',name='開発の移動',exact=True).focus()
                    page.keyboard.press('Enter')
                    expect(page.locator('#collection-dialog')).to_be_visible()
                    page.locator('#close-collection').click()
                    # Reset folder through the existing form for the next viewport.
                    page.get_by_role('button',name='開発を編集',exact=True).click()
                    page.locator('#collection-form [name=folderId]').select_option(label='仕事')
                    page.locator('#collection-form').get_by_role('button',name='保存',exact=True).click()
                    expect(page.locator('#collection-dialog')).not_to_be_visible()
                    page.screenshot(path=str(output/f'drag-{width}.png'),full_page=True)
                    assert not errors,errors
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    print(f'{width}px: task/category moves, uncategorized, persistence, cancel, save failure, keyboard alternative passed',flush=True)
                    page.close()
            finally:browser.close()
    finally:server.terminate();server.wait(timeout=10)
