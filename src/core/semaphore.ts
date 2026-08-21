/**
 * Gateway-wide concurrency limiter for upstream fetches.
 *
 * The 2 vCPU / 4 GB guardrail: a bounded page walk can pull thousands of rows,
 * and several concurrent tool calls doing that would exhaust the box. Every KLIP
 * data fetch passes through one shared semaphore.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error('semaphore needs at least one permit');
    this.available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolvePermit) => this.waiters.push(resolvePermit));
    return this.makeRelease();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get pending(): number {
    return this.waiters.length;
  }

  get free(): number {
    return this.available;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.available += 1;
    };
  }
}

/**
 * Run tasks with bounded parallelism, preserving input order in the output.
 * Used to fetch pages 2..N concurrently once page 1 reveals the total.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
