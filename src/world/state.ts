import roster from '../../data/classic-roster.json';
import type { Alignment, Division, Role, Style } from '../schema/episode';

export type CharacterRole = Role | 'interviewer';

export interface Character {
  id: string;
  name: string;
  role: CharacterRole;
  alignment: Alignment;
  division: Division;
  style: Style;
  gimmick: string;
  entrance: string;
  finisher: { name: string; move: string };
  color: string;
}

export interface Title {
  id: string;
  name: string;
  division: Division;
  holder: string | null;
}

export interface Feud { a: string; b: string; reason: string; since: number }
export interface Alliance { name: string; members: string[]; since: number }
export interface HistoryEntry { episode: number; segment: string; recap: string }

export interface World {
  version: 2;
  showName: string;
  /** Short brand shown on the ring apron, e.g. "GPTWW". */
  shortName: string;
  /** Optional creative direction for the whole promotion (e.g. "ECW-style hardcore"). */
  direction: string;
  /** Random per-world seed: two worlds never stage the same show. */
  seed: number;
  /** Number of the last episode booked into this state (0 = fresh world). */
  episode: number;
  characters: Character[];
  titles: Title[];
  feuds: Feud[];
  alliances: Alliance[];
  notes: { episode: number; text: string }[];
  history: HistoryEntry[];
  /** Kinds of angles used per episode, fed back to the booker to avoid repetition. */
  angleLog: { episode: number; kinds: string[] }[];
  storySoFar: string;
}

export const HISTORY_LIMIT = 60;
export const NOTES_LIMIT = 20;
export const ANGLE_LOG_LIMIT = 8;

/** Colors handed out to generated and debuting characters (distinct on a dark background). */
export const DEBUT_COLORS = [
  '#4fa3ff', '#ff4f7b', '#ffe14f', '#b07cff', '#ff9d3b', '#c9372c', '#4fffd0', '#8fd14f',
  '#f0f0f0', '#9a9a9a', '#d9a066', '#ff7ae0', '#5ee05e', '#e0c35e', '#ffb3c7',
  '#7fdbff', '#ffdc00', '#01ff70', '#f012be', '#ff851b', '#39cccc', '#b10dc9', '#ffa0a0',
  '#a0ffa0', '#a0a0ff', '#ffd27f', '#c0ffee',
];

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32) >>> 0;
}

/** The hand-written GPTWW roster: used by tests and as the `--classic` preset. */
export function classicWorld(seed = 1): World {
  return {
    version: 2,
    showName: roster.showName,
    shortName: roster.shortName,
    direction: '',
    seed,
    episode: 0,
    characters: roster.characters.map((c) => ({ ...c, finisher: { ...c.finisher } })) as Character[],
    titles: roster.titles.map((t) => ({ ...t })) as Title[],
    feuds: roster.feuds.map((f) => ({ ...f, since: 0 })),
    alliances: roster.alliances.map((a) => ({ ...a, members: [...a.members], since: 0 })),
    notes: [],
    history: [],
    angleLog: [],
    storySoFar: roster.storySoFar,
  };
}

export function cloneWorld(w: World): World {
  return structuredClone(w);
}

export function charById(w: World, id: string): Character | undefined {
  return w.characters.find((c) => c.id === id);
}

export function wrestlers(w: World): Character[] {
  return w.characters.filter((c) => c.role === 'wrestler');
}

export function interviewer(w: World): Character {
  const c = w.characters.find((ch) => ch.role === 'interviewer');
  if (!c) throw new Error('world has no interviewer');
  return c;
}

export function titleHeldBy(w: World, id: string): Title | undefined {
  return w.titles.find((t) => t.holder === id);
}

export function alliesOf(w: World, id: string): string[] {
  const out = new Set<string>();
  for (const a of w.alliances) if (a.members.includes(id)) a.members.forEach((m) => m !== id && out.add(m));
  return [...out];
}

export function feudsOf(w: World, id: string): Feud[] {
  return w.feuds.filter((f) => f.a === id || f.b === id);
}

// Persistence. Browser uses localStorage; the CLI uses a JSON file (see cli/preview.ts).
const STORAGE_KEY = 'gptww.world';

export function loadWorldFromStorage(): World | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as World;
    return w.version === 2 ? w : null;
  } catch {
    return null;
  }
}

export function saveWorldToStorage(w: World): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  } catch {
    // storage unavailable (private mode, quota): the show keeps running without persistence
  }
}

export function clearWorldStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
