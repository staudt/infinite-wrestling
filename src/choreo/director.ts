// The choreographer: turns booked beats (WHAT happens) into staged action (HOW it
// happens). Each beat type has a few randomized realizations so repeated angles
// still play out differently.
import type { Actor, Pace } from '../engine/actor';
import { arena, curtain, placePoint, type Point, ringEntry } from '../engine/arena';
import type { Stage } from '../engine/stage';
import type { Co } from '../engine/tasks';
import type { BeatOf, Episode, Mood, Place, Reaction, Segment, Spot } from '../schema/episode';
import { MatchSim, shortName } from '../sim/match';
import { move } from '../sim/moves';
import { titleOutcome } from '../world/apply';
import { beltName, line, type LineKey } from './lines';

const REACTION_POSE: Record<Reaction, { head: 'shout' | 'hurt' | 'look_up' | 'neutral'; upper: 'hurt' | 'arms_up' | 'point' | 'idle' | 'guard' }> = {
  shock: { head: 'look_up', upper: 'guard' },
  laugh: { head: 'shout', upper: 'point' },
  anger: { head: 'shout', upper: 'guard' },
  cry: { head: 'hurt', upper: 'hurt' },
  faint: { head: 'hurt', upper: 'hurt' },
  cheer: { head: 'shout', upper: 'arms_up' },
  smirk: { head: 'neutral', upper: 'idle' },
  disbelief: { head: 'look_up', upper: 'hurt' },
};

const FIGHT_SPEC = {
  wrestlers: ['', ''], winner: 'none', finish: 'no_contest', story: 'even', length: 'short', spots: [],
} as const;

export class Director {
  private segIndex = 0;

  constructor(
    private stage: Stage,
    private episode: Episode,
    private number: number,
  ) {}

  private get rng() {
    return this.stage.rng;
  }

  private get(id: string): Actor | null {
    return this.stage.actors.get(id) ?? null;
  }

  private nm(a: Actor): string {
    return shortName(a);
  }

  private say(key: LineKey, a?: Actor | null, d?: Actor | null, extra: Record<string, string> = {}): string {
    return line(this.rng, key, {
      ...(a ? { A: this.nm(a) } : {}),
      ...(d ? { D: this.nm(d) } : {}),
      S: this.stage.showName,
      ...extra,
    });
  }

  private interviewer(): Actor | null {
    return [...this.stage.actors.values()].find((a) => a.kind === 'interviewer') ?? null;
  }

  // ---------------------------------------------------------------- episode flow

  *play(): Co {
    const { stage } = this;
    stage.bus.emit({ type: 'episodeStart', number: this.number, title: this.episode.title });
    const lance = this.interviewer();
    if (lance) stage.appear(lance, arena.podium.interviewer);
    yield* stage.narrate(this.say('showOpen'), 'big');
    stage.crowd('pop');
    yield 1;
    for (const seg of this.episode.segments) {
      yield* this.segment(seg);
    }
    yield* stage.narrate(this.say('showClose'), 'big');
    yield 2;
    for (const a of stage.visibleActors()) stage.vanish(a);
    stage.bus.emit({ type: 'episodeEnd', number: this.number });
  }

  private *segment(seg: Segment): Co {
    const { stage } = this;
    const index = this.segIndex++;
    stage.bus.emit({ type: 'segmentStart', index, title: seg.title });
    yield 1.2;
    for (const beat of seg.beats) {
      yield* this.beat(beat);
      yield this.rng.range(0.4, 1.0);
    }
    if (index < this.episode.segments.length - 1) {
      yield* stage.narrate(this.say('commercial'), 'info');
    }
    yield 1;
    // Cut to break: everyone but the interviewer is cleared off camera.
    for (const a of stage.visibleActors()) {
      if (a.kind !== 'interviewer') stage.vanish(a);
    }
    const lance = this.interviewer();
    if (lance && !lance.visible) stage.appear(lance, arena.podium.interviewer);
    if (lance) {
      lance.x = arena.podium.interviewer.x;
      lance.depth = arena.podium.interviewer.depth;
      stage.setBody(lance, 'standing');
    }
    stage.bus.emit({ type: 'segmentEnd', index, recap: seg.recap });
  }

