import roster from '../../data/classic-roster.json';
import type { Alignment, Division, Role, Style } from '../schema/episode';
import type { SeasonPlan } from '../schema/season';

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
  finisher: {
    name: string;
    move: string;
    /** What it looks like, e.g. "a spinning DDT off the second rope". */
    description?: string;
    /** The play-by-play's setup call, e.g. "He's measuring him for the Jackpot!" */
    call?: string;
  };
  color: string;
  hometown?: string;
  weight?: number;
  catchphrase?: string;
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
  /** Storage id (folder name), from the initials; older saves use the seed (see showId). */
  id?: string;
  /** Announce team at the desk (older saves lack it; see crewOf). */
  crew?: Crew;
  /** The current season's long-term plan (see world/season.ts). */
  plan?: SeasonPlan;
  /** One-line recaps of finished seasons. */
  seasonHistory?: { season: number; recap: string }[];
  /** Characters who left the promotion (candidates for comebacks). */
  alumni?: { id: string; name: string; reason: string; season: number }[];
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

export interface Crew {
  /** Play-by-play voice: calls the action. */
  pbp: string;
  /** Color commentator: a heel sympathizer with opinions. */
  color: string;
}

const PBP_NAMES = ['Gordon Sollie', 'Jim Rossiter', 'Tony Chiavone', 'Vince Kirby', 'Joey Styles-Bennett', 'Bob Caudle-Hayes', 'Lance Russo'];
const COLOR_NAMES = ['Jesse "The Mouth" Ventano', 'Bobby "The Brain" Heenly', 'Dusty "Big Talk" Rhodes', 'Mean Gene Dorsey', 'Rowdy Roddy MacLeod', 'Cornette the Racketeer'];

/** A show's storage id: its folder under sessions/ and library/. */
export function showId(w: Pick<World, 'id' | 'seed'>): string {
  return w.id || String(w.seed >>> 0);
}

/** "Mid-South Wrestling" -> "mid-south-wrestling": safe for folders, ids and URLs. */
export function slugId(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function crewOf(w: Pick<World, 'crew' | 'seed'>): Crew {
  if (w.crew?.pbp && w.crew.color) return w.crew;
  return {
    pbp: w.crew?.pbp || PBP_NAMES[w.seed % PBP_NAMES.length],
    color: w.crew?.color || COLOR_NAMES[(w.seed >>> 3) % COLOR_NAMES.length],
  };
}

/** Fixed desk colors, kept out of the wrestler palette so everyone stays distinct. */
export const CREW_COLORS = { pbp: '#9ecbff', color: '#ffb86b', announcer: '#f4f4f4', ref: '#b8b8b8' };

export const HISTORY_LIMIT = 60;
export const NOTES_LIMIT = 20;
export const ANGLE_LOG_LIMIT = 8;

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
