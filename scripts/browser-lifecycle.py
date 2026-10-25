"""Verify lifecycle and execution controls through root and extension URL prefixes."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as data:
    server=subprocess.Popen(['node','--input-type=module','-e',r'''
import {createServer} from 'node:http';
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const store=new TaskStore(process.env.TEST_DATA+'/tasks.json');await store.init();
const app=createTaskServer({store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public',auth:{token:'t'.repeat(32)}});
const port=await listen(app.server);
const bridge=createTaskServer({store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public',auth:{token:'b'.repeat(32),}}).server;
const bridgePort=await listen(bridge);
const prefix='/api/extensions/xangi-tasks/service/';
const proxy=createServer(async(req,res)=>{
 const embedded=req.url.startsWith(prefix);const path=embedded?'/'+req.url.slice(prefix.length):req.url;
 const chunks=[];for await(const c of req)chunks.push(c);
 const response=await fetch(`http://127.0.0.1:${embedded?bridgePort:port}${path}`,{method:req.method,headers:{Authorization:'Bearer '+(embedded?'b'.repeat(32):'t'.repeat(32)),'Content-Type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
 res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(Buffer.from(await response.arrayBuffer()));
});
console.log(await listen(proxy));
'''],cwd=root,env={**os.environ,'TEST_DATA':data},stdout=subprocess.PIPE,text=True)
    try:
        port=server.stdout.readline().strip();assert port.isdigit()
        origin='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
            try:
                for embedded in (False,True):
                    for width in (1280,375):
                        context=browser.new_context(viewport={'width':width,'height':900})
                        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                        base=origin+('/api/extensions/xangi-tasks/service/' if embedded else '/')
                        page.goto(base,wait_until='networkidle')
                        title=f'Lifecycle {embedded} {width}'
                        response=page.request.post(base+'api/inbox',data={'title':title,'sourceText':'Please check the proposed work','sourceKey':title});assert response.ok
                        task_id=response.json()['task']['id']
                        page.locator('#refresh').click();page.locator('[data-filter=inbox]').click()
                        page.get_by_role('button',name=title+'の詳細を開く',exact=True).click()
                        expect(page.locator('#quick-status')).to_have_value('inbox')
                        expect(page.locator('#quick-execution')).to_have_value('idle')
                        expect(page.locator('#quick-execution')).to_be_disabled()
                        page.locator('#quick-status').select_option('open')
                        expect(page.locator('#quick-status')).to_have_value('open')
                        page.locator('#quick-execution').select_option('working')
                        expect(page.locator('#quick-execution')).to_have_value('working')
                        task=page.request.get(base+'api/tasks/'+task_id+'?history=0').json()['task']
                        assert task['status']=='open' and task['executionStatus']=='working'
                        page.locator('#quick-status').select_option('closed')
                        expect(page.locator('#quick-status')).to_have_value('closed')
                        expect(page.locator('#quick-execution')).to_have_value('idle')
                        page.locator('#close-detail').click();page.locator('[data-filter=closed]').click()
                        page.get_by_role('button',name=title+'の詳細を開く',exact=True).click()
                        page.locator('#quick-status').select_option('open')
                        expect(page.locator('#quick-status')).to_have_value('open')
                        expect(page.locator('#quick-execution')).to_have_value('idle')
                        page.locator('#close-detail').click()
                        dismissed=page.request.post(base+'api/inbox',data={'title':title+' dismissed','sourceText':'No longer needed'}).json()['task']['id']
                        assert page.request.post(base+'api/tasks/'+dismissed+'/dismiss',data={}).ok
                        page.locator('#refresh').click();page.locator('[data-filter=closed]').click()
                        page.get_by_role('button',name=title+' dismissedの詳細を開く',exact=True).click()
                        expect(page.locator('#detail-status')).to_contain_text('却下')
                        expect(page.locator('#quick-status')).to_have_value('closed')
                        page.locator('#close-detail').click();page.reload(wait_until='networkidle')
                        expect(page.locator('[data-filter=closed]')).to_have_class('nav-item active')
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                        assert not errors,errors
                        context.close();print('PASS lifecycle UI',embedded,width)
            finally:browser.close()
    finally:server.terminate();server.wait(timeout=10)
