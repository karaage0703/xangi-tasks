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
const app = createTaskServer({auth:{token:'sidebar-test-token-with-at-least-32-characters'},store,connector:{baseUrl:"http://127.0.0.1:18888",listProjects:async()=>[{id:"project",name:"開発",channel:{platform:"discord",channelId:"fixture"}}],health:async()=>({version:'fixture'}),readHistory:async()=>[],listAgents:async()=>[{id:"research",name:"調査",model:"fixture"}],dispatchTask:async()=>({sessionId:"fixture-session"}),readTaskSession:async()=>({state:"idle",result:"調査結果です"})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA': str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server did not start'
        base = 'http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (1280, 375):
                    page=browser.new_page(viewport={'width':width,'height':900},extra_http_headers={'Authorization':'Bearer sidebar-test-token-with-at-least-32-characters'})
                    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                    page.route('**/chat/fixture-session', lambda route: route.fulfill(content_type='text/html', body='<h1>Conversation</h1>'))
                    page.goto(base,wait_until='networkidle')
                    page.locator('.task-open').first.click()
                    page.route('**/api/agents',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":"fixture unavailable"}'))
                    page.locator('[data-action=delegate]').click()
                    expect(page.locator('#delegate-error')).to_contain_text('fixture unavailable')
                    expect(page.locator('#delegate-form [type=submit]')).to_be_disabled()
                    page.locator('#close-delegate').click()
                    page.unroute('**/api/agents')
                    page.locator('[data-action=delegate]').click()
                    expect(page.locator('#delegate-dialog')).to_be_visible()
                    page.locator('#delegate-agent').select_option('research')
                    page.locator('#save-default-agent').click()
                    expect(page.locator('#toast')).to_have_text('既定の依頼先を保存しました')
                    page.locator('#close-delegate').click()
                    page.reload(wait_until='networkidle')
                    page.locator('.task-open').first.click()
                    task_id=page.locator('.task-card.selected').get_attribute('data-id')
                    page.locator('[data-action=delegate]').click()
                    expect(page.locator('#delegate-agent')).to_have_value('research')
                    page.locator('#delegate-form [name=instructions]').fill('調査結果だけまとめて')
                    page.screenshot(path=str(output/f'delegation-{width}.png'),full_page=True)
                    page.locator('#delegate-form [type=submit]').click()
                    page.wait_for_url('**/chat/fixture-session')
                    page.goto(base,wait_until='networkidle')
                    page.locator('[data-filter=open]').click()
                    page.locator(f'.task-card[data-id="{task_id}"] .task-open').click()
                    expect(page.locator('[data-filter=open]')).to_have_class('nav-item active')
                    expect(page.locator('.task-card.selected')).to_be_visible()
                    task=page.request.get(base+'/api/tasks/'+task_id+'?history=0').json()['task']
                    assert task['agentId']=='research' and task['status']=='open' and task['executionStatus']=='running'
                    assert task['delegationInstructions']=='調査結果だけまとめて'
                    page.locator('[data-action=sync]').click()
                    expect(page.get_by_role('link',name='xangiの会話を開く')).to_have_attribute('href','http://127.0.0.1:18888/chat/fixture-session')
                    assert page.locator('#task-result').count()==0
                    page.locator('[data-action=delegate]').click()
                    page.locator('#delegate-project').select_option('project')
                    expect(page.locator('#delegate-agent')).to_be_disabled()
                    expect(page.locator('#delegate-project-hint')).to_contain_text('discord')
                    page.locator('#close-delegate').click()
                    assert not errors,errors
                    page.close();print('PASS agent selection/default/reload/delegation',width)
            finally:
                browser.close()
    finally:
        server.terminate(); server.wait(timeout=10)
