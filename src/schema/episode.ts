// The contract between the booker (LLM or offline generator) and the show engine.
// "none" and empty arrays stand in for absent values. Parsing is lenient on purpose:
// a missing or invalid non-essential field is repaired with a sensible default (via
// .catch) instead of failing the whole episode, because every retry costs credits.
import { z } from 'zod';

/** A string that falls back to `d` when missing or malformed. */
const str = (d = '') => z.string().catch(d);
/** A string list that falls back to [] (non-string items are dropped). */
const strs = () => z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []), z.array(z.string()));

export const Mood = z.enum([
  'calm', 'cocky', 'angry', 'furious', 'sad', 'crazy', 'smug', 'excited', 'scared', 'menacing',
]);
export const Place = z.enum(['ring', 'stage', 'aisle', 'podium']);
export const Reaction = z.enum([
  'shock', 'laugh', 'anger', 'cry', 'faint', 'cheer', 'smirk', 'disbelief',
]);
export const Finish = z.enum([
  'pin', 'rollup', 'cheat_pin', 'submission', 'dq', 'countout', 'no_contest',
]);
export const Story = z.enum([
  'even', 'winner_dominates', 'loser_dominates', 'comeback', 'squash', 'back_and_forth',
]);
export const MatchLength = z.enum(['short', 'medium', 'long']);
export const Alignment = z.enum(['face', 'heel', 'tweener']);
export const Division = z.enum(['men', 'women']);
export const Style = z.enum(['brawler', 'technician', 'powerhouse', 'highflyer', 'showman']);
export const Role = z.enum(['wrestler', 'manager', 'valet']);
export const NarrationStyle = z.enum(['call', 'big', 'shock', 'crowd']);

const Line = z.object({
  speaker: z.string().describe('Character id of who says this line'),
  text: z.string(),
});
const Lines = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => Line.safeParse(x).success) : []), z.array(Line));

export const Spot = z.object({
  phase: z.enum(['early', 'mid', 'late', 'finish']).catch('mid'),
  type: z.enum(['interrupt', 'run_in', 'distraction', 'ref_bump', 'weapon']),
  who: z.string().describe('Character id performing the spot'),
  target: str('none').describe('Character id the spot is aimed at, or "none"'),
  lines: strs().describe('What "who" shouts during the spot (0-2 short lines)'),
});
/** Invalid spots are dropped one by one instead of failing the match. */
const Spots = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => Spot.safeParse(x).success) : []), z.array(Spot));

export const Beat = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('entrance'),
    who: z.string(),
    mood: Mood.catch('calm'),
    escorts: strs().describe('Managers/valets/allies walking out with them'),
  }),
  z.object({
    type: z.literal('promo'),
    who: z.string(),
    where: Place.catch('ring'),
    mood: Mood.catch('calm'),
    lines: strs().describe('1-5 short, punchy lines'),
  }),
  z.object({
    type: z.literal('interview'),
    guest: z.string(),
    exchange: Lines.describe('Interviewer and guest lines, 2-6 total'),
  }),
  z.object({
    type: z.literal('confrontation'),
    a: z.string(),
    b: z.string(),
    where: Place.catch('ring'),
    exchange: Lines,
    escalation: z.enum(['stare_down', 'shove', 'slap', 'brawl', 'separated']).catch('stare_down'),
  }),
  z.object({
    type: z.literal('attack'),
    attackers: strs(),
    victim: z.string(),
    where: Place.catch('ring'),
    style: z.enum(['from_behind', 'beatdown', 'weapon', 'finisher']).catch('beatdown'),
  }),
  z.object({
    type: z.literal('match'),
    wrestlers: strs().describe('Exactly two wrestler ids'),
    winner: str('none').describe('One of the wrestlers, or "none" for no_contest'),
    finish: Finish.catch('pin'),
    story: Story.catch('even'),
    length: MatchLength.catch('short'),
    titleOnLine: str('none').describe('Title id if this is a title match, else "none"'),
    spots: Spots,
  }),
  z.object({
    type: z.literal('interrupt'),
    who: z.string(),
    where: Place.catch('stage'),
    lines: strs(),
    then: z.enum(['stays', 'leaves', 'walks_to_ring', 'attacks']).catch('stays'),
    target: str('none').describe('Who they attack if then=attacks, else "none"'),
  }),
  z.object({
    type: z.literal('run_in'),
    who: z.string(),
    target: z.string(),
    intent: z.enum(['attack', 'save']).catch('attack'),
  }),
  z.object({
    type: z.literal('reveal'),
    who: z.string(),
    line: z.string().describe('The bombshell line'),
    reactions: z.array(z.object({ who: z.string(), reaction: Reaction.catch('shock') })).catch([]),
  }),
  z.object({
    type: z.literal('turn'),
    who: z.string(),
    newAlignment: Alignment,
    how: z.enum(['attacks_partner', 'joins_heels', 'saves_rival', 'walks_out']).catch('walks_out'),
    target: str('none').describe('The betrayed partner / saved rival / new ally, or "none"'),
  }),
  z.object({
    type: z.literal('react'),
    who: z.string(),
    reaction: Reaction.catch('shock'),
  }),
  z.object({
    type: z.literal('celebrate'),
    who: strs(),
  }),
  z.object({
    type: z.literal('exit'),
    who: strs(),
    how: z.enum(['walk', 'storm_off', 'stagger', 'helped']).catch('walk'),
  }),
  z.object({
    type: z.literal('narrate'),
    text: z.string().describe('A commentator line, e.g. "It was a setup all along!"'),
    style: NarrationStyle.catch('call'),
  }),
]);

