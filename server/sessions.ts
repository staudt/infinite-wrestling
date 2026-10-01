// On-disk store of everything the LLM generated, so nothing is paid for twice.
//   sessions/<world seed>/promotion.json   the world as created (your saved live shows)
//   sessions/<world seed>/ep-001.json      each booked episode
//   sessions/failures/*.json               raw tool input that needed repairs (for prompt tuning)
//   library/<world seed>/...               curated promotions committed to the repo (same layout)
// An episode is keyed by (world seed, episode number), which fully determines the world
// it was booked against, so a stored episode can always be replayed safely.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode } from '../src/schema/episode.ts';
import type { World } from '../src/world/state.ts';

const SESSIONS = process.env.SESSIONS_DIR || 'sessions';
const LIBRARY = process.env.LIBRARY_DIR || 'library';
/** Where stored shows are read from; new material is always written to sessions. */
const ROOTS = [SESSIONS, LIBRARY];
const pad = (n: number) => String(n).padStart(3, '0');

export interface LibraryEntry {
  seed: number;
  source: 'sessions' | 'library';
  showName: string;
  shortName: string;
  direction: string;
  episodes: number;
  updated: number;
}

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

/** Read a stored file for a show, from sessions first, then the committed library. */
export function readStored(seed: number, file: string): unknown {
  if (!/^(promotion|ep-\d{3})\.json$/.test(file)) return null;
  for (const root of ROOTS) {
    const v = readJson<unknown>(join(root, String(seed >>> 0), file));
    if (v) return v;
  }
  return null;
}

export function savePromotion(world: World): void {
  writeJson(join(SESSIONS, String(world.seed >>> 0), 'promotion.json'), world);
}

export function saveEpisode(worldSeed: number, number: number, ep: Episode): void {
  writeJson(join(SESSIONS, String(worldSeed >>> 0), `ep-${pad(number)}.json`), ep);
}

export function loadEpisode(worldSeed: number, number: number): Episode | null {
  return readStored(worldSeed, `ep-${pad(number)}.json`) as Episode | null;
}

/** Stored episodes for a show: the length of the unbroken run from episode 1. */
function episodeCount(seed: number): number {
  let n = 0;
  while (readStored(seed, `ep-${pad(n + 1)}.json`)) n++;
  return n;
}

/** Every stored show, newest first (a show in both places is listed once). */
export function listLibrary(): LibraryEntry[] {
  const out = new Map<number, LibraryEntry>();
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, 'promotion.json');
      if (!/^\d+$/.test(dir) || !existsSync(file)) continue;
      const w = readJson<World>(file);
      if (w?.version !== 2) continue;
      const seed = Number(dir);
      const prev = out.get(seed);
      const updated = statSync(join(root, dir)).mtimeMs;
      out.set(seed, {
        seed,
        source: prev?.source === 'library' || root === LIBRARY ? 'library' : 'sessions',
        showName: w.showName,
        shortName: w.shortName,
        direction: w.direction,
        episodes: episodeCount(seed),
        updated: Math.max(updated, prev?.updated ?? 0),
      });
    }
  }
  return [...out.values()].sort((a, b) => b.updated - a.updated);
}

export function saveFailure(tool: string, input: unknown, problems: string[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJson(join(SESSIONS, 'failures', `${stamp}-${tool}.json`), { problems, input });
}

export const dirs = { sessions: SESSIONS, library: LIBRARY };
