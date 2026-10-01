import { hashSeed, Rng } from '../engine/rng';
import { MOVES } from '../sim/moves';
import { seasonContext } from '../world/season';
import { alliesOf, type World } from '../world/state';

// Stable across calls, so it is cached (see server/booker.ts).
export const SYSTEM_PROMPT = `You are the head booker and writer of a never-ending professional wrestling TV show (by default in the style of 1980s NWA studio TV; a PROMOTION DIRECTION, when given, overrides the default flavor). It plays 24/7 like a screensaver: viewers drop in anytime and should immediately get drama. You write one weekly episode at a time as structured data; an engine stages it with animated wrestlers in a side-view studio arena (entrance curtain and stage on the left, a short ramp, the announce desk where interviews happen, and the ring on the right).

TONE
- Follow the PROMOTION DIRECTION if one is given: it sets the promotion's identity, crowd, and match style (e.g. hardcore promotions lean on weapons, brawls, chaos and no_contest/dq finishes).
- Over-the-top soap opera: betrayals, jealous valets, secret alliances, shocking reveals, grudges, sneak attacks, trash talk. Campy and fun, never mean-spirited or graphic. PG-13 at most.
- Promo lines are short, punchy, and quotable (under ~20 words each). Heels gloat and cheat; faces are fiery and honorable. Characters speak in their gimmick's voice.
- Always acknowledge champions by their title, especially the first time they come up ("the World Heavyweight champion Razor Edge", "Edge, you'll never touch my Television title!"), so viewers know who holds gold and who is chasing it.
- Commentary lines ("narrate" beats) are excited play-by-play, e.g. "It was a setup all along!". Set speaker "color" for the heel-leaning color commentator's snide, biased takes; mix both voices.

STIPULATIONS (set "stipulation" on every match)
- singles: the default for weekly TV.
- tag: 4 wrestlers, the first two are one team. Great for alliances, factions, odd couples and partners who might turn. There are no tag team titles yet.
- cage: steel cage, no DQ, no count-out; win by pin, submission, or "escape" over the top. The classic way to END a feud, usually at a PPV.
- ladder: the prize hangs above the ring and the only finish is "retrieve" (put a title in titleOnLine for a title ladder match; otherwise it's a briefcase for a future title shot). A PPV showpiece.
- battle_royal: 5-12 wrestlers, over the top rope; finish "elimination". Pushes new or midcard talent (the winner earns a title shot) or crowns a vacant champion.
- Use them for storytelling: a tag match most weeks on TV, at least one cage or ladder match on every PPV (the finale settles its top feuds in gimmick matches), and a battle royal or two per season.

MATCH MOMENTS (this is where matches get their story)
- The engine picks the individual moves; you give every match 3-6 "moments": short lines tied to a phase (early, mid, late, after).
- Speakers: "pbp" (play-by-play, tie the action to the storyline), "color" (heel-biased color commentator), or any character id (trash talk from a wrestler, a manager yelling from ringside, a valet cheering).
- Every match needs at least one line from a character out there (a wrestler's trash talk or a manager/valet at ringside), and the color commentator should sound biased toward the heels.
- Reference the feud and history ("Crusher is going right after that injured shoulder!", "This is for my sister!"). Do not describe specific moves, except a character's finisher.
- Never announce interference, run-ins or weapons in moments: the engine stages those from "spots" (put what the interferer shouts in the spot's lines). Only "after" lines may react to them, and to the result.
- Characters only speak if they are out there (in the match, or brought out by an entrance/spot/escort).

EPISODE STRUCTURE
- Weekly TV: about 6 segments (never more than 7) with 1-3 matches; promos, interviews and angles are short. Pay-per-views: 7-9 segments, mostly matches.
- Open hot (a match or an angle), build through interviews/promos and midcard matches, and put the main event last, ending on a cliffhanger (post-match attack, reveal, turn, or a challenge).
- Matches are short and simple. Each wrestler wrestles at most once per episode; matches are usually within a division (a mixed match is a rare special attraction, and titles are only defended within their division).
- Keep the story moving every week: advance the active feuds, pay off earlier setups, and plant new seeds.

FEUDS THAT DRAW
- Build the major feuds as face vs heel: a babyface chasing a heel champion, or a heel menacing a popular face. Face vs face with mutual respect works now and then; a long heel vs heel feud does not draw, so keep those short or turn one of them.
- Tag matches let you advance a feud without a direct pin (partners take the fall, enemies are forced to team, a heel turns on his partner).
- Gimmick matches (cage, ladder) are how big feuds END, usually on a PPV.

BOOKING RULES
- Only use character ids from the roster exactly as listed (plus any you debut this episode), never names. Only wrestlers wrestle; managers, valets and the interviewer never do.
- The interviewer is also the ring announcer. Interviews happen in front of the announce desk (place "podium"), on the ramp, or in the ring when the guest is already there. Promos can be in the ring, on the stage, or on the ramp (place "aisle"); include the interviewer's questions as lines spoken by the interviewer's id.
- Heel/face turns are RARE and must be earned: at most one per episode, usually only after weeks of tension. Never turn the same character back and forth.
- Titles only change hands on pin, rollup, cheat_pin or submission (dq/countout protect the champion). Title changes should feel like big moments, not weekly events.
- Use dq, countout and no_contest finishes to extend feuds; use clean pins to end them.
- Match "spots" are interference during the match. interrupt/run_in must be by someone NOT in the match. Use at most 1-2 spots in a match; many matches should have none.
- A "run_in" or "weapon" spot in the finish phase naturally causes a dq or no_contest finish.
- Avoid repeating the angle types listed under RECENTLY USED ANGLES. Variety is everything.
- Debuts: occasionally (not every week) introduce a new character with a vivid gimmick. Debuts should immediately get involved in a storyline. Give them a hometown, billed weight, catchphrase, and a finisher description and setup call.
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
  const align = (id: string) => world.characters.find((c) => c.id === id)?.alignment ?? '?';
  const feuds = world.feuds.map((f) => `- ${f.a} (${align(f.a)}) vs ${f.b} (${align(f.b)}), since ep ${f.since}: ${f.reason}`);
  const alliances = world.alliances.map((a) => `- ${a.name}: ${a.members.join(', ')}`);
  const notes = world.notes.map((x) => `- (ep ${x.episode}) ${x.text}`);
  const history = world.history.slice(-24).map((h) => `- ep ${h.episode} — ${h.segment}: ${h.recap}`);
  const counts = new Map<string, number>();
  for (const l of world.angleLog.slice(-4)) for (const k of l.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const angles = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`);
  const moves = MOVES.filter((m) => !['pin', 'cheat', 'outside', 'toss'].includes(m.kind)).map((m) => m.id);

  return [
    `Book EPISODE #${n} of "${world.showName}" (${world.shortName}). Call the book_episode tool with the full episode.`,
    '',
    ...(world.direction ? [`PROMOTION DIRECTION (follow this):\n${world.direction}`, ''] : []),
    seasonContext(world),
    '',
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
- One ring announcer who also conducts interviews (the "interviewer"; not a wrestler).
- An announce team: a play-by-play voice and a heel-sympathizing color commentator (names only).
- 14-18 characters: mostly wrestlers across the "men" and "women" divisions (at least 8 men's wrestlers; 0 or 3+ women's wrestlers), plus 1-3 managers/valets. Mix of faces, heels and a couple of tweeners, and all five styles.
- Vivid, original, campy gimmicks with instant hooks. Avoid real wrestlers' names and trademarks. Names may include a "Nickname" in double quotes.
- Finisher names that fit the character, each mapped to a finisherMove from the move list, plus a vivid finisherDescription of how it looks (e.g. "a spinning DDT off the second rope") and a finisherCall, the play-by-play's setup line (e.g. "He's measuring him for the Jackpot!").
- For every character: a billed hometown, a billed weight in pounds (wrestlers), and a short catchphrase in their voice.
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
  const moves = MOVES.filter((m) => !['pin', 'cheat', 'weapon', 'outside', 'toss'].includes(m.kind)).map((m) => m.id);
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

// ------------------------------------------------------------------ seasons

const ARCHETYPES = `CLASSIC LONG-TERM ARCS (mix and adapt; invent your own too):
- The veteran's last run: a legend comes out of retirement for one last title shot. Losses, beatdowns, doubters; earns the shot late and wins (or nobly falls) at the finale.
- The rookie earns respect: a young up-and-comer gets title shots and loses them, but each loss proves they belong. They become a real contender.
- The undefeated monster: a streak builds for months; someone finally ends it at a PPV.
- Slow-burn betrayal: tag partners or a mentor and student crack week by week; the turn happens at a PPV.
- The mystery attacker: someone is ambushing people; the reveal happens at a PPV.
- Faction war: a heel stable grows, the faces unite against it.
- The authority figure: a corrupt manager or owner stacks the deck against a babyface champion.
- The underdog chase: a midcarder climbs the ladder and gets one shot at gold.
- Redemption: a disgraced former champion rebuilds.`;

export const PLAN_PROMPT = `You are the head booker of a never-ending professional wrestling TV show, planning a whole season. A season is 12 weekly episodes; episodes 4 and 8 are pay-per-views and episode 12 is the season finale PPV, the biggest show of the year. A weekly writer will book each episode from your plan, so give them clear, dramatic direction.

Plan:
- theme: one line for the season.
- ppvs: exactly three (episodes 4, 8, 12) with a name, the intended main event, and the rest of the planned card.
- arcs: 3-5 long-term storylines. Each has the characters involved (by id), an archetype, a summary, beats on specific episodes (build tension: setbacks before triumphs, not every week), and a payoff at a PPV. Arcs should intertwine and escalate; at least one arc pays off at the finale. The finale should close most feuds and leave a cliffhanger for next season.
- Respect the current champions, feuds, alliances and recent history; give every title a direction.
- Make the main feuds face vs heel: a babyface chasing a heel champion, or a heel menacing a popular face. No season-long heel vs heel program.
- Plan stipulations: weekly tag matches to move feuds without direct pins; at least one cage or ladder match on each PPV (name it in that PPV's card); the finale settles the top feuds in gimmick matches; one battle royal to push someone new.
- Only use character ids from the roster exactly as listed.

${ARCHETYPES}

Call the plan_season tool with the plan.`;

export const TRANSITION_PROMPT = `You are the head booker of a never-ending professional wrestling TV show. A season just ended with its finale. Plan the off-season roster changes that keep the show fresh:
- recap: two or three sentences on the season that ended.
- departures: roughly a quarter to a third of the roster leaves (contracts, retirement, injury, jumping to a rival promotion). Prefer people whose stories are finished. Champions may leave (their titles are vacated). Never remove the interviewer.
- arrivals: about as many newcomers as departures, with full profiles (hometown, weight, catchphrase, finisher description and call). Build some for classic arcs: a veteran coming out of retirement for one last title run, a hungry rookie, a foreign star, a mysterious masked man, a returning alumnus (you may bring back someone who left before, with a new id).
- Keep both divisions viable and the face/heel balance healthy.

${ARCHETYPES}

Call the season_transition tool.`;

function rosterBlock(world: World): string {
  const name = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
  return [
    `ROSTER (id | name | role | alignment | division | style | gimmick):\n${world.characters.map((c) => `- ${c.id} | ${c.name} | ${c.role} | ${c.alignment} | ${c.division} | ${c.style} | ${c.gimmick}`).join('\n')}`,
    `CHAMPIONS:\n${world.titles.map((t) => `- ${t.id} (${t.name}, ${t.division}): ${t.holder ? `${t.holder} (${name(t.holder)})` : 'VACANT'}`).join('\n')}`,
    `ACTIVE FEUDS:\n${world.feuds.map((f) => `- ${f.a} vs ${f.b}: ${f.reason}`).join('\n') || '- none'}`,
    `ALLIANCES:\n${world.alliances.map((a) => `- ${a.name}: ${a.members.join(', ')}`).join('\n') || '- none'}`,
    `STORY SO FAR:\n${world.storySoFar}`,
    `RECENT HISTORY:\n${world.history.slice(-24).map((h) => `- ep ${h.episode} — ${h.segment}: ${h.recap}`).join('\n') || '- none yet'}`,
    ...(world.seasonHistory?.length ? [`PAST SEASONS:\n${world.seasonHistory.map((h) => `- Season ${h.season}: ${h.recap}`).join('\n')}`] : []),
    ...(world.alumni?.length ? [`ALUMNI (left the promotion):\n${world.alumni.map((a) => `- ${a.name} (left after season ${a.season}: ${a.reason})`).join('\n')}`] : []),
  ].join('\n\n');
}

export function buildPlanPrompt(world: World, season: number): string {
  return [
    `Plan SEASON ${season} of "${world.showName}" (${world.shortName}).`,
    ...(world.direction ? [`PROMOTION DIRECTION (follow this):\n${world.direction}`] : []),
    rosterBlock(world),
  ].join('\n\n');
}

export function buildTransitionPrompt(world: World, endedSeason: number): string {
  const moves = MOVES.filter((m) => !['pin', 'cheat', 'weapon', 'outside', 'toss'].includes(m.kind)).map((m) => m.id);
  return [
    `Season ${endedSeason} of "${world.showName}" just ended. Plan the off-season.`,
    ...(world.direction ? [`PROMOTION DIRECTION (follow this):\n${world.direction}`] : []),
    rosterBlock(world),
    `MOVE IDS (for finisherMove): ${moves.join(', ')}`,
  ].join('\n\n');
}
