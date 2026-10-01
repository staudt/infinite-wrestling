import type { Alignment } from '../schema/episode';
import type { Character } from '../world/state';
import type { Keyframe, Track } from './anim';
import { inRing, type Point, type Zone, zoneOf } from './arena';
import { type BodyState, GROUNDED, type Pose, STANDING } from './poses';

export type ActorKind = 'wrestler' | 'manager' | 'valet' | 'interviewer' | 'ref' | 'commentator';

export type Pace = 'walk' | 'run' | 'stagger' | 'strut';
export const SPEED: Record<Pace, number> = { walk: 5, run: 13, stagger: 2.5, strut: 3.5 };

export interface ActiveAnim {
  keys: Keyframe[];
  track: Track;
  start: number;
  /** Attacker's position and facing when the move started; all dx are relative to this. */
  origin: Point;
  facing: 1 | -1;
}

export class Actor {
  x: number;
  depth: number;
  facing: 1 | -1 = 1;
  visible = false;
  bodyState: BodyState = 'standing';
  pose: Pose = { ...STANDING };
  alignment: Alignment;
  target: Point | null = null;
  speed = 0;
  anim: ActiveAnim | null = null;
  /** Who this actor is looking at (for views that want to turn heads). */
  lookingAt: string | null = null;
  speaking = false;
  holdsMic = false;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly kind: ActorKind,
    readonly color: string,
    alignment: Alignment,
    readonly character: Character | null,
    at: Point,
  ) {
    this.x = at.x;
    this.depth = at.depth;
    this.alignment = alignment;
  }

  get pos(): Point {
    return { x: this.x, depth: this.depth };
  }

  get inRing(): boolean {
    return this.visible && inRing(this.pos);
  }

  get zone(): Zone {
    return zoneOf(this.pos, this.visible);
  }

  get moving(): boolean {
    return this.target !== null;
  }

  /** Crew who are never part of the storyline action (ref, announcer, desk). */
  get crew(): boolean {
    return this.kind === 'ref' || this.kind === 'interviewer' || this.kind === 'commentator';
  }

  get down(): boolean {
    return this.bodyState === 'grounded';
  }

  /** The resting pose for the current body state. */
  basePose(): Pose {
    switch (this.bodyState) {
      case 'grounded':
        return { ...GROUNDED };
      case 'kneeling':
        return { ...STANDING, lower: 'kneel', head: 'hurt', upper: 'hurt' };
      case 'reeling':
        return { ...STANDING, lower: 'run' };
      case 'corner':
        return { ...STANDING, upper: 'hurt', head: 'hurt' };
      default:
        return { ...STANDING, upper: this.holdsMic ? 'mic' : 'idle' };
    }
  }
}
