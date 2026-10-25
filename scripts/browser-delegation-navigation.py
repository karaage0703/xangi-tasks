"""Verify request acceptance navigates to the chat before the AI finishes (no live sends)."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', r'''
import {createServer} from 'node:http';
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
import {XangiConnector} from './src/xangi-connector.js';
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const token = 'fixture-token-with-at-least-32-characters';
let sequence=0;
const fake = createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/projects') return res.end(JSON.stringify({projects:[{id:'project',name:'Project',channel:{platform:'discord'}}]}));
  if(req.url==='/api/agents') return res.end('{"agents":[]}');
  if(req.url==='/api/sessions') return res.end(JSON.stringify({sessionId:'thread-'+(++sequence)}));
  if(req.url.endsWith('/discord-continue')) {
    // Longer than the connector metadata timeout. No Discord or agent is called.
    await new Promise(resolve=>setTimeout(resolve,1500));
    return res.end('{"ok":true}');
  }
  if(req.url.startsWith('/api/sessions/')) return res.end('{"isActive":true,"lifecycle":"open","messages":[]}');
  res.end('{}');
});
const fakePort=await listen(fake);
const store=new TaskStore(process.env.TEST_DATA);await store.init();
await store.saveSettings({projectId:'project',agentId:''});
const connector=new XangiConnector({baseUrl:`http://127.0.0.1:${fakePort}`,timeoutMs:100});
const app=createTaskServer({store,connector,auth:{token},publicDir:process.env.TEST_PUBLIC_DIR||process.cwd()+'/public'});
const appPort=await listen(app.server);
const bridge=createTaskServer({store,connector,auth:{token,},publicDir:process.env.TEST_PUBLIC_DIR||process.cwd()+'/public'}).server;
const bridgePort=await listen(bridge);
const prefix='/api/extensions/xangi-tasks/service/';
const proxy=createServer(async(req,res)=>{
  if(req.url.startsWith('/chat/')) {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>依頼先の会話</h1>');return;}
  const embedded=req.url.startsWith(prefix);
  const path=embedded?'/'+req.url.slice(prefix.length):req.url;
  if(path==='/fixture/new') {await store.create({title:'画面遷移の確認'});res.end('{}');return;}
  const body=[];for await(const chunk of req)body.push(chunk);
  const response=await fetch(`http://127.0.0.1:${embedded?bridgePort:appPort}${path}`,{method:req.method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body.length?{body:Buffer.concat(body)}:{})});
  let content=await response.text();
  // Standalone navigates to the configured xangi origin; use this fixture origin.
  if(response.headers.get('content-type')?.includes('application/json'))content=content.replaceAll(`http://127.0.0.1:${fakePort}`,`http://localhost:${proxy.address().port}`);
  res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(content);
});
console.log(await listen(proxy));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port=server.stdout.readline().strip()
        assert port.isdigit(), port
        base='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
            try:
                for embedded in (False,True):
                    for width in (375,1280):
                        context=browser.new_context(viewport={'width':width,'height':850},is_mobile=width==375,has_touch=width==375)
                        page=context.new_page(); errors=[]
                        page.on('pageerror',lambda error:errors.append(str(error)))
                        context.request.get(base+'/fixture/new')
                        page.goto(base+('/api/extensions/xangi-tasks/service/' if embedded else '/'))
                        page.locator('.task-open',has_text='画面遷移の確認').first.click()
                        page.locator('#task-dialog').get_by_role('button',name='xangiへ依頼',exact=True).click()
                        expect(page.locator('#delegate-form button[type=submit]')).to_be_enabled()
                        page.locator('#delegate-form button[type=submit]').click()
                        page.wait_for_url('**/chat/thread-*',timeout=5000)
                        expect(page.get_by_role('heading',name='依頼先の会話')).to_be_visible()
                        assert len(context.pages)==1, 'must navigate in the same tab'
                        assert not errors, errors
                        print(f'PASS: width={width}, embedded={embedded}, same-tab chat navigation')
                        context.close()
            finally:browser.close()
    finally:
        server.terminate();server.wait(timeout=10)
