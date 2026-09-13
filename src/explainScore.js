// Why one person scored what they did, in one game (spec §10.1, §10.2).
//
// Not a list of what the model weighs — that is `/glossary`. This answers the
// question people actually ask, "why is that number what it is", for a good game
// as readily as a bad one.
//
// The arithmetic is what makes it honest rather than impressionistic. A
// composite is a weighted mean of components anchored at 50, so
//
//   composite − 50 = Σ (weightᵢ / Σweight) × (scoreᵢ − 50)
//
// exactly. Each component's *contribution* is that term: how many points of the
// final score it is responsible for. The spec asks for contributions rather than
// scores for exactly this reason — a component can be wildly above par and barely
// matter at a weight of 6, and a mild dip at a weight of 28 can be the whole story.

import { narrate } from './narrate.js';

// A reason has to move the score by at least this much to be told as one.
const WORTH_TELLING = 0.5;
const MAX_REASONS = 4;

/**
 * How far from par, in words that describe the gap rather than judge the player.
 *
 * Banded on distance from 50 rather than on the letter grade. 45.7 is a D, and
 * calling it "a poor game" describes a 4-point miss the same way as a 14-point
 * one; "a little below par" is what actually happened.
 */
function verdictFor(fromPar) {
  const d = Math.abs(fromPar);
  if (d < 3) return 'Right around par';
  if (fromPar < 0) return d < 8 ? 'A little below par' : d < 15 ? 'Below par' : 'Well below par';
  return d < 8 ? 'A little above par' : d < 15 ? 'A good game' : 'A strong game';
}

/**
 * Breaks a stored score into what actually moved it.
 */
export function contributions(scored) {
  const usable = (scored.components || []).filter((c) => Number.isFinite(c.score) && c.weight > 0);
  const totalWeight = usable.reduce((s, c) => s + c.weight, 0);

  const parts = usable
    .map((c) => ({
      key: c.key,
      label: c.label,
      score: c.score,
      weight: c.weight,
      detail: c.detail || null,
      contribution: totalWeight > 0 ? (c.weight / totalWeight) * (c.score - 50) : 0
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    composite: scored.composite,
    fromPar: Math.round((scored.composite - 50) * 10) / 10,
    parts,
    // Kept for callers that only want each direction.
    carried: parts.filter((p) => p.contribution >= WORTH_TELLING).slice(0, MAX_REASONS),
    cost: parts.filter((p) => p.contribution <= -WORTH_TELLING).slice(0, MAX_REASONS)
  };
}

const lower = (s) => s.toLowerCase();

/**
 * The explanation: a one-line summary, a short paragraph for each thing that
 * actually moved the score, and one line accounting for the rest.
 */
export function explainPerformance(scored) {
  const c = contributions(scored);
  const verdict = verdictFor(c.fromPar);

  // The reasons are whatever moved the score most, told in the order they
  // mattered. Direction is not filtered: a below-par game whose single biggest
  // mover was a strong component should still show that component.
  //
  // How many is decided by the game rather than fixed. A flat three hid a −3.6
  // while showing a −4.5 above it, which is arbitrary; a flat four would pad a
  // quiet game with components that barely moved. So the first two are told if
  // they matter at all, and the third and fourth only if each is at least 40% of
  // the largest — substantial next to the thing that mattered most.
  const largest = Math.abs(c.parts[0]?.contribution ?? 0);
  const reasons = c.parts
    .filter((p) => Math.abs(p.contribution) >= WORTH_TELLING)
    .filter((p, i) => i < 2 || Math.abs(p.contribution) >= largest * 0.4)
    .slice(0, MAX_REASONS)
    .map((p) => ({ ...p, ...narrate(p, scored) }));

  // --- summary ----------------------------------------------------------------
  //
  // Names what pushed the score in the direction it went. On a below-par game
  // that is what cost it; above par, what carried it. Naming a positive in the
  // summary of a negative game is how "a bad game, and mostly deaths" got
  // written about a game where deaths were the one thing that went right.
  const pushing = reasons.filter((r) => (c.fromPar < 0 ? r.contribution < 0 : r.contribution > 0));
  const names = pushing.slice(0, 2).map((r) => lower(r.label));
  let summary;
  if (Math.abs(c.fromPar) < 3) {
    summary = names.length ? `${verdict} — ${names.join(' and ')} moved it most, and not far.` : `${verdict}.`;
  } else if (names.length === 0) {
    summary = `${verdict}, spread thinly across everything rather than down to one thing.`;
  } else {
    summary = `${verdict} — mostly ${names.join(' and ')}.`;
  }

  // --- the rest ---------------------------------------------------------------
  //
  // Said out loud so the figures on screen visibly add up to the score. Listing
  // two reasons worth −2.6 under a game 4.3 below par, with a footer claiming
  // they sum to the gap, is the kind of thing that makes a reader stop trusting
  // the rest of the explanation.
  const told = new Set(reasons.map((r) => r.key));
  const rest = c.parts.filter((p) => !told.has(p.key));
  const restTotal = rest.reduce((s, p) => s + p.contribution, 0);
  const restLargest = rest.reduce((m, p) => Math.max(m, Math.abs(p.contribution)), 0);

  let remainder = null;
  if (rest.length > 0) {
    const signed = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
    remainder =
      Math.abs(restTotal) < 0.05
        ? `The other ${rest.length === 1 ? 'component' : `${rest.length} components`} landed on par.`
        : `The other ${rest.length === 1 ? 'component' : `${rest.length} components`} added ${signed(restTotal)} between them` +
          (rest.length > 1 ? `, none more than ${restLargest.toFixed(1)} on its own.` : '.');
  }

  return { ...c, verdict, summary, reasons, remainder };
}

/**
 * The scorecard notes a paragraph has not already told.
 *
 * `buildNotes` was written for a compact scorecard where it is the only prose on
 * screen. The narrated paragraphs now say most of it in full sentences — "your
 * jungler spent a lot of time in your lane" is the note "jungler committed ×1.7",
 * told — so the notes are filtered against the paragraphs on their figures.
 */
export function distinctNotes(notes, told) {
  const items = Array.isArray(told) ? told : [];
  const text = items.map((s) => (typeof s === 'string' ? s : s.why ?? s.value ?? '')).join(' ');
  const keys = new Set(items.map((s) => s?.key).filter(Boolean));

  // Which component's paragraph already tells each kind of note. Matching on the
  // figures alone misses the case that matters most: "jungler committed ×1.7" is
  // exactly what the lane paragraph says in words, without ever printing 1.7.
  const COVERED_BY = [
    [/jungler committed|camped/i, 'lane'],
    [/deaths alone|solo deaths/i, 'deaths'],
    [/of epics/i, 'objectives'],
    [/unanswered/i, 'pressure'],
    [/lanes .* down/i, 'tempo'],
    [/cross-map trades/i, 'tempo'],
    [/down .*g @\d+, \+/i, 'lane']
  ];

  const figures = (s) => String(s).match(/\d+(?:\.\d+)?/g) || [];
  const onScreen = new Set(figures(text));

  return (notes || []).filter((n) => {
    const topic = COVERED_BY.find(([re]) => re.test(n));
    if (topic && keys.has(topic[1])) return false;
    const mine = figures(n);
    return mine.length === 0 || !mine.every((f) => onScreen.has(f));
  });
}
