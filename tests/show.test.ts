import { describe, expect, it } from 'vitest';
import { fallbackEpisode } from '../src/booker/fallback';
import { reviewEpisode } from '../src/booker/validate';
import { duration } from '../src/engine/anim';
import { arena } from '../src/engine/arena';
import type { EngineEvent } from '../src/engine/events';
import { isPoseKey } from '../src/engine/poses';
import { Stage } from '../src/engine/stage';
import { Episode, type Finish, type Story } from '../src/schema/episode';
import { MatchSim } from '../src/sim/match';
import { MOVES } from '../src/sim/moves';
import { prepareStage } from '../src/show/runner';
import { applyEpisode, titleOutcome } from '../src/world/apply';
import { offlineWorld, randomPromotion, reviewPromotion } from '../src/world/genesis';
import { classicWorld, type World } from '../src/world/state';

function playEpisode(world: World, ep: Episode): { events: EngineEvent[]; after: World } {
  const stage = new Stage(0);
  const { director, after } = prepareStage(stage, world, ep);
  const events: EngineEvent[] = [];
  stage.on((e) => events.push(e));
  stage.runToEnd(director.play());
  // Nobody ever hits themselves.
  for (const e of events) if (e.type === 'moveStarted') expect(e.att, `${e.move}`).not.toBe(e.def);
  return { events, after };
}

function matchEpisode(winner: string, finish: Finish, titleOnLine = 'none'): Episode {
  return {
    title: 'Test', storySoFar: '', debuts: [],
    segments: [1, 2, 3].map((i) => ({
      title: `Seg ${i}`, stateChanges: [], recap: `r${i}`,
      beats: i === 3
        ? [{ type: 'match', stipulation: 'singles', wrestlers: ['rex', 'vega'], winner, finish, story: 'even', length: 'short', titleOnLine, spots: [], moments: [] }]
        : [{ type: 'narrate', text: 'Hello', style: 'call', speaker: 'pbp' }],
    })),
  };
}

