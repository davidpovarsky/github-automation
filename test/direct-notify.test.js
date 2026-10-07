'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  executeDirectNotify,
  normalizeConfig,
  resolveScopeEnabled,
  short,
  runUrl,
  runButton,
  visibleStep,
  activityView,
  statusFor,
  matchingActivities,
  sortActivities,
  resetConfigCacheForTests,
} = require('../live-refresh/index.js');

const {
  instrument,
  renderRefresh,
  shouldSkipWorkflow,
} = require('../scripts/instrument-workflows.js');

function createHarness({
  run = {},
  jobs = [],
  config = { enabled: true, repositories: { '*': true }, branches: { '*': { '*': true } }, endExistingWhenDisabled: true },
  configFailure = false,
  githubFailure = false,
  notifyFailure = false,
  activities = [],
  onStart = null,
} = {}) {
  resetConfigCacheForTests();
  const calls = [];
  const baseRun = {
    id: 42,
    run_attempt: 1,
    status: 'in_progress',
    conclusion: null,
    name: 'CI Workflow',
    head_branch: 'main',
    repository: { full_name: 'davidpovarsky/demo', owner: { login: 'davidpovarsky' } },
    run_number: 12,
    html_url: 'https://github.com/davidpovarsky/demo/actions/runs/42',
    ...run,
  };
  const baseJobs = jobs.length
    ? jobs
    : [
        {
          id: 101,
          name: 'Build Job',
          status: 'in_progress',
          conclusion: null,
          steps: [
            { number: 1, name: 'Setup', status: 'completed' },
            { number: 2, name: 'Live Activity · refresh', status: 'in_progress' },
            { number: 3, name: 'Compile App', status: 'queued' },
          ],
        },
      ];

  const currentActivities = [...activities];

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: urlStr, method, body, headers: init.headers });

    if (urlStr.includes('raw.githubusercontent.com')) {
      if (configFailure) throw new Error('Simulated config network error');
      return {
        ok: true,
        status: 200,
        json: async () => config,
      };
    }

    if (urlStr.includes('api.github.com')) {
      if (githubFailure) {
        return {
          ok: false,
          status: 500,
          text: async () => 'Simulated GitHub 500 error',
        };
      }
      if (urlStr.includes('/jobs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jobs: baseJobs }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => baseRun,
      };
    }

    if (urlStr.includes('push.getnotifyapp.com')) {
      if (notifyFailure) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Simulated Notify 503',
        };
      }

      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ activities: currentActivities }),
        };
      }

      if (method === 'POST') {
        const isStart = urlStr.includes('new=1');
        const actId = isStart ? `LA_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` : 'LA_UPDATED';
        if (isStart) {
          const newAct = {
            activityId: actId,
            state: 'active',
            content: body,
            createdAt: new Date().toISOString(),
          };
          currentActivities.push(newAct);
          if (onStart) onStart(currentActivities);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, activityId: actId }),
        };
      }

      if (method === 'DELETE') {
        const idMatch = urlStr.match(/live-activity\/([^?]+)/);
        const delId = idMatch ? decodeURIComponent(idMatch[1]) : '';
        const idx = currentActivities.findIndex(a => a.activityId === delId);
        if (idx >= 0) currentActivities.splice(idx, 1);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, state: 'ended' }),
        };
      }
    }

    throw new Error(`Unexpected mock URL: ${urlStr}`);
  };

  const defaultInputs = {
    event: 'refresh',
    deviceId: 'DEV_123',
    token: 'TOK_SECRET',
    githubToken: 'gh_token',
    sourceRepository: 'davidpovarsky/demo',
    sourceRunId: '42',
    sourceRunAttempt: '1',
    sourceBranch: 'main',
  };

  return { mockFetch, defaultInputs, calls, currentActivities };
}

