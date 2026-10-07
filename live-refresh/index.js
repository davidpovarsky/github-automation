'use strict';

const INSTRUMENTATION_PREFIX = 'Live Activity ·';
const CONFIG_URL = 'https://raw.githubusercontent.com/davidpovarsky/github-automation/main/config.json';
const NOTIFY_BASE_URL = 'https://push.getnotifyapp.com/live-activity';
const TIMEOUT_MS = 1800;

let configCache = { expiresAt: 0, value: null };
let configTtlMs = 30_000;

function resetConfigCacheForTests() {
  configCache = { expiresAt: 0, value: null };
}

function setConfigTtlForTests(ttlMs) {
  configTtlMs = ttlMs;
}

function warning(message) {
  console.log(`::warning::${message}`);
}

function maskSecret(value) {
  if (value && typeof value === 'string' && value.length > 3) {
    console.log(`::add-mask::${value}`);
  }
}

function short(value, max = 16) {
  const s = String(value ?? '').trim();
  if (!s) return '-';
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeConfig(parsed) {
  return {
    enabled: parsed?.enabled !== false,
    repositories: parsed?.repositories && typeof parsed.repositories === 'object' ? parsed.repositories : { '*': true },
    branches: parsed?.branches && typeof parsed.branches === 'object' ? parsed.branches : {},
    endExistingWhenDisabled: parsed?.endExistingWhenDisabled !== false,
  };
}

function resolveScopeEnabled(config, repository, branch) {
  if (!config || !config.enabled) return false;
  let enabled = true;
  const repos = config.repositories || {};
  if (Object.hasOwn(repos, '*')) enabled = repos['*'] !== false;
  if (repository && Object.hasOwn(repos, repository)) enabled = repos[repository] !== false;
  const apply = rules => {
    if (!rules || typeof rules !== 'object') return;
    if (Object.hasOwn(rules, '*')) enabled = rules['*'] !== false;
    if (branch && Object.hasOwn(rules, branch)) enabled = rules[branch] !== false;
  };
  apply(config.branches?.['*']);
  apply(repository ? config.branches?.[repository] : undefined);
  return enabled;
}

function runUrl(run, repository) {
  return run.html_url || `https://github.com/${repository}/actions/runs/${run.id}`;
}

function runButton(run, repository) {
  return {
    title: `#${run.run_number} ↗`,
    url: runUrl(run, repository),
    open: true,
    method: 'GET',
  };
}

function isInstrumentationStep(step) {
  return String(step?.name || '').startsWith(INSTRUMENTATION_PREFIX);
}

function stepDisplayName(step) {
  if (!step) return '';
  if (step.name && String(step.name).trim()) return String(step.name).trim();
  if (step.number) return `Step #${step.number}`;
  return 'Running';
}

function visibleStep(job) {
  const steps = (job?.steps || []).filter(step => !isInstrumentationStep(step));
  return (
    steps.find(s => s.status === 'in_progress') ||
    steps.find(s => s.status === 'queued') ||
    steps.find(s => s.status !== 'completed') ||
    steps[steps.length - 1]
  );
}

function activityView(run, jobs) {
  const realJobs = (jobs || []).filter(j => !String(j.name || '').startsWith(INSTRUMENTATION_PREFIX));
  const completed = realJobs.filter(j => j.status === 'completed').length;
  const total = realJobs.length;
  const active =
    realJobs.find(j => j.status === 'in_progress') ||
    realJobs.find(j => j.status === 'queued') ||
    realJobs.find(j => j.status !== 'completed') ||
    realJobs[realJobs.length - 1];
  const step = visibleStep(active);
  const stepName = stepDisplayName(step) || run.status || 'Running';
  return {
    completed,
    total,
    progress: total > 0 ? Math.min(99, Math.floor((completed / total) * 100)) : 0,
    body: active?.name || run.name,
    job: active?.name || 'Waiting',
    step: stepName,
    fingerprint: JSON.stringify({
      runStatus: run.status,
      runConclusion: run.conclusion,
      jobs: realJobs.map(j => [j.id, j.status, j.conclusion]),
      active: active ? [active.id, active.status, step?.number, step?.status] : null,
    }),
  };
}

function statusFor(conclusion) {
  const val = String(conclusion || 'completed').toLowerCase();
  if (val === 'success') return 'Success';
  if (val === 'failure') return 'Failure';
  if (val === 'cancelled') return 'Cancelled';
  if (val === 'timed_out') return 'Timed Out';
  if (val === 'skipped') return 'Skipped';
  if (val === 'action_required') return 'Action Required';
  if (val === 'stale') return 'Stale';
  if (val === 'neutral') return 'Neutral';
  return val.charAt(0).toUpperCase() + val.slice(1);
}

function matchingActivities(listResponse, targetUrl) {
  const activities = Array.isArray(listResponse?.activities) ? listResponse.activities : [];
  return activities.filter(activity =>
    activity?.state !== 'ended' &&
    activity?.state !== 'dismissed' &&
    activity?.content?.button?.url === targetUrl &&
    /^LA[A-Za-z0-9_-]{2,}$/i.test(String(activity.activityId || ''))
  );
}

function activityTimestamp(activity) {
  const value = activity?.updatedAt || activity?.startedAt || activity?.createdAt || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function sortActivities(matches) {
  return [...matches].sort((a, b) =>
    activityTimestamp(b) - activityTimestamp(a) ||
    String(b.activityId).localeCompare(String(a.activityId))
  );
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 1800) {
  const signal = AbortSignal.timeout(1800);
  return fetch(url, { ...init, signal });
}

async function loadConfig(fetchFn = fetchWithTimeout) {
  if (configCache.value && configCache.expiresAt > Date.now()) {
    return { available: true, value: configCache.value, source: 'cache' };
  }
  try {
    const res = await fetchFn(CONFIG_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'davidpovarsky/github-automation',
        'Cache-Control': 'no-cache',
      },
    });
    if (res.ok) {
      const parsed = await res.json();
      const value = normalizeConfig(parsed);
      configCache = { value, expiresAt: Date.now() + configTtlMs };
      return { available: true, value, source: 'fresh' };
    }
  } catch {}
  if (configCache.value) {
    return { available: true, value: configCache.value, source: 'last-known-good' };
  }
  return { available: false, value: null, source: 'unavailable' };
}