describe('schema and validation', () => {
  it('rejects malformed booker output', () => {
    expect(Episode.safeParse({ title: 'x' }).success).toBe(false);
    const r = reviewEpisode({ segments: 'nope' }, classicWorld());
    expect(r.episode).toBeNull();
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('flags and fixes a winner who is not in the match', () => {
    const r = reviewEpisode(matchEpisode('earl', 'pin'), classicWorld());
    expect(r.problems.some((p) => p.includes('winner'))).toBe(true);
    const m = r.episode!.segments[2].beats[0];
    expect(m.type === 'match' && m.winner).toBe('rex');
  });

  it('drops unknown characters and a second turn', () => {
    const ep = matchEpisode('rex', 'pin');
    ep.segments[0].beats.push(
      { type: 'promo', who: 'nobody', where: 'ring', mood: 'calm', lines: ['hi'] },
      { type: 'turn', who: 'rex', newAlignment: 'heel', how: 'walks_out', target: 'none' },
      { type: 'turn', who: 'earl', newAlignment: 'heel', how: 'walks_out', target: 'none' },
    );
    const r = reviewEpisode(ep, classicWorld());
    const beats = r.episode!.segments[0].beats.map((b) => b.type);
    expect(beats).toEqual(['narrate', 'turn']);
    expect(r.problems.some((p) => p.includes('unknown character'))).toBe(true);
    expect(r.problems.some((p) => p.includes('one turn'))).toBe(true);
  });

  it('allows mixed matches but keeps titles within their division', () => {
    const ep = matchEpisode('rex', 'pin', 'world');
    const m = ep.segments[2].beats[0];
    if (m.type === 'match') m.wrestlers = ['rex', 'viper'];
    const r = reviewEpisode(ep, classicWorld());
    const kept = r.episode!.segments[2].beats[0];
    expect(kept.type === 'match' && kept.titleOnLine).toBe('none');
    expect(r.problems.some((p) => p.includes('division'))).toBe(true);
  });

  it('resolves names used in place of ids', () => {
    const ep = matchEpisode('Rex Tolliver', 'pin');
    ep.segments[0].beats.push({ type: 'interview', guest: 'Slick Vic Vega', exchange: [{ speaker: 'Lance Holloway', text: 'Hi' }] });
    const m = ep.segments[2].beats[0];
    if (m.type === 'match') m.wrestlers = ['rex_tolliver', 'vega'];
    const r = reviewEpisode(ep, classicWorld());
    expect(r.problems).toEqual([]);
    const iv = r.episode!.segments[0].beats[1];
    expect(iv.type === 'interview' && [iv.guest, iv.exchange[0].speaker]).toEqual(['vega', 'lance']);
    const kept = r.episode!.segments[2].beats[0];
    expect(kept.type === 'match' && [kept.wrestlers, kept.winner]).toEqual([['rex', 'vega'], 'rex']);
  });

  it('fallback episodes are always valid', () => {
    let w = classicWorld();
    for (let i = 0; i < 25; i++) {
      const ep = fallbackEpisode(w);
      const r = reviewEpisode(ep, w);
      expect(r.problems).toEqual([]);
      w = applyEpisode(w, r.episode!);
    }
  });
});

describe('world state', () => {
  it('applies turns, feuds and title changes', () => {
    const w = classicWorld();
    const ep = matchEpisode('rex', 'pin', 'world');
    ep.segments[0].beats.push({ type: 'turn', who: 'earl', newAlignment: 'heel', how: 'walks_out', target: 'none' });
    ep.segments[1].stateChanges.push({ type: 'feud_start', a: 'kaos', b: 'lightning', reason: 'x' });
    const after = applyEpisode(w, ep);
    expect(after.episode).toBe(1);
    expect(after.characters.find((c) => c.id === 'earl')!.alignment).toBe('heel');
    expect(after.titles.find((t) => t.id === 'world')!.holder).toBe('rex');
    expect(after.feuds.some((f) => f.a === 'kaos' && f.b === 'lightning')).toBe(true);
    expect(after.history).toHaveLength(3);
    expect(w.episode).toBe(0); // input untouched
  });

  it('protects champions on dq and countout', () => {
    expect(titleOutcome('vega', 'rex', 'dq')).toBe('protected');
    expect(titleOutcome('vega', 'rex', 'countout')).toBe('protected');
    expect(titleOutcome('vega', 'rex', 'rollup')).toBe('new_champion');
    expect(titleOutcome('vega', 'vega', 'pin')).toBe('retain');
    const after = applyEpisode(classicWorld(), matchEpisode('rex', 'dq', 'world'));
    expect(after.titles.find((t) => t.id === 'world')!.holder).toBe('vega');
  });
});

describe('moves', () => {
  it('every keyframe uses the 3-part pose vocabulary', () => {
    for (const m of MOVES) {
      expect(m.keys.length, m.id).toBeGreaterThan(0);
      expect(duration(m.keys), m.id).toBeGreaterThan(0);
      for (const k of m.keys) {
        if (k.att) expect(isPoseKey(k.att), `${m.id} att @${k.t}`).toBe(true);
        if (k.def) expect(isPoseKey(k.def), `${m.id} def @${k.t}`).toBe(true);
      }
      const ts = m.keys.map((k) => k.t);
      expect([...ts].sort((a, b) => a - b), m.id).toEqual(ts);
    }
  });
});

describe('match sim', () => {
  const finishes: Finish[] = ['pin', 'rollup', 'cheat_pin', 'submission', 'dq', 'countout', 'no_contest'];
  const stories: Story[] = ['even', 'winner_dominates', 'loser_dominates', 'comeback', 'squash', 'back_and_forth'];

  it('always reaches the booked winner and finish', () => {
    let seed = 1;
    for (const finish of finishes) {
      for (const story of stories) {
        const stage = new Stage(seed++);
        stage.setCast(classicWorld());
        const [a, b] = [stage.actor('rex'), stage.actor('vega')];
        stage.appear(a, arena.ringSpots[0]);
        stage.appear(b, arena.ringSpots[1]);
        stage.appear(stage.ref, arena.refSpot);
        const winner = finish === 'no_contest' ? 'none' : seed % 2 ? 'rex' : 'vega';
        const sim = new MatchSim(stage, { wrestlers: ['rex', 'vega'], winner, finish, story, length: 'short', spots: [] }, function* () {});
        stage.runToEnd(sim.run(), 600);
        expect(sim.result, `${finish}/${story}`).toEqual({
          winner: winner === 'none' ? null : winner,
          loser: winner === 'none' ? null : winner === 'rex' ? 'vega' : 'rex',
          finish,
        });
      }
    }
  });
});

describe('full show', () => {
  it('is deterministic: same episode, same events', () => {
    const w = classicWorld();
    const ep = fallbackEpisode(w);
    const one = playEpisode(w, ep).events;
    const two = playEpisode(w, ep).events;
    expect(one.length).toBeGreaterThan(100);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('plays many booked episodes end to end, carrying state forward', () => {
    let w = classicWorld();
    for (let i = 0; i < 8; i++) {
      const ep = reviewEpisode(fallbackEpisode(w), w).episode!;
      const { events, after } = playEpisode(w, ep);
      expect(events.at(-1)!.type).toBe('episodeEnd');
      const results = events.filter((e) => e.type === 'matchEnd');
      const booked = ep.segments.flatMap((s) => s.beats).filter((b) => b.type === 'match');
      expect(results).toHaveLength(booked.length);
      w = after;
    }
    expect(w.episode).toBe(8);
  });

  it('stages every beat type, including in-match spots', () => {
    const w = classicWorld();
    const ep: Episode = {
      title: 'Everything', storySoFar: 'x', debuts: [{
        id: 'masked_x', name: 'Masked X', role: 'wrestler', alignment: 'heel', division: 'men', style: 'brawler',
        gimmick: 'mystery', entrance: 'in silence', finisherName: 'X Driver', finisherMove: 'piledriver',
        hometown: 'Parts Unknown', weight: 301, catchphrase: 'X marks the spot!',
        finisherDescription: 'a piledriver from a standing switch', finisherCall: 'He is setting up the X Driver!',
      }],
      segments: [
        { title: 'A', stateChanges: [], recap: 'a', beats: [
          { type: 'entrance', who: 'vega', mood: 'cocky', escorts: ['debbie'] },
          { type: 'promo', who: 'vega', where: 'ring', mood: 'smug', lines: ['I am the champ!'] },
          { type: 'interrupt', who: 'rex', where: 'stage', lines: ['Not for long!'], then: 'walks_to_ring', target: 'none' },
          { type: 'confrontation', a: 'rex', b: 'vega', where: 'ring', exchange: [{ speaker: 'vega', text: 'Back off!' }], escalation: 'brawl' },
          { type: 'run_in', who: 'clint', target: 'rex', intent: 'save' },
        ] },
        { title: 'B', stateChanges: [], recap: 'b', beats: [
          { type: 'interview', guest: 'earl', exchange: [{ speaker: 'lance', text: 'Earl?' }, { speaker: 'earl', text: 'BBQ!' }, { speaker: 'maddog', text: 'Woof!' }] },
          { type: 'attack', attackers: ['maddog'], victim: 'earl', where: 'podium', style: 'weapon' },
          { type: 'reveal', who: 'debbie', line: 'I love Rex!', reactions: [{ who: 'lance', reaction: 'faint' }] },
        ] },
        { title: 'C', stateChanges: [], recap: 'c', beats: [
          { type: 'match', stipulation: 'singles', wrestlers: ['masked_x', 'lightning'], winner: 'masked_x', finish: 'dq', story: 'comeback', length: 'short', titleOnLine: 'tv', spots: [
            { phase: 'early', type: 'distraction', who: 'pemberton', target: 'lightning', lines: ['Referee!'] },
            { phase: 'mid', type: 'ref_bump', who: 'lightning', target: 'none', lines: [] },
            { phase: 'late', type: 'interrupt', who: 'kaos', target: 'lightning', lines: ['Hey!'] },
            { phase: 'finish', type: 'run_in', who: 'bane', target: 'masked_x', lines: [] },
          ], moments: [
            { phase: 'early', speaker: 'pbp', line: 'Masked X is a mystery to everyone here!' },
            { phase: 'mid', speaker: 'masked_x', line: 'You cannot stop what you cannot see!' },
            { phase: 'late', speaker: 'color', line: 'Pemberton has this all figured out.' },
            { phase: 'after', speaker: 'lightning', line: 'This is NOT over!' },
          ] },
          { type: 'turn', who: 'clint', newAlignment: 'heel', how: 'attacks_partner', target: 'rex' },
          { type: 'celebrate', who: ['clint'] },
          { type: 'exit', who: ['clint', 'rex'], how: 'storm_off' },
          { type: 'narrate', text: 'Unbelievable!', style: 'shock', speaker: 'color' },
        ] },
      ],
    };
    const r = reviewEpisode(ep, w);
    expect(r.problems).toEqual([]);
    const { events, after } = playEpisode(w, r.episode!);
    const types = new Set(events.map((e) => e.type));
    for (const t of ['music', 'said', 'moveImpact', 'bell', 'matchEnd', 'alignmentChanged', 'episodeEnd']) {
      expect(types.has(t as EngineEvent['type']), t).toBe(true);
    }
    // Booked storyline lines are all spoken, by the right speakers.
    const said = events.filter((e) => e.type === 'said').map((e) => `${e.who}: ${e.text}`);
    const narrated = events.filter((e) => e.type === 'narrated').map((e) => e.text);
    expect(narrated).toContain('Masked X is a mystery to everyone here!');
    expect(said).toContain('masked_x: You cannot stop what you cannot see!');
    expect(said).toContain('_color: Pemberton has this all figured out.');
    expect(said).toContain('lightning: This is NOT over!');
    expect(said).toContain('_color: Unbelievable!');
    expect(after.characters.find((c) => c.id === 'masked_x')?.catchphrase).toBe('X marks the spot!');
    expect(after.characters.find((c) => c.id === 'masked_x')).toBeTruthy();
    expect(after.characters.find((c) => c.id === 'clint')!.alignment).toBe('heel');
  });
});

describe('new promotions', () => {
  it('offline worlds are fresh per seed and always playable', () => {
    const names = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const w = offlineWorld(seed, seed % 2 ? 'ECW-style hardcore' : '');
      names.add(w.characters.filter((c) => c.role === 'wrestler').map((c) => c.name).sort().join());
      const r = reviewEpisode(fallbackEpisode(w), w);
      expect(r.problems, `seed ${seed}`).toEqual([]);
      if (seed <= 12) {
        const { events } = playEpisode(w, r.episode!);
        expect(events.at(-1)!.type).toBe('episodeEnd');
      }
    }
    expect(names.size).toBe(30);
  });

  it('sanitizes a sloppy LLM promotion', () => {
    const p = randomPromotion(7);
    p.characters[0].id = 'Bad Id!';
    p.characters[1].finisherMove = 'not_a_move';
    p.titles[0].holder = 'nobody';
    const r = reviewPromotion(p, 'x', 7);
    expect(r.world).not.toBeNull();
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
    const w = r.world!;
    expect(w.characters.every((c) => /^[a-z][a-z0-9_]*$/.test(c.id))).toBe(true);
    expect(w.characters.find((c) => c.id === w.titles[0].holder)?.role).toBe('wrestler');
    expect(w.direction).toBe('x');
  });
});

describe('lenient parsing (no paid retries for fixable output)', () => {
  it('accepts a promotion whose managers omit entrance and finisher', () => {
    const p = randomPromotion(3) as unknown as { characters: Record<string, unknown>[] };
    for (const c of p.characters) {
      if (c.role !== 'wrestler') {
        delete c.entrance;
        delete c.finisherName;
        delete c.finisherMove;
      }
    }
    const r = reviewPromotion(p, '', 3);
    expect(r.world).not.toBeNull();
    expect(r.problems).toEqual([]);
  });

  it('decodes stringified beats and repairs missing optional fields', async () => {
    const w = classicWorld();
    const beats = [
      { type: 'segment', title: 'Open', recap: 'r' },
      { type: 'promo', who: 'vega', lines: ['I am the man!'] }, // no where/mood
      { type: 'segment', title: 'Mid', recap: 'r' },
      { type: 'match', wrestlers: ['rex', 'earl'], winner: 'rex', finish: 'pinfall!!' }, // bad enum, missing fields
      { type: 'teleport', who: 'rex' }, // unknown beat type: dropped alone
      { type: 'segment', title: 'Main', recap: 'r' },
      { type: 'match', wrestlers: ['vega', 'lightning'], winner: 'vega', finish: 'dq', story: 'even', length: 'short', titleOnLine: 'none', spots: [{ type: 'bogus' }] },
    ];
    const r = reviewEpisode({ title: 'Episode 7: Chaos', storySoFar: 's', beats: JSON.stringify(beats) }, w);
    expect(r.episode).not.toBeNull();
    const ep = r.episode!;
    expect(ep.title).toBe('Chaos');
    const { cleanTitle } = await import('../src/booker/validate');
    expect(cleanTitle('Dixie Mat Wrestling - Episode #1: The Hammer Holds Fast', 'Dixie Mat Wrestling')).toBe('The Hammer Holds Fast');
    expect(cleanTitle('Dixie Mat Wrestling: Night of Fury', 'Dixie Mat Wrestling')).toBe('Night of Fury');
    expect(cleanTitle('Ep. 12 - Payback', 'X')).toBe('Payback');
    expect(cleanTitle('The Hammer Holds Fast', 'X')).toBe('The Hammer Holds Fast');
    expect(cleanTitle('"The Comeback"', 'X')).toBe('The Comeback');
    expect(cleanTitle('Line in the Sand" PAY-PER-VIEW', 'X')).toBe('Line in the Sand');
    expect(cleanTitle('#6 — "The Clock Ticks', 'X')).toBe('The Clock Ticks');
    expect(cleanTitle('The Last Gambit" (GO-HOME TO JUDGMENT NIGHT)', 'X')).toBe('The Last Gambit');
    expect(cleanTitle('Episode #10', 'X')).toBe('');
    expect(cleanTitle('WARZONE: The Last Stand', 'X')).toBe('WARZONE: The Last Stand');
    expect(cleanTitle('Season 1, Episode 4: Heat', 'X')).toBe('Heat');
    const { parseLoose } = await import('../src/booker/json');
    expect(parseLoose('[\n  {\n    "name": "Dusty "The Tornado" Mercer",\n    "id": "dusty"\n  }\n]')).toEqual([{ name: 'Dusty "The Tornado" Mercer', id: 'dusty' }]);
    // A stray brace in a stringified list costs nothing but the broken spot.
    expect(parseLoose('[{"type":"a","x":"}"},{"type":"b"}},{"type":"c"}]')).toEqual([{ type: 'a', x: '}' }, { type: 'b' }, { type: 'c' }]);
    expect(ep.segments.map((s) => s.beats.length)).toEqual([1, 1, 1]);
    const promo = ep.segments[0].beats[0];
    expect(promo.type === 'promo' && [promo.where, promo.mood]).toEqual(['ring', 'calm']);
    const m = ep.segments[1].beats[0];
    expect(m.type === 'match' && [m.finish, m.story, m.spots]).toEqual(['pin', 'even', []]);
    expect(r.problems.some((p) => p.includes('teleport'))).toBe(true);
  });
});

describe('name coloring', () => {
  it('colors full, plain and unique partial names, but not common words', async () => {
    const { NameIndex } = await import('../src/view/names');
    const stage = new Stage(1);
    const w = classicWorld();
    stage.setCast(w);
    const idx = new NameIndex(stage);
    const colored = (text: string) => idx.runs(text).filter((r) => r.color).map((r) => r.text);
    expect(colored('Rex Tolliver hits Vega with a chop! The crowd loves Rex!')).toEqual(['Rex Tolliver', 'Vega', 'Rex']);
    expect(colored('"SLICK" VIC VEGA IS YOUR WINNER')).toEqual(['"SLICK" VIC VEGA']);
    expect(colored('The king of the ring')).toEqual([]);
    expect(colored("Vega's belt")).toEqual(['Vega']);
  });
});

describe('character colors', () => {
  it('keeps every pair of wrestlers visually distinct', async () => {
    const { colorDistance } = await import('../src/engine/colors');
    for (let seed = 1; seed < 40; seed++) {
      const cs = offlineWorld(seed).characters.filter((c) => c.role === 'wrestler').map((c) => c.color);
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) expect(colorDistance(cs[i], cs[j]), `seed ${seed}`).toBeGreaterThan(95);
      }
    }
  });
});

describe('ring vs. floor', () => {
  it('only pins in the ring, and only uses floor moves on the floor', async () => {
    const { move: moveById } = await import('../src/sim/moves');
    let floorMoves = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const stage = new Stage(seed);
      stage.setCast(classicWorld());
      const [a, b] = [stage.actor('rex'), stage.actor('vega')];
      stage.appear(a, arena.ringSpots[0]);
      stage.appear(b, arena.ringSpots[1]);
      stage.appear(stage.ref, arena.refSpot);
      stage.on((e) => {
        if (e.type === 'pinCount') expect(a.inRing && b.inRing, `seed ${seed}: pin on the floor`).toBe(true);
        if (e.type === 'moveStarted') {
          const kind = moveById(e.move).kind;
          const att = stage.actor(e.att);
          const def = stage.actor(e.def);
          if (kind === 'outside') {
            floorMoves++;
            expect(!att.inRing && !def.inRing, `seed ${seed}: ${e.move} in the ring`).toBe(true);
          }
          if (kind === 'aerial' || kind === 'submission' || kind === 'pin') {
            expect(att.inRing && def.inRing, `seed ${seed}: ${e.move} on the floor`).toBe(true);
          }
        }
      });
      const finish = (['pin', 'rollup', 'submission', 'dq', 'cheat_pin'] as const)[seed % 5];
      const sim = new MatchSim(stage, { wrestlers: ['rex', 'vega'], winner: seed % 2 ? 'rex' : 'vega', finish, story: 'back_and_forth', length: 'long', spots: [] }, function* () {});
      stage.runToEnd(sim.run(), 900);
    }
    expect(floorMoves).toBeGreaterThan(0);
  });
});

