// A freshly created promotion: the whole starting world, generated once per new world
// by the LLM (or the offline generator). Lenient like the episode schema: non-essential
// fields fall back to defaults, and invalid list items are dropped individually.
import { z } from 'zod';
import { Alignment, Division, Role, Style } from './episode';

export const NewCharacter = z.object({
  id: z.string().describe('lowercase_snake_case, unique'),
  name: z.string().describe('Ring name, may include a "Nickname" in double quotes'),
  role: Role.catch('wrestler'),
  alignment: Alignment.catch('face'),
  division: Division.catch('men'),
  style: Style.catch('brawler'),
  gimmick: z.string().catch('').describe('One or two vivid sentences: persona, attitude, relationships'),
  entrance: z.string().catch('').describe('Entrance flavor that reads after "here comes X, ...", e.g. "to wailing bagpipes"'),
  finisherName: z.string().catch('').describe('Wrestlers only; managers/valets may leave empty'),
  finisherMove: z.string().catch('').describe('A move id from the move list (wrestlers only)'),
});

/** Drop invalid items one by one instead of failing the whole list. */
const each = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success) : []), z.array(item));

export const Promotion = z.object({
  showName: z.string().describe('TV show title, e.g. "Hardcore Heaven Weekly"'),
  shortName: z.string().catch('').describe('Promotion initials or short brand, max 6 characters, e.g. "XCW"'),
  interviewer: z.object({
    id: z.string().catch('interviewer'),
    name: z.string().catch('Lance Holloway'),
    gimmick: z.string().catch(''),
  }).catch({ id: 'interviewer', name: 'Lance Holloway', gimmick: '' }),
  characters: each(NewCharacter).describe('14-18 characters: mostly wrestlers, plus 1-3 managers/valets'),
  titles: each(z.object({
    id: z.string().catch('').describe('lowercase_snake_case'),
    name: z.string(),
    division: Division.catch('men'),
    holder: z.string().catch('').describe('Wrestler id of the current champion'),
  })),
  feuds: each(z.object({ a: z.string(), b: z.string(), reason: z.string().catch('') })),
  alliances: each(z.object({ name: z.string(), members: z.array(z.string()) })),
  storySoFar: z.string().catch('').describe('The situation as the first episode begins, max ~120 words'),
});

export type NewCharacter = z.infer<typeof NewCharacter>;
export type Promotion = z.infer<typeof Promotion>;
