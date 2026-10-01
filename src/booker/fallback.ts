// Offline booker: builds an episode from templates when the LLM is unavailable (no key,
// server down, bad output). Simpler than the LLM, but valid and varied enough to keep
// the screensaver running forever.
import { hashSeed, Rng } from '../engine/rng';
import type { Beat, BeatOf, Episode, Finish, Segment, Spot, StateChange, Stipulation, Story } from '../schema/episode';
import type { SeasonStart } from '../schema/season';
import { isHardcore } from '../world/genesis';
import { applySeasonStart, isPPV, isSeasonStart, offlinePlan, offlineTransition, seasonOf } from '../world/season';
import {
  alliesOf, type Character, charById, interviewer, titleHeldBy, type World, wrestlers,
} from '../world/state';

const short = (c: Character) => c.name.replace(/"[^"]*"\s*/g, '').trim();
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w)\}/g, (m, k: string) => v[k] ?? m);

const HEEL_LINES = [
  '{R}, you are nothing but a washed-up has-been!',
  'Everybody in this building knows I\'m the greatest! Everybody except {R}!',
  'Next week, I\'m going to take {R} apart piece by piece!',
  'These people cheer for {R} because they\'re just like {R}: LOSERS!',
  'I didn\'t cheat! I outsmarted {R}! There\'s a difference!',
  'When I\'m done with you, {R}, your own mother won\'t recognize you!',
  'Look at me! LOOK AT ME! Do I look worried about {R}?',
  'I\'m too good-looking to lose to somebody like {R}!',
  'You people don\'t deserve a star like me!',
  '{R}, I\'ve forgotten more about wrestling than you\'ll ever know!',
];
const FACE_LINES = [
  '{R}, I\'ve been waiting a long time for this!',
  'You can run, {R}, but you can\'t hide!',
  'Every one of these fans deserves better than {R}!',
  'I\'m coming for you, {R}, and I\'m bringing all these people with me!',
  'You crossed the line, {R}. Now you\'re going to pay!',
  '{R}, you want a fight? You\'ve GOT one!',
  'I don\'t care how many cheap shots you take, {R}. I will NOT stay down!',
  'This one\'s for the fans, {R}!',
];
const TITLE_LINES = [
  'That {T} belongs around MY waist!',
  'I\'m taking that {T} and there\'s nothing you can do about it!',
  'The {T} deserves a real champion!',
];
const QUESTIONS = [
  '{G}, what\'s going through your mind after last week?',
  '{G}, everyone wants to know: what are your plans for {R}?',
  '{G}, you seem upset. Care to explain?',
  '{G}, a lot of people say {R} has your number. Your response?',
  '{G}, what do you have to say to {R}?',
];
const REVEALS = [
  'I\'M PREGNANT!',
  '{Y} is my long-lost brother!',
  'I\'ve been working for {Y} this whole time!',
  'I just bought 51 percent of this company!',
  'I have a twin, and it wasn\'t me in that match last week!',
  'I\'ve been secretly married to {Y} for three years!',
  'I know what you did in Tulsa, {Y}!',
  'The Baron\'s monocle is FAKE! And so is the accent!',
];
const REASONS = [
  '{A} stole {B}\'s spotlight on live TV.',
  '{A} insulted {B}\'s hometown.',
  '{A} cost {B} a big match.',
  '{A} ruined {B}\'s birthday celebration.',
  '{A} says {B} is past it.',
];
const MATCH_TITLES = ['Grudge Match', 'Showdown', 'Collision Course', 'Featured Bout', 'Special Attraction', 'Midcard Mayhem'];
const EPISODE_TITLES = [
  'Night of Betrayal', 'Collision Course', 'Blood and Glitter', 'The Reckoning', 'Saturday Night Stampede',
  'No Mercy in Motown', 'Chaos Theory', 'Thunder in the Arena', 'The Big Payback', 'Bad Blood Boulevard',
];

