import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './style.css';
import {
  type BookSource, fetchEpisode, fetchHealth, fetchLibrary, fetchPromotion, fetchStoredEpisode, fetchStoredPromotion,
  type Health, type LibraryEntry,
} from './booker/client';
import { demoEpisode } from './booker/fallback';
import { reviewEpisode } from './booker/validate';
import type { EngineEvent } from './engine/events';
import { arena } from './engine/arena';
import { Stage, TICK } from './engine/stage';
import type { Task } from './engine/tasks';
import type { Episode } from './schema/episode';
import { prepareStage } from './show/runner';
import { CardView } from './view/card';
import { FeedView } from './view/feed';
import { MapView } from './view/map';
import { connectionText, StartScreen } from './view/start';
import { applyEpisode } from './world/apply';
import { offlineWorld } from './world/genesis';
import { episodeLabel, ppvName } from './world/season';
import { loadWorldFromStorage, randomSeed, saveWorldToStorage, type World } from './world/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ stage + views

// Every episode plays on a fresh stage, so replaying an episode (to jump to a segment or a
// log line) reproduces it exactly: the engine is deterministic for a given world + episode.
let stage = new Stage(0);
let map = new MapView($('map'), stage);
let feed = new FeedView($('feed'), stage);
let card = new CardView($('card'), stage);

function onEvent(e: EngineEvent): void {
  map.onEvent(e);
  feed.onEvent(e);
  card.onEvent(e);
  if (e.type === 'segmentStart') $('seg').textContent = e.title;
  if (e.type === 'episodeStart') $('ep').textContent = e.title === e.ppv ? e.label : `${e.label}: ${e.title}`;
  if (e.type === 'titleChange' || e.type === 'episodeStart') renderChamps();
}

function freshStage(): void {
  stage = new Stage(0);
  map = new MapView($('map'), stage);
  feed = new FeedView($('feed'), stage);
  feed.clear();
  card = new CardView($('card'), stage);
  stage.on(onEvent);
}
stage.on(onEvent);

const SPEEDS = [1, 2, 4, 8];
let speed = 1;
let paused = false;
let playing: { task: Task; done: () => void } | null = null;
let status = '';
let current: { episode: Episode; world: World; source: BookSource } | null = null;

function renderChamps(): void {
  $('champs').innerHTML = stage.titles
    .map((t) => {
      const a = t.holder ? stage.actors.get(t.holder) : null;
      const short = t.name.replace(`${stage.shortName} `, '').replace(' Championship', '');
      return `<span title="${t.name}">${short}: <b style="color:${a?.color ?? '#888'}">${a?.name ?? 'vacant'}</b></span>`;
    })
    .join('');
}

function setStatus(s: string): void {
  status = s;
  renderStatus();
}

function renderStatus(): void {
  $('status').textContent = `${paused ? '⏸ paused' : `▶ ${speed}x`} · ${status}`;
  if (!$('debug').hidden && current) {
    $('debug-body').textContent = JSON.stringify(
      {
        status,
        booked_by: current.source,
        direction: current.world.direction || '(none)',
        champions: current.world.titles.map((t) => `${t.id}: ${t.holder}`),
        feuds: current.world.feuds.map((f) => `${f.a} vs ${f.b}: ${f.reason}`),
        alliances: current.world.alliances.map((a) => `${a.name}: ${a.members.join(', ')}`),
        storySoFar: current.world.storySoFar,
        episode: current.episode,
      },
      null,
      2,
    );
  }
}

// ------------------------------------------------------------------ episodes + seeking

/** An episode we can (re)play: the world it follows, and the episode itself. */
interface Entry { before: World; episode: Episode; source: BookSource }

/** Where to jump inside an episode. */
type Target = { segment: number } | { time: number };

/** Episodes known this session, by global episode number. */
const entries = new Map<number, Promise<Entry | null>>();
/** The show's starting point: the first episode to air and the world before it. */
let base: { n: number; world: World } | null = null;
/** The episode on screen. */
let nowPlaying = 0;
/** Bumped by every jump, so an older playback chain stops when it notices. */
let generation = 0;

/**
 * Get (or book) episode n: from this session, from the world after episode n-1 (stored
 * first, then the LLM, then offline), or rebuilt from stored episodes 1..n.
 */
function entryFor(n: number): Promise<Entry | null> {
  const known = entries.get(n);
  if (known) return known;
  const promise = (async (): Promise<Entry | null> => {
    let before: World | null = null;
    if (!base) return null;
    if (n === base.n) before = base.world;
    else if (n > base.n) {
      // Walk forward from the episode before it (each step stored, booked, or offline).
      const prev = await entryFor(n - 1);
      if (prev) before = applyEpisode(prev.before, prev.episode);
    } else {
      return rebuildFromStorage(n, base.world.seed);
    }
    if (!before) return null;
    const booked = await fetchEpisode(before);
    return { before, episode: booked.episode, source: booked.source };
  })();
  entries.set(n, promise);
  promise.then((e) => {
    if (!e) entries.delete(n); // let a later attempt try again
  });
  return promise;
}