describe('seasons', () => {
  it('maps episodes onto the 12-week calendar with PPVs at 4, 8 and 12', async () => {
    const s = await import('../src/world/season');
    expect([1, 4, 8, 12, 13, 16].map(s.isPPV)).toEqual([false, true, true, true, false, true]);
    expect([12, 13, 25].map(s.seasonOf)).toEqual([1, 2, 3]);
    expect(s.isFinale(24)).toBe(true);
    expect(s.episodeLabel({ plan: undefined }, 16)).toMatch(/^Season 2 · Episode 4 — PPV: /);
  });

  it('runs a full season offline and shuffles the roster between seasons', async () => {
    const { offlineBook } = await import('../src/booker/fallback');
    let w = offlineWorld(77);
    const seasonOne = new Set(w.characters.map((c) => c.id));
    for (let i = 0; i < 13; i++) {
      const raw = offlineBook(w);
      const r = reviewEpisode(raw, w); // a season opener validates against the pre-shuffle world
      expect(r.problems, `episode ${i + 1}`).toEqual([]);
      if (i === 0 || i === 12) expect(r.episode!.seasonStart?.plan?.ppvs).toHaveLength(3);
      if (i === 12) {
        const { events } = playEpisode(w, r.episode!); // arrivals can be staged
        expect(events.at(-1)!.type).toBe('episodeEnd');
      }
      w = applyEpisode(w, r.episode!);
    }
    expect(w.episode).toBe(13);
    expect(w.seasonHistory).toHaveLength(1);
    expect(w.alumni!.length).toBeGreaterThan(0);
    const newcomers = w.characters.filter((c) => !seasonOne.has(c.id));
    expect(newcomers.length).toBeGreaterThan(0);
    expect(w.alumni!.every((a) => !w.characters.some((c) => c.id === a.id))).toBe(true);
    expect(w.titles.every((t) => !t.holder || w.characters.some((c) => c.id === t.holder))).toBe(true);
  });
});

