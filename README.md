# Infinite Wrestling

**Never-ending generative pro wrestling.** An AI-booked wrestling TV show that runs itself like a screensaver. An LLM (Claude) books each weekly episode: promos, interviews, betrayals, reveals, run-ins and short matches. A deterministic engine stages it in a NetHack-style ASCII arena with timed play-by-play.

```
 ░░░▒░░^░░░░░░!░░░░░░░░░░░░░░░░░░^░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 ██······                  ▄▄▄▄▄▄▄          o═══════════════════════════o
 ██······                   i  @            ║··························║
 ██······──────────────────────────────     ║···@····r·················║
 ██···@···································  ║··········_···············║
 ENTRANCE                 INTERVIEW                     GPTWW
```

**Demo:** https://staudt.github.io/infinite-wrestling/ plays the shows in `library/` with no AI, using the offline booker after the stored episodes run out.

## Run it

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY to have Claude create and book the show
npm run server              # booker proxy on :8787 (keeps the key server-side)
npm run dev                 # open the printed URL
```

The first visit opens the **start screen** (press `N` any time to reopen it):

- **New live promotion**: Claude creates a promotion and books it as it airs. You can add an optional direction (era, style, the stars you want, match styles, factions, crowd) or start from a preset. The direction is saved with the world and steers every booking call.
- **Stored shows**: every show you watch live is saved and plays back from Season 1, Episode 1 for free. This works even with the booker server down. When a stored show runs out, new episodes are booked live and saved, extending it. With no connection, the offline booker takes over; those episodes aren't saved.
- **Continue** the current show.

The footer shows the connection: live (model names), server up without an API key, or not connected.

Keys: `space` pause · `1`–`4` speed (1/2/4/8x) · `d` debug panel · `f` fullscreen · `N` shows.

### Seasons

A season is 12 episodes. Episodes 4 and 8 are pay-per-views, and episode 12 is the season finale PPV that closes the year's feuds. At the start of each season, a stronger model (`BOOKER_PLAN_MODEL`, default `claude-sonnet-5`) writes a **season plan**: a theme, the three PPVs with their main events, and 3–5 long-term arcs with weekly beats and payoffs. Examples are the veteran's last run, the rookie who earns respect by losing, and the slow-burn betrayal. Each weekly prompt gets the plan and "where we are" (go-home shows, PPV nights, the finale).

Between seasons, an **off-season** call retires or releases a quarter to a third of the roster, vacates their titles, and brings in newcomers with full profiles. A season premiere opens with the announcer saying goodbye and welcoming the new faces.

### Match types

Every match has a stipulation, chosen by the booker:

- **singles**
- **tag**: 2 vs 2 with a legal man per team and partners on the apron. It has tags, the hot tag, heel double-teams, and partners breaking up pins. There are no tag titles yet.
- **steel cage**: the cage is drawn around the ring. No DQ and no floor fighting; you win by pin, submission, or climbing out ("escape").
- **ladder**: the prize hangs over the ring. Wrestlers pull a ladder from under the ring, set it up, climb, get tipped off, and swing it as a weapon; the only finish is grabbing the prize.
- **battle royal**: 5–12 wrestlers, eliminated over the top rope, and the last one left wins. The card shows eliminations live.

The booker is told to save cages and ladders for settling feuds at PPVs, and to use battle royals to push new talent. To preview one without waiting for a PPV, open `/?offline=1&demo=cage` (or `ladder`, `tag`, `royal`).

### Pre-generating and the library

```bash
npm run pregen -- --direction "80s Mid-South, a veteran's last run" --seasons 1   # book a season ahead (nothing airs)
npm run pregen -- --seed <seed> --seasons 1                                        # extend a stored show
npm run library                                                                    # list stored shows
npm run library -- add <seed>                                                      # copy a saved show into library/ to commit it
```

To publish a show to the demo, pregen it, `npm run library -- add <seed>`, commit `library/` and push. The GitHub Pages workflow (`.github/workflows/pages.yml`) builds the static site and bundles the library into it.

Saved shows live in `sessions/<seed>/` (git-ignored); curated shows live in `library/<seed>/` (committed). Both are read the same way, and a stored episode is always used before generating a new one. A season on Haiku (plus one Sonnet plan and one off-season call) costs roughly $0.40–0.50.

Headless preview (prints the play-by-play and saves `shows/ep-XXX.{md,json}` + `world.json`):

```bash
npm run preview -- --new --direction "ECW-style hardcore" --episodes 2
npm run preview -- --episodes 3            # continue the saved CLI world
npm run preview -- --new --classic         # the hand-written GPTWW roster
npm run preview -- --offline ...           # never call the API
```

Model output that needed repairs is saved to `sessions/failures/` for prompt tuning. `npm test` runs the Vitest suite; `npm run typecheck` runs tsc.

## How it works

Three layers. The LLM decides **what** happens; the engine decides **how**.

0. **Genesis** (`src/world/genesis.ts`, `src/schema/promotion.ts`): one Claude call per new world creates the promotion. `reviewPromotion` sanitizes it (ids, finishers, champions) and assigns colors. `randomPromotion` is the offline equivalent.
1. **Booker** (`server/booker.ts`, `src/booker/`): one Claude call per episode. The model fills a `book_episode` tool with a flat list of beats split by `segment` markers (`EpisodeDraft`), which is converted into the nested `Episode` (`src/schema/episode.ts`). It contains segments of beats (`entrance`, `promo`, `interview`, `confrontation`, `attack`, `match`, `interrupt`, `run_in`, `reveal`, `turn`, `react`, `celebrate`, `exit`, `narrate`) plus state changes. `validate.ts` checks ids and booking rules; parsing is lenient: missing or invalid non-essential fields get defaults, stringified JSON is decoded, and broken beats are dropped individually. Only an unplayable result pays for a retry. The prompt includes the world state, recent history, an anti-repetition log and random weekly "booking directives". The default model is `claude-haiku-4-5` (cheap enough to run forever); set `BOOKER_MODEL` to change it.
2. **Choreographer** (`src/choreo/director.ts`): each beat type is a generator over actor primitives (`walkTo`, `goTo`, `say`, `narrate`, `playMove`…). Each beat has randomized realizations, and connective narration comes from `lines.ts`.
3. **Match sim** (`src/sim/match.ts`): picks moves by body state, style, phase and recency, with momentum, near-falls, heel cheating, and phases that steer to the booked finish. Match `spots` (interrupts, run-ins, distractions, ref bumps, weapons) are hooks back into the choreographer.

The **engine** (`src/engine/`) is a fixed-step 60 Hz clock with generator coroutines, so a seeded episode always produces the same event stream. Actors have continuous arena positions (`data/arena.json`) and a 3-part pose (head/upper/lower frames + rotation). Every move in `data/moves.json` carries attacker/defender keyframe tracks. Views subscribe to engine events and read actor state. The ASCII view (`src/view/map.ts`) is one such view; a sprite renderer can replace it without touching the engine.

The **world state** (`src/world/`) covers roster, alignments, titles (NWA rules: no title change on DQ/count-out), feuds, alliances, notes and history. It persists in localStorage in the browser and `world.json` for the CLI. The browser books episode N+1 while episode N airs.
