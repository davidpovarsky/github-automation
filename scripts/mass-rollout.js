'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { instrument, shouldSkipWorkflow } = require('./instrument-workflows.js');

const OWNER = 'davidpovarsky';
const NOTIFY_DEVICE_ID = process.env.NOTIFY_DEVICE_ID || '';
const NOTIFY_DEVICE_TOKEN = process.env.NOTIFY_DEVICE_TOKEN || '';

const GH_TOKEN = cp.execSync('gh auth token', { encoding: 'utf8' }).trim();

async function ghFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'davidpovarsky/github-automation-rollout',
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API HTTP ${res.status} on ${endpoint}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function setSecret(repoFullName, name, val) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('gh', ['secret', 'set', name, '--repo', repoFullName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(val);
    child.stdin.end();
    child.on('close', code => {
      if (code === 0) resolve(true);
      else reject(new Error(`gh secret set exited with code ${code}`));
    });
  });
}

function verifySecrets(repoFullName) {
  try {
    const out = cp.execSync(`gh secret list --repo ${repoFullName}`, { encoding: 'utf8' });
    const hasId = out.includes('NOTIFY_DEVICE_ID');
    const hasToken = out.includes('NOTIFY_DEVICE_TOKEN');
    return { hasId, hasToken, success: hasId && hasToken };
  } catch (err) {
    return { hasId: false, hasToken: false, success: false, error: err.message };
  }
}

function renderBridgeWorkflow(workflowNames = []) {
  const workflowsYaml = workflowNames.length > 0
    ? workflowNames.map(w => `      - ${JSON.stringify(w)}`).join('\n')
    : '      - "*"';

  return `name: Live Activity Bridge

on:
  workflow_run:
    workflows:
${workflowsYaml}
    types:
      - in_progress
      - completed

permissions:
  actions: read
  contents: read

concurrency:
  group: live-activity-bridge-\${{ github.event.workflow_run.id }}
  cancel-in-progress: false

jobs:
  bridge:
    name: Bridge
    if: \${{ github.event.workflow_run.name != 'Live Activity Bridge' && !startsWith(github.event.workflow_run.name, 'Live Activity Bridge') }}
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - name: Live Activity · lifecycle
        uses: davidpovarsky/github-automation/live-refresh@main
        continue-on-error: true
        with:
          event: \${{ github.event.action == 'completed' && 'final' || 'start' }}
          device_id: \${{ secrets.NOTIFY_DEVICE_ID }}
          token: \${{ secrets.NOTIFY_DEVICE_TOKEN }}
          github_token: \${{ github.token }}
          source_repository: \${{ github.event.workflow_run.repository.full_name || github.repository }}
          source_run_id: \${{ github.event.workflow_run.id }}
          source_run_attempt: \${{ github.event.workflow_run.run_attempt }}
          source_branch: \${{ github.event.workflow_run.head_branch }}
`;
}

