"""Round-trip JSON through download and import, with no Notion configuration."""
import os
import json
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as data:
    server=subprocess.Popen(['node','--input-type=module','-e',r'''
import {createServer} from 'node:http';
import {phaseFields} from './public/task-state.js';
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const store=new TaskStore(process.env.TEST_DATA+'/tasks.json');await store.init();
await store.saveCollection('categories',{name:'Empty'});
await store.create({title:'Todo'});
const done=await store.create({title:'Done'});await store.update(done.id,{...phaseFields('closed')});
for(let i=0;i<8;i++)await store.create({title:'Large '+i,notes:'x'.repeat(10000)});
const app=createTaskServer({store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public',auth:{token:'t'.repeat(32)}});
const port=await listen(app.server);
const bridge=createTaskServer({store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public',auth:{token:'b'.repeat(32),}}).server;
const bridgePort=await listen(bridge);
const prefix='/api/extensions/xangi-tasks/service/';
const proxy=createServer(async(req,res)=>{
 const embedded=req.url.startsWith(prefix);const path=embedded?'/'+req.url.slice(prefix.length):req.url;
 const chunks=[];for await(const c of req)chunks.push(c);
 const upstream=await fetch(`http://127.0.0.1:${embedded?bridgePort:port}${path}`,{method:req.method,headers:{Authorization:'Bearer '+(embedded?'b'.repeat(32):'t'.repeat(32)),'Content-Type':'application/json'},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
 res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});res.end(Buffer.from(await upstream.arrayBuffer()));
});
console.log(await listen(proxy));
'''],cwd=root,env={**os.environ,'TEST_DATA':data},stdout=subprocess.PIPE,text=True)
    try:
        port=server.stdout.readline().strip();assert port.isdigit()
        base='http://127.0.0.1:'+port
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
            try:
                for embedded in (False,True):
                    for width in (375,1280):
                        context=browser.new_context(viewport={'width':width,'height':850},accept_downloads=True)
                        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                        page.goto(base+('/api/extensions/xangi-tasks/service/' if embedded else '/'))
                        page.locator('#open-settings').click()
                        expect(page.locator('#notion-parent')).to_have_value('')
                        with page.expect_download() as download:
                            page.locator('#export-all').click()
                        file=Path(data)/f'export-{width}-{embedded}.json';download.value.save_as(file)
                        saved=json.loads(file.read_text());assert len(saved['tasks'])==10 and file.stat().st_size>65536
                        response=context.request.post(base+'/api/tasks',data={'title':'After export'});assert response.ok
                        page.locator('#import-file').set_input_files(str(file))
                        page.locator('#import-preview').click()
                        expect(page.locator('#transfer-status')).to_contain_text('現在の11件')
                        expect(page.locator('#import-confirm')).to_be_visible()
                        # Preview alone must not change the store.
                        assert len(context.request.get(base+'/api/tasks').json()['tasks'])==11
                        with page.expect_navigation():page.locator('#import-confirm').click()
                        restored=context.request.get(base+'/api/export').json()
                        assert len(restored['tasks'])==10
                        assert {t['id'] for t in restored['tasks']}=={t['id'] for t in saved['tasks']}
                        assert restored['collections']==saved['collections']
                        assert not errors,errors
                        context.close();print(f'PASS {width}px embedded={embedded}: JSON download, >64KiB preview, confirm, restore without Notion')
            finally:browser.close()
    finally:server.terminate();server.wait(timeout=10)
