// Which games are worth scoring.
//
// The role rubrics assume Summoner's Rift: five distinct roles, a lane opponent
// playing the same role on the other team, a jungle, and objectives on a known
// timer. ARAM has none of that — one lane, ten randoms, no counterpart — and
// Arena is 2v2v2v2. Scoring them produces confident-looking nonsense (every
// player "Weakest: Economy 0", nine champions listed as the enemy team), so they
// are rejected before they ever reach the scorer.

import { config } from './config.js';
import { normaliseRole, ROLES } from './scoring/context.js';

// Standard 5v5 Summoner's Rift. Deliberately excludes bot games (no meaningful
// opponent), and rotating modes like URF, One for All and Nexus Blitz, whose
// economy and objective pacing would make the baselines meaningless.
//
// This is a fast path, not the whole rule. A queue Riot adds after this list was
// written still gets scored if it is structurally a normal Rift game — see
// `looksLikeStandardRift`. Ranked 5s is exactly that case: a weekend-only
// experimental queue that is not in Riot's own published queues.json yet, so an
// allowlist could not have known about it and neither could we.
export const DEFAULT_ALLOWED_QUEUES = [
  400, // Normal Draft Pick
  420, // Ranked Solo/Duo
  430, // Normal Blind Pick
  440, // Ranked Flex
  490, // Quickplay
  700 // Clash
];

// Bumped whenever the acceptance rules change. It is stored on every rejection,
// so widening the rules automatically re-checks matches turned away under the
// old ones — otherwise a fix here would never reach the games it was written for.
const RULES_VERSION = 2;

export const QUEUE_NAMES = {
  0: 'Custom',
  400: 'Normal Draft',
  420: 'Ranked Solo/Duo',
  430: 'Normal Blind',
  440: 'Ranked Flex',
  450: 'ARAM',
  480: 'Swiftplay',
  490: 'Quickplay',
  700: 'Clash',
  720: 'ARAM Clash',
  830: 'Co-op vs AI (Intro)',
  840: 'Co-op vs AI (Beginner)',
  850: 'Co-op vs AI (Intermediate)',
  870: 'Co-op vs AI (Intro)',
  880: 'Co-op vs AI (Beginner)',
  890: 'Co-op vs AI (Intermediate)',
  900: 'ARURF',
  1020: 'One for All',
  1300: 'Nexus Blitz',
  1400: 'Ultimate Spellbook',
  1700: 'Arena',
  1710: 'Arena',
  1900: 'URF'
};

export function queueName(queueId) {
  return QUEUE_NAMES[queueId] || `queue ${queueId}`;
}

// Rotating modes whose economy and objective pacing would make every baseline
// meaningless. Listed rather than requiring CLASSIC, for the same reason the
// queue list is a fast path rather than the whole rule: `gameMode` is a string
// Riot can add to, and demanding an exact match on it rejects anything new.
//
// The residual risk is a genuinely new rotating mode on Rift whose mode string
// nobody here recognises. That is narrower than the alternative, which rejected
// every new *standard* queue — and a new rotating mode still has to get past the
// structural checks below.
const NON_STANDARD_MODES = new Set([
  'ARAM', 'URF', 'ARSR', 'ONEFORALL', 'ASCENSION', 'FIRSTBLOOD', 'KINGPORO', 'SIEGE',
  'ASSASSINATE', 'DARKSTAR', 'STARGUARDIAN', 'PROJECT', 'ODYSSEY', 'NEXUSBLITZ',
  'ULTBOOK', 'CHERRY', 'STRAWBERRY', 'BRAWL', 'DOOMBOTSTEEMO', 'GAMEMODEX', 'TUTORIAL',
  'TUTORIAL_MODULE_1', 'TUTORIAL_MODULE_2', 'TUTORIAL_MODULE_3', 'PRACTICETOOL', 'SWARM'
]);

/** True for a mode we know breaks the rubrics' assumptions. */
function isRotatingMode(gameMode) {
  return gameMode !== undefined && NON_STANDARD_MODES.has(String(gameMode).toUpperCase());
}

export const allowedQueues = () => config.allowedQueues ?? DEFAULT_ALLOWED_QUEUES;
export const blockedQueues = () => config.blockedQueues ?? [];

/**
 * Is this a normal 5v5 Summoner's Rift game that simply isn't on the allowlist?
 *
 * The allowlist exists because map and mode alone are not enough: Co-op vs AI is
 * Summoner's Rift CLASSIC, and so is a custom 1v1. But an allowlist can only
 * ever know about queues that existed when it was written, and Riot adds them —
 * Ranked 5s is a weekend-only experimental queue that is not even in the
 * published queues.json. So everything the allowlist was really standing in for
 * is checked directly instead.
 */
