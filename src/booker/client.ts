// How the page gets its show. Episodes come from, in order:
//   1. the library (stored episodes, served by the dev server; free, works offline),
//   2. the booker server (LLM; new episodes are saved, extending the stored show),
//   3. the offline booker (templates, never saved).
import type { Episode } from '../schema/episode';
import type { World } from '../world/state';
import { offlineWorld } from '../world/genesis';
import { offlineBook } from './fallback';
import { reviewEpisode } from './validate';

export type BookSource = 'llm' | 'stored' | 'offline' | 'offline (server unreachable)';

export interface Health { llm: boolean; model: string; planModel: string }

export interface LibraryEntry {
  seed: number;
  source: 'sessions' | 'library';
  showName: string;
  shortName: string;
  direction: string;
  episodes: number;
  updated: number;
}

const sourceOf = (s: unknown): BookSource => (s === 'llm' ? 'llm' : s === 'cache' ? 'stored' : 'offline');
const pad = (n: number) => String(n).padStart(3, '0');

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
  return (await getJson<LibraryEntry[]>('/library/index.json')) ?? [];
}

export async function fetchStoredPromotion(seed: number): Promise<World | null> {
  const w = await getJson<World>(`/library/${seed}/promotion.json`);
  return w?.version === 2 ? w : null;
}

/** The next episode for this world: stored first, then the LLM, then offline. */
export async function fetchEpisode(world: World): Promise<{ episode: Episode; source: BookSource }> {
  // Re-check everything on the client: the page must never play what it can't stage.
  const stored = await getJson<unknown>(`/library/${world.seed}/ep-${pad(world.episode + 1)}.json`);
  if (stored) {
    const review = reviewEpisode(stored, world);
    if (review.episode) return { episode: review.episode, source: 'stored' };
  }
  if (OFFLINE) return { episode: offlineBook(world), source: 'offline' };
  try {
    const res = await fetch('/api/episode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ world }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const review = reviewEpisode(body.episode, world);
    if (review.episode) return { episode: review.episode, source: sourceOf(body.source) };
  } catch {
    return { episode: offlineBook(world), source: 'offline (server unreachable)' };
  }
  return { episode: offlineBook(world), source: 'offline' };
}

/** Ask the booker server to create a new promotion; falls back to the offline generator. */
export async function fetchPromotion(direction: string, seed: number): Promise<{ world: World; source: BookSource }> {
  if (OFFLINE) return { world: offlineWorld(seed, direction), source: 'offline' };
  try {
    const res = await fetch('/api/promotion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction, seed }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.world?.version === 2) return { world: body.world, source: sourceOf(body.source) };
  } catch {
    return { world: offlineWorld(seed, direction), source: 'offline (server unreachable)' };
  }
  return { world: offlineWorld(seed, direction), source: 'offline' };
}
