// Render stored episodes to MP4: the show is deterministic, so instead of recording in
// real time we step it frame by frame in a headless browser, screenshot each frame, and
// pipe the frames into ffmpeg. Unattended and frame-perfect (and silent, for now).
//
//   npm run render -- --show stw --ep 12                 one episode
//   npm run render -- --show stw --ep 12 --seg 7         one segment (a clip)
//   npm run render -- --show stw --season 1              every stored episode of a season
//   options: --format landscape|vertical (1920x1080 or 1080x1920)  --fps 24  --out renders
//
// Works with anything stored: the committed library/ and your saved shows in sessions/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { listLibrary, type LibraryEntry } from '../../server/sessions';
import { SEASON_LENGTH } from '../world/season';

const args = process.argv.slice(2);
const arg = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const FORMATS = {
  // Viewport x scale = output size; the vertical one uses the phone (stacked) layout.
  landscape: { width: 1280, height: 720, scale: 1.5 },
  vertical: { width: 540, height: 960, scale: 2 },
} as const;

function fail(msg: string): never {
  console.error(`[render] ${msg}`);
  process.exit(1);
}

/** Same matching as the ?show= links: id, seed, short name, or (part of) the name. */
function findShow(query: string): LibraryEntry | undefined {
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const q = slug(query);
  const all = listLibrary();
  return all.find((e) => e.id === query || String(e.seed) === query)
    ?? all.find((e) => slug(e.shortName) === q || slug(e.showName) === q)
    ?? all.find((e) => slug(e.showName).split('-').includes(q) || slug(e.showName).startsWith(q));
}

function findBrowser(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => p && existsSync(p));
}

const showArg = arg('show') ?? fail('missing --show <id | initials | name>');
const show = findShow(showArg) ?? fail(`no stored show matches "${showArg}" (see npm run library)`);
const format = FORMATS[(arg('format') ?? 'landscape') as keyof typeof FORMATS] ?? fail('--format is landscape or vertical');
const fps = Number(arg('fps') ?? 24);
const outDir = arg('out') ?? 'renders';
const seg = arg('seg') ? Number(arg('seg')) : null;

// Which episodes: --ep N, or every stored episode of --season S.
let episodes: number[];
if (arg('ep')) episodes = [Number(arg('ep'))];
else if (arg('season')) {
  const s = Number(arg('season'));
  episodes = Array.from({ length: SEASON_LENGTH }, (_, i) => (s - 1) * SEASON_LENGTH + i + 1).filter((n) => n <= show.episodes);
} else fail('pass --ep <n> or --season <n>');
if (!episodes.length || episodes.some((n) => n < 1 || n > show.episodes)) {
  fail(`"${show.showName}" has ${show.episodes} stored episodes`);
}
if (seg !== null && episodes.length > 1) fail('--seg works with a single --ep');

const executablePath = findBrowser() ?? fail('no Chrome/Chromium found; set CHROMIUM_PATH');
mkdirSync(outDir, { recursive: true });

// The app (and its stored-show library) served by Vite, on a free port.
const server = await createServer({ logLevel: 'error', server: { port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer!.address();
const base = `http://localhost:${typeof address === 'object' && address ? address.port : 5173}`;

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'] });
try {
  for (const n of episodes) {
    const season = Math.floor((n - 1) / SEASON_LENGTH) + 1;
    const inSeason = ((n - 1) % SEASON_LENGTH) + 1;
    const name = `${show.shortName.toLowerCase()}-s${season}e${String(inSeason).padStart(2, '0')}${seg ? `-seg${seg}` : ''}.mp4`;
    await renderEpisode(n, join(outDir, name));
  }
} finally {
  await browser.close();
  await server.close();
}

async function renderEpisode(n: number, file: string): Promise<void> {
  const page: Page = await browser.newPage({
    viewport: { width: format.width, height: format.height },
    deviceScaleFactor: format.scale,
  });
  const params = new URLSearchParams({ render: '1', offline: '1', show: show.id, ep: String(n) });
  if (seg) {
    params.set('seg', String(seg));
    params.set('clip', '1');
  }
  await page.goto(`${base}/?${params}`);
  await page.waitForFunction(() => (window as unknown as { __render?: { ready: boolean } }).__render?.ready, null, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  const label = await page.evaluate(() => (window as unknown as { __render: { label: string } }).__render.label);
  console.error(`[render] ${label} -> ${file}`);

  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart',
    file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise<number>((resolve) => ffmpeg.on('close', (code) => resolve(code ?? 1)));
  const write = (buf: Buffer) => new Promise<void>((resolve) => (ffmpeg.stdin.write(buf) ? resolve() : ffmpeg.stdin.once('drain', resolve)));

  // Chrome's fast capture path; frames where nothing changed reuse the previous image.
  const cdp = await page.context().newCDPSession(page);
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', {
    format: 'jpeg', quality: 90, optimizeForSpeed: true,
    // CDP captures at CSS size unless the clip asks for the device scale.
    clip: { x: 0, y: 0, width: format.width, height: format.height, scale: format.scale },
  } as never) as { data: string }).data, 'base64');
  const started = Date.now();
  let frames = 0;
  let captured = 0;
  let frame = await shot();
  for (;;) {
    await write(frame);
    frames++;
    const state = await page.evaluate((dt) => {
      const r = (window as unknown as { __render: { step(s: number): boolean; done: boolean; time: number } }).__render;
      const changed = r.step(dt);
      return { done: r.done, time: r.time, changed };
    }, 1 / fps);
    if (state.changed) {
      frame = await shot();
      captured++;
    }
    if (frames % (fps * 30) === 0) {
      const t = Math.floor(state.time);
      console.error(`[render]   ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} of show time, ${frames} frames, ${Math.round((100 * captured) / frames)}% captured (${Math.round(frames / ((Date.now() - started) / 1000))} fps)`);
    }
    if (state.done) break;
  }
  // Hold the last frame for two seconds so the ending doesn't cut off abruptly.
  const last = await shot();
  for (let i = 0; i < fps * 2; i++) await write(last);
  ffmpeg.stdin.end();
  const code = await finished;
  await page.close();
  if (code !== 0) fail(`ffmpeg exited with code ${code}`);
  const secs = frames / fps;
  console.error(`[render]   done: ${Math.floor(secs / 60)}m${Math.round(secs % 60)}s of video in ${Math.round((Date.now() - started) / 1000)}s`);
}
