'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = 'davidpovarsky';
const GH_TOKEN = cp.execSync('gh auth token', { encoding: 'utf8' }).trim();

async function ghFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'davidpovarsky/bridge-updater',
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

function removeRequested(content) {
  // Matches "- requested\n" with any surrounding indentation
  return content.replace(/^[ \t]*-[ \t]*requested\r?\n/gm, '');
}

async function updateBridge(repo) {
  const repoFullName = repo.full_name;
  const defaultBranch = repo.default_branch;

  try {
    const fileRes = await ghFetch(`/repos/${repoFullName}/contents/.github/workflows/live-activity-bridge.yml?ref=${encodeURIComponent(defaultBranch)}`);
    if (!fileRes || !fileRes.content) {
      return { repo: repoFullName, status: 'no_bridge' };
    }

    const currentContent = Buffer.from(fileRes.content, 'base64').toString('utf8');
    if (!currentContent.includes('requested')) {
      return { repo: repoFullName, status: 'already_clean' };
    }

    const newContent = removeRequested(currentContent);
    if (newContent === currentContent) {
      return { repo: repoFullName, status: 'no_change' };
    }

    await ghFetch(`/repos/${repoFullName}/contents/.github/workflows/live-activity-bridge.yml`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'ci: update Live Activity Bridge to in_progress and completed only [skip ci]',
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        sha: fileRes.sha,
        branch: defaultBranch,
      }),
    });

    return { repo: repoFullName, status: 'updated' };
  } catch (err) {
    return { repo: repoFullName, status: 'error', error: err.message };
  }
}

async function main() {
  console.log('Discovering non-archived repositories...');
  const repos = await getRepos();
  console.log(`Found ${repos.length} repositories.`);

  let updatedCount = 0;
  let cleanCount = 0;
  let noBridgeCount = 0;
  let errorCount = 0;
  const results = [];

  // Update with concurrency = 5
  const concurrency = 5;
  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(r => updateBridge(r)));
    for (const res of chunkResults) {
      results.push(res);
      if (res.status === 'updated') {
        updatedCount++;
        console.log(`  ✓ Updated bridge: ${res.repo}`);
      } else if (res.status === 'already_clean') {
        cleanCount++;
        console.log(`  - Already clean: ${res.repo}`);
      } else if (res.status === 'no_bridge') {
        noBridgeCount++;
        console.log(`  - No bridge: ${res.repo}`);
      } else {
        errorCount++;
        console.error(`  ✗ Error on ${res.repo}: ${res.error}`);
      }
    }
  }

  console.log('\n========================================');
  console.log('BRIDGE UPDATE SUMMARY:');
  console.log(`  - Total Repositories: ${repos.length}`);
  console.log(`  - Bridges Updated:    ${updatedCount}`);
  console.log(`  - Already Clean:      ${cleanCount}`);
  console.log(`  - No Bridge:          ${noBridgeCount}`);
  console.log(`  - Errors:             ${errorCount}`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal error in bridge updater:', err);
  process.exit(1);
});
