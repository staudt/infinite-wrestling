import type { Actor } from '../engine/actor';
import { arena, clampToRing } from '../engine/arena';
import { readTime, type Stage } from '../engine/stage';
import type { BodyState } from '../engine/poses';
import type { Co } from '../engine/tasks';
import { fill, finisherName, line, LINES } from '../choreo/lines';
import type { BeatOf, Finish, Spot } from '../schema/episode';
import { CHEATS, hasMove, type Move, move, RANDOM_POOL, SUBMISSIONS } from './moves';

export type MatchSpec = Pick<BeatOf<'match'>, 'wrestlers' | 'winner' | 'finish' | 'story' | 'length' | 'spots'>;
export type Phase = 'early' | 'mid' | 'late' | 'finish';
export interface MatchResult { winner: string | null; loser: string | null; finish: Finish }

/** Seconds of in-ring action (spots and holds excluded) before the finish. */
export const MATCH_SECONDS = { short: 45, medium: 85, long: 135 } as const;
const PHASES: Phase[] = ['early', 'mid', 'late', 'finish'];

/** Choreography for spots lives in the choreographer; the match calls back into it. */
export type SpotHandler = (spot: Spot, match: MatchSim) => Co;

export function shortName(a: Actor): string {
  return a.name.replace(/"[^"]*"\s*/g, '').trim();
}

export class MatchSim {
  readonly a: Actor;
  readonly b: Actor;
  readonly winner: Actor | null;
  readonly loser: Actor | null;
  readonly hp = new Map<string, number>();
  result: MatchResult | null = null;
  refDown = false;
  /** Set by a spot when interference should decide a DQ / no-contest finish. */
  interferenceFinish = false;
  private recent: string[] = [];
  private lastAttacker: Actor | null = null;
  private activeTime = 0;
  private fired = new Set<Spot>();
  private refDownFor = 0;

  constructor(
    private stage: Stage,
    readonly spec: MatchSpec,
    private onSpot: SpotHandler,
  ) {
    this.a = stage.actor(spec.wrestlers[0]);
    this.b = stage.actor(spec.wrestlers[1]);
    this.winner = spec.winner === 'none' ? null : stage.actor(spec.winner);
    this.loser = this.winner ? this.other(this.winner) : null;
    this.hp.set(this.a.id, 100);
    this.hp.set(this.b.id, 100);
  }

  other(x: Actor): Actor {
    return x === this.a ? this.b : this.a;
  }

  get phase(): Phase {
    const f = this.activeTime / MATCH_SECONDS[this.spec.length];
    return f < 0.3 ? 'early' : f < 0.65 ? 'mid' : f < 1 ? 'late' : 'finish';
  }

  private get rng() {
    return this.stage.rng;
  }

  private vars(att: Actor, def: Actor, extra: Record<string, string> = {}) {
    const w = this.winner ?? this.a;
    const l = this.loser ?? this.b;
    return { A: shortName(att), D: shortName(def), W: shortName(w), L: shortName(l), ...extra };
  }

  // ---------------------------------------------------------------- main loop

  *run(): Co {
    this.stage.bus.emit({ type: 'bell' });
    yield* this.stage.narrate(line(this.rng, 'bell'), 'bell');
    yield* this.stage.narrate(line(this.rng, 'lockup', this.vars(this.a, this.b)));

    while (!this.result) {
      const phase = this.phase;
      for (const spot of this.spec.spots) {
        if (this.fired.has(spot) || PHASES.indexOf(spot.phase) > PHASES.indexOf(phase)) continue;
        this.fired.add(spot);
        yield* this.runSpot(spot);
        if (this.result) break;
      }
      if (this.result) break;
      if (phase === 'finish') {
        yield* this.finish();
        break;
      }
      const t0 = this.stage.time;
      yield* this.exchange(phase);
      this.activeTime += this.stage.time - t0;
    }

    this.stage.bus.emit({ type: 'bell' });
    this.stage.bus.emit({
      type: 'matchEnd',
      winner: this.result!.winner,
      loser: this.result!.loser,
      finish: this.result!.finish,
    });
  }