export function fallbackEpisode(world: World): Episode {
  const n = world.episode + 1;
  const rng = new Rng(hashSeed('fallback', world.seed, n));
  const hard = isHardcore(world.direction);
  const brand = (name: string) => name.replace(new RegExp(`^${world.shortName}\\s+`), '');
  const lance = interviewer(world);
  const men = wrestlers(world).filter((c) => c.division === 'men');
  const women = wrestlers(world).filter((c) => c.division === 'women');
  const used = new Set<string>();
  const segments: Segment[] = [];
  const recentTurns = world.angleLog.slice(-3).some((l) => l.kinds.some((k) => k.startsWith('turn')));

  const pickPair = (pool: Character[], prefer?: [string, string]): [Character, Character] | null => {
    if (prefer && !used.has(prefer[0]) && !used.has(prefer[1])) {
      const a = charById(world, prefer[0]);
      const b = charById(world, prefer[1]);
      if (a && b && a.role === 'wrestler' && b.role === 'wrestler' && a.division === b.division) return [a, b];
    }
    const free = rng.shuffle(pool.filter((c) => !used.has(c.id)));
    if (free.length < 2) return null;
    const a = free[0];
    const b = free.find((c) => c.alignment !== a.alignment) ?? free[1];
    return [a, b];
  };

  const lineFor = (c: Character, rival: Character): string => {
    const t = titleHeldBy(world, rival.id) ?? titleHeldBy(world, c.id);
    if (t && rng.chance(0.35)) return fill(rng.pick(TITLE_LINES), { T: brand(t.name) });
    return fill(rng.pick(c.alignment === 'heel' ? HEEL_LINES : FACE_LINES), { R: short(rival) });
  };

  const match = (a: Character, b: Character, opts: { main?: boolean } = {}): { beat: Beat; winner: Character | null; finish: Finish } => {
    used.add(a.id);
    used.add(b.id);
    const story: Story = rng.pick(opts.main ? ['comeback', 'back_and_forth', 'even', 'loser_dominates'] : ['even', 'squash', 'winner_dominates', 'back_and_forth']);
    const finish: Finish = rng.weighted(
      ['pin', 'cheat_pin', 'rollup', 'submission', 'dq', 'countout', 'no_contest'] as const,
      (f) => ({ pin: 5, cheat_pin: 1.5, rollup: 1.2, submission: 1, dq: (opts.main ? 2 : 0.6) * (hard ? 1.5 : 1), countout: hard ? 0.1 : 0.4, no_contest: (opts.main ? 1.2 : 0.2) * (hard ? 3 : 1) })[f],
    );
    let winner: Character | null = rng.chance(0.5) ? a : b;
    if (finish === 'cheat_pin') winner = a.alignment === 'heel' ? a : b.alignment === 'heel' ? b : a;
    if (finish === 'no_contest') winner = null;
    const loser = winner ? (winner === a ? b : a) : null;
    const spots: Spot[] = [];
    if (opts.main && loser) {
      const loserAllies = alliesOf(world, loser.id).filter((id) => !used.has(id));
      const winnerAllies = alliesOf(world, winner!.id).filter((id) => !used.has(id));
      if ((finish === 'dq' || finish === 'no_contest') && loserAllies.length) {
        spots.push({ phase: 'finish', type: 'run_in', who: rng.pick(loserAllies), target: winner!.id, lines: [] });
      } else if (finish === 'cheat_pin' && winnerAllies.length) {
        spots.push({ phase: 'late', type: 'distraction', who: rng.pick(winnerAllies), target: loser.id, lines: ['Hey ref! Over here!'] });
      } else if (rng.chance(0.3)) {
        spots.push({ phase: 'mid', type: 'ref_bump', who: a.id, target: 'none', lines: [] });
      }
    }
    // Hardcore crowds expect furniture: the wrestlers bring their own weapons.
    if (hard && winner && rng.chance(opts.main ? 0.7 : 0.4)) {
      spots.push({ phase: rng.pick(['mid', 'late'] as const), type: 'weapon', who: rng.pick([a, b]).id, target: 'none', lines: [] });
    }
    const holder = [a, b].map((c) => titleHeldBy(world, c.id)).find((t) => t && t.division === a.division);
    const titleOnLine = opts.main && holder && rng.chance(0.6) ? holder.id : 'none';
    return {
      beat: {
        type: 'match', stipulation: 'singles', wrestlers: [a.id, b.id], winner: winner?.id ?? 'none', finish, story,
        length: opts.main ? rng.pick(['medium', 'long'] as const) : rng.pick(['short', 'medium'] as const),
        titleOnLine, spots, moments: [],
      },
      winner,
      finish,
    };
  };

  const resultText = (a: Character, b: Character, winner: Character | null, finish: Finish) =>
    winner ? `${short(winner)} def. ${short(winner === a ? b : a)} by ${finish.replace('_', ' ')}.` : `${short(a)} vs ${short(b)} ended in chaos.`;

  // --- 1. Opener
  const opener = pickPair(men);
  if (opener) {
    const [a, b] = opener;
    const m = match(a, b);
    segments.push({
      title: `Opening Contest: ${short(a)} vs. ${short(b)}`,
      beats: [m.beat],
      stateChanges: [],
      recap: resultText(a, b, m.winner, m.finish),
    });
  }

  // --- 2. Feud interview (with a possible interruption)
  const feud = world.feuds.length ? rng.pick(world.feuds) : null;
  const stateChanges: StateChange[] = [];
  let mainPair: [string, string] | undefined;
  if (feud) {
    mainPair = [feud.a, feud.b];
  } else {
    const p = pickPair(men.filter((c) => !used.has(c.id)));
    if (p) {
      mainPair = [p[0].id, p[1].id];
      stateChanges.push({
        type: 'feud_start', a: p[0].id, b: p[1].id,
        reason: fill(rng.pick(REASONS), { A: short(p[0]), B: short(p[1]) }),
      });
    }
  }
  if (mainPair) {
    const g = charById(world, rng.pick(mainPair))!;
    const r = charById(world, mainPair[0] === g.id ? mainPair[1] : mainPair[0])!;
    const exchange = [
      { speaker: lance.id, text: fill(rng.pick(QUESTIONS), { G: short(g), R: short(r) }) },
      { speaker: g.id, text: lineFor(g, r) },
      { speaker: g.id, text: lineFor(g, r) },
    ];
    const beats: Beat[] = [{ type: 'interview', guest: g.id, exchange }];
    let recap = `${short(g)} ran down ${short(r)} in an interview.`;
    if (rng.chance(0.55)) {
      beats.push({
        type: 'confrontation', a: g.id, b: r.id, where: 'podium',
        exchange: [{ speaker: r.id, text: lineFor(r, g) }, { speaker: g.id, text: lineFor(g, r) }],
        escalation: rng.pick(['stare_down', 'shove', 'slap', 'brawl', 'separated'] as const),
      });
      recap = `${short(r)} interrupted ${short(g)}'s interview and things got heated.`;
    }
    segments.push({ title: `${short(g)} Speaks`, beats, stateChanges, recap });
  }

  // --- 3. Women's match or a squash
  const wp = pickPair(women);
  if (wp && rng.chance(0.7)) {
    const [a, b] = wp;
    const m = match(a, b);
    segments.push({ title: `Women's Action: ${short(a)} vs. ${short(b)}`, beats: [m.beat], stateChanges: [], recap: resultText(a, b, m.winner, m.finish) });
  } else {
    const p = pickPair(men.filter((c) => !mainPair?.includes(c.id)));
    if (p) {
      const [a, b] = p;
      const m = match(a, b);
      segments.push({ title: rng.pick(MATCH_TITLES), beats: [m.beat], stateChanges: [], recap: resultText(a, b, m.winner, m.finish) });
    }
  }

  // --- 4. Angle
  const angle = rng.weighted(['attack', 'reveal', 'promo', 'turn'] as const, (k) =>
    k === 'turn' ? (recentTurns ? 0 : 0.6) : k === 'reveal' ? 1 : k === 'attack' ? 1.4 : 1.2,
  );
  const everyone = world.characters.filter((c) => c.role !== 'interviewer');
  if (angle === 'attack') {
    const heels = everyone.filter((c) => c.alignment === 'heel' && c.role === 'wrestler');
    const faces = everyone.filter((c) => c.alignment === 'face' && c.role === 'wrestler' && !used.has(c.id));
    if (heels.length && faces.length) {
      const h = rng.pick(heels);
      const f = rng.pick(faces);
      segments.push({
        title: `${short(f)} Addresses the Fans`,
        beats: [
          { type: 'promo', who: f.id, where: 'ring', mood: 'excited', lines: [lineFor(f, h), 'Thank you all for the support!'] },
          { type: 'attack', attackers: [h.id, ...alliesOf(world, h.id).filter((id) => charById(world, id)?.alignment === 'heel').slice(0, 1)], victim: f.id, where: 'ring', style: rng.pick(['from_behind', 'beatdown', 'weapon'] as const) },
          { type: 'narrate', text: rng.pick(['Somebody get some help out here!', 'This is a disgrace!', 'Why won\'t anybody help?']), style: 'shock', speaker: 'pbp' },
        ],
        stateChanges: rng.chance(0.5) ? [{ type: 'feud_start', a: f.id, b: h.id, reason: `${short(h)} ambushed ${short(f)} during a promo.` }] : [],
        recap: `${short(h)} ambushed ${short(f)} in the middle of a promo.`,
      });
    }
  } else if (angle === 'reveal') {
    const who = rng.pick(everyone.filter((c) => c.role !== 'wrestler' || rng.chance(0.3)));
    const y = rng.pick(everyone.filter((c) => c.id !== who.id));
    const text = fill(rng.pick(REVEALS), { Y: short(y) });
    segments.push({
      title: 'A Shocking Announcement',
      beats: [
        { type: 'promo', who: who.id, where: 'ring', mood: 'excited', lines: ['I have something to get off my chest.', 'Something nobody in this building knows...'] },
        { type: 'reveal', who: who.id, line: text, reactions: [{ who: y.id, reaction: rng.pick(['shock', 'disbelief', 'faint', 'anger'] as const) }] },
        { type: 'narrate', text: rng.pick(['I did not see that coming!', 'This changes everything!', 'Fans, I am speechless!']), style: 'shock', speaker: 'pbp' },
      ],
      stateChanges: [{ type: 'storyline_note', text: `${short(who)} revealed: "${text}"` }],
      recap: `${short(who)} revealed: "${text}"`,
    });
    // Bring the other person out to react on the spot.
    segments[segments.length - 1].beats.splice(1, 0, {
      type: 'interrupt', who: y.id, where: 'aisle', lines: ['What are you talking about?!'], then: 'stays', target: 'none',
    });
  } else if (angle === 'turn') {
    const pairs = world.alliances.filter((a) => a.members.length >= 2);
    const al = pairs.length ? rng.pick(pairs) : null;
    if (al) {
      const [x, y] = rng.shuffle(al.members).map((id) => charById(world, id)!).filter(Boolean);
      if (x && y) {
        const newAlign = x.alignment === 'heel' ? 'face' : 'heel';
        segments.push({
          title: `${al.name}: United?`,
          beats: [
            { type: 'promo', who: y.id, where: 'ring', mood: 'excited', lines: [`${short(x)} and I are stronger than ever!`, `Come on out here, partner!`] },
            { type: 'entrance', who: x.id, mood: 'calm', escorts: [] },
            { type: 'turn', who: x.id, newAlignment: newAlign, how: 'attacks_partner', target: y.id },
            { type: 'promo', who: x.id, where: 'ring', mood: 'menacing', lines: [`I carried you for YEARS, ${short(y)}!`, 'I\'m done being your sidekick!'] },
          ],
          stateChanges: [
            { type: 'alliance_break', name: al.name },
            { type: 'feud_start', a: x.id, b: y.id, reason: `${short(x)} betrayed ${short(y)}.` },
          ],
          recap: `${short(x)} turned on partner ${short(y)}!`,
        });
      }
    }
  } else {
    const c = rng.pick(everyone.filter((ch) => ch.role === 'wrestler'));
    const r = rng.pick(everyone.filter((ch) => ch.role === 'wrestler' && ch.id !== c.id && ch.division === c.division));
    segments.push({
      title: `${short(c)} Has Something to Say`,
      beats: [
        { type: 'promo', who: c.id, where: rng.pick(['ring', 'stage', 'aisle'] as const), mood: c.alignment === 'heel' ? 'cocky' : 'angry', lines: [lineFor(c, r), lineFor(c, r)] },
        { type: 'interrupt', who: r.id, where: 'stage', lines: [lineFor(r, c)], then: rng.pick(['stays', 'walks_to_ring', 'leaves'] as const), target: 'none' },
      ],
      stateChanges: [],
      recap: `${short(r)} interrupted ${short(c)}'s promo.`,
    });
  }

  const ppv = isPPV(n);

  // --- 4b. Tag team match between two alliances (weekly TV)
  const pairs = world.alliances
    .map((al) => al.members.map((id) => charById(world, id)!).filter((c) => c?.role === 'wrestler' && c.division === 'men' && !used.has(c.id)))
    .filter((t) => t.length >= 2)
    .map((t) => t.slice(0, 2));
  if (!ppv && pairs.length >= 2 && rng.chance(0.4)) {
    const [t1, t2] = rng.shuffle(pairs).slice(0, 2);
    if (!t1.some((c) => t2.includes(c)) && !t1.concat(t2).some((c) => mainPair?.includes(c.id))) {
      t1.concat(t2).forEach((c) => used.add(c.id));
      const winner = rng.pick([...t1, ...t2]);
      segments.push({
        title: `Tag Team Action: ${short(t1[0])} & ${short(t1[1])} vs. ${short(t2[0])} & ${short(t2[1])}`,
        beats: [{
          type: 'match', stipulation: 'tag', wrestlers: [...t1, ...t2].map((c) => c.id), winner: winner.id,
          finish: rng.pick(['pin', 'pin', 'rollup', 'dq'] as const), story: 'back_and_forth', length: 'medium', titleOnLine: 'none', spots: [], moments: [],
        }],
        stateChanges: [],
        recap: `${short(winner)}'s team won the tag match.`,
      });
    }
  }

  // --- 4c. Battle royal on PPV nights: pushes someone into title contention
  const field = rng.shuffle(men.filter((c) => !used.has(c.id) && !mainPair?.includes(c.id))).slice(0, rng.int(6, 8));
  if (ppv && field.length >= 5) {
    field.forEach((c) => used.add(c.id));
    const winner = rng.pick(field);
    segments.push({
      title: 'Battle Royal',
      beats: [{
        type: 'match', stipulation: 'battle_royal', wrestlers: field.map((c) => c.id), winner: winner.id,
        finish: 'elimination', story: 'even', length: 'medium', titleOnLine: 'none', spots: [], moments: [],
      }],
      stateChanges: [{ type: 'storyline_note', text: `${short(winner)} won a battle royal and earned a title shot.` }],
      recap: `${short(winner)} won the battle royal.`,
    });
  }

  // --- 5. Main event (PPVs often settle it in a cage or a ladder match)
  const mp = pickPair(men, mainPair);
  if (mp) {
    const [a, b] = mp;
    const m = match(a, b, { main: true });
    const mb = m.beat as BeatOf<'match'>;
    if (ppv && rng.chance(0.6)) {
      mb.stipulation = rng.pick(['cage', 'ladder'] as const);
      mb.spots = [];
      if (!m.winner) {
        m.winner = a;
        mb.winner = a.id;
      }
      mb.finish = mb.stipulation === 'ladder' ? 'retrieve' : rng.chance(0.5) ? 'escape' : 'pin';
      m.finish = mb.finish;
    }
    const beats: Beat[] = [m.beat];
    const changes: StateChange[] = [];
    if (m.winner && (m.finish === 'dq' || m.finish === 'no_contest' || m.finish === 'cheat_pin')) {
      const loser = m.winner === a ? b : a;
      beats.push({ type: 'promo', who: loser.id, where: 'ring', mood: 'furious', lines: [lineFor(loser, m.winner), 'This is NOT over!'] });
    } else if (m.winner && rng.chance(0.3)) {
      beats.push({ type: 'celebrate', who: [m.winner.id] });
      if (feud && rng.chance(0.4)) changes.push({ type: 'feud_end', a: feud.a, b: feud.b });
    }
    segments.push({ title: `Main Event: ${short(a)} vs. ${short(b)}`, beats, stateChanges: changes, recap: resultText(a, b, m.winner, m.finish) });
  }

  const champs = world.titles.map((t) => `${brand(t.name)}: ${t.holder ? short(charById(world, t.holder)!) : 'vacant'}`);
  return {
    title: rng.pick(EPISODE_TITLES),
    storySoFar: `${world.storySoFar.split('. ').slice(0, 3).join('. ')}. Champions — ${champs.join('; ')}.`.slice(0, 900),
    debuts: [],
    segments,
  };
}

