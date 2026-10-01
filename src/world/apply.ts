import { farthestColor } from '../engine/colors';
import { profileOf } from './genesis';
import { applySeasonStart } from './season';
import type { Episode, Finish } from '../schema/episode';
import {
  ANGLE_LOG_LIMIT, type Character, cloneWorld, CREW_COLORS, HISTORY_LIMIT, NOTES_LIMIT, type World,
} from './state';

export type TitleOutcome = 'retain' | 'new_champion' | 'protected' | 'none';

/** NWA rules: titles only change hands on a pinfall or submission. */
export function titleOutcome(holder: string | null, winner: string | null, finish: Finish): TitleOutcome {
  if (!winner) return 'none';
  if (holder === winner) return 'retain';
  const clean = ['pin', 'rollup', 'cheat_pin', 'submission', 'escape', 'retrieve', 'elimination'].includes(finish);
  return clean ? 'new_champion' : 'protected';
}

const samePair = (a1: string, b1: string, a2: string, b2: string) =>
  (a1 === a2 && b1 === b2) || (a1 === b2 && b1 === a2);

/** Kinds of angles an episode used, so the booker can avoid repeating itself. */
export function angleKinds(ep: Episode): string[] {
  const kinds: string[] = [];
  for (const seg of ep.segments) {
    for (const b of seg.beats) {
      if (b.type === 'match') {
        if (b.finish !== 'pin') kinds.push(`finish:${b.finish}`);
        for (const s of b.spots) kinds.push(`spot:${s.type}`);
      } else if (b.type === 'turn') {
        kinds.push(`turn:${b.how}`);
      } else if (b.type !== 'entrance' && b.type !== 'exit' && b.type !== 'narrate' && b.type !== 'celebrate') {
        kinds.push(b.type);
      }
    }
  }
  if (ep.debuts.length) kinds.push('debut');
  return kinds;
}

/** Return the world as it will be after this episode airs. Pure: the input is not modified. */
export function applyEpisode(world: World, ep: Episode): World {
  const w = cloneWorld(ep.seasonStart ? applySeasonStart(world, ep.seasonStart) : world);
  const n = w.episode + 1;
  w.episode = n;

  for (const d of ep.debuts) {
    if (w.characters.some((c) => c.id === d.id)) continue;
    const used = new Set(w.characters.map((c) => c.color));
    const color = farthestColor([...used, ...Object.values(CREW_COLORS)]);
    const c: Character = {
      id: d.id, name: d.name, role: d.role, alignment: d.alignment, division: d.division, style: d.style,
      gimmick: d.gimmick, entrance: d.entrance, color,
      finisher: {
        name: d.finisherName, move: d.finisherMove,
        ...(d.finisherDescription.trim() ? { description: d.finisherDescription.trim() } : {}),
        ...(d.finisherCall.trim() ? { call: d.finisherCall.trim() } : {}),
      },
      ...profileOf(d),
    };
    w.characters.push(c);
  }

  for (const seg of ep.segments) {
    for (const b of seg.beats) {
      if (b.type === 'turn') {
        const c = w.characters.find((ch) => ch.id === b.who);
        if (c) c.alignment = b.newAlignment;
      }
      if (b.type === 'match' && b.titleOnLine !== 'none') {
        const t = w.titles.find((tt) => tt.id === b.titleOnLine);
        const winner = b.winner === 'none' ? null : b.winner;
        if (t && titleOutcome(t.holder, winner, b.finish) === 'new_champion') t.holder = winner;
      }
    }
    for (const s of seg.stateChanges) {
      switch (s.type) {
        case 'feud_start':
          if (!w.feuds.some((f) => samePair(f.a, f.b, s.a, s.b))) w.feuds.push({ a: s.a, b: s.b, reason: s.reason, since: n });
          break;
        case 'feud_end':
          w.feuds = w.feuds.filter((f) => !samePair(f.a, f.b, s.a, s.b));
          break;
        case 'alliance_form':
          w.alliances = w.alliances.filter((a) => a.name !== s.name);
          w.alliances.push({ name: s.name, members: [...s.members], since: n });
          break;
        case 'alliance_break':
          w.alliances = w.alliances.filter((a) => a.name !== s.name);
          break;
        case 'storyline_note':
          w.notes.push({ episode: n, text: s.text });
          break;
      }
    }
    w.history.push({ episode: n, segment: seg.title, recap: seg.recap });
  }

  // A heel/face turn implicitly ends alliances with the other side when the partner was attacked.
  for (const seg of ep.segments) {
    for (const b of seg.beats) {
      if (b.type === 'turn' && b.how === 'attacks_partner' && b.target !== 'none') {
        w.alliances = w.alliances.filter((a) => !(a.members.includes(b.who) && a.members.includes(b.target)));
      }
    }
  }

  w.history = w.history.slice(-HISTORY_LIMIT);
  w.notes = w.notes.slice(-NOTES_LIMIT);
  w.angleLog = [...w.angleLog, { episode: n, kinds: angleKinds(ep) }].slice(-ANGLE_LOG_LIMIT);
  if (ep.storySoFar.trim()) w.storySoFar = ep.storySoFar.trim();
  return w;
}
