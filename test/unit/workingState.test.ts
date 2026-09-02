import * as assert from 'node:assert';
import { computeWorkingTransitions } from '../../src/workingState';

const IDLE_MS = 10_000;

suite('computeWorkingTransitions', () => {
  test('a freshly-written file is newly working and reports changed', () => {
    const now = 1_000_000;
    const activity = new Map([['/a.jsonl', now - 100]]);
    const result = computeWorkingTransitions(activity, new Set(), now, IDLE_MS);

    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual([...result.nowWorking], ['/a.jsonl']);
    assert.deepStrictEqual(result.justFinished, []);
  });

  test('a file that keeps writing stays working across ticks with no change reported', () => {
    const now = 1_000_000;
    const activity = new Map([['/a.jsonl', now - 100]]);
    const wasWorking = new Set(['/a.jsonl']);
    const result = computeWorkingTransitions(activity, wasWorking, now, IDLE_MS);

    assert.strictEqual(result.changed, false, 'a continuously-active file must not report a change every tick');
    assert.deepStrictEqual([...result.nowWorking], ['/a.jsonl']);
    assert.deepStrictEqual(result.justFinished, []);
  });

  test('a file idle past the threshold is reported as just finished, exactly once', () => {
    const now = 1_000_000;
    const activity = new Map([['/a.jsonl', now - IDLE_MS - 1]]);
    const wasWorking = new Set(['/a.jsonl']);
    const result = computeWorkingTransitions(activity, wasWorking, now, IDLE_MS);

    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual([...result.nowWorking], []);
    assert.deepStrictEqual(result.justFinished, ['/a.jsonl']);
  });

  test('a file already idle before this tick is not re-reported as finished again', () => {
    const now = 1_000_000;
    const activity = new Map([['/a.jsonl', now - IDLE_MS - 1]]);
    const result = computeWorkingTransitions(activity, new Set(), now, IDLE_MS);

    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.justFinished, []);
  });

  test('multiple concurrently-working files: only the one that goes idle is reported', () => {
    const now = 1_000_000;
    const activity = new Map([
      ['/still-working.jsonl', now - 100],
      ['/just-finished.jsonl', now - IDLE_MS - 1],
    ]);
    const wasWorking = new Set(['/still-working.jsonl', '/just-finished.jsonl']);
    const result = computeWorkingTransitions(activity, wasWorking, now, IDLE_MS);

    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual([...result.nowWorking], ['/still-working.jsonl']);
    assert.deepStrictEqual(result.justFinished, ['/just-finished.jsonl']);
  });
});
