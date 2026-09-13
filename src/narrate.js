// Turns a component score into a sentence a player would recognise.
//
// "Lane −1.4 — +130g @14 (bar +646g)" is accurate and tells nobody anything. What
// it means is: you came out of lane 130g up, but your jungler spent so long in
// your lane that 650g was the expectation, so the lane grades below par. That
// sentence is the explanation; the first line is just its evidence.
//
// Each narrator gets the stored facts for the game and the live bar for the role,
// and returns why the component landed where it did and — when it was below par —
// the one change that would have lifted it. Kept to two sentences, because the
// point is that people read it.
//
// Games scored before these facts were stored fall back to the component's own
// detail line. `/rescore` fills them in.

import { BASELINE } from './scoring/roles.js';

const ROLE_NAME = {
  TOP: 'top laner',
  JUNGLE: 'jungler',
  MIDDLE: 'mid laner',
  BOTTOM: 'ADC',
  UTILITY: 'support',
  UNKNOWN: 'player'
};

/** 'an ADC', 'a jungler' — the only role name that needs the other article. */
const aRole = (name) => (/^[aeiou]/i.test(name) || name === 'ADC' ? `an ${name}` : `a ${name}`);

const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const g = (n) => `${Math.abs(Math.round(n)).toLocaleString('en-GB')}g`;
const pct = (n) => `${Math.round(n)}%`;
const fixed = (n, dp = 1) => Number(n).toFixed(dp);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A lead or deficit, said the way a player would say it. */
const standing = (diff) => (diff >= 0 ? `${g(diff)} ahead` : `${g(diff)} behind`);

// ---------------------------------------------------------------------------

