import type { EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';
import { clock } from './transcript';

const MAX_LINES = 120;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Scrolling play-by-play. Dialogue types out; big moments flash. */
export class FeedView {
  private typing: { el: HTMLElement; text: string; start: number; cps: number } | null = null;

  constructor(private el: HTMLElement, private stage: Stage) {}

  onEvent(e: EngineEvent): void {
    const name = (id: string) => this.stage.actors.get(id);
    switch (e.type) {
      case 'episodeStart':
        return void this.add(`<span class="ep">★ EPISODE ${e.number}: ${esc(e.title)} ★</span>`, 'header', e.t);
      case 'segmentStart':
        return void this.add(`<span class="seg">— ${esc(e.title)} —</span>`, 'header', e.t);
      case 'narrated':
        return void this.add(esc(e.text), `n-${e.style}`, e.t);
      case 'said': {
        const a = name(e.who);
        const who = `<b style="color:${a?.color ?? '#fff'}">${esc(a?.name ?? e.who)}:</b> `;
        const li = this.add(`${who}<span class="q"></span>`, `said mood-${e.mood}`, e.t);
        this.finishTyping();
        this.typing = { el: li.querySelector('.q')!, text: `"${e.text}"`, start: e.t, cps: 38 };
        return;
      }
      case 'matchEnd': {
        const w = e.winner ? name(e.winner)?.name : null;
        return void this.add(w ? `RESULT: ${esc(w)} wins by ${e.finish.replace('_', ' ')}` : 'RESULT: no contest', 'result', e.t);
      }
      case 'titleChange':
        return void this.add(`🏆 ${esc(name(e.newChampion)?.name ?? e.newChampion)} is the new champion!`, 'title', e.t);
      case 'alignmentChanged':
        return void this.add(`⚡ ${esc(name(e.id)?.name ?? e.id)} is now a ${e.alignment.toUpperCase()}!`, 'turn', e.t);
      case 'crowd':
        if (e.chant) this.add(`♪ ${esc(e.chant)} ♪`, 'n-crowd', e.t);
        return;
    }
  }

  private add(html: string, cls: string, t: number): HTMLElement {
    const li = document.createElement('li');
    li.className = cls;
    li.innerHTML = `<span class="ts">${clock(t)}</span> ${html}`;
    this.el.appendChild(li);
    while (this.el.children.length > MAX_LINES) this.el.firstElementChild!.remove();
    this.el.scrollTop = this.el.scrollHeight;
    return li;
  }

  private finishTyping(): void {
    if (this.typing) this.typing.el.textContent = this.typing.text;
    this.typing = null;
  }

  /** Advance the typewriter; called every frame with the show clock. */
  tick(): void {
    if (!this.typing) return;
    const n = Math.floor((this.stage.time - this.typing.start) * this.typing.cps);
    this.typing.el.textContent = this.typing.text.slice(0, Math.max(0, n));
    if (n >= this.typing.text.length) this.typing = null;
  }

  clear(): void {
    this.typing = null;
    this.el.innerHTML = '';
  }
}
