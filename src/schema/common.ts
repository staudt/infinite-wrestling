// Building blocks shared by the episode, promotion and season schemas.
import { z } from 'zod';

export const Alignment = z.enum(['face', 'heel', 'tweener']);
export const Division = z.enum(['men', 'women']);
export const Style = z.enum(['brawler', 'technician', 'powerhouse', 'highflyer', 'showman']);
export const Role = z.enum(['wrestler', 'manager', 'valet']);

/** Character flavor used by the announcer, the desk and in-match moments. */
export function profileFields() {
  return {
    hometown: z.string().catch('').describe('Billed hometown, e.g. "Parts Unknown" or "Amarillo, Texas"'),
    weight: z.number().catch(0).describe('Billed weight in pounds'),
    catchphrase: z.string().catch('').describe('Short signature line the character yells'),
    finisherDescription: z.string().catch('').describe('What the finisher looks like, e.g. "a spinning DDT off the second rope"'),
    finisherCall: z.string().catch('').describe('How the play-by-play calls the setup, e.g. "He\'s measuring him for the Jackpot!"'),
  };
}