  *beat(b: Segment['beats'][number]): Co {
    switch (b.type) {
      case 'entrance': return yield* this.entrance(b);
      case 'promo': return yield* this.promo(b);
      case 'interview': return yield* this.interview(b);
      case 'confrontation': return yield* this.confrontation(b);
      case 'attack': return yield* this.attack(b);
      case 'match': return yield* this.match(b);
      case 'interrupt': return yield* this.interrupt(b);
      case 'run_in': return yield* this.runIn(b);
      case 'reveal': return yield* this.reveal(b);
      case 'turn': return yield* this.turn(b);
      case 'react': return yield* this.react(b);
      case 'celebrate': return yield* this.celebrate(b);
      case 'exit': return yield* this.exit(b);
      case 'narrate': {
        if (b.style === 'shock') this.stage.crowd('gasp');
        return yield* this.stage.narrate(b.text, b.style);
      }
    }
  }

  // ---------------------------------------------------------------- positioning

  /** A free standing spot for a place, avoiding people already there. */
  private freeSpot(place: Place, self?: Actor): Point {
    const taken = this.stage.visibleActors().filter((a) => a !== self && a.kind !== 'ref');
    for (let slot = 0; slot < 6; slot++) {
      const p = placePoint(place, slot);
      if (!taken.some((a) => Math.hypot(a.x - p.x, a.depth - p.depth) < 2.5)) return p;
    }
    return placePoint(place, this.rng.int(0, 5));
  }

  /** Music hits: the character appears at the curtain as the call is made. */
  private *musicHit(a: Actor, interrupt = false): Co {
    const { stage } = this;
    stage.bus.emit({ type: 'music', who: a.id });
    stage.appear(a, curtain);
    stage.camera(a.id);
    const flavor = a.character?.entrance || 'to a roar from the crowd';
    yield* stage.narrate(
      interrupt ? this.say('musicInterrupt', a) : this.say('music', a, null, { E: flavor }),
      interrupt ? 'big' : 'call',
    );
    stage.crowd(a.alignment === 'heel' ? 'boo' : a.alignment === 'face' ? 'cheer' : 'buzz');
  }

  /** Get someone to a place, making an entrance first if they are backstage. */
  private *bring(a: Actor, place: Place, pace: Pace = 'walk', interrupt = false): Co {
    const { stage } = this;
    if (!a.visible && a.kind !== 'interviewer') {
      // Walk out while the announcer makes the call.
      stage.appear(a, curtain);
      const walking = stage.spawn(stage.goTo(a, this.freeSpot(place, a), pace));
      yield* this.musicHit(a, interrupt);
      yield [walking];
      return;
    }
    if (a.bodyState !== 'standing') yield* stage.getUp(a);
    yield* stage.goTo(a, this.freeSpot(place, a), pace);
  }

  private fight(a: Actor, b: Actor): MatchSim {
    return new MatchSim(this.stage, { ...FIGHT_SPEC, wrestlers: [a.id, b.id], spots: [] }, function* () {});
  }

  private moodFor(a: Actor, text: string): Mood {
    if (a.kind === 'interviewer') return 'calm';
    const loud = (text.match(/!/g) ?? []).length;
    if (loud >= 2) return a.alignment === 'heel' ? 'furious' : 'excited';
    if (loud === 1) return a.alignment === 'heel' ? 'cocky' : 'angry';
    return a.alignment === 'heel' ? 'smug' : 'calm';
  }

  // ---------------------------------------------------------------- beats

