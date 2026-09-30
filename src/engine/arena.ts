import arenaData from '../../data/arena.json';
import type { Place } from '../schema/episode';

export interface Point { x: number; depth: number }

export const arena = arenaData;

export type Zone = 'backstage' | 'stage' | 'aisle' | 'podium' | 'ringside' | 'ring';

export function inRing(p: Point): boolean {
  const r = arena.ring;
  return p.x > r.x0 && p.x < r.x1 && p.depth > r.d0 && p.depth < r.d1;
}

export function zoneOf(p: Point, visible: boolean): Zone {
  if (!visible) return 'backstage';
  if (inRing(p)) return 'ring';
  if (p.x >= arena.ringside.x0) return 'ringside';
  if (p.x >= arena.podium.x0 && p.x <= arena.podium.x1 && p.depth < 2.5) return 'podium';
  if (p.x < arena.stage.x1) return 'stage';
  return 'aisle';
}

/** Keep a point inside the ring ropes. */
export function clampToRing(p: Point): Point {
  const r = arena.ring;
  return {
    x: Math.min(r.x1 - 1.5, Math.max(r.x0 + 1.5, p.x)),
    depth: Math.min(r.d1 - 1, Math.max(r.d0 + 1, p.depth)),
  };
}

/** The spot to stand on for a place. `slot` spreads several people apart. */
export function placePoint(place: Place, slot = 0): Point {
  switch (place) {
    case 'ring':
      return arena.ringSpots[slot % arena.ringSpots.length];
    case 'stage':
      return { x: arena.stage.spot.x - (slot % 3) * 1.5, depth: arena.stage.spot.depth + (slot % 2 ? 1.5 : 0) };
    case 'aisle':
      return { x: arena.aisle.spot.x + slot * 3, depth: arena.aisle.depth };
    case 'podium':
      return slot === 0 ? arena.podium.guest : { x: arena.podium.guest.x + 2 * slot, depth: arena.podium.guest.depth + 1 };
  }
}

export const curtain: Point = arena.curtain;
export const ringEntry: Point = arena.ringEntry;
