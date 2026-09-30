// The fixed 3-part pose vocabulary. The future sprite renderer draws one image per
// (part, frame); the ASCII view ignores poses. Moves and choreography may only use these.
export const HEAD = ['neutral', 'shout', 'hurt', 'look_up'] as const;
export const UPPER = [
  'idle', 'guard', 'punch', 'chop', 'grab', 'lift', 'overhead', 'point', 'mic', 'arms_up', 'hurt',
] as const;
export const LOWER = ['stand', 'walk', 'run', 'crouch', 'kneel', 'jump', 'lying'] as const;

export type HeadFrame = (typeof HEAD)[number];
export type UpperFrame = (typeof UPPER)[number];
export type LowerFrame = (typeof LOWER)[number];

export interface Pose {
  head: HeadFrame;
  upper: UpperFrame;
  lower: LowerFrame;
  /** Whole-body rotation in degrees (0 = upright, 90 = lying face up). */
  rot: number;
  /** Vertical offset in arena units (positive = up), for lifts and jumps. */
  dy: number;
}

/** A partial pose inside a keyframe. `dx` is only meaningful for the defender track. */
export interface PoseKey {
  head?: HeadFrame;
  upper?: UpperFrame;
  lower?: LowerFrame;
  rot?: number;
  dy?: number;
  dx?: number;
}

export const STANDING: Pose = { head: 'neutral', upper: 'idle', lower: 'stand', rot: 0, dy: 0 };
export const GROUNDED: Pose = { head: 'hurt', upper: 'hurt', lower: 'lying', rot: 90, dy: 0 };

export type BodyState = 'standing' | 'grounded' | 'kneeling' | 'airborne' | 'corner' | 'reeling';

export function isPoseKey(k: unknown): boolean {
  if (!k || typeof k !== 'object') return false;
  const p = k as Record<string, unknown>;
  if (p.head !== undefined && !(HEAD as readonly unknown[]).includes(p.head)) return false;
  if (p.upper !== undefined && !(UPPER as readonly unknown[]).includes(p.upper)) return false;
  if (p.lower !== undefined && !(LOWER as readonly unknown[]).includes(p.lower)) return false;
  for (const n of ['rot', 'dy', 'dx']) {
    if (p[n] !== undefined && typeof p[n] !== 'number') return false;
  }
  return true;
}