  private *entrance(b: BeatOf<'entrance'>): Co {
    const { stage, rng } = this;
    const a = this.get(b.who);
    if (!a) return;
    if (a.visible) {
      if (!a.inRing) yield* stage.goTo(a, this.freeSpot('ring', a));
      return;
    }
    const style = a.character?.style;
    const angry = b.mood === 'angry' || b.mood === 'furious' || b.mood === 'crazy';
    const variant = rng.weighted(['classic', 'sprint', 'pose'] as const, (v) =>
      v === 'classic' ? 3 : v === 'sprint' ? (angry || style === 'brawler' ? 3 : 0.5) : style === 'showman' || b.mood === 'cocky' ? 3 : 1,
    );
    yield* this.musicHit(a);
    const escorts = b.escorts.map((id) => this.get(id)).filter((e): e is Actor => !!e && !e.visible);
    escorts.forEach((e, i) => stage.appear(e, { x: curtain.x - 1, depth: curtain.depth + (i % 2 ? -1.5 : 1.5) }));

    if (variant === 'pose') {
      yield* stage.walkTo(a, placePoint('stage'));
      yield* stage.gesture(a, { upper: 'arms_up', head: 'shout' }, 1.5);
      yield* stage.narrate(this.say('stagePose', a));
    }
    const pace: Pace = variant === 'sprint' ? 'run' : a.alignment === 'heel' && style === 'showman' ? 'strut' : 'walk';
    const walking = stage.spawn(stage.goTo(a, this.freeSpot('ring', a), pace));
    const escorting = escorts.map((e, i) =>
      stage.spawn(stage.goTo(e, { x: ringEntry.x - 1 - i, depth: 1.5 + i * 2 }, pace)),
    );
    if (variant === 'sprint') yield* stage.narrate(this.say('sprint', a));
    else yield* stage.narrate(this.say(a.alignment === 'heel' ? 'walkHeel' : 'walkFace', a));
    yield [walking, ...escorting];
    if (rng.chance(0.35)) {
      yield* stage.gesture(a, { upper: 'arms_up', head: 'shout' }, 1.5);
      yield* stage.narrate(this.say('turnbucklePose', a));
    }
  }

  private *promo(b: BeatOf<'promo'>): Co {
    const { stage, rng } = this;
    const a = this.get(b.who);
    if (!a) return;
    yield* this.bring(a, b.where);
    stage.camera(a.id);
    if (rng.chance(0.4)) yield* stage.narrate(this.say('mic', a));
    a.holdsMic = true;
    stage.setPose(a, { upper: 'mic' });
    for (let i = 0; i < b.lines.length; i++) {
      yield* stage.say(a, b.lines[i], b.mood);
      if (i < b.lines.length - 1 && rng.chance(0.3)) {
        stage.crowd(a.alignment === 'heel' ? 'boo' : 'cheer');
        if (b.where === 'ring' && rng.chance(0.5)) {
          yield* stage.walkTo(a, this.freeSpot('ring', a), 'walk');
        }
      }
    }
    a.holdsMic = false;
    stage.setBody(a, 'standing');
    stage.crowd(a.alignment === 'heel' ? 'boo' : 'pop');
  }

  private *interview(b: BeatOf<'interview'>): Co {
    const { stage, rng } = this;
    const guest = this.get(b.guest);
    const lance = this.interviewer();
    if (!guest) return;
    if (rng.chance(0.4)) yield* stage.narrate(this.say('interviewIntro'), 'info');
    if (!guest.visible) {
      stage.appear(guest, curtain);
      yield* stage.goTo(guest, arena.podium.guest);
    } else {
      yield* stage.goTo(guest, arena.podium.guest);
    }
    stage.camera(guest.id, ...(lance ? [lance.id] : []));
    if (lance) {
      stage.face(lance, guest);
      stage.face(guest, lance);
    }
    for (const l of b.exchange) {
      const sp = this.get(l.speaker);
      if (!sp) continue;
      if (!sp.visible) {
        // Someone new barges into the interview.
        yield* this.musicHit(sp, true);
        yield* stage.goTo(sp, { x: arena.podium.guest.x + 3, depth: arena.podium.guest.depth + 1 }, 'run');
        stage.face(sp, guest);
        stage.face(guest, sp);
      }
      yield* stage.say(sp, l.text, this.moodFor(sp, l.text));
    }
    if (lance && guest.alignment === 'heel' && rng.chance(0.25)) {
      yield* this.fight(guest, lance).perform(guest, lance, move('slap'), this.say('interviewShove', guest));
      stage.setBody(lance, 'standing');
      yield* stage.goTo(guest, curtain, 'walk');
      stage.vanish(guest);
    }
  }