// 1. start with no existing activity
test('start with no existing activity creates a new activity', async () => {
  const h = createHarness();
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'start' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.match(res.status, /^started/);
  const startCall = h.calls.find(c => c.method === 'POST' && c.url.includes('new=1'));
  assert.ok(startCall);
  assert.equal(startCall.body.title, 'demo');
  assert.equal(startCall.body.symbol, 'hammer.fill');
  assert.equal(startCall.body.tint, '#0A84FF');
  assert.equal(startCall.body.button.url, 'https://github.com/davidpovarsky/demo/actions/runs/42');
});

// 2. start with existing matching activity
test('start with existing matching activity ensures/updates and does not create second activity', async () => {
  const existing = {
    activityId: 'LA_EXISTING',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({ activities: [existing] });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'start' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
  assert.equal(res.activityId, 'LA_EXISTING');
  const startCalls = h.calls.filter(c => c.method === 'POST' && c.url.includes('new=1'));
  assert.equal(startCalls.length, 0);
  const updateCall = h.calls.find(c => c.method === 'POST' && c.url.includes('LA_EXISTING'));
  assert.ok(updateCall);
});

// 3. refresh existing activity
test('refresh existing activity updates canonical activity', async () => {
  const existing = {
    activityId: 'LA_CANONICAL',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({ activities: [existing] });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'refresh' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
  assert.equal(res.activityId, 'LA_CANONICAL');
});

// 4. final success
test('final success ends matching activity with Success status', async () => {
  const existing = {
    activityId: 'LA_CANONICAL',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({
    activities: [existing],
    run: { status: 'completed', conclusion: 'success' },
  });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ended');
  assert.equal(res.conclusion, 'Success');
  const delCall = h.calls.find(c => c.method === 'DELETE' && c.url.includes('LA_CANONICAL'));
  assert.ok(delCall);
  assert.equal(delCall.body.status, 'Success');
  assert.equal(delCall.body.progress, 100);
});

// 5. final failure
test('final failure ends matching activity with Failure status', async () => {
  const existing = {
    activityId: 'LA_FAIL',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({
    activities: [existing],
    run: { status: 'completed', conclusion: 'failure' },
  });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.conclusion, 'Failure');
  const delCall = h.calls.find(c => c.method === 'DELETE' && c.url.includes('LA_FAIL'));
  assert.equal(delCall.body.status, 'Failure');
});

// 6. final cancellation
test('final cancellation ends matching activity with Cancelled status', async () => {
  const existing = {
    activityId: 'LA_CANCEL',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({
    activities: [existing],
    run: { status: 'completed', conclusion: 'cancelled' },
  });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.conclusion, 'Cancelled');
  const delCall = h.calls.find(c => c.method === 'DELETE' && c.url.includes('LA_CANCEL'));
  assert.equal(delCall.body.status, 'Cancelled');
});

// 7. final ends every duplicate matching activity
test('final ends every duplicate matching activity', async () => {
  const acts = [
    { activityId: 'LA_D1', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } }, createdAt: '2026-10-07T10:00:00Z' },
    { activityId: 'LA_D2', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } }, createdAt: '2026-10-07T11:00:00Z' },
    { activityId: 'LA_D3', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } }, createdAt: '2026-10-07T12:00:00Z' },
  ];
  const h = createHarness({
    activities: acts,
    run: { status: 'completed', conclusion: 'success' },
  });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  const deleteCalls = h.calls.filter(c => c.method === 'DELETE');
  assert.equal(deleteCalls.length, 3);
});

// 8. simultaneous refreshes
test('simultaneous refreshes safely update canonical without creating duplicates', async () => {
  const existing = {
    activityId: 'LA_MAIN',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({ activities: [existing] });
  const tasks = Array.from({ length: 25 }, () => executeDirectNotify(h.defaultInputs, h.mockFetch));
  const results = await Promise.all(tasks);
  assert.equal(results.every(r => r.ok && r.status === 'updated'), true);
  const startCalls = h.calls.filter(c => c.method === 'POST' && c.url.includes('new=1'));
  assert.equal(startCalls.length, 0);
});

// 9. simultaneous starts and duplicate reconciliation
test('simultaneous starts reconcile and delete duplicates immediately', async () => {
  // Simulate race condition where during start a concurrent worker created LA_RACER
  const h = createHarness({
    onStart: (activities) => {
      activities.push({
        activityId: 'LA_RACER',
        state: 'active',
        content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
        createdAt: new Date(Date.now() - 500).toISOString(),
      });
    },
  });

  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'start' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'started_reconciled');
  const deleteCalls = h.calls.filter(c => c.method === 'DELETE');
  assert.ok(deleteCalls.length >= 1);
});

