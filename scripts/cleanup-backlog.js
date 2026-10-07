'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const GH_TOKEN = cp.execSync('gh auth token', { encoding: 'utf8' }).trim();

async function ghFetch(url, options = {}) {
  const fullUrl = url.startsWith('https://') ? url : `https://api.github.com${url}`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'davidpovarsky/backlog-cleanup',
    ...(options.headers || {})
  };
  const res = await fetch(fullUrl, { ...options, headers });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function cancelRun(repoFullName, runId) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'davidpovarsky/backlog-cleanup'
      }
    });
    return res.status === 202 || res.status === 200;
  } catch (err) {
    return false;
  }
}

const ROLLOUT_COMMIT_PREFIXES = [
  'ci: add event-driven Live Activity updates',
  'ci: install Live Activity Bridge',
  'ci: update Live Activity Bridge',
  'feat(rollout): complete direct-to-Notify',
  'migration:'
];

function isRolloutRun(run) {
  const msg = (run.head_commit && run.head_commit.message) ? run.head_commit.message.trim() : '';
  const workflowName = run.name || '';
  
  // Bridge runs
  if (workflowName === 'Live Activity Bridge') {
    return true;
  }
  
  // Commit message check
  for (const prefix of ROLLOUT_COMMIT_PREFIXES) {
    if (msg.startsWith(prefix) || msg.includes(prefix)) {
      return true;
    }
  }
  
  // Telemetry or rollout test runs
  if (workflowName.includes('Workflow-Run Watcher') || workflowName.includes('Central Account Actions Monitor')) {
    return true;
  }

  return false;
}

async function getRepos() {
  const repos = [];
  let page = 1;
  while (true) {
    const batch = await ghFetch(`/user/repos?per_page=100&type=owner&page=${page}`);
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      if (!r.archived) repos.push(r);
    }
    if (batch.length < 100) break;
    page++;
  }
  return repos;
}

async function getActiveRuns(repoFullName) {
  const [queuedRes, inProgRes] = await Promise.all([
    ghFetch(`/repos/${repoFullName}/actions/runs?status=queued&per_page=100`).catch(() => ({ workflow_runs: [] })),
    ghFetch(`/repos/${repoFullName}/actions/runs?status=in_progress&per_page=100`).catch(() => ({ workflow_runs: [] }))
  ]);
  return [
    ...(queuedRes.workflow_runs || []),
    ...(inProgRes.workflow_runs || [])
  ];
}

async function runCleanup() {
  console.log('Discovering owned repositories...');
  const repos = await getRepos();
  console.log(`Found ${repos.length} non-archived repositories.`);

  let totalQueuedBefore = 0;
  let totalInProgressBefore = 0;
  let totalCancelled = 0;
  let genuinePreserved = 0;

  const cancelledRuns = [];
  const preservedRuns = [];

  console.log('Inspecting active runs across all repositories...');

  // Inspect in batches of 5
  const concurrency = 5;
  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (repo) => {
      const runs = await getActiveRuns(repo.full_name);
      for (const run of runs) {
        if (run.status === 'queued') totalQueuedBefore++;
        if (run.status === 'in_progress') totalInProgressBefore++;

        const isRollout = isRolloutRun(run);
        if (isRollout) {
          const ok = await cancelRun(repo.full_name, run.id);
          totalCancelled++;
          cancelledRuns.push({
            repo: repo.full_name,
            runId: run.id,
            status: run.status,
            name: run.name,
            commitMessage: run.head_commit?.message?.split('\n')[0] || '(no message)',
            cancelled: ok
          });
          console.log(`  [CANCELLED] ${repo.full_name} #${run.id} (${run.status}) - ${run.name}: ${run.head_commit?.message?.split('\n')[0] || ''}`);
        } else {
          genuinePreserved++;
          preservedRuns.push({
            repo: repo.full_name,
            runId: run.id,
            status: run.status,
            name: run.name,
            commitMessage: run.head_commit?.message?.split('\n')[0] || '(no message)'
          });
          console.log(`  [PRESERVED] ${repo.full_name} #${run.id} (${run.status}) - ${run.name}: ${run.head_commit?.message?.split('\n')[0] || ''}`);
        }
      }
    }));
  }

  console.log('\nWaiting 5 seconds for GitHub Actions to process cancellations...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('Verifying remaining queued runs...');
  let totalQueuedAfter = 0;
  let totalInProgressAfter = 0;

  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (repo) => {
      const runs = await getActiveRuns(repo.full_name);
      for (const run of runs) {
        if (run.status === 'queued') totalQueuedAfter++;
        if (run.status === 'in_progress') totalInProgressAfter++;
      }
    }));
  }

  const report = {
    timestamp: new Date().toISOString(),
    queuedBefore: totalQueuedBefore,
    inProgressBefore: totalInProgressBefore,
    totalCancelled,
    genuinePreserved,
    queuedAfter: totalQueuedAfter,
    inProgressAfter: totalInProgressAfter,
    cancelledRuns,
    preservedRuns
  };

  const reportPath = path.join(__dirname, '..', 'migration', 'backlog-cleanup-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n========================================');
  console.log('BACKLOG CLEANUP SUMMARY:');
  console.log(`  - Queued Before:          ${totalQueuedBefore}`);
  console.log(`  - In Progress Before:     ${totalInProgressBefore}`);
  console.log(`  - Cancelled Rollout Runs: ${totalCancelled}`);
  console.log(`  - Genuine Runs Preserved: ${genuinePreserved}`);
  console.log(`  - Queued After:           ${totalQueuedAfter}`);
  console.log(`  - In Progress After:      ${totalInProgressAfter}`);
  console.log(`Report written to ${reportPath}`);
  console.log('========================================\n');
}

runCleanup().catch(err => {
  console.error('Backlog cleanup failed:', err);
  process.exit(1);
});
