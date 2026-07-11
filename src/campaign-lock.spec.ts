import { describe, expect, it } from 'vitest';
import { CampaignLock } from './campaign-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('marketing-ops campaign lock', () => {
  it('TC-AUTO-QUEUE-127-01 同 campaign 串行而不同 campaign 可并行', async () => {
    const lock = new CampaignLock();
    const firstGate = deferred();
    const events: string[] = [];
    const first = lock.runExclusive('same', async () => {
      events.push('same-1-start');
      await firstGate.promise;
      events.push('same-1-end');
    });
    const second = lock.runExclusive('same', async () => {
      events.push('same-2');
    });
    const other = lock.runExclusive('other', async () => {
      events.push('other');
    });

    await other;
    expect(events).toEqual(['same-1-start', 'other']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['same-1-start', 'other', 'same-1-end', 'same-2']);
  });

  it('TC-AUTO-QUEUE-127-02 异常后释放锁且后续任务可继续', async () => {
    const lock = new CampaignLock();
    await expect(
      lock.runExclusive('campaign', async () => {
        throw new Error('expected failure');
      }),
    ).rejects.toThrow('expected failure');

    await expect(lock.runExclusive('campaign', async () => 'continued')).resolves.toBe('continued');
    expect(lock.pendingKeys()).toEqual([]);
  });
});
