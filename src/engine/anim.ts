import type { HeadFrame, LowerFrame, PoseKey, UpperFrame } from './poses';

/** One keyframe of a two-person animation. `dx` values are measured from the attacker's
 *  starting position along the attacker's facing. */
export interface Keyframe {
  t: number;
  att?: PoseKey;
  def?: PoseKey;
  impact?: boolean;
}

export type Track = 'att' | 'def';

export interface Sample {
  head?: HeadFrame;
  upper?: UpperFrame;
  lower?: LowerFrame;
  rot?: number;
  dy?: number;
  dx?: number;
}

export function duration(keys: Keyframe[]): number {
  return keys.length ? keys[keys.length - 1].t : 0;
}

function lerpProp(keys: Keyframe[], track: Track, prop: 'rot' | 'dy' | 'dx', t: number): number | undefined {
  let prev: { t: number; v: number } | undefined;
  for (const k of keys) {
    const v = k[track]?.[prop];
    if (v === undefined) continue;
    if (k.t <= t) {
      prev = { t: k.t, v };
      continue;
    }
    if (!prev) return undefined; // before the first defined value: leave the actor as it was
    const f = (t - prev.t) / (k.t - prev.t);
    return prev.v + (v - prev.v) * f;
  }
  return prev?.v;
}

function lastFrame<P extends 'head' | 'upper' | 'lower'>(keys: Keyframe[], track: Track, prop: P, t: number) {
  let out: PoseKey[P] | undefined;
  for (const k of keys) {
    if (k.t > t) break;
    const v = k[track]?.[prop];
    if (v !== undefined) out = v;
  }
  return out;
}

/** Sample one track at time t: discrete frames switch at keys, numbers interpolate. */
export function sample(keys: Keyframe[], track: Track, t: number): Sample {
  return {
    head: lastFrame(keys, track, 'head', t),
    upper: lastFrame(keys, track, 'upper', t),
    lower: lastFrame(keys, track, 'lower', t),
    rot: lerpProp(keys, track, 'rot', t),
    dy: lerpProp(keys, track, 'dy', t),
    dx: lerpProp(keys, track, 'dx', t),
  };
}

export function impactTimes(keys: Keyframe[]): number[] {
  return keys.filter((k) => k.impact).map((k) => k.t);
}