  private *confrontation(b: BeatOf<'confrontation'>): Co {
    const { stage, rng } = this;
    const a = this.get(b.a);
    const d = this.get(b.b);
    if (!a || !d) return;
    yield* this.bring(a, b.where);
    yield* this.bring(d, b.where, 'walk', true);
    // Nose to nose.
    const face = { x: a.x + (d.x >= a.x ? 2 : -2), depth: a.depth };
    yield* stage.walkTo(d, face);
    stage.face(a, d);
    stage.face(d, a);
    stage.camera(a.id, d.id);
    for (const l of b.exchange) {
      const sp = this.get(l.speaker);
      if (!sp) continue;
      if (!sp.visible) yield* this.bring(sp, b.where, 'run', true);
      yield* stage.say(sp, l.text, this.moodFor(sp, l.text));
    }
    const f = this.fight(a, d);
    switch (b.escalation) {
      case 'stare_down':
        stage.crowd('buzz');
        yield* stage.narrate(this.say('stareDown', a, d));
        break;
      case 'shove': {
        const [x, y] = rng.chance(0.5) ? [a, d] : [d, a];
        stage.setPose(x, { upper: 'grab' });
        yield* stage.narrate(this.say('shove', x, y));
        yield* stage.walkTo(y, { x: y.x + (y.x >= x.x ? 2.5 : -2.5), depth: y.depth }, 'stagger');
        stage.setBody(x, 'standing');
        stage.crowd('pop');
        break;
      }
      case 'slap': {
        const [x, y] = a.alignment === 'heel' ? [a, d] : [d, a];
        yield* f.perform(x, y, move('slap'), this.say('slapFace', x, y));
        stage.crowd('gasp');
        break;
      }
      case 'brawl':
      case 'separated': {
        yield* stage.narrate(this.say('brawl', a, d), 'big');
        stage.crowd('pop');
        const rounds = b.escalation === 'separated' ? 2 : rng.int(3, 4);
        for (let i = 0; i < rounds; i++) {
          const [x, y] = rng.chance(0.5) ? [a, d] : [d, a];
          if (x.bodyState !== 'standing') yield* stage.getUp(x);
          if (y.bodyState === 'grounded' && rng.chance(0.5)) yield* stage.getUp(y);
          yield* f.perform(x, y, this.brawlMove(y));
        }
        if (b.escalation === 'separated') {
          yield* stage.narrate(this.say('separated', a, d));
          for (const p of [a, d]) if (p.bodyState !== 'standing') yield* stage.getUp(p);
          const ta = stage.spawn(stage.walkTo(a, { x: a.x - 3, depth: a.depth }, 'walk'));
          const td = stage.spawn(stage.walkTo(d, { x: d.x + 3, depth: d.depth }, 'walk'));
          yield [ta, td];
        }
        break;
      }
    }
  }

  private brawlMove(def: Actor) {
    const ids = def.down ? ['stomp', 'elbow_drop', 'stomp'] : ['punch', 'forearm', 'headbutt', 'clothesline', 'kick_gut', 'punch'];
    return move(this.rng.pick(ids));
  }

  /** Walk/run the attackers over to the victim, sneaking when attacking from behind. */
  private *converge(attackers: Actor[], victim: Actor, sneak: boolean): Co {
    const { stage } = this;
    for (const x of attackers) {
      if (!x.visible) stage.appear(x, curtain);
    }
    if (sneak) {
      stage.face(victim, victim.x < 40 ? { x: 0, depth: victim.depth } : { x: 78, depth: victim.depth });
      yield* stage.narrate(this.say('sneak', attackers[0], victim));
    }
    const moving = attackers.map((x, i) => {
      const side = victim.facing === 1 ? -1 : 1; // come from behind
      const p = { x: victim.x + side * (2 + i), depth: victim.depth + (i % 2 ? 1 : 0) };
      return stage.spawn(stage.goTo(x, p, 'run'));
    });
    yield moving;
  }

  private *attack(b: BeatOf<'attack'>): Co {
    const { stage, rng } = this;
    const victim = this.get(b.victim);
    const attackers = b.attackers.map((id) => this.get(id)).filter((x): x is Actor => !!x && x !== victim);
    if (!victim || !attackers.length) return;
    if (!victim.visible) yield* this.bring(victim, b.where);
    stage.camera(victim.id, ...attackers.map((x) => x.id));
    yield* this.converge(attackers, victim, b.style === 'from_behind');
    stage.crowd('gasp');
    const lead = attackers[0];
    const f = this.fight(lead, victim);
    if (victim.bodyState !== 'standing' && b.style !== 'beatdown') yield* stage.getUp(victim);
    yield* f.perform(lead, victim, move(victim.down ? 'stomp' : 'forearm'), this.say('ambush', lead, victim));
    const hits = b.style === 'beatdown' ? rng.int(3, 4) : rng.int(1, 2);
    for (let i = 0; i < hits; i++) {
      const x = attackers[i % attackers.length];
      if (x.bodyState !== 'standing') yield* stage.getUp(x);
      yield* f.perform(x, victim, this.brawlMove(victim));
      if (i === 1) yield* stage.narrate(this.say('beatdown', x, victim));
    }
    if (b.style === 'weapon') {
      yield* stage.narrate(this.say('weapon', lead));
      if (victim.bodyState === 'grounded') yield* stage.getUp(victim);
      yield* f.weaponShot(lead, victim);
    } else if (b.style === 'finisher') {
      const mf = this.fight(lead, victim);
      yield* mf.hitFinisher(lead, victim);
    }
    stage.setBody(victim, 'grounded');
    for (const x of attackers) if (x.bodyState !== 'standing') yield* stage.getUp(x);
    yield* stage.narrate(this.say('standOver', lead, victim));
    stage.crowd(lead.alignment === 'heel' ? 'boo' : 'cheer');
  }

