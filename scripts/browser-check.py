"""Run with uv run --with playwright python scripts/browser-check.py."""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.getenv('CHROMIUM_EXECUTABLE','/snap/bin/chromium'),args=['--no-sandbox'])
  try:
   for width in (1180,375):
    for entry in ('http://tasks.test:4180/','http://tasks.test:18888/api/extensions/xangi-tasks/ui'):
     page=await browser.new_page(viewport={'width':width,'height':812})
     errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     async def route(r):
      path=r.request.url
      if '/chat/session-test' in path:
       await r.fulfill(body='<h1>xangi conversation</h1>',content_type='text/html');return
      if path.endswith('/api/tasks'):
       await r.fulfill(json={'tasks':[{'id':'one','title':'会話リンク確認','description':'背景','status':'review','xangiSessionId':'session-test','updatedAt':'2026-10-07T00:00:00Z'}]});return
      if path.endswith('/api/health'):
       await r.fulfill(json={'xangi':{'connected':True,'version':'test'}});return
      filename=path.rsplit('/',1)[-1]
      filename='index.html' if filename in ('','ui') else filename
      text=(ROOT/'public'/filename).read_text()
      if filename=='index.html' and '/extensions/' in path:text=text.replace('<head>','<head><base href="./service/">')
      await r.fulfill(body=text,content_type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[Path(filename).suffix])
     await page.route('http://tasks.test*/**',route)
     await page.goto(entry,wait_until='networkidle')
     await page.locator('[data-filter=all]').click()
     link=page.get_by_role('link',name='会話を開く',exact=True)
     assert await link.get_attribute('href')=='http://tasks.test:18888/chat/session-test'
     await link.click()
     await page.get_by_role('heading',name='xangi conversation').wait_for()
     assert not errors,errors
     print(f'{width}px {entry}: native conversation link passed',flush=True)
     await page.close()
  finally:await browser.close()
asyncio.run(main())
