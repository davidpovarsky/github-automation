'use strict';

const cp = require('child_process');
const token = cp.execSync('gh auth token', { encoding: 'utf8' }).trim();

async function check() {
  const reposRes = await fetch('https://api.github.com/user/repos?per_page=100&type=owner', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'check' }
  });
  const repos = await reposRes.json();
  const queuedRuns = [];
  for (const r of repos) {
    if (r.archived) continue;
    const res = await fetch(`https://api.github.com/repos/${r.full_name}/actions/runs?status=queued&per_page=50`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'check' }
    });
    const d = await res.json();
    if (d.workflow_runs && d.workflow_runs.length > 0) {
      for (const run of d.workflow_runs) {
        queuedRuns.push({
          repo: r.full_name,
          id: run.id,
          name: run.name,
          event: run.event,
          msg: run.head_commit?.message?.split('\n')[0]
        });
      }
    }
  }
  console.log(`Remaining queued runs: ${queuedRuns.length}`);
  for (const q of queuedRuns) {
    console.log(`[${q.repo}] #${q.id} - ${q.name} (${q.event}): ${q.msg}`);
  }
}
check();
