import type { Alignment, Finish, Mood, NarrationStyle, Stipulation } from '../schema/episode';
import type { BodyState, Pose } from './poses';

export type CrowdLevel = 'cheer' | 'boo' | 'gasp' | 'chant' | 'buzz' | 'pop';

// Discrete happenings emitted by the engine. Views subscribe to these; for continuous
// state (actor positions) they read the Stage snapshot each frame.
export type EngineEvent = { t: number } & (
  | { type: 'episodeStart'; number: number; title: string; /** e.g. "Season 1 · Episode 4 — PPV: Summer Slaughter" */ label: string; ppv: string | null }
  | { type: 'episodeEnd'; number: number }
  | { type: 'segmentStart'; index: number; title: string }
  | { type: 'segmentEnd'; index: number; recap: string }
  | { type: 'spawn'; id: string }
  | { type: 'despawn'; id: string }
  | { type: 'poseChanged'; id: string; pose: Pose; bodyState: BodyState }
  | { type: 'moveStarted'; att: string; def: string; move: string; name: string }
  | { type: 'moveImpact'; att: string; def: string; move: string }
  | { type: 'moveEnded'; att: string; def: string; move: string }
  | { type: 'said'; who: string; text: string; mood: Mood; /** Text color override, e.g. pin counts in the coverer's color. */ tint?: string }
  | { type: 'narrated'; text: string; style: NarrationStyle | 'info' | 'bell' | 'count' }
  | { type: 'music'; who: string }
  | { type: 'crowd'; level: CrowdLevel; chant?: string }
  | { type: 'camera'; focus: string[] }
  | { type: 'bell' }
  | { type: 'pinCount'; count: 1 | 2 | 3; kickout: boolean; coverer: string }
  | { type: 'matchStart'; wrestlers: string[]; title: string | null; stipulation: Stipulation }
  | { type: 'elimination'; who: string; by: string; remaining: number }
  | { type: 'matchEnd'; winner: string | null; loser: string | null; finish: Finish }
  | { type: 'titleChange'; title: string; newChampion: string }
  | { type: 'alignmentChanged'; id: string; alignment: Alignment }
);

export type EventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

// Distributes Omit over the union so each variant keeps its own fields.
export type EventInput = EngineEvent extends infer E ? (E extends EngineEvent ? Omit<E, 't'> : never) : never;

export class EventBus {
  private listeners: ((e: EngineEvent) => void)[] = [];

  constructor(private clock: () => number) {}

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  emit(e: EventInput): void {
    const ev = { ...e, t: Math.round(this.clock() * 1000) / 1000 } as EngineEvent;
    for (const l of this.listeners) l(ev);
  }
}
