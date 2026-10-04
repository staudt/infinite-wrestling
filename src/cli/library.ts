// Manage stored shows.
//   npm run library                 list stored shows (saved sessions and the committed library)
//   npm run library -- add <id>     copy a saved show into library/ so it can be committed
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirs, listLibrary } from '../../server/sessions';

const [cmd, id] = process.argv.slice(2);

if (cmd === 'add') {
  const from = join(dirs.sessions, String(id));
  if (!id || !existsSync(join(from, 'promotion.json'))) {
    console.error(`no saved show "${id}" in ${dirs.sessions}/`);
    process.exit(1);
  }
  cpSync(from, join(dirs.library, id), { recursive: true });
  console.log(`copied ${from} -> ${join(dirs.library, id)} (commit it to ship this show)`);
} else {
  for (const e of listLibrary()) {
    console.log(`${e.id.padEnd(11)} ${e.source.padEnd(8)} ${String(e.episodes).padStart(3)} eps  ${e.showName}${e.direction ? ` — ${e.direction.slice(0, 60)}` : ''}`);
  }
}
