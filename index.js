'use strict';

const fs = require('fs');

const BASE_URL = 'https://push.getnotifyapp.com';

function getInput(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

function parseBool(value, fallback = false) {
  if (value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(name, value, { integer = false, min, max } = {}) {
  if (value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    throw new Error(`Input "${name}" must be ${integer ? 'an integer' : 'a number'}; got "${value}".`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`Input "${name}" must be >= ${min}; got ${n}.`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`Input "${name}" must be <= ${max}; got ${n}.`);
  }
  return n;
}

function parseJsonInput(name, value, expected) {
  if (value === '') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Input "${name}" is not valid JSON: ${error.message}`);
  }

  if (expected === 'array' && !Array.isArray(parsed)) {
    throw new Error(`Input "${name}" must be a JSON array.`);
  }
  if (expected === 'object' && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) {
    throw new Error(`Input "${name}" must be a JSON object.`);
  }
  return parsed;
}

function normalizeMetrics(metrics) {
  if (metrics === undefined) return undefined;
  if (metrics.length > 6) {
    throw new Error('Notify! supports at most 6 metrics.');
  }

  return metrics.map((metric, index) => {
    if (!metric || Array.isArray(metric) || typeof metric !== 'object') {
      throw new Error(`metrics_json[${index}] must be an object.`);
    }

    const result = { ...metric };

    // Notify! requires metric values to be strings. Coerce deliberately so
    // callers do not hit the Shortcuts-style number/string serialization bug.
    if (result.value !== undefined && result.value !== null) {
      result.value = String(result.value);

      // Notify! currently limits metric values to 1–16 characters.
      // Truncate safely instead of letting an otherwise valid workflow fail.
      if (result.value.length > 16) {
        const original = result.value;
        result.value = original.slice(0, 15) + '…';
        warning(`metrics_json[${index}].value exceeded 16 characters and was truncated to "${result.value}".`);
      }

      if (result.value.length < 1) {
        throw new Error(`metrics_json[${index}].value must contain at least 1 character.`);
      }
    }
    if (result.label !== undefined && result.label !== null) {
      result.label = String(result.label);
    }
    if (result.unit !== undefined && result.unit !== null) {
      result.unit = String(result.unit);
    }

    return result;
  });
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const safe = value === undefined || value === null ? '' : String(value).replace(/\r?\n/g, ' ');
  fs.appendFileSync(outputFile, `${name}=${safe}\n`, 'utf8');
}

function warning(message) {
  console.log(`::warning::${message}`);
}

function errorAnnotation(message) {
  console.log(`::error::${message}`);
}

function maskSecret(value) {
  if (value) console.log(`::add-mask::${value}`);
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'Unable to serialize response' });
  }
}

function emitResult({ activityId = '', expiresAt = '', state = '', response = {} }) {
  setOutput('activity_id', activityId);
  setOutput('expires_at', expiresAt);
  setOutput('state', state);
  setOutput('response_json', compactJson(response));
}

async function main() {
  const action = getInput('action').toLowerCase();
  const deviceId = getInput('device_id');
  const token = getInput('token');
  const activityIdInput = getInput('activity_id');
  const failOnError = parseBool(getInput('fail_on_error'), false);
  const newActivity = parseBool(getInput('new_activity'), true);

  maskSecret(token);

  if (!['start', 'update', 'end'].includes(action)) {
    throw new Error(`Input "action" must be start, update, or end; got "${action || '(empty)'}".`);
  }

  // GitHub intentionally withholds repository secrets from fork PRs.
  // Treat missing credentials as a skipped notification by default.
  if (!deviceId || !token) {
    const message = 'Notify! credentials are missing. This is expected for fork pull requests; no Live Activity was sent.';
    if (failOnError) throw new Error(message);
    warning(message);
    emitResult({ state: 'skipped', response: { success: false, skipped: true, message } });
    return;
  }

  let addressId;
  if (action === 'start') {
    addressId = deviceId;
  } else {
    if (!activityIdInput) {
      throw new Error(`Input "activity_id" is required for action "${action}".`);
    }
    if (!/^LA[A-Z0-9]{6,}$/i.test(activityIdInput)) {
      throw new Error(`Input "activity_id" does not look like a Notify! Live Activity ID: "${activityIdInput}".`);
    }
    addressId = activityIdInput;
  }

  const payload = {};

  const textFields = [
    ['title', 'title'],
    ['body', 'body'],
    ['symbol', 'symbol'],
    ['tint', 'tint'],
    ['trailing', 'trailing'],
    ['status', 'status'],
  ];
  for (const [inputName, apiName] of textFields) {
    const value = getInput(inputName);
    if (value !== '') payload[apiName] = value;
  }

  const progress = parseNumber('progress', getInput('progress'), { min: 0, max: 100 });
  const endsIn = parseNumber('ends_in', getInput('ends_in'), { integer: true, min: 1, max: 86400 });
  const steps = parseNumber('steps', getInput('steps'), { integer: true, min: 2, max: 20 });
  const step = parseNumber('step', getInput('step'), { integer: true, min: 0 });
  const keepFor = parseNumber('keep_for', getInput('keep_for'), { integer: true, min: 0 });

  if (progress !== undefined) payload.progress = progress;
  if (endsIn !== undefined) payload.endsIn = endsIn;
  if (steps !== undefined) payload.steps = steps;
  if (step !== undefined) payload.step = step;

  const metrics = normalizeMetrics(parseJsonInput('metrics_json', getInput('metrics_json'), 'array'));
  const button = parseJsonInput('button_json', getInput('button_json'), 'object');
  if (metrics !== undefined) payload.metrics = metrics;
  if (button !== undefined) payload.button = button;

  if (action === 'start' && !payload.title) {
    throw new Error('Input "title" is required when starting a new Notify! Live Activity.');
  }

  if (action === 'end' && keepFor !== undefined) {
    payload.keepFor = keepFor;
  }

  const url = new URL(`${BASE_URL}/live-activity/${encodeURIComponent(addressId)}`);
  url.searchParams.set('token', token);
  if (action === 'start' && newActivity) {
    url.searchParams.set('new', '1');
  }

  const method = action === 'end' ? 'DELETE' : 'POST';

  console.log(`Notify!: ${action} Live Activity (${action === 'start' ? 'device' : 'activity'} ${addressId})`);

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'davidpovarsky/github-automation',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { raw: responseText };
  }

  if (!response.ok) {
    const apiMessage = responseBody && typeof responseBody === 'object'
      ? (responseBody.message || responseBody.error || compactJson(responseBody))
      : responseText;

    const message = `Notify! API returned HTTP ${response.status}: ${apiMessage || response.statusText}`;
    emitResult({
      activityId: responseBody?.activityId || activityIdInput,
      expiresAt: responseBody?.expiresAt || '',
      state: 'error',
      response: responseBody,
    });

    if (failOnError) {
      throw new Error(message);
    }

    warning(message);
    return;
  }

  const returnedActivityId = responseBody?.activityId || activityIdInput || '';
  const state = responseBody?.state || (action === 'end' ? 'ended' : 'active');

  if (action === 'start' && !returnedActivityId) {
    const message = 'Notify! start succeeded but no activityId was returned; refusing to export an ambiguous handle.';
    emitResult({ state: 'error', response: responseBody });
    if (failOnError) throw new Error(message);
    warning(message);
    return;
  }

  emitResult({
    activityId: returnedActivityId,
    expiresAt: responseBody?.expiresAt || '',
    state,
    response: responseBody,
  });

  console.log(`Notify!: success (${returnedActivityId || state})`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const failOnError = parseBool(getInput('fail_on_error'), false);

  emitResult({
    state: 'error',
    response: { success: false, error: message },
  });

  if (failOnError) {
    errorAnnotation(message);
    process.exitCode = 1;
  } else {
    warning(message);
  }
});
