// Why one person scored what they did, in one game (spec §10.1, §10.2).
//
// Not a list of what the model weighs — that is `/glossary`, and reading it
// tells you nothing about the game you just played. This answers the question
// people actually ask, which is "why is that number what it is", and it answers
// it for a good game as readily as a bad one.
//
// The arithmetic is what makes it honest rather than impressionistic. A
// composite is a weighted mean of components anchored at 50, so
//
//   composite − 50 = Σ (weightᵢ / Σweight) × (scoreᵢ − 50)
//
// exactly. Each component's *contribution* is that term: how many points of the
// final score it is responsible for. That is the spec's §10.2 requirement and
// the reason it says contributions rather than scores — a component can be
// wildly above par and barely matter if it weighs 6, and a mild dip on a weight
// of 28 can be the whole story.

/** Composite bands, in the language the scorecard already uses. */
function verdictFor(composite) {
  if (composite >= 80) return { word: 'An outstanding game', tone: 'high' };
  if (composite >= 70) return { word: 'A strong game', tone: 'high' };
  if (composite >= 60) return { word: 'A good game', tone: 'high' };
  if (composite >= 47) return { word: 'An ordinary game', tone: 'par' };
  if (composite >= 36) return { word: 'A poor game', tone: 'low' };
  return { word: 'A bad game', tone: 'low' };
}

// Below this a component is rounding, not a reason. Naming a 0.4-point
// contribution alongside a 9-point one implies they are comparable.
const WORTH_MENTIONING = 1.0;
const MAX_REASONS = 3;

/**
 * Breaks a stored score into what actually moved it.
 *
 * @param {object} scored - one player's stored score record
 * @returns {{verdict, composite, fromPar, carried, cost, minor, total}}
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
      // Points of the final score this component is responsible for.
      contribution: totalWeight > 0 ? (c.weight / totalWeight) * (c.score - 50) : 0
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const carried = parts.filter((p) => p.contribution >= WORTH_MENTIONING).slice(0, MAX_REASONS);
  const cost = parts
    .filter((p) => p.contribution <= -WORTH_MENTIONING)
    .slice(0, MAX_REASONS)
    .sort((a, b) => a.contribution - b.contribution);

  return {
    verdict: verdictFor(scored.composite),
    composite: scored.composite,
    fromPar: Math.round((scored.composite - 50) * 10) / 10,
    carried,
    cost,
    // Everything that landed close enough to par to not be part of the story.
    minor: parts.filter((p) => Math.abs(p.contribution) < WORTH_MENTIONING).length,
    parts
  };
}

const sign = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));

/**
 * The explanation as sentences.
 *
 * Written as prose rather than a table on purpose. A table of every component
 * and its weight is a description of the model; this is meant to be a
 * description of the game.
 */
export function explainPerformance(scored) {
  const c = contributions(scored);
  const { verdict, carried, cost } = c;

  // --- the opening line ------------------------------------------------------
  //
  // Names whatever moved the score furthest in *either* direction, because that
  // is the sentence somebody reads if they read only one — and it has to agree
  // with the verdict. Picking the largest positive first said "a bad game, and
  // mostly deaths" about a game where deaths were the only thing that went
  // right, which is the opposite of what happened.
  const lead = c.parts[0] ?? null;
  const helped = lead != null && lead.contribution > 0;
  const headline =
    lead == null || Math.abs(lead.contribution) < WORTH_MENTIONING
      ? `${verdict.word}. Nothing in it stands out either way.`
      : c.fromPar >= 0
        ? helped
          ? `${verdict.word}, and mostly down to **${lead.label.toLowerCase()}**.`
          : `${verdict.word}, despite **${lead.label.toLowerCase()}** going against you.`
        : helped
          ? `${verdict.word}, and **${lead.label.toLowerCase()}** was the only part that went right.`
          : `${verdict.word}, and mostly **${lead.label.toLowerCase()}**.`;

  const par =
    c.fromPar === 0
      ? '50 is par for the role, and this landed exactly on it.'
      : `50 is par for the role — what the model expects of anyone playing it. This came in **${Math.abs(c.fromPar)} ${c.fromPar > 0 ? 'above' : 'below'}**.`;

  // --- the reasons -----------------------------------------------------------
  const line = (p) => `**${p.label}** ${sign(p.contribution)}` + (p.detail ? ` — ${p.detail}` : '');

  // Whichever direction the score went leads, because that is the story. A bad
  // game that opens with the one thing that went right buries its own point.
  const good = carried.length
    ? { name: c.fromPar >= 0 ? 'What carried it' : 'What held it up', value: carried.map(line).join('\n') }
    : null;
  const bad = cost.length
    ? { name: c.fromPar >= 0 ? 'What held it back' : 'What cost it', value: cost.map(line).join('\n') }
    : null;
  const sections = (c.fromPar >= 0 ? [good, bad] : [bad, good]).filter(Boolean);

  // --- the closing note ------------------------------------------------------
  let closing;
  if (!carried.length && cost.length) closing = 'Nothing in the game pulled the other way.';
  else if (carried.length && !cost.length) closing = 'Nothing dragged it down.';
  else if (c.minor > 0) closing = `The other ${c.minor === 1 ? 'component' : `${c.minor} components`} landed close enough to par to not be part of the story.`;
  else closing = null;

  return { ...c, headline, par, sections, closing };
}

/**
 * The scorecard notes that are not already said by a reason above.
 *
 * `buildNotes` was written for a compact scorecard where it is the only prose on
 * screen. Here the reasons already carry the component details, so "team held
 * 15% of epics" arrives directly underneath "Objectives −4.5 — team held 15%".
 * Repeating a number makes an explanation look padded, which is the opposite of
 * what it is for.
 *
 * Matched on the figures rather than the wording: a note whose numbers are all
 * already on screen is saying the same thing in different words.
 */
export function distinctNotes(notes, sections) {
  const shown = sections.map((s) => s.value).join(' ');
  const figures = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []);
  const onScreen = new Set(figures(shown));

  return (notes || []).filter((n) => {
    const mine = figures(n);
    return mine.length === 0 || !mine.every((f) => onScreen.has(f));
  });
}