const NARRATORS = {
  lane(c, f, m) {
    if (!has(f.goldDiff14)) return null;
    const vs = `the enemy ${m.roleName}`;
    // The same bar the model used: each net jungle commitment moves "even" by
    // about 380g, capped at three against and two for.
    const net = has(f.netJunglePressure) ? Math.max(-2, Math.min(3, f.netJunglePressure)) : 0;
    const expected = -net * 380;
    const at = f.benchMinute ?? 14;

    let why;
    if (net <= -1) {
      why =
        `You came out of laning ${standing(f.goldDiff14)} of ${vs} — but your jungler spent a lot of time in your lane, ` +
        `so ${expected > 0 ? `a lead nearer ${g(expected)}` : 'more'} was the expectation from that much help.`;
    } else if (net >= 1) {
      why =
        `You were ${standing(f.goldDiff14)} of ${vs} at ${at} minutes, but you were ganked repeatedly — ` +
        `${g(expected)} behind was the expected cost of that much pressure, and this is measured against it.`;
    } else {
      why = `You finished laning ${standing(f.goldDiff14)} of ${vs}, with no jungle pressure either way to account for it.`;
    }

    if (has(f.postLaneSwing) && Math.abs(f.postLaneSwing) >= 800) {
      why +=
        f.postLaneSwing > 0
          ? ` You then out-earned them by ${g(f.postLaneSwing)} after laning, which is credited.`
          : ` They then out-earned you by ${g(f.postLaneSwing)} after laning.`;
    }

    const fix =
      c.score >= 50
        ? null
        : net <= -1
          ? 'Turning that pressure into a bigger lead is what would have put this above par.'
          : 'Coming out of lane closer to even is par.';
    return { why, fix };
  },

  economy(c, f, m) {
    if (!has(f.csPerMin)) return null;
    const bar = m.bar.csPerMin;
    const isJungle = m.role === 'JUNGLE';
    const short = has(f.minutes) && has(bar) ? Math.round((bar - f.csPerMin) * f.minutes) : null;
    const why =
      `${fixed(f.csPerMin)} CS a minute, against the ${fixed(bar)} ${aRole(m.roleName)} usually manages` +
      (short !== null && Math.abs(short) >= 10
        ? ` — ${short > 0 ? `about ${short} CS short` : `about ${-short} CS ahead of that`} across ${Math.round(f.minutes)} minutes.`
        : '.');
    const fix =
      c.score >= 50
        ? null
        : isJungle
          ? 'Clearing more camps between plays brings this back to par.'
          : `Farming closer to ${fixed(bar)} a minute brings this back to par.`;
    return { why, fix };
  },

  combat(c, f, m) {
    if (!has(f.dmgShare)) return null;
    const bar = Math.round((m.bar.dmgShare ?? 0) * 100);
    let why = `You did ${pct(f.dmgShare)} of your team's damage, where ${aRole(m.roleName)} usually does about ${pct(bar)}`;
    if (has(f.killShare)) why += `, and took ${pct(f.killShare)} of the kills`;
    why += '.';

    // The conversion check, said plainly when it is what held the score back.
    const converted = has(f.killShare) && f.dmgShare > 0 ? f.killShare / f.dmgShare : null;
    const par = m.bar.killPerDamageShare;
    if (converted !== null && has(par) && f.dmgShare > bar && converted < par * 0.7) {
      why += " A lot of that damage didn't turn into kills, so the model counts less of it.";
    }

    // The advice has to name the cause that actually applies, and say nothing
    // when none of the checkable ones do. Picking "turn damage into kills"
    // whenever damage share was above par told a player converting at 1.3x par
    // that conversion was their problem — wrong advice is worse than none.
    const dpgsBar = m.bar.damagePerGoldShare;
    let fix = null;
    if (c.score < 50) {
      if (f.dmgShare < bar) fix = 'Doing more of the team’s damage is what lifts this.';
      else if (converted !== null && has(par) && converted < par * 0.85) {
        fix = 'Turning more of that damage into kills is what lifts this.';
      } else if (has(f.damagePerGoldShare) && has(dpgsBar) && f.damagePerGoldShare < dpgsBar * 0.9) {
        fix = 'It took more gold than usual to do that damage — the same damage on less gold lifts this.';
      }
    }
    return { why, fix };
  },

  deaths(c, f, m) {
    if (!has(f.deaths)) return null;
    const t = f.deathTags || {};
    const solo = t.solo || 0;
    const deep = t.deep || 0;
    const fights = t.teamfight || 0;
    const ganked = t.ganked || 0;

    if (f.deaths === 0) return { why: 'You did not die once.', fix: null };

    let why = `${plural(f.deaths, 'death')}`;
    const parts = [];
    if (deep) parts.push(`${deep} alone in the enemy half`);
    else if (solo) parts.push(`${solo} with nobody else involved`);
    if (ganked) parts.push(`${ganked} to ganks`);
    if (fights) parts.push(`${fights} in full teamfights`);
    if (parts.length) why += `: ${parts.join(', ')}`;
    why += '.';

    // Say which way the weighting cut, because it is the part people dispute.
    if (deep || solo) {
      why += ' Deaths nobody else was part of count most against you.';
    } else if (fights >= f.deaths / 2) {
      why += ' Most came in fights your team had committed to, which count for less.';
    } else if (has(f.weightedDeaths) && has(m.bar.wDeathsPerMin) && has(f.minutes)) {
      // No telling tags — say how the count compares to the role, since "9
      // deaths" on its own does not say whether that is a lot for the game.
      const usual = m.bar.wDeathsPerMin * f.minutes;
      const ratio = f.weightedDeaths / usual;
      why +=
        ratio > 1.25
          ? ` That is more than ${aRole(m.roleName)} usually has in a game this long.`
          : ratio < 0.8
            ? ` Once weighted for how each one happened, that is fewer than ${aRole(m.roleName)} usually has in a game this long.`
            : ` Once weighted for how each one happened, that is about what ${aRole(m.roleName)} usually has in a game this long.`;
    }

    const fix =
      c.score >= 50
        ? null
        : deep || solo
          ? 'Fewer deaths alone in enemy territory is the fastest way to lift this.'
          : 'Dying less often is what lifts this.';
    return { why, fix };
  },

  vision(c, f, m) {
    if (!has(f.visionPerMin)) return null;
    const bar = m.bar.visionPerMin;
    const why =
      `${fixed(f.visionPerMin, 2)} vision score a minute, against the ${fixed(bar, 2)} ${aRole(m.roleName)} usually has` +
      (has(f.controlWards) ? `, with ${plural(f.controlWards, 'control ward')}.` : '.');
    const fix = c.score >= 50 ? null : 'Buying and placing more control wards makes up most of that gap.';
    return { why, fix };
  },

  objectives(c, f, m) {
    if (!has(f.teamEpicControl)) return null;
    let why = `Your team took ${pct(f.teamEpicControl)} of the objectives`;
    // A jungler's share is not graded — their bar has no headroom — so it is not
    // mentioned for them, only the control.
    if (m.role !== 'JUNGLE' && has(f.epicShare)) why += `, and you were there for ${pct(f.epicShare)} of them`;
    if (f.tookSoul) why += ', including soul';
    else if (f.concededSoul) why += ', and gave up soul';
    why += '.';
    const fix =
      c.score >= 50
        ? null
        : m.role === 'JUNGLE'
          ? 'Contesting drakes and heralds rather than trading them away is what lifts this.'
          : 'Being there when your team takes an objective is what lifts this.';
    return { why, fix };
  },

  presence(c, f, m) {
    if (!has(f.kp)) return null;
    const why =
      `In ${pct(f.kp)} of your team's kills` +
      (has(f.lateKp) ? `, and ${pct(f.lateKp)} after the 15-minute mark.` : '.');
    const fix = c.score >= 50 ? null : 'Being in more of the fights after laning is what lifts this.';
    return { why, fix };
  },

  roam(c, f, m) {
    if (m.role === 'UTILITY') {
      if (!has(f.roamTakedowns)) return null;
      return {
        why: `${plural(f.roamTakedowns, 'takedown')} away from bot lane during laning.`,
        fix: c.score >= 50 ? null : 'Leaving a won lane to make plays elsewhere is what lifts this.'
      };
    }
    return NARRATORS.presence(c, f, m);
  },

  tempo(c, f, m) {
    if (m.role !== 'JUNGLE' || !has(f.weightedLaneGold14)) return null;
    let why = `The lanes you spent time in were ${standing(f.weightedLaneGold14)} at 14`;
    if (has(f.jungleControl)) why += `, and you took about ${plural(Math.max(0, Math.round(f.jungleControl)), 'camp')}' worth of control off their jungle`;
    why += '.';
    if (has(f.tradeValueWon) && has(f.tradeValueLost)) {
      why +=
        f.tradeValueWon >= f.tradeValueLost
          ? ` You won the cross-map trades ${fixed(f.tradeValueWon)} to ${fixed(f.tradeValueLost)}.`
          : ` You lost the cross-map trades ${fixed(f.tradeValueWon)} to ${fixed(f.tradeValueLost)}.`;
    }
    const fix = c.score >= 50 ? null : 'Spending time in the lanes that can win, and trading objectives rather than conceding them, lifts this.';
    return { why, fix };
  },

  pressure(c, f, m) {
    if (!has(f.gankTakedowns) && !has(f.alliesUnanswered)) return null;
    let why = has(f.gankTakedowns) ? `${plural(f.gankTakedowns, 'gank takedown')}` : 'Your ganks';
    if (has(f.alliesUnanswered) && f.alliesUnanswered >= 0.5) {
      why += `, and the enemy jungler got into your lanes about ${plural(Math.round(f.alliesUnanswered), 'time')} without an answer`;
    }
    why += '.';
    const fix = c.score >= 50 ? null : 'Ganks that end in a takedown, and answering their jungler’s, is what lifts this.';
    return { why, fix };
  },

  sidelane(c, f, m) {
    const bits = [];
    if (has(f.soloKills) && f.soloKills > 0) bits.push(plural(f.soloKills, 'solo kill'));
    if (has(f.platesEarly)) bits.push(`${plural(f.platesEarly, 'plate')} in laning`);
    if (has(f.turretDamage)) bits.push(`${Math.round(f.turretDamage).toLocaleString('en-GB')} damage to turrets`);
    if (!bits.length) return null;
    return {
      why: `${bits.join(', ')}.`.replace(/^./, (s) => s.toUpperCase()),
      fix: c.score >= 50 ? null : 'Taking plates and pushing a side lane when your team is elsewhere lifts this.'
    };
  },

  structures(c, f, m) {
    if (!has(f.turretDamage)) return null;
    const usual = has(m.bar.turretDmgPerMin) && has(f.minutes) ? m.bar.turretDmgPerMin * f.minutes : null;
    const why =
      `${Math.round(f.turretDamage).toLocaleString('en-GB')} damage to turrets` +
      (usual ? `, against the roughly ${Math.round(usual).toLocaleString('en-GB')} ${aRole(m.roleName)} does in a game this long.` : '.');
    return { why, fix: c.score >= 50 ? null : 'Hitting towers whenever the lane is pushed is what lifts this.' };
  },

  utility(c, f, m) {
    if (!has(f.ccScore) && !has(f.healShieldPerMin)) return null;
    const bits = [];
    if (has(f.ccScore)) bits.push(`${Math.round(f.ccScore)} crowd control`);
    if (has(f.healShieldPerMin) && f.healShieldPerMin > 0) bits.push(`${f.healShieldPerMin} healing and shielding a minute`);
    return {
      why: `${bits.join(', ')} — graded on whichever your champion is built for.`.replace(/^./, (s) => s.toUpperCase()),
      fix: c.score >= 50 ? null : 'More of whichever your champion does best is what lifts this.'
    };
  }
};

/**
 * One component, told as a short paragraph.
 *
 * @param {object} component  stored `{ key, label, score, detail }`
 * @param {object} scored     the whole stored score (role, context)
 * @returns {{ why: string, fix: string|null, fromFacts: boolean }}
 */
export function narrate(component, scored) {
  const role = scored.role ?? 'UNKNOWN';
  const meta = { role, roleName: ROLE_NAME[role] ?? 'player', bar: BASELINE[role] ?? BASELINE.UNKNOWN };
  const facts = scored.context ?? {};

  const told = NARRATORS[component.key]?.(component, facts, meta);
  if (told?.why) return { ...told, fromFacts: true };

  // An older game, stored before these facts were kept. The detail line is still
  // accurate, just not as readable.
  return { why: component.detail ? `${component.detail}.` : '', fix: null, fromFacts: false };
}

export { ROLE_NAME };
