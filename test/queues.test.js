// ARAM and Arena scored as if they were Summoner's Rift produced confident
// nonsense — every player "Weakest: Economy 0", nine champions under "Enemy
// team". These assert they never reach the scorer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedQueue, unsupportedReason, queueName, queueRulesKey, DEFAULT_ALLOWED_QUEUES } from '../src/queues.js';

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

// Ranked 5s is a weekend-only experimental queue that is not in Riot's published
// queues.json and that OP.GG itself only labels "Featured". An allowlist of queue
// ids plus a hard `gameMode === 'CLASSIC'` gate could not have accepted it, and
// no future queue either.
const RIFT_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** A structurally normal 5v5 Rift lobby on an arbitrary queue id. */
function riftLobby(overrides = {}, participantOverride = null) {
  const participants = [];
  for (let i = 1; i <= 10; i++) {
    participants.push({
      puuid: `p${i}`,
      teamId: i <= 5 ? 100 : 200,
      teamPosition: RIFT_ROLES[(i - 1) % 5],
      ...(participantOverride ? participantOverride(i) : {})
    });
  }
  return { queueId: 9999, mapId: 11, gameMode: 'CLASSIC', gameType: 'MATCHED_GAME', participants, ...overrides };
}

test('an unlisted queue is accepted when it is structurally a normal Rift game', () => {
  assert.equal(isSupportedQueue(riftLobby()), true, 'a new 5v5 Rift queue must not need a code change');
});

test('an unfamiliar mode string does not reject a normal Rift game', () => {
  // The bug: requiring gameMode to equal CLASSIC exactly. A queue reporting
  // something Riot invented last week is not automatically a rotating mode.
  assert.equal(isSupportedQueue(riftLobby({ gameMode: 'TOURNAMENT' })), true);
  assert.equal(isSupportedQueue(riftLobby({ gameMode: undefined })), true);
});

test('but a mode we know breaks the rubrics is still rejected', () => {
  for (const mode of ['URF', 'ONEFORALL', 'ULTBOOK', 'NEXUSBLITZ', 'ARAM', 'CHERRY']) {
    assert.equal(isSupportedQueue(riftLobby({ gameMode: mode })), false, `${mode} should be rejected`);
  }
});

test('bot games are still rejected, though they are Rift CLASSIC too', () => {
  const bots = riftLobby({}, (i) => (i > 5 ? { puuid: 'BOT' } : {}));
  assert.equal(isSupportedQueue(bots), false);
  assert.match(unsupportedReason(bots), /bot game/);
});

test('customs are still rejected however normal the lobby looks', () => {
  assert.equal(isSupportedQueue(riftLobby({ gameType: 'CUSTOM_GAME' })), false);
});

test('an unlisted queue that is not 5v5 is rejected', () => {
  const lopsided = riftLobby({}, (i) => ({ teamId: i <= 6 ? 100 : 200 }));
  assert.equal(isSupportedQueue(lopsided), false);
  const short = riftLobby();
  short.participants = short.participants.slice(0, 8);
  assert.equal(isSupportedQueue(short), false);
  assert.match(unsupportedReason(short), /8 players/);
});

test('one unreadable role is tolerated, a lobby of them is not', () => {
  // Role detection on a brand-new queue is exactly the thing likeliest to be
  // flaky, so rejecting on a single miss would reproduce the bug being fixed.
  const oneMissing = riftLobby({}, (i) => (i === 3 ? { teamPosition: '' } : {}));
  assert.equal(isSupportedQueue(oneMissing), true);

  const noRoles = riftLobby({}, () => ({ teamPosition: '' }));
  assert.equal(isSupportedQueue(noRoles), false);
  assert.match(unsupportedReason(noRoles), /roles could not be read/);
});

test('the rejection reason always names the raw queue and mode', () => {
  // When a queue Riot has just added is turned away, the reason is the only
  // evidence of what it actually was.
  const reason = unsupportedReason(riftLobby({ queueId: 1234, gameMode: 'URF' }));
  assert.match(reason, /queue 1234/);
  assert.match(reason, /URF/);
});

test('the rules key changes when the rules do', () => {
  const before = queueRulesKey();
  assert.match(before, /^v\d+:/, 'carries a version');
  assert.match(before, /420/, 'and the allowlist it was made under');
});

// Leaving a queue off ALLOWED_QUEUES stopped excluding it the moment unlisted
// queues began falling through to a structural check. BLOCKED_QUEUES is what
// exclusion means now, and a config that silently stops restricting is worse
// than one that never restricted.
test('BLOCKED_QUEUES excludes a queue that would otherwise pass', async () => {
  const { config } = await import('../src/config.js');
  const original = config.blockedQueues;
  try {
    config.blockedQueues = [9999];
    assert.equal(isSupportedQueue(riftLobby({ queueId: 9999 })), false);
    assert.match(unsupportedReason(riftLobby({ queueId: 9999 })), /BLOCKED_QUEUES/);
    // And it beats the allowlist, not just the structural fallback.
    config.blockedQueues = [420];
    assert.equal(isSupportedQueue(info({ queueId: 420 })), false, 'blocking wins over allowing');
  } finally {
    config.blockedQueues = original;
  }
});

test('changing the block list re-checks games rejected under the old one', async () => {
  const { config } = await import('../src/config.js');
  const original = config.blockedQueues;
  try {
    config.blockedQueues = [];
    const before = queueRulesKey();
    config.blockedQueues = [480];
    assert.notEqual(queueRulesKey(), before);
  } finally {
    config.blockedQueues = original;
  }
});
