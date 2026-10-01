// NetHack-style arena view. Actors live in continuous arena units; this view quantizes
// them to character cells. Everything anyone says (wrestlers, announcer, referee, the
// desk) appears as a character-cell talk balloon above the speaker, with names painted
// in each character's color, so the eyes stay on the action. A sprite renderer can
// replace this file without touching the engine.
import type { Actor } from '../engine/actor';
import { arena } from '../engine/arena';
import type { CrowdLevel, EngineEvent } from '../engine/events';
import { PBP_ID, readTime, type Stage } from '../engine/stage';
import { NameIndex } from './names';

interface Cell { ch: string; cls: string; color?: string }

const W = arena.width;
const CROWD_TOP = 2;
const ROWS = CROWD_TOP + arena.depth; // back crowd, then arena rows (the last ones are the front crowd)
const FRONT_ROW = CROWD_TOP + arena.crowd.front;
const rowOf = (depth: number) => CROWD_TOP + Math.max(0, Math.min(arena.depth - 1, Math.round(depth)));
const colOf = (x: number) => Math.max(0, Math.min(W - 1, Math.round(x)));

const BALLOON_WIDTH = 30;
const BALLOON_LINES = 3;

/** Text colors for the play-by-play by narration style. */
const CALL_COLOR: Record<string, string> = {
  call: '#e6e6e6', big: '#ffe066', shock: '#ff5fd2', bell: '#7fe0e0', info: '#9a9ab8', count: '#ffffff', crowd: '#d8b84a',
};

const CROWD_SHOUTS: Record<CrowdLevel, { texts: string[]; color: string }> = {
  cheer: { texts: ['YEAH!', 'WOO!', 'ALRIGHT!'], color: '#5fa8ff' },
  pop: { texts: ['WOOOOO!', 'OHHH YEAH!', 'YESSS!'], color: '#8fd0ff' },
  boo: { texts: ['BOOOO!', 'BOOO!', 'YOU SUCK!'], color: '#e05a4a' },
  gasp: { texts: ['OHHHH!', 'OH MY!', 'NOOO!'], color: '#f0f0f0' },
  buzz: { texts: ['ooOOoo...', 'hmmm...', 'wha...?'], color: '#a898d0' },
  chant: { texts: [], color: '#e8c860' },
};

/** A balloon keeps the full text with per-character colors, so names stay colored across line breaks. */
interface Balloon { who: string; text: string; colors: (string | null)[]; bold: boolean[]; lines: [number, number][]; until: number; color: string; at: number }
interface Shout { text: string; color: string; row: number; col: number; until: number }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Word-wrap into [start, end) ranges of at most `max` lines; widens the balloon rather
 * than cutting the text.
 */
