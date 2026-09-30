// NetHack-style arena view. Actors live in continuous arena units; this view quantizes
// them to character cells. A sprite renderer can replace this file without touching
// the engine.
import type { Actor } from '../engine/actor';
import { arena } from '../engine/arena';
import type { CrowdLevel, EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';

interface Cell { ch: string; cls: string; color?: string }

const W = arena.width;
const CROWD_TOP = 2;
const ROWS = CROWD_TOP + arena.depth + 2; // crowd, walkable depth rows, front row, labels
const rowOf = (depth: number) => CROWD_TOP + Math.max(0, Math.min(arena.depth - 1, Math.round(depth)));
const colOf = (x: number) => Math.max(0, Math.min(W - 1, Math.round(x)));

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function background(): Cell[][] {
  const g: Cell[][] = Array.from({ length: ROWS }, () => Array.from({ length: W }, () => ({ ch: ' ', cls: '' })));
  const put = (r: number, c: number, ch: string, cls: string) => {
    if (r >= 0 && r < ROWS && c >= 0 && c < W) g[r][c] = { ch, cls };
  };
  const r = arena.ring;
  // Stage + curtain
  for (let d = 1; d < arena.depth - 1; d++) {
    for (let x = 0; x < arena.stage.x1; x++) put(rowOf(d), x, x <= 1 ? '█' : '·', x <= 1 ? 'curtain' : 'stagefloor');
  }
  // Aisle with rails
  for (let x = arena.aisle.x0; x < arena.ringEntry.x; x++) {
    put(rowOf(arena.aisle.depth), x, '·', 'aisle');
    put(rowOf(arena.aisle.depth - 1.5), x, '─', 'rail');
    put(rowOf(arena.aisle.depth + 1.5), x, '─', 'rail');
  }
  // Podium
  for (let x = arena.podium.x0; x <= arena.podium.x1; x++) put(rowOf(0), x, '▄', 'podium');
  // Ring
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
  // Labels
  const label = (x: number, text: string) => [...text].forEach((ch, i) => put(ROWS - 1, x + i, ch, 'label'));
  label(0, 'ENTRANCE');
  label(arena.podium.x0 - 1, 'INTERVIEW');
  return g;
}

const CROWD_CHARS: Record<CrowdLevel | 'idle', string> = {
  idle: '▒░▒░', cheer: '^▒^o', pop: '^!^▒', boo: 'v▒v~', gasp: 'oO▒o', chant: '♪▒♫▒', buzz: '~▒~░',
};

export class MapView {
  private bg = background();
  private brand = '';
  private crowd: CrowdLevel | 'idle' = 'idle';
  private crowdUntil = 0;
  private focus = new Set<string>();
  private bubbles = new Map<string, { text: string; until: number }>();
  private seed = 0;

  constructor(private el: HTMLElement, private legend: HTMLElement, private stage: Stage) {}

  onEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'crowd':
        this.crowd = e.level;
        this.crowdUntil = e.t + 2.5;
        break;
      case 'camera':
        this.focus = new Set(e.focus);
        break;
      case 'said':
        this.bubbles.set(e.who, { text: e.text, until: e.t + Math.min(7, 1.3 + e.text.split(/\s+/).length * 0.32) });
        break;
      case 'despawn':
        this.bubbles.delete(e.id);
        break;
      case 'segmentStart':
        this.focus.clear();
        break;
    }
  }

  private glyph(a: Actor): string {
    if (a.kind === 'ref') return 'r';
    if (a.kind === 'interviewer') return 'i';
    return '@';
  }

  render(): void {
    const t = this.stage.time;
    if (this.brand !== this.stage.shortName) {
      // The promotion's brand goes on the ring apron.
      this.brand = this.stage.shortName;
      this.bg = background();
      const row = this.bg[ROWS - 1];
      const start = Math.round((arena.ring.x0 + arena.ring.x1) / 2) - Math.floor(this.brand.length / 2);
      [...this.brand].forEach((ch, i) => (row[start + i] = { ch, cls: 'label' }));
    }
    const g = this.bg.map((row) => row.map((c) => ({ ...c })));
    if (t > this.crowdUntil) this.crowd = 'idle';
    this.seed = Math.floor(t * 4);

    // Crowd rows (behind the ring and in front)
    const chars = CROWD_CHARS[this.crowd];
    for (const r of [0, 1, ROWS - 2]) {
      for (let x = 0; x < W; x++) {
        // Hash each seat so the crowd shimmers instead of scrolling in a visible pattern.
        const tick = this.crowd === 'idle' ? Math.floor(this.seed / 3) : this.seed;
        const h = (Math.imul(x + 1, 73856093) ^ Math.imul(r + 1, 19349663) ^ Math.imul(tick + 1, 83492791)) >>> 0;
        const busy = this.crowd === 'idle' ? h % 9 === 0 : h % 3 === 0;
        g[r][x] = { ch: busy ? chars[h % chars.length] : '░', cls: `crowd crowd-${busy ? this.crowd : 'idle'}` };
      }
    }

    // Actors, back rows first so front-row actors win shared cells.
    const actors = this.stage.visibleActors().sort((a, b) => a.depth - b.depth);
    for (const a of actors) {
      const r = rowOf(a.depth);
      const c = colOf(a.x);
      const cls = ['actor', a.down ? 'down' : '', a.speaking ? 'speaking' : '', this.focus.has(a.id) ? 'focus' : '']
        .filter(Boolean).join(' ');
      g[r][c] = { ch: a.down ? '_' : this.glyph(a), cls, color: a.color };
      // Airborne: show a shadow under a raised actor.
      if (a.pose.dy >= 1.5 && r > 0) {
        g[r - 1][c] = { ch: this.glyph(a), cls: 'actor air', color: a.color };
        g[r][c] = { ch: '.', cls: 'shadow' };
      }
    }

    // Speech bubbles on the row above the speaker.
    for (const [id, b] of this.bubbles) {
      const a = this.stage.actors.get(id);
      if (!a || !a.visible || t > b.until) {
        this.bubbles.delete(id);
        continue;
      }
      const text = `"${b.text.length > 34 ? b.text.slice(0, 33) + '…' : b.text}"`;
      const r = Math.max(0, rowOf(a.depth) - 1);
      let start = colOf(a.x) - Math.floor(text.length / 2);
      start = Math.max(0, Math.min(W - text.length, start));
      [...text].forEach((ch, i) => {
        g[r][start + i] = { ch, cls: 'bubble', color: a.color };
      });
    }

    this.el.innerHTML = g
      .map((row) => {
        let html = '';
        let run = '';
        let key = '';
        const flush = () => {
          if (!run) return;
          const [cls, color] = key.split('|');
          html += cls || color
            ? `<span class="${cls}"${color ? ` style="color:${color}"` : ''}>${esc(run)}</span>`
            : esc(run);
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
      })
      .join('\n');

    this.renderLegend(actors);
  }

  private renderLegend(actors: Actor[]): void {
    const champs = new Map(this.stage.titles.filter((t) => t.holder).map((t) => [t.holder!, t]));
    const items = actors
      .filter((a) => a.kind !== 'ref')
      .map((a) => {
        const tag = a.kind === 'wrestler' ? a.alignment : a.kind;
        const belt = champs.has(a.id) ? ` <span class="belt" title="${esc(champs.get(a.id)!.name)}">★</span>` : '';
        return `<li class="${a.speaking ? 'speaking' : ''}"><span class="glyph" style="color:${a.color}">${this.glyph(a)}</span> ${esc(a.name)}${belt} <span class="tag tag-${tag}">${tag}</span></li>`;
      });
    this.legend.innerHTML = items.join('');
  }
}
