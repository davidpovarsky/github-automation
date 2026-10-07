const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { instrument } = require('../scripts/instrument-workflows.js');

test('workflow instrumentation handles unnamed uses, run, and named steps', () => {
  const source = 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - name: Build\n        run: npm run build\n';
  const result = instrument(source);
  assert.equal(result.refreshes, 3);
  assert.equal(result.finals, 1);
  assert.equal((result.text.match(/uses: davidpovarsky\/github-automation\/live-refresh@main/g) || []).length, 4);
});

test('workflow instrumentation is granular for partial files and adds one final hint per job', () => {
  const source = 'jobs:\n  first:\n    steps:\n      - name: Live Activity · refresh\n        uses: davidpovarsky/github-automation/live-refresh@main\n        continue-on-error: true\n      - run: first\n  second:\n    steps:\n      - name: Build\n        run: npm test\n';
  const result = instrument(source);
  assert.equal(result.modified, true);
  assert.equal(result.refreshes, 1);
  assert.equal(result.finals, 2);
  const again = instrument(result.text);
  assert.equal(again.modified, false);
});

test('workflow instrumentation mirrors original conditions and expressions', () => {
  const source = 'jobs:\n  build:\n    steps:\n      - name: Deploy\n        if: ${{ github.ref == \'refs/heads/main\' }}\n        run: ./deploy.sh\n';
  const result = instrument(source);
  assert.equal((result.text.match(/if: \$\{\{ github\.ref == \'refs\/heads\/main\' \}\}/g) || []).length, 2);
});

test('workflow instrumentation preserves multiline if block scalars', () => {
  const source = 'jobs:\n  build:\n    steps:\n      - name: Push only\n        if: >\n          github.event_name == \'push\' &&\n          github.ref == \'refs/heads/main\'\n        run: ./push.sh\n      - name: Main only\n        if: |\n          always() &&\n          github.ref_name == \'main\'\n        run: ./main.sh\n';
  const result = instrument(source);
  assert.equal((result.text.match(/if: >/g) || []).length, 2);
  assert.equal((result.text.match(/if: \|/g) || []).length, 2);
  assert.equal((result.text.match(/github\.ref == \'refs\/heads\/main\'/g) || []).length, 2);
  assert.equal((result.text.match(/github\.ref_name == \'main\'/g) || []).length, 2);
});

test('workflow instrumentation does not treat nested with lists as steps', () => {
  const source = 'jobs:\n  build:\n    steps:\n      - uses: actions/example@v1\n        with:\n          items:\n            - one\n            - two\n';
  const result = instrument(source);
  assert.equal(result.refreshes, 1);
});

test('source action contains no Notify or PAT secret inputs and uses a short timeout', () => {
  const action = fs.readFileSync(path.join(__dirname, '..', 'live-refresh/action.yml'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'live-refresh/index.js'), 'utf8');
  assert.doesNotMatch(action, /NOTIFY_DEVICE|GH_MONITOR_TOKEN|token:/i);
  assert.match(runtime, /AbortSignal\.timeout\(1800\)/);
});

test('fail-open refresh runtime exits successfully when endpoint is unavailable', () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'live-refresh/index.js')], {
    encoding: 'utf8',
    env: { ...process.env, INPUT_ENDPOINT: 'http://127.0.0.1:1/v1/refresh', INPUT_EVENT: 'refresh', GITHUB_REPOSITORY: 'davidpovarsky/demo', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF_NAME: 'main' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /build continues/);
});

test('worker source contains explicit queue, recovery, and fail-closed config behavior', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker/src/index.js'), 'utf8');
  assert.match(worker, /this\.queue\.then/);
  assert.match(worker, /configResult\.available/);
  assert.match(worker, /recoverActivity/);
  assert.match(worker, /state\.lifecycle = 'starting'/);
  assert.match(worker, /state\.lifecycle = 'finalized'/);
});
