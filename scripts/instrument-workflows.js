'use strict';

const fs = require('fs');
const path = require('path');

const ACTION = 'davidpovarsky/github-automation/live-refresh@main';
const PREFIX = 'Live Activity ·';

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

function isListItem(line, indent) {
  return indentOf(line) === indent && /^\s*-\s+/.test(line);
}

function isInstrumentationStep(lines) {
  return lines.some(line => line.includes(ACTION) || line.includes(PREFIX));
}

function isFinalStep(lines) {
  return lines.some(line => line.includes('Live Activity · final'));
}

function hasDirectNotifyConfig(lines) {
  return lines.some(line => line.includes('NOTIFY_DEVICE_ID'));
}

function conditionLines(stepLines) {
  const index = stepLines.findIndex(line => /^\s*if:\s*/.test(line));
  if (index < 0) return [];
  const first = stepLines[index];
  const conditionIndent = indentOf(first);
  const result = [first.trim()];
  for (let i = index + 1; i < stepLines.length; i += 1) {
    const line = stepLines[i];
    if (line.trim() && indentOf(line) <= conditionIndent) break;
    if (!line.trim()) {
      result.push('');
      continue;
    }
    result.push(`${' '.repeat(Math.max(0, indentOf(line) - conditionIndent))}${line.trim()}`);
  }
  return result;
}

function renderRefresh(indent, condition) {
  const pad = ' '.repeat(indent);
  const renderedCondition = condition.length
    ? condition.map((line, index) => `${pad}  ${line}`)
    : [];
  return [
    `${pad}- name: Live Activity · refresh`,
    ...renderedCondition,
    `${pad}  uses: ${ACTION}`,
    `${pad}  continue-on-error: true`,
    `${pad}  with:`,
    `${pad}    event: refresh`,
    `${pad}    device_id: \${{ secrets.NOTIFY_DEVICE_ID }}`,
    `${pad}    token: \${{ secrets.NOTIFY_DEVICE_TOKEN }}`,
    `${pad}    github_token: \${{ github.token }}`,
  ];
}

function shouldSkipWorkflow(filePathOrName, content = '') {
  const name = path.basename(filePathOrName || '').toLowerCase();
  const skipNames = [
    'live-activity-bridge.yml',
    'live-activity-bridge.yaml',
    'account-monitor.yml',
    'account-monitor.yaml',
    'deploy-live-activity-worker.yml',
    'deploy-live-activity-worker.yaml',
    'notify-live-activity-watcher.yml',
    'notify-live-activity-watcher.yaml',
  ];
  if (skipNames.includes(name)) return true;

  if (
    content.includes('name: Live Activity Bridge') ||
    content.includes('name: Central Account Actions Monitor') ||
    content.includes('name: Deploy Live Activity Worker') ||
    content.includes('name: Notify Live Activity Watcher') ||
    content.includes('name: Test Workflow-Run Watcher')
  ) {
    return true;
  }
  return false;
}

function ensurePermissions(lines) {
  const permIdx = lines.findIndex(l => /^\s*permissions:\s*$/.test(l));
  if (permIdx === -1) return { lines, modified: false };

  const permIndent = indentOf(lines[permIdx]);
  const innerIndent = permIndent + 2;
  const pad = ' '.repeat(innerIndent);

  let endIdx = permIdx + 1;
  let hasActions = false;
  while (endIdx < lines.length) {
    const l = lines[endIdx];
    if (l.trim() && indentOf(l) <= permIndent) break;
    if (l.trim().startsWith('actions:')) hasActions = true;
    endIdx += 1;
  }

  if (hasActions) return { lines, modified: false };

  const updated = [...lines];
  updated.splice(permIdx + 1, 0, `${pad}actions: read`);
  return { lines: updated, modified: true };
}

function instrument(text, { preservePermissions = true } = {}) {
  let lines = text.split(/\r?\n/);
  let permissionsModified = false;

  if (preservePermissions) {
    const permResult = ensurePermissions(lines);
    if (permResult.modified) {
      lines = permResult.lines;
      permissionsModified = true;
    }
  }

  const output = [];
  let modified = permissionsModified;
  let jobs = 0;
  let refreshes = 0;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!/^\s*steps:\s*$/.test(line)) {
      output.push(line);
      i += 1;
      continue;
    }

    const stepsIndent = indentOf(line);
    const block = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (lines[j].trim() && indentOf(lines[j]) <= stepsIndent) break;
      block.push(lines[j]);
    }

    const firstItem = block.find(item => /^\s*-\s+/.test(item));
    if (!firstItem) {
      output.push(line, ...block);
      i = j;
      continue;
    }

    const itemIndent = indentOf(firstItem);
    const items = [];
    for (let k = 0; k < block.length; ) {
      if (!isListItem(block[k], itemIndent)) {
        k += 1;
        continue;
      }
      let end = k + 1;
      while (end < block.length && !isListItem(block[end], itemIndent)) end += 1;
      items.push({ start: k, end, lines: block.slice(k, end) });
      k = end;
    }

    const normalItems = items.filter(item => !isInstrumentationStep(item.lines));
    if (!normalItems.length) {
      output.push(line, ...block);
      i = j;
      continue;
    }

    jobs += 1;
    output.push(line);

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];

      // Remove unnecessary final-hint step per Section 14
      if (isFinalStep(item.lines)) {
        modified = true;
        continue;
      }

      if (isInstrumentationStep(item.lines)) {
        // Upgrade existing refresh step if it lacks direct-to-notify configuration
        if (!hasDirectNotifyConfig(item.lines)) {
          const nextItem = items.slice(idx + 1).find(candidate => !isInstrumentationStep(candidate.lines));
          const cond = nextItem ? conditionLines(nextItem.lines) : conditionLines(item.lines);
          output.push(...renderRefresh(itemIndent, cond));
          modified = true;
          refreshes += 1;
        } else {
          output.push(...item.lines);
        }
        continue;
      }

      const previous = items.slice(0, idx).reverse().find(candidate => !isFinalStep(candidate.lines));
      const alreadyHasRefresh =
        previous &&
        previous.lines.some(candidate => candidate.includes('Live Activity · refresh') || candidate.includes(ACTION)) &&
        hasDirectNotifyConfig(previous.lines);

      if (!alreadyHasRefresh) {
        output.push(...renderRefresh(itemIndent, conditionLines(item.lines)));
        refreshes += 1;
        modified = true;
      }
      output.push(...item.lines);
    }

    i = j;
  }

  return {
    text: output.join('\n'),
    modified,
    jobs,
    refreshes,
    finals: 0,
    reason: modified ? undefined : 'already-complete-or-no-normal-steps',
  };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/instrument-workflows.js <workflow.yml> [--write]');
  const original = fs.readFileSync(path.resolve(file), 'utf8');
  if (shouldSkipWorkflow(file, original)) {
    console.log(JSON.stringify({ skipped: true, reason: 'workflow-excluded' }, null, 2));
    process.exit(0);
  }
  const result = instrument(original);
  if (process.argv.includes('--write') && result.modified) {
    fs.writeFileSync(file, result.text, 'utf8');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = {
  instrument,
  renderRefresh,
  shouldSkipWorkflow,
  ensurePermissions,
};
