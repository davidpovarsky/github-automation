const OWNER = 'davidpovarsky';
const CONFIG_URL = 'https://raw.githubusercontent.com/davidpovarsky/github-automation/main/config.json';
const DEFAULT_CONFIG_TTL_MS = 30_000;
const DEBOUNCE_MS = 1_000;
const INSTRUMENTATION_PREFIX = 'Live Activity ·';

let configCache = { expiresAt: 0, value: null };
let configTtlMs = DEFAULT_CONFIG_TTL_MS;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function normalizeConfig(parsed) {
  return {
    enabled: parsed?.enabled !== false,
    repositories: parsed?.repositories && typeof parsed.repositories === 'object' ? parsed.repositories : { '*': true },
    branches: parsed?.branches && typeof parsed.branches === 'object' ? parsed.branches : {},
    endExistingWhenDisabled: parsed?.endExistingWhenDisabled !== false,
  };
}

export function resolveScopeEnabled(config, repository, branch) {
  if (!config.enabled) return false;
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

export function short(value, max = 16) {
  const s = String(value ?? '').trim();
  if (!s) return '-';
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function runButton(run, repository) {
  return { title: `#${run.run_number} ↗`, url: run.html_url || `https://github.com/${repository}/actions/runs/${run.id}`, open: true, method: 'GET' };
}

export function visibleStep(job) {
  const steps = (job?.steps || []).filter(step => !String(step.name || '').startsWith(INSTRUMENTATION_PREFIX));
  return steps.find(s => s.status === 'in_progress') || steps.find(s => s.status === 'queued') || steps.find(s => s.status !== 'completed') || steps[steps.length - 1];
}

export function activityView(run, jobs) {
  const realJobs = (jobs || []).filter(j => !String(j.name || '').startsWith(INSTRUMENTATION_PREFIX));
  const completed = realJobs.filter(j => j.status === 'completed').length;
  const total = realJobs.length || 1;
  const active = realJobs.find(j => j.status === 'in_progress') || realJobs.find(j => j.status === 'queued') || realJobs.find(j => j.status !== 'completed') || realJobs[realJobs.length - 1];
  const step = visibleStep(active);
  return { completed, total: realJobs.length, progress: Math.min(99, Math.floor((completed / total) * 100)), body: active?.name || run.name, job: active?.name || 'Waiting', step: step?.name || run.status, fingerprint: JSON.stringify({ runStatus: run.status, runConclusion: run.conclusion, jobs: realJobs.map(j => [j.id, j.status, j.conclusion]), active: active ? [active.id, active.status, step?.number, step?.status] : null }) };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function github(env, endpoint) {
  return fetchJson(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${env.GH_MONITOR_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'davidpovarsky/github-live-activity' } });
}

async function loadConfig() {
  if (configCache.value && configCache.expiresAt > Date.now()) return { available: true, value: configCache.value, source: 'cache' };
  try {
    const value = normalizeConfig(await fetchJson(CONFIG_URL, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }));
    configCache = { value, expiresAt: Date.now() + configTtlMs };
    return { available: true, value, source: 'fresh' };
  } catch {
    if (configCache.value) return { available: true, value: configCache.value, source: 'last-known-good' };
    return { available: false, value: null, source: 'unavailable' };
  }
}

async function notify(env, action, activityId, payload = {}) {
  const address = action === 'start' ? env.NOTIFY_DEVICE_ID : activityId;
  if (!address || !env.NOTIFY_DEVICE_TOKEN) throw new Error('Notify secrets are not configured on the Worker');
  const url = new URL(`https://push.getnotifyapp.com/live-activity/${encodeURIComponent(address)}`);
  url.searchParams.set('token', env.NOTIFY_DEVICE_TOKEN);
  if (action === 'start') url.searchParams.set('new', '1');
  const response = await fetch(url, { method: action === 'end' ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'davidpovarsky/github-live-activity' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`Notify HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

function runUrl(run, repository) {
  return run.html_url || `https://github.com/${repository}/actions/runs/${run.id}`;
}

async function listDeviceActivities(env) {
  const url = new URL(`https://push.getnotifyapp.com/live-activity/${encodeURIComponent(env.NOTIFY_DEVICE_ID)}`);
  url.searchParams.set('token', env.NOTIFY_DEVICE_TOKEN);
  return fetchJson(url, { method: 'GET', headers: { Accept: 'application/json', 'user-agent': 'davidpovarsky/github-live-activity-recovery' } });
}

function matchingActivities(listResponse, targetUrl) {
  const activities = Array.isArray(listResponse?.activities) ? listResponse.activities : [];
  return activities.filter(activity => activity?.state === 'active' && activity?.content?.button?.url === targetUrl && /^LA[A-Z0-9]{6,}$/i.test(String(activity.activityId || '')));
}

function activityTimestamp(activity) {
  const value = activity?.updatedAt || activity?.startedAt || activity?.createdAt || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function recoverActivity(env, run, repository) {
  const response = await listDeviceActivities(env);
  const matches = matchingActivities(response, runUrl(run, repository));
  if (!matches.length) return { activityId: '', anomaly: false };
  const sorted = [...matches].sort((a, b) => activityTimestamp(b) - activityTimestamp(a) || String(b.activityId).localeCompare(String(a.activityId)));
  return { activityId: sorted[0].activityId, anomaly: matches.length > 1 };
}

function statusFor(conclusion) {
  const value = String(conclusion || 'completed').toLowerCase();
  return value === 'success' ? 'Success' : value === 'cancelled' ? 'Cancelled' : value === 'skipped' ? 'Skipped' : 'Failure';
}

async function verifiedRun(env, input) {
  const repository = String(input.repository || '').trim();
  const [owner, repo] = repository.split('/');
  if (owner !== OWNER || !repo || !/^\d+$/.test(String(input.run_id))) throw new Error('Invalid repository or run_id');
  const metadata = await github(env, `/repos/${owner}/${repo}`);
  if (metadata.full_name !== repository || metadata.owner?.login !== OWNER) throw new Error('Repository owner verification failed');
  const run = await github(env, `/repos/${owner}/${repo}/actions/runs/${input.run_id}`);
  if (run.repository?.full_name !== repository || Number(run.id) !== Number(input.run_id)) throw new Error('Run does not belong to repository');
  if (input.run_attempt !== undefined && input.run_attempt !== null && Number(input.run_attempt) !== Number(run.run_attempt || 1)) throw new Error('Run attempt mismatch');
  const jobs = await github(env, `/repos/${owner}/${repo}/actions/runs/${input.run_id}/jobs?filter=latest&per_page=100`);
  return { repository, run, jobs: jobs.jobs || [] };
}

async function reconcile(state, env, input, delayMs = 60_000, persist = async () => {}) {
  const { repository, run, jobs } = await verifiedRun(env, input);
  const configResult = await loadConfig();
  // Completion is authoritative even when config is unavailable or disabled.
  if (run.status === 'completed') {
    if (state.activityId && !state.finalised) {
      state.lifecycle = 'ending';
      await notify(env, 'end', state.activityId, { progress: 100, status: statusFor(run.conclusion), keepFor: 60 });
    }
    state.finalised = true;
    state.lifecycle = 'finalized';
    state.lastKnownStatus = run.conclusion || 'completed';
    state.conclusion = run.conclusion || 'completed';
    return { state, alarm: false };
  }
  // No valid config means fail closed: do not create or update activities.
  if (!configResult.available) return { state, alarm: !!state.activityId, delayMs };
  const branch = run.head_branch || '';
  const enabled = resolveScopeEnabled(configResult.value, repository, branch);
  if (!enabled) {
    if (state.activityId && configResult.value.endExistingWhenDisabled) {
      state.lifecycle = 'ending';
      await notify(env, 'end', state.activityId, { progress: 100, status: 'Disabled', keepFor: 60 });
      state.finalised = true;
      state.lifecycle = 'finalized';
    }
    return { state, alarm: false };
  }
  const view = activityView(run, jobs);
  if (!state.activityId && (state.lifecycle === 'starting' || state.startAttemptedAt)) {
    const recovered = await recoverActivity(env, run, repository);
    if (recovered.activityId) {
      state.activityId = recovered.activityId;
      state.recoveredActivity = true;
      state.recoveryAnomaly = recovered.anomaly;
      state.lifecycle = 'active';
    }
  }
  if (!state.activityId) {
    state.lifecycle = 'starting';
    state.startAttemptedAt = Date.now();
    await persist(state);
    const started = await notify(env, 'start', '', { title: repository.split('/').pop(), body: run.name, symbol: 'hammer.fill', tint: '#0A84FF', progress: 0, status: run.status === 'queued' ? 'Queued' : 'Running', metrics: [{ label: 'Branch', value: short(branch) }, { label: 'Workflow', value: short(run.name) }], button: runButton(run, repository) });
    state.activityId = started.activityId || '';
    if (!state.activityId) throw new Error('Notify start returned no activityId');
    state.createdAt = state.createdAt || Date.now();
    state.lifecycle = 'active';
  }
  if (state.lastFingerprint !== view.fingerprint || !state.lastNotifyAt || Date.now() - state.lastNotifyAt > 60_000) {
    await notify(env, 'update', state.activityId, { body: view.body, progress: view.progress, status: run.status === 'queued' ? 'Queued' : 'Running', metrics: [{ label: 'Branch', value: short(branch) }, { label: 'Job', value: short(view.job) }, { label: 'Step', value: short(view.step) }, { label: 'Done', value: `${view.completed}/${view.total}` }], button: runButton(run, repository) });
    state.lastFingerprint = view.fingerprint;
    state.lastNotifyAt = Date.now();
  }
  state.lastKnownStatus = run.status;
  return { state, alarm: true, delayMs };
}

export class RunState {
  constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
  fetch(request) {
    // Durable Object requests are explicitly serialized before any await or external call.
    const operation = this.queue.then(() => this.handle(request));
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async handle(request) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    let input; try { input = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    try {
      if (!input || typeof input.repository !== 'string' || !input.run_id) return json({ error: 'repository_and_run_id_required' }, 400);
      const current = await this.state.storage.get('state') || { repository: input.repository, runId: Number(input.run_id), runAttempt: Number(input.run_attempt || 1), activityId: '', createdAt: 0, lastFingerprint: '', lastNotifyAt: 0, lastKnownStatus: '', finalised: false, lifecycle: 'new', lastRequestAt: 0 };
      if (current.finalised) return json({ ok: true, finalised: true, debounced: false });
      const now = Date.now();
      const finalHint = input.event === 'final-hint';
      if (!finalHint && current.lifecycle !== 'starting' && current.lastRequestAt && now - current.lastRequestAt < DEBOUNCE_MS) return json({ ok: true, debounced: true, activity_id: current.activityId || null, finalised: false });
      current.lastRequestAt = now;
      const result = await reconcile(current, this.env, input, finalHint ? 5_000 : 60_000, state => this.state.storage.put('state', state));
      await this.state.storage.put('state', result.state);
      if (result.alarm) await this.state.storage.setAlarm(Date.now() + result.delayMs); else await this.state.storage.deleteAlarm();
      return json({ ok: true, activity_id: result.state.activityId || null, finalised: !!result.state.finalised, debounced: false });
    } catch (error) { return json({ ok: false, error: error.message }, 502); }
  }
  async alarm() {
    const state = await this.state.storage.get('state');
    if (!state || state.finalised) return;
    try {
      const result = await reconcile(state, this.env, { repository: state.repository, run_id: state.runId, run_attempt: state.runAttempt }, 60_000, nextState => this.state.storage.put('state', nextState));
      await this.state.storage.put('state', result.state);
      if (result.alarm) await this.state.storage.setAlarm(Date.now() + result.delayMs); else await this.state.storage.deleteAlarm();
    } catch { await this.state.storage.setAlarm(Date.now() + 60_000); }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'github-live-activity' });
    if (request.method !== 'POST' || url.pathname !== '/v1/refresh') return json({ error: 'not_found' }, 404);
    let input; try { input = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!input || typeof input.repository !== 'string' || !input.run_id) return json({ error: 'repository_and_run_id_required' }, 400);
    const attempt = Number(input.run_attempt || 1);
    const id = env.RUN_STATE.idFromName(`${input.repository}#${input.run_id}#${attempt}`);
    return env.RUN_STATE.get(id).fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ repository: input.repository, run_id: Number(input.run_id), run_attempt: attempt, event: input.event === 'final-hint' ? 'final-hint' : 'refresh' }) }));
  },
};

export function resetConfigCacheForTests() {
  configCache = { expiresAt: 0, value: null };
  configTtlMs = DEFAULT_CONFIG_TTL_MS;
}

export function setConfigTtlForTests(value) {
  configTtlMs = Math.max(0, Number(value));
}