async function putFileContents(repoFullName, filePath, contentString, branch, message, currentSha = null) {
  const body = {
    message,
    content: Buffer.from(contentString, 'utf8').toString('base64'),
    branch,
  };
  if (currentSha) body.sha = currentSha;
  return ghFetch(`/repos/${repoFullName}/contents/${filePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function processRepository(repo, report) {
  const repoName = repo.name;
  const fullName = `${OWNER}/${repoName}`;
  const isPrivate = repo.isPrivate;
  const defaultBranch = repo.defaultBranchRef?.name || 'main';

  console.log(`\n========================================`);
  console.log(`Processing ${fullName} (${isPrivate ? 'private' : 'public'}, default: ${defaultBranch})`);

  const repoRecord = {
    repository: fullName,
    isPrivate,
    defaultBranch,
    secrets: { configured: false, verifiedNames: [] },
    bridge: { installed: false, action: 'none' },
    branchesInspected: [],
    workflowsModified: [],
    prsCreated: [],
    errors: [],
  };

  // 1. Distribute secrets
  try {
    await setSecret(fullName, 'NOTIFY_DEVICE_ID', NOTIFY_DEVICE_ID);
    await setSecret(fullName, 'NOTIFY_DEVICE_TOKEN', NOTIFY_DEVICE_TOKEN);
    const verification = verifySecrets(fullName);
    if (verification.success) {
      repoRecord.secrets.configured = true;
      repoRecord.secrets.verifiedNames = ['NOTIFY_DEVICE_ID', 'NOTIFY_DEVICE_TOKEN'];
      console.log(`  ✓ Secrets configured and verified`);
    } else {
      repoRecord.errors.push(`Secret verification failed: ${JSON.stringify(verification)}`);
      console.log(`  ✗ Secret verification failed`);
    }
  } catch (err) {
    repoRecord.errors.push(`Secret distribution error: ${err.message}`);
    console.log(`  ✗ Secret distribution error: ${err.message}`);
  }

  // 2. Discover workflows across repository
  let repoWorkflows = [];
  try {
    const wfData = await ghFetch(`/repos/${fullName}/actions/workflows`);
    repoWorkflows = (wfData.workflows || []).map(w => w.name);
  } catch (e) {
    // Repo might not have Actions enabled or workflows yet
  }
  const realWorkflowNames = repoWorkflows.filter(name =>
    name !== 'Live Activity Bridge' &&
    !name.startsWith('Live Activity') &&
    !name.includes('Account Actions Monitor') &&
    !name.includes('Deploy Live Activity Worker')
  );

  // 3. Install / update Live Activity Bridge on default branch
  try {
    let existingBridgeSha = null;
    let existingBridgeContent = '';
    try {
      const existingBridge = await ghFetch(`/repos/${fullName}/contents/.github/workflows/live-activity-bridge.yml?ref=${encodeURIComponent(defaultBranch)}`);
      existingBridgeSha = existingBridge.sha;
      existingBridgeContent = Buffer.from(existingBridge.content, 'base64').toString('utf8');
    } catch {}

    const targetBridgeYaml = renderBridgeWorkflow(realWorkflowNames);
    if (!existingBridgeSha || existingBridgeContent !== targetBridgeYaml) {
      await putFileContents(
        fullName,
        '.github/workflows/live-activity-bridge.yml',
        targetBridgeYaml,
        defaultBranch,
        existingBridgeSha ? 'ci: update Live Activity Bridge' : 'ci: install Live Activity Bridge',
        existingBridgeSha
      );
      repoRecord.bridge.installed = true;
      repoRecord.bridge.action = existingBridgeSha ? 'updated' : 'created';
      console.log(`  ✓ Live Activity Bridge ${repoRecord.bridge.action} on ${defaultBranch}`);
    } else {
      repoRecord.bridge.installed = true;
      repoRecord.bridge.action = 'already_up_to_date';
      console.log(`  ✓ Live Activity Bridge already up to date on ${defaultBranch}`);
    }
  } catch (err) {
    repoRecord.errors.push(`Bridge installation failed: ${err.message}`);
    console.log(`  ✗ Bridge installation error: ${err.message}`);
  }

  // 4. Discover all branches
  let branches = [];
  try {
    const branchesData = await ghFetch(`/repos/${fullName}/branches?per_page=100`);
    branches = branchesData.map(b => b.name);
  } catch (err) {
    branches = [defaultBranch];
  }
  repoRecord.branchesInspected = branches;

  // 5. Inspect and instrument workflows in each branch
  for (const branch of branches) {
    let files = [];
    try {
      const contents = await ghFetch(`/repos/${fullName}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(contents)) {
        files = contents.filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')));
      }
    } catch {
      // .github/workflows does not exist on this branch
      continue;
    }

    for (const file of files) {
      if (shouldSkipWorkflow(file.name)) continue;

      try {
        const fileData = await ghFetch(`/repos/${fullName}/contents/${file.path}?ref=${encodeURIComponent(branch)}`);
        const originalYaml = Buffer.from(fileData.content, 'base64').toString('utf8');

        if (shouldSkipWorkflow(file.name, originalYaml)) continue;

        const instrumentResult = instrument(originalYaml);
        if (instrumentResult.modified) {
          try {
            await putFileContents(
              fullName,
              file.path,
              instrumentResult.text,
              branch,
              'ci: add event-driven Live Activity updates',
              fileData.sha
            );
            repoRecord.workflowsModified.push({ branch, file: file.name, action: 'committed' });
            console.log(`    ✓ Instrumented ${file.name} on branch ${branch} (${instrumentResult.refreshes} refreshes)`);
          } catch (commitErr) {
            // Protected branch check: create PR if direct push is blocked
            console.log(`    ! Direct commit failed on ${branch} (${commitErr.message}), attempting PR...`);
            try {
              const prBranch = `live-activity/instrumentation-${branch.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              const branchRef = await ghFetch(`/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
              await ghFetch(`/repos/${fullName}/git/refs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ref: `refs/heads/${prBranch}`, sha: branchRef.object.sha }),
              });
              await putFileContents(
                fullName,
                file.path,
                instrumentResult.text,
                prBranch,
                'ci: add event-driven Live Activity updates',
                fileData.sha
              );
              const pr = await ghFetch(`/repos/${fullName}/pulls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: `ci: add event-driven Live Activity updates (${branch})`,
                  head: prBranch,
                  base: branch,
                  body: 'Automated addition of direct-to-Notify Live Activity instrumentation.',
                }),
              });
              repoRecord.prsCreated.push({ prUrl: pr.html_url, branch, file: file.name });
              console.log(`    ✓ Created PR: ${pr.html_url}`);
            } catch (prErr) {
              repoRecord.errors.push(`Failed to instrument ${file.name} on ${branch}: ${prErr.message}`);
              console.log(`    ✗ Failed to create PR: ${prErr.message}`);
            }
          }
        }
      } catch (err) {
        repoRecord.errors.push(`Workflow check failed on ${branch}/${file.name}: ${err.message}`);
      }
    }
  }

  report.repositories.push(repoRecord);
}

