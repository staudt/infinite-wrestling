// On-disk store of everything the LLM generated, so nothing is paid for twice.
//   sessions/<world seed>/promotion.json   the world as created
//   sessions/<world seed>/ep-001.json      each booked episode
//   sessions/failures/*.json               raw tool input that needed repairs (for prompt tuning)
// An episode is keyed by (world seed, episode number), which fully determines the world
// it was booked against, so a stored episode can always be replayed safely.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode } from '../src/schema/episode';
import type { World } from '../src/world/state';

const ROOT = process.env.SESSIONS_DIR || 'sessions';
const pad = (n: number) => String(n).padStart(3, '0');
const dirFor = (seed: number) => join(ROOT, String(seed >>> 0));

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[sessions] could not write ${path}: ${(err as Error).message}`);
  }
}

export function savePromotion(world: World): void {
  writeJson(join(dirFor(world.seed), 'promotion.json'), world);
}

export function saveEpisode(worldSeed: number, number: number, ep: Episode): void {
  writeJson(join(dirFor(worldSeed), `ep-${pad(number)}.json`), ep);
}

export function loadEpisode(worldSeed: number, number: number): Episode | null {
  return readJson<Episode>(join(dirFor(worldSeed), `ep-${pad(number)}.json`));
}

/** The most recently created promotion, for `--cached` runs. */
export function latestPromotion(): { world: World; episodes: number } | null {
  if (!existsSync(ROOT)) return null;
  const sessions = readdirSync(ROOT)
    .map((d) => join(ROOT, d, 'promotion.json'))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of sessions) {
    const world = readJson<World>(f);
    if (world?.version === 2) {
      const episodes = readdirSync(join(f, '..')).filter((x) => /^ep-\d+\.json$/.test(x)).length;
      return { world, episodes };
    }
  }
  return null;
}

export function saveFailure(tool: string, input: unknown, problems: string[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJson(join(ROOT, 'failures', `${stamp}-${tool}.json`), { problems, input });
}
