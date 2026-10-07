const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { instrument } = require('../scripts/instrument-workflows.js');

test('workflow instrumentation is idempotent and adds one final hint per job', () => {
  const source = 'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Build\n        run: npm test\n';
  const first = instrument(source);
  assert.equal(first.modified, true);
  assert.equal(first.refreshes, 1);
  assert.equal(first.finals, 1);
  assert.equal((first.text.match(/Live Activity · final/g) || []).length, 1);
  const second = instrument(first.text);
  assert.equal(second.modified, false);
});

test('workflow instrumentation mirrors original conditions and expressions', () => {
  const source = 'jobs:\n  build:\n    steps:\n      - name: Deploy\n        if: ${{ github.ref == \'refs/heads/main\' }}\n        run: ./deploy.sh\n';
  const result = instrument(source);
  assert.equal((result.text.match(/if: \$\{\{ github\.ref == \'refs\/heads\/main\' \}\}/g) || []).length, 2);
  assert.match(result.text, /Live Activity · refresh/);
});

test('source action contains no Notify or PAT secret inputs', () => {
  const action = fs.readFileSync(path.join(__dirname, '..', 'live-refresh/action.yml'), 'utf8');
  assert.doesNotMatch(action, /NOTIFY_DEVICE|GH_MONITOR_TOKEN|token:/i);
});

test('worker source enforces owner and run verification', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker/src/index.js'), 'utf8');
  assert.match(worker, /owner !== OWNER/);
  assert.match(worker, /run\.repository\?\.full_name/);
  assert.match(worker, /idFromName/);
});

test('worker source ignores instrumentation steps', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker/src/index.js'), 'utf8');
  assert.match(worker, /INSTRUMENTATION_PREFIX/);
  assert.match(worker, /startsWith\(INSTRUMENTATION_PREFIX\)/);
});
