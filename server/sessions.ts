// On-disk store of everything the LLM generated, so nothing is paid for twice.
//   sessions/<show id>/promotion.json   the world as created (your saved live shows)
//   sessions/<show id>/ep-001.json      each booked episode
//   sessions/failures/*.json            raw tool input that needed repairs (for prompt tuning)
//   library/<show id>/...               curated promotions committed to the repo (same layout)
// The show id comes from the initials ("stw"); older shows use their seed. An episode is
// keyed by (show, episode number), which fully determines the world it was booked
// against, so a stored episode can always be replayed safely.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode } from '../src/schema/episode.ts';
import { showId, slugId, type World } from '../src/world/state.ts';

const SESSIONS = process.env.SESSIONS_DIR || 'sessions';
const LIBRARY = process.env.LIBRARY_DIR || 'library';
/** Where stored shows are read from; new material is always written to sessions. */
const ROOTS = [SESSIONS, LIBRARY];
const pad = (n: number) => String(n).padStart(3, '0');

export interface LibraryEntry {
  id: string;
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

/** Show folders: an id like "stw" or "stw-2", or a seed for older shows. */
export const SHOW_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Read a stored file for a show, from sessions first, then the committed library. */
export function readStored(id: string, file: string): unknown {
  if (!SHOW_ID.test(id) || !/^(promotion|ep-\d{3})\.json$/.test(file)) return null;
  for (const root of ROOTS) {
    const v = readJson<unknown>(join(root, id, file));
    if (v) return v;
  }
  return null;
}

/** A free id for a new show, from its initials: "stw", or "stw-2" if that one is taken. */
export function newShowId(initials: string, seed: number): string {
  const base = slugId(initials) || String(seed >>> 0);
  const taken = (id: string) => ROOTS.some((root) => existsSync(join(root, id)));
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

export function savePromotion(world: World): void {
  writeJson(join(SESSIONS, showId(world), 'promotion.json'), world);
}

export function saveEpisode(world: World, number: number, ep: Episode): void {
  writeJson(join(SESSIONS, showId(world), `ep-${pad(number)}.json`), ep);
}

export function loadEpisode(world: World, number: number): Episode | null {
  return readStored(showId(world), `ep-${pad(number)}.json`) as Episode | null;
}

/** Stored episodes for a show: the length of the unbroken run from episode 1. */
function episodeCount(id: string): number {
  let n = 0;
  while (readStored(id, `ep-${pad(n + 1)}.json`)) n++;
  return n;
}

/** Every stored show, newest first (a show in both places is listed once). */
export function listLibrary(): LibraryEntry[] {
  const out = new Map<string, LibraryEntry>();
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, 'promotion.json');
      if (!SHOW_ID.test(dir) || !existsSync(file)) continue;
      const w = readJson<World>(file);
      if (w?.version !== 2) continue;
      const prev = out.get(dir);
      const updated = statSync(join(root, dir)).mtimeMs;
      out.set(dir, {
        id: dir,
        seed: w.seed,
        source: prev?.source === 'library' || root === LIBRARY ? 'library' : 'sessions',
        showName: w.showName,
        shortName: w.shortName,
        direction: w.direction,
        episodes: episodeCount(dir),
        updated: Math.max(updated, prev?.updated ?? 0),
      });
    }
  }
  // The same show under two folders (e.g. a saved copy of a library show): list it once.
  const bySeed = new Map<number, LibraryEntry>();
  for (const e of out.values()) {
    const prev = bySeed.get(e.seed);
    if (!prev || (e.source === 'library' && prev.source !== 'library')) bySeed.set(e.seed, e);
  }
  return [...bySeed.values()].sort((a, b) => b.updated - a.updated);
}

export function saveFailure(tool: string, input: unknown, problems: string[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJson(join(SESSIONS, 'failures', `${stamp}-${tool}.json`), { problems, input });
}

export const dirs = { sessions: SESSIONS, library: LIBRARY };

/**
 * Everything in the committed library as static files (for the GitHub Pages build):
 * library/index.json plus each show's promotion.json and episodes.
 */
export function exportLibrary(): { path: string; content: string }[] {
  if (!existsSync(LIBRARY)) return [{ path: 'library/index.json', content: '[]' }];
  const files: { path: string; content: string }[] = [];
  const entries: LibraryEntry[] = [];
  for (const dir of readdirSync(LIBRARY)) {
    const promo = readJson<World>(join(LIBRARY, dir, 'promotion.json'));
    if (!SHOW_ID.test(dir) || promo?.version !== 2) continue;
    const eps = readdirSync(join(LIBRARY, dir)).filter((f) => /^ep-\d{3}\.json$/.test(f)).sort();
    for (const f of ['promotion.json', ...eps]) {
      files.push({ path: `library/${dir}/${f}`, content: readFileSync(join(LIBRARY, dir, f), 'utf8') });
    }
    entries.push({
      id: dir, seed: promo.seed, source: 'library', showName: promo.showName, shortName: promo.shortName,
      direction: promo.direction, episodes: eps.length, updated: statSync(join(LIBRARY, dir)).mtimeMs,
    });
  }
  files.push({ path: 'library/index.json', content: JSON.stringify(entries) });
  return files;
}