  private *match(b: BeatOf<'match'>): Co {
    const { stage, rng } = this;
    const [a, d] = b.wrestlers.map((id) => this.get(id));
    if (!a || !d) return;
    // The heel (or the first-named) comes out first, the babyface last.
    const order = a.alignment === 'face' && d.alignment !== 'face' ? [d, a] : [a, d];
    for (const w of order) {
      if (!w.visible) yield* this.entrance({ type: 'entrance', who: w.id, mood: 'calm', escorts: [] });
      else if (!w.inRing) yield* stage.goTo(w, this.freeSpot('ring', w));
      if (w.bodyState !== 'standing') yield* stage.getUp(w);
    }
    const ref = stage.ref;
    stage.appear(ref, arena.refSpot);
    const title = b.titleOnLine !== 'none' ? stage.titles.find((t) => t.id === b.titleOnLine) ?? null : null;
    stage.bus.emit({ type: 'matchStart', wrestlers: [a.id, d.id], title: title?.id ?? null });
    stage.camera(a.id, d.id);
    if (title) yield* stage.narrate(this.say('titleIntro', a, d, { T: title.name }), 'big');
    // Square off in opposite halves of the ring.
    yield [
      stage.spawn(stage.walkTo(a, arena.ringSpots[0])),
      stage.spawn(stage.walkTo(d, arena.ringSpots[1])),
    ];
    stage.face(a, d);
    stage.face(d, a);

    const sim = new MatchSim(stage, b, (spot, m) => this.spot(spot, m));
    yield* sim.run();
    const r = sim.result!;
    yield 1;
    if (r.winner) {
      const w = this.get(r.winner)!;
      const how = r.finish === 'dq' ? 'disqualification' : r.finish === 'countout' ? 'count-out' : r.finish === 'submission' ? 'submission' : 'pinfall';
      yield* stage.narrate(this.say('winner', null, null, { W: w.name, how }), 'big');
      if (title) {
        const outcome = titleOutcome(title.holder, w.id, r.finish);
        if (outcome === 'retain') {
          yield* stage.narrate(this.say('retain', null, null, { W: this.nm(w), T: beltName(title.name) }), 'big');
        } else if (outcome === 'new_champion') {
          title.holder = w.id;
          stage.bus.emit({ type: 'titleChange', title: title.id, newChampion: w.id });
          stage.crowd(w.alignment === 'heel' ? 'boo' : 'pop');
          yield* stage.narrate(this.say('newChamp', null, null, { W: this.nm(w), T: beltName(title.name) }), 'big');
        } else {
          yield* stage.narrate(this.say('titleNoChange', null, null, { W: this.nm(w), how }), 'call');
        }
      }
      if (w.bodyState !== 'standing') yield* stage.getUp(w);
      if (rng.chance(0.6)) {
        yield* stage.gesture(w, { upper: 'arms_up', head: 'shout' }, 1.5);
        stage.crowd(w.alignment === 'heel' ? 'boo' : 'cheer');
      }
    }
    stage.vanish(ref);
  }

  /** Is `who` on the same side as participant `p`? */
  private allied(whoId: string, p: Actor): boolean {
    const who = this.get(whoId);
    if (!who) return false;
    return who.alignment === p.alignment && p.alignment !== 'tweener';
  }