/** Re-apply stored episodes 1..n from the stored promotion (pure and instant). */
async function rebuildFromStorage(n: number, seed: number): Promise<Entry | null> {
  let world = await fetchStoredPromotion(seed);
  if (!world) return null;
  for (let k = 1; k <= n; k++) {
    const raw = await fetchStoredEpisode(seed, k);
    const review = raw ? reviewEpisode(raw, world) : null;
    if (!review?.episode) return null;
    const entry: Entry = { before: world, episode: review.episode, source: 'stored' };
    if (!entries.has(k)) entries.set(k, Promise.resolve(entry));
    if (k === n) return entry;
    world = applyEpisode(world, review.episode);
  }
  return null;
}

/** Run the simulation silently until `until()` holds (or the episode ends). */
function fastForward(task: Task, until: () => boolean): void {
  const limit = stage.time + 4 * 3600;
  while (!task.done && !until() && stage.time < limit) stage.update();
}

/** Play episode n (optionally jumping inside it), then keep the show going. */
async function run(n: number, target?: Target): Promise<void> {
  const my = ++generation;
  playing = null;
  setStatus(n === nowPlaying ? 'rewinding…' : `loading episode ${n}…`);
  const entry = await entryFor(n);
  if (my !== generation) return;
  if (!entry) {
    setStatus(n < nowPlaying ? 'earlier episodes of this show are not stored' : `episode ${n} is not available`);
    return;
  }
  nowPlaying = n;
  freshStage();
  const { director, after } = prepareStage(stage, entry.before, entry.episode);
  current = { episode: entry.episode, world: after, source: entry.source };
  $('show').textContent = after.showName;
  document.title = after.showName;
  card.setEpisode(episodeLabel(after, n), entry.episode, ppvName(after, n), { prev: n > 1, next: true });
  renderChamps();
  const task = stage.spawn(director.play());
  if (target) {
    if ('segment' in target) {
      let reached = false;
      const off = stage.on((e) => {
        if (e.type === 'segmentStart' && e.index >= target.segment) reached = true;
      });
      fastForward(task, () => reached);
      off();
    } else {
      fastForward(task, () => stage.time >= target.time - 0.05);
    }
  }
  const from = entry.source === 'stored' ? 'from storage' : `booked by ${entry.source}`;
  setStatus(`episode ${n} ${from} · preparing the next one…`);
  void entryFor(n + 1).then((next) => {
    if (my === generation && next) setStatus(`episode ${n} ${from} · next episode ready (${next.source})`);
  });
  await new Promise<void>((done) => {
    playing = { task, done };
  });
  if (my !== generation) return;
  saveWorldToStorage(after);
  void run(n + 1);
}

/** Start the endless show from a world (the next episode is world.episode + 1). */
function startShow(world: World, target?: Target): void {
  entries.clear();
  base = { n: world.episode + 1, world };
  void run(base.n, target);
}

// Clicks: a segment in the card, the episode arrows, or a line in the log.
$('card').addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const nav = el.closest<HTMLElement>('[data-nav]')?.dataset.nav;
  if (nav && !(el.closest('button') as HTMLButtonElement | null)?.disabled) {
    void run(nowPlaying + (nav === 'prev' ? -1 : 1));
    return;
  }
  const seg = el.closest<HTMLElement>('[data-seg]')?.dataset.seg;
  if (seg !== undefined && nowPlaying) void run(nowPlaying, { segment: Number(seg) });
});
$('feed').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]')?.dataset.t;
  if (t !== undefined && nowPlaying) void run(nowPlaying, { time: Number(t) });
});

// ------------------------------------------------------------------ connection + start screen

let health: Health | null | undefined;
async function refreshHealth(): Promise<void> {
  health = await fetchHealth();
  const c = connectionText(health);
  $('conn').textContent = c.text;
  $('conn').className = c.cls;
}

const start = new StartScreen($('start'));
async function openStart(canClose: boolean, currentWorld: World | null = canClose ? loadWorldFromStorage() : null): Promise<void> {
  start.open({ current: currentWorld, library: await fetchLibrary(), health, canClose });
}

