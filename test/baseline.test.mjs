import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parsePositiveIntegers, parseResultFile, resultFilesForPrefix, retrySeedsForArtifacts } from '../bridge/baseline.mjs';

test('baseline parser uses safe defaults and rejects invalid batch sizes', () => {
  assert.deepEqual(parseList('', ['three']), ['three']);
  assert.deepEqual(parseList('two, three,,four', ['three']), ['two', 'three', 'four']);
  assert.deepEqual(parsePositiveIntegers('1,20,100'), [1, 20, 100]);
  assert.throws(() => parsePositiveIntegers('1,0'), /positive integers/);
  assert.throws(() => parsePositiveIntegers('abc'), /positive integers/);
});

test('baseline artifact selection is prefix isolated', () => {
  assert.deepEqual(resultFilesForPrefix(['run_two_1_000001.jsonl', 'run_two_10_000001.jsonl', 'run_three_1_000001.jsonl', 'run_two_1_000001.txt'], 'run_two_1'), ['run_two_1_000001.jsonl']);
});

test('baseline result parser retains failures and ignores non-result records', () => {
  const parsed = parseResultFile('{"type":"trajectory_meta"}\n{"type":"result","match_id":"m","status":"timeout","seed":7}\nnot-json\n', 'm.jsonl');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].status, 'timeout');
  assert.equal(parsed[1].status, 'error');
  assert.match(parsed[1].error, /invalid JSON/);
});

test('baseline retry planning keeps only failed or missing seeds in range', () => {
  assert.deepEqual(retrySeedsForArtifacts({
    failed_seeds: [100, 103, 999],
    missing_result_ids: ['batch_000101', 'batch_000103'],
    missing_trajectory_ids: ['batch_000102'],
  }, { seedStart: 100, expected: 4 }), [100, 101, 102, 103]);
  assert.deepEqual(retrySeedsForArtifacts({ failed_seeds: [], missing_result_ids: [] }, { seedStart: 1, expected: 2 }), []);
});
