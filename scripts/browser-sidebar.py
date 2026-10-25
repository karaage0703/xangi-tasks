"""Isolated UI verification: uv run --with playwright python scripts/browser-sidebar.py."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
output = Path(os.environ.get('TEST_ARTIFACTS', '/tmp/tasks-sidebar-artifacts'))
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store = new TaskStore(process.env.TEST_DATA); await store.init();
await store.create({title:'仕様をまとめる', description:'詳細を見ながら一覧を操作する'});
await store.create({title:'次の作業を確認する'});
const app = createTaskServer({auth:{token:'sidebar-test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'}),readHistory:async()=>[]},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA': str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server did not start'
        base = 'http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (1280, 950, 375):
                    page=browser.new_page(viewport={'width':width,'height':900}, extra_http_headers={'Authorization':'Bearer sidebar-test-token-with-at-least-32-characters'})
                    errors=[]
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.goto(base,wait_until='networkidle')
                    if width==375:
                        expect(page.locator('.category-sidebar')).not_to_be_visible()
                        page.screenshot(path=str(output/'mobile-list.png'),full_page=True)
                        page.locator('#open-categories').click()
                        expect(page.locator('#close-categories')).to_be_focused()
                        page.keyboard.press('Shift+Tab')
                        expect(page.locator('#add-folder')).to_be_focused()
                        page.keyboard.press('Tab')
                        expect(page.locator('#close-categories')).to_be_focused()
                        page.keyboard.press('Escape')
                        expect(page.locator('#open-categories')).to_be_focused()
                        page.locator('#open-categories').click()
                        page.locator('#category-backdrop').click(position={'x':365,'y':500})
                        expect(page.locator('.category-sidebar')).not_to_be_visible()
                        page.locator('#open-categories').click()
                        page.set_viewport_size({'width':1280,'height':900})
                        expect(page.locator('.category-sidebar')).to_be_visible()
                        page.set_viewport_size({'width':375,'height':900})
                        expect(page.locator('.category-sidebar')).not_to_be_visible()
                        page.locator('#open-categories').click()
                    page.locator('#add-folder').click()
                    form=page.locator('#collection-form')
                    form.locator('[name=name]').fill(f'仕事{width}')
                    form.get_by_role('button',name='保存',exact=True).click()
                    expect(form).not_to_be_visible()
                    page.locator('#add-category').click()
                    form.locator('[name=name]').fill(f'開発{width}')
                    form.locator('[name=folderId]').select_option(label=f'仕事{width}')
                    form.get_by_role('button',name='保存',exact=True).click()
                    expect(form).not_to_be_visible()
                    folder_button = page.get_by_role('button',name=f'仕事{width}フォルダを編集',exact=True)
                    category_button = page.get_by_role('button',name=f'開発{width}を編集',exact=True)
                    expect(folder_button).to_be_visible()
                    expect(category_button).to_be_visible()
                    assert abs(folder_button.bounding_box()['x'] - category_button.bounding_box()['x']) < 1
                    if width==375:
                        page.screenshot(path=str(output/'mobile-menu.png'),full_page=True)
                        page.locator('#close-categories').click()
                    page.get_by_role('button',name='仕様をまとめるの詳細を開く',exact=True).click()
                    expect(page.locator('#detail-title')).to_have_value('仕様をまとめる')
                    assert page.locator('#task-dialog').evaluate('(e)=>e.matches(":modal")') == (width==375)
                    page.locator('#quick-category').select_option(label=f'仕事{width} / 開発{width}')
                    expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                    page.locator('#detail-notes').fill(f'保存確認{width}')
                    page.locator('#detail-notes').press('Tab')
                    expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                    if width==1280:
                        page.locator('#detail-title').fill('')
                        page.get_by_role('button',name='仕様をまとめるの詳細を開く',exact=True).click()
                        expect(page.locator('#detail-title')).to_have_value('')
                        page.get_by_role('button',name='次の作業を確認するの詳細を開く',exact=True).click()
                        expect(page.locator('#detail-title')).to_have_value('')
                        page.locator('#detail-title').fill('仕様をまとめる')
                        page.locator('#detail-title').press('Tab')
                        expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                        workspace=page.locator('.workspace').bounding_box()
                        panel=page.locator('#task-dialog').bounding_box()
                        assert panel['x'] >= workspace['x']+workspace['width']
                        page.get_by_role('button',name='次の作業を確認するの詳細を開く',exact=True).click()
                        expect(page.locator('#detail-title')).to_have_value('次の作業を確認する')
                        page.get_by_role('button',name='仕様をまとめるの詳細を開く',exact=True).click()
                        page.set_viewport_size({'width':375,'height':900})
                        expect(page.locator('#task-dialog:modal')).to_be_visible()
                        expect(page.locator('#detail-title')).to_have_value('仕様をまとめる')
                        page.set_viewport_size({'width':1280,'height':900})
                        expect(page.locator('#task-dialog')).to_be_visible()
                        expect(page.locator('#task-dialog:modal')).to_have_count(0)
                    page.locator('#task-dialog .detail-shell').evaluate('(e)=>e.scrollTop=0')
                    page.screenshot(path=str(output/f'sidebar-{width}.png'),full_page=True)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.locator('#close-detail').click()
                    expect(page.locator('#task-dialog')).not_to_be_visible()
                    if width==375: page.locator('#open-categories').click()
                    page.get_by_role('button',name=f'開発{width}',exact=True).click()
                    if width==375: expect(page.locator('.category-sidebar')).not_to_be_visible()
                    expect(page.locator('.task-card')).to_have_count(1)
                    page.locator('#open-create').click()
                    create=page.locator('#task-form')
                    expect(create.locator('[name=categoryId] option:checked')).to_have_text(f'仕事{width} / 開発{width}')
                    create.locator('[name=title]').fill(f'新しい作業{width}')
                    create.get_by_role('button',name='追加',exact=True).click()
                    expect(create).not_to_be_visible()
                    expect(page.locator('.task-card')).to_have_count(2)
                    page.reload(wait_until='networkidle')
                    page.get_by_role('button',name='仕様をまとめるの詳細を開く',exact=True).click()
                    expect(page.locator('#detail-notes')).to_have_value(f'保存確認{width}')
                    expect(page.locator('#quick-category option:checked')).to_have_text(f'仕事{width} / 開発{width}')
                    page.locator('#close-detail').click()
                    page.locator('#theme-select').select_option('dark')
                    if width==375: page.locator('#open-categories').click()
                    page.get_by_role('button',name=f'開発{width}を編集',exact=True).click()
                    form.locator('[name=folderId]').select_option('')
                    form.get_by_role('button',name='保存',exact=True).click()
                    expect(form).not_to_be_visible()
                    assert not errors,errors
                    print(f'{width}px: folder/category creation, assignment, notes, switch, close, filter, reload, move passed',flush=True)
                    page.close()
            finally:
                browser.close()
    finally:
        server.terminate(); server.wait(timeout=10)
