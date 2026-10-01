// Creating a brand-new promotion. `reviewPromotion` validates and sanitizes a promotion
// (from the LLM or the offline generator) into a playable World; `randomPromotion` is
// LLM output. (The offline random-roster generator lives in src/dev/, for tests and demos.)
import { matchCharacter, unstringify } from '../booker/json';
import { hashSeed, Rng } from '../engine/rng';
import type { Division, Style } from '../schema/episode';
import { Promotion } from '../schema/promotion';
import { hasMove, MOVES } from '../sim/moves';
import { farthestColor, PALETTE } from '../engine/colors';
import { type Character, CREW_COLORS, crewOf, type World } from './state';

export interface PromotionReview {
  world: World | null;
  problems: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1') || 'x';

/** Moves that make sense as a finisher for each style. */
export const FINISHERS_BY_STYLE: Record<Style, string[]> = {
  brawler: ['piledriver', 'lariat', 'ddt', 'big_splash', 'spear'],
  technician: ['figure_four', 'belly_to_belly', 'suplex', 'boston_crab', 'armbar', 'sleeper'],
  powerhouse: ['powerbomb', 'backbreaker', 'spear', 'powerslam', 'big_boot'],
  highflyer: ['moonsault', 'top_rope_splash', 'top_rope_elbow', 'bulldog', 'crossbody'],
  showman: ['ddt', 'bulldog', 'top_rope_elbow', 'leg_drop', 'neckbreaker'],
};

/** Optional profile fields, only when the model provided something usable. */
export function profileOf(c: { hometown: string; weight: number; catchphrase: string }): Pick<Character, 'hometown' | 'weight' | 'catchphrase'> {
  return {
    ...(c.hometown.trim() ? { hometown: c.hometown.trim() } : {}),
    ...(c.weight >= 80 && c.weight <= 700 ? { weight: Math.round(c.weight) } : {}),
    ...(c.catchphrase.trim() ? { catchphrase: c.catchphrase.trim() } : {}),
  };
}

export function reviewPromotion(raw: unknown, direction: string, seed: number): PromotionReview {
  const parsed = Promotion.safeParse(unstringify(raw));
  if (!parsed.success) {
    return { world: null, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const p = parsed.data;
  const problems: string[] = [];
  const rng = new Rng(hashSeed('colors', seed));
  // Rotate the palette per world for variety, then always take the most distinct color left.
  const palette = [...PALETTE.slice(seed % PALETTE.length), ...PALETTE.slice(0, seed % PALETTE.length)];
  const used: string[] = Object.values(CREW_COLORS);
  const ids = new Set<string>();
  const uniqueId = (raw: string) => {
    let id = slug(raw);
    for (let i = 2; ids.has(id); i++) id = `${slug(raw)}_${i}`;
    ids.add(id);
    return id;
  };
  const idMap = new Map<string, string>();

  // Prefer a name-based id ("chet_millwood"): models refer to people by name, not by "interviewer".
  const lanceId = uniqueId(/^(interviewer|announcer|host)$/i.test(p.interviewer.id) || !p.interviewer.id ? p.interviewer.name : p.interviewer.id);
  idMap.set(p.interviewer.id, lanceId);
  const characters: Character[] = [{
    id: lanceId, name: p.interviewer.name, role: 'interviewer', alignment: 'tweener', division: 'men',
    style: 'technician', gimmick: p.interviewer.gimmick, entrance: '', finisher: { name: '', move: 'punch' }, color: '#dddddd',
  }];
  for (const c of p.characters) {
    const id = uniqueId(c.id || c.name);
    if (id !== c.id) problems.push(`character id "${c.id}" was not unique lowercase_snake_case`);
    idMap.set(c.id, id);
    let move = c.finisherMove;
    if (!hasMove(move) || move === 'cover' || move === 'rollup') {
      // Repaired silently: an unknown finisher move isn't worth a paid retry.
      move = rng.pick(FINISHERS_BY_STYLE[c.style]);
    }
    characters.push({
      id, name: c.name.trim(), role: c.role, alignment: c.alignment, division: c.division, style: c.style,
      gimmick: c.gimmick, entrance: c.entrance || 'to a roar from the crowd',
      finisher: {
        name: c.finisherName || MOVES.find((m) => m.id === move)!.name, move,
        ...(c.finisherDescription.trim() ? { description: c.finisherDescription.trim() } : {}),
        ...(c.finisherCall.trim() ? { call: c.finisherCall.trim() } : {}),
      },
      ...profileOf(c),
      color: '',
    });
  }
  // Wrestlers pick first so the people who share the ring are the most distinct.
  for (const c of [...characters.filter((x) => x.role === 'wrestler'), ...characters.filter((x) => x.role !== 'wrestler' && x.role !== 'interviewer')]) {
    c.color = farthestColor(used, palette);
    used.push(c.color);
  }
  const byId = (raw: string) => {
    const id = idMap.get(raw) ?? raw;
    return characters.find((c) => c.id === id) ?? matchCharacter(raw, characters);
  };
  const wrestlersIn = (d: Division) => characters.filter((c) => c.role === 'wrestler' && c.division === d);
  const men = wrestlersIn('men').length;
  const women = wrestlersIn('women').length;
  if (men + women < 6 || Math.max(men, women) < 4) {
    problems.push(`need at least 6 wrestlers, with 4+ in one division (got ${men} men, ${women} women)`);
    return { world: null, problems };
  }

  const titleIds = new Set<string>();
  const titles = p.titles.flatMap((t) => {
    const pool = wrestlersIn(t.division);
    if (pool.length < 2) {
      problems.push(`title ${t.id}: the ${t.division} division needs at least 2 wrestlers`);
      return [];
    }
    let id = slug(t.id || t.name);
    while (titleIds.has(id)) id += '_2';
    titleIds.add(id);
    let holder = byId(t.holder);
    if (!holder || holder.role !== 'wrestler' || holder.division !== t.division) {
      problems.push(`title ${id}: holder "${t.holder}" is not a ${t.division} wrestler`);
      holder = rng.pick(pool);
    }
    return [{ id, name: t.name, division: t.division, holder: holder.id }];
  });
  if (!titles.length) problems.push('the promotion needs at least one title');

  const feuds = p.feuds.flatMap((f) => {
    const a = byId(f.a);
    const b = byId(f.b);
    if (!a || !b || a === b) {
      problems.push(`feud ${f.a} vs ${f.b}: unknown characters`);
      return [];
    }
    return [{ a: a.id, b: b.id, reason: f.reason, since: 0 }];
  });
  const alliances = p.alliances.flatMap((al) => {
    const members = al.members.map(byId).filter((c): c is Character => !!c).map((c) => c.id);
    return members.length >= 2 ? [{ name: al.name, members, since: 0 }] : [];
  });

  const world: World = {
    version: 2,
    showName: p.showName.trim() || 'Wrestling Weekly',
    shortName: (p.shortName.trim() || p.showName.trim()).slice(0, 6).toUpperCase(),
    direction,
    seed,
    crew: crewOf({ seed, crew: { pbp: p.commentators.playByPlay.trim(), color: p.commentators.color.trim() } }),
    episode: 0,
    characters,
    titles,
    feuds,
    alliances,
    notes: [],
    history: [],
    angleLog: [],
    storySoFar: p.storySoFar.trim(),
  };
  return { world, problems };
}

/** Hardcore promotions put weapons everywhere (the stage and bookers check this). */
export function isHardcore(direction: string): boolean {
  return /hardcore|extreme|ecw|garbage|deathmatch|violent|bloody/i.test(direction);
}