async function fetchGithub(endpoint, token, fetchFn = fetchWithTimeout) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'davidpovarsky/github-live-activity',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchFn(`https://api.github.com${endpoint}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API HTTP ${res.status} on ${endpoint}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function listDeviceActivities(deviceId, token, fetchFn = fetchWithTimeout) {
  const url = new URL(`${NOTIFY_BASE_URL}/${encodeURIComponent(deviceId)}`);
  url.searchParams.set('token', token);
  const res = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'davidpovarsky/github-live-activity' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notify list HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function startNotifyActivity(deviceId, token, payload, fetchFn = fetchWithTimeout) {
  const url = new URL(`${NOTIFY_BASE_URL}/${encodeURIComponent(deviceId)}`);
  url.searchParams.set('token', token);
  url.searchParams.set('new', '1');
  const res = await fetchFn(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'davidpovarsky/github-live-activity',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notify start HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function updateNotifyActivity(activityId, token, payload, fetchFn = fetchWithTimeout) {
  const url = new URL(`${NOTIFY_BASE_URL}/${encodeURIComponent(activityId)}`);
  url.searchParams.set('token', token);
  const res = await fetchFn(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'davidpovarsky/github-live-activity',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notify update HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function endNotifyActivity(activityId, token, payload = {}, fetchFn = fetchWithTimeout) {
  const url = new URL(`${NOTIFY_BASE_URL}/${encodeURIComponent(activityId)}`);
  url.searchParams.set('token', token);
  const res = await fetchFn(url.toString(), {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'davidpovarsky/github-live-activity',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notify end HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function executeDirectNotify(inputs, fetchFn = fetchWithTimeout) {
  const event = (inputs.event || 'refresh').toLowerCase() === 'final-hint' ? 'final' : (inputs.event || 'refresh').toLowerCase();
  const deviceId = inputs.deviceId || '';
  const token = inputs.token || '';
  const githubToken = inputs.githubToken || '';
  const sourceRepository = (inputs.sourceRepository || '').trim();
  const sourceRunId = String(inputs.sourceRunId || '').trim();
  const sourceRunAttempt = Number(inputs.sourceRunAttempt || 1);
  const sourceBranch = (inputs.sourceBranch || '').trim();

  maskSecret(token);
  maskSecret(githubToken);

  // Missing credentials: fork PRs or unconfigured secrets fail open cleanly
  if (!deviceId || !token) {
    warning('Notify credentials are not configured or withheld on fork PR; build continues without notification.');
    return { ok: true, status: 'skipped', reason: 'missing_credentials' };
  }

  if (!sourceRepository || !sourceRunId) {
    warning('GitHub repository or run ID is unavailable; build continues without notification.');
    return { ok: true, status: 'skipped', reason: 'missing_identifiers' };
  }

  const [owner, repo] = sourceRepository.split('/');
  if (!owner || !repo || !/^\d+$/.test(sourceRunId)) {
    warning('Invalid repository or run ID format; build continues.');
    return { ok: true, status: 'skipped', reason: 'invalid_identifiers' };
  }

  const runId = Number(sourceRunId);

  // 1. Fetch GitHub run and jobs
  let run;
  let jobs = [];
  try {
    const runData = await fetchGithub(`/repos/${owner}/${repo}/actions/runs/${runId}`, githubToken, fetchFn);
    if (!runData || Number(runData.id) !== runId) {
      throw new Error(`Run ID mismatch in GitHub response`);
    }
    if (runData.run_attempt && Number(runData.run_attempt) !== sourceRunAttempt) {
      warning(`Run attempt mismatch (expected ${sourceRunAttempt}, got ${runData.run_attempt}); build continues.`);
      return { ok: true, status: 'skipped', reason: 'run_attempt_mismatch' };
    }
    run = runData;
    if (run.name === 'Live Activity Bridge' || String(run.name || '').startsWith('Live Activity Bridge')) {
      return { ok: true, status: 'skipped', reason: 'bridge_workflow_ignored' };
    }
    const jobsData = await fetchGithub(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, githubToken, fetchFn);
    jobs = jobsData?.jobs || [];
  } catch (error) {
    warning(`GitHub API query failed: ${error.message}; build continues.`);
    return { ok: false, status: 'error', reason: 'github_api_error', error: error.message };
  }

  const targetUrl = runUrl(run, sourceRepository);
  const isCompleted = run.status === 'completed' || event === 'final';

  // 2. Authoritative Central Config Evaluation
  const configRes = await loadConfig(fetchFn);
  if (!configRes.available) {
    if (!isCompleted) {
      warning('Central config is unavailable; failing closed for start/refresh.');
      return { ok: true, status: 'skipped', reason: 'config_unavailable' };
    }
  } else {
    const branch = sourceBranch || run.head_branch || '';
    const enabled = resolveScopeEnabled(configRes.value, sourceRepository, branch);
    if (!enabled) {
      if (!configRes.value.endExistingWhenDisabled) {
        return { ok: true, status: 'skipped', reason: 'disabled_by_config' };
      }
      // If disabled but endExistingWhenDisabled, fall through to end any existing matching activity
    }
  }

  // 3. Query Device Activities for exact run URL
  let listRes;
  try {
    listRes = await listDeviceActivities(deviceId, token, fetchFn);
  } catch (error) {
    warning(`Notify list activities failed: ${error.message}; build continues.`);
    return { ok: false, status: 'error', reason: 'notify_list_error', error: error.message };
  }

  const matches = matchingActivities(listRes, targetUrl);
  const sortedMatches = sortActivities(matches);

  const configDisabled = configRes.available && !resolveScopeEnabled(configRes.value, sourceRepository, sourceBranch || run.head_branch || '');

  // 4. Completed Run or Disabled Cleanup -> End ALL matching activities
  if (isCompleted || configDisabled) {
    const endStatus = configDisabled ? 'Disabled' : statusFor(run.conclusion);
    const endPayload = { progress: 100, status: endStatus, keepFor: 60 };
    for (const match of sortedMatches) {
      try {
        await endNotifyActivity(match.activityId, token, endPayload, fetchFn);
      } catch (err) {
        warning(`Notify end failed for ${match.activityId}: ${err.message}`);
      }
    }
    return { ok: true, status: 'ended', count: sortedMatches.length, conclusion: endStatus };
  }

  // 5. Active Start or Refresh
  const view = activityView(run, jobs);
  const repoTitle = sourceRepository.split('/').pop() || sourceRepository;
  const branchShort = short(sourceBranch || run.head_branch, 16);
  const btn = runButton(run, sourceRepository);
  const metrics = [
    { label: 'Branch', value: branchShort },
    { label: 'Job', value: short(view.job, 16) },
    { label: 'Step', value: short(view.step, 16) },
    { label: 'Done', value: short(`${view.completed}/${view.total}`, 16) },
  ];
  const currentStatus = run.status === 'queued' ? 'Queued' : 'Running';

  if (sortedMatches.length > 0) {
    const [canonical, ...duplicates] = sortedMatches;
    // Self-healing: end duplicate activities deterministically
    for (const dup of duplicates) {
      try {
        await endNotifyActivity(dup.activityId, token, { progress: 100, status: 'Duplicate', keepFor: 0 }, fetchFn);
      } catch (err) {
        warning(`Failed to end duplicate activity ${dup.activityId}: ${err.message}`);
      }
    }
    // Update canonical activity
    try {
      await updateNotifyActivity(canonical.activityId, token, {
        body: view.body,
        progress: view.progress,
        status: currentStatus,
        metrics,
        button: btn,
      }, fetchFn);
      return { ok: true, status: 'updated', activityId: canonical.activityId };
    } catch (err) {
      warning(`Notify update failed: ${err.message}; build continues.`);
      return { ok: false, status: 'error', reason: 'notify_update_error', error: err.message };
    }
  } else {
    // No matching activity -> Start new activity
    let startRes;
    try {
      startRes = await startNotifyActivity(deviceId, token, {
        title: repoTitle,
        body: view.body,
        symbol: 'hammer.fill',
        tint: '#0A84FF',
        progress: view.progress,
        status: currentStatus,
        metrics,
        button: btn,
      }, fetchFn);
    } catch (err) {
      warning(`Notify start failed: ${err.message}; build continues.`);
      return { ok: false, status: 'error', reason: 'notify_start_error', error: err.message };
    }

    const createdId = startRes?.activityId;

    // Immediately re-query device activities to detect concurrency races and reconcile duplicates
    try {
      const recheckList = await listDeviceActivities(deviceId, token, fetchFn);
      const recheckMatches = sortActivities(matchingActivities(recheckList, targetUrl));
      if (recheckMatches.length > 1) {
        const [winner, ...losers] = recheckMatches;
        for (const loser of losers) {
          try {
            await endNotifyActivity(loser.activityId, token, { progress: 100, status: 'Duplicate', keepFor: 0 }, fetchFn);
          } catch {}
        }
        return { ok: true, status: 'started_reconciled', activityId: winner.activityId };
      }
    } catch {}

    return { ok: true, status: 'started', activityId: createdId };
  }
}

function getEnvInputs(env = process.env) {
  function input(name, fallback = '') {
    return (env[`INPUT_${name.toUpperCase()}`] || fallback).trim();
  }
  return {
    event: input('event', 'refresh'),
    deviceId: input('device_id') || env.NOTIFY_DEVICE_ID || '',
    token: input('token') || env.NOTIFY_DEVICE_TOKEN || '',
    githubToken: input('github_token') || env.GITHUB_TOKEN || env.GH_TOKEN || '',
    sourceRepository: input('source_repository') || env.GITHUB_REPOSITORY || '',
    sourceRunId: input('source_run_id') || env.GITHUB_RUN_ID || '',
    sourceRunAttempt: input('source_run_attempt') || env.GITHUB_RUN_ATTEMPT || '1',
    sourceBranch: input('source_branch') || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '',
  };
}

async function main() {
  const inputs = getEnvInputs();
  try {
    await executeDirectNotify(inputs);
  } catch (error) {
    warning(`Live Activity unexpected failure: ${error.message}; build continues.`);
  }
}

if (require.main === module) {
  main().catch(error => {
    warning(`Live Activity execution failed: ${error.message}; build continues.`);
  });
}

module.exports = {
  executeDirectNotify,
  getEnvInputs,
  normalizeConfig,
  resolveScopeEnabled,
  loadConfig,
  resetConfigCacheForTests,
  setConfigTtlForTests,
  short,
  runUrl,
  runButton,
  visibleStep,
  activityView,
  statusFor,
  matchingActivities,
  sortActivities,
  isInstrumentationStep,
  stepDisplayName,
};
