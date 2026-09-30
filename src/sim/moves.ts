import movesData from '../../data/moves.json';
import type { Keyframe } from '../engine/anim';
import type { BodyState } from '../engine/poses';
import type { Style } from '../schema/episode';

export type MoveKind =
  | 'strike' | 'grapple' | 'whip' | 'ground' | 'aerial' | 'submission' | 'cheat' | 'weapon' | 'pin';

export interface Move {
  id: string;
  name: string;
  kind: MoveKind;
  damage: number;
  big: boolean;
  styles: Style[];
  text: string[];
  requires: { def: BodyState[] };
  result: { att: BodyState; def: BodyState };
  keys: Keyframe[];
}

export const MOVES: Move[] = movesData as Move[];
const BY_ID = new Map(MOVES.map((m) => [m.id, m]));

export function move(id: string): Move {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`unknown move ${id}`);
  return m;
}

export function hasMove(id: string): boolean {
  return BY_ID.has(id);
}

/** Moves the sim may pick on its own (specials like pins and weapons are scripted). */
export const RANDOM_POOL = MOVES.filter((m) => m.kind !== 'pin' && m.kind !== 'weapon' && m.kind !== 'cheat');
export const CHEATS = MOVES.filter((m) => m.kind === 'cheat');
export const SUBMISSIONS = MOVES.filter((m) => m.kind === 'submission');
