#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { batch, DEFAULT_CONCURRENCY, gatePath, runCommand } from '../src/index.js';

const HELP = `pfdeploy: deploy in batches, ${DEFAULT_CONCURRENCY} at a time.

  pfdeploy batch [-c 3] [--keep-going] [--min-free-gb 8] -- '<command with {}>' item1 item2 ...
      run the command once per item, at most -c at once ({} is the quoted item;
      without {} the item is appended). Items may also come on stdin, one per line.
      Stops starting new items after the first failure unless --keep-going.
  pfdeploy gate [--slots 3] [--name site] -- <command...>
      take one of the box's deploy slots, then run the command (bin/deploy-gate).
  pfdeploy status [--slots 3]     which deploy slots are busy, and by whom
  pfdeploy install [dir]          copy deploy-gate to dir (default /usr/local/bin)

Examples:
  pfdeploy batch -c 3 -- 'cd ~/src/profullstack/{} && bun test && gh pr merge --squash' crawlproof smshub ugig
  ls ~/www | pfdeploy batch -c 3 -- '~/www/{}/deploy-app.sh origin/main'
`;

const args = process.argv.slice(2);
const command = args.shift();

const gate = (rest) => {
  const r = spawnSync('bash', [gatePath, ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP);
  process.exit(command ? 0 : 64);
}
if (command === 'version' || command === '--version') {
  process.stdout.write(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
  process.exit(0);
}
if (command === 'gate') gate(args);
if (command === 'status') gate(['status', ...args]);
if (command === 'install') {
  const dir = args[0] ?? '/usr/local/bin';
  const to = join(dir, 'deploy-gate');
  try {
    copyFileSync(gatePath, to);
    chmodSync(to, 0o755);
    process.stdout.write(`installed ${to}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`pfdeploy install: ${e.message}${e.code === 'EACCES' ? ' (run with sudo)' : ''}\n`);
    process.exit(1);
  }
}
if (command !== 'batch') {
  process.stderr.write(`pfdeploy: unknown command "${command}"\n\n${HELP}`);
  process.exit(64);
}

let concurrency = DEFAULT_CONCURRENCY;
let keepGoing = false;
let minFreeGb = 0;
while (args.length && args[0] !== '--') {
  const a = args.shift();
  if (a === '-c' || a === '--concurrency') concurrency = Number(args.shift());
  else if (a === '--keep-going' || a === '-k') keepGoing = true;
  else if (a === '--min-free-gb') minFreeGb = Number(args.shift());
  else {
    process.stderr.write(`pfdeploy batch: unknown option ${a}\n`);
    process.exit(64);
  }
}
if (args[0] === '--') args.shift();
const template = args.shift();
if (!template || !(concurrency >= 1)) {
  process.stderr.write(HELP);
  process.exit(64);
}
let items = args;
if (!items.length && !process.stdin.isTTY) items = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (!items.length) {
  process.stderr.write('pfdeploy batch: no items\n');
  process.exit(64);
}

const log = (s) => process.stderr.write(`[pfdeploy] ${s}\n`);
log(`${items.length} item${items.length === 1 ? '' : 's'}, ${concurrency} at a time`);
const results = await batch(items, (item) => runCommand(template, item), {
  concurrency,
  keepGoing,
  minFreeGb,
  onEvent: (e) => {
    if (e.type === 'start') log(`start ${e.item}`);
    if (e.type === 'done') log(`${e.ok ? 'ok   ' : 'FAIL '} ${e.item}${e.ok ? '' : `: ${e.error.message}`}`);
    if (e.type === 'memory') log(`${e.freeGb.toFixed(1)} GB free, want ${e.wantGb}: holding ${e.item}`);
  },
});
const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
log(`done: ${results.length - failed.length - skipped.length} ok, ${failed.length} failed${skipped.length ? `, ${skipped.length} not started (after a failure; --keep-going runs them)` : ''}`);
for (const r of failed) log(`failed: ${r.item}`);
for (const r of skipped) log(`not started: ${r.item}`);
process.exit(failed.length || skipped.length ? 1 : 0);