  private *spot(spot: Spot, m: MatchSim): Co {
    const { stage, rng } = this;
    const who = this.get(spot.who);
    if (!who) return;
    const inMatch = who === m.a || who === m.b;
    const targetIn = spot.target === m.a.id ? m.a : spot.target === m.b.id ? m.b : null;
    // The participant the spot works against, and the one who benefits.
    const victim = inMatch
      ? m.other(who)
      : targetIn ?? (this.allied(who.id, m.a) ? m.b : this.allied(who.id, m.b) ? m.a : (m.loser ?? m.b));
    const helped = m.other(victim);
    const mood: Mood = who.alignment === 'heel' ? 'cocky' : 'angry';

    switch (spot.type) {
      case 'interrupt': {
        if (inMatch) return;
        yield* this.bring(who, 'stage', 'walk', true);
        for (const x of [m.a, m.b, stage.ref]) stage.face(x, who);
        stage.camera(who.id, m.a.id, m.b.id);
        yield* stage.narrate(this.say('interruptLook', m.a, m.b));
        for (const l of spot.lines) yield* stage.say(who, l, mood);
        yield* stage.narrate(this.say('distracted', victim));
        if (helped.bodyState !== 'standing') yield* stage.getUp(helped);
        if (victim.bodyState !== 'standing') yield* stage.getUp(victim);
        yield* m.perform(helped, victim, move(rng.pick(['clothesline', 'forearm', 'kick_gut'])), this.say('cheapShotAfter', helped, victim));
        break;
      }
      case 'run_in': {
        if (inMatch) return;
        if (!who.visible) {
          stage.appear(who, curtain);
          stage.bus.emit({ type: 'music', who: who.id });
        }
        stage.camera(who.id, victim.id);
        yield* stage.narrate(this.say('runIn', who), 'big');
        stage.crowd('gasp');
        yield* stage.goTo(who, this.freeSpot('ring', who), 'run');
        for (const l of spot.lines) yield* stage.say(who, l, 'furious');
        if (victim.bodyState !== 'standing' && rng.chance(0.5)) yield* stage.getUp(victim);
        yield* m.perform(who, victim, this.brawlMove(victim), this.say('ambush', who, victim));
        yield* m.perform(who, victim, this.brawlMove(victim));
        const decisive = spot.phase === 'finish' && (m.spec.finish === 'dq' || m.spec.finish === 'no_contest');
        if (!decisive) {
          yield* stage.narrate(this.say('flee', who));
          yield* stage.goTo(who, arena.aisle.spot, 'run');
          stage.vanish(who);
        }
        break;
      }
      case 'distraction': {
        const apron = { x: arena.ring.x0 - 0.5, depth: 2 };
        if (!who.visible) {
          stage.appear(who, curtain);
        }
        yield* stage.goTo(who, apron, 'run');
        yield* stage.walkTo(stage.ref, { x: arena.ring.x0 + 2, depth: 2 });
        stage.face(stage.ref, who);
        stage.camera(who.id, stage.ref.id);
        yield* stage.narrate(this.say('distract', who));
        for (const l of spot.lines) yield* stage.say(who, l, mood);
        if (!inMatch) {
          if (helped.bodyState !== 'standing') yield* stage.getUp(helped);
          if (victim.bodyState !== 'standing') yield* stage.getUp(victim);
          const cheat = move(rng.pick(['low_blow', 'eye_rake']));
          yield* m.perform(helped, victim, cheat, this.say('distractCheat', helped, victim));
          stage.crowd('boo');
        }
        yield* stage.goTo(who, { x: arena.ringside.x0, depth: 1 }, 'walk');
        break;
      }
      case 'ref_bump': {
        const ref = stage.ref;
        const bumper = inMatch ? who : m.a;
        yield* stage.walkTo(ref, { x: bumper.x + (bumper.facing === 1 ? 2 : -2), depth: bumper.depth });
        yield* stage.narrate(this.say('refBump', bumper), 'big');
        yield* stage.knockdown(ref);
        stage.crowd('gasp');
        break;
      }
      case 'weapon': {
        let user = inMatch ? who : helped;
        if (!inMatch) {
          if (!who.visible) stage.appear(who, curtain);
          yield* stage.goTo(who, { x: arena.ring.x0 - 1, depth: 3 }, 'run');
          yield* stage.narrate(this.say('weapon', who));
          for (const l of spot.lines) yield* stage.say(who, l, mood);
          if (who.kind === 'wrestler' && rng.chance(0.5)) {
            yield* stage.goTo(who, this.freeSpot('ring', who), 'run');
            user = who;
          }
        } else {
          yield* stage.narrate(this.say('weapon', who));
        }
        if (user.bodyState !== 'standing') yield* stage.getUp(user);
        yield* m.weaponShot(user, victim);
        if (!m.refDown && !(spot.phase === 'finish' && m.spec.finish === 'dq')) {
          yield* stage.narrate(line(rng, 'cheatUnseen'));
        }
        if (user === who && !inMatch && spot.phase !== 'finish') {
          yield* stage.goTo(who, arena.aisle.spot, 'run');
          stage.vanish(who);
        }
        break;
      }
    }
    for (const x of [m.a, m.b]) x.lookingAt = null;
  }