export const StateChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('feud_start'), a: z.string(), b: z.string(), reason: str() }),
  z.object({ type: z.literal('feud_end'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('alliance_form'), name: z.string(), members: strs() }),
  z.object({ type: z.literal('alliance_break'), name: z.string() }),
  z.object({ type: z.literal('storyline_note'), text: z.string() }),
]);

export const Debut = z.object({
  id: z.string().describe('lowercase_snake_case, unique'),
  name: z.string(),
  role: Role.catch('wrestler'),
  alignment: Alignment.catch('heel'),
  division: Division.catch('men'),
  style: Style.catch('brawler'),
  gimmick: str(),
  entrance: str('to a roar from the crowd').describe('How their entrance feels, e.g. "to wailing bagpipes"'),
  finisherName: str(),
  finisherMove: str().describe('A move id from the move list'),
});

const StateChanges = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => StateChange.safeParse(x).success) : []),
  z.array(StateChange),
);
const Debuts = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => Debut.safeParse(x).success) : []), z.array(Debut));

export const Segment = z.object({
  title: z.string(),
  beats: z.array(Beat),
  stateChanges: StateChanges,
  recap: str().describe('One sentence recap of what happened, for the history log'),
});

export const Episode = z.object({
  title: str('Untitled'),
  storySoFar: str().describe('Updated summary of all ongoing storylines, max ~120 words'),
  debuts: Debuts,
  segments: z.array(Segment),
});

// What the LLM writes: one flat list of beats, where a `segment` marker starts each TV
// segment. Models fill flat lists far more reliably than deeply nested ones;
// `draftToEpisode` (booker/validate.ts) converts it into the nested Episode.
export const SegmentMarker = z.object({
  type: z.literal('segment'),
  title: str().describe('Segment title, e.g. "Main Event: A vs. B"'),
  recap: str().describe('One sentence recap of what happens in this segment'),
});

export const EpisodeDraft = z.object({
  title: str('Untitled'),
  storySoFar: str().describe('Updated summary of all ongoing storylines, max ~120 words'),
  debuts: Debuts,
  beats: z.array(z.union([SegmentMarker, Beat]))
    .describe('The whole episode in order. Start EVERY segment with a {"type":"segment"} marker, followed by its beats. 5-7 segments.'),
  stateChanges: StateChanges.describe('Storyline changes caused by this episode'),
});

export type Mood = z.infer<typeof Mood>;
export type Place = z.infer<typeof Place>;
export type Reaction = z.infer<typeof Reaction>;
export type Finish = z.infer<typeof Finish>;
export type Story = z.infer<typeof Story>;
export type MatchLength = z.infer<typeof MatchLength>;
export type Alignment = z.infer<typeof Alignment>;
export type Division = z.infer<typeof Division>;
export type Style = z.infer<typeof Style>;
export type Role = z.infer<typeof Role>;
export type NarrationStyle = z.infer<typeof NarrationStyle>;
export type Spot = z.infer<typeof Spot>;
export type Beat = z.infer<typeof Beat>;
export type StateChange = z.infer<typeof StateChange>;
export type Debut = z.infer<typeof Debut>;
export type Segment = z.infer<typeof Segment>;
export type Episode = z.infer<typeof Episode>;
export type EpisodeDraft = z.infer<typeof EpisodeDraft>;
export type BeatOf<T extends Beat['type']> = Extract<Beat, { type: T }>;
