"""Verify goal/deadline colors and labels across Japan calendar boundaries."""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as data:
    server = subprocess.Popen(['node', '--input-type=module', '-e', '''
import {TaskStore} from './src/task-store.js';
import {createTaskServer} from './src/app.js';
const store = new TaskStore(process.env.TEST_DATA); await store.init();
for (const [title, day] of [['昨日','2026-11-10'],['今日','2026-11-11'],['明日','2026-11-12']]) {
  await store.create({title, targetDate:day, deadlineAt:day});
}
await store.create({title:'日付なし'});
const closed = await store.create({title:'完了', targetDate:'2026-11-10', deadlineAt:'2026-11-10'});
await store.complete(closed.id);
const inbox = await store.createInboxItem({title:'候補', sourceText:'fixture'});
await store.update(inbox.id, {targetDate:'2026-11-10', deadlineAt:'2026-11-10'});
const app = createTaskServer({auth:{token:'test-token-with-at-least-32-characters'},store,connector:{health:async()=>({version:'fixture'})},publicDir:process.cwd()+'/public'});
app.server.listen(0,'127.0.0.1',()=>console.log(app.server.address().port));
'''], cwd=root, env={**os.environ, 'TEST_DATA':str(Path(data)/'tasks.json')}, stdout=subprocess.PIPE, text=True)
    try:
        port = server.stdout.readline().strip()
        assert port.isdigit(), 'fixture server failed'
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE'), args=['--no-sandbox'])
            try:
                for width in (375, 1280):
                    for theme in ('light', 'dark'):
                        context = browser.new_context(viewport={'width':width,'height':850}, timezone_id='America/Los_Angeles', extra_http_headers={'Authorization':'Bearer test-token-with-at-least-32-characters'})
                        page = context.new_page()
                        page.clock.install(time='2026-11-10T15:00:00Z')
                        page_errors = []
                        page.on('pageerror', lambda error: page_errors.append(str(error)))
                        # Match the extension host: HTML/API proxying without local asset routes.
                        base = 'http://127.0.0.1:' + port
                        prefix = '/api/extensions/xangi-tasks/ui/'
                        def embedded_route(route):
                            suffix = route.request.url.split(prefix, 1)[1]
                            if suffix.split('?', 1)[0].endswith(('.js', '.css')):
                                route.fulfill(status=404, content_type='application/json', body='{}')
                            else:
                                response = route.fetch(url=base + '/' + suffix)
                                route.fulfill(response=response)
                        page.route('**' + prefix + '**', embedded_route)
                        page.goto(base + prefix)
                        page.locator('#theme-select').select_option(theme)

                        def row(title):
                            return page.locator('.task-card', has=page.get_by_role('heading', name=title, exact=True))

                        def options():
                            page.locator('.list-options-disclosure').evaluate('(node) => node.open = true')

                        expect(row('昨日').locator('.row-due.goal-passed')).to_have_text('目標日超過 2026-11-10')
                        expect(row('今日').locator('.row-due.goal-today')).to_have_text('今日の目標 2026-11-11')
                        expect(row('明日').locator('.row-due')).to_have_text('目標日 2026-11-12')
                        expect(row('日付なし').locator('.row-due')).to_have_count(0)
                        options()
                        page.locator('[data-display=deadline]').check()
                        expect(row('昨日').locator('.row-due.overdue')).to_have_text('締切超過 2026-11-10')
                        expect(row('今日').locator('.row-due.deadline-today')).to_have_text('今日が締切 2026-11-11')
                        expect(row('明日').locator('.row-due.overdue, .row-due.deadline-today')).to_have_count(0)
                        # Compare computed colors so a missing/overridden stylesheet fails too.
                        normal = row('明日').locator('.row-due').first.evaluate('(n) => getComputedStyle(n).color')
                        for title, cls in [('昨日','goal-passed'),('今日','goal-today'),('昨日','overdue'),('今日','deadline-today')]:
                            assert row(title).locator('.'+cls).evaluate('(n) => getComputedStyle(n).color') != normal
                        page.locator('.list-options-disclosure').evaluate('(node) => node.open = false')
                        if os.environ.get('OVERDUE_SCREENSHOTS'):
                            page.screenshot(path=str(Path(os.environ['OVERDUE_SCREENSHOTS']) / f'{width}-{theme}.png'))
                        # Tabs have independent preferences; enable both date fields on All.
                        page.locator('[data-filter=all]').click()
                        options()
                        page.locator('[data-display=deadline]').check()
                        expect(row('完了').locator('.goal-passed, .goal-today, .overdue, .deadline-today')).to_have_count(0)
                        if width == 375:
                            page.locator('#open-categories').click()
                        page.locator('[data-filter=inbox]').click()
                        expect(row('候補').locator('.goal-passed, .goal-today, .overdue, .deadline-today')).to_have_count(0)
                        if width == 375:
                            page.locator('#open-categories').click()
                        page.get_by_role('button', name='すべてのカテゴリ', exact=True).click()
                        options()
                        page.locator('[data-display=targetDate]').uncheck()
                        expect(row('今日').locator('.goal-today')).to_have_count(0)
                        page.locator('[data-display=targetDate]').check()
                        # Reject later goals in the create form with a visible warning.
                        order_title = f'日付順序テスト{width}{theme}'
                        page.locator('#open-create').click()
                        form = page.locator('#task-form')
                        form.locator('[name=title]').fill(order_title)
                        form.locator('[name=targetDate]').fill('2026-11-20')
                        form.locator('[name=deadlineAt]').fill('2026-11-19')
                        form.locator('[type=submit]').click()
                        expect(page.locator('#create-target-warning')).to_contain_text('目標日は締め切り日以前')
                        expect(row(order_title)).to_have_count(0)
                        if os.environ.get('OVERDUE_SCREENSHOTS'):
                            page.screenshot(path=str(Path(os.environ['OVERDUE_SCREENSHOTS']) / f'{width}-{theme}-date-warning.png'))
                        # Equal dates are allowed through the same form.
                        form.locator('[name=targetDate]').fill('2026-11-19')
                        form.locator('[type=submit]').click()
                        expect(row(order_title)).to_be_visible()
                        row('明日').locator('.task-open').click()
                        goal_input = page.locator('#quick-edit [name=targetDate]')
                        goal_input.fill('2026-11-13')
                        goal_input.press('Tab')
                        expect(page.locator('#quick-target-warning')).to_contain_text('目標日は締め切り日以前')
                        expect(goal_input).to_have_attribute('aria-invalid', 'true')
                        warning = page.locator('#quick-target-warning')
                        assert warning.evaluate('(n) => getComputedStyle(n).color') != page.locator('#quick-save-status').evaluate('(n) => getComputedStyle(n).color')
                        assert goal_input.evaluate('(n) => getComputedStyle(n).borderTopColor') == warning.evaluate('(n) => getComputedStyle(n).color')
                        assert goal_input.evaluate('(n) => n.closest("label").nextElementSibling.id') == 'quick-target-warning'
                        if os.environ.get('OVERDUE_SCREENSHOTS'):
                            page.screenshot(path=str(Path(os.environ['OVERDUE_SCREENSHOTS']) / f'{width}-{theme}-inline-warning.png'))
                        # The list retains the saved date after the rejected autosave.
                        expect(row('明日').locator('.row-due').first).to_have_text('目標日 2026-11-12')
                        goal_input.fill('2026-11-12')
                        goal_input.press('Tab')
                        expect(page.locator('#quick-save-status')).to_have_text('保存しました')
                        expect(page.locator('#quick-target-warning')).to_be_hidden()
                        expect(goal_input).to_have_attribute('aria-invalid', 'false')
                        page.locator('#close-detail').click()
                        # Next JST midnight: same tasks, refresh only via the existing polling loop.
                        page.clock.fast_forward('24:00:05')
                        expect(row('今日').locator('.goal-passed')).to_have_text('目標日超過 2026-11-11')
                        expect(row('今日').locator('.overdue')).to_have_text('締切超過 2026-11-11')
                        expect(row('明日').locator('.goal-today')).to_have_text('今日の目標 2026-11-12')
                        expect(row('明日').locator('.deadline-today')).to_have_text('今日が締切 2026-11-12')
                        page.locator('[data-filter=today]').click()
                        expect(page.locator('.task-card')).to_have_count(1)
                        expect(row('明日')).to_be_visible()
                        assert not page_errors, page_errors
                        context.close()
                print('PASS: embedded extension route without static module routes, no JS errors, date-order create rejection/warning, same-day save, autosave rejection/recovery, goal/deadline colors and text, future/undated/closed/inbox, display options, JST midnight and Today view, light/dark at 375/1280px')
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
