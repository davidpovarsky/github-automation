import test from 'node:test';
import assert from 'node:assert/strict';
import { RunState, resetConfigCacheForTests, resolveScopeEnabled } from '../worker/src/index.js';

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}

function harness({ config = { enabled: true, repositories: { '*': true }, branches: { '*': { '*': true } }, endExistingWhenDisabled: true }, run = {}, jobs = [], notifyFailure = false, configFailure = false } = {}) {
  resetConfigCacheForTests();
  const calls = [];
  const baseRun = { id: 42, run_attempt: 1, status: 'in_progress', conclusion: null, name: 'Build', head_branch: 'main', repository: { full_name: 'davidpovarsky/demo', owner: { login: 'davidpovarsky' } }, run_number: 7, html_url: 'https://github.com/davidpovarsky/demo/actions/runs/42', ...run };
  const baseJobs = jobs.length ? jobs : [{ id: 1, name: 'build', status: 'in_progress', conclusion: null, steps: [{ number: 1, name: 'Compile', status: 'in_progress' }] }];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value === 'https://raw.githubusercontent.com/davidpovarsky/github-automation/main/config.json') {
      if (configFailure) throw new Error('config unavailable');
      return new Response(JSON.stringify(config));
    }
    if (value.startsWith('https://api.github.com/repos/davidpovarsky/demo/actions/runs/42/jobs')) return new Response(JSON.stringify({ jobs: baseJobs }));
    if (value === 'https://api.github.com/repos/davidpovarsky/demo/actions/runs/42') return new Response(JSON.stringify(baseRun));
    if (value === 'https://api.github.com/repos/davidpovarsky/demo') return new Response(JSON.stringify({ full_name: 'davidpovarsky/demo', owner: { login: 'davidpovarsky' } }));
    if (value.startsWith('https://push.getnotifyapp.com/')) {
      const method = init.method || 'GET'; calls.push({ method, body: init.body ? JSON.parse(init.body) : null });
      if (notifyFailure) return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 });
      const responseBody = method === 'DELETE'
        ? { state: 'ended' }
        : (value.includes('/device') ? { activityId: 'LA123456' } : { state: 'active', activityId: 'LA123456' });
      return new Response(JSON.stringify(responseBody));
    }
    throw new Error(`unexpected URL ${value}`);
  };
  const storage = new Storage();
  const object = new RunState({ storage }, { GH_MONITOR_TOKEN: 'test', NOTIFY_DEVICE_ID: 'device', NOTIFY_DEVICE_TOKEN: 'token' });
  const request = event => new Request('https://worker.test/v1/refresh', { method: 'POST', body: JSON.stringify({ repository: 'davidpovarsky/demo', run_id: 42, run_attempt: 1, event }) });
  return { object, request, storage, calls };
}

async function body(response) { return response.json(); }

test('config matching honors global, repository, and branch disable rules', () => {
  const config = { enabled: true, repositories: { '*': true, 'davidpovarsky/demo': false }, branches: { '*': { '*': true }, 'davidpovarsky/demo': { main: false } } };
  assert.equal(resolveScopeEnabled(config, 'davidpovarsky/demo', 'main'), false);
  assert.equal(resolveScopeEnabled({ ...config, repositories: { '*': true, 'davidpovarsky/demo': true } }, 'davidpovarsky/demo', 'main'), false);
  assert.equal(resolveScopeEnabled({ ...config, enabled: false }, 'davidpovarsky/demo', 'main'), false);
});

test('100 simultaneous refreshes create exactly one activity', async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 100 }, () => h.object.fetch(h.request('refresh'))));
  assert.equal(responses.every(response => response.status === 200), true);
  assert.equal(h.calls.filter(call => call.body?.title === 'demo').length, 1);
  assert.equal((await h.storage.get('state')).activityId, 'LA123456');
});

test('duplicate burst requests are debounced and use the existing activity', async () => {
  const h = harness();
  await h.object.fetch(h.request('refresh'));
  const before = h.calls.length;
  const result = await body(await h.object.fetch(h.request('refresh')));
  assert.equal(result.debounced, true);
  assert.equal(h.calls.length, before);
});