  private *runSpot(spot: Spot): Co {
    yield* this.settle();
    yield* this.onSpot(spot, this);
    if (spot.type === 'ref_bump') {
      this.refDown = true;
      this.refDownFor = 3;
    }
    const decisive = spot.phase === 'finish' && (spot.type === 'run_in' || spot.type === 'weapon');
    if (decisive && (this.spec.finish === 'dq' || this.spec.finish === 'no_contest')) this.interferenceFinish = true;
  }

  /** Let any in-progress motion finish so spots start from a calm state. */
  *settle(): Co {
    yield () => !this.a.anim && !this.b.anim;
  }

  // ---------------------------------------------------------------- exchanges

  private controlChance(phase: Phase): number {
    switch (this.spec.story) {
      case 'even': return 0.5;
      case 'back_and_forth': return 0.5;
      case 'winner_dominates': return 0.75;
      case 'squash': return 0.92;
      case 'loser_dominates': return phase === 'late' ? 0.45 : 0.25;
      case 'comeback': return phase === 'early' ? 0.4 : phase === 'mid' ? 0.2 : 0.85;
    }
  }

  private pickAttacker(phase: Phase): Actor {
    // Whips set up a follow-up: the same wrestler keeps control.
    if (this.lastAttacker) {
      const opp = this.other(this.lastAttacker);
      if (opp.bodyState === 'reeling' || opp.bodyState === 'corner') return this.lastAttacker;
    }
    const w = this.winner ?? this.a;
    let p = this.controlChance(phase);
    if (this.lastAttacker && this.spec.story !== 'back_and_forth') {
      p += this.lastAttacker === w ? 0.1 : -0.1;
    }
    return this.rng.chance(p) ? w : this.other(w);
  }

  private *exchange(phase: Phase): Co {
    const { stage, rng } = this;
    this.followRef();
    if (this.refDown && --this.refDownFor <= 0) {
      this.refDown = false;
      yield* stage.getUp(stage.ref, true);
      yield* stage.narrate(line(rng, 'refUp'));
    }

    if (this.a.down && this.b.down) {
      yield* stage.narrate(line(rng, 'bothDown'));
      yield 1.5;
      const ta = stage.spawn(stage.getUp(this.a, true));
      const tb = stage.spawn(stage.getUp(this.b, true));
      yield [ta, tb];
      return;
    }

    const att = this.pickAttacker(phase);
    const def = this.other(att);
    const turned = this.lastAttacker !== null && this.lastAttacker !== att;
    if (att.bodyState !== 'standing') yield* stage.getUp(att);
    if (def.bodyState === 'kneeling') yield* stage.getUp(def);

    if (turned && phase !== 'early' && rng.chance(0.35)) {
      const heel = att.alignment === 'heel';
      yield* stage.narrate(line(rng, heel ? 'cutoff' : 'comeback', this.vars(att, def)));
      stage.crowd(heel ? 'boo' : 'cheer');
    }
    this.lastAttacker = att;

    // Flavor between moves.
    const style = att.character?.style;
    if (rng.chance(style === 'showman' ? 0.14 : 0.05)) {
      yield* stage.gesture(att, { upper: 'arms_up', head: 'shout' }, 1.2);
      yield* stage.narrate(line(rng, 'taunt', this.vars(att, def)));
      this.chant(att);
      return;
    }
    if (att.alignment === 'heel' && phase === 'early' && rng.chance(0.08)) {
      yield* stage.narrate(line(rng, 'stall', this.vars(att, def)));
      stage.crowd('boo');
      return;
    }
    if (phase !== 'late' && def.bodyState === 'standing' && rng.chance(0.07)) {
      yield* this.restHold(att, def);
      return;
    }
    if (def.down && rng.chance(0.3)) {
      yield* this.approach(att, def, 1.5);
      yield* stage.narrate(line(rng, 'pullUp', this.vars(att, def)));
      yield* stage.getUp(def);
    }

    // Hardcore crowds get plunder in every match, legal or not.
    if (stage.hardcore && phase !== 'early' && rng.chance(0.1)) {
      yield* this.weaponShot(att, def);
      if (rng.chance(0.4)) yield* stage.narrate('The referee isn\'t even bothering to call for the bell!');
      return;
    }

    if (att.alignment === 'heel' && rng.chance(0.1)) {
      const cheat = this.pick(CHEATS, att, def, phase);
      if (cheat) {
        yield* this.perform(att, def, cheat);
        yield* stage.narrate(line(rng, this.refDown || rng.chance(0.5) ? 'cheatUnseen' : 'refWarn', this.vars(att, def)));
        stage.crowd('boo');
        return;
      }
    }

    const mv = this.pick(RANDOM_POOL, att, def, phase);
    if (!mv) return;
    if (mv.kind === 'submission') {
      yield* this.submission(att, def, mv, false);
    } else {
      yield* this.perform(att, def, mv);
    }
    if (mv.big && def.down && phase !== 'early' && !this.refDown && rng.chance(0.55)) {
      yield* this.cover(att, def, false);
    }
    yield rng.range(0.3, 1.0);
  }