// 10. duplicate reconciliation during refresh
test('duplicate reconciliation during refresh deletes older duplicates', async () => {
  const acts = [
    { activityId: 'LA_OLD', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } }, createdAt: '2026-10-07T10:00:00Z' },
    { activityId: 'LA_NEW', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } }, createdAt: '2026-10-07T11:00:00Z' },
  ];
  const h = createHarness({ activities: acts });
  const res = await executeDirectNotify(h.defaultInputs, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
  assert.equal(res.activityId, 'LA_NEW');
  const delCall = h.calls.find(c => c.method === 'DELETE' && c.url.includes('LA_OLD'));
  assert.ok(delCall);
});

// 11. exact URL matching
test('exact URL matching isolates runs by full Actions URL', () => {
  const target = 'https://github.com/davidpovarsky/demo/actions/runs/42';
  const list = {
    activities: [
      { activityId: 'LA_MATCH', state: 'active', content: { button: { url: target } } },
      { activityId: 'LA_OTHER', state: 'active', content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/43' } } },
    ],
  };
  const matches = matchingActivities(list, target);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].activityId, 'LA_MATCH');
});

// 12. unrelated activities untouched
test('unrelated activities on same device are untouched', async () => {
  const unrelated = {
    activityId: 'LA_UNRELATED',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/other/actions/runs/999' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const matching = {
    activityId: 'LA_MATCHING',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
    createdAt: '2026-10-07T12:00:00Z',
  };
  const h = createHarness({
    activities: [unrelated, matching],
    run: { status: 'completed', conclusion: 'success' },
  });
  await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  const deleteCalls = h.calls.filter(c => c.method === 'DELETE');
  assert.equal(deleteCalls.length, 1);
  assert.ok(deleteCalls[0].url.includes('LA_MATCHING'));
  assert.ok(!deleteCalls.some(c => c.url.includes('LA_UNRELATED')));
});

// 13. missing secrets -> fail open
test('missing secrets fails open without throwing', async () => {
  const h = createHarness();
  const res = await executeDirectNotify({ ...h.defaultInputs, deviceId: '', token: '' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'missing_credentials');
  assert.equal(h.calls.length, 0);
});

// 14. Notify error -> fail open
test('Notify error fails open without throwing', async () => {
  const h = createHarness({ notifyFailure: true });
  const res = await executeDirectNotify(h.defaultInputs, h.mockFetch);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'notify_list_error');
});

// 15. GitHub API error -> fail open
test('GitHub API error fails open without throwing', async () => {
  const h = createHarness({ githubFailure: true });
  const res = await executeDirectNotify(h.defaultInputs, h.mockFetch);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'github_api_error');
});

