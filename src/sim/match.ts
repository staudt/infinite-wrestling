import type { Actor } from '../engine/actor';
import { arena, clampToRing, type Point } from '../engine/arena';
import { readTime, type Stage } from '../engine/stage';
import type { BodyState } from '../engine/poses';
import type { Co, Wait } from '../engine/tasks';
import type { Prop } from '../engine/stage';
import { beltName, fill, finisherName, line, LINES } from '../choreo/lines';
import type { BeatOf, Finish, Moment, Spot, Stipulation } from '../schema/episode';
import { CHEATS, hasMove, type Move, move, OUTSIDE_POOL, RANDOM_POOL, SUBMISSIONS } from './moves';

export type MatchSpec = Pick<BeatOf<'match'>, 'wrestlers' | 'winner' | 'finish' | 'story' | 'length' | 'spots'> & {
  moments?: Moment[];
  stipulation?: Stipulation;
  titleOnLine?: string;
};
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
  /** The two wrestlers facing each other right now (in tag: the legal men; in a battle
   *  royal: the current pair). */
  a: Actor;
  b: Actor;
  readonly winner: Actor | null;
  /** Settled at the finish in tag matches (the man pinned) and battle royals (the runner-up). */
  loser: Actor | null;
  readonly stipulation: Stipulation;
  /** Everyone in the match. */
  readonly all: Actor[];
  /** Tag teams: [team of a, team of b]. */
  readonly teams: [Actor[], Actor[]] | null;
  private hotTag = false;
  private eliminated: Actor[] = [];
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
  private spoken = new Set<Moment>();
  /** Referee's count while someone is on the floor, and moves done out there. */
  private floorCount = 0;
  private floorMoves = 0;

  constructor(
    private stage: Stage,
    readonly spec: MatchSpec,
    private onSpot: SpotHandler,
  ) {
    this.stipulation = spec.stipulation ?? 'singles';
    this.all = spec.wrestlers.map((id) => stage.actor(id));
    this.teams = this.stipulation === 'tag' ? [this.all.slice(0, 2), this.all.slice(2, 4)] : null;
    this.a = this.all[0];
    this.b = this.teams ? this.teams[1][0] : this.all[1];
    this.winner = spec.winner === 'none' ? null : stage.actor(spec.winner);
    this.loser = this.winner && this.all.length === 2 ? this.other(this.winner) : null;
    for (const x of this.all) this.hp.set(x.id, 100);
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
    return { A: this.stage.called(att), D: this.stage.called(def), W: shortName(w), L: shortName(l), ...extra };
  }

  // ---------------------------------------------------------------- main loop

  /** The one of the facing pair on the booked winner's side. */
  private winnerSide(): Actor {
    if (!this.winner) return this.a;
    if (this.teams) return this.teams[0].includes(this.winner) ? this.a : this.b;
    return this.winner;
  }

  private get cage(): boolean {
    return this.stipulation === 'cage';
  }

  *run(): Co {
    if (this.stipulation === 'battle_royal') {
      yield* this.runBattleRoyal();
      yield* this.wrapUp();
      return;
    }
    if (this.stipulation === 'ladder') this.setUpLadderMatch();
    this.stage.blurt(this.stage.ref, this.rng.pick(['Ring the bell!', 'Let\'s go!', 'Fight!']));
    this.stage.bus.emit({ type: 'bell' });
    yield* this.stage.narrate(line(this.rng, 'bell'), 'bell');
    // Meet in the middle before the lockup is called.
    const mid = (this.a.x + this.b.x) / 2;
    const side = this.a.x <= this.b.x ? -1 : 1;
    yield [
      this.stage.spawn(this.stage.walkTo(this.a, clampToRing({ x: mid + side * 1.5, depth: this.a.depth }))),
      this.stage.spawn(this.stage.walkTo(this.b, clampToRing({ x: mid - side * 1.5, depth: this.b.depth }))),
    ];
    this.stage.face(this.a, this.b);
    this.stage.face(this.b, this.a);
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
        // Anything the booker wanted said during the match gets said before the finish.
        for (const mo of this.pendingMoments('late')) yield* this.speak(mo);
        yield* this.finish();
        break;
      }
      // At most one storyline line per exchange, so they spread through the match.
      const next = this.pendingMoments(phase)[0];
      if (next) yield* this.speak(next);
      const t0 = this.stage.time;
      yield* this.exchange(phase);
      this.activeTime += this.stage.time - t0;
    }

    yield* this.wrapUp();
  }

  /** The bell, the result, and any booked post-match lines. */
  private *wrapUp(): Co {
    this.stage.bus.emit({ type: 'bell' });
    this.stage.bus.emit({
      type: 'matchEnd',
      winner: this.result!.winner,
      loser: this.result!.loser,
      finish: this.result!.finish,
    });
    for (const mo of this.pendingMoments('after')) yield* this.speak(mo);
  }

  /** Booked storyline lines due by `phase` that haven't been said yet. */
  private pendingMoments(phase: Phase | 'after'): Moment[] {
    const order = ['early', 'mid', 'late', 'after'];
    const limit = order.indexOf(phase === 'finish' ? 'late' : phase);
    return (this.spec.moments ?? []).filter((mo) => !this.spoken.has(mo) && order.indexOf(mo.phase) <= limit);
  }

  /** Say a booked line: the play-by-play, the color man, or whoever is out there. */
  private *speak(mo: Moment): Co {
    const { stage } = this;
    this.spoken.add(mo);
    if (mo.speaker === 'pbp') {
      yield* stage.narrate(mo.line, /!/.test(mo.line) ? 'big' : 'call');
      return;
    }
    const who = mo.speaker === 'color' ? stage.colorGuy : stage.actors.get(mo.speaker);
    if (!who?.visible) return;
    const loud = /!/.test(mo.line);
    yield* stage.say(who, mo.line, mo.speaker === 'color' ? 'smug' : who.alignment === 'heel' ? (loud ? 'furious' : 'cocky') : loud ? 'angry' : 'calm');
  }

  private *runSpot(spot: Spot): Co {
    yield* this.settle();
    // The referee lives in the ring: bring the fight back in before bumping him.
    if (spot.type === 'ref_bump' && (!this.a.inRing || !this.b.inRing)) {
      const att = this.lastAttacker ?? this.a;
      yield* this.backInRing(att, this.other(att));
    }
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
    const w = this.winnerSide();
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

    // Someone is on the floor: fight out there, with the referee counting.
    if (!this.a.inRing || !this.b.inRing) {
      yield* this.floorExchange(phase);
      return;
    }

    if (this.a.down && this.b.down) {
      yield* stage.narrate(line(rng, 'bothDown'));
      yield 1.5;
      const ta = stage.spawn(stage.getUp(this.a, true));
      const tb = stage.spawn(stage.getUp(this.b, true));
      yield [ta, tb];
      return;
    }

    if (this.teams && (yield* this.tagTurn(phase))) return;

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
      const phrase = att.character?.catchphrase;
      if (phrase && rng.chance(0.5)) {
        stage.setPose(att, { upper: 'arms_up', head: 'shout' });
        yield* stage.say(att, phrase, 'excited');
        stage.setPose(att, att.basePose());
      } else {
        yield* stage.gesture(att, { upper: 'arms_up', head: 'shout' }, 1.2);
        yield* stage.narrate(line(rng, 'taunt', this.vars(att, def)));
      }
      this.chant(att);
      return;
    }
    // Steel cage: the cage is a weapon, and climbing out is a way to win.
    if (this.cage && def.bodyState === 'standing' && rng.chance(0.12)) {
      yield* this.perform(att, def, move('cage_slam'));
      return;
    }
    if (this.cage && phase !== 'early' && rng.chance(0.07)) {
      yield* this.cageClimbAttempt(att, def);
      return;
    }
    if (this.stipulation === 'ladder' && (yield* this.ladderTurn(att, def, phase))) return;
    if (!this.cage && att.alignment === 'heel' && phase === 'early' && rng.chance(0.08)) {
      yield* this.toFloor(att, this.floorSpot(att));
      yield* stage.narrate(line(rng, 'stall', this.vars(att, def)));
      stage.crowd('boo');
      return;
    }
    // Throw the opponent over the top rope to the floor.
    if (!this.cage && phase !== 'early' && def.bodyState === 'standing' && rng.chance(0.06)) {
      yield* this.perform(att, def, move('over_the_top'));
      yield* this.slide(def, this.floorSpot(def), 6);
      stage.crowd('pop');
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
    if (!ref.visible || ref.down || ref.moving || this.refDown || !this.a.inRing || !this.b.inRing) return;
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
    let popped = false;
    yield* stage.playMove(att, def, mv.keys, mv.id, mv.name, () => {
      this.hp.set(def.id, Math.max(0, (this.hp.get(def.id) ?? 100) - mv.damage));
      if (mv.big && !popped) {
        popped = true;
        stage.crowd('pop');
      }
    });
    stage.setBody(att, mv.result.att);
    stage.setBody(def, mv.result.def);
    this.recent.push(mv.id);
    // Call the move once it has landed (you see it, then you hear it), and leave the
    // line up long enough to read.
    stage.bus.emit({ type: 'narrated', text: said, style: mv.big ? 'big' : 'call' });
    yield readTime(said, mv.big ? 'big' : 'narrated') * 0.85;
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
    if (!att.inRing || !def.inRing) yield* this.backInRing(att, def);
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
    if (!att.inRing || !def.inRing) yield* this.backInRing(att, def);
    if (att.bodyState !== 'standing') yield* stage.getUp(att);
    const cv = move('cover');
    yield* this.perform(att, def, cv, coverText);
    stage.setPose(att, { lower: 'lying', rot: 90, upper: 'grab' });
    const ref = stage.ref;
    if (!ref.down) {
      yield* stage.walkTo(ref, clampToRing({ x: def.x + 1, depth: def.depth - 1 }), 'run');
      stage.setPose(ref, { lower: 'lying', rot: 90 });
    }
    // Near-falls always reach two: "1... 2... KICKOUT!" is the drama. The ref counts in
    // the coverer's color so it's obvious who is about to win.
    let count = '';
    for (const n of [1, 2] as const) {
      stage.bus.emit({ type: 'pinCount', count: n, kickout: false, coverer: att.id });
      count += `${n}... `;
      stage.blurt(ref, count.trim(), att.color);
      yield 0.9;
    }
    // Tag partners save their team from near-falls.
    const saver = !decisive && this.teams && this.inMatch(def) ? this.partnerOf(def) : undefined;
    if (saver && saver.visible && !saver.inRing && rng.chance(0.4)) {
      yield* this.stage.walkTo(saver, clampToRing({ x: att.x + 1.5, depth: att.depth }), 'run');
      stage.setBody(att, 'kneeling');
      yield* this.perform(saver, att, move('stomp'), line(rng, 'breakup', this.vars(saver, att)));
      stage.crowd('pop');
      if (!ref.down) stage.setBody(ref, 'standing');
      yield* this.stage.walkTo(saver, this.apronSpot(this.teamIndex(saver)));
      return;
    }
    stage.bus.emit({ type: 'pinCount', count: 3, kickout: !decisive, coverer: att.id });
    if (decisive) {
      stage.blurt(ref, `${count}3!!!`, att.color);
      yield 1.6;
    } else {
      stage.blurt(ref, `${count}— NO!`, att.color);
      stage.crowd('gasp');
      yield* stage.narrate(line(rng, 'kickout', this.vars(att, def)), 'big');
      stage.setBody(att, 'kneeling');
    }
    if (!ref.down) stage.setBody(ref, 'standing');
  }

  // ---------------------------------------------------------------- the floor

  private inMatch(x: Actor): boolean {
    return x === this.a || x === this.b;
  }

  /** A spot on the ringside floor by the ropes nearest to `near`. */
  floorSpot(near: Actor, offset = 0): Point {
    const r = arena.ring;
    const top = near.depth < (r.d0 + r.d1) / 2;
    return { x: Math.min(r.x1 - 1, Math.max(r.x0 + 1, near.x + offset)), depth: top ? arena.ringside.d0 : arena.ringside.d1 };
  }

  /** Just inside the ropes on the side where `x` is. */
  private ringEdge(x: Actor): Point {
    const r = arena.ring;
    return clampToRing({ x: x.x, depth: x.depth < (r.d0 + r.d1) / 2 ? r.d0 + 1 : r.d1 - 1 });
  }

  /** Climb out through the ropes to the floor. */
  *toFloor(x: Actor, spot: Point, pace: 'walk' | 'run' = 'walk'): Co {
    if (x.bodyState !== 'standing') yield* this.stage.getUp(x);
    this.stage.setPose(x, { lower: 'crouch', upper: 'grab' });
    yield* this.stage.walkTo(x, spot, pace);
  }

  /** Move someone without changing their pose (being rolled or thrown). */
  private *slide(x: Actor, to: Point, speed: number): Co {
    x.target = { ...to };
    x.speed = speed;
    yield () => x.target === null;
  }

  /** Whoever is in control rolls the other back in, then climbs in after them. */
  *backInRing(att: Actor, def: Actor): Co {
    const { stage, rng } = this;
    if (!def.inRing) {
      if (att.bodyState !== 'standing') yield* stage.getUp(att);
      if (!att.inRing) yield* this.approach(att, def, 1.5);
      yield* stage.narrate(line(rng, 'rollIn', this.vars(att, def)));
      stage.setBody(def, 'grounded');
      yield* this.slide(def, this.ringEdge(def), 4);
    }
    if (!att.inRing) {
      if (att.bodyState !== 'standing') yield* stage.getUp(att);
      stage.setPose(att, { lower: 'crouch', upper: 'grab' });
      yield* stage.walkTo(att, this.ringEdge(att));
      stage.setPose(att, att.basePose());
    }
    this.floorCount = 0;
    this.floorMoves = 0;
  }

  /** One exchange while at least one wrestler is on the floor. */
  private *floorExchange(phase: Phase): Co {
    const { stage, rng } = this;
    const att = this.pickAttacker(phase);
    const def = this.other(att);
    this.lastAttacker = att;
    if (att.bodyState !== 'standing') yield* stage.getUp(att, true);

    // The referee leans on the ropes and counts.
    const ref = stage.ref;
    this.floorCount += rng.int(1, 2);
    if (!this.refDown && !ref.down && ref.visible) {
      const lean = this.ringEdge(def.inRing ? att : def);
      if (Math.hypot(ref.x - lean.x, ref.depth - lean.depth) > 2) stage.spawn(stage.walkTo(ref, lean));
      if (this.floorCount >= 2) stage.blurt(ref, `${Math.min(this.floorCount, 8)}!`);
    }

    // Back in before the count gets dangerous.
    if (this.floorCount >= 6 || (this.floorMoves >= 2 && rng.chance(0.45))) {
      if (att.inRing && !def.inRing) yield* this.backInRing(att, def);
      else if (!att.inRing && def.inRing) {
        yield* stage.narrate(line(rng, 'breakCount', this.vars(att, def)));
        yield* this.backInRing(def, att);
      } else yield* this.backInRing(att, def);
      return;
    }
    if (att.inRing && !def.inRing) {
      // A heel may just wait and gloat; otherwise go out after them.
      if (att.alignment === 'heel' && rng.chance(0.35)) {
        yield* stage.gesture(att, { upper: 'point', head: 'shout' }, 1.2);
        yield* stage.narrate(line(rng, 'waitInRing', this.vars(att, def)));
        stage.crowd('boo');
        return;
      }
      yield* this.toFloor(att, this.floorSpot(def, att.x <= def.x ? -2 : 2), 'run');
      yield* stage.narrate(line(rng, 'chase', this.vars(att, def)));
    } else if (!att.inRing && def.inRing) {
      yield* stage.narrate(line(rng, 'breakCount', this.vars(att, def)));
      yield* this.backInRing(def, att);
      return;
    }

    // Both on the floor: guardrails, ring posts, steps, and (hardcore) tables.
    if (def.down) {
      if (rng.chance(0.5)) {
        yield* this.approach(att, def, 1.5);
        yield* stage.narrate(line(rng, 'pullUp', this.vars(att, def)));
      }
      yield* stage.getUp(def);
    }
    const state = def.bodyState === 'kneeling' ? 'standing' : def.bodyState;
    const pool = OUTSIDE_POOL.filter((m) => m.requires.def.includes(state) && (stage.hardcore || m.id !== 'table_bump'));
    if (!pool.length) return;
    const mv = rng.weighted(pool, (m) =>
      (m.kind === 'outside' ? 2 : 1) * (m.id === 'table_bump' ? 1.5 : 1) * (this.recent.slice(-4).includes(m.id) ? 0.1 : 1));
    yield* this.perform(att, def, mv);
    this.floorMoves++;
  }

  // ---------------------------------------------------------------- tag teams

  private teamIndex(x: Actor): 0 | 1 {
    return this.teams![0].includes(x) ? 0 : 1;
  }

  private partnerOf(x: Actor): Actor | undefined {
    return this.teams?.[this.teamIndex(x)].find((p) => p !== x);
  }

  /** Where the partner waits: on the apron outside their team's corner (opposite corners). */
  apronSpot(team: 0 | 1): Point {
    const r = arena.ring;
    return team === 0 ? { x: r.x0 - 1, depth: r.d0 + 1 } : { x: r.x1 + 1, depth: r.d1 - 1 };
  }

  private cornerSpot(team: 0 | 1): Point {
    const r = arena.ring;
    return team === 0 ? { x: r.x0 + 1.5, depth: r.d0 + 1 } : { x: r.x1 - 1.5, depth: r.d1 - 1 };
  }

  /** Before the bell: the partners who aren't starting take their places on the apron. */
  *partnersToApron(): Co {
    if (!this.teams) return;
    const moving = ([0, 1] as const).map((t) => {
      const partner = this.teams![t][1];
      return this.stage.spawn(this.stage.walkTo(partner, this.apronSpot(t)));
    });
    yield moving;
  }

  /** The legal man makes it to his corner and tags his partner in. */
  private *tag(team: 0 | 1, hot: boolean): Co {
    const { stage, rng } = this;
    const legal = team === 0 ? this.a : this.b;
    const partner = this.partnerOf(legal)!;
    if (legal.bodyState !== 'standing') yield* stage.getUp(legal, true);
    yield* stage.walkTo(legal, this.cornerSpot(team), 'stagger');
    stage.setPose(partner, { upper: 'arms_up', head: 'shout' });
    yield* stage.narrate(line(rng, hot ? 'hotTag' : 'tag', this.vars(legal, partner)), hot ? 'big' : 'call');
    if (team === 0) this.a = partner;
    else this.b = partner;
    const inward = { x: this.cornerSpot(team).x + (team === 0 ? 2 : -2), depth: this.cornerSpot(team).depth + (team === 0 ? 1 : -1) };
    yield [
      stage.spawn(stage.walkTo(legal, this.apronSpot(team))),
      stage.spawn(stage.walkTo(partner, clampToRing(inward), hot ? 'run' : 'walk')),
    ];
    stage.setBody(partner, 'standing');
    if (hot) {
      // The hot tag: the fresh babyface cleans house.
      this.hotTag = true;
      this.lastAttacker = partner;
      stage.crowd('pop');
      const opp = team === 0 ? this.b : this.a;
      for (const id of ['clothesline', 'punch', 'big_boot']) {
        if (opp.bodyState !== 'standing') yield* stage.getUp(opp);
        yield* this.perform(partner, opp, move(id));
      }
    }
  }

  /** Tags, hot tags and heel double-teams. Returns true if it used up the exchange. */
  private *tagTurn(phase: Phase): Generator<Wait, boolean, void> {
    const { stage, rng } = this;
    if (!this.teams || phase === 'early' || this.refDown) return false;
    for (const team of [0, 1] as const) {
      const legal = team === 0 ? this.a : this.b;
      const partner = this.partnerOf(legal)!;
      const hurt = (this.hp.get(legal.id) ?? 100) < (this.hp.get(partner.id) ?? 100) - 12;
      if (hurt && legal.inRing && !partner.inRing && rng.chance(phase === 'late' ? 0.35 : 0.2)) {
        const hot = !this.hotTag && phase === 'late' && partner.alignment !== 'heel';
        yield* this.tag(team, hot);
        return true;
      }
    }
    // Heels double-team while the referee is busy with the other corner.
    for (const team of [0, 1] as const) {
      const legal = team === 0 ? this.a : this.b;
      const partner = this.partnerOf(legal)!;
      const opp = team === 0 ? this.b : this.a;
      if (partner.alignment === 'heel' && !partner.inRing && legal.inRing && opp.inRing && rng.chance(0.07)) {
        yield* stage.narrate(line(rng, 'doubleTeam', this.vars(partner, opp)));
        if (opp.bodyState !== 'standing') yield* stage.getUp(opp);
        yield* this.perform(partner, opp, move(rng.pick(['forearm', 'kick_gut', 'eye_rake'])));
        if (legal.bodyState !== 'standing') yield* stage.getUp(legal);
        yield* this.perform(legal, opp, move(rng.pick(['clothesline', 'body_slam', 'neckbreaker'])));
        stage.crowd('boo');
        yield* stage.walkTo(partner, this.apronSpot(team));
        return true;
      }
    }
    return false;
  }

  /** Before the finish of a tag match: the man who scores the fall must be legal. */
  private *legalForFinish(): Co {
    if (!this.teams || !this.winner) return;
    const team = this.teamIndex(this.winner);
    const legal = team === 0 ? this.a : this.b;
    if (legal !== this.winner) yield* this.tag(team, false);
    this.loser = team === 0 ? this.b : this.a;
  }

  // ---------------------------------------------------------------- steel cage

  private *climbUp(x: Actor, heights: number[]): Co {
    for (const dy of heights) {
      this.stage.setPose(x, { lower: 'jump', upper: 'grab', head: 'look_up', dy });
      yield 0.7;
    }
  }

  /** Someone tries to climb out; the other drags them back in. */
  private *cageClimbAttempt(climber: Actor, stopper: Actor): Co {
    const { stage, rng } = this;
    if (climber.bodyState !== 'standing') yield* stage.getUp(climber);
    yield* stage.walkTo(climber, this.ringEdge(climber));
    yield* stage.narrate(line(rng, 'cageClimb', this.vars(climber, stopper)));
    yield* this.climbUp(climber, [1.5, 2.5]);
    if (stopper.bodyState !== 'standing') yield* stage.getUp(stopper, true);
    yield* this.approach(stopper, climber, 1);
    yield* stage.narrate(line(rng, 'cageDrag', this.vars(stopper, climber)), 'big');
    stage.setBody(climber, 'grounded');
    stage.crowd('pop');
  }

  /** The cage finish: the winner climbs over the top and drops to the floor. */
  private *escapeCage(w: Actor, l: Actor): Co {
    const { stage, rng } = this;
    if (!l.down) yield* this.hitFinisher(w, l);
    yield* stage.walkTo(w, this.ringEdge(w));
    yield* stage.narrate(line(rng, 'cageClimb', this.vars(w, l)));
    yield* this.climbUp(w, [1.5, 2.5, 3.5]);
    yield* stage.narrate(line(rng, 'cageTop', this.vars(w, l)), 'big');
    stage.crowd(w.alignment === 'heel' ? 'boo' : 'pop');
    stage.setBody(w, 'standing');
    yield* this.slide(w, this.floorSpot(w), 5);
    yield* stage.narrate(line(rng, 'cageEscape', this.vars(w, l)), 'big');
  }

  // ---------------------------------------------------------------- ladder

  private get ladder(): Prop | undefined {
    return this.stage.props.find((p) => p.kind === 'ladder');
  }

  /** Hang the prize and hide a ladder under the ring. */
  setUpLadderMatch(): void {
    const r = arena.ring;
    const title = this.spec.titleOnLine && this.spec.titleOnLine !== 'none' ? this.stage.titles.find((t) => t.id === this.spec.titleOnLine) : null;
    this.stage.prize = { name: title ? `the ${beltName(title.name)} championship` : 'the briefcase', taken: false };
    this.stage.props = [{ id: 'ladder', kind: 'ladder', x: r.x0 + 3, depth: arena.ringside.d1, state: 'under', by: null }];
  }

  private ringCenter(): Point {
    const r = arena.ring;
    return { x: (r.x0 + r.x1) / 2, depth: (r.d0 + r.d1) / 2 };
  }

  /** Out to the floor, a ladder from under the ring, back in, set up in the middle. */
  private *fetchLadder(x: Actor): Co {
    const { stage, rng } = this;
    const lad = this.ladder!;
    yield* this.toFloor(x, { x: lad.x, depth: arena.ringside.d1 }, 'run');
    lad.state = 'carried';
    lad.by = x.id;
    stage.crowd('pop');
    yield* stage.narrate(line(rng, 'ladderFetch', this.vars(x, this.other(x))));
    stage.setPose(x, { lower: 'crouch', upper: 'grab' });
    yield* stage.walkTo(x, this.ringEdge(x));
    yield* stage.walkTo(x, clampToRing({ x: this.ringCenter().x - 1, depth: this.ringCenter().depth }));
    Object.assign(lad, { state: 'up', by: null, ...this.ringCenter() });
    stage.setBody(x, 'standing');
    yield* stage.narrate(line(rng, 'ladderSetUp', this.vars(x, this.other(x))));
  }

  private *raiseLadder(x: Actor): Co {
    const lad = this.ladder!;
    if (x.bodyState !== 'standing') yield* this.stage.getUp(x);
    yield* this.stage.walkTo(x, clampToRing({ x: lad.x - 1, depth: lad.depth }));
    Object.assign(lad, { state: 'up', ...this.ringCenter() });
    yield* this.stage.narrate(line(this.rng, 'ladderSetUp', this.vars(x, this.other(x))));
  }

  private *climbLadder(x: Actor, heights: number[]): Co {
    const lad = this.ladder!;
    if (x.bodyState !== 'standing') yield* this.stage.getUp(x);
    yield* this.stage.walkTo(x, clampToRing({ x: lad.x - 0.6, depth: lad.depth }));
    yield* this.stage.narrate(line(this.rng, 'ladderClimb', this.vars(x, this.other(x), { P: this.stage.prize?.name ?? 'the prize' })));
    yield* this.climbUp(x, heights);
  }

  /** Ladder business during the match. Returns true if it used up the exchange. */
  private *ladderTurn(att: Actor, def: Actor, phase: Phase): Generator<Wait, boolean, void> {
    const { stage, rng } = this;
    const lad = this.ladder;
    if (!lad || !att.inRing || !def.inRing) return false;
    if (lad.state === 'under' && phase !== 'early' && rng.chance(0.35)) {
      yield* this.fetchLadder(att);
      return true;
    }
    if (lad.state === 'down' && rng.chance(0.3)) {
      yield* this.raiseLadder(att);
      return true;
    }
    if (lad.state === 'up' && def.bodyState === 'standing' && rng.chance(0.15)) {
      yield* this.perform(att, def, move('chair_shot'), line(rng, 'ladderShot', this.vars(att, def)));
      Object.assign(lad, { state: 'down', x: def.x, depth: def.depth });
      stage.crowd('gasp');
      return true;
    }
    if (lad.state === 'up' && rng.chance(0.3)) {
      // A climb that gets stopped: the finish decides who actually reaches the top.
      yield* this.climbLadder(att, [1, 2]);
      if (def.bodyState !== 'standing') yield* stage.getUp(def, true);
      yield* this.approach(def, att, 1);
      const tip = rng.chance(0.5);
      yield* stage.narrate(line(rng, tip ? 'ladderTip' : 'ladderPull', this.vars(def, att)), 'big');
      if (tip) Object.assign(lad, { state: 'down', x: lad.x + 2 });
      stage.setBody(att, 'grounded');
      stage.crowd('gasp');
      return true;
    }
    return false;
  }

  /** The ladder finish: the winner climbs all the way and pulls down the prize. */
  private *retrievePrize(w: Actor, l: Actor): Co {
    const { stage, rng } = this;
    const lad = this.ladder!;
    if (lad.state === 'under') yield* this.fetchLadder(w);
    if (lad.state !== 'up') yield* this.raiseLadder(w);
    if (!l.down) yield* this.hitFinisher(w, l);
    yield* this.climbLadder(w, [1, 2, 3, 3.5]);
    stage.setPose(w, { upper: 'arms_up', head: 'shout' });
    if (stage.prize) stage.prize.taken = true;
    stage.crowd(w.alignment === 'heel' ? 'boo' : 'pop');
    yield* stage.narrate(line(rng, 'ladderGrab', this.vars(w, l, { P: stage.prize?.name ?? 'the prize' })), 'big');
    stage.setBody(w, 'standing');
  }

  // ---------------------------------------------------------------- battle royal

  /** Where each entrant starts: spread over the ring. */
  static battleRoyalSpot(i: number): Point {
    const r = arena.ring;
    const cols = 5;
    return { x: r.x0 + 2.5 + (i % cols) * ((r.x1 - r.x0 - 5) / (cols - 1)), depth: r.d0 + 1 + (Math.floor(i / cols) % 3) * 1.5 };
  }

  /** Over the top rope to the floor; the booked winner is the last one left. */
  private *runBattleRoyal(): Co {
    const { stage, rng } = this;
    stage.blurt(stage.ref, 'Ring the bell!');
    stage.bus.emit({ type: 'bell' });
    yield* stage.narrate(line(rng, 'royalStart', {}), 'bell');
    const winner = this.winner ?? rng.pick(this.all);
    const order = rng.shuffle(this.all.filter((x) => x !== winner));
    const strikes = RANDOM_POOL.filter((m) => (m.kind === 'strike' || m.kind === 'grapple') && m.requires.def.includes('standing'));
    for (let i = 0; i < order.length; i++) {
      const phase: Phase = i < order.length / 3 ? 'early' : i < (2 * order.length) / 3 ? 'mid' : 'late';
      const next = this.pendingMoments(phase)[0];
      if (next) yield* this.speak(next);
      const alive = () => this.all.filter((x) => !this.eliminated.includes(x));
      // A flurry of brawling around the ring before each elimination.
      const flurry = i === order.length - 1 ? 3 : rng.int(1, 2);
      for (let k = 0; k < flurry; k++) {
        const [x, y] = i === order.length - 1 ? rng.shuffle([winner, order[i]]) : rng.shuffle(alive()).slice(0, 2);
        this.a = x;
        this.b = y;
        for (const p of [x, y]) if (p.bodyState !== 'standing') yield* stage.getUp(p);
        yield* this.perform(x, y, rng.pick(strikes));
      }
      const victim = order[i];
      const others = alive().filter((x) => x !== victim);
      const by = i === order.length - 1 || rng.chance(0.3) ? winner : rng.pick(others);
      this.a = by;
      this.b = victim;
      for (const p of [by, victim]) if (p.bodyState !== 'standing') yield* stage.getUp(p);
      yield* this.perform(by, victim, move('over_the_top'));
      yield* this.slide(victim, this.floorSpot(victim), 6);
      this.eliminated.push(victim);
      const remaining = this.all.length - this.eliminated.length;
      stage.bus.emit({ type: 'elimination', who: victim.id, by: by.id, remaining });
      stage.crowd(victim.alignment === 'heel' ? 'cheer' : 'boo');
      yield* stage.narrate(line(rng, remaining === 2 ? 'royalFinalTwo' : remaining === 1 ? 'royalWinner' : 'royalOut',
        this.vars(by, victim, { N: String(remaining) })), remaining <= 2 ? 'big' : 'call');
      // The eliminated wrestler heads to the back.
      stage.spawn((function* (): Co {
        yield 1.5;
        yield* stage.getUp(victim, true);
        yield* stage.goTo(victim, arena.curtain, 'walk');
        stage.vanish(victim);
      })());
    }
    this.loser = order.at(-1) ?? null;
    this.result = { winner: winner.id, loser: this.loser?.id ?? null, finish: 'elimination' };
  }

  // ---------------------------------------------------------------- finishes

  private finisherOf(x: Actor): { mv: Move; name: string } {
    const f = x.character?.finisher;
    if (f && f.name && hasMove(f.move)) return { mv: move(f.move), name: finisherName(f.name) };
    return { mv: move('piledriver'), name: 'piledriver' };
  }

  /** Hit the winner's finisher (or a big substitute when the finisher is a hold). */
  /** The setup call: the character's own call when the booker wrote one. */
  private finisherCallLine(w: Actor, l: Actor, name: string): string {
    const own = w.character?.finisher.call;
    return own && name === this.finisherOf(w).name ? own : line(this.rng, 'finisherCall', this.vars(w, l, { F: name }));
  }

  *hitFinisher(w: Actor, l: Actor): Co {
    const { stage, rng } = this;
    if (this.inMatch(w) && (!w.inRing || !l.inRing)) yield* this.backInRing(w, l);
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
    yield* stage.narrate(this.finisherCallLine(w, l, name), 'big');
    stage.crowd(w.alignment === 'heel' ? 'boo' : 'pop');
    // Own finisher with a description reads "Vega hits the Vegas Jackpot, a jumping DDT!"
    const desc = name === this.finisherOf(w).name ? w.character?.finisher.description : undefined;
    const hit = desc ? `${shortName(w)} hits the ${name}, ${desc}!` : line(rng, 'finisherHit', this.vars(w, l, { F: name.toUpperCase() }));
    yield* this.perform(w, l, mv, hit);
    this.stage.setBody(l, 'grounded');
  }

  private *finish(): Co {
    const { stage, rng, spec } = this;
    yield* this.legalForFinish();
    // Finishes happen in the ring: whoever wins rolls the other back in first.
    if (this.winner && (!this.a.inRing || !this.b.inRing)) yield* this.backInRing(this.winner, this.loser!);
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

    if (spec.finish === 'escape' && this.winner && this.loser) {
      yield* this.escapeCage(this.winner, this.loser);
      this.result = { winner: this.winner.id, loser: this.loser.id, finish: 'escape' };
      return;
    }
    if (spec.finish === 'retrieve' && this.winner && this.loser) {
      yield* this.retrievePrize(this.winner, this.loser);
      this.result = { winner: this.winner.id, loser: this.loser.id, finish: 'retrieve' };
      return;
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
        yield* stage.narrate(this.finisherCallLine(w, l, name), 'big');
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
        const [outL, outW] = arena.outside;
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

