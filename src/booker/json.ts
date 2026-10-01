// Helpers for tolerating the shapes models actually send.
type Loose = Record<string, unknown>;
const isObj = (x: unknown): x is Loose => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Models sometimes send nested tool arguments as JSON-encoded strings
 * (e.g. `"beats": "[{...}]"`). Decode those anywhere in the input.
 */
export function unstringify(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      const parsed = parseLoose(t);
      return parsed === undefined ? v : unstringify(parsed);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(unstringify);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unstringify(x)]));
  return v;
}

/**
 * JSON.parse, plus one repair for a mistake models make inside stringified JSON:
 * unescaped quotes in values, e.g. "name": "Dusty "The Tornado" Mercer". Pretty-printed
 * JSON has one value per line, so quotes inside a line's string value get re-escaped.
 */
export function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repair
  }
  const fixed = text.split('\n').map((line) => {
    const m = line.match(/^(\s*"[^"]+"\s*:\s*")(.*)("\s*,?\s*)$/);
    if (!m) return line;
    return m[1] + m[2].replace(/\\"/g, '"').replace(/"/g, '\\"') + m[3];
  }).join('\n');
  try {
    return JSON.parse(fixed);
  } catch {
    // fall through to salvaging list items one by one
  }
  return text.trimStart().startsWith('[') ? salvageArray(text) : undefined;
}

/**
 * Last resort for a broken stringified list: pull out each complete top-level {...}
 * object and keep the ones that parse, so one stray brace or bad item loses one item
 * instead of the whole list.
 */
function salvageArray(text: string): unknown[] | undefined {
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue; // stray closing brace
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip just this item
        }
        start = -1;
      }
    }
  }
  return items.length ? items : undefined;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && w !== 'the');

/**
 * Find who a loose reference means: an exact id, or the one character whose name contains
 * every word of it ("marcus_architect_stone" -> Marcus "The Architect" Stone).
 */
export function matchCharacter<T extends { id: string; name: string }>(ref: string, people: T[]): T | undefined {
  const exact = people.find((p) => p.id === ref);
  if (exact) return exact;
  const want = words(ref);
  if (!want.length) return undefined;
  const hits = people.filter((p) => {
    const have = new Set(words(p.name));
    return want.every((w) => have.has(w));
  });
  return hits.length === 1 ? hits[0] : undefined;
}