  private *interrupt(b: BeatOf<'interrupt'>): Co {
    const { stage } = this;
    const who = this.get(b.who);
    if (!who) return;
    yield* this.bring(who, b.where === 'ring' ? 'stage' : b.where, 'walk', true);
    const present = stage.visibleActors().filter((x) => x !== who && x.kind !== 'ref');
    for (const x of present) stage.face(x, who);
    stage.camera(who.id);
    for (const l of b.lines) yield* stage.say(who, l, this.moodFor(who, l));
    switch (b.then) {
      case 'stays':
        break;
      case 'leaves':
        yield* stage.goTo(who, curtain);
        stage.vanish(who);
        break;
      case 'walks_to_ring':
        yield* stage.goTo(who, this.freeSpot('ring', who), 'strut');
        break;
      case 'attacks': {
        const t = this.get(b.target);
        if (t && t.visible) yield* this.attack({ type: 'attack', attackers: [who.id], victim: t.id, where: 'ring', style: 'beatdown' });
        break;
      }
    }
  }

  private *runIn(b: BeatOf<'run_in'>): Co {
    const { stage } = this;
    const who = this.get(b.who);
    const target = this.get(b.target);
    if (!who || !target) return;
    if (b.intent === 'attack') {
      if (!who.visible) yield* stage.narrate(this.say('runIn', who), 'big');
      yield* this.attack({ type: 'attack', attackers: [who.id], victim: target.id, where: 'ring', style: 'beatdown' });
      return;
    }
    // Save: run in, chase off whoever is standing over the target.
    if (!who.visible) stage.appear(who, curtain);
    yield* stage.narrate(this.say('save', who), 'big');
    stage.crowd('pop');
    yield* stage.goTo(who, { x: target.x - 2, depth: target.depth }, 'run');
    const heels = stage.visibleActors().filter(
      (x) => x !== who && x !== target && x.kind !== 'ref' && x.kind !== 'interviewer' && x.alignment !== who.alignment,
    );
    const f = this.fight(who, target);
    for (const h of heels.slice(0, 2)) {
      if (h.bodyState !== 'standing') yield* stage.getUp(h);
      yield* f.perform(who, h, move(this.rng.pick(['punch', 'clothesline', 'big_boot'])));
      yield* stage.getUp(h);
      yield* stage.narrate(this.say('flee', h));
      yield* stage.goTo(h, curtain, 'run');
      stage.vanish(h);
    }
    yield* stage.goTo(who, { x: target.x - 1.5, depth: target.depth });
    yield* stage.getUp(target, true);
    stage.face(who, target);
    stage.face(target, who);
  }

  private *reveal(b: BeatOf<'reveal'>): Co {
    const { stage, rng } = this;
    const who = this.get(b.who);
    if (!who) return;
    if (!who.visible) yield* this.bring(who, 'stage', 'walk', true);
    stage.camera(who.id);
    stage.setPose(who, { upper: 'point', head: 'shout' });
    yield* stage.say(who, b.line, 'crazy');
    stage.crowd('gasp');
    yield* stage.narrate(line(rng, 'crowdGasp'), 'shock');
    for (const r of b.reactions) yield* this.react({ type: 'react', who: r.who, reaction: r.reaction });
  }

  private *react(b: BeatOf<'react'>): Co {
    const { stage } = this;
    const a = this.get(b.who);
    if (!a || !a.visible) return;
    const pose = REACTION_POSE[b.reaction];
    if (b.reaction === 'faint') {
      yield* stage.narrate(this.say('faint', a), 'shock');
      yield* stage.knockdown(a);
      return;
    }
    stage.setPose(a, pose);
    yield* stage.narrate(this.say(b.reaction, a), b.reaction === 'shock' || b.reaction === 'disbelief' ? 'shock' : 'call');
    if (a.bodyState === 'standing') stage.setPose(a, a.basePose());
  }

