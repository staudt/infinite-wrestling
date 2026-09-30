import { hashSeed, Rng } from '../engine/rng';
import { MOVES } from '../sim/moves';
import { alliesOf, type World } from '../world/state';

// Stable across calls, so it is cached (see server/booker.ts).
export const SYSTEM_PROMPT = `You are the head booker and writer of a never-ending professional wrestling TV show (by default in the style of 1980s NWA studio TV; a PROMOTION DIRECTION, when given, overrides the default flavor). It plays 24/7 like a screensaver: viewers drop in anytime and should immediately get drama. You write one weekly episode at a time as structured data; an engine stages it with animated wrestlers in a side-view studio arena (entrance curtain and stage on the left, an aisle, an interview podium beside it, and the ring on the right).

TONE
- Follow the PROMOTION DIRECTION if one is given: it sets the promotion's identity, crowd, and match style (e.g. hardcore promotions lean on weapons, brawls, chaos and no_contest/dq finishes).
- Over-the-top soap opera: betrayals, jealous valets, secret alliances, shocking reveals, grudges, sneak attacks, trash talk. Campy and fun, never mean-spirited or graphic. PG-13 at most.
- Promo lines are short, punchy, and quotable (under ~20 words each). Heels gloat and cheat; faces are fiery and honorable. Characters speak in their gimmick's voice.
- Commentary lines ("narrate" beats) are excited play-by-play, e.g. "It was a setup all along!".

EPISODE STRUCTURE (5-7 segments)
- Open hot (a match or an angle), build through interviews/promos and midcard matches, and put the main event last, ending on a cliffhanger (post-match attack, reveal, turn, or a challenge).
- Matches are short and simple. Each wrestler wrestles at most once per episode; matches are singles, same division only.
- Keep the story moving every week: advance the active feuds, pay off earlier setups, and plant new seeds.

BOOKING RULES
- Only use character ids from the roster (plus any you debut this episode). Only wrestlers wrestle; managers, valets and the interviewer never do.
- The interviewer conducts interviews at the podium; include the interviewer's questions as lines spoken by the interviewer's id.
- Heel/face turns are RARE and must be earned: at most one per episode, usually only after weeks of tension. Never turn the same character back and forth.
- Titles only change hands on pin, rollup, cheat_pin or submission (dq/countout protect the champion). Title changes should feel like big moments, not weekly events.
- Use dq, countout and no_contest finishes to extend feuds; use clean pins to end them.
- Match "spots" are interference during the match. interrupt/run_in must be by someone NOT in the match. Use at most 1-2 spots in a match; many matches should have none.
- A "run_in" or "weapon" spot in the finish phase naturally causes a dq or no_contest finish.
- Avoid repeating the angle types listed under RECENTLY USED ANGLES. Variety is everything.
- Debuts: occasionally (not every week) introduce a new character with a vivid gimmick. Debuts should immediately get involved in a storyline.
- Use stateChanges to record feuds starting/ending, alliances forming/breaking, and storyline notes (secrets, schemes, upcoming payoffs) you want to remember in future weeks.
- storySoFar: rewrite the running summary of all active storylines (max ~120 words) so a future writer can continue them.
- Write the episode as one ordered list of beats. Start every segment with a segment marker beat ({"type":"segment","title":...,"recap":...}), followed by that segment's beats.
- Each segment's recap is one sentence describing what happened.`;

const DIRECTIVES = [
  'Feature the women\'s division prominently this week.',
  'Include a backstage-style interview that ends with somebody storming off.',
  'Give a midcard wrestler a surprising upset win.',
  'Book a sneak attack that nobody saw coming.',
  'Have a manager or valet cause trouble for their own client.',
  'Plant the seed of a future betrayal without paying it off yet.',
  'Build to a big title match next week with a heated contract-style confrontation.',
  'Have someone make an outrageous claim during a promo.',
  'Pay off an older storyline note from the history.',
  'Give a babyface a heroic moment where they make the save.',
  'Keep things cleaner this week: fewer run-ins, more decisive results.',
  'Have a heel get a comeuppance.',
  'Introduce a mysterious newcomer (debut) who ties into an existing feud.',
  'Book a match that ends in total chaos.',
  'Put the tag partners through a moment of tension.',
  'Let the interviewer get caught in the middle of something.',
  'Do something funny: a ridiculous reveal or a gimmick gone wrong.',
];

export function directivesFor(world: World): string[] {
  const rng = new Rng(hashSeed('directives', world.seed, world.episode + 1));
  return rng.shuffle(DIRECTIVES).slice(0, 2);
}

