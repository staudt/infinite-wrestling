# GPTWW Saturday Night

A never-ending, AI-booked, 1980s NWA-style wrestling TV show that runs itself like a screensaver. An LLM (Claude) books each weekly episode: promos, interviews, betrayals, reveals, run-ins and short matches. A deterministic engine stages it in a NetHack-style ASCII arena with timed play-by-play.

```
 ░░░▒░░^░░░░░░!░░░░░░░░░░░░░░░░░░^░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 ██······                  ▄▄▄▄▄▄▄          o═══════════════════════════o
 ██······                   i  @            ║··························║
 ██······──────────────────────────────     ║···@····r·················║
 ██···@···································  ║··········_···············║
 ENTRANCE                 INTERVIEW                     GPTWW
```

## Run it

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY to have Claude create and book the show
npm run server              # booker proxy on :8787 (keeps the key server-side)
npm run dev                 # open the printed URL
```

The first visit creates a **brand-new promotion**: show name, roster, gimmicks, titles, feuds and alliances, all generated fresh. Press `N` to start another; you can give it an optional direction such as *"ECW-style hardcore bingo-hall promotion with rabid fans"*. The direction is stored with the world and steers every episode. You can also open `/?new=1&direction=...`.

Without an API key, or if the proxy is down, the offline generator and booker keep the show going.

Keys: `space` pause · `1`–`4` speed (1/2/4/8x) · `d` debug panel · `f` fullscreen · `N` new promotion.

Headless preview (prints the play-by-play and saves `shows/ep-XXX.{md,json}` + `world.json`):

```bash
npm run preview -- --new --direction "ECW-style hardcore" --episodes 2   # new world + 2 episodes
npm run preview -- --episodes 3            # continue the saved world
npm run preview -- --new --classic         # the hand-written GPTWW roster
npm run preview -- --offline ...           # never call the API
npm run preview -- --new --cached          # reuse the latest stored promotion + episodes
```

**Nothing is generated twice.** Every LLM-created promotion and episode is stored under `sessions/<world seed>/`. An episode already booked for a world and episode number is replayed from disk instead of re-booked, for example after a page reload. Run `npm run server -- --cached` (or `npm run server --cached`) to make new worlds reuse the most recent stored promotion. Its stored episodes then replay for free, and generation only resumes past the end. Raw model output that needed repairs is saved to `sessions/failures/` for prompt tuning.

`npm test` runs the Vitest suite; `npm run typecheck` runs tsc.

## How it works

Three layers. The LLM decides **what** happens; the engine decides **how**.

0. **Genesis** (`src/world/genesis.ts`, `src/schema/promotion.ts`): one Claude call per new world creates the promotion. `reviewPromotion` sanitizes it (ids, finishers, champions) and assigns colors. `randomPromotion` is the offline equivalent.
1. **Booker** (`server/booker.ts`, `src/booker/`): one Claude call per episode. The model fills a `book_episode` tool with a flat list of beats split by `segment` markers (`EpisodeDraft`), which is converted into the nested `Episode` (`src/schema/episode.ts`). It contains segments of beats (`entrance`, `promo`, `interview`, `confrontation`, `attack`, `match`, `interrupt`, `run_in`, `reveal`, `turn`, `react`, `celebrate`, `exit`, `narrate`) plus state changes. `validate.ts` checks ids and booking rules; parsing is lenient: missing or invalid non-essential fields get defaults, stringified JSON is decoded, and broken beats are dropped individually. Only an unplayable result pays for a retry. The prompt includes the world state, recent history, an anti-repetition log and random weekly "booking directives". The default model is `claude-haiku-4-5` (cheap enough to run forever); set `BOOKER_MODEL` to change it.
2. **Choreographer** (`src/choreo/director.ts`): each beat type is a generator over actor primitives (`walkTo`, `goTo`, `say`, `narrate`, `playMove`…). Each beat has randomized realizations, and connective narration comes from `lines.ts`.
3. **Match sim** (`src/sim/match.ts`): picks moves by body state, style, phase and recency, with momentum, near-falls, heel cheating, and phases that steer to the booked finish. Match `spots` (interrupts, run-ins, distractions, ref bumps, weapons) are hooks back into the choreographer.

The **engine** (`src/engine/`) is a fixed-step 60 Hz clock with generator coroutines, so a seeded episode always produces the same event stream. Actors have continuous arena positions (`data/arena.json`) and a 3-part pose (head/upper/lower frames + rotation). Every move in `data/moves.json` carries attacker/defender keyframe tracks. Views subscribe to engine events and read actor state. The ASCII view (`src/view/map.ts`) is one such view; a sprite renderer can replace it without touching the engine.

The **world state** (`src/world/`) covers roster, alignments, titles (NWA rules: no title change on DQ/count-out), feuds, alliances, notes and history. It persists in localStorage in the browser and `world.json` for the CLI. The browser books episode N+1 while episode N airs.
