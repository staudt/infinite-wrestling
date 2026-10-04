// How the page gets its show. Episodes come from, in order:
//   1. the library (stored episodes, served by the dev server or GitHub Pages; free),
//   2. the booker server (LLM; new episodes are saved, extending the stored show).
// When neither has the episode the show stops and says why: viewers only ever see
// LLM-written shows.
import type { Episode } from '../schema/episode';
import type { PromotionNames } from '../world/genesis';
import { showId, type World } from '../world/state';
import { reviewEpisode } from './validate';

export type BookSource = 'llm' | 'stored';

/** Why an episode or promotion couldn't be produced. */
export interface Unavailable {
  /** offline: no booker server; no-llm: server without an API key; error: the LLM failed. */
  reason: 'offline' | 'no-llm' | 'error';
  message: string;
}

export interface Health { llm: boolean; model: string; planModel: string }

export interface LibraryEntry {
  /** Folder name and link id, e.g. "stw" (older shows: the seed). */
  id: string;
  seed: number;
  source: 'sessions' | 'library';
  showName: string;
  shortName: string;
  direction: string;
  episodes: number;
  updated: number;
}

const sourceOf = (s: unknown): BookSource => (s === 'cache' ? 'stored' : 'llm');

/** Turn a failed booker response into an Unavailable. */
async function unavailable(res: Response): Promise<Unavailable> {
  const body = await res.json().catch(() => null);
  if (body?.error === 'no-llm') return { reason: 'no-llm', message: body.message ?? 'no API key on the booker server' };
  if (body?.error) return { reason: 'error', message: body.message ?? 'the booker failed' };
  return { reason: 'offline', message: 'not connected to a booker server' };
}
const OFFLINE_REASON: Unavailable = { reason: 'offline', message: 'not connected to a booker server' };
const pad = (n: number) => String(n).padStart(3, '0');
/** Stored shows live next to the page (dev server middleware, or static files on GitHub Pages). */
const LIBRARY = `${import.meta.env.BASE_URL}library`;

// A season premiere may plan the season and shuffle the roster first (two extra calls).
const TIMEOUT_MS = 300_000;
/** Dev aid: `?offline=1` never calls the booker server (no API spend). */
const OFFLINE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('offline');

async function getJson<T>(url: string, timeout = 5000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Is the booker server up, and does it have an LLM? null = server unreachable. */
export async function fetchHealth(): Promise<Health | null> {
  if (OFFLINE) return null;
  return getJson<Health>('/api/health', 3000);
}

export async function fetchLibrary(): Promise<LibraryEntry[]> {
  return (await getJson<LibraryEntry[]>(`${LIBRARY}/index.json`)) ?? [];
}

export async function fetchStoredPromotion(id: string): Promise<World | null> {
  const w = await getJson<World>(`${LIBRARY}/${encodeURIComponent(id)}/promotion.json`);
  return w?.version === 2 ? { ...w, id } : null;
}

/** One stored episode, as stored (callers review it against the world it follows). */
export async function fetchStoredEpisode(id: string, n: number): Promise<unknown | null> {
  return getJson<unknown>(`${LIBRARY}/${encodeURIComponent(id)}/ep-${pad(n)}.json`);
}

/** The next episode for this world: stored first, then the LLM. */
export async function fetchEpisode(world: World): Promise<{ episode: Episode; source: BookSource } | ({ episode: null } & Unavailable)> {
  // Re-check everything on the client: the page must never play what it can't stage.
  const stored = await getJson<unknown>(`${LIBRARY}/${encodeURIComponent(showId(world))}/ep-${pad(world.episode + 1)}.json`);
  if (stored) {
    const review = reviewEpisode(stored, world);
    if (review.episode) return { episode: review.episode, source: 'stored' };
  }
  if (OFFLINE) return { episode: null, ...OFFLINE_REASON };
  try {
    const res = await fetch('/api/episode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ world }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { episode: null, ...(await unavailable(res)) };
    const body = await res.json();
    const review = reviewEpisode(body.episode, world);
    if (review.episode) return { episode: review.episode, source: sourceOf(body.source) };
    return { episode: null, reason: 'error', message: 'the booker sent an unplayable episode' };
  } catch {
    return { episode: null, ...OFFLINE_REASON };
  }
}

/** Ask the booker server to create a new promotion (needs the LLM). */
export async function fetchPromotion(direction: string, seed: number, names: PromotionNames = {}): Promise<{ world: World; source: BookSource } | ({ world: null } & Unavailable)> {
  if (OFFLINE) return { world: null, ...OFFLINE_REASON };
  try {
    const res = await fetch('/api/promotion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction, seed, ...names }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { world: null, ...(await unavailable(res)) };
    const body = await res.json();
    if (body.world?.version === 2) return { world: body.world, source: sourceOf(body.source) };
    return { world: null, reason: 'error', message: 'the booker sent an unusable promotion' };
  } catch {
    return { world: null, ...OFFLINE_REASON };
  }
}