export function buildUserPrompt(world: World): string {
  const n = world.episode + 1;
  const name = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
  const roster = world.characters.map((c) => {
    const allies = alliesOf(world, c.id);
    return `- ${c.id} | ${c.name} | ${c.role} | ${c.alignment} | ${c.division} | ${c.style} | finisher: ${c.finisher.name || '—'} | ${c.gimmick}${allies.length ? ` | allies: ${allies.join(', ')}` : ''}`;
  });
  const titles = world.titles.map((t) => `- ${t.id} (${t.name}, ${t.division}): ${t.holder ? `${t.holder} (${name(t.holder)})` : 'VACANT'}`);
  const feuds = world.feuds.map((f) => `- ${f.a} vs ${f.b} (since ep ${f.since}): ${f.reason}`);
  const alliances = world.alliances.map((a) => `- ${a.name}: ${a.members.join(', ')}`);
  const notes = world.notes.map((x) => `- (ep ${x.episode}) ${x.text}`);
  const history = world.history.slice(-24).map((h) => `- ep ${h.episode} — ${h.segment}: ${h.recap}`);
  const counts = new Map<string, number>();
  for (const l of world.angleLog.slice(-4)) for (const k of l.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const angles = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`);
  const moves = MOVES.filter((m) => m.kind !== 'pin' && m.kind !== 'cheat').map((m) => m.id);

  return [
    `Book EPISODE #${n} of "${world.showName}" (${world.shortName}). Call the book_episode tool with the full episode.`,
    '',
    ...(world.direction ? [`PROMOTION DIRECTION (follow this):\n${world.direction}`, ''] : []),
    `STORY SO FAR:\n${world.storySoFar}`,
    '',
    `ROSTER (id | name | role | alignment | division | style | finisher | gimmick):\n${roster.join('\n')}`,
    '',
    `CHAMPIONS:\n${titles.join('\n')}`,
    '',
    `ACTIVE FEUDS:\n${feuds.join('\n') || '- none'}`,
    '',
    `ALLIANCES:\n${alliances.join('\n') || '- none'}`,
    '',
    `STORYLINE NOTES:\n${notes.join('\n') || '- none'}`,
    '',
    `RECENT HISTORY (oldest first):\n${history.join('\n') || '- this is the first episode'}`,
    '',
    `RECENTLY USED ANGLES (last 4 episodes, avoid overusing): ${angles.join(', ') || 'none'}`,
    '',
    `THIS WEEK'S BOOKING DIRECTIVES:\n${directivesFor(world).map((d) => `- ${d}`).join('\n')}`,
    '',
    `MOVE IDS (for debut finishers): ${moves.join(', ')}`,
  ].join('\n');
}

// ------------------------------------------------------------------ new promotions

export const GENESIS_PROMPT = `You create brand-new professional wrestling promotions for a never-ending, self-running wrestling TV show (think the soap-opera drama of 1980s NWA studio TV and MDickie games, unless a direction says otherwise). The show will run forever, booked week by week from the world you create, so plant rich, interconnected storylines.

Create:
- A show name and a short brand (initials, max 6 characters).
- One interviewer (not a wrestler).
- 14-18 characters: mostly wrestlers across the "men" and "women" divisions (at least 8 men's wrestlers; 0 or 3+ women's wrestlers), plus 1-3 managers/valets. Mix of faces, heels and a couple of tweeners, and all five styles.
- Vivid, original, campy gimmicks with instant hooks. Avoid real wrestlers' names and trademarks. Names may include a "Nickname" in double quotes.
- Finisher names that fit the character, each mapped to a finisherMove from the move list.
- 2-3 titles (a world title, a secondary title, and a women's title if there is a women's division), each with a current champion from that division.
- 2-4 active feuds and 2-4 alliances (tag teams, stables, manager/valet pairings) with secrets and tension baked in.
- storySoFar: the situation as episode 1 begins.
Call the create_promotion tool with the result.`;

const FLAVORS = [
  'Southern territory in 1986, sweaty armory crowds',
  'a Canadian promotion broadcast from a hockey arena',
  'a flashy Los Angeles promotion full of Hollywood egos',
  'a blue-collar Midwest promotion in a bingo hall',
  'a Texas promotion with cowboys, oil barons and family dynasties',
  'a Florida promotion with sun-soaked surfers and swamp monsters',
  'a New York promotion with loudmouth city slickers and mob rumors',
  'a Pacific Northwest promotion with lumberjacks and mysterious mountain men',
  'a promotion run by a feuding family where the owner\'s kids wrestle',
];

export function buildGenesisPrompt(direction: string, seed: number): string {
  const moves = MOVES.filter((m) => m.kind !== 'pin' && m.kind !== 'cheat' && m.kind !== 'weapon').map((m) => m.id);
  const flavor = new Rng(hashSeed('flavor', seed)).pick(FLAVORS);
  return [
    direction
      ? `PROMOTION DIRECTION (build everything around this):\n${direction}`
      : `No direction was given. For variety, loosely inspire it by: ${flavor}.`,
    '',
    `Wrestling styles: brawler, technician, powerhouse, highflyer, showman.`,
    `MOVE IDS (for finisherMove): ${moves.join(', ')}`,
    `Random seed for originality: ${seed}`,
  ].join('\n');
}
