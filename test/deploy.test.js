import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batch, freeGb, gatePath, runCommand, shellQuote } from '../src/index.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'pfdeploy-'));
const run = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn('bash', [gatePath, ...args], { env: { ...process.env, DEPLOY_MIN_FREE_GB: '0', DEPLOY_POLL: '0.2', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });

test('the gate never lets more than --slots deploys run at once', async () => {
  const dir = scratch();
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // Each job appends +1 when it starts and -1 when it ends; we replay the log for the peak.
  const job = `echo +1 >> ${log}; sleep 0.6; echo -1 >> ${log}`;
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => run(['--slots', '2', '--name', `site${i}`, '--', 'bash', '-c', job], { DEPLOY_LOCK_DIR: join(dir, 'locks') })));
  assert.ok(results.every((r) => r.code === 0), results.map((r) => r.err).join('\n'));
  let now = 0;
  let peak = 0;
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    now += Number(line);
    peak = Math.max(peak, now);
  }
  assert.equal(peak, 2);
  // Six jobs, two at a time, 0.6 s each: at least three rounds.
  assert.ok(Date.now() - started >= 1700, `took ${Date.now() - started} ms`);
  assert.ok(results.every((r) => /took deploy slot [01] of 2/.test(r.err)), results.map((r) => r.err).join('|'));
})

test('exit codes pass through; a nested gate never waits on itself; status names the holder', async () => {
  const dir = scratch();
  const env = { DEPLOY_LOCK_DIR: join(dir, 'locks') };
  assert.equal((await run(['--slots', '1', '--', 'bash', '-c', 'exit 7'], env)).code, 7);
  // With one slot, a gated command that runs the gate again would deadlock without DEPLOY_GATED.
  const nested = await run(['--slots', '1', '--', 'bash', gatePath, '--slots', '1', '--', 'echo', 'inner'], env);
  assert.equal(nested.code, 0);
  assert.equal(nested.out.trim(), 'inner');
  const holding = run(['--slots', '1', '--name', 'crawlproof', '--', 'sleep', '1'], env);
  await new Promise((r) => setTimeout(r, 300));
  const status = spawnSync('bash', [gatePath, 'status', '--slots', '1'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.match(status.stdout, /slot 0 {2}busy {2}crawlproof pid \d+/);
  await holding;
  assert.match(spawnSync('bash', [gatePath, 'status', '--slots', '1'], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout, /slot 0 {2}free/);
})

test('a daemon the deploy starts does not keep the slot', async () => {
  const dir = scratch();
  const env = { DEPLOY_LOCK_DIR: join(dir, 'locks') };
  // The deploy leaves a background process running (like `nohup server &`), then exits.
  const first = await run(['--slots', '1', '--', 'bash', '-c', 'sleep 3 & disown; echo started'], env);
  assert.equal(first.code, 0);
  const t = Date.now();
  const second = await run(['--slots', '1', '--wait', '2', '--', 'true'], env);
  assert.equal(second.code, 0, second.err);
  assert.ok(Date.now() - t < 1500, 'the second deploy got the slot at once');
})

test('a slot that never frees times out with 75, or runs anyway when asked', async () => {
  const dir = scratch();
  const env = { DEPLOY_LOCK_DIR: join(dir, 'locks') };
  const holder = run(['--slots', '1', '--', 'sleep', '8'], env);
  await new Promise((r) => setTimeout(r, 300));
  const late = await run(['--slots', '1', '--wait', '1', '--', 'true'], env);
  assert.equal(late.code, 75);
  assert.match(late.err, /giving up/);
  const forced = await run(['--slots', '1', '--wait', '1', '--', 'echo', 'ran'], { ...env, DEPLOY_GATE_ON_TIMEOUT: 'run' });
  assert.equal(forced.out.trim(), 'ran');
  spawnSync('pkill', ['-f', 'sleep 8']);
  await holder;
})

test('batch: at most `concurrency` at once, in order, and stops starting after a failure', async () => {
  let running = 0;
  let peak = 0;
  const order = [];
  const results = await batch([1, 2, 3, 4, 5, 6, 7], async (n) => {
    order.push(n);
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
    return n * 2;
  }, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(results.map((r) => r.value), [2, 4, 6, 8, 10, 12, 14]);

  const stopped = await batch(['a', 'b', 'c', 'd', 'e'], async (x) => {
    if (x === 'b') throw new Error('build failed');
    await new Promise((r) => setTimeout(r, 20));
  }, { concurrency: 2 });
  assert.equal(stopped.find((r) => r.item === 'b').ok, false);
  assert.ok(stopped.filter((r) => r.skipped).length >= 2);
  const kept = await batch(['a', 'b', 'c'], async (x) => {
    if (x === 'a') throw new Error('x');
  }, { concurrency: 1, keepGoing: true });
  assert.deepEqual(kept.map((r) => r.ok), [false, true, true]);
})

test('batch waits for memory before each start, then gives up waiting', async () => {
  const seen = [];
  let calls = 0;
  await batch(['x'], async () => {}, { minFreeGb: 8, pollMs: 5, memWaitMs: 1000, freeGb: () => (++calls < 3 ? 2 : 20), onEvent: (e) => seen.push(e.type) });
  assert.deepEqual(seen, ['memory', 'memory', 'start', 'done']);
  const t = Date.now();
  await batch(['y'], async () => {}, { minFreeGb: 8, pollMs: 5, memWaitMs: 50, freeGb: () => 1 });
  assert.ok(Date.now() - t < 500);
})

test('helpers: free memory from /proc/meminfo, shell quoting, commands per item', async () => {
  assert.equal(freeGb(() => 'MemTotal: 1 kB\nMemAvailable:   25165824 kB\n'), 24);
  assert.equal(freeGb(() => { throw new Error('no proc'); }), Infinity);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const out = [];
  const sink = { write: (s) => out.push(s) };
  await runCommand('echo deploying {}', "o'neil.com", { stdout: sink, stderr: sink });
  assert.deepEqual(out, ["[o'neil.com] deploying o'neil.com\n"]);
  await assert.rejects(runCommand('exit 3', 'x', { stdout: sink, stderr: sink }), /x: exit 3/);
})

test('the CLI runs a batch three at a time by default', () => {
  const dir = scratch();
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const r = spawnSync('node', [new URL('../bin/pfdeploy.js', import.meta.url).pathname, 'batch', '--', `echo +1 >> ${log}; sleep 0.3; echo -1 >> ${log}; true`, 'a', 'b', 'c', 'd', 'e', 'f'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /6 items, 3 at a time/);
  let now = 0;
  let peak = 0;
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    now += Number(line);
    peak = Math.max(peak, now);
  }
  assert.equal(peak, 3);
  const bad = spawnSync('node', [new URL('../bin/pfdeploy.js', import.meta.url).pathname, 'batch', '-c', '1', '--', 'test {} != b', 'a', 'b', 'c'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /failed: b/);
  assert.match(bad.stderr, /not started: c/);
})
