// Finds character names inside any text so views can paint them in that character's
// color ("Vega hits the DDT!" -> "Vega" in Vega's color). Matches full names, names
// without the "Nickname", and unambiguous first/last names.
import type { Stage } from '../engine/stage';

export interface Run { text: string; color: string | null }

// Words too common to treat as a name on their own.
const STOP = new Set(['The', 'Big', 'Lady', 'Sir', 'Kid', 'Mad', 'Doc', 'Baron', 'Mr', 'Miss', 'Mrs', 'King', 'Queen', 'Iron', 'Little', 'Mean', 'Dr', 'Captain', 'Colonel', 'Sgt', 'Rowdy']);

export class NameIndex {
  private re: RegExp | null = null;
  private colorOf = new Map<string, string>();
  private key = '';

  constructor(private stage: Stage) {}

  private rebuild(): void {
    const actors = [...this.stage.actors.values()].filter((a) => a.kind !== 'ref');
    const key = actors.map((a) => a.id).join();
    if (key === this.key) return;
    this.key = key;
    this.colorOf.clear();
    const words = new Map<string, string[]>();
    const add = (name: string, color: string) => {
      if (name.length < 3 || this.colorOf.has(name.toLowerCase())) return;
      this.colorOf.set(name.toLowerCase(), color);
    };
    for (const a of actors) {
      const plain = a.name.replace(/"[^"]*"\s*/g, '').replace(/\s+/g, ' ').trim();
      add(a.name, a.color);
      add(plain, a.color);
      for (const w of plain.split(' ')) {
        // Only capitalized words ("the" in "Cornette the Racketeer" is not a name).
        if (w.length >= 3 && /^[A-Z]/.test(w) && !STOP.has(w)) words.set(w, [...(words.get(w) ?? []), a.color]);
      }
    }
    // Single words only when they belong to exactly one character.
    for (const [w, colors] of words) if (colors.length === 1) add(w, colors[0]);
    const names = [...this.colorOf.keys()].sort((a, b) => b.length - a.length);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.re = names.length ? new RegExp(`(?<![\\w'])(${names.map(esc).join('|')})(?!\\w)`, 'gi') : null;
  }

  /** Split text into runs, coloring every name. */
  runs(text: string): Run[] {
    this.rebuild();
    if (!this.re) return [{ text, color: null }];
    const out: Run[] = [];
    let last = 0;
    for (const m of text.matchAll(this.re)) {
      const word = m[0];
      // Single words must match case exactly (so "king" in a sentence isn't a name);
      // multi-word names may be shouted in caps.
      const single = !word.includes(' ');
      const color = this.colorOf.get(word.toLowerCase());
      if (!color || (single && !/^[A-Z]/.test(word))) continue;
      if (m.index! > last) out.push({ text: text.slice(last, m.index), color: null });
      out.push({ text: word, color });
      last = m.index! + word.length;
    }
    if (last < text.length) out.push({ text: text.slice(last), color: null });
    return out;
  }

  html(text: string, esc: (s: string) => string): string {
    return this.runs(text)
      .map((r) => (r.color ? `<b style="color:${r.color}">${esc(r.text)}</b>` : esc(r.text)))
      .join('');
  }
}
