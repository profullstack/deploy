export const DEFAULT_CONCURRENCY: number;
/** Path of the bundled bash deploy gate. */
export const gatePath: string;
/** GB of memory available now (Linux MemAvailable), Infinity where unknown. */
export function freeGb(read?: () => string): number;

export type BatchEvent<T> =
  | { type: 'start'; item: T; index: number }
  | { type: 'done'; item: T; index: number; ok: boolean; error?: unknown }
  | { type: 'memory'; item: T; freeGb: number; wantGb: number };

export type BatchResult<T, R> = { item: T; ok: boolean; value?: R; error?: unknown; skipped: boolean };

export interface BatchOptions<T> {
  /** At most this many at once. Default 3. */
  concurrency?: number;
  /** Keep starting items after a failure. Default false. */
  keepGoing?: boolean;
  /** Before each start, wait while less than this many GB are available. Default 0 (off). */
  minFreeGb?: number;
  /** Longest wait for memory before starting anyway. Default 600000. */
  memWaitMs?: number;
  pollMs?: number;
  freeGb?: () => number;
  onEvent?: (event: BatchEvent<T>) => void;
}

/** Run task for every item, at most `concurrency` at once, in list order. */
export function batch<T, R>(items: Iterable<T>, task: (item: T, index: number) => Promise<R> | R, options?: BatchOptions<T>): Promise<BatchResult<T, R>[]>;

export function shellQuote(s: string): string;
/** sh -c the template with {} replaced by the quoted item; rejects on a non-zero exit. */
export function runCommand(template: string, item: string, options?: { prefix?: boolean; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; env?: NodeJS.ProcessEnv }): Promise<0>;
