// Collects a reference sample so the role baselines can be measured instead of
// guessed (spec §7.2). Resumable, rate-limited, and writes incrementally.
//
// Sampling: snowball outward from the squad's own matches. Every match contains
// ten players whose own histories are then queued. Matchmaking already pairs
// similar ranks, so this lands near the squad's band without needing LEAGUE-V4
// and without a second endpoint's rate budget.
//
// Design constraints, because this runs against a shared development key:
//   * hard cap on total requests, passed in and never exceeded
//   * one shared token bucket honouring 20/s and 100/2min
//   * every match appended to disk as it lands, so nothing is lost on a stop
//   * a checkpoint file, so re-running continues rather than restarting
//
//   node scripts/calibration-pull.mjs [targetMatches] [maxRequests]

import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedQueue } from '../src/queues.js';
import { buildContext } from '../src/scoring/context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'calibration');
const ROWS = path.join(OUT_DIR, 'rows.ndjson');
const STATE = path.join(OUT_DIR, 'state.json');

const KEY = process.env.RIOT_API_KEY;
const REGIONAL = `https://${process.env.RIOT_REGION || 'europe'}.api.riotgames.com`;
const TARGET_MATCHES = Number(process.argv[2] || 400);
const MAX_REQUESTS = Number(process.argv[3] || 1200);
const MIN_DURATION_S = 12 * 60; // spec §12.1: laning metrics are undefined below this

if (!KEY) {
  console.error('RIOT_API_KEY is not set.');
  process.exit(1);
}

// --- rate limiting ----------------------------------------------------------
const PER_2MIN = 90;
const PER_SEC = 15;
const WINDOW_MS = 120_000;
const long = [];
const short = [];
let requestsUsed = 0;

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (long.length && now - long[0] > WINDOW_MS) long.shift();
    while (short.length && now - short[0] > 1000) short.shift();
    if (long.length < PER_2MIN && short.length < PER_SEC) {
      long.push(now);
      short.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function get(url, tries = 3) {
  if (requestsUsed >= MAX_REQUESTS) throw Object.assign(new Error('REQUEST_BUDGET_SPENT'), { budget: true });
  await throttle();
  requestsUsed += 1;
  try {
    return (await axios.get(url, { headers: { 'X-Riot-Token': KEY }, timeout: 20000 })).data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && tries > 0) {
      const after = Number(err.response.headers['retry-after'] || 10);
      await new Promise((r) => setTimeout(r, (after + 1) * 1000));
      return get(url, tries - 1);
    }
    if (status >= 500 && tries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return get(url, tries - 1);
    }
    throw err;
  }
}

// --- state ------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });
const state = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf-8'))
  : { seenMatches: [], queuedPuuids: [], donePuuids: [], storedMatches: 0 };

const seen = new Set(state.seenMatches);
const donePuuids = new Set(state.donePuuids);
const queue = state.queuedPuuids.slice();

function saveState() {
  fs.writeFileSync(
    STATE,
    JSON.stringify(
      { seenMatches: [...seen], queuedPuuids: queue, donePuuids: [...donePuuids], storedMatches: state.storedMatches },
      null,
      2
    )
  );
}

/**
 * One row per participant: the raw inputs the baselines are computed from.
 * Deliberately not scores — a calibration built from scores would be circular.
 */
