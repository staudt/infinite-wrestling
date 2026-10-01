import { Director } from '../choreo/director';
import { hashSeed } from '../engine/rng';
import { Stage } from '../engine/stage';
import type { Episode } from '../schema/episode';
import { applyEpisode } from '../world/apply';
import { episodeLabel, isFinale, ppvName } from '../world/season';
import type { World } from '../world/state';

/** Seed for an episode's staging, so the same episode always plays out identically. */
export function episodeSeed(worldSeed: number, number: number, ep: Episode): number {
  return hashSeed('stage', worldSeed, number, ep.title, ep.segments.length);
}

/**
 * Prepare a stage to air `ep` on top of `before` (the world prior to the episode).
 * The cast includes debuts but keeps pre-episode alignments and champions; the show
 * itself updates those as turns and title changes air.
 */
export function prepareStage(stage: Stage, before: World, ep: Episode): { director: Director; after: World } {
  const after = applyEpisode(before, ep);
  const number = after.episode;
  const cast: World = {
    ...before,
    characters: after.characters.map((c) => {
      const prior = before.characters.find((p) => p.id === c.id);
      return prior ? { ...c, alignment: prior.alignment } : c;
    }),
  };
  stage.setCast(cast);
  stage.reseed(episodeSeed(before.seed, number, ep));
  const meta = { label: episodeLabel(after, number), ppv: ppvName(after, number), finale: isFinale(number) };
  return { director: new Director(stage, ep, number, meta), after };
}