// 16. config globally disabled
test('config globally disabled skips creation and ends existing if configured', async () => {
  const existing = {
    activityId: 'LA_DIS',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
  };
  const h = createHarness({
    activities: [existing],
    config: { enabled: false, repositories: { '*': true }, branches: {}, endExistingWhenDisabled: true },
  });
  const res = await executeDirectNotify(h.defaultInputs, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ended');
  assert.equal(res.conclusion, 'Disabled');
  const delCall = h.calls.find(c => c.method === 'DELETE');
  assert.ok(delCall);
});

// 17. repository disabled
test('config repository disabled skips notification', async () => {
  const h = createHarness({
    config: { enabled: true, repositories: { 'davidpovarsky/demo': false }, branches: {}, endExistingWhenDisabled: false },
  });
  const res = await executeDirectNotify(h.defaultInputs, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'disabled_by_config');
});

// 18. branch disabled
test('config branch disabled skips notification', async () => {
  const h = createHarness({
    config: { enabled: true, repositories: { '*': true }, branches: { 'davidpovarsky/demo': { feature: false } }, endExistingWhenDisabled: false },
  });
  const res = await executeDirectNotify({ ...h.defaultInputs, sourceBranch: 'feature' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'disabled_by_config');
});

// 19. config unavailable fails closed for start/refresh but allows cleanup on completion
test('config unavailable fails closed for refresh but cleans up on completed run', async () => {
  const hRefresh = createHarness({ configFailure: true });
  const resRefresh = await executeDirectNotify(hRefresh.defaultInputs, hRefresh.mockFetch);
  assert.equal(resRefresh.ok, true);
  assert.equal(resRefresh.status, 'skipped');
  assert.equal(resRefresh.reason, 'config_unavailable');

  const existing = {
    activityId: 'LA_CLEAN',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
  };
  const hEnd = createHarness({
    configFailure: true,
    activities: [existing],
    run: { status: 'completed', conclusion: 'success' },
  });
  const resEnd = await executeDirectNotify({ ...hEnd.defaultInputs, event: 'final' }, hEnd.mockFetch);
  assert.equal(resEnd.ok, true);
  assert.equal(resEnd.status, 'ended');
});

// 20. metric truncation
test('metric values are safely truncated to 16 characters max', () => {
  assert.equal(short('short'), 'short');
  assert.equal(short('1234567890123456'), '1234567890123456');
  assert.equal(short('12345678901234567'), '123456789012345…');
  assert.equal(short('12345678901234567').length, 16);
});

// 21. instrumentation steps hidden
test('instrumentation steps are hidden from visible steps', () => {
  const job = {
    steps: [
      { name: 'Live Activity · refresh', status: 'in_progress' },
      { name: 'Real build step', status: 'queued' },
    ],
  };
  const step = visibleStep(job);
  assert.equal(step.name, 'Real build step');
});

// 22. next real step selection
test('next real step is selected when refresh is in progress', () => {
  const job = {
    steps: [
      { name: 'Checkout', status: 'completed' },
      { name: 'Live Activity · refresh', status: 'in_progress' },
      { name: 'Compile IPA', status: 'queued' },
      { name: 'Upload', status: 'queued' },
    ],
  };
  const step = visibleStep(job);
  assert.equal(step.name, 'Compile IPA');
});

// 23. matrix jobs
test('matrix jobs contribute accurately to progress and done count', () => {
  const run = { name: 'Matrix Test', status: 'in_progress' };
  const jobs = [
    { id: 1, name: 'test (node 18)', status: 'completed' },
    { id: 2, name: 'test (node 20)', status: 'completed' },
    { id: 3, name: 'test (node 22)', status: 'in_progress', steps: [{ name: 'Test', status: 'in_progress' }] },
    { id: 4, name: 'test (node 24)', status: 'queued' },
  ];
  const view = activityView(run, jobs);
  assert.equal(view.completed, 2);
  assert.equal(view.total, 4);
  assert.equal(view.progress, 50);
});

// 24. parallel jobs
test('parallel jobs contribute to overall total count', () => {
  const run = { name: 'Parallel Test', status: 'in_progress' };
  const jobs = [
    { id: 1, name: 'Lint', status: 'completed' },
    { id: 2, name: 'Unit Tests', status: 'in_progress', steps: [{ name: 'Jest', status: 'in_progress' }] },
    { id: 3, name: 'E2E Tests', status: 'in_progress', steps: [{ name: 'Playwright', status: 'in_progress' }] },
  ];
  const view = activityView(run, jobs);
  assert.equal(view.completed, 1);
  assert.equal(view.total, 3);
  assert.equal(view.progress, 33);
});

// 25. rerun / run_attempt handling
test('mismatched run attempt is skipped cleanly', async () => {
  const h = createHarness({ run: { run_attempt: 2 } });
  const res = await executeDirectNotify({ ...h.defaultInputs, sourceRunAttempt: '1' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'run_attempt_mismatch');
});

// 26. requested -> start behavior
test('requested event starts activity even with 0 jobs scheduled', async () => {
  const h = createHarness({ jobs: [], run: { status: 'queued' } });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'start' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.match(res.status, /^started/);
  const startCall = h.calls.find(c => c.method === 'POST' && c.url.includes('new=1'));
  assert.equal(startCall.body.status, 'Queued');
});

// 27. in_progress -> start/ensure
test('in_progress event ensures single activity', async () => {
  const existing = {
    activityId: 'LA_RUNNING',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
  };
  const h = createHarness({ activities: [existing], run: { status: 'in_progress' } });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'start' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
});

// 28. completed -> final
test('completed event triggers final cleanup', async () => {
  const existing = {
    activityId: 'LA_DONE',
    state: 'active',
    content: { button: { url: 'https://github.com/davidpovarsky/demo/actions/runs/42' } },
  };
  const h = createHarness({ activities: [existing], run: { status: 'completed', conclusion: 'success' } });
  const res = await executeDirectNotify({ ...h.defaultInputs, event: 'final' }, h.mockFetch);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ended');
});

// 29. bridge does not trigger itself
test('bridge does not trigger itself and workflow template excludes recursion', () => {
  const bridgeYaml = fs.readFileSync(path.join(__dirname, '../templates/live-activity-bridge.yml'), 'utf8');
  assert.match(bridgeYaml, /!Live Activity Bridge/);
  assert.match(bridgeYaml, /github\.event\.workflow_run\.name != 'Live Activity Bridge'/);
  assert.equal(shouldSkipWorkflow('live-activity-bridge.yml', bridgeYaml), true);
});

// 30. instrumentation idempotency
test('instrumentation is strictly idempotent', () => {
  const yaml = `name: Build\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n`;
  const first = instrument(yaml);
  assert.equal(first.modified, true);
  assert.equal(first.refreshes, 2);
  const second = instrument(first.text);
  assert.equal(second.modified, false);
  assert.equal(second.refreshes, 0);
  assert.equal(first.text, second.text);
});

// 31. partial instrumentation
test('partial instrumentation adds refreshes only before uninstrumented steps', () => {
  const yaml = `name: Build\njobs:\n  test:\n    steps:\n      - name: Live Activity · refresh\n        uses: davidpovarsky/github-automation/live-refresh@main\n        continue-on-error: true\n        with:\n          event: refresh\n          device_id: \${{ secrets.NOTIFY_DEVICE_ID }}\n          token: \${{ secrets.NOTIFY_DEVICE_TOKEN }}\n          github_token: \${{ github.token }}\n      - uses: actions/checkout@v4\n      - run: npm test\n`;
  const res = instrument(yaml);
  assert.equal(res.modified, true);
  assert.equal(res.refreshes, 1);
});

// 32. multiline conditions
test('multiline conditions are preserved accurately', () => {
  const yaml = `jobs:\n  build:\n    steps:\n      - name: Deploy\n        if: >\n          github.ref == 'refs/heads/main' &&\n          success()\n        run: ./deploy.sh\n`;
  const res = instrument(yaml);
  assert.match(res.text, /if: >\n\s+github\.ref == 'refs\/heads\/main' &&/);
  assert.equal((res.text.match(/if: >/g) || []).length, 2);
});

// 33. unnamed run/uses steps
test('unnamed run and uses steps are handled seamlessly', () => {
  const yaml = `jobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n      - run: node --version\n`;
  const res = instrument(yaml);
  assert.equal(res.refreshes, 2);
  assert.match(res.text, /uses: actions\/setup-node@v4/);
  assert.match(res.text, /run: node --version/);
});

// 34. permissions preservation
test('workflow permissions are preserved and actions: read is added when needed', () => {
  const yaml = `name: CI\npermissions:\n  contents: read\n  packages: write\njobs:\n  build:\n    steps:\n      - run: echo ok\n`;
  const res = instrument(yaml);
  assert.match(res.text, /actions: read/);
  assert.match(res.text, /contents: read/);
  assert.match(res.text, /packages: write/);
});
