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
        ? [{ type: 'match', wrestlers: ['rex', 'vega'], winner, finish, story: 'even', length: 'short', titleOnLine, spots: [] }]
        : [{ type: 'narrate', text: 'Hello', style: 'call' }],
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

  it('rejects cross-division matches', () => {
    const ep = matchEpisode('rex', 'pin');
    const m = ep.segments[2].beats[0];
    if (m.type === 'match') m.wrestlers = ['rex', 'viper'];
    const r = reviewEpisode(ep, classicWorld());
    expect(r.problems.some((p) => p.includes('division'))).toBe(true);
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
          { type: 'match', wrestlers: ['masked_x', 'lightning'], winner: 'masked_x', finish: 'dq', story: 'comeback', length: 'short', titleOnLine: 'tv', spots: [
            { phase: 'early', type: 'distraction', who: 'pemberton', target: 'lightning', lines: ['Referee!'] },
            { phase: 'mid', type: 'ref_bump', who: 'lightning', target: 'none', lines: [] },
            { phase: 'late', type: 'interrupt', who: 'kaos', target: 'lightning', lines: ['Hey!'] },
            { phase: 'finish', type: 'run_in', who: 'bane', target: 'masked_x', lines: [] },
          ] },
          { type: 'turn', who: 'clint', newAlignment: 'heel', how: 'attacks_partner', target: 'rex' },
          { type: 'celebrate', who: ['clint'] },
          { type: 'exit', who: ['clint', 'rex'], how: 'storm_off' },
          { type: 'narrate', text: 'Unbelievable!', style: 'shock' },
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
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
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

  it('decodes stringified beats and repairs missing optional fields', () => {
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
    expect(ep.segments.map((s) => s.beats.length)).toEqual([1, 1, 1]);
    const promo = ep.segments[0].beats[0];
    expect(promo.type === 'promo' && [promo.where, promo.mood]).toEqual(['ring', 'calm']);
    const m = ep.segments[1].beats[0];
    expect(m.type === 'match' && [m.finish, m.story, m.spots]).toEqual(['pin', 'even', []]);
    expect(r.problems.some((p) => p.includes('teleport'))).toBe(true);
  });
});