/**
 * Offline booking with the season calendar: on a season's first episode it runs an
 * offline off-season shuffle and plan, then books on the new roster.
 */
export function offlineBook(world: World): Episode {
  const n = world.episode + 1;
  if (!isSeasonStart(n)) return fallbackEpisode(world);
  const season = seasonOf(n);
  const seasonStart: SeasonStart = {
    season,
    transition: season > 1 ? offlineTransition(world, season) : null,
    plan: offlinePlan(season),
  };
  return { ...fallbackEpisode(applySeasonStart(world, seasonStart)), seasonStart };
}

/** Dev/demo: a one-match episode showing off a stipulation (`?demo=cage|ladder|tag|royal`). */
export function demoEpisode(world: World, kind: string): Episode {
  const rng = new Rng(hashSeed('demo', world.seed, kind));
  const men = rng.shuffle(wrestlers(world).filter((c) => c.division === 'men'));
  const kinds: Record<string, Stipulation> = { cage: 'cage', ladder: 'ladder', tag: 'tag', royal: 'battle_royal' };
  const stipulation: Stipulation = kinds[kind] ?? 'singles';
  const size = stipulation === 'tag' ? 4 : stipulation === 'battle_royal' ? Math.min(8, men.length) : 2;
  const field = men.slice(0, size);
  const finish = ({ cage: 'escape', ladder: 'retrieve', battle_royal: 'elimination', tag: 'pin', singles: 'pin' } as const)[stipulation];
  const winner = rng.pick(field);
  return {
    title: `Demo: ${stipulation.replace('_', ' ')}`,
    storySoFar: world.storySoFar,
    debuts: [],
    segments: [{
      title: `${stipulation.replace('_', ' ').toUpperCase()} DEMO`,
      beats: [{
        type: 'match', stipulation, wrestlers: field.map((c) => c.id), winner: winner.id, finish,
        story: 'back_and_forth', length: 'short', titleOnLine: 'none', spots: [], moments: [],
      }],
      stateChanges: [],
      recap: 'Demo match.',
    }],
  };
}