  private defState(def: Actor): BodyState {
    return def.bodyState === 'kneeling' ? 'standing' : def.bodyState;
  }

  private pick(pool: Move[], att: Actor, def: Actor, phase: Phase): Move | null {
    const state = this.defState(def);
    const cands = pool.filter((m) => m.requires.def.includes(state));
    if (!cands.length) return null;
    const style = att.character?.style;
    return this.rng.weighted(cands, (m) => {
      let w = 1;
      if (style && m.styles.includes(style)) w *= 3;
      if (m.big) w *= phase === 'early' ? 0.15 : phase === 'mid' ? 0.8 : 2;
      if (m.kind === 'strike' && phase === 'early') w *= 1.8;
      if (m.kind === 'aerial' && style !== 'highflyer') w *= 0.1;
      if (m.kind === 'submission') w *= style === 'technician' ? 1.2 : 0.4;
      if (m.kind === 'whip') w *= 0.7;
      if (this.recent.slice(-5).includes(m.id)) w *= 0.12;
      return w;
    });
  }

  // ---------------------------------------------------------------- actions

  private followRef(): void {
    const ref = this.stage.ref;
    if (!ref.visible || ref.down || ref.moving || this.refDown) return;
    const mid = clampToRing({ x: (this.a.x + this.b.x) / 2, depth: Math.max(this.a.depth, this.b.depth) - 2.5 });
    if (Math.abs(mid.x - ref.x) > 4) this.stage.spawn(this.stage.walkTo(ref, mid));
  }

  *approach(att: Actor, def: Actor, dist: number): Co {
    const dir = def.x >= att.x ? 1 : -1;
    let target = { x: def.x - dir * dist, depth: def.depth };
    if (def.inRing) {
      target = clampToRing(target);
      if (Math.abs(target.x - def.x) < 1) target.x = def.x + dir * dist; // pinned against the ropes: come from the other side
      target = clampToRing(target);
    }
    const far = Math.hypot(target.x - att.x, target.depth - att.depth);
    if (far > 0.3) yield* this.stage.walkTo(att, target, far > 7 ? 'run' : 'walk');
    this.stage.face(att, def);
  }