describe('stipulations', () => {
  const men = ['rex', 'vega', 'lightning', 'krank', 'earl', 'maddog', 'sterling', 'stryker', 'kaos', 'bane', 'clint'];
  const episodeWith = (m: Record<string, unknown>): Episode => ({
    title: 'Stips', storySoFar: '', debuts: [],
    segments: [1, 2, 3].map((i) => ({
      title: `Seg ${i}`, stateChanges: [], recap: `r${i}`,
      beats: i === 2
        ? [{ type: 'match', story: 'back_and_forth', length: 'short', titleOnLine: 'none', spots: [], moments: [], ...m } as unknown as Episode['segments'][0]['beats'][0]]
        : [{ type: 'narrate', text: 'Hi', style: 'call', speaker: 'pbp' }],
    })),
  });

  const cases: [string, Record<string, unknown>][] = [
    ['tag', { stipulation: 'tag', wrestlers: ['rex', 'clint', 'krank', 'bane'], winner: 'clint', finish: 'pin' }],
    ['tag dq', { stipulation: 'tag', wrestlers: ['rex', 'clint', 'krank', 'bane'], winner: 'bane', finish: 'dq' }],
    ['cage escape', { stipulation: 'cage', wrestlers: ['rex', 'vega'], winner: 'vega', finish: 'escape' }],
    ['cage pin', { stipulation: 'cage', wrestlers: ['rex', 'vega'], winner: 'rex', finish: 'pin' }],
    ['ladder', { stipulation: 'ladder', wrestlers: ['lightning', 'kaos'], winner: 'kaos', finish: 'retrieve', titleOnLine: 'tv' }],
    ['battle royal', { stipulation: 'battle_royal', wrestlers: men.slice(0, 8), winner: 'earl', finish: 'elimination' }],
  ];

  for (const [name, m] of cases) {
    it(`plays a ${name} match to the booked result`, () => {
      for (let seed = 1; seed <= 4; seed++) {
        const w = { ...classicWorld(), seed };
        const r = reviewEpisode(episodeWith(m), w);
        expect(r.problems).toEqual([]);
        const { events } = playEpisode(w, r.episode!);
        const end = events.find((e) => e.type === 'matchEnd');
        expect(end && [end.winner, end.finish], `${name} seed ${seed}`).toEqual([m.winner, m.finish]);
        if (m.stipulation === 'battle_royal') {
          expect(events.filter((e) => e.type === 'elimination')).toHaveLength((m.wrestlers as string[]).length - 1);
        }
        if (m.stipulation === 'tag') {
          // A pin in a tag match is scored by the winner and counted on the other team.
          const pins = events.filter((e) => e.type === 'pinCount' && e.count === 3 && !e.kickout);
          if (m.finish === 'pin') expect(pins.at(-1)?.type === 'pinCount' && pins.at(-1)).toMatchObject({ coverer: m.winner });
        }
      }
    });
  }

  it('fixes finishes that do not fit the stipulation', () => {
    const r = reviewEpisode(episodeWith({ stipulation: 'ladder', wrestlers: ['rex', 'vega'], winner: 'rex', finish: 'pin' }), classicWorld());
    const m = r.episode!.segments[1].beats[0];
    expect(m.type === 'match' && m.finish).toBe('retrieve');
    const bad = reviewEpisode(episodeWith({ stipulation: 'tag', wrestlers: ['rex', 'vega'], winner: 'rex', finish: 'pin' }), classicWorld());
    expect(bad.problems.some((p) => p.includes('tag match needs exactly 4'))).toBe(true);
  });
});

