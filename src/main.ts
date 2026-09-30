import './style.css';
import { type BookSource, fetchEpisode, fetchPromotion } from './booker/client';
import type { Director } from './choreo/director';
import { Stage, TICK } from './engine/stage';
import type { Task } from './engine/tasks';
import type { Episode } from './schema/episode';
import { prepareStage } from './show/runner';
import { FeedView } from './view/feed';
import { MapView } from './view/map';
import { clearWorldStorage, loadWorldFromStorage, randomSeed, saveWorldToStorage, type World } from './world/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage(0);
const map = new MapView($('map'), $('legend'), stage);
const feed = new FeedView($('feed'), stage);
stage.on((e) => {
  map.onEvent(e);
  feed.onEvent(e);
  if (e.type === 'segmentStart') $('seg').textContent = e.title;
  if (e.type === 'episodeStart') $('ep').textContent = `Episode ${e.number}: ${e.title}`;
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
async function showLoop(): Promise<void> {
  const params = new URLSearchParams(location.search);
  let world = params.has('new') ? null : loadWorldFromStorage();
  if (!world) {
    // A brand-new promotion: fresh roster, titles and feuds, optionally steered by a direction.
    const direction = params.get('direction') ?? '';
    setStatus(`creating a new promotion${direction ? ` (${direction})` : ''}…`);
    feed.onEvent({ type: 'narrated', text: 'Creating a brand-new promotion…', style: 'info', t: 0 });
    const created = await fetchPromotion(direction, randomSeed());
    world = created.world;
    saveWorldToStorage(world);
    feed.onEvent({ type: 'narrated', text: `Welcome to ${world.showName}! (roster by ${created.source})`, style: 'info', t: 0 });
    params.delete('new');
    params.delete('direction');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  $('show').textContent = world.showName;
  document.title = world.showName;
  setStatus(`booking episode ${world.episode + 1}…`);
  let booking = fetchEpisode(world);
  for (;;) {
    const { episode, source } = await booking;
    const { director, after } = prepareStage(stage, world, episode);
    current = { episode, world: after, source };
    renderChamps();
    setStatus(`episode ${after.episode} booked by ${source} · booking episode ${after.episode + 1}…`);
    booking = fetchEpisode(after);
    booking.then((b) => setStatus(`episode ${after.episode} booked by ${source} · episode ${after.episode + 1} ready (${b.source})`));
    await play(director);
    saveWorldToStorage(after);
    world = after;
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
  feed.tick();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
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
    const direction = prompt(
      'Start a brand-new promotion? All storylines will be forgotten.\n\n' +
        'Optional direction (e.g. "ECW-style hardcore bingo-hall promotion with rabid fans"):',
      '',
    );
    if (direction === null) return;
    clearWorldStorage();
    location.search = `?new=1${direction.trim() ? `&direction=${encodeURIComponent(direction.trim())}` : ''}`;
  }
  renderStatus();
});

function fit(): void {
  const width = Math.min(window.innerWidth - 32, 1400);
  const px = Math.max(7, Math.min(20, width / (78 * 0.61)));
  document.documentElement.style.setProperty('--cell', `${px}px`);
}
window.addEventListener('resize', fit);
fit();

requestAnimationFrame(frame);
showLoop().catch((err) => setStatus(`show crashed: ${(err as Error).message}`));
