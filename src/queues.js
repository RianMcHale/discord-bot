// Which games are worth scoring.
//
// The role rubrics assume Summoner's Rift: five distinct roles, a lane opponent
// playing the same role on the other team, a jungle, and objectives on a known
// timer. ARAM has none of that — one lane, ten randoms, no counterpart — and
// Arena is 2v2v2v2. Scoring them produces confident-looking nonsense (every
// player "Weakest: Economy 0", nine champions listed as the enemy team), so they
// are rejected before they ever reach the scorer.

import { config } from './config.js';

// Standard 5v5 Summoner's Rift. Deliberately excludes bot games (no meaningful
// opponent), and rotating modes like URF, One for All and Nexus Blitz, whose
// economy and objective pacing would make the baselines meaningless.
export const DEFAULT_ALLOWED_QUEUES = [
  400, // Normal Draft Pick
  420, // Ranked Solo/Duo
  430, // Normal Blind Pick
  440, // Ranked Flex
  490, // Quickplay
  700 // Clash
];

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

export const allowedQueues = () => config.allowedQueues ?? DEFAULT_ALLOWED_QUEUES;

/**
 * Three independent checks, because any one of them can be missing or surprising
 * on older matches: the queue must be an allowed one, the map must be Summoner's
 * Rift (11), and the mode must be CLASSIC. A rotating game mode played on Rift
 * still fails the queue check.
 */
export function isSupportedQueue(info) {
  if (!allowedQueues().includes(info.queueId)) return false;
  if (info.mapId !== undefined && info.mapId !== 11) return false;
  if (info.gameMode !== undefined && info.gameMode !== 'CLASSIC') return false;
  return true;
}

/** Why a match was rejected, for logs and the /fetchgame reply. */
export function unsupportedReason(info) {
  if (info.mapId !== undefined && info.mapId !== 11) return `${queueName(info.queueId)} (not Summoner's Rift)`;
  if (info.gameMode !== undefined && info.gameMode !== 'CLASSIC') return `${info.gameMode} mode`;
  return `${queueName(info.queueId)} is not a tracked queue`;
}
