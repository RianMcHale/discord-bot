// Task 0 from the audit spec (§3.5): find out what Riot actually returns.
//
// Every field name in the spec's §3 and §4 is a hypothesis. Riot changes the
// `challenges` block without notice and has shipped bugs in timeline events, so
// nothing downstream should be written against a field nobody has seen. This
// pulls real squad matches and emits:
//
//   docs/schema-observed.json  — the raw union of everything present
//   docs/field-audit.md        — every field the spec names, confirmed or not
//
// Run it again on a patch bump and diff the output.
//
//   node scripts/schema-probe.mjs [matchCount]

import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const KEY = process.env.RIOT_API_KEY;
const REGIONAL = `https://${process.env.RIOT_REGION || 'europe'}.api.riotgames.com`;
const WANT_MATCHES = Number(process.argv[2] || 60);

if (!KEY) {
  console.error('RIOT_API_KEY is not set.');
  process.exit(1);
}

// --- rate limiting (§12.2) --------------------------------------------------
// Development keys allow 20 requests/second and 100 per 2 minutes. The second
// limit is the binding one for a bulk pull, so the pacing is built around it.
const PER_2MIN = 95; // a little under, to leave room for retries
const WINDOW_MS = 120_000;
const recent = [];

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
    if (recent.length < PER_2MIN) {
      recent.push(now);
      return;
    }
    const waitFor = WINDOW_MS - (now - recent[0]) + 250;
    process.stdout.write(`\r  rate limit: waiting ${Math.ceil(waitFor / 1000)}s…      `);
    await new Promise((r) => setTimeout(r, Math.min(waitFor, 5000)));
  }
}

async function get(url, tries = 3) {
  await throttle();
  try {
    const res = await axios.get(url, { headers: { 'X-Riot-Token': KEY }, timeout: 20000 });
    return res.data;
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

// --- observation accumulators ----------------------------------------------
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Tracks, per key: how often present, its observed types, and how often falsy. */
function makeFieldTracker() {
  const keys = new Map();
  return {
    observe(obj, rows) {
      for (const [k, v] of Object.entries(obj || {})) {
        if (!keys.has(k)) keys.set(k, { present: 0, types: new Set(), zeroOrNull: 0, sample: undefined });
        const e = keys.get(k);
        e.present += 1;
        e.types.add(typeOf(v));
        if (v === null || v === undefined || v === 0 || v === '' || v === false) e.zeroOrNull += 1;
        if (e.sample === undefined && v !== null && v !== 0 && v !== '') e.sample = v;
      }
      this.rows = (this.rows || 0) + rows;
    },
    rows: 0,
    summary() {
      return Object.fromEntries(
        [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, e]) => [
          k,
          {
            presentRate: +(e.present / this.rows).toFixed(4),
            missingRate: +(1 - e.present / this.rows).toFixed(4),
            zeroOrNullRate: +(e.zeroOrNull / Math.max(e.present, 1)).toFixed(4),
            types: [...e.types].sort(),
            sample: typeof e.sample === 'object' ? '[object]' : e.sample
          }
        ])
      );
    }
  };
}

const challenges = makeFieldTracker();
const participantTop = makeFieldTracker();
const eventTypes = new Map(); // type -> { count, keys: Map }
const enums = {
  monsterType: new Map(),
  monsterSubType: new Map(),
  buildingType: new Map(),
  towerType: new Map(),
  laneType: new Map(),
  killType: new Map(),
  wardType: new Map(),
  teamPosition: new Map(),
  individualPosition: new Map(),
  lane: new Map(),
  role: new Map()
};
const bump = (m, v) => {
  if (v === undefined) return;
  const k = v === null ? 'null' : v === '' ? '(empty string)' : String(v);
  m.set(k, (m.get(k) || 0) + 1);
};
const frameIntervals = new Map();
const participantFrameKeys = makeFieldTracker();
const queueIds = new Map();
const gameVersions = new Map();

// Positional facts the spec depends on and gets wrong if 2026 changed them.
const observed = {
  baronFirstSpawnMs: [],
  plateEventsAfter14: 0,
  plateEventsTotal: 0,
  platesByLane: new Map(),
  soulEvents: 0,
  atakhanEvents: 0,
  hordeEvents: 0,
  firstWaveMinionsAtFrame1: []
};

