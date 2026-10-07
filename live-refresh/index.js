'use strict';

function input(name, fallback = '') {
  return (process.env[`INPUT_${name.toUpperCase()}`] || fallback).trim();
}
function warning(message) { console.log(`::warning::${message}`); }

async function main() {
  const endpoint = input('endpoint') || process.env.LIVE_ACTIVITY_WORKER_URL || '';
  if (!endpoint) { warning('Live Activity Worker endpoint is not configured; build continues without notification.'); return; }
  const payload = {
    repository: process.env.GITHUB_REPOSITORY || '',
    run_id: Number(process.env.GITHUB_RUN_ID || 0),
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
    ref: process.env.GITHUB_REF_NAME || '',
    event: input('event', 'refresh') === 'final-hint' ? 'final-hint' : 'refresh',
  };
  if (!payload.repository || !payload.run_id) { warning('GitHub run identifiers are unavailable; build continues without notification.'); return; }
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'davidpovarsky/github-live-activity-refresh' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    if (!response.ok) warning(`Live Activity Worker returned HTTP ${response.status}; build continues.`);
  } catch (error) { warning(`Live Activity refresh failed: ${error.message}; build continues.`); }
}

main().catch(error => warning(`Live Activity refresh failed: ${error.message}; build continues.`));
