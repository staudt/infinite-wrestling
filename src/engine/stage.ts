import type { Mood, NarrationStyle, Place } from '../schema/episode';
import { type Character, CREW_COLORS, crewOf, type Title, type World } from '../world/state';
import { attachColorCommentary } from '../choreo/commentary';
import { beltName } from '../choreo/lines';
import { distinctColor } from './colors';
import { Actor, type ActorKind, type Pace, SPEED } from './actor';
import { duration, impactTimes, type Keyframe, sample } from './anim';
import { arena, clampToRing, curtain, inRing, placePoint, type Point, ringEntry } from './arena';
import { type CrowdLevel, type EngineEvent, EventBus } from './events';
import type { BodyState, Pose } from './poses';
import { isHardcore } from '../world/genesis';
import { Rng } from './rng';
import { type Co, Scheduler, type Task } from './tasks';

export const TICK = 1 / 60;

export interface Prop {
  id: string;
  kind: 'ladder';
  x: number;
  depth: number;
  /** under = not visible yet; carried = moves with `by`; up = standing; down = lying flat. */
  state: 'under' | 'carried' | 'up' | 'down';
  by: string | null;
}
export const REF_ID = 'ref';
export const PBP_ID = '_pbp';
export const COLOR_ID = '_color';

/** Reading-time model: how long a line stays up before the show moves on. */
export function readTime(text: string, kind: 'said' | 'narrated' | 'big'): number {
  const words = text.trim().split(/\s+/).length;
  if (kind === 'said') return Math.min(7, 1.3 + words * 0.32);
  if (kind === 'big') return Math.min(5, 1.6 + words * 0.25);
  return Math.min(5, 0.9 + words * 0.24);
}