async function main() {
  fs.mkdirSync(DOCS, { recursive: true });

  // Seed from the squad's own PUUIDs, which is what the bot actually scores.
  //
  // Stored PUUIDs are scoped to the API key that issued them, and a development
  // key rotates daily, so they routinely come back 400. `SEED_MATCH` gives a
  // match id to lift ten currently-valid PUUIDs from instead.
  const dbPath = path.join(ROOT, 'data', 'db.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  let puuids = Object.values(db.players || {}).map((p) => p.puuid).filter(Boolean);

  const seedMatch = process.env.SEED_MATCH;
  if (seedMatch) {
    const m = await get(`${REGIONAL}/lol/match/v5/matches/${seedMatch}`);
    puuids = m.info.participants.map((p) => p.puuid);
    console.log(`Seeding from ${puuids.length} PUUIDs lifted from ${seedMatch}.`);
  } else {
    console.log(`Seeding from ${puuids.length} stored squad PUUIDs.`);
  }
  if (puuids.length === 0) throw new Error('No PUUIDs to seed from.');

  const matchIds = new Set();
  for (const puuid of puuids) {
    if (matchIds.size >= WANT_MATCHES) break;
    try {
      const ids = await get(`${REGIONAL}/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=40`);
      ids.forEach((id) => matchIds.add(id));
      process.stdout.write(`\r  discovered ${matchIds.size} match ids…      `);
    } catch (err) {
      console.error(`\n  match list failed for a player: ${err.response?.status || err.message}`);
    }
  }
  const ids = [...matchIds].slice(0, WANT_MATCHES);
  console.log(`\nProbing ${ids.length} matches (2 calls each).\n`);

  let done = 0;
  let withTimeline = 0;
  let withChallenges = 0;
  for (const id of ids) {
    let match;
    try {
      match = await get(`${REGIONAL}/lol/match/v5/matches/${id}`);
    } catch (err) {
      console.error(`\n  ${id}: summary failed ${err.response?.status || err.message}`);
      continue;
    }
    const info = match.info;
    bump(queueIds, info.queueId);
    bump(gameVersions, (info.gameVersion || '').split('.').slice(0, 2).join('.'));

    for (const p of info.participants) {
      participantTop.observe(p, 0);
      bump(enums.teamPosition, p.teamPosition);
      bump(enums.individualPosition, p.individualPosition);
      bump(enums.lane, p.lane);
      bump(enums.role, p.role);
      if (p.challenges) {
        challenges.observe(p.challenges, 0);
        challenges.rows += 1;
        withChallenges += 1;
      }
    }
    participantTop.rows += info.participants.length;

    let timeline;
    try {
      timeline = await get(`${REGIONAL}/lol/match/v5/matches/${id}/timeline`);
      withTimeline += 1;
    } catch {
      timeline = null;
    }
    if (timeline) {
      bump(frameIntervals, timeline.info.frameInterval);
      for (const f of timeline.info.frames) {
        for (const pf of Object.values(f.participantFrames || {})) {
          participantFrameKeys.observe(pf, 0);
          participantFrameKeys.rows += 1;
        }
        for (const e of f.events || []) {
          if (!eventTypes.has(e.type)) eventTypes.set(e.type, { count: 0, keys: new Map() });
          const rec = eventTypes.get(e.type);
          rec.count += 1;
          for (const k of Object.keys(e)) rec.keys.set(k, (rec.keys.get(k) || 0) + 1);

          bump(enums.monsterType, e.monsterType);
          bump(enums.monsterSubType, e.monsterSubType);
          bump(enums.buildingType, e.buildingType);
          bump(enums.towerType, e.towerType);
          bump(enums.laneType, e.laneType);
          bump(enums.killType, e.killType);
          bump(enums.wardType, e.wardType);

          if (e.type === 'ELITE_MONSTER_KILL') {
            if (e.monsterType === 'BARON_NASHOR') observed.baronFirstSpawnMs.push(e.timestamp);
            if (e.monsterType === 'ATAKHAN') observed.atakhanEvents += 1;
            if (e.monsterType === 'HORDE') observed.hordeEvents += 1;
          }
          if (e.type === 'DRAGON_SOUL_GIVEN') observed.soulEvents += 1;
          if (e.type === 'TURRET_PLATE_DESTROYED') {
            observed.plateEventsTotal += 1;
            if (e.timestamp > 14 * 60_000) observed.plateEventsAfter14 += 1;
            bump(observed.platesByLane, e.laneType);
          }
        }
      }
    }
    done += 1;
    process.stdout.write(`\r  ${done}/${ids.length} matches probed…      `);
  }

  const mapOut = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  const out = {
    generatedAt: new Date().toISOString(),
    sample: {
      matchesRequested: WANT_MATCHES,
      matchesProbed: done,
      matchesWithTimeline: withTimeline,
      participantRows: participantTop.rows,
      participantRowsWithChallenges: withChallenges,
      challengesMissingRate: +(1 - withChallenges / Math.max(participantTop.rows, 1)).toFixed(4)
    },
    queueIds: mapOut(queueIds),
    gameVersions: mapOut(gameVersions),
    frameIntervals: mapOut(frameIntervals),
    enums: Object.fromEntries(Object.entries(enums).map(([k, v]) => [k, mapOut(v)])),
    eventTypes: Object.fromEntries(
      [...eventTypes.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([t, r]) => [t, { count: r.count, keys: mapOut(r.keys) }])
    ),
    participantFrameKeys: participantFrameKeys.summary(),
    participantFields: participantTop.summary(),
    challenges: challenges.summary(),
    patchFacts: {
      baronFirstSpawnMs: observed.baronFirstSpawnMs.length
        ? Math.min(...observed.baronFirstSpawnMs)
        : null,
      baronKillsSeen: observed.baronFirstSpawnMs.length,
      atakhanEvents: observed.atakhanEvents,
      hordeEvents: observed.hordeEvents,
      dragonSoulGivenEvents: observed.soulEvents,
      turretPlateEvents: observed.plateEventsTotal,
      turretPlateEventsAfter14Min: observed.plateEventsAfter14,
      turretPlatesByLane: mapOut(observed.platesByLane)
    }
  };

  fs.writeFileSync(path.join(DOCS, 'schema-observed.json'), JSON.stringify(out, null, 2));
  console.log(`\n\nWrote docs/schema-observed.json`);
  console.log(`  ${done} matches, ${participantTop.rows} participant rows, ${withTimeline} timelines`);
  console.log(`  ${Object.keys(out.challenges).length} distinct challenges keys`);
  console.log(`  ${Object.keys(out.eventTypes).length} distinct timeline event types`);
}

main().catch((e) => {
  console.error('\nProbe failed:', e.response?.status, e.response?.data || e.message);
  process.exit(1);
});
