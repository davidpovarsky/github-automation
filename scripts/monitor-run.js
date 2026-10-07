'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = process.env.SOURCE_REPOSITORY || process.env.GITHUB_REPOSITORY;
const runId = (process.env.SOURCE_RUN_ID && process.env.SOURCE_RUN_ID !== '0')
  ? process.env.SOURCE_RUN_ID
  : process.env.GITHUB_RUN_ID;
const branch = process.env.SOURCE_BRANCH || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '';
const workflow = process.env.SOURCE_WORKFLOW || process.env.GITHUB_WORKFLOW || '';
const runNumber = (process.env.SOURCE_RUN_NUMBER && process.env.SOURCE_RUN_NUMBER !== '0')
  ? process.env.SOURCE_RUN_NUMBER
  : (process.env.GITHUB_RUN_NUMBER || '');
const ghToken = process.env.GH_TOKEN || '';
const deviceId = process.env.NOTIFY_DEVICE_ID || '';
const deviceToken = process.env.NOTIFY_DEVICE_TOKEN || '';
const activityId = process.env.NOTIFY_ACTIVITY_ID || '';
const pollSeconds = Math.max(5, Number(process.env.POLL_SECONDS || '15'));
const actionEntrypoint = path.resolve(__dirname, '..', 'index.js');

const TERMINAL = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'neutral']);
const FAILURE = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const CANCELLED = new Set(['cancelled']);

function out(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const safe = String(value ?? '').replace(/\r?\n/g, ' ');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${safe}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function short(value, max = 16) {
  const s = String(value ?? '').trim();
  if (!s) return '-';
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
}

async function api(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'davidpovarsky/github-automation-monitor',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchJobs() {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const data = await api(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...(data.jobs || []));
    if (!data.jobs || data.jobs.length < 100) break;
  }
  return jobs;
}

function isMonitorJob(job) {
  return /Live Activity monitor/i.test(job.name || '');
}

function conclusion(job) {
  return (job.conclusion || '').toLowerCase();
}

function currentStep(job) {
  const steps = job.steps || [];
  return steps.find(s => s.status === 'in_progress')
    || steps.find(s => s.status === 'queued')
    || steps.find(s => s.status !== 'completed')
    || steps[steps.length - 1]
    || null;
}

function stateFromJobs(jobs) {
  const completed = jobs.filter(j => j.status === 'completed');
  const total = jobs.length;
  const completedCount = completed.length;
  const progress = total ? Math.max(0, Math.min(99, Math.floor((completedCount / total) * 100))) : 0;

  const active = jobs.find(j => j.status === 'in_progress')
    || jobs.find(j => j.status === 'queued')
    || jobs.find(j => j.status !== 'completed')
    || jobs[jobs.length - 1]
    || null;

  const step = active ? currentStep(active) : null;

  return {
    total,
    completedCount,
    progress,
    active,
    step,
    allDone: total > 0 && completedCount === total,
  };
}

function finalStatus(jobs) {
  const conclusions = jobs.map(conclusion);
  if (conclusions.some(c => FAILURE.has(c))) return 'Failure';
  if (conclusions.some(c => CANCELLED.has(c))) return 'Cancelled';
  return 'Success';
}

function notifyUpdate(state) {
  const metrics = [
    { label: 'Branch', value: short(branch) },
    { label: 'Job', value: short(state.active?.name || 'Waiting') },
    { label: 'Step', value: short(state.step?.name || 'Queued') },
    { label: 'Done', value: `${state.completedCount}/${state.total}` },
    { label: 'Run', value: short(`#${runNumber}`) },
  ];

  const childEnv = {
    ...process.env,
    INPUT_ACTION: 'update',
    INPUT_DEVICE_ID: deviceId,
    INPUT_TOKEN: deviceToken,
    INPUT_ACTIVITY_ID: activityId,
    INPUT_SCOPE_REPOSITORY: repo,
    INPUT_SCOPE_BRANCH: branch,
    INPUT_TITLE: '',
    INPUT_BODY: state.active ? short(state.active.name, 64) : 'Waiting for jobs',
    INPUT_SYMBOL: '',
    INPUT_TINT: '',
    INPUT_PROGRESS: String(state.progress),
    INPUT_ENDS_IN: '',
    INPUT_TRAILING: '',
    INPUT_STATUS: state.active?.status === 'queued' ? 'Queued' : 'Running',
    INPUT_STEPS: '',
    INPUT_STEP: '',
    INPUT_METRICS_JSON: JSON.stringify(metrics),
    INPUT_BUTTON_JSON: '',
    INPUT_KEEP_FOR: '',
    INPUT_FAIL_ON_ERROR: 'false',
    INPUT_NEW_ACTIVITY: 'false',
  };

  const result = spawnSync(process.execPath, [actionEntrypoint], {
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    console.log(`::warning::Notify monitor update exited with code ${result.status}; monitoring will continue.`);
  }
}

async function main() {
  if (!repo || !runId || !ghToken) {
    throw new Error('Missing GitHub runtime context required for workflow monitoring.');
  }
  if (!deviceId || !deviceToken || !activityId) {
    throw new Error('Missing Notify! credentials or activity ID.');
  }

  console.log(`Monitoring ${repo} run #${runNumber} (${runId}) every ${pollSeconds}s.`);

  let lastFingerprint = '';
  let emptyPolls = 0;

  // Give GitHub a moment to materialize the full job graph.
  await sleep(3000);

  while (true) {
    const allJobs = await fetchJobs();
    const jobs = allJobs.filter(j => !isMonitorJob(j));

    if (jobs.length === 0) {
      emptyPolls += 1;
      if (emptyPolls === 1 || emptyPolls % 4 === 0) {
        console.log('Waiting for non-monitor jobs to appear...');
      }
      await sleep(pollSeconds * 1000);
      continue;
    }

    emptyPolls = 0;
    const state = stateFromJobs(jobs);

    const fingerprint = JSON.stringify({
      jobs: jobs.map(j => [j.id, j.status, j.conclusion, currentStep(j)?.number, currentStep(j)?.status]),
      completedCount: state.completedCount,
      total: state.total,
    });

    // Update immediately on meaningful changes. Also refresh every ~60 seconds
    // even when GitHub job state is unchanged, so the tile stays current.
    const shouldHeartbeat = !lastFingerprint || Date.now() - Number(process.env.__LAST_NOTIFY_MS || 0) >= 60000;
    if (fingerprint !== lastFingerprint || shouldHeartbeat) {
      console.log(`Progress: ${state.completedCount}/${state.total}; active: ${state.active?.name || 'none'}; step: ${state.step?.name || 'none'}`);
      notifyUpdate(state);
      lastFingerprint = fingerprint;
      process.env.__LAST_NOTIFY_MS = String(Date.now());
    }

    if (state.allDone) {
      const status = finalStatus(jobs);
      out('final_status', status);
      out('completed_jobs', state.completedCount);
      out('total_jobs', state.total);
      console.log(`All non-monitor jobs are complete. Final status: ${status}.`);
      return;
    }

    await sleep(pollSeconds * 1000);
  }
}

main().catch(error => {
  console.log(`::warning::Central monitor stopped: ${error.message}`);
  out('final_status', 'Finished');
  // Monitoring must never change the caller workflow result.
  process.exitCode = 0;
});
