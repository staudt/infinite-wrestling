import movesData from '../../data/moves.json';
import type { Keyframe } from '../engine/anim';
import type { BodyState } from '../engine/poses';
import type { Style } from '../schema/episode';

export type MoveKind =
  | 'strike' | 'grapple' | 'whip' | 'ground' | 'aerial' | 'submission' | 'cheat' | 'weapon' | 'pin'
  /** Only on the floor outside the ring. */
  | 'outside'
  /** Sends the opponent from the ring to the floor. */
  | 'toss'
  /** Only inside a steel cage. */
  | 'cage';

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
export const RANDOM_POOL = MOVES.filter((m) => !['pin', 'weapon', 'cheat', 'outside', 'toss', 'cage'].includes(m.kind));
/** What makes sense on the floor: the outside moves plus basic strikes and stomps. */
export const OUTSIDE_POOL = MOVES.filter((m) => m.kind === 'outside' || ['punch', 'chop', 'forearm', 'headbutt', 'kick_gut', 'stomp'].includes(m.id));
export const CHEATS = MOVES.filter((m) => m.kind === 'cheat');
export const SUBMISSIONS = MOVES.filter((m) => m.kind === 'submission');