describe('episode size', () => {
  it('trims weekly TV to 7 segments, keeping matches and the main event', () => {
    const w = classicWorld();
    const talk = (i: number) => ({ title: `Talk ${i}`, stateChanges: [], recap: 'r', beats: [{ type: 'promo', who: 'vega', where: 'ring', mood: 'cocky', lines: ['Hi'] }] });
    const match = (a: string, b: string, t: string) => ({
      title: t, stateChanges: [], recap: 'r',
      beats: [{ type: 'match', stipulation: 'singles', wrestlers: [a, b], winner: a, finish: 'pin', story: 'even', length: 'short', titleOnLine: 'none', spots: [], moments: [] }],
    });
    const ep = {
      title: 'Long', storySoFar: '', debuts: [],
      segments: [match('rex', 'vega', 'Opener'), talk(1), talk(2), match('earl', 'maddog', 'Mid'), talk(3), talk(4), talk(5), talk(6), talk(7), match('lightning', 'kaos', 'Main')],
    } as unknown as Episode;
    expect(reviewEpisode(ep, w).episode!.segments).toHaveLength(10); // stored episodes replay untouched
    const r = reviewEpisode(ep, w, { trim: true });
    expect(r.episode!.segments).toHaveLength(7);
    expect(r.episode!.segments.map((s) => s.title)).toEqual(expect.arrayContaining(['Opener', 'Mid', 'Main']));
    expect(r.episode!.segments.at(-1)!.title).toBe('Main');
  });
});