function looksLikeStandardRift(info) {
  const ps = info.participants;
  if (!Array.isArray(ps) || ps.length !== 10) return false;

  // Bot games are Rift CLASSIC too. Riot marks bot participants with a literal
  // "BOT" puuid, and there is nothing worth grading a player against in one.
  if (ps.some((p) => !p.puuid || p.puuid === 'BOT')) return false;

  // Customs can be anything at all — an inhouse 1v1 mid, a five-man ARAM played
  // on Rift — so they stay out however normal the lobby looks.
  if (info.gameType !== undefined && info.gameType !== 'MATCHED_GAME') return false;

  const perTeam = { 100: 0, 200: 0 };
  for (const p of ps) {
    if (perTeam[p.teamId] === undefined) return false;
    perTeam[p.teamId] += 1;
  }
  if (perTeam[100] !== 5 || perTeam[200] !== 5) return false;

  // Both sides should field recognisable roles. Deliberately 4 of 5 rather than
  // all five: role detection on a brand-new queue is exactly the thing likeliest
  // to be flaky, and rejecting the game for it would reproduce the bug this
  // function exists to fix.
  for (const teamId of [100, 200]) {
    const roles = new Set(
      ps.filter((p) => p.teamId === teamId).map(normaliseRole).filter((r) => ROLES.includes(r))
    );
    if (roles.size < 4) return false;
  }
  return true;
}

/**
 * The map must be Summoner's Rift (11) and the mode must not be a known rotating
 * one. Past that, an allowlisted queue is accepted outright and anything else has
 * to look structurally like a normal Rift game.
 *
 * Two fast paths and one fallback, rather than three hard gates. The old version
 * required `queueId` to be on a list AND `gameMode` to be exactly CLASSIC, so a
 * new queue failed the first check and an unfamiliar mode string failed the
 * second — which is how Ranked 5s, a weekend-only experimental queue that OP.GG
 * itself only labels "Featured", ended up unfetchable.
 */
export function isSupportedQueue(info) {
  // Checked first, and it wins outright: since an unlisted queue now falls
  // through to a structural check, leaving a queue off ALLOWED_QUEUES no longer
  // excludes it. BLOCKED_QUEUES is the only thing that does.
  if (blockedQueues().includes(info.queueId)) return false;
  if (info.mapId !== undefined && info.mapId !== 11) return false;
  if (isRotatingMode(info.gameMode)) return false;
  // No gameMode condition here: the rotating-mode check above already covers it,
  // and older matches omit the field entirely.
  if (allowedQueues().includes(info.queueId)) return true;
  return looksLikeStandardRift(info);
}

/**
 * Identifies the rules a rejection was made under, so widening them re-checks it.
 * Includes the configured allowlist as well as the version, so editing
 * ALLOWED_QUEUES invalidates old rejections without needing a code change too.
 */
export function queueRulesKey() {
  const sort = (xs) => [...xs].sort((a, b) => a - b).join(',');
  return `v${RULES_VERSION}:${sort(allowedQueues())}:-${sort(blockedQueues())}`;
}

/**
 * Why a match was rejected, for logs and the /fetchgame reply.
 *
 * Always names the raw queueId and gameMode. When a queue Riot has just added
 * gets turned away, the reason is the only evidence of what it actually was, and
 * "not a tracked queue" on its own is not enough to act on.
 */
export function unsupportedReason(info) {
  const id = `queue ${info.queueId}${info.gameMode ? `/${info.gameMode}` : ''}`;
  if (blockedQueues().includes(info.queueId)) return `${queueName(info.queueId)} — blocked by BLOCKED_QUEUES (${id})`;
  if (info.mapId !== undefined && info.mapId !== 11) return `${queueName(info.queueId)} — not Summoner's Rift (${id}, map ${info.mapId})`;
  if (isRotatingMode(info.gameMode)) return `${queueName(info.queueId)} — rotating mode (${id})`;
  if (Array.isArray(info.participants) && info.participants.some((p) => !p.puuid || p.puuid === 'BOT')) {
    return `${queueName(info.queueId)} — bot game (${id})`;
  }
  if (info.gameType !== undefined && info.gameType !== 'MATCHED_GAME') {
    return `${info.gameType.toLowerCase().replace(/_/g, ' ')} (${id})`;
  }
  const n = Array.isArray(info.participants) ? info.participants.length : 0;
  if (n !== 10) return `${queueName(info.queueId)} — ${n} players, not 10 (${id})`;
  return `${queueName(info.queueId)} — roles could not be read (${id})`;
}
