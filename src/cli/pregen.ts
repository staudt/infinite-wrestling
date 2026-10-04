// Pre-generate a show: create a promotion (or pick up a stored one) and book episodes
// ahead of time without airing them. Everything is saved under sessions/, so the show
// appears in the start screen's "Stored shows" and plays back for free.
//   npm run pregen -- [--direction "…"] [--name "…"] [--initials XYZ] [--seasons 1 | --episodes 12]
//   npm run pregen -- --show <id> --seasons 1      extend a stored show (id from npm run library)
import { bookEpisode, createPromotion, llmAvailable } from '../../server/booker';
import { readStored } from '../../server/sessions';
import { reviewEpisode } from '../booker/validate';
import type { Episode } from '../schema/episode';
import { applyEpisode } from '../world/apply';
import { episodeLabel, SEASON_LENGTH } from '../world/season';
import { randomSeed, showId, type World } from '../world/state';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const args = process.argv.slice(2);
const arg = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!llmAvailable()) {
  console.error('pregen needs ANTHROPIC_API_KEY (offline episodes are never stored).');
  process.exit(1);
}

let world: World;
const showArg = arg('show') ?? arg('seed');
if (showArg) {
  const stored = readStored(showArg, 'promotion.json') as World | null;
  if (!stored) {
    console.error(`no stored promotion "${showArg}" (see npm run library)`);
    process.exit(1);
  }
  world = { ...stored, id: showArg };
  // Replay the stored episodes to reach the current state (free: nothing is re-booked).
  for (;;) {
    const ep = readStored(showId(world), `ep-${String(world.episode + 1).padStart(3, '0')}.json`);
    if (!ep) break;
    const r = reviewEpisode(ep, world);
    if (!r.episode) break;
    world = applyEpisode(world, r.episode);
  }
  console.error(`[pregen] "${world.showName}" (${showId(world)}): ${world.episode} stored episodes`);
} else {
  const created = await createPromotion(arg('direction') ?? '', randomSeed(), { showName: arg('name'), shortName: arg('initials') });
  if (!created.world) {
    console.error(`[pregen] couldn't create a promotion: ${created.message}`);
    process.exit(1);
  }
  world = created.world;
  console.error(`[pregen] created "${world.showName}" (id ${showId(world)}) by ${created.source}`);
}

const count = arg('episodes') ? Number(arg('episodes')) : Number(arg('seasons') ?? 1) * SEASON_LENGTH;
for (let i = 0; i < count; i++) {
  const t0 = Date.now();
  const booked = await bookEpisode(world);
  if (!booked.episode) {
    console.error(`[pregen] stopping: ${booked.message}`);
    break;
  }
  const ep: Episode = booked.episode;
  world = applyEpisode(world, ep);
  console.error(`[pregen] ${episodeLabel(world, world.episode)}: "${ep.title}" (${booked.source}, ${Math.round((Date.now() - t0) / 1000)}s)`);
}
console.error(`[pregen] done: "${world.showName}" has ${world.episode} stored episodes (id ${showId(world)})`);
