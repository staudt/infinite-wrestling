// The color commentator: a heel sympathizer who chimes in shortly after big moments.
// It listens to engine events and replies a beat later, so the play-by-play line and
// the quip read as a conversation. All randomness goes through the stage RNG, so the
// show stays deterministic.
import type { Actor } from '../engine/actor';
import type { EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';
import type { Co } from '../engine/tasks';
import { move } from '../sim/moves';
import { fill } from './lines';

const QUIPS = {
  heelBig: [
    'Textbook! That is how a real champion does it!', 'Now THAT is a professional, {A}!', 'Beautiful! Just beautiful!',
    'You see that? {A} is a genius!', 'Put that in the museum!',
  ],
  faceBig: [
    'Lucky shot. Pure luck.', 'Oh please, {A} has been doing that same move since 1974.', 'Big deal. My grandmother does that.',
    'Somebody check {A} for foreign objects!', 'Overrated!',
  ],
  cheat: [
    'That is not cheating, that is strategy!', 'I didn\'t see anything. Did you see anything?', 'The rules are more like guidelines!',
    'Smart! Work smarter, not harder!', 'If you ain\'t cheatin\', you ain\'t tryin\'!',
  ],
  kickout: ['That was three! That was THREE!', 'Slow count! This ref is a disgrace!', 'The referee is blind as a bat!'],
  heelWin: ['The better athlete won, plain and simple!', 'Justice! Sweet justice!', 'Did you ever doubt {A}? I didn\'t!'],
  faceWin: ['Robbery! Absolute highway robbery!', 'I want a recount!', 'That referee should be fired tonight!'],
  heelEntrance: ['Now HERE is a real athlete!', 'Finally, some class in this building!', 'Show some respect for {A}!'],
  faceEntrance: ['Oh great. This bum again.', 'Hide your wallets, {A} is here.', 'Why do these people cheer for {A}?'],
  turnHeel: ['FINALLY! {A} has seen the light!', 'Best decision of {A}\'s career!', 'Welcome to the winning team, {A}!'],
  turnFace: ['What a waste of talent.', '{A} just threw it all away!', 'Traitor!'],
  shock: ['Did I just hear that right?!', 'I need a drink.', 'This is better than my soap operas!', 'Well, I never!'],
  chant: ['Listen to these morons.', 'Can somebody shut these people up?', 'I\'m being drowned out by peasants!'],
} as const;

const COOLDOWN = 7;

export function attachColorCommentary(stage: Stage): void {
  let last = -Infinity;
  const name = (id: string) => {
    const a = stage.actors.get(id);
    return a ? a.name.replace(/"[^"]*"\s*/g, '').trim() : id;
  };
  const heel = (id: string) => stage.actors.get(id)?.alignment === 'heel';

  const chime = (bank: keyof typeof QUIPS, chance: number, who?: string) => {
    const guy: Actor | undefined = stage.actors.get('_color');
    if (!guy?.visible || stage.time - last < COOLDOWN || !stage.rng.chance(chance)) return;
    last = stage.time;
    const text = fill(stage.rng.pick(QUIPS[bank]), { A: who ? name(who) : '' });
    stage.spawn((function* (): Co {
      yield 1.4;
      stage.bus.emit({ type: 'said', who: guy.id, text, mood: 'smug' });
    })());
  };

  stage.on((e: EngineEvent) => {
    switch (e.type) {
      case 'moveImpact': {
        const m = move(e.move);
        if (m.kind === 'cheat') chime('cheat', 0.7, e.att);
        else if (m.big) chime(heel(e.att) ? 'heelBig' : 'faceBig', 0.35, e.att);
        break;
      }
      case 'pinCount':
        if (e.kickout && heel(stage.actors.get(e.coverer)?.id ?? '')) chime('kickout', 0.5);
        break;
      case 'matchEnd':
        if (e.winner) chime(heel(e.winner) ? 'heelWin' : 'faceWin', 0.8, e.winner);
        break;
      case 'music':
        chime(heel(e.who) ? 'heelEntrance' : 'faceEntrance', 0.35, e.who);
        break;
      case 'alignmentChanged':
        last = -Infinity;
        chime(e.alignment === 'heel' ? 'turnHeel' : 'turnFace', 1, e.id);
        break;
      case 'narrated':
        if (e.style === 'shock') chime('shock', 0.5);
        break;
      case 'crowd':
        if (e.chant) chime('chant', 0.15);
        break;
    }
  });
}