test('completed run finalizes even when no activity exists', async () => {
  const h = harness({ run: { status: 'completed', conclusion: 'success' } });
  const result = await body(await h.object.fetch(h.request('final-hint')));
  const state = await h.storage.get('state');
  assert.equal(result.finalised, true);
  assert.equal(state.finalised, true);
  assert.equal(state.lifecycle, 'finalized');
  assert.equal(state.conclusion, 'success');
  assert.equal(h.calls.length, 0);
});

test('completed success, failure, and cancellation end the existing activity', async (t) => {
  for (const conclusion of ['success', 'failure', 'cancelled']) {
    await t.test(conclusion, async () => {
      const h = harness();
      await h.object.fetch(h.request('refresh'));
      const current = await h.storage.get('state');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).includes('/actions/runs/42') && !String(url).includes('/jobs')) return new Response(JSON.stringify({ id: 42, run_attempt: 1, status: 'completed', conclusion, name: 'Build', head_branch: 'main', repository: { full_name: 'davidpovarsky/demo', owner: { login: 'davidpovarsky' } }, run_number: 7 }));
        return originalFetch(url, init);
      };
      await h.object.fetch(h.request('final-hint'));
      assert.equal((await h.storage.get('state')).finalised, true);
      assert.equal(h.calls.at(-1).method, 'DELETE');
      assert.ok(current.activityId);
    });
  }
});

test('config failure fails closed when there is no last-known-good config', async () => {
  const h = harness({ configFailure: true });
  const result = await body(await h.object.fetch(h.request('refresh')));
  assert.equal(result.ok, true);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.storage.get('state')).activityId, '');
});

test('config failure uses last-known-good config rather than enabling by default', async () => {
  const h = harness();
  await h.object.fetch(h.request('refresh'));
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('raw.githubusercontent.com')) throw new Error('temporary config outage');
    return original(url, init);
  };
  const result = await body(await h.object.fetch(h.request('final-hint')));
  assert.equal(result.ok, true);
  assert.equal((await h.storage.get('state')).activityId, 'LA123456');
});

test('disabled config does not create an activity', async () => {
  const h = harness({ config: { enabled: false, repositories: { '*': true }, branches: {}, endExistingWhenDisabled: true } });
  await h.object.fetch(h.request('refresh'));
  assert.equal(h.calls.length, 0);
});

test('instrumentation steps are ignored in progress calculation', async () => {
  const h = harness({ jobs: [{ id: 1, name: 'build', status: 'in_progress', steps: [{ name: 'Live Activity · refresh', status: 'in_progress' }, { name: 'Real step', status: 'queued' }] }] });
  await h.object.fetch(h.request('refresh'));
  const update = h.calls.find(call => call.body?.metrics?.some(metric => metric.label === 'Step'));
  assert.equal(update.body.metrics.find(metric => metric.label === 'Step').value, 'Real step');
});

test('Notify failure remains retryable and does not persist a fake activity', async () => {
  const h = harness({ notifyFailure: true });
  const result = await body(await h.object.fetch(h.request('refresh')));
  assert.equal(result.ok, false);
  assert.equal((await h.storage.get('state')), undefined);
});

test('active runs schedule an alarm and final-hint uses the accelerated interval', async () => {
  const h = harness();
  await h.object.fetch(h.request('refresh'));
  assert.ok(h.storage.alarm > Date.now());
  const before = h.storage.alarm;
  await h.object.fetch(h.request('final-hint'));
  assert.ok(h.storage.alarm <= before);
});

test('run attempt mismatch is rejected before Notify', async () => {
  const h = harness();
  const response = await h.object.fetch(new Request('https://worker.test/v1/refresh', { method: 'POST', body: JSON.stringify({ repository: 'davidpovarsky/demo', run_id: 42, run_attempt: 2 }) }));
  assert.equal(response.status, 502);
  assert.equal(h.calls.length, 0);
});
