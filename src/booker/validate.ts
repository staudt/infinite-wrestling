// Semantic checks on top of the Zod schema. `reviewEpisode` reports problems (fed back
// to the LLM for a retry) and returns a sanitized episode that is always safe to play.
import { Beat, Episode, type Segment } from '../schema/episode';
import { hasMove } from '../sim/moves';
import { applySeasonStart } from '../world/season';
import { matchCharacter, unstringify } from './json';
import type { World } from '../world/state';

export interface Review {
  episode: Episode;
  problems: string[];
}

const MAX_LINES = 6;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 10;

function cleanLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES);
}

type Loose = Record<string, unknown>;
const isObj = (x: unknown): x is Loose => typeof x === 'object' && x !== null && !Array.isArray(x);
export { unstringify };


/**
 * Accept the flat LLM draft (beats with `segment` markers) and turn it into the nested
 * Episode. Nested input passes through. Also tolerates a model putting the flat beat
 * list under `segments`.
 */
export function draftToEpisode(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  let beats = raw.beats;
  if (!Array.isArray(beats) && Array.isArray(raw.segments) && raw.segments.some((s) => isObj(s) && typeof s.type === 'string')) {
    beats = raw.segments;
  }
  if (!Array.isArray(beats)) return raw;
  const segments: Loose[] = [];
  for (const b of beats) {
    if (isObj(b) && b.type === 'segment') {
      segments.push({ title: b.title, recap: b.recap, beats: [], stateChanges: [] });
      continue;
    }
    if (!segments.length) segments.push({ title: 'Opening', recap: '', beats: [], stateChanges: [] });
    (segments.at(-1)!.beats as unknown[]).push(b);
  }
  // Episode-level state changes are recorded with the final segment.
  if (segments.length && Array.isArray(raw.stateChanges)) segments.at(-1)!.stateChanges = raw.stateChanges;
  for (const s of segments) if (typeof s.recap !== 'string' || !s.recap) s.recap = String(s.title ?? '');
  return { title: raw.title, storySoFar: raw.storySoFar, debuts: raw.debuts ?? [], segments };
}

/**
 * The show adds "Episode #N" and the show name itself, so strip them from the booked
 * title: "Dixie Mat Wrestling - Episode #1: The Hammer Holds Fast" -> "The Hammer Holds Fast".
 */
