'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OWNER = process.env.ACCOUNT_OWNER || 'davidpovarsky';
const CENTRAL_REPO = process.env.CENTRAL_REPOSITORY || 'davidpovarsky/github-automation';
const STATE_ISSUE = Number(process.env.STATE_ISSUE_NUMBER || '1');
const MONITOR_TOKEN = process.env.GH_MONITOR_TOKEN || '';
const CENTRAL_TOKEN = process.env.CENTRAL_GITHUB_TOKEN || '';
const DEVICE_ID = process.env.NOTIFY_DEVICE_ID || '';
const DEVICE_TOKEN = process.env.NOTIFY_DEVICE_TOKEN || '';
const RUNTIME_MS = Math.max(1, Number(process.env.RUNTIME_MINUTES || '330')) * 60_000;
const FULL_SCAN_MS = Math.max(30, Number(process.env.FULL_SCAN_SECONDS || '120')) * 1000;
const ACTIVE_POLL_MS = Math.max(10, Number(process.env.ACTIVE_POLL_SECONDS || '15')) * 1000;
const ACTION_ENTRYPOINT = path.resolve(__dirname, '..', 'index.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function short(value, max = 16) {
  const s = String(value ?? '').trim();
  if (!s) return '-';
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

function runLink(run) {
  return run.html_url || `https://github.com/${run.repository.full_name}/actions/runs/${run.id}`;
}

function runButton(run) {
  return JSON.stringify({
    title: 'Open Run',
    url: runLink(run),
    open: true,
  });
}

async function github(token, endpoint, options = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'davidpovarsky/github-automation-account-monitor',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} ${endpoint}: ${text.slice(0, 600)}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

function defaultState() {
  return {
    version: 2,
    tracked: {},
    repos: [],
    reposUpdatedAt: 0,
    heartbeatAt: 0,
  };
}

function parseState(body) {
  const match = String(body || '').match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return defaultState();

  try {
    const parsed = JSON.parse(match[1]);
    return {
      ...defaultState(),
      ...parsed,
      tracked: parsed.tracked && typeof parsed.tracked === 'object' ? parsed.tracked : {},
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
    };
  } catch {
    return defaultState();
  }
}

function stateBody(state) {
  return [
    'Internal state used by the central GitHub Actions monitor. Do not edit manually.',
    '',
    '```json',
    JSON.stringify(state),
    '```',
  ].join('\n');
}

async function readState() {
  const issue = await github(CENTRAL_TOKEN, `/repos/${CENTRAL_REPO}/issues/${STATE_ISSUE}`);
  return parseState(issue.body);
}

async function writeState(state) {
  state.heartbeatAt = Date.now();
  await github(CENTRAL_TOKEN, `/repos/${CENTRAL_REPO}/issues/${STATE_ISSUE}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: stateBody(state) }),
  });
}

async function listOwnedRepos() {
  const repos = [];

  for (let page = 1; page <= 10; page++) {
    const items = await github(
      MONITOR_TOKEN,
      `/user/repos?affiliation=owner&sort=updated&direction=desc&per_page=100&page=${page}`
    );

    repos.push(...items
      .filter(repo => repo.owner?.login?.toLowerCase() === OWNER.toLowerCase())
      .filter(repo => !repo.archived)
      .filter(repo => repo.full_name !== CENTRAL_REPO)
      .map(repo => repo.full_name));

    if (items.length < 100) break;
  }

  return [...new Set(repos)];
}

function runAction(inputs) {
  const outputFile = path.join(
    os.tmpdir(),
    `notify-output-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(outputFile, '');

  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputFile,
  };

  for (const [key, value] of Object.entries(inputs)) {
    env[`INPUT_${key.toUpperCase()}`] = value == null ? '' : String(value);
  }

  const result = spawnSync(process.execPath, [ACTION_ENTRYPOINT], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const outputs = {};
  for (const line of fs.readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) outputs[line.slice(0, idx)] = line.slice(idx + 1);
  }

  try { fs.unlinkSync(outputFile); } catch {}

  return outputs;
}

function startActivity(run) {
  const repoName = run.repository.full_name.split('/').pop();
  return runAction({
    action: 'start',
    device_id: DEVICE_ID,
    token: DEVICE_TOKEN,
    scope_repository: run.repository.full_name,
    scope_branch: run.head_branch || '',
    title: repoName,
    body: `${run.name} #${run.run_number}`,
    symbol: 'hammer.fill',
    tint: '#0A84FF',
    progress: '0',
    status: run.status === 'queued' ? 'Queued' : 'Running',
    metrics_json: JSON.stringify([
      { label: 'Branch', value: short(run.head_branch) },
      { label: 'Workflow', value: short(run.name) },
      { label: 'Run', value: short(`#${run.run_number}`) },
    ]),
    button_json: runButton(run),
    fail_on_error: 'false',
    new_activity: 'true',
  });
}

function updateActivity(entry, run, jobs) {
  const completed = jobs.filter(j => j.status === 'completed').length;
  const total = jobs.length || 1;
  const progress = Math.min(99, Math.floor((completed / total) * 100));

  const active = jobs.find(j => j.status === 'in_progress')
    || jobs.find(j => j.status === 'queued')
    || jobs.find(j => j.status !== 'completed')
    || jobs[jobs.length - 1];

  const steps = active?.steps || [];
  const step = steps.find(s => s.status === 'in_progress')
    || steps.find(s => s.status === 'queued')
    || steps.find(s => s.status !== 'completed')
    || steps[steps.length - 1];

  const fingerprint = JSON.stringify({
    runStatus: run.status,
    runConclusion: run.conclusion,
    jobs: jobs.map(j => [j.id, j.status, j.conclusion]),
    active: active ? [active.id, active.status, step?.number, step?.status] : null,
  });

  const heartbeatDue = !entry.lastNotifyAt || Date.now() - entry.lastNotifyAt > 60_000;
  if (fingerprint === entry.lastFingerprint && !heartbeatDue) return false;

  runAction({
    action: 'update',
    device_id: DEVICE_ID,
    token: DEVICE_TOKEN,
    activity_id: entry.activityId,
    scope_repository: entry.repository,
    scope_branch: entry.branch,
    body: active?.name || run.name,
    progress: String(progress),
    status: run.status === 'queued' ? 'Queued' : 'Running',
    metrics_json: JSON.stringify([
      { label: 'Branch', value: short(entry.branch) },
      { label: 'Job', value: short(active?.name || 'Waiting') },
      { label: 'Step', value: short(step?.name || run.status) },
      { label: 'Done', value: `${completed}/${jobs.length}` },
      { label: 'Run', value: short(`#${run.run_number}`) },
    ]),
    button_json: runButton(run),
    fail_on_error: 'false',
    new_activity: 'false',
  });

  entry.lastFingerprint = fingerprint;
  entry.lastNotifyAt = Date.now();
  return true;
}

function endActivity(entry, run) {
  const conclusion = String(run.conclusion || 'completed').toLowerCase();
  const status =
    conclusion === 'success' ? 'Success'
    : conclusion === 'cancelled' ? 'Cancelled'
    : conclusion === 'skipped' ? 'Skipped'
    : 'Failure';

  runAction({
    action: 'end',
    device_id: DEVICE_ID,
    token: DEVICE_TOKEN,
    activity_id: entry.activityId,
    scope_repository: entry.repository,
    scope_branch: entry.branch,
    progress: '100',
    status,
    keep_for: '60',
    fail_on_error: 'false',
  });
}

async function latestRuns(repo) {
  const data = await github(
    MONITOR_TOKEN,
    `/repos/${repo}/actions/runs?per_page=10&exclude_pull_requests=false`
  );
  return (data.workflow_runs || []).filter(run => run.status === 'queued' || run.status === 'in_progress');
}

async function jobsFor(repo, runId) {
  const data = await github(
    MONITOR_TOKEN,
    `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
  );
  return data.jobs || [];
}

async function runFor(repo, runId) {
  return github(MONITOR_TOKEN, `/repos/${repo}/actions/runs/${runId}`);
}

function keyFor(run) {
  return `${run.repository.full_name}#${run.id}`;
}

async function discover(state) {
  for (const repo of state.repos) {
    try {
      const runs = await latestRuns(repo);

      for (const run of runs) {
        const key = keyFor(run);
        if (state.tracked[key]) continue;

        console.log(`Discovered ${repo}: ${run.name} #${run.run_number} (${run.head_branch})`);
        const outputs = startActivity(run);
        const activityId = outputs.activity_id || '';

        if (!activityId) {
          console.log(`No activity created for ${key}; central config may be disabled. It will be retried on a later scan.`);
          continue;
        }

        state.tracked[key] = {
          repository: repo,
          runId: run.id,
          runNumber: run.run_number,
          workflow: run.name,
          branch: run.head_branch || '',
          activityId,
          createdAt: Date.now(),
          lastFingerprint: '',
          lastNotifyAt: 0,
        };

        await writeState(state);
      }
    } catch (error) {
      console.log(`::warning::Scan failed for ${repo}: ${error.message}`);
    }
  }
}

async function updateTracked(state) {
  for (const [key, entry] of Object.entries(state.tracked)) {
    try {
      const run = await runFor(entry.repository, entry.runId);

      if (run.status === 'completed') {
        console.log(`Completed ${key}: ${run.conclusion}`);
        endActivity(entry, run);
        delete state.tracked[key];
        await writeState(state);
        continue;
      }

      const jobs = await jobsFor(entry.repository, entry.runId);
      updateActivity(entry, run, jobs);
    } catch (error) {
      console.log(`::warning::Tracking failed for ${key}: ${error.message}`);
    }
  }
}

async function main() {
  if (!MONITOR_TOKEN) {
    throw new Error('Missing GH_MONITOR_TOKEN. Add one fine-grained GitHub PAT to github-automation with Actions: read access to all repositories.');
  }
  if (!CENTRAL_TOKEN) throw new Error('Missing CENTRAL_GITHUB_TOKEN.');
  if (!DEVICE_ID || !DEVICE_TOKEN) throw new Error('Missing Notify! secrets in github-automation.');

  const state = await readState();

  // Refresh the repository inventory at startup and at least every six hours.
  if (!state.repos.length || Date.now() - Number(state.reposUpdatedAt || 0) > 6 * 60 * 60 * 1000) {
    state.repos = await listOwnedRepos();
    state.reposUpdatedAt = Date.now();
    await writeState(state);
  }

  console.log(`Central account monitor started: ${state.repos.length} repositories, ${Object.keys(state.tracked).length} tracked runs.`);
  console.log(`Full discovery every ${FULL_SCAN_MS / 1000}s; active runs every ${ACTIVE_POLL_MS / 1000}s.`);

  const stopAt = Date.now() + RUNTIME_MS;
  let nextFullScan = 0;
  let nextHeartbeat = 0;

  while (Date.now() < stopAt) {
    if (Date.now() >= nextFullScan) {
      await discover(state);
      nextFullScan = Date.now() + FULL_SCAN_MS;
    }

    await updateTracked(state);

    if (Date.now() >= nextHeartbeat) {
      await writeState(state);
      nextHeartbeat = Date.now() + 60_000;
    }

    await sleep(ACTIVE_POLL_MS);
  }

  await writeState(state);
  console.log(`Monitor handoff after ${RUNTIME_MS / 60000} minutes at ${nowIso()}.`);
}

main().catch(error => {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
});
