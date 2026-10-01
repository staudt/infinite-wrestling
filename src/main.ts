import './style.css';
import { type BookSource, fetchEpisode, fetchHealth, fetchLibrary, fetchPromotion, fetchStoredPromotion, type Health, type LibraryEntry } from './booker/client';
import type { Director } from './choreo/director';
import { arena } from './engine/arena';
import { Stage, TICK } from './engine/stage';
import type { Task } from './engine/tasks';
import type { Episode } from './schema/episode';
import { prepareStage } from './show/runner';
import { demoEpisode } from './booker/fallback';
import { offlineWorld } from './world/genesis';
import { episodeLabel, ppvName } from './world/season';
import { CardView } from './view/card';
import { FeedView } from './view/feed';
import { MapView } from './view/map';
import { connectionText, StartScreen } from './view/start';
import { loadWorldFromStorage, randomSeed, saveWorldToStorage, type World } from './world/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage(0);
const map = new MapView($('map'), stage);
const feed = new FeedView($('feed'), stage);
const card = new CardView($('card'), stage);
stage.on((e) => {
  map.onEvent(e);
  feed.onEvent(e);
  card.onEvent(e);
  if (e.type === 'segmentStart') $('seg').textContent = e.title;
  if (e.type === 'episodeStart') $('ep').textContent = `${e.label}: ${e.title}`;
  if (e.type === 'titleChange' || e.type === 'episodeStart') renderChamps();
});

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

// Dev aid: ?skip=SECONDS fast-forwards the first episode (e.g. to inspect a match).
let skip = Number(new URLSearchParams(location.search).get('skip') ?? 0);

function play(director: Director): Promise<void> {
  return new Promise((done) => {
    playing = { task: stage.spawn(director.play()), done };
    for (; skip > 0 && !playing.task.done; skip -= TICK) stage.update();
    skip = 0;
  });
}

/** The endless show: air episode N while the booker writes episode N+1. */
async function showLoop(world: World): Promise<void> {
  $('show').textContent = world.showName;
  document.title = world.showName;
  setStatus(`booking episode ${world.episode + 1}…`);
  let booking = fetchEpisode(world);
  for (;;) {
    const { episode, source } = await booking;
    const { director, after } = prepareStage(stage, world, episode);
    current = { episode, world: after, source };
    card.setEpisode(episodeLabel(after, after.episode), episode, ppvName(after, after.episode));
    renderChamps();
    setStatus(`episode ${after.episode} ${source === 'stored' ? 'from storage' : `booked by ${source}`} · preparing the next one…`);
    booking = fetchEpisode(after);
    booking.then((b) => setStatus(`episode ${after.episode} ${source === 'stored' ? 'from storage' : `booked by ${source}`} · next episode ready (${b.source})`));
    await play(director);
    saveWorldToStorage(after);
    world = after;
  }
}

// ------------------------------------------------------------------ connection + start screen

let health: Health | null | undefined;
async function refreshHealth(): Promise<void> {
  health = await fetchHealth();
  const c = connectionText(health);
  $('conn').textContent = c.text;
  $('conn').className = c.cls;
}

const start = new StartScreen($('start'));
async function openStart(canClose: boolean, current: World | null = canClose ? loadWorldFromStorage() : null): Promise<void> {
  start.open({ current, library: await fetchLibrary(), health, canClose });
}

/** Decide what to air: ?play=new|library, the saved show, or the start screen. */
async function main(): Promise<void> {
  await refreshHealth();
  setInterval(refreshHealth, 20_000);
  const params = new URLSearchParams(location.search);
  // Shareable links: ?show=warzone (or the short name, full name, or seed) plays that
  // stored show from Season 1, Episode 1 right away.
  const showParam = params.get('show');
  const program = showParam ? 'library' : params.get('play');
  const demo = params.get('demo');
  if (demo) {
    // Dev/demo: one stipulation match on a throwaway offline roster (nothing is saved).
    const w = offlineWorld(randomSeed());
    const ep = demoEpisode(w, demo);
    const { director } = prepareStage(stage, w, ep);
    card.setEpisode('Demo', ep);
    $('show').textContent = w.showName;
    setStatus(`demo: ${demo}`);
    await play(director);
    setStatus('demo finished');
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
    feed.onEvent({ type: 'narrated', text: `Welcome to ${world.showName}! (roster by ${created.source})`, style: 'info', t: 0 });
  } else if (program === 'library') {
    const seed = showParam ? findShow(await fetchLibrary(), showParam)?.seed : Number(params.get('seed'));
    world = seed ? await fetchStoredPromotion(seed) : null;
    if (!world) setStatus(`couldn't find the stored show "${showParam ?? params.get('seed')}"`);
  } else {
    world = loadWorldFromStorage();
  }
  // Keep the URL clean so a reload continues the show instead of restarting it.
  for (const k of ['play', 'direction', 'seed', 'show']) params.delete(k);
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
      void showLoop(ready);
    };
    await openStart(true, ready);
    return;
  }
  markChosen();
  await showLoop(world);
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
  }
  renderStatus();
});

function fit(): void {
  // The arena is the main event: size it to the space left of the card.
  const side = window.innerWidth > 900 ? 320 : 0;
  const width = Math.min(window.innerWidth - 48 - side, 1500);
  const px = Math.max(7, Math.min(24, width / (arena.width * 0.61)));
  document.documentElement.style.setProperty('--cell', `${px}px`);
}
window.addEventListener('resize', fit);
fit();

requestAnimationFrame(frame);
main().catch((err) => setStatus(`show crashed: ${(err as Error).message}`));
