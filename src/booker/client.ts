import type { Episode } from '../schema/episode';
import type { World } from '../world/state';
import { offlineWorld } from '../world/genesis';
import { fallbackEpisode } from './fallback';
import { reviewEpisode } from './validate';

export type BookSource = 'llm' | 'cache' | 'offline' | 'offline (server unreachable)';

const sourceOf = (s: unknown): BookSource => (s === 'llm' || s === 'cache' ? s : 'offline');

const TIMEOUT_MS = 150_000;

/** Ask the proxy for the next episode; any failure falls back to the offline booker. */
export async function fetchEpisode(world: World): Promise<{ episode: Episode; source: BookSource }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch('/api/episode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ world }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Re-check on the client: the page must never play an episode the engine can't stage.
    const review = reviewEpisode(body.episode, world);
    if (review.episode) return { episode: review.episode, source: sourceOf(body.source) };
  } catch {
    return { episode: fallbackEpisode(world), source: 'offline (server unreachable)' };
  }
  return { episode: fallbackEpisode(world), source: 'offline' };
}

/** Ask the proxy to create a new promotion; falls back to the offline generator. */
export async function fetchPromotion(direction: string, seed: number): Promise<{ world: World; source: BookSource }> {
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