  /** Approach, animate, apply damage and resulting body states. */
  *perform(att: Actor, def: Actor, mv: Move, text?: string): Co {
    const { stage, rng } = this;
    const firstDx = mv.keys[0]?.def?.dx ?? 2;
    yield* this.approach(att, def, Math.min(firstDx, 3));
    const said = text ?? fill(rng.pick(mv.text), this.vars(att, def));
    let impactAt = 0;
    let told = false;
    yield* stage.playMove(att, def, mv.keys, mv.id, mv.name, () => {
      this.hp.set(def.id, Math.max(0, (this.hp.get(def.id) ?? 100) - mv.damage));
      if (!told) {
        told = true;
        impactAt = stage.time;
        stage.bus.emit({ type: 'narrated', text: said, style: mv.big ? 'big' : 'call' });
        if (mv.big) stage.crowd('pop');
      }
    });
    stage.setBody(att, mv.result.att);
    stage.setBody(def, mv.result.def);
    this.recent.push(mv.id);
    // Leave the line up long enough to read.
    const left = readTime(said, mv.big ? 'big' : 'narrated') - (stage.time - impactAt);
    if (left > 0) yield left;
    if (rng.chance(0.12)) this.chant(rng.chance(0.5) ? att : def);
  }

  /** Hit someone with whatever is lying around (hardcore promotions have more lying around). */
  *weaponShot(att: Actor, def: Actor): Co {
    const weapon = this.rng.pick(this.stage.hardcore ? LINES.hardcoreWeapons : LINES.weapons);
    if (att.bodyState !== 'standing') yield* this.stage.getUp(att);
    yield* this.perform(att, def, move('chair_shot'), fill(this.rng.pick(LINES.weaponHit), { ...this.vars(att, def), X: weapon }));
    this.stage.crowd(this.stage.hardcore ? 'chant' : 'gasp', this.stage.hardcore ? this.rng.pick([`${this.stage.shortName}! ${this.stage.shortName}!`, 'Holy $#!%!', 'One more time!', 'Hard-core! Hard-core!']) : undefined);
  }

  private chant(x: Actor): void {
    const bank = x.alignment === 'face' ? 'face' : x.alignment === 'heel' ? 'heel' : 'any';
    const chant = fill(this.rng.pick(LINES.chants[bank]), { X: shortName(x) });
    this.stage.crowd('chant', chant);
  }

  private *restHold(att: Actor, def: Actor): Co {
    const { stage, rng } = this;
    yield* this.approach(att, def, 1);
    stage.setPose(att, { upper: 'grab' });
    stage.setPose(def, { head: 'hurt', lower: 'kneel' });
    yield* stage.narrate(line(rng, 'headlock', this.vars(att, def)));
    yield rng.range(1.5, 3);
    yield* stage.narrate(line(rng, 'headlockEscape', this.vars(att, def)));
    stage.setBody(att, 'standing');
    stage.setBody(def, 'standing');
    if (def.alignment === 'face') stage.crowd('cheer');
  }

  *submission(att: Actor, def: Actor, mv: Move, decisive: boolean, text?: string): Co {
    const { stage, rng } = this;
    if (!mv.requires.def.includes(this.defState(def))) {
      yield* this.knockDown(att, def);
    }
    yield* this.perform(att, def, mv, text);
    stage.setBody(att, 'kneeling');
    stage.setPose(att, { upper: 'grab' });
    stage.setBody(def, 'grounded');
    stage.setPose(def, { head: 'shout' });
    yield* stage.narrate(line(rng, 'subStruggle', this.vars(att, def)));
    yield rng.range(1, 2.5);
    if (decisive) {
      yield* stage.narrate(line(rng, 'subStruggle', this.vars(att, def)));
      yield* stage.narrate(line(rng, 'tapout', this.vars(att, def)), 'big');
      stage.crowd(att.alignment === 'heel' ? 'boo' : 'pop');
    } else {
      yield* stage.narrate(line(rng, 'subEscape', this.vars(att, def)));
    }
    stage.setBody(att, 'standing');
  }

  /** Knock a standing opponent down with a quick move (setup for ground finishers). */
  *knockDown(att: Actor, def: Actor): Co {
    if (def.down) return;
    const opts = RANDOM_POOL.filter(
      (m) => !m.big && m.result.def === 'grounded' && m.result.att === 'standing' &&
        m.requires.def.includes(this.defState(def)) && m.kind !== 'submission',
    );
    const mv = opts.length ? this.rng.pick(opts) : move('body_slam');
    yield* this.perform(att, def, mv);
  }

