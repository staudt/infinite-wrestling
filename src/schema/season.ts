// Long-term booking: a season is 12 episodes with pay-per-views at 4, 8 and 12. At the
// start of each season the head booker writes a plan (arcs that pay off at PPVs); between
// seasons an off-season transition shuffles the roster. Lenient like the other schemas.
import { z } from 'zod';
import { NewCharacter } from './promotion';

const each = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success) : []), z.array(item));
const strs = () => z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []), z.array(z.string()));

export const PPV = z.object({
  episode: z.number().describe('4, 8 or 12'),
  name: z.string().describe('Pay-per-view name, e.g. "Summer Slaughter"'),
  mainEvent: z.string().describe('The intended main event and what is at stake'),
  card: strs().describe('Other intended matches/angles for that show'),
});

export const ArcBeat = z.object({
  episode: z.number().describe('Season episode number 1-12'),
  beat: z.string().describe('What should happen in this arc that week'),
});

export const Arc = z.object({
  title: z.string(),
  archetype: z.string().catch('').describe('e.g. "veteran\'s last run", "rookie earns respect", "slow-burn betrayal"'),
  characters: strs().describe('Character ids involved'),
  summary: z.string().catch(''),
  beats: each(ArcBeat).describe('The arc week by week (not every week needs a beat)'),
  payoff: z.object({ episode: z.number().catch(12), outcome: z.string().catch('') }).catch({ episode: 12, outcome: '' }),
});

export const SeasonPlan = z.object({
  theme: z.string().catch('').describe('One line: what this season is about'),
  ppvs: each(PPV).describe('Exactly three: episodes 4, 8 and 12 (12 is the season finale)'),
  arcs: each(Arc).describe('3-5 long-term storylines'),
});

export const Departure = z.object({
  id: z.string(),
  reason: z.string().catch('').describe('e.g. "contract expired", "retired after the finale", "injured"'),
});

export const SeasonTransition = z.object({
  recap: z.string().describe('Two or three sentences summing up the season that just ended'),
  departures: each(Departure).describe('Roughly a quarter to a third of the roster'),
  arrivals: each(NewCharacter).describe('Newcomers with full profiles, often built for next season\'s arcs'),
});

/** Attached to the first episode of a season, so replays re-create the same season. */
export const SeasonStart = z.object({
  season: z.number(),
  transition: SeasonTransition.nullable().catch(null),
  plan: SeasonPlan.nullable().catch(null),
});

export type PPV = z.infer<typeof PPV>;
export type Arc = z.infer<typeof Arc>;
export type SeasonPlan = z.infer<typeof SeasonPlan>;
export type SeasonTransition = z.infer<typeof SeasonTransition>;
export type SeasonStart = z.infer<typeof SeasonStart>;
