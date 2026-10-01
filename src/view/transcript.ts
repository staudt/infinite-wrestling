import type { EngineEvent } from '../engine/events';
import type { Stage } from '../engine/stage';

export function clock(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Turn engine events into plain transcript lines (terminal preview, saved show logs). */
export function transcriptLine(stage: Stage, e: EngineEvent): string | null {
  const name = (id: string) => stage.actors.get(id)?.name ?? id;
  switch (e.type) {
    case 'episodeStart':
      return `\n=== ${e.label.toUpperCase()}: ${e.title} ===`;
    case 'segmentStart':
      return `\n--- ${e.title} ---`;
    case 'narrated':
      return `${clock(e.t)}  ${e.style === 'big' || e.style === 'shock' ? e.text.toUpperCase() : e.text}`;
    case 'said':
      return `${clock(e.t)}  ${name(e.who)}: "${e.text}"`;
    case 'matchEnd':
      return `${clock(e.t)}  [RESULT] ${e.winner ? `${name(e.winner)} wins by ${e.finish}` : 'no contest'}`;
    case 'titleChange':
      return `${clock(e.t)}  [TITLE] ${name(e.newChampion)} is the new ${stage.titles.find((t) => t.id === e.title)?.name ?? e.title} champion`;
    case 'elimination':
      return `${clock(e.t)}  [OUT] ${name(e.who)} eliminated by ${name(e.by)} (${e.remaining} left)`;
    case 'alignmentChanged':
      return `${clock(e.t)}  [TURN] ${name(e.id)} is now a ${e.alignment}`;
    case 'crowd':
      return e.chant ? `${clock(e.t)}  (crowd: "${e.chant}")` : null;
    default:
      return null;
  }
}
