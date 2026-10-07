'use strict';

const fs = require('fs');
const path = require('path');

const ACTION = 'davidpovarsky/github-automation/live-refresh@main';
const PREFIX = 'Live Activity ·';

function indentOf(line) { return line.match(/^\s*/)[0].length; }
function isListItem(line, indent) { return indentOf(line) === indent && /^\s*-\s+/.test(line); }
function isInstrumentationStep(lines) { return lines.some(line => line.includes(ACTION) || line.includes(PREFIX)); }
function renderRefresh(indent, conditionLine) {
  const pad = ' '.repeat(indent);
  return [`${pad}- name: Live Activity · refresh`, conditionLine ? `${pad}  ${conditionLine.trim()}` : null, `${pad}  uses: ${ACTION}`, `${pad}  continue-on-error: true`].filter(Boolean);
}
function renderFinal(indent) {
  const pad = ' '.repeat(indent);
  return [`${pad}- name: Live Activity · final`, `${pad}  if: always()`, `${pad}  uses: ${ACTION}`, `${pad}  continue-on-error: true`, `${pad}  with:`, `${pad}    event: final-hint`];
}

function instrument(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let modified = false;
  let jobs = 0;
  let refreshes = 0;
  let finals = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!/^\s*steps:\s*$/.test(line)) { output.push(line); i += 1; continue; }
    const stepsIndent = indentOf(line);
    const block = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (lines[j].trim() && indentOf(lines[j]) <= stepsIndent) break;
      block.push(lines[j]);
    }
    const firstItem = block.find(item => /^\s*-\s+/.test(item));
    if (!firstItem) { output.push(line, ...block); i = j; continue; }
    const itemIndent = indentOf(firstItem);
    const items = [];
    for (let k = 0; k < block.length;) {
      if (!isListItem(block[k], itemIndent)) { k += 1; continue; }
      let end = k + 1;
      while (end < block.length && !isListItem(block[end], itemIndent)) end += 1;
      items.push({ start: k, end, lines: block.slice(k, end) });
      k = end;
    }
    const normalItems = items.filter(item => !isInstrumentationStep(item.lines));
    if (!normalItems.length) { output.push(line, ...block); i = j; continue; }
    jobs += 1;
    output.push(line);
    for (const item of items) {
      if (isInstrumentationStep(item.lines)) {
        output.push(...item.lines);
        continue;
      }
      const previous = items.find(candidate => candidate.end === item.start);
      const alreadyHasRefresh = previous && previous.lines.some(candidate => candidate.includes('Live Activity · refresh') || candidate.includes(ACTION));
      if (!alreadyHasRefresh) {
        const condition = item.lines.find(candidate => /^\s*if:\s*/.test(candidate));
        output.push(...renderRefresh(itemIndent, condition));
        refreshes += 1;
        modified = true;
      }
      output.push(...item.lines);
    }
    const existingFinal = items.some(item => item.lines.some(candidate => candidate.includes('Live Activity · final')));
    if (!existingFinal) {
      output.push(...renderFinal(itemIndent));
      finals += 1;
      modified = true;
    }
    i = j;
  }
  return { text: output.join('\n'), modified, jobs, refreshes, finals, reason: modified ? undefined : 'already-complete-or-no-normal-steps' };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/instrument-workflows.js <workflow.yml> [--write]');
  const original = fs.readFileSync(path.resolve(file), 'utf8');
  const result = instrument(original);
  if (process.argv.includes('--write') && result.modified) fs.writeFileSync(file, result.text);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { instrument, renderRefresh, renderFinal };
