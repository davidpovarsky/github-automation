'use strict';

const fs = require('fs');
const path = require('path');

const ACTION = 'davidpovarsky/github-automation/live-refresh@main';
const PREFIX = 'Live Activity ·';

function indentOf(line) { return line.match(/^\s*/)[0].length; }
function isStepItem(line) { return /^\s*-\s+name:\s*/.test(line); }
function isInstrumentation(line) { return line.includes(ACTION) || line.includes(PREFIX); }
function renderRefresh(indent, conditionLine) {
  const pad = ' '.repeat(indent);
  return [
    `${pad}- name: Live Activity · refresh`,
    conditionLine ? `${pad}  ${conditionLine.trim()}` : null,
    `${pad}  uses: ${ACTION}`,
    `${pad}  continue-on-error: true`,
  ].filter(Boolean);
}
function renderFinal(indent) {
  const pad = ' '.repeat(indent);
  return [
    `${pad}- name: Live Activity · final`,
    `${pad}  if: always()`,
    `${pad}  uses: ${ACTION}`,
    `${pad}  continue-on-error: true`,
    `${pad}  with:`,
    `${pad}    event: final-hint`,
  ];
}

function instrument(text) {
  const lines = text.split(/\r?\n/);
  if (text.includes(ACTION)) return { text, modified: false, reason: 'already-instrumented' };
  const output = [];
  let modified = false;
  let jobs = 0;
  let refreshes = 0;
  let finals = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!/^\s*steps:\s*$/.test(line)) { output.push(line); i += 1; continue; }
    const stepsIndent = indentOf(line);
    const itemIndent = (() => {
      for (let j = i + 1; j < lines.length; j += 1) if (isStepItem(lines[j])) return indentOf(lines[j]);
      return stepsIndent + 2;
    })();
    const block = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate.trim() && indentOf(candidate) <= stepsIndent) break;
      block.push(candidate);
    }
    const hasNormalStep = block.some(item => isStepItem(item) && !isInstrumentation(item));
    output.push(line);
    if (!hasNormalStep) { output.push(...block); i = j; continue; }
    jobs += 1;
    for (let k = 0; k < block.length;) {
      const current = block[k];
      if (!isStepItem(current) || isInstrumentation(current)) { output.push(current); k += 1; continue; }
      const stepIndent = indentOf(current);
      let end = k + 1;
      while (end < block.length && !(isStepItem(block[end]) && indentOf(block[end]) === stepIndent)) end += 1;
      const stepLines = block.slice(k, end);
      const condition = stepLines.find(item => /^\s*if:\s*/.test(item));
      output.push(...renderRefresh(stepIndent, condition));
      output.push(...stepLines);
      refreshes += 1;
      modified = true;
      k = end;
    }
    output.push(...renderFinal(itemIndent));
    finals += 1;
    i = j;
  }
  return { text: output.join('\n'), modified, jobs, refreshes, finals, reason: modified ? undefined : 'no-normal-steps-found' };
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
