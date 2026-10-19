/**
 * @profullstack/deploy: deploy in batches, a few at a time, so a fleet-wide
 * change never builds everything at once on one box.
 *
 * Two halves:
 *   - deploy-gate (bin/deploy-gate, bash + flock): every deploy on a box takes
 *     one of N slots before it builds. Use it on the box.
 *   - batch() / `pfdeploy batch`: an agent or a person rolling one change out to
 *     many repos runs them N at a time. Use it where the rollout is driven.
 *
 * Zero dependencies.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONCURRENCY = 3;

/** Path of the bundled bash gate. */
export const gatePath = fileURLToPath(new URL('../bin/deploy-gate', import.meta.url));

/** GB of memory available right now (Linux), or Infinity where /proc/meminfo is not. */
export function freeGb(read = () => readFileSync('/proc/meminfo', 'utf8')) {
  try {
    const kb = Number(/^MemAvailable:\s+(\d+)/m.exec(read())?.[1]);
    return Number.isFinite(kb) ? kb / 1048576 : Infinity;
  } catch {
    return Infinity;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `task(item, index)` for every item, at most `concurrency` at once, in order
 * of the list. Before each start, waits (up to memWaitMs) while less than
 * minFreeGb is available. On the first failure no new item starts unless
 * keepGoing; items already running finish. Resolves to one result per item:
 * { item, ok, value | error, skipped }.
 */
export async function batch(items, task, options = {}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const minFreeGb = options.minFreeGb ?? 0;
  const memWaitMs = options.memWaitMs ?? 600_000;
  const pollMs = options.pollMs ?? 15_000;
  const free = options.freeGb ?? freeGb;
  const onEvent = options.onEvent ?? (() => {});
  const list = [...items];
  const results = list.map((item) => ({ item, ok: false, skipped: true }));
  let next = 0;
  let failed = false;

  const roomFor = async (item) => {
    if (!(minFreeGb > 0)) return;
    const until = Date.now() + memWaitMs;
    for (let gb = free(); gb < minFreeGb && Date.now() < until; gb = free()) {
      onEvent({ type: 'memory', item, freeGb: gb, wantGb: minFreeGb });
      await sleep(pollMs);
    }
  };

  const worker = async () => {
    while (next < list.length && !(failed && !options.keepGoing)) {
      const index = next++;
      const item = list[index];
      await roomFor(item);
      if (failed && !options.keepGoing) return;
      onEvent({ type: 'start', item, index });
      try {
        const value = await task(item, index);
        results[index] = { item, ok: true, value, skipped: false };
        onEvent({ type: 'done', item, index, ok: true });
      } catch (error) {
        failed = true;
        results[index] = { item, ok: false, error, skipped: false };
        onEvent({ type: 'done', item, index, ok: false, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}

/** POSIX single-quote a string for sh -c. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run a shell command, with every `{}` replaced by the quoted item, and resolve
 * to its exit code. Output lines are prefixed with the item.
 */
export function runCommand(template, item, { prefix = true, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const command = template.includes('{}') ? template.replaceAll('{}', shellQuote(item)) : `${template} ${shellQuote(item)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], env });
    const pipe = (from, to) => {
      let carry = '';
      from.on('data', (chunk) => {
        const lines = (carry + chunk).split('\n');
        carry = lines.pop();
        for (const line of lines) to.write(prefix ? `[${item}] ${line}\n` : `${line}\n`);
      });
      from.on('end', () => carry && to.write(prefix ? `[${item}] ${carry}\n` : `${carry}\n`));
    };
    pipe(child.stdout, stdout);
    pipe(child.stderr, stderr);
    child.on('error', reject);
    child.on('close', (code, signal) => (code === 0 ? resolve(0) : reject(Object.assign(new Error(`${item}: exit ${code ?? signal}`), { code: code ?? 1 }))));
  });
}