export function wrap(text: string, width: number, max: number): [number, number][] {
  const lines: [number, number][] = [];
  const words = [...text.matchAll(/\S+/g)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
  let cur: [number, number] | null = null;
  for (const [s, e] of words) {
    if (cur && e - cur[0] > width) {
      lines.push(cur);
      cur = [s, e];
    } else {
      cur = cur ? [cur[0], e] : [s, e];
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > max && width < 70) return wrap(text, width + 8, max);
  return lines;
}

function background(): Cell[][] {
  const g: Cell[][] = Array.from({ length: ROWS }, () => Array.from({ length: W }, () => ({ ch: ' ', cls: '' })));
  const put = (r: number, c: number, ch: string, cls: string) => {
    if (r >= 0 && r < ROWS && c >= 0 && c < W) g[r][c] = { ch, cls };
  };
  const r = arena.ring;
  // Stage and curtain
  for (let d = arena.stage.d0; d <= arena.stage.d1; d++) {
    for (let x = 0; x < arena.stage.x1; x++) put(rowOf(d), x, x <= 1 ? '█' : '·', x <= 1 ? 'curtain' : 'stagefloor');
  }
  // Ramp to the ring, with rails
  for (let x = arena.aisle.x0; x < arena.ringside.x0; x++) {
    put(rowOf(arena.aisle.depth), x, '·', 'aisle');
    put(rowOf(arena.aisle.depth - 1), x, '─', 'rail');
    put(rowOf(arena.aisle.depth + 1), x, '─', 'rail');
  }
  // Announce desk (commentators sit behind it; interviews happen in front of it)
  for (let x = arena.desk.x0; x <= arena.desk.x1; x++) put(rowOf(arena.desk.depth), x, '▀', 'desk');
  // The ring, with one cell of ringside floor around it
  for (let x = r.x0; x <= r.x1; x++) {
    for (let d = r.d0; d <= r.d1; d++) {
      const edgeX = x === r.x0 || x === r.x1;
      const edgeD = d === r.d0 || d === r.d1;
      if (edgeX && edgeD) put(rowOf(d), x, 'o', 'post');
      else if (edgeD) put(rowOf(d), x, '═', 'rope');
      else if (edgeX) put(rowOf(d), x, '║', 'rope');
      else put(rowOf(d), x, '·', 'canvas');
    }
  }
  return g;
}

/** How many rows up to draw someone (jumping, lifted, climbing a cage or ladder). */
const liftOf = (a: Actor) => (a.pose.dy >= 3 ? 2 : a.pose.dy >= 1.5 ? 1 : 0);

/** Cells that are part of the crowd (animated each frame). */
function isCrowd(r: number, c: number): boolean {
  if (r < CROWD_TOP || r >= FRONT_ROW) return true;
  const top = arena.crowd.top;
  if (r >= rowOf(top.depth) && r < rowOf(top.depth) + top.rows && c >= top.x0 && c <= top.x1) return true;
  return r < FRONT_ROW && c >= arena.crowd.right;
}

export class MapView {
  private readonly bg: Cell[][] = background();
  private crowd: CrowdLevel | 'idle' = 'idle';
  private crowdUntil = 0;
  private focus = new Set<string>();
  private balloons = new Map<string, Balloon>();
  private shouts: Shout[] = [];
  private names: NameIndex;
  private shoutSeed = 0;

  constructor(private el: HTMLElement, private stage: Stage) {
    this.names = new NameIndex(stage);
  }

  onEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'crowd':
        this.crowd = e.level;
        this.crowdUntil = e.t + 2.5;
        this.addShout(e.level, e.chant, e.t);
        break;
      case 'camera':
        this.focus = new Set(e.focus);
        break;
      case 'said': {
        const a = this.stage.actors.get(e.who);
        const until = e.t + Math.max(2.2, readTime(e.text, 'said'));
        this.balloons.set(e.who, this.balloon(e.who, e.text, e.tint ?? '#ececec', !e.tint, a?.color ?? '#fff', e.t, until));
        break;
      }
      case 'narrated': {
        // The play-by-play voice calls everything the engine narrates.
        const kind = e.style === 'big' || e.style === 'shock' ? 'big' : 'narrated';
        const until = e.t + Math.max(2.2, readTime(e.text, kind) + 0.6);
        this.balloons.set(PBP_ID, this.balloon(PBP_ID, e.text, CALL_COLOR[e.style] ?? '#e6e6e6', true, this.stage.pbp.color, e.t, until));
        break;
      }
      case 'despawn':
        this.balloons.delete(e.id);
        break;
      case 'segmentStart':
      case 'episodeStart':
        this.focus.clear();
        break;
    }
  }

  private balloon(who: string, text: string, base: string, names: boolean, color: string, at: number, until: number): Balloon {
    const colors: (string | null)[] = [];
    const bold: boolean[] = [];
    for (const run of names ? this.names.runs(text) : [{ text, color: null }]) {
      for (let i = 0; i < run.text.length; i++) {
        colors.push(run.color ?? base);
        bold.push(run.color !== null);
      }
    }
    return { who, text, colors, bold, lines: wrap(text, BALLOON_WIDTH, BALLOON_LINES), until, color, at };
  }

  private addShout(level: CrowdLevel, chant: string | undefined, t: number): void {
    const s = CROWD_SHOUTS[level];
    const n = this.shoutSeed++;
    const text = chant ? `♪ ${chant} ♪` : s.texts[n % s.texts.length];
    if (!text) return;
    // Spread shouts around the crowd: back rows, front row, or the side section.
    const spots = [
      { row: n % 2, col: 20 + ((n * 11) % 24) },
      { row: FRONT_ROW + (n % 2), col: 14 + ((n * 7) % 30) },
      { row: CROWD_TOP + 4 + ((n * 5) % 7), col: arena.crowd.right },
      { row: rowOf(arena.crowd.top.depth), col: arena.crowd.top.x0 + ((n * 3) % 12) },
    ];
    const { row, col } = spots[n % spots.length];
    this.shouts.push({ text, color: s.color, row, col: Math.max(0, Math.min(W - text.length, col)), until: t + (chant ? 3.2 : 2) });
    if (this.shouts.length > 5) this.shouts.shift();
  }

  private glyph(a: Actor): string {
    if (a.kind === 'ref') return 'r';
    if (a.kind === 'interviewer') return 'i';
    if (a.kind === 'commentator') return 'c';
    return '@';
  }

  render(): void {
    const t = this.stage.time;
    const g = this.bg.map((row) => row.map((c) => ({ ...c })));
    if (t > this.crowdUntil) this.crowd = 'idle';

    // Crowd: each seat shimmers; reactions light up a share of the seats.
    const tick = Math.floor(t * (this.crowd === 'idle' ? 1.3 : 4));
    const chars = this.crowd === 'idle' ? '▒░' : '^▒o▒';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < W; c++) {
        if (!isCrowd(r, c)) continue;
        const h = (Math.imul(c + 1, 73856093) ^ Math.imul(r + 1, 19349663) ^ Math.imul(tick + 1, 83492791)) >>> 0;
        const busy = this.crowd === 'idle' ? h % 9 === 0 : h % 3 === 0;
        g[r][c] = { ch: busy ? chars[h % chars.length] : '░', cls: `crowd crowd-${busy ? this.crowd : 'idle'}` };
      }
    }
    // Crowd shouts ride on top of the crowd.
    this.shouts = this.shouts.filter((s) => s.until > t);
    for (const s of this.shouts) this.paint(g, s.row, s.col, s.text, s.color, 'shout');

    // Match set pieces: the steel cage, the ladder, the prize hanging above the ring.
    const r = arena.ring;
    if (this.stage.cage) {
      for (let x = r.x0; x <= r.x1; x++) for (const d of [r.d0, r.d1]) g[rowOf(d)][x] = { ch: '#', cls: 'cage' };
      for (let d = r.d0; d <= r.d1; d++) for (const x of [r.x0, r.x1]) g[rowOf(d)][x] = { ch: '#', cls: 'cage' };
    }
    const prize = this.stage.prize;
    if (prize && !prize.taken) {
      const cx = Math.round((r.x0 + r.x1) / 2);
      g[rowOf(r.d0)][cx] = { ch: '★', cls: 'prize' };
      g[rowOf(r.d0) - 1][cx] = { ch: '¦', cls: 'prize-line' };
    }
    for (const p of this.stage.props) {
      if (p.state === 'under') continue;
      g[rowOf(p.depth)][colOf(p.x)] = { ch: p.state === 'down' ? '=' : 'H', cls: 'ladder' };
    }

    // Actors, back rows first so front-row actors win shared cells.
    const actors = this.stage.visibleActors().sort((a, b) => a.depth - b.depth);
    for (const a of actors) {
      const row = rowOf(a.depth);
      const c = colOf(a.x);
      const cls = ['actor', a.down ? 'down' : '', a.speaking ? 'speaking' : '', this.focus.has(a.id) ? 'focus' : '']
        .filter(Boolean).join(' ');
      g[row][c] = { ch: a.down ? '_' : this.glyph(a), cls, color: a.color };
      // Airborne or climbing: drawn a row or two up, with a shadow where they stand.
      const lift = Math.min(row, liftOf(a));
      if (lift > 0) {
        g[row - lift][c] = { ch: this.glyph(a), cls: 'actor air', color: a.color };
        if (g[row][c].cls.startsWith('actor')) g[row][c] = { ch: '.', cls: 'shadow' };
      }
    }

    this.drawBalloons(g, t);
    this.el.innerHTML = g.map((row) => this.rowHtml(row)).join('\n');
  }

  private paint(g: Cell[][], r: number, c: number, text: string, color: string, cls: string): void {
    let col = c;
    for (const run of this.names.runs(text)) {
      for (const ch of run.text) {
        if (r >= 0 && r < ROWS && col >= 0 && col < W) g[r][col] = { ch, cls: run.color ? `${cls} name` : cls, color: run.color ?? color };
        col++;
      }
    }
  }

  /**
   * Balloons are blocks of cells above the speaker with a ▾ tail. Placement tries a few
   * spots (above, nudged left/right, higher, then below) to avoid covering other
   * balloons; newer balloons win when nothing fits.
   */
  private drawBalloons(g: Cell[][], t: number): void {
    // Balloons try not to cover people or the announce desk.
    const taken: { r0: number; r1: number; c0: number; c1: number }[] = this.stage.visibleActors().map((a) => {
      const r = rowOf(a.depth);
      const c = colOf(a.x);
      return { r0: r, r1: r, c0: c, c1: c };
    });
    const deskRow = rowOf(arena.desk.depth);
    taken.push({ r0: deskRow, r1: deskRow, c0: arena.desk.x0, c1: arena.desk.x1 });
    const overlaps = (r0: number, r1: number, c0: number, c1: number) =>
      taken.some((b) => r0 <= b.r1 && r1 >= b.r0 && c0 <= b.c1 && c1 >= b.c0);
    const list = [...this.balloons.values()].sort((a, b) => a.at - b.at);
    for (const b of list) {
      const a = this.stage.actors.get(b.who);
      if (!a || !a.visible || t > b.until) {
        this.balloons.delete(b.who);
        continue;
      }
      const ar = rowOf(a.depth) - liftOf(a);
      const ac = colOf(a.x);
      const h = b.lines.length;
      const w = Math.min(W, Math.max(...b.lines.map(([s, e]) => e - s)) + 3); // edge bar + padding
      const center = Math.max(0, Math.min(W - w, ac - Math.floor(w / 2)));
      const leftOf = Math.max(0, Math.min(W - w, ac - w + 2));
      const rightOf = Math.max(0, Math.min(W - w, ac - 1));
      const candidates: { top: number; left: number; above: boolean }[] = [];
      for (const left of [center, leftOf, rightOf]) {
        for (const lift of [0, 1, 2]) candidates.push({ top: ar - 1 - h - lift, left, above: true });
      }
      for (const left of [center, leftOf, rightOf]) candidates.push({ top: ar + 2, left, above: false });
      const fits = (p: { top: number }) => p.top >= 0 && p.top + h <= ROWS;
      const spot =
        candidates.find((p) => fits(p) && !overlaps(p.top, p.top + h, p.left, p.left + w - 1)) ??
        candidates.find(fits) ??
        { top: Math.max(0, ar - 1 - h), left: center, above: true };
      taken.push({ r0: spot.top - (spot.above ? 0 : 1), r1: spot.top + h, c0: spot.left, c1: spot.left + w - 1 });

      b.lines.forEach(([s, e], i) => {
        const r = spot.top + i;
        if (r < 0 || r >= ROWS) return;
        for (let c = spot.left; c < spot.left + w; c++) g[r][c] = { ch: ' ', cls: 'bubble' };
        g[r][spot.left] = { ch: '▌', cls: 'bubble edge', color: b.color };
        for (let k = s; k < e && spot.left + 2 + k - s < W; k++) {
          const color = b.colors[k] ?? '#ececec';
          g[r][spot.left + 2 + k - s] = { ch: b.text[k], cls: b.bold[k] ? 'bubble name' : 'bubble', color };
        }
      });
      // Tail pointing at the speaker.
      const tailRow = spot.above ? spot.top + h : spot.top - 1;
      const tailCol = Math.max(spot.left, Math.min(spot.left + w - 1, ac));
      if (tailRow >= 0 && tailRow < ROWS && tailRow !== ar) {
        g[tailRow][tailCol] = { ch: spot.above ? '▾' : '▴', cls: 'tail', color: b.color };
      }
    }
  }

  private rowHtml(row: Cell[]): string {
    let html = '';
    let run = '';
    let key = '';
    const flush = () => {
      if (!run) return;
      const [cls, color] = key.split('|');
      html += cls || color ? `<span class="${cls}"${color ? ` style="color:${color}"` : ''}>${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (const c of row) {
      const k = `${c.cls}|${c.color ?? ''}`;
      if (k !== key) {
        flush();
        key = k;
      }
      run += c.ch;
    }
    flush();
    return html;
  }

}
