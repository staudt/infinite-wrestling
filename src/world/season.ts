// Seasons: 12 episodes each, with pay-per-views at episodes 4, 8 and 12 (12 is the
// finale). Episode numbers in the world are global (1, 2, 3, ...); these helpers map them
// onto the season calendar and apply the off-season roster shuffle.
import { farthestColor } from '../engine/colors';
import { hashSeed, Rng } from '../engine/rng';
import type { SeasonPlan, SeasonStart, SeasonTransition } from '../schema/season';
import { MOVES } from '../sim/moves';
import { profileOf, randomPromotion } from './genesis';
import { type Character, CREW_COLORS, type World } from './state';

export const SEASON_LENGTH = 12;
export const PPV_EPISODES = [4, 8, 12];
const OFFLINE_PPV_NAMES = [
  'Summer Slaughter', 'Blood & Glory', 'Night of Champions', 'Havoc at the Coliseum', 'Final Reckoning',
  'Thunder Dome', 'Bash at the Beach Club', 'Starrcade Nights', 'No Way Out', 'Road to Glory', 'The Last Stand', 'Wrestle Rampage',
];

/** Season number (1-based) of global episode `n`. */
export const seasonOf = (n: number) => Math.floor((n - 1) / SEASON_LENGTH) + 1;
/** Position of global episode `n` within its season (1..12). */
export const episodeInSeason = (n: number) => ((n - 1) % SEASON_LENGTH) + 1;
export const isPPV = (n: number) => PPV_EPISODES.includes(episodeInSeason(n));
export const isFinale = (n: number) => episodeInSeason(n) === SEASON_LENGTH;
export const isSeasonStart = (n: number) => episodeInSeason(n) === 1;

/** The PPV name for global episode `n`, from the season plan when there is one. */
export function ppvName(world: Pick<World, 'plan'>, n: number): string | null {
  if (!isPPV(n)) return null;
  const e = episodeInSeason(n);
  const planned = world.plan?.ppvs.find((p) => p.episode === e)?.name;
  if (planned) return planned;
  return OFFLINE_PPV_NAMES[(seasonOf(n) * 3 + PPV_EPISODES.indexOf(e)) % OFFLINE_PPV_NAMES.length];
}

