// The start screen: continue the current show, create a new live promotion (with an
// optional direction), or watch a stored show from the beginning. Choices reload the page
// with ?play=... so every run starts from a clean stage.
import type { Health, LibraryEntry } from '../booker/client';
import { episodeLabel } from '../world/season';
import type { World } from '../world/state';

const PRESETS: { label: string; text: string }[] = [
  { label: '80s NWA', text: '1980s NWA studio TV: sweaty southern arenas, loud managers with tennis rackets, the Four Horsemen-style heel stable against beloved blue-collar heroes. Mostly brawls and technical wrestling.' },
  { label: 'ECW hardcore', text: 'ECW-style hardcore promotion in a Philadelphia bingo hall: rabid chanting fans, tables, chairs and barbed wire, anti-heroes and extreme stunts, a cult-like heel faction.' },
  { label: 'Lucha libre', text: 'Mexican lucha libre promotion in Arena Mexico: masked técnicos and rudos, high-flying, mask-versus-mask and hair-versus-hair feuds, family dynasties.' },
  { label: 'Joshi', text: 'Japanese women\'s wrestling (joshi) promotion: idol babyfaces, fearsome heel gangs, hard-hitting strikes, and loyal fan clubs.' },
  { label: 'Monday Nitro', text: 'Late-90s Monday night war: a rebellious outlaw faction invading the promotion, celebrity guests, cruiserweights stealing the show, the old guard fighting back.' },
  { label: 'Territory days', text: 'A 1970s southern territory run by a feuding family: the owner\'s sons wrestle, a hated foreign menace, a traveling world champion comes to town for the big shows.' },
];

/** "Southern Territory Wrestling" -> "STW" (a suggestion; the user can change it). */
function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^(of|the|and|de|la|el)$/i.test(w));
  return words.map((w) => w[0]).join('').slice(0, 6).toUpperCase();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One line describing what the booker can do right now. */
export function connectionText(h: Health | null | undefined): { text: string; cls: string } {
  if (h === undefined) return { text: 'checking connection…', cls: 'conn-wait' };
  if (h === null) return { text: '● not connected: stored shows play; new episodes need the AI booker', cls: 'conn-off' };
  if (!h.llm) return { text: '● booker server has no API key: stored shows only', cls: 'conn-warn' };
  return { text: `● live: ${h.model} (season plans: ${h.planModel})`, cls: 'conn-on' };
}

/** A link that opens straight into a stored show, e.g. https://…/infinite-wrestling/?show=wzw */
function shareLink(e: LibraryEntry): string {
  const name = (e.shortName || e.showName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${location.origin}${location.pathname}?show=${encodeURIComponent(name || e.id)}`;
}

/** Reload into a program, keeping dev flags like ?offline. */
export function go(play: Record<string, string>): void {
  const keep = new URLSearchParams(location.search);
  const next = new URLSearchParams();
  if (keep.has('offline')) next.set('offline', '1');
  for (const [k, v] of Object.entries(play)) next.set(k, v);
  location.search = `?${next}`;
}

export class StartScreen {
  constructor(private el: HTMLElement) {
    const presets = el.querySelector('#presets')!;
    presets.innerHTML = PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${esc(p.label)}</button>`).join('');
    presets.addEventListener('click', (e) => {
      const i = (e.target as HTMLElement).dataset.preset;
      if (i !== undefined) (el.querySelector('#direction') as HTMLTextAreaElement).value = PRESETS[Number(i)].text;
    });
    el.querySelector('#create')!.addEventListener('click', () => {
      const value = (sel: string) => (el.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement).value.trim();
      const play: Record<string, string> = { play: 'new' };
      if (value('#direction')) play.direction = value('#direction');
      if (value('#promo-name')) play.name = value('#promo-name');
      if (value('#promo-initials')) play.initials = value('#promo-initials').toUpperCase();
      go(play);
    });
    // Suggest initials from the name until the user types their own.
    const initials = el.querySelector('#promo-initials') as HTMLInputElement;
    initials.addEventListener('input', () => (initials.dataset.touched = initials.value ? '1' : ''));
    el.querySelector('#promo-name')!.addEventListener('input', (e) => {
      if (initials.dataset.touched) return;
      initials.value = initialsOf((e.target as HTMLInputElement).value);
    });
    el.querySelector('#library-list')!.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).dataset.show;
      if (id) go({ play: 'library', id });
    });
    el.querySelector('#start-continue')!.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.continue !== undefined) {
        this.close();
        this.onContinue?.();
      }
    });
  }

  /** Called when "Continue" is picked (e.g. to start the show if it isn't running yet). */
  onContinue: (() => void) | null = null;

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(opts: { current: World | null; library: LibraryEntry[]; health: Health | null | undefined; canClose: boolean }): void {
    const conn = connectionText(opts.health);
    const connEl = this.el.querySelector('#start-conn')!;
    connEl.textContent = conn.text;
    connEl.className = `conn-line ${conn.cls}`;

    // New promotions are written by the AI booker; without it, only stored shows play.
    const canCreate = !!opts.health?.llm;
    (this.el.querySelector('#create-area') as HTMLFieldSetElement).disabled = !canCreate;
    this.el.querySelector('.start-panel')!.classList.toggle('no-llm', !canCreate);
    const note = this.el.querySelector('#create-note') as HTMLElement;
    note.hidden = canCreate;
    note.innerHTML = opts.health === null
      ? '<b>Not connected to an AI booker.</b> New promotions are written live by an LLM, and no booker server is reachable from here (the online demo has none). You can watch the stored shows; to create your own, run the project locally with <code>npm run server</code> and an Anthropic API key.'
      : '<b>The booker server has no API key.</b> New promotions are written live by an LLM. Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code> and restart <code>npm run server</code>. Stored shows play without it.';

    const cont = this.el.querySelector('#start-continue')!;
    cont.innerHTML = opts.current && opts.canClose
      ? `<h2>Your show</h2><button class="primary" data-continue>Continue ${esc(opts.current.showName)}</button>
         <span class="hint"> next: ${esc(episodeLabel(opts.current, opts.current.episode + 1))}</span>`
      : '';

    const list = this.el.querySelector('#library-list')!;
    list.innerHTML = opts.library.length
      ? opts.library.map((e) => {
        const seasons = Math.ceil(e.episodes / 12);
        const stored = e.episodes ? `${e.episodes} episode${e.episodes === 1 ? '' : 's'} stored · season${seasons === 1 ? '' : 's'} 1${seasons > 1 ? `–${seasons}` : ''}` : 'roster only, no episodes yet';
        return `<li>
          <div><b>${esc(e.showName)}</b> <span class="badge">${e.source === 'library' ? 'library' : 'saved'}</span></div>
          <div class="hint">${esc(e.direction || 'no direction')}</div>
          <div class="row"><span class="hint">${stored} · <a class="share" href="${shareLink(e)}" title="Link that starts this show right away">share link</a></span><button data-show="${esc(e.id)}">Watch from the start</button></div>
        </li>`;
      }).join('')
      : '<li class="hint">Nothing stored yet. Shows you create are saved automatically when the booker server is running.</li>';
    this.el.hidden = false;
    if (canCreate) (this.el.querySelector('#promo-name') as HTMLInputElement).focus();
  }

  close(): void {
    this.el.hidden = true;
  }
}
