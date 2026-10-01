// Tonight's card, beside the arena: every segment of the episode in order. The live
// segment is boxed and shows who is out there (wrestlers, managers, valets); finished
// segments collapse to their result and a bit of context (who interfered, how it ended).
import type { EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';
import type { BeatOf, Episode, Finish, Segment, Spot, Stipulation } from '../schema/episode';
import { beltName } from '../choreo/lines';

interface MatchEntry {
  wrestlers: string[];
  stipulation: Stipulation;
  /** Battle royal: who is out, in order. */
  eliminated: string[];
  title: string | null;
  spots: Spot[];
  state: 'upcoming' | 'live' | 'done';
  result: { winner: string | null; loser: string | null; finish: Finish } | null;
  newChampion: boolean;
}

interface SegmentEntry {
  title: string;
  recap: string;
  kind: string;
  state: 'upcoming' | 'live' | 'done';
  matches: MatchEntry[];
}

const FINISH_LABEL: Record<Finish, string> = {
  pin: 'pinfall', rollup: 'roll-up', cheat_pin: 'cheating pinfall', submission: 'submission', dq: 'DQ', countout: 'count-out', no_contest: 'no contest',
  escape: 'escaped the cage', retrieve: 'grabbed the prize', elimination: 'last one standing',
};

const STIP_LABEL: Record<Stipulation, string> = {
  singles: 'MATCH', tag: 'TAG TEAM MATCH', cage: 'STEEL CAGE MATCH', ladder: 'LADDER MATCH', battle_royal: 'BATTLE ROYAL',
};

const SPOT_LABEL: Record<Spot['type'], string> = {
  interrupt: 'interrupted', run_in: 'ran in', distraction: 'distracted the ref', ref_bump: 'ref bump', weapon: 'used a weapon',
};

/** A short label for what kind of segment this is, from its beats. */
function kindOf(seg: Segment): string {
  const types = new Set(seg.beats.map((b) => b.type));
  const m = seg.beats.find((b): b is BeatOf<'match'> => b.type === 'match');
  if (m) return STIP_LABEL[m.stipulation];
  if (types.has('turn')) return 'ANGLE';
  if (types.has('reveal')) return 'REVEAL';
  if (types.has('interview')) return 'INTERVIEW';
  if (types.has('attack') || types.has('confrontation')) return 'ANGLE';
  if (types.has('promo')) return 'PROMO';
  return 'SEGMENT';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class CardView {
  private segments: SegmentEntry[] = [];
  private header = '';
  private ppv: string | null = null;
  /** Which episode arrows are available (rendered as ◀ ▶ around the title). */
  private nav = { prev: false, next: false };

  constructor(private el: HTMLElement, private stage: Stage) {}

  setEpisode(label: string, ep: Episode, ppv: string | null = null, nav = { prev: false, next: false }): void {
    this.header = ep.title === ppv ? label : `${label}: ${ep.title}`;
    this.ppv = ppv;
    this.nav = nav;
    this.segments = ep.segments.map((seg) => ({
      title: seg.title,
      recap: seg.recap,
      kind: kindOf(seg),
      state: 'upcoming',
      matches: seg.beats
        .filter((b): b is BeatOf<'match'> => b.type === 'match')
        .map((m) => ({
          wrestlers: m.wrestlers,
          stipulation: m.stipulation,
          eliminated: [],
          title: m.titleOnLine !== 'none' ? m.titleOnLine : null,
          spots: m.spots,
          state: 'upcoming' as const,
          result: null,
          newChampion: false,
        })),
    }));
    this.render();
  }

  private get live(): SegmentEntry | undefined {
    return this.segments.find((s) => s.state === 'live');
  }

  onEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'segmentStart':
        if (this.segments[e.index]) this.segments[e.index].state = 'live';
        break;
      case 'segmentEnd':
        if (this.segments[e.index]) this.segments[e.index].state = 'done';
        break;
      case 'matchStart': {
        const m = this.live?.matches.find((x) => x.state === 'upcoming' && e.wrestlers.every((w) => x.wrestlers.includes(w)));
        if (m) m.state = 'live';
        break;
      }
      case 'matchEnd': {
        const m = this.live?.matches.find((x) => x.state === 'live');
        if (m) {
          m.state = 'done';
          m.result = { winner: e.winner, loser: e.loser, finish: e.finish };
        }
        break;
      }
      case 'elimination': {
        this.live?.matches.find((x) => x.state === 'live')?.eliminated.push(e.who);
        break;
      }
      case 'titleChange': {
        const m = this.segments.flatMap((s) => s.matches).find((x) => x.title === e.title && x.state === 'done');
        if (m) m.newChampion = true;
        break;
      }
      case 'spawn':
      case 'despawn':
      case 'alignmentChanged':
      case 'episodeStart':
        break;
      default:
        return;
    }
    this.render();
  }

  private name(id: string, cls = ''): string {
    const a = this.stage.actors.get(id);
    const n = a ? a.name.replace(/"[^"]*"\s*/g, '').trim() : id;
    return `<span class="${cls}" style="color:${a?.color ?? '#ccc'}">${esc(n)}</span>`;
  }

  /** The face/heel/tweener tag (or manager/valet) used across the card. */
  private tag(id: string): string {
    const a = this.stage.actors.get(id);
    if (!a) return '';
    const tag = a.kind === 'wrestler' ? a.alignment : a.kind;
    return ` <span class="tag tag-${tag}">${tag}</span>`;
  }

  private team(ids: string[], cls = ''): string {
    return ids.map((id) => this.name(id, cls)).join(' <span class="def">&amp;</span> ');
  }

  /** Tag team and battle royal lines; singles-style matches go through matchLine. */
  private groupLine(m: MatchEntry, beltTag: string): string {
    if (m.stipulation === 'tag') {
      const [t1, t2] = [m.wrestlers.slice(0, 2), m.wrestlers.slice(2, 4)];
      if (m.state === 'done' && m.result?.winner) {
        const [w, l] = t1.includes(m.result.winner) ? [t1, t2] : [t2, t1];
        return `<div class="match">${this.team(w, 'win')} <span class="def">def.</span> ${this.team(l, 'lose')}</div>` +
          `<div class="how">${FINISH_LABEL[m.result.finish]}${m.result.loser ? ` · ${this.name(m.result.winner)} over ${this.name(m.result.loser)}` : ''}</div>`;
      }
      return `<div class="match">${this.team(t1)} <span class="def">vs.</span> ${this.team(t2)}</div>`;
    }
    // Battle royal: the field, with eliminated wrestlers struck through as they go.
    if (m.state === 'done' && m.result?.winner) {
      return `<div class="match">${this.name(m.result.winner, 'win')} wins the battle royal${beltTag}</div>` +
        `<div class="how">${m.wrestlers.length} entrants${m.result.loser ? ` · last eliminated ${this.name(m.result.loser)}` : ''}</div>`;
    }
    const field = m.wrestlers.map((id) => this.name(id, m.eliminated.includes(id) ? 'lose' : '')).join(', ');
    const left = m.wrestlers.length - m.eliminated.length;
    return `<div class="match">${m.state === 'live' ? `${left} of ${m.wrestlers.length} left` : `${m.wrestlers.length} entrants`}${beltTag}</div><div class="field">${field}</div>`;
  }

  private matchLine(m: MatchEntry): string {
    const belt = m.title ? this.stage.titles.find((t) => t.id === m.title) : null;
    const beltTag = belt ? ` <span class="belt">★ ${esc(beltName(belt.name))}</span>` : '';
    if (m.stipulation === 'tag' || m.stipulation === 'battle_royal') return this.groupLine(m, beltTag);
    if (m.state === 'live') {
      const [a, b] = m.wrestlers;
      return `<div class="match">${this.name(a)}${this.tag(a)} <span class="def">vs.</span> ${this.name(b)}${this.tag(b)}${beltTag}</div>`;
    }
    if (m.state !== 'done' || !m.result) {
      return `<div class="match">${this.name(m.wrestlers[0])} <span class="def">vs.</span> ${this.name(m.wrestlers[1])}${beltTag}</div>`;
    }
    const r = m.result;
    const line = r.winner
      ? `${this.name(r.winner, 'win')} <span class="def">def.</span> ${this.name(r.loser!, 'lose')}`
      : `${this.name(m.wrestlers[0], 'lose')} <span class="def">vs.</span> ${this.name(m.wrestlers[1], 'lose')}`;
    const context = [
      FINISH_LABEL[r.finish],
      ...m.spots.filter((s) => s.type !== 'ref_bump').map((s) => `${this.name(s.who)} ${SPOT_LABEL[s.type]}`),
      ...(m.spots.some((s) => s.type === 'ref_bump') ? ['ref bump'] : []),
      ...(m.newChampion ? ['<span class="belt">NEW CHAMPION</span>'] : []),
    ];
    return `<div class="match">${line}${beltTag}</div><div class="how">${context.join(' · ')}</div>`;
  }

  /**
   * Who else is out there right now: everyone on screen except the announce crew and
   * the wrestlers already named in the live match line (so managers, valets, run-ins).
   */
  private people(seg: SegmentEntry): string {
    const champs = new Map(this.stage.titles.filter((t) => t.holder).map((t) => [t.holder!, t]));
    const named = new Set(seg.matches.filter((m) => m.state === 'live').flatMap((m) => m.wrestlers));
    const items = this.stage.visibleActors()
      .filter((a) => !a.crew && !named.has(a.id))
      .map((a) => {
        const belt = champs.has(a.id) ? ` <span class="belt" title="${esc(champs.get(a.id)!.name)}">★</span>` : '';
        return `<li><span class="glyph" style="color:${a.color}">@</span> <span style="color:${a.color}">${esc(a.name)}</span>${belt}${this.tag(a.id)}</li>`;
      });
    return items.length ? `<ul class="people">${items.join('')}</ul>` : '';
  }

  private render(): void {
    const rows = this.segments.map((s, i) => {
      const main = i === this.segments.length - 1 && s.matches.length ? ' <span class="main">MAIN EVENT</span>' : '';
      const head = `<div class="seg-head"><span class="kind">${s.kind}</span>${main}</div><div class="seg-title">${esc(s.title)}</div>`;
      const matches = s.matches.map((m) => this.matchLine(m)).join('');
      // data-seg makes every segment clickable: watch it from its start.
      const seg = `data-seg="${i}" title="Watch this segment"`;
      if (s.state === 'live') {
        return `<li class="live" ${seg}><div class="seg-head"><span class="live">● LIVE</span> <span class="kind">${s.kind}</span>${main}</div><div class="seg-title">${esc(s.title)}</div>${matches}${this.people(s)}</li>`;
      }
      if (s.state === 'done') {
        // Matches speak for themselves; other segments get their one-line recap.
        const summary = s.matches.length ? matches : `<div class="recap">${esc(s.recap)}</div>`;
        return `<li class="done" ${seg}>${head}${summary}</li>`;
      }
      return `<li class="upcoming" ${seg}>${head}${matches}</li>`;
    });
    const banner = this.ppv ? `<div class="ppv">PAY-PER-VIEW · ${esc(this.ppv)}</div>` : '';
    const arrow = (dir: 'prev' | 'next', ok: boolean) =>
      `<button class="ep-nav" data-nav="${dir}" ${ok ? '' : 'disabled'} title="${dir === 'prev' ? 'Previous' : 'Next'} episode">${dir === 'prev' ? '◀' : '▶'}</button>`;
    this.el.innerHTML = `${banner}<div class="ep-head">${arrow('prev', this.nav.prev)}<h3>${esc(this.header)}</h3>${arrow('next', this.nav.next)}</div><ol>${rows.join('')}</ol>`;
  }
}