/** Human label, e.g. "Season 2 · Episode 4 — PPV: Summer Slaughter". */
export function episodeLabel(world: Pick<World, 'plan'>, n: number): string {
  const ppv = ppvName(world, n);
  return `Season ${seasonOf(n)} · Episode ${episodeInSeason(n)}${ppv ? ` — ${isFinale(n) ? 'Finale' : 'PPV'}: ${ppv}` : ''}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Apply the off-season: departures leave (titles vacated), arrivals join with fresh colors. */
export function applyTransition(world: World, t: SeasonTransition | null, season: number): World {
  if (!t) return world;
  const w = structuredClone(world);
  const leaving = new Set(
    t.departures.map((d) => d.id).filter((id) => w.characters.some((c) => c.id === id && c.role !== 'interviewer')),
  );
  w.alumni = [
    ...(w.alumni ?? []),
    ...w.characters.filter((c) => leaving.has(c.id)).map((c) => ({
      id: c.id, name: c.name, reason: t.departures.find((d) => d.id === c.id)?.reason ?? '', season: season - 1,
    })),
  ].slice(-40);
  w.characters = w.characters.filter((c) => !leaving.has(c.id));
  for (const title of w.titles) if (title.holder && leaving.has(title.holder)) title.holder = null;
  w.feuds = w.feuds.filter((f) => !leaving.has(f.a) && !leaving.has(f.b));
  w.alliances = w.alliances
    .map((a) => ({ ...a, members: a.members.filter((m) => !leaving.has(m)) }))
    .filter((a) => a.members.length >= 2);

  const used = [...Object.values(CREW_COLORS), ...w.characters.map((c) => c.color)];
  for (const a of t.arrivals) {
    let id = slug(a.id || a.name);
    while (w.characters.some((c) => c.id === id)) id += '_2';
    let move = a.finisherMove;
    if (!MOVES.some((m) => m.id === move) || ['cover', 'rollup'].includes(move)) move = 'piledriver';
    const color = farthestColor(used);
    used.push(color);
    const c: Character = {
      id, name: a.name.trim(), role: a.role, alignment: a.alignment, division: a.division, style: a.style,
      gimmick: a.gimmick, entrance: a.entrance || 'to a roar from the crowd', color,
      finisher: {
        name: a.finisherName || MOVES.find((m) => m.id === move)!.name, move,
        ...(a.finisherDescription.trim() ? { description: a.finisherDescription.trim() } : {}),
        ...(a.finisherCall.trim() ? { call: a.finisherCall.trim() } : {}),
      },
      ...profileOf(a),
    };
    w.characters.push(c);
  }
  w.seasonHistory = [...(w.seasonHistory ?? []), { season: season - 1, recap: t.recap }].slice(-10);
  return w;
}

/** Everything a season start does to the world: the shuffle, then the new plan. */
export function applySeasonStart(world: World, s: SeasonStart): World {
  const w = applyTransition(world, s.transition, s.season);
  return { ...w, plan: s.plan ?? undefined };
}

/** Offline off-season: a few wrestlers leave, a few generated newcomers arrive. */
export function offlineTransition(world: World, season: number): SeasonTransition {
  const rng = new Rng(hashSeed('offseason', world.seed, season));
  const wrestlers = world.characters.filter((c) => c.role === 'wrestler');
  const champs = new Set(world.titles.map((t) => t.holder));
  const pool = wrestlers.filter((c) => !champs.has(c.id));
  const n = Math.max(2, Math.round(wrestlers.length * 0.25));
  const departures = rng.shuffle(pool).slice(0, n).map((c) => ({
    id: c.id, reason: rng.pick(['contract expired', 'retired', 'left for a rival promotion', 'injured']),
  }));
  const fresh = randomPromotion(hashSeed('arrivals', world.seed, season)).characters.filter((c) => c.role === 'wrestler');
  const divisions = departures.map((d) => world.characters.find((c) => c.id === d.id)!.division);
  const arrivals = divisions.map((div) => fresh.find((c) => c.division === div && !world.characters.some((x) => x.name === c.name)))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .filter((c, i, all) => all.indexOf(c) === i);
  return { recap: `Season ${season - 1} of ${world.showName} is in the books.`, departures, arrivals };
}

/** Offline plan: PPV names only, no arcs. */
export function offlinePlan(season: number): SeasonPlan {
  const base = (season - 1) * SEASON_LENGTH;
  return {
    theme: '',
    ppvs: PPV_EPISODES.map((e) => ({ episode: e, name: ppvName({ plan: undefined }, base + e)!, mainEvent: '', card: [] })),
    arcs: [],
  };
}

/** The season block for the weekly booking prompt. */
export function seasonContext(world: World): string {
  const n = world.episode + 1;
  const e = episodeInSeason(n);
  const s = seasonOf(n);
  const plan = world.plan;
  const next = PPV_EPISODES.find((p) => p >= e)!;
  const nextName = ppvName(world, n - e + next);
  const lines = [`SEASON ${s}, EPISODE ${e} OF ${SEASON_LENGTH}.`];
  if (isFinale(n)) {
    lines.push(`THIS IS THE SEASON FINALE PPV: "${nextName}". The biggest show of the year: pay off the season's arcs, settle the main feuds in gimmick matches (cage, ladder) and close them (feud_end), crown or confirm champions, and plant one or two long-term cliffhangers for next season. Book 7-9 segments, long matches for the top of the card.`);
  } else if (isPPV(n)) {
    lines.push(`THIS IS A PAY-PER-VIEW: "${nextName}". Big matches, title matches, payoffs for this month's builds, and at least one cage or ladder match to settle a feud. Book 7-9 segments, long matches for the top of the card.`);
  } else if (next - e === 1) {
    lines.push(`GO-HOME SHOW: next week is the PPV "${nextName}". Confirm the PPV card (including its gimmick match), final face-offs and contract signings, make fans want to see it. About 6 segments, 1-3 matches.`);
  } else {
    lines.push(`Weekly TV. The next PPV, "${nextName}", is ${next - e} weeks away: build toward its card. About 6 segments, 1-3 matches, a tag match if it moves a feud.`);
  }
  if (plan) {
    if (plan.theme) lines.push(`SEASON THEME: ${plan.theme}`);
    lines.push(`PPV PLAN:\n${plan.ppvs.map((p) => `- Ep ${p.episode} "${p.name}": ${p.mainEvent}${p.card.length ? ` | also: ${p.card.join('; ')}` : ''}`).join('\n')}`);
    if (plan.arcs.length) {
      lines.push('LONG-TERM ARCS (follow them, adapt if the story demands):');
      for (const a of plan.arcs) {
        const now = a.beats.filter((b) => b.episode === e).map((b) => b.beat);
        const soon = a.beats.filter((b) => b.episode === e + 1).map((b) => b.beat);
        lines.push(`- ${a.title} [${a.archetype}] (${a.characters.join(', ')}): ${a.summary} Payoff ep ${a.payoff.episode}: ${a.payoff.outcome}` +
          (now.length ? `\n    THIS WEEK: ${now.join(' / ')}` : '') + (soon.length ? `\n    next week: ${soon.join(' / ')}` : ''));
      }
    }
  }
  // What this season has used so far, so gaps get noticed (no gimmick match yet, etc).
  const seasonStart = n - e + 1;
  const used = new Map<string, number>();
  for (const l of world.angleLog ?? []) {
    if (l.episode < seasonStart) continue;
    for (const k of l.kinds) if (k.startsWith('stip:') && k !== 'stip:singles') used.set(k.slice(5), (used.get(k.slice(5)) ?? 0) + 1);
  }
  if (e > 1) {
    const count = (k: string) => used.get(k) ?? 0;
    lines.push(`STIPULATIONS SO FAR THIS SEASON: tag ×${count('tag')}, cage ×${count('cage')}, ladder ×${count('ladder')}, battle royal ×${count('battle_royal')}.`);
  }
  if (world.plan || e > 1) {
    const heelVsHeel = world.feuds.filter((f) => {
      const a = world.characters.find((c) => c.id === f.a)?.alignment;
      const b = world.characters.find((c) => c.id === f.b)?.alignment;
      return a === 'heel' && b === 'heel';
    });
    if (heelVsHeel.length) {
      lines.push(`NOTE: heel vs heel feuds (${heelVsHeel.map((f) => `${f.a} vs ${f.b}`).join(', ')}) don't draw for long: wrap them up, or turn one of them.`);
    }
  }
  if (world.seasonHistory?.length) lines.push(`PAST SEASONS:\n${world.seasonHistory.map((h) => `- Season ${h.season}: ${h.recap}`).join('\n')}`);
  return lines.join('\n');
}