  /** Bring a downed opponent back up for a standing finisher. */
  *standUp(att: Actor, def: Actor): Co {
    if (!def.down && def.bodyState !== 'kneeling') return;
    yield* this.approach(att, def, 1.5);
    yield* this.stage.narrate(line(this.rng, 'pullUp', this.vars(att, def)));
    yield* this.stage.getUp(def);
  }

  *cover(att: Actor, def: Actor, decisive: boolean, coverText?: string): Co {
    const { stage, rng } = this;
    if (att.bodyState !== 'standing') yield* stage.getUp(att);
    const cv = move('cover');
    yield* this.perform(att, def, cv, coverText);
    stage.setPose(att, { lower: 'lying', rot: 90, upper: 'grab' });
    const ref = stage.ref;
    if (!ref.down) {
      yield* stage.walkTo(ref, clampToRing({ x: def.x + 1, depth: def.depth - 1 }), 'run');
      stage.setPose(ref, { lower: 'lying', rot: 90 });
    }
    // Near-falls always reach two: "1... 2... KICKOUT!" is the drama.
    for (const n of [1, 2] as const) {
      stage.bus.emit({ type: 'pinCount', count: n, kickout: false });
      yield* stage.narrate(n === 2 ? 'TWO...' : 'ONE...', 'count');
    }
    stage.bus.emit({ type: 'pinCount', count: 3, kickout: !decisive });
    if (decisive) {
      yield* stage.narrate('THREE!!!', 'count');
    } else {
      stage.crowd('gasp');
      yield* stage.narrate(line(rng, 'kickout', this.vars(att, def)), 'big');
      stage.setBody(att, 'kneeling');
    }
    if (!ref.down) stage.setBody(ref, 'standing');
  }

  // ---------------------------------------------------------------- finishes

  private finisherOf(x: Actor): { mv: Move; name: string } {
    const f = x.character?.finisher;
    if (f && f.name && hasMove(f.move)) return { mv: move(f.move), name: finisherName(f.name) };
    return { mv: move('piledriver'), name: 'piledriver' };
  }

  /** Hit the winner's finisher (or a big substitute when the finisher is a hold). */
  *hitFinisher(w: Actor, l: Actor): Co {
    const { stage, rng } = this;
    let { mv, name } = this.finisherOf(w);
    if (mv.kind === 'submission' || mv.kind === 'pin') {
      const bigs = RANDOM_POOL.filter((m) => m.big && m.requires.def.includes('standing') && m.kind !== 'submission');
      mv = rng.pick(bigs);
      name = mv.name;
    }
    if (mv.requires.def.includes('grounded') && !mv.requires.def.includes('standing')) {
      yield* this.knockDown(w, l);
    } else {
      yield* this.standUp(w, l);
    }
    yield* stage.narrate(line(rng, 'finisherCall', this.vars(w, l, { F: name })), 'big');
    stage.crowd(w.alignment === 'heel' ? 'boo' : 'pop');
    yield* this.perform(w, l, mv, line(rng, 'finisherHit', this.vars(w, l, { F: name.toUpperCase() })));
    this.stage.setBody(l, 'grounded');
  }

