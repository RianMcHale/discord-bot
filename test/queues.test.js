// ARAM and Arena scored as if they were Summoner's Rift produced confident
// nonsense — every player "Weakest: Economy 0", nine champions under "Enemy
// team". These assert they never reach the scorer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedQueue, unsupportedReason, queueName, DEFAULT_ALLOWED_QUEUES } from '../src/queues.js';

const info = (over) => ({ queueId: 420, mapId: 11, gameMode: 'CLASSIC', ...over });

test('accepts standard 5v5 Summoner’s Rift queues', () => {
  for (const queueId of DEFAULT_ALLOWED_QUEUES) {
    assert.equal(isSupportedQueue(info({ queueId })), true, `${queueName(queueId)} should be scored`);
  }
});

test('rejects ARAM', () => {
  const aram = info({ queueId: 450, mapId: 12, gameMode: 'ARAM' });
  assert.equal(isSupportedQueue(aram), false);
  assert.match(unsupportedReason(aram), /Summoner's Rift/);
});

test('rejects Arena', () => {
  assert.equal(isSupportedQueue(info({ queueId: 1700, mapId: 30, gameMode: 'CHERRY' })), false);
});

test('rejects bot games, rotating modes and customs', () => {
  for (const queueId of [0, 830, 840, 850, 900, 1020, 1300, 1400, 1900]) {
    assert.equal(isSupportedQueue(info({ queueId })), false, `${queueName(queueId)} should be rejected`);
  }
});

test('rejects a rotating mode even when it is played on Summoner’s Rift', () => {
  // URF is map 11 and would otherwise slip through a map-only check.
  assert.equal(isSupportedQueue(info({ queueId: 1900, mapId: 11, gameMode: 'URF' })), false);
});

test('each check stands alone, so one odd field is enough to reject', () => {
  assert.equal(isSupportedQueue(info({ mapId: 12 })), false, 'wrong map');
  assert.equal(isSupportedQueue(info({ gameMode: 'ARAM' })), false, 'wrong mode');
  assert.equal(isSupportedQueue(info({ queueId: 450 })), false, 'wrong queue');
});

test('tolerates older matches missing mapId or gameMode', () => {
  assert.equal(isSupportedQueue({ queueId: 420 }), true);
  assert.equal(isSupportedQueue({ queueId: 450 }), false, 'queue alone is still decisive');
});

test('names known queues for the skip message', () => {
  assert.equal(queueName(450), 'ARAM');
  assert.equal(queueName(1700), 'Arena');
  assert.match(queueName(99999), /99999/);
});