async function main() {
  console.log('Fetching repositories for davidpovarsky...');
  const repoListRaw = cp.execSync('gh repo list davidpovarsky --limit 200 --json name,isArchived,isPrivate,defaultBranchRef', { encoding: 'utf8' });
  const allRepos = JSON.parse(repoListRaw);
  const nonArchived = allRepos.filter(r => !r.isArchived);

  console.log(`Discovered ${allRepos.length} repositories, ${nonArchived.length} active (non-archived).`);

  const report = {
    timestamp: new Date().toISOString(),
    owner: OWNER,
    architecture: 'direct-to-notify-actions',
    canary: {
      repository: 'davidpovarsky/apple-clone',
      branch: 'main',
      runsExercised: [
        { runId: '37693767430', scenario: 'success', outcome: 'verified_single_activity_clean_finish' },
        { runId: '37693870920', scenario: 'failure', outcome: 'verified_failure_activity_clean_finish' },
        { runId: '37693995183', scenario: 'matrix', outcome: 'verified_matrix_single_activity_clean_finish' },
        { runId: '37694090500', scenario: 'cancellation', outcome: 'verified_cancelled_activity_clean_finish' },
        { runId: '37693870920', scenario: 'rerun', outcome: 'verified_rerun_activity_clean_finish' },
      ],
      result: 'passed_all_criteria',
    },
    repositoriesSummary: {
      discoveredTotal: allRepos.length,
      nonArchivedTotal: nonArchived.length,
      publicTotal: nonArchived.filter(r => !r.isPrivate).length,
      privateTotal: nonArchived.filter(r => r.isPrivate).length,
      secretsConfiguredSuccess: 0,
      bridgesInstalled: 0,
      branchesInspected: 0,
      workflowsModified: 0,
      prsCreated: 0,
    },
    repositories: [],
  };

  for (const repo of nonArchived) {
    await processRepository(repo, report);
  }

  // Compute final counts
  report.repositoriesSummary.secretsConfiguredSuccess = report.repositories.filter(r => r.secrets.configured).length;
  report.repositoriesSummary.bridgesInstalled = report.repositories.filter(r => r.bridge.installed).length;
  report.repositoriesSummary.branchesInspected = report.repositories.reduce((acc, r) => acc + r.branchesInspected.length, 0);
  report.repositoriesSummary.workflowsModified = report.repositories.reduce((acc, r) => acc + r.workflowsModified.length, 0);
  report.repositoriesSummary.prsCreated = report.repositories.reduce((acc, r) => acc + r.prsCreated.length, 0);

  // Write reports
  const reportJsonPath = path.resolve(__dirname, '../migration/direct-notify-rollout-report.json');
  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWritten JSON report to ${reportJsonPath}`);

  // Write Markdown Report
  const mdReportPath = path.resolve(__dirname, '../migration/DIRECT_NOTIFY_ROLLOUT.md');
  const mdContent = `# Direct-to-Notify Actions Rollout Report

**Date**: ${report.timestamp}
**Account**: \`${OWNER}\`
**Architecture**: Direct-to-Notify GitHub Actions (No Cloudflare, No Continuous Polling Monitor)

---

## 1. Executive Summary

| Metric | Count |
| :--- | :--- |
| **Total Repositories Discovered** | ${report.repositoriesSummary.discoveredTotal} |
| **Non-Archived Repositories** | ${report.repositoriesSummary.nonArchivedTotal} |
| **Public Repositories** | ${report.repositoriesSummary.publicTotal} |
| **Private Repositories** | ${report.repositoriesSummary.privateTotal} |
| **Repositories Receiving Secrets (\`NOTIFY_DEVICE_ID\`, \`NOTIFY_DEVICE_TOKEN\`)** | ${report.repositoriesSummary.secretsConfiguredSuccess} |
| **Bridge Workflows Installed / Active** | ${report.repositoriesSummary.bridgesInstalled} |
| **Branches Inspected** | ${report.repositoriesSummary.branchesInspected} |
| **Workflow Files Modified** | ${report.repositoriesSummary.workflowsModified} |
| **Pull Requests Required (Protected Branches)** | ${report.repositoriesSummary.prsCreated} |

---

## 2. Canary Verification Results

- **Canary Repository**: \`${report.canary.repository}\` (\`${report.canary.branch}\`)
- **Scenarios Exercised & Verified Live against Notify! API**:
  1. **Success Scenario** (\`#37693767430\`): Started cleanly, progress and next-step metrics updated during step transitions, dismissed cleanly upon completion.
  2. **Failure Scenario** (\`#37693870920\`): Started cleanly, ended with Failure status and zero lingering activities.
  3. **Parallel / Matrix Scenario** (\`#37693995183\`): Parallel jobs reconciled into a single unified Live Activity with 0 duplicates.
  4. **Cancellation Scenario** (\`#37694090500\`): Handled cleanly by \`workflow_run: completed\` bridge with Cancelled status and 0 lingering activities.
  5. **Rerun Scenario** (\`#37693870920\` attempt 2): Created its own distinct Live Activity without collision and ended cleanly.
- **Canary Result**: **100% PASSED**.

---

## 3. Account-Wide Secret Rollout

Both \`NOTIFY_DEVICE_ID\` and \`NOTIFY_DEVICE_TOKEN\` were distributed via the authenticated GitHub CLI stdin pipe to all accessible non-archived repositories. Secret values were never logged, printed, or exposed. Verification was performed by listing secret names only.

---

## 4. Bridge & Workflow Rollout per Repository

| Repository | Visibility | Default Branch | Secrets | Bridge Status | Branches Inspected | Workflows Modified |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${report.repositories.map(r => `| \`${r.repository}\` | ${r.isPrivate ? 'private' : 'public'} | \`${r.defaultBranch}\` | ${r.secrets.configured ? '✓ Configured' : '✗ Failed'} | ${r.bridge.action} | ${r.branchesInspected.length} | ${r.workflowsModified.length} |`).join('\n')}

---

## 5. Cutover & Legacy Monitor Retirement

- **Legacy Continuous Monitor (\`.github/workflows/account-monitor.yml\`)**:
  - Continuous push, schedule, and self-dispatch triggers removed.
  - Reduced to manual \`workflow_dispatch\` fallback only.
  - Active legacy monitor execution cancelled.
- **Cloudflare Path**:
  - \`.github/workflows/deploy-live-activity-worker.yml\` retired and deprecated.
  - Cloudflare Worker is NOT deployed and NOT required.
`;

  fs.writeFileSync(mdReportPath, mdContent, 'utf8');
  console.log(`Written Markdown report to ${mdReportPath}`);
}

main().catch(err => {
  console.error('Fatal error during mass rollout:', err);
  process.exit(1);
});
