import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Exercise the actual submit handler without introducing a DOM dependency.
const urlFunction = source.slice(source.indexOf('function conversationUrl('), source.indexOf('\nfunction renderTaskActions('));
const submitHandler = source.slice(source.indexOf("delegateForm.addEventListener('submit'"), source.indexOf('\n\nconst notionPanel'));

function harness({ popup = 'allowed', embedded = true } = {}) {
  const events = [];
  let submit;
  let accept;
  let reject;
  const response = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  const tab = { closed: false, opener: {}, document: {}, location: { replace: href => events.push(['navigate', href]) }, close() { this.closed = true; events.push(['close']); } };
  const button = { disabled: false };
  const busy = new Set();
  const context = vm.createContext({
    URL,
    location: { pathname: embedded ? '/api/extensions/xangi-tasks/' : '/', origin: 'https://xangi.example', hostname: 'tasks.example', assign() { assert.fail('must preserve tasks tab'); } },
    state: { busy },
    delegateForm: {
      dataset: { id: 'task-1' },
      elements: { agentId: { value: 'agent' }, projectId: { value: '' }, instructions: { value: 'do work' } },
      querySelector: () => button,
      addEventListener(event, handler) { assert.equal(event, 'submit'); submit = handler; },
    },
    defaultAgentButton: { disabled: false },
    delegateDialog: { close: () => events.push(['dialog-close']) },
    window: { open(url, target) {
      events.push(['open', url, target]);
      if (popup === 'throws') throw new Error('Popup unavailable');
      return popup === 'blocked' ? null : tab;
    } },
    document: { querySelector: () => ({ click: () => events.push(['open-filter']) }) },
    api: (path, options) => { events.push(['api', path, JSON.parse(options.body)]); return response; },
    delegationError: message => events.push(['error', message]),
    showToast: message => events.push(['toast', message]),
    loadTasks: async () => events.push(['load-tasks']),
    loadTaskDetail: async () => events.push(['load-detail']),
    render() {}, renderDetail() {},
  });
  vm.runInContext(`let submittingDelegation = false;\n${urlFunction}\n${submitHandler}`, context);
  return { events, tab, button, busy, accept, reject, submit: () => submit({ preventDefault() {} }) };
}
const accepted = { task: { xangiSessionId: 'session/id' }, xangiOrigin: 'http://127.0.0.1:8000' };

test('reserves tab before delayed acceptance, prevents duplicate sends, keeps tasks open', async () => {
  const h = harness();
  const pending = h.submit();
  assert.ok(h.events.findIndex(e => e[0] === 'open') < h.events.findIndex(e => e[0] === 'api'));
  assert.equal(h.tab.opener, null);
  assert.equal(h.events.some(e => e[0] === 'navigate'), false);
  await h.submit();
  assert.equal(h.events.filter(e => e[0] === 'api').length, 1);
  h.accept(accepted);
  await pending;
  assert.deepEqual(h.events.find(e => e[0] === 'navigate'), ['navigate', 'https://xangi.example/chat/session%2Fid']);
  assert.equal(h.tab.closed, false);
  assert.ok(h.events.some(e => e[0] === 'load-detail'));
  assert.equal(h.button.disabled, false);
  assert.equal(h.busy.size, 0);
});

for (const popup of ['blocked', 'throws']) {
  test(`${popup} popup still submits and offers the conversation link`, async () => {
    const h = harness({ popup });
    const pending = h.submit(); h.accept(accepted); await pending;
    assert.ok(h.events.some(e => e[0] === 'toast' && e[1].includes('xangiの会話を開く')));
    assert.equal(h.events.some(e => e[0] === 'navigate'), false);
  });
}

test('failure closes the reserved tab and retains the error', async () => {
  const h = harness();
  const pending = h.submit(); h.reject(new Error('request failed')); await pending;
  assert.equal(h.tab.closed, true);
  assert.ok(h.events.some(e => e[0] === 'error' && e[1] === 'request failed'));
  assert.equal(h.events.some(e => e[0] === 'navigate'), false);
});

test('a manually closed tab is not reopened after acceptance', async () => {
  const h = harness();
  const pending = h.submit(); h.tab.closed = true; h.accept(accepted); await pending;
  assert.equal(h.events.filter(e => e[0] === 'open').length, 1);
  assert.equal(h.events.some(e => e[0] === 'navigate'), false);
  assert.ok(h.events.some(e => e[0] === 'toast' && e[1].includes('xangiの会話を開く')));
});

test('response without a conversation closes the unused tab', async () => {
  const h = harness();
  const pending = h.submit(); h.accept({ task: {} }); await pending;
  assert.equal(h.tab.closed, true);
  assert.ok(h.events.some(e => e[0] === 'toast' && e[1] === 'xangiへ依頼しました'));
});

test('standalone page preserves host rewriting for the new conversation tab', async () => {
  const h = harness({ embedded: false });
  const pending = h.submit(); h.accept(accepted); await pending;
  assert.deepEqual(h.events.find(e => e[0] === 'navigate'), ['navigate', 'http://tasks.example:8000/chat/session%2Fid']);
});