export function cleanTitle(title: string, showName: string): string {
  let t = title.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  const ep = t.match(/(?:^|[\s\-–—:|])(?:episode|ep\.?)\s*#?\d+\s*[:\-–—|]\s*(.+)$/i);
  if (ep) t = ep[1];
  if (showName && t.toLowerCase().startsWith(showName.toLowerCase())) t = t.slice(showName.length).replace(/^\s*[:\-–—|]\s*/, '');
  return t.trim() || title.trim();
}

const ID_KEYS = new Set(['who', 'guest', 'a', 'b', 'victim', 'winner', 'target', 'speaker']);
const ID_LIST_KEYS = new Set(['attackers', 'wrestlers', 'escorts', 'members']);
const slugify = (s: string) => s.toLowerCase().replace(/"[^"]*"/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Models sometimes refer to people by name ("Chet Millwood", "chet_millwood") instead of
 * their id. Map any id field that isn't a known id but matches someone's name.
 */
export function resolveIds(v: unknown, world: World): unknown {
  const ids = new Set(world.characters.map((c) => c.id));
  const alias = new Map<string, string>();
  for (const c of world.characters) {
    alias.set(slugify(c.name), c.id);
    alias.set(slugify(c.name.replace(/"[^"]*"\s*/g, '')), c.id);
    alias.set(slugify(c.name.replace(/"/g, '')), c.id); // nickname kept, quotes dropped
  }
  const fix = (x: unknown) =>
    typeof x === 'string' && !ids.has(x) ? alias.get(slugify(x)) ?? matchCharacter(x, world.characters)?.id ?? x : x;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!isObj(x)) return x;
    return Object.fromEntries(Object.entries(x).map(([k, val]) => {
      if (ID_KEYS.has(k)) return [k, fix(val)];
      if (ID_LIST_KEYS.has(k) && Array.isArray(val)) return [k, val.map(fix)];
      return [k, walk(val)];
    }));
  };
  return walk(v);
}

export function reviewEpisode(raw: unknown, world: World): Review | { episode: null; problems: string[] } {
  const problems: string[] = [];
  const nested = draftToEpisode(resolveIds(unstringify(raw), world));
  // Drop malformed beats one by one rather than rejecting the whole episode.
  if (isObj(nested) && Array.isArray(nested.segments)) {
    nested.segments.forEach((seg, si) => {
      if (!isObj(seg) || !Array.isArray(seg.beats)) return;
      seg.beats = seg.beats.filter((b, bi) => {
        const r = Beat.safeParse(b);
        if (!r.success) {
          const i = r.error.issues[0];
          problems.push(`segment ${si + 1} beat ${bi + 1} (${isObj(b) ? String(b.type) : '?'}) dropped: ${i.path.join('.')} ${i.message}`);
        }
        return r.success;
      });
    });
  }
  const parsed = Episode.safeParse(nested);
  if (!parsed.success) {
    return { episode: null, problems: [...problems, ...parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.')}: ${i.message}`)] };
  }
  const ep = structuredClone(parsed.data);
  // A season opener's roster is the post-shuffle roster (departures out, arrivals in).
  if (ep.seasonStart) world = applySeasonStart(world, ep.seasonStart);
  ep.title = cleanTitle(ep.title, world.showName);

  // Debuts first, so later beats can reference them.
  const known = new Map(world.characters.map((c) => [c.id, c]));
  ep.debuts = ep.debuts.filter((d) => {
    if (!/^[a-z][a-z0-9_]*$/.test(d.id)) problems.push(`debut id "${d.id}" must be lowercase_snake_case`);
    else if (known.has(d.id)) problems.push(`debut id "${d.id}" already exists`);
    else {
      if (!hasMove(d.finisherMove)) {
        problems.push(`debut ${d.id}: finisherMove "${d.finisherMove}" is not a known move id`);
        d.finisherMove = 'piledriver';
      }
      known.set(d.id, {
        id: d.id, name: d.name, role: d.role, alignment: d.alignment, division: d.division, style: d.style,
        gimmick: d.gimmick, entrance: d.entrance, finisher: { name: d.finisherName, move: d.finisherMove }, color: '',
      });
      return true;
    }
    return false;
  });

  const alignment = new Map([...known.values()].map((c) => [c.id, c.alignment]));
  const isChar = (id: string) => known.has(id);
  const isWrestler = (id: string) => known.get(id)?.role === 'wrestler';
  const booked = new Set<string>();
  let turns = 0;

  const checkBeat = (b: Beat, where: string): Beat | null => {
    const bad = (msg: string) => {
      problems.push(`${where} (${b.type}): ${msg}`);
      return null;
    };
    const unknown = (ids: string[]) => ids.filter((id) => !isChar(id));
    switch (b.type) {
      case 'entrance': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        b.escorts = b.escorts.filter(isChar);
        return b;
      }
      case 'promo': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        b.lines = cleanLines(b.lines);
        if (!b.lines.length) return bad('promo has no lines');
        return b;
      }
      case 'interview': {
        if (!isChar(b.guest)) return bad(`unknown guest "${b.guest}"`);
        const u = unknown(b.exchange.map((l) => l.speaker));
        if (u.length) problems.push(`${where} (interview): unknown speakers ${u.join(', ')}`);
        b.exchange = b.exchange.filter((l) => isChar(l.speaker) && l.text.trim()).slice(0, 8);
        if (!b.exchange.length) return bad('interview has no valid lines');
        return b;
      }
      case 'confrontation': {
        const u = unknown([b.a, b.b]);
        if (u.length) return bad(`unknown characters ${u.join(', ')}`);
        if (b.a === b.b) return bad('a and b must differ');
        b.exchange = b.exchange.filter((l) => isChar(l.speaker) && l.text.trim()).slice(0, 8);
        return b;
      }
      case 'attack': {
        b.attackers = b.attackers.filter((id) => isChar(id) && id !== b.victim);
        if (!isChar(b.victim)) return bad(`unknown victim "${b.victim}"`);
        if (!b.attackers.length) return bad('no valid attackers');
        return b;
      }
      case 'match': {
        b.wrestlers = [...new Set(b.wrestlers)];
        const size = b.wrestlers.length;
        const st = b.stipulation;
        if (st === 'tag' && size !== 4) return bad(`a tag match needs exactly 4 wrestlers (got ${size})`);
        if (st === 'battle_royal' && (size < 4 || size > 12)) return bad(`a battle royal needs 4-12 wrestlers (got ${size})`);
        if (st !== 'tag' && st !== 'battle_royal' && size !== 2) return bad(`a ${st} match needs exactly two different wrestlers`);
        const [x] = b.wrestlers;
        // Each stipulation has its own ways to win.
        const allowed: Record<typeof st, string[]> = {
          singles: ['pin', 'rollup', 'cheat_pin', 'submission', 'dq', 'countout', 'no_contest'],
          tag: ['pin', 'rollup', 'cheat_pin', 'submission', 'dq', 'countout', 'no_contest'],
          cage: ['pin', 'rollup', 'cheat_pin', 'submission', 'escape', 'no_contest'],
          ladder: ['retrieve', 'no_contest'],
          battle_royal: ['elimination'],
        };
        if (!allowed[st].includes(b.finish)) {
          const fix = st === 'cage' ? 'escape' : st === 'ladder' ? 'retrieve' : st === 'battle_royal' ? 'elimination' : 'pin';
          problems.push(`${where} (match): "${b.finish}" is not a ${st} finish, using "${fix}"`);
          b.finish = fix;
        }
        const notW = b.wrestlers.filter((id) => !isWrestler(id));
        if (notW.length) return bad(`not wrestlers: ${notW.join(', ')}`);
        const twice = b.wrestlers.filter((id) => booked.has(id));
        if (twice.length) return bad(`${twice.join(', ')} already wrestled this episode`);
        if (b.finish === 'no_contest') {
          if (b.winner !== 'none') problems.push(`${where} (match): no_contest must have winner "none"`);
          b.winner = 'none';
        } else if (!b.wrestlers.includes(b.winner)) {
          problems.push(`${where} (match): winner "${b.winner}" is not in the match`);
          b.winner = x;
        }
        if (b.titleOnLine !== 'none' && st === 'tag') {
          problems.push(`${where} (match): there are no tag team titles yet`);
          b.titleOnLine = 'none';
        }
        if (b.titleOnLine !== 'none') {
          const t = world.titles.find((tt) => tt.id === b.titleOnLine);
          if (!t) {
            problems.push(`${where} (match): unknown title "${b.titleOnLine}"`);
            b.titleOnLine = 'none';
          } else if (b.wrestlers.some((id) => known.get(id)!.division !== t.division)) {
            problems.push(`${where} (match): ${t.id} can only be defended within its division`);
            b.titleOnLine = 'none';
          }
        }
        b.spots = b.spots.filter((s) => {
          if (!isChar(s.who)) {
            problems.push(`${where} (match): spot by unknown "${s.who}"`);
            return false;
          }
          if ((s.type === 'interrupt' || s.type === 'run_in') && b.wrestlers.includes(s.who)) {
            problems.push(`${where} (match): ${s.type} must be by someone outside the match`);
            return false;
          }
          s.lines = cleanLines(s.lines).slice(0, 2);
          return true;
        }).slice(0, 3);
        b.moments = b.moments
          .map((mo) => ({ ...mo, line: mo.line.trim() }))
          .filter((mo) => {
            const ok = mo.speaker === 'pbp' || mo.speaker === 'color' || isChar(mo.speaker);
            if (!ok) problems.push(`${where} (match): moment by unknown speaker "${mo.speaker}"`);
            return ok && mo.line.length > 0;
          })
          .slice(0, 8);
        b.wrestlers.forEach((id) => booked.add(id));
        return b;
      }
      case 'interrupt': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        b.lines = cleanLines(b.lines);
        if (b.then === 'attacks' && !isChar(b.target)) b.then = 'stays';
        return b;
      }
      case 'run_in': {
        const u = unknown([b.who, b.target]);
        if (u.length) return bad(`unknown characters ${u.join(', ')}`);
        return b;
      }
      case 'reveal': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        b.reactions = b.reactions.filter((r) => isChar(r.who)).slice(0, 4);
        return b;
      }
      case 'turn': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        if (turns >= 1) return bad('only one turn per episode — turns must stay rare');
        if (alignment.get(b.who) === b.newAlignment) return bad(`${b.who} is already ${b.newAlignment}`);
        if (b.target !== 'none' && !isChar(b.target)) b.target = 'none';
        turns++;
        alignment.set(b.who, b.newAlignment);
        return b;
      }
      case 'react': {
        if (!isChar(b.who)) return bad(`unknown character "${b.who}"`);
        return b;
      }
      case 'celebrate':
      case 'exit': {
        b.who = b.who.filter(isChar);
        return b.who.length ? b : null;
      }
      case 'narrate': {
        b.text = b.text.trim();
        return b.text ? b : null;
      }
    }
  };

  const segments: Segment[] = [];
  ep.segments.forEach((seg, si) => {
    const beats = seg.beats
      .map((b, bi) => checkBeat(b, `segment ${si + 1} beat ${bi + 1}`))
      .filter((b): b is Beat => b !== null);
    const stateChanges = seg.stateChanges.filter((s) => {
      if (s.type === 'feud_start' || s.type === 'feud_end') return isChar(s.a) && isChar(s.b) && s.a !== s.b;
      if (s.type === 'alliance_form') {
        s.members = s.members.filter(isChar);
        return s.members.length >= 2;
      }
      return true;
    });
    if (beats.length) segments.push({ ...seg, beats, stateChanges });
    else problems.push(`segment ${si + 1} has no playable beats`);
  });
  ep.segments = segments.slice(0, MAX_SEGMENTS);
  if (segments.length > MAX_SEGMENTS) problems.push(`too many segments (max ${MAX_SEGMENTS})`);
  if (ep.segments.length < MIN_SEGMENTS) {
    problems.push(`needs at least ${MIN_SEGMENTS} segments`);
    return { episode: null, problems };
  }
  if (!ep.segments.some((s) => s.beats.some((b) => b.type === 'match'))) problems.push('an episode needs at least one match');
  return { episode: ep, problems };
}
