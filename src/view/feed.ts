import type { EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';
import { NameIndex } from './names';
import { clock } from './transcript';

const MAX_LINES = 120;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Scrolling log of everything said, for looking back. Names are painted in their colors. */
export class FeedView {
  private names: NameIndex;

  constructor(private el: HTMLElement, private stage: Stage) {
    this.names = new NameIndex(stage);
  }

  onEvent(e: EngineEvent): void {
    const name = (id: string) => this.stage.actors.get(id);
    switch (e.type) {
      case 'episodeStart':
        return void this.add(`<span class="ep">★ ${esc(e.label.toUpperCase())}: ${esc(e.title)} ★</span>`, 'header', e.t);
      case 'segmentStart':
        return void this.add(`<span class="seg">— ${esc(e.title)} —</span>`, 'header', e.t);
      case 'narrated':
        return void this.add(this.names.html(e.text, esc), `n-${e.style}`, e.t);
      case 'said': {
        const a = name(e.who);
        const who = `<b style="color:${a?.color ?? '#fff'}">${esc(a?.name ?? e.who)}:</b> `;
        const tint = e.tint ? ` style="color:${e.tint}"` : '';
        return void this.add(`${who}<span class="q"${tint}>"${e.tint ? esc(e.text) : this.names.html(e.text, esc)}"</span>`, `said mood-${e.mood}`, e.t);
      }
      case 'matchEnd': {
        const w = e.winner ? name(e.winner)?.name : null;
        return void this.add(w ? `RESULT: ${this.names.html(w, esc)} wins by ${e.finish.replace('_', ' ')}` : 'RESULT: no contest', 'result', e.t);
      }
      case 'titleChange':
        return void this.add(`🏆 ${this.names.html(name(e.newChampion)?.name ?? e.newChampion, esc)} is the new champion!`, 'title', e.t);
      case 'alignmentChanged':
        return void this.add(`⚡ ${this.names.html(name(e.id)?.name ?? e.id, esc)} is now a ${e.alignment.toUpperCase()}!`, 'turn', e.t);
      case 'crowd':
        if (e.chant) this.add(`♪ ${this.names.html(e.chant, esc)} ♪`, 'n-crowd', e.t);
        return;
    }
  }

  private add(html: string, cls: string, t: number): HTMLElement {
    const li = document.createElement('li');
    li.className = cls;
    // The show time lets a click on the line rewind/jump the show to that moment.
    li.dataset.t = String(t);
    li.title = 'Jump to this moment';
    li.innerHTML = `<span class="ts">${clock(t)}</span> ${html}`;
    this.el.appendChild(li);
    while (this.el.children.length > MAX_LINES) this.el.firstElementChild!.remove();
    this.el.scrollTop = this.el.scrollHeight;
    return li;
  }

  clear(): void {
    this.el.innerHTML = '';
  }
}
