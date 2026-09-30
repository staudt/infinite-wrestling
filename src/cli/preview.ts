// Headless preview: book and "air" episodes in the terminal, printing the play-by-play.
//   npm run preview -- --episodes 3 [--offline] [--quiet]
//   npm run preview -- --new [--direction "ECW-style hardcore"] [--classic] [--cached]   start a new world
// World state persists in ./world.json; transcripts and episode JSON go to ./shows/.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { bookEpisode, createPromotion, llmAvailable } from '../../server/booker';
import { fallbackEpisode } from '../booker/fallback';
import { Stage } from '../engine/stage';
import { prepareStage } from '../show/runner';
import { clock, transcriptLine } from '../view/transcript';
import { offlineWorld } from '../world/genesis';
import { classicWorld, randomSeed, type World } from '../world/state';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(`--${f}`);
const opt = (f: string, d: number) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const str = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? (args[i + 1] ?? '') : '';
};

const WORLD_FILE = 'world.json';
const episodes = opt('episodes', 1);
const offline = flag('offline') || !llmAvailable();
let world: World | null = null;
if (!flag('new') && existsSync(WORLD_FILE)) {
  const saved = JSON.parse(readFileSync(WORLD_FILE, 'utf8'));
  if (saved.version === 2) world = saved;
}
if (!world) {
  const seed = randomSeed();
  const direction = str('direction');
  if (flag('classic')) world = classicWorld(seed);
  else if (offline) world = offlineWorld(seed, direction);
  else {
    const created = await createPromotion(direction, seed, flag('cached'));
    console.error(`[genesis] "${created.world.showName}" created by ${created.source}`);
    world = created.world;
  }
  const cast = world.characters.map((c) => `  ${c.id.padEnd(18)} ${c.role.padEnd(8)} ${c.alignment.padEnd(7)} ${c.division.padEnd(5)} ${c.name} — ${c.gimmick}`);
  console.error(`[genesis] ${world.showName} (${world.shortName})${world.direction ? ` — ${world.direction}` : ''}\n${cast.join('\n')}\n[genesis] ${world.storySoFar}`);
}
if (flag('new')) rmSync('shows', { recursive: true, force: true });
mkdirSync('shows', { recursive: true });

for (let i = 0; i < episodes; i++) {
  const t0 = Date.now();
  const booked = offline
    ? { episode: fallbackEpisode(world), source: 'offline' as const, problems: [] as string[] }
    : await bookEpisode(world);
  const ep = booked.episode;
  console.error(`[booker] episode ${world.episode + 1} from ${booked.source} in ${Date.now() - t0}ms` +
    (booked.problems.length ? ` (${booked.problems.length} problems fixed: ${booked.problems.join('; ')})` : ''));

  const stage = new Stage(0);
  const { director, after } = prepareStage(stage, world, ep);
  const lines: string[] = [];
  stage.on((e) => {
    const l = transcriptLine(stage, e);
    if (l === null) return;
    lines.push(l);
    if (!flag('quiet')) console.log(l);
  });
  stage.runToEnd(director.play());
  console.error(`[show] episode ${after.episode} ran ${clock(stage.time)} of show time`);

  const tag = String(after.episode).padStart(3, '0');
  writeFileSync(`shows/ep-${tag}.json`, JSON.stringify(ep, null, 2));
  writeFileSync(`shows/ep-${tag}.md`, lines.join('\n') + '\n');
  world = after;
  writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2));
}