function rowsFor(match, timeline) {
  const ctx = buildContext(match, timeline);
  return ctx.players
    .filter((p) => p.role !== 'UNKNOWN')
    .map((p) => ({
      matchId: match.metadata.matchId,
      patch: (match.info.gameVersion || '').split('.').slice(0, 2).join('.'),
      queueId: match.info.queueId,
      minutes: +ctx.minutes.toFixed(2),
      role: p.role,
      champion: p.champion,
      win: p.win,
      dmgShare: p.teamDamageShare,
      tankShare: p.teamTakenShare,
      kp: p.kp,
      killShare: p.killShare,
      csPerMin: +p.csPerMin.toFixed(3),
      goldPerMin: +p.goldPerMin.toFixed(1),
      visionPerMin: +p.visionPerMin.toFixed(3),
      wDeathsPerMin: p.weightedDeathsPerMin == null ? null : +p.weightedDeathsPerMin.toFixed(4),
      epicShare: p.epicShare,
      jungleCs14: p.jungleCs14 ?? null,
      turretDmgPerMin: +(p.turretDamage / ctx.minutes).toFixed(1),
      ccScore: p.ccScore,
      healShield: +p.healShieldPerMin.toFixed(1),
      // Absolute lane state, not just the differential. laneComponent has no
      // absolute anchor at all today, which is spec F5 applied to the heaviest
      // component in three rubrics: two laners who both farmed terribly go even
      // and both score 50.
      gold14: p.gold14 ?? null,
      xp14: p.xp14 ?? null,
      cs14: p.cs14 ?? null,
      goldDiff14: p.goldDiff14 ?? null,
      xpDiff14: p.xpDiff14 ?? null,
      platesEarly: p.platesEarly ?? null,
      platesLate: p.platesLate ?? null,
      lateKp: p.lateKp
    }));
}

async function main() {
  // Seed the PUUID queue if this is a cold start.
  if (queue.length === 0 && donePuuids.size === 0) {
    const seedMatch = process.env.SEED_MATCH;
    if (!seedMatch) throw new Error('Cold start needs SEED_MATCH=<a recent match id>.');
    const m = await get(`${REGIONAL}/lol/match/v5/matches/${seedMatch}`);
    m.info.participants.forEach((p) => queue.push(p.puuid));
    console.log(`Seeded ${queue.length} PUUIDs from ${seedMatch}.`);
  }

  const started = Date.now();
  let stored = state.storedMatches;
  const out = fs.createWriteStream(ROWS, { flags: 'a' });

  try {
    while (stored < TARGET_MATCHES && queue.length > 0) {
      const puuid = queue.shift();
      if (donePuuids.has(puuid)) continue;
      donePuuids.add(puuid);

      let ids;
      try {
        ids = await get(`${REGIONAL}/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=20&type=ranked`);
      } catch (err) {
        if (err.budget) throw err;
        continue; // a stale or unreachable puuid is not worth a retry here
      }

      for (const id of ids) {
        if (stored >= TARGET_MATCHES) break;
        if (seen.has(id)) continue;
        seen.add(id);

        let match;
        try {
          match = await get(`${REGIONAL}/lol/match/v5/matches/${id}`);
        } catch (err) {
          if (err.budget) throw err;
          continue;
        }
        if (!isSupportedQueue(match.info) || match.info.gameDuration < MIN_DURATION_S) continue;

        let timeline = null;
        try {
          timeline = await get(`${REGIONAL}/lol/match/v5/matches/${id}/timeline`);
        } catch (err) {
          if (err.budget) throw err;
        }

        try {
          for (const row of rowsFor(match, timeline)) out.write(JSON.stringify(row) + '\n');
        } catch {
          continue; // a match the scorer cannot read is not a calibration row
        }
        stored += 1;
        state.storedMatches = stored;

        // Widen the net: everyone in this game becomes a future seed.
        for (const p of match.info.participants) if (!donePuuids.has(p.puuid)) queue.push(p.puuid);

        if (stored % 10 === 0) {
          saveState();
          const mins = ((Date.now() - started) / 60000).toFixed(1);
          process.stdout.write(`\r  ${stored}/${TARGET_MATCHES} matches · ${requestsUsed}/${MAX_REQUESTS} requests · ${mins}m      `);
        }
      }
    }
  } catch (err) {
    if (!err.budget) throw err;
    console.log(`\n  stopped: request budget of ${MAX_REQUESTS} spent.`);
  } finally {
    out.end();
    saveState();
  }

  console.log(`\n\nStored ${stored} matches, ${requestsUsed} requests used.`);
  console.log(`  rows: ${ROWS}`);
  console.log(`  resume by re-running; state is in ${STATE}`);
}

main().catch((e) => {
  console.error('\nPull failed:', e.response?.status, e.response?.data || e.message);
  saveState();
  process.exit(1);
});