export class Stage {
  readonly sched = new Scheduler();
  readonly bus = new EventBus(() => this.sched.time);
  rng: Rng;
  readonly actors = new Map<string, Actor>();
  titles: Title[] = [];
  showName = '';
  shortName = '';
  /** Hardcore promotions: weapons are everywhere. */
  hardcore = false;
  /** A steel cage is lowered around the ring for the current match. */
  cage = false;
  /** Match props: the ladder in a ladder match. A carried prop follows its carrier. */
  props: Prop[] = [];
  /** What hangs above the ring in a ladder match ("the belt", "the briefcase"). */
  prize: { name: string; taken: boolean } | null = null;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.addActor(new Actor(REF_ID, 'Referee', 'ref', CREW_COLORS.ref, 'tweener', null, arena.refSpot));
    attachColorCommentary(this);
    this.bus.on((e) => {
      if (e.type === 'segmentStart' || e.type === 'episodeStart') this.billed.clear();
    });
  }

  get time(): number {
    return this.sched.time;
  }

  reseed(seed: number): void {
    this.rng = new Rng(seed);
  }

  on(fn: (e: EngineEvent) => void): () => void {
    return this.bus.on(fn);
  }

  /** Load the cast from a world. Existing actors keep their positions. */
  setCast(world: World): void {
    this.showName = world.showName;
    this.shortName = world.shortName;
    this.hardcore = isHardcore(world.direction);
    this.titles = world.titles.map((t) => ({ ...t }));
    // Guard against look-alike colors (older saves, hand-edited rosters): a new cast member
    // whose color is too close to someone already cast gets the most distinct free color.
    const used = [...Object.values(CREW_COLORS), ...[...this.actors.values()].filter((a) => !a.crew).map((a) => a.color)];
    const order = [...world.characters].sort((a, b) => Number(b.role === 'wrestler') - Number(a.role === 'wrestler'));
    for (const c of order) {
      const existing = this.actors.get(c.id);
      if (existing) {
        existing.alignment = c.alignment;
        continue;
      }
      const color = c.role === 'interviewer' ? CREW_COLORS.announcer : distinctColor(c.color, used);
      if (c.role !== 'interviewer') used.push(color);
      this.addActor(new Actor(c.id, c.name, c.role as ActorKind, color, c.alignment, c, curtain));
    }
    const crew = crewOf(world);
    for (const [id, name, color, at] of [
      [PBP_ID, crew.pbp, CREW_COLORS.pbp, arena.desk.pbp],
      [COLOR_ID, crew.color, CREW_COLORS.color, arena.desk.color],
    ] as const) {
      if (this.actors.get(id)?.name !== name) this.addActor(new Actor(id, name, 'commentator', color, 'tweener', null, at));
    }
  }

  private addActor(a: Actor): void {
    this.actors.set(a.id, a);
  }

  actor(id: string): Actor {
    const a = this.actors.get(id);
    if (!a) throw new Error(`unknown actor ${id}`);
    return a;
  }

  character(id: string): Character | null {
    return this.actors.get(id)?.character ?? null;
  }

  get ref(): Actor {
    return this.actor(REF_ID);
  }

  visibleActors(): Actor[] {
    return [...this.actors.values()].filter((a) => a.visible);
  }

  spawn(gen: Co): Task {
    return this.sched.spawn(gen);
  }

  /** Advance the simulation by one fixed tick. */
  update(dt = TICK): void {
    this.sched.tick(dt);
    for (const a of this.actors.values()) {
      if (a.anim) this.applyAnim(a);
      else if (a.target) this.applyMovement(a, dt);
    }
    for (const p of this.props) {
      const carrier = p.state === 'carried' && p.by ? this.actors.get(p.by) : null;
      if (carrier) {
        p.x = carrier.x + carrier.facing;
        p.depth = carrier.depth;
      }
    }
  }

  /** "World Heavyweight" for a champion, else null. */
  titleOf(a: Actor): string | null {
    const t = this.titles.find((x) => x.holder === a.id);
    if (!t) return null;
    const belt = beltName(t.name);
    return this.shortName && belt.startsWith(`${this.shortName} `) ? belt.slice(this.shortName.length + 1) : belt;
  }

  private billed = new Set<string>();

  /**
   * How the desk refers to someone. Champions get their title ("World Heavyweight
   * champion Razor Edge") the first time they come up in a segment, and now and then
   * after, so it's always clear who holds the gold and who is chasing it.
   */
  called(a: Actor): string {
    const short = a.name.replace(/"[^"]*"\s*/g, '').trim();
    const title = this.titleOf(a);
    if (!title || (this.billed.has(a.id) && !this.rng.chance(0.12))) return short;
    this.billed.add(a.id);
    return `${title} champion ${short}`;
  }

  get pbp(): Actor {
    return this.actor(PBP_ID);
  }

  get colorGuy(): Actor {
    return this.actor(COLOR_ID);
  }

  /** The ring announcer / interviewer (the world's interviewer character). */
  get announcer(): Actor | null {
    for (const a of this.actors.values()) if (a.kind === 'interviewer') return a;
    return null;
  }

  /** A quick line with no reading pause (pin counts, ref calls). */
  blurt(a: Actor, text: string, tint?: string): void {
    this.bus.emit({ type: 'said', who: a.id, text, mood: 'excited', ...(tint ? { tint } : {}) });
  }

  /** Run a coroutine to completion without rendering (headless preview, tests). */
  runToEnd(gen: Co, maxSeconds = 60 * 60 * 3): void {
    const task = this.spawn(gen);
    const limit = this.time + maxSeconds;
    while (!task.done) {
      if (this.time > limit) throw new Error('show did not finish in time');
      this.update();
    }
  }

  // ------------------------------------------------------------------ state helpers

  setPose(a: Actor, pose: Partial<Pose>): void {
    const next = { ...a.pose, ...pose };
    if (
      next.head === a.pose.head && next.upper === a.pose.upper && next.lower === a.pose.lower &&
      next.rot === a.pose.rot && next.dy === a.pose.dy
    ) return;
    a.pose = next;
    this.bus.emit({ type: 'poseChanged', id: a.id, pose: { ...next }, bodyState: a.bodyState });
  }

  setBody(a: Actor, state: BodyState): void {
    a.bodyState = state;
    a.pose = a.basePose();
    this.bus.emit({ type: 'poseChanged', id: a.id, pose: { ...a.pose }, bodyState: a.bodyState });
  }

  face(a: Actor, toward: Actor | Point): void {
    const x = toward instanceof Actor ? toward.x : toward.x;
    if (Math.abs(x - a.x) > 0.05) a.facing = x > a.x ? 1 : -1;
    if (toward instanceof Actor) a.lookingAt = toward.id;
  }

  appear(a: Actor, at: Point = curtain): void {
    if (a.visible) return;
    a.visible = true;
    a.x = at.x;
    a.depth = at.depth;
    a.target = null;
    a.anim = null;
    a.holdsMic = false;
    a.bodyState = 'standing';
    a.pose = a.basePose();
    this.bus.emit({ type: 'spawn', id: a.id });
  }

  vanish(a: Actor): void {
    if (!a.visible) return;
    a.visible = false;
    a.target = null;
    a.anim = null;
    a.holdsMic = false;
    a.speaking = false;
    this.bus.emit({ type: 'despawn', id: a.id });
  }

  crowd(level: CrowdLevel, chant?: string): void {
    this.bus.emit({ type: 'crowd', level, ...(chant ? { chant } : {}) });
  }

  camera(...ids: string[]): void {
    this.bus.emit({ type: 'camera', focus: ids });
  }

  // ------------------------------------------------------------------ coroutine primitives

  *pause(seconds: number): Co {
    yield seconds;
  }

  *narrate(text: string, style: NarrationStyle | 'info' | 'bell' | 'count' = 'call'): Co {
    this.bus.emit({ type: 'narrated', text, style });
    yield readTime(text, style === 'big' || style === 'shock' ? 'big' : 'narrated');
  }

  *say(a: Actor, text: string, mood: Mood = 'calm'): Co {
    a.speaking = true;
    const loud = mood === 'angry' || mood === 'furious' || mood === 'crazy' || mood === 'excited';
    this.setPose(a, { head: loud ? 'shout' : 'neutral', upper: a.holdsMic ? 'mic' : loud ? 'point' : a.pose.upper });
    this.bus.emit({ type: 'said', who: a.id, text, mood });
    yield readTime(text, 'said');
    a.speaking = false;
    if (a.bodyState === 'standing' && !a.anim) this.setPose(a, { head: 'neutral', upper: a.holdsMic ? 'mic' : 'idle' });
  }

  *walkTo(a: Actor, p: Point, pace: Pace = 'walk'): Co {
    const dest = inRing(p) && a.inRing ? clampToRing(p) : p;
    if (Math.hypot(dest.x - a.x, dest.depth - a.depth) < 0.1) return;
    a.target = { ...dest };
    a.speed = SPEED[pace];
    this.setPose(a, { lower: pace === 'run' ? 'run' : 'walk', rot: 0, dy: 0 });
    yield () => a.target === null;
  }

  /** Walk anywhere, climbing through the ropes when crossing into or out of the ring. */
  *goTo(a: Actor, dest: Point | Place, pace: Pace = 'walk', slot = 0): Co {
    const p = typeof dest === 'string' ? placePoint(dest, slot) : dest;
    if (!a.visible) this.appear(a);
    const wantRing = inRing(p);
    if (a.inRing && !wantRing) {
      yield* this.walkTo(a, { x: arena.ring.x0 + 1.5, depth: ringEntry.depth }, pace);
      yield* this.exitRing(a);
    }
    if (!a.inRing && wantRing) {
      yield* this.walkTo(a, ringEntry, pace);
      yield* this.enterRing(a, pace === 'run');
    }
    yield* this.walkTo(a, p, pace);
  }

  *enterRing(a: Actor, quick = false): Co {
    this.setPose(a, { lower: 'crouch', upper: 'grab' });
    a.target = { x: arena.ring.x0 + 1.5, depth: ringEntry.depth };
    a.speed = quick ? 5 : 3;
    yield () => a.target === null;
    this.setPose(a, { lower: 'stand', upper: 'idle' });
  }

  *exitRing(a: Actor): Co {
    this.setPose(a, { lower: 'crouch', upper: 'grab' });
    a.target = { ...ringEntry };
    a.speed = 3;
    yield () => a.target === null;
    this.setPose(a, { lower: 'stand', upper: 'idle' });
  }

  /** Hold a pose for a while, then settle back to the body state's resting pose. */
  *gesture(a: Actor, pose: Partial<Pose>, seconds: number): Co {
    this.setPose(a, pose);
    yield seconds;
    if (!a.anim) this.setPose(a, a.basePose());
  }

  *knockdown(a: Actor): Co {
    a.target = null;
    this.setBody(a, 'grounded');
    yield 0.2;
  }

  *getUp(a: Actor, slow = false): Co {
    if (a.bodyState === 'standing') return;
    this.setPose(a, { lower: 'kneel', rot: 0, head: 'hurt' });
    a.bodyState = 'kneeling';
    yield slow ? 1.4 : 0.7;
    this.setBody(a, 'standing');
    yield 0.2;
  }

  /**
   * Play a two-person keyframed move. Both actors are positioned relative to the
   * attacker's starting spot; `onImpact` fires at each impact key (damage, narration).
   */
  *playMove(att: Actor, def: Actor, keys: Keyframe[], moveId: string, name: string, onImpact: () => Co | void): Co {
    const origin = att.pos;
    const facing = att.facing;
    def.facing = facing === 1 ? -1 : 1;
    att.target = null;
    def.target = null;
    att.anim = { keys, track: 'att', start: this.time, origin, facing };
    def.anim = { keys, track: 'def', start: this.time, origin, facing };
    this.bus.emit({ type: 'moveStarted', att: att.id, def: def.id, move: moveId, name });
    let last = 0;
    for (const t of impactTimes(keys)) {
      yield t - last;
      last = t;
      this.bus.emit({ type: 'moveImpact', att: att.id, def: def.id, move: moveId });
      const r = onImpact();
      if (r) yield* r;
    }
    yield Math.max(0, duration(keys) - last);
    att.anim = null;
    def.anim = null;
    this.bus.emit({ type: 'moveEnded', att: att.id, def: def.id, move: moveId });
  }

  // ------------------------------------------------------------------ per-tick physics

  private applyMovement(a: Actor, dt: number): void {
    const t = a.target!;
    const dx = t.x - a.x;
    const dd = t.depth - a.depth;
    const dist = Math.hypot(dx, dd);
    const step = a.speed * dt;
    if (Math.abs(dx) > 0.05) a.facing = dx > 0 ? 1 : -1;
    if (dist <= step) {
      a.x = t.x;
      a.depth = t.depth;
      a.target = null;
      if (a.bodyState === 'standing') this.setPose(a, { lower: 'stand' });
      return;
    }
    a.x += (dx / dist) * step;
    a.depth += (dd / dist) * step;
  }

  private applyAnim(a: Actor): void {
    const anim = a.anim!;
    const s = sample(anim.keys, anim.track, this.time - anim.start);
    this.setPose(a, {
      ...(s.head ? { head: s.head } : {}),
      ...(s.upper ? { upper: s.upper } : {}),
      ...(s.lower ? { lower: s.lower } : {}),
      ...(s.rot !== undefined ? { rot: Math.round(s.rot) } : {}),
      ...(s.dy !== undefined ? { dy: Math.round(s.dy * 10) / 10 } : {}),
    });
    if (s.dx !== undefined) {
      const p = { x: anim.origin.x + anim.facing * s.dx, depth: anim.origin.depth };
      // Moves stay inside the ropes, or on the ringside floor when they start out there.
      const rs = arena.ringside;
      const onFloor = !inRing(anim.origin) && anim.origin.x >= rs.x0 && anim.origin.x <= rs.x1;
      const q = inRing(anim.origin) ? clampToRing(p) : onFloor ? { x: Math.min(rs.x1, Math.max(rs.x0, p.x)), depth: p.depth } : p;
      a.x = q.x;
      a.depth = q.depth;
    }
  }
}