/** Decide what to air: ?show= / ?play=new|library, the saved show, or the start screen. */
async function main(): Promise<void> {
  await refreshHealth();
  setInterval(refreshHealth, 20_000);
  const params = new URLSearchParams(location.search);
  // Dev aid: ?skip=SECONDS jumps into the first episode (e.g. to inspect a match).
  const skip = Number(params.get('skip') ?? 0);
  const target: Target | undefined = skip > 0 ? { time: skip } : undefined;
  // Shareable links: ?show=warzone (or the short name, full name, or seed) plays that
  // stored show from Season 1, Episode 1 right away.
  const showParam = params.get('show');
  const program = showParam ? 'library' : params.get('play');
  const demo = params.get('demo');
  if (demo) {
    // Dev/demo: one stipulation match on a throwaway offline roster (nothing is saved).
    const w = offlineWorld(randomSeed());
    freshStage();
    const ep = demoEpisode(w, demo);
    const { director } = prepareStage(stage, w, ep);
    card.setEpisode('Demo', ep);
    $('show').textContent = w.showName;
    setStatus(`demo: ${demo}`);
    const task = stage.spawn(director.play());
    if (target) fastForward(task, () => stage.time >= target.time);
    return;
  }
  let world: World | null = null;
  if (program === 'new') {
    // A brand-new promotion: fresh roster, titles and feuds, optionally steered by a direction.
    const direction = params.get('direction') ?? '';
    setStatus(`creating a new promotion${direction ? ` (${direction.slice(0, 60)}…)` : ''}`);
    feed.onEvent({ type: 'narrated', text: 'Creating a brand-new promotion…', style: 'info', t: 0 });
    const created = await fetchPromotion(direction, randomSeed());
    world = created.world;
  } else if (program === 'library') {
    const seed = showParam ? findShow(await fetchLibrary(), showParam)?.seed : Number(params.get('seed'));
    world = seed ? await fetchStoredPromotion(seed) : null;
    if (!world) setStatus(`couldn't find the stored show "${showParam ?? params.get('seed')}"`);
  } else {
    world = loadWorldFromStorage();
  }
  const deep = { ep: params.get('ep'), seg: params.get('seg') };
  // Keep the URL clean so a reload continues the show instead of restarting it.
  for (const k of ['play', 'direction', 'seed', 'show', 'skip', 'ep', 'seg']) params.delete(k);
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  if (!world) {
    if (!status.startsWith("couldn't")) setStatus('choose a show');
    await openStart(false);
    return;
  }
  saveWorldToStorage(world);
  // Opening the show in a new tab asks what to watch (Continue is the first choice);
  // reloads in the same tab, or a pick from the start screen, go straight to the show.
  if (!program && !chosenThisTab()) {
    setStatus('choose a show');
    const ready = world;
    start.onContinue = () => {
      start.onContinue = null; // later Continue clicks (from N) just close the screen
      markChosen();
      startShow(ready);
    };
    await openStart(true, ready);
    return;
  }
  markChosen();
  // Deep links: &ep=8 (and &seg=3) open that episode (segment) of the show directly.
  const ep = Number(deep.ep ?? 0);
  if (ep >= 1) {
    entries.clear();
    base = { n: world.episode + 1, world };
    void run(ep, deep.seg !== null ? { segment: Number(deep.seg) - 1 } : target);
    return;
  }
  startShow(world, target);
}

/** Match a ?show= value against stored shows: seed, short name, or (part of) the name. */
function findShow(library: LibraryEntry[], query: string): LibraryEntry | undefined {
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const q = slug(query);
  return library.find((e) => String(e.seed) === query)
    ?? library.find((e) => slug(e.shortName) === q || slug(e.showName) === q)
    ?? library.find((e) => slug(e.showName).split('-').includes(q) || slug(e.showName).startsWith(q));
}

const CHOSEN_KEY = 'gptww.chosen';
function chosenThisTab(): boolean {
  try {
    return sessionStorage.getItem(CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}
function markChosen(): void {
  try {
    sessionStorage.setItem(CHOSEN_KEY, '1');
  } catch {
    // no session storage: the start screen simply shows on every load
  }
}

// Fixed-step simulation, decoupled from the frame rate.
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dt * speed;
    while (acc >= TICK) {
      stage.update();
      acc -= TICK;
      if (playing?.task.done) {
        const p = playing;
        playing = null;
        p.done();
      }
    }
  }
  map.render();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
  if (start.isOpen) {
    if (e.key === 'Escape' && current) start.close();
    return;
  }
  if (e.key === ' ') {
    paused = !paused;
    e.preventDefault();
  } else if (e.key >= '1' && e.key <= '4') {
    speed = SPEEDS[Number(e.key) - 1];
  } else if (e.key === 'd') {
    $('debug').hidden = !$('debug').hidden;
  } else if (e.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  } else if (e.key === 'N') {
    void openStart(current !== null);
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && nowPlaying) {
    const n = nowPlaying + (e.key === 'ArrowLeft' ? -1 : 1);
    if (n >= 1) void run(n);
  }
  renderStatus();
});

function fit(): void {
  // The arena is the main event: as big as fits beside the card and above the log.
  // Up to 900px wide the layout stacks (arena, card, log); wider, the card has its own column.
  const phone = window.innerWidth <= 900;
  const side = phone ? 0 : 454; // the card column (440px) + gap
  const width = Math.min(window.innerWidth - (phone ? 30 : 48) - side, 1500);
  let px = Math.min(24, width / (arena.width * 0.61));
  if (!phone) {
    // Leave room under the arena for the log (and the header/footer around them).
    const rows = arena.depth + 2;
    px = Math.min(px, (window.innerHeight - 260) / (rows * 1.3));
  }
  px = Math.max(7, px);
  document.documentElement.style.setProperty('--cell', `${px}px`);
}
window.addEventListener('resize', fit);
fit();

requestAnimationFrame(frame);
main().catch((err) => setStatus(`show crashed: ${(err as Error).message}`));