  private *turn(b: BeatOf<'turn'>): Co {
    const { stage, rng } = this;
    const who = this.get(b.who);
    if (!who) return;
    const target = b.target !== 'none' ? this.get(b.target) : null;
    stage.camera(who.id, ...(target ? [target.id] : []));
    switch (b.how) {
      case 'attacks_partner': {
        if (!target) break;
        if (!target.visible) yield* this.bring(target, 'ring');
        if (!who.visible) yield* this.bring(who, 'ring', 'walk');
        yield* stage.walkTo(who, { x: target.x + (target.x > who.x ? -2 : 2), depth: target.depth });
        stage.face(who, target);
        stage.face(target, who);
        const f = this.fight(who, target);
        if (target.bodyState !== 'standing') yield* stage.getUp(target);
        yield* f.perform(who, target, move(rng.pick(['low_blow', 'forearm', 'eye_rake'])), this.say('turnAttack', who, target));
        stage.crowd('gasp');
        yield* f.hitFinisher(who, target);
        yield* stage.narrate(this.say('standOver', who, target));
        break;
      }
      case 'joins_heels': {
        if (target && !target.visible) yield* this.bring(target, 'ring', 'strut');
        if (!who.visible) yield* this.bring(who, 'ring');
        if (target) {
          yield* stage.walkTo(who, { x: target.x + 2, depth: target.depth });
          stage.face(who, target);
          stage.face(target, who);
          stage.setPose(who, { upper: 'grab' });
          stage.setPose(target, { upper: 'grab' });
          yield* stage.narrate(this.say('turnJoin', who, target), 'shock');
          yield* stage.gesture(who, { upper: 'arms_up', head: 'shout' }, 1.2);
        }
        break;
      }
      case 'saves_rival': {
        if (target) {
          yield* this.runIn({ type: 'run_in', who: who.id, target: target.id, intent: 'save' });
          yield* stage.narrate(this.say('turnSave', who, target), 'shock');
        }
        break;
      }
      case 'walks_out': {
        if (!who.visible) break;
        yield* stage.narrate(this.say('turnWalk', who), 'shock');
        yield* stage.goTo(who, curtain, 'walk');
        stage.vanish(who);
        break;
      }
    }
    who.alignment = b.newAlignment;
    stage.bus.emit({ type: 'alignmentChanged', id: who.id, alignment: b.newAlignment });
    stage.crowd(b.newAlignment === 'heel' ? 'boo' : 'pop');
    if (rng.chance(0.6)) yield* stage.narrate(this.say('turnCommentary'), 'big');
  }

  private *celebrate(b: BeatOf<'celebrate'>): Co {
    const { stage } = this;
    const who = b.who.map((id) => this.get(id)).filter((x): x is Actor => !!x && x.visible);
    if (!who.length) return;
    for (const x of who) {
      if (x.bodyState !== 'standing') yield* stage.getUp(x);
      stage.setPose(x, { upper: 'arms_up', head: 'shout' });
    }
    yield* stage.narrate(this.say('celebrate', who[0]));
    stage.crowd(who[0].alignment === 'heel' ? 'boo' : 'cheer');
    yield 1.5;
    for (const x of who) stage.setPose(x, x.basePose());
  }

  private *exit(b: BeatOf<'exit'>): Co {
    const { stage } = this;
    const who = b.who.map((id) => this.get(id)).filter((x): x is Actor => !!x && x.visible && x.kind !== 'interviewer');
    if (!who.length) return;
    const key: LineKey = b.how === 'storm_off' ? 'exitStorm' : b.how === 'stagger' ? 'exitStagger' : b.how === 'helped' ? 'exitHelped' : 'exitWalk';
    const pace: Pace = b.how === 'storm_off' ? 'run' : b.how === 'walk' ? 'walk' : 'stagger';
    const tasks = who.map((x) =>
      this.stage.spawn(
        (function* (): Co {
          if (x.bodyState !== 'standing') yield* stage.getUp(x, true);
          yield* stage.goTo(x, curtain, pace);
          stage.vanish(x);
        })(),
      ),
    );
    yield* stage.narrate(this.say(key, who[0]));
    yield tasks;
  }
}