  private *finish(): Co {
    const { stage, rng, spec } = this;
    const w = this.winner ?? this.a;
    const l = this.loser ?? this.b;
    const end = (finish: Finish) => {
      this.result = {
        winner: this.winner?.id ?? null,
        loser: this.loser?.id ?? null,
        finish,
      };
    };
    if (w.bodyState !== 'standing') yield* stage.getUp(w);
    if (this.refDown) {
      this.refDown = false;
      yield* stage.getUp(stage.ref, true);
    }

    switch (spec.finish) {
      case 'pin': {
        yield* this.hitFinisher(w, l);
        yield* this.cover(w, l, true);
        end('pin');
        break;
      }
      case 'cheat_pin': {
        const bigs = RANDOM_POOL.filter((m) => m.big && m.requires.def.includes(this.defState(l)));
        if (bigs.length) yield* this.perform(w, l, rng.pick(bigs));
        else yield* this.knockDown(w, l);
        stage.setBody(l, 'grounded');
        yield* this.cover(w, l, true, line(rng, 'cheatPin', this.vars(w, l)));
        stage.crowd('boo');
        end('cheat_pin');
        break;
      }
      case 'rollup': {
        if (l.bodyState !== 'standing') yield* stage.getUp(l);
        if (w.bodyState !== 'standing') yield* stage.getUp(w);
        const strike = this.pick(RANDOM_POOL.filter((m) => m.kind === 'strike' && m.result.def === 'standing'), l, w, 'mid');
        if (strike) yield* this.perform(l, w, strike);
        yield* stage.narrate(line(rng, 'rollupSetup', this.vars(l, w)));
        yield* this.perform(w, l, move('rollup'), line(rng, 'rollupHit', this.vars(w, l)));
        stage.setBody(l, 'grounded');
        yield* this.cover(w, l, true, `${shortName(w)} hooks the legs!`);
        stage.crowd('pop');
        end('rollup');
        break;
      }
      case 'submission': {
        const own = this.finisherOf(w);
        const mv = own.mv.kind === 'submission' ? own.mv : this.pick(SUBMISSIONS, w, l, 'late') ?? move('boston_crab');
        const name = own.mv.kind === 'submission' ? own.name : mv.name;
        yield* stage.narrate(line(rng, 'finisherCall', this.vars(w, l, { F: name })), 'big');
        yield* this.submission(w, l, mv, true);
        end('submission');
        break;
      }
      case 'dq': {
        if (!this.interferenceFinish) {
          yield* stage.narrate(line(rng, 'dqCause', this.vars(l, w)), 'big');
          if (w.bodyState !== 'standing') yield* stage.getUp(w);
          yield* this.weaponShot(l, w);
        }
        yield* stage.narrate(line(rng, 'dq', this.vars(w, l)), 'big');
        stage.crowd(l.alignment === 'heel' ? 'boo' : 'buzz');
        end('dq');
        break;
      }
      case 'countout': {
        yield* stage.narrate(line(rng, 'countoutSpill', this.vars(w, l)));
        const outW = { x: arena.ringside.x0 + 3, depth: 2 };
        const outL = { x: arena.ringside.x0 + 1, depth: 2 };
        yield [stage.spawn(stage.goTo(w, outW, 'run')), stage.spawn(stage.goTo(l, outL, 'run'))];
        const strike = this.pick(RANDOM_POOL.filter((m) => m.kind === 'strike' && m.result.def === 'grounded'), w, l, 'late');
        if (strike) yield* this.perform(w, l, strike);
        yield* stage.narrate('The referee is counting... 5... 6... 7... 8...', 'count');
        yield* stage.goTo(w, arena.ringSpots[1], 'run');
        yield* stage.narrate(line(rng, 'countoutBeat', this.vars(w, l)));
        yield* stage.narrate('...9... 10!', 'count');
        yield* stage.narrate(line(rng, 'countoutLoss', this.vars(w, l)), 'big');
        end('countout');
        break;
      }
      case 'no_contest': {
        if (!this.interferenceFinish) {
          yield* stage.narrate(line(rng, 'brawl', this.vars(this.a, this.b)), 'big');
          for (let i = 0; i < 3; i++) {
            const att = i % 2 ? this.b : this.a;
            const def = this.other(att);
            if (att.bodyState !== 'standing') yield* stage.getUp(att);
            if (def.bodyState !== 'standing') yield* stage.getUp(def);
            const strike = this.pick(RANDOM_POOL.filter((m) => m.kind === 'strike'), att, def, 'mid');
            if (strike) yield* this.perform(att, def, strike);
          }
        }
        yield* stage.narrate(line(rng, 'noContest'), 'big');
        stage.crowd('buzz');
        end('no_contest');
        break;
      }
    }
  }
}

