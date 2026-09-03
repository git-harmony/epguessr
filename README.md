# epguessr

Pick an anime, get one random frame from one random episode, guess which episode it came from.
Closer guesses score partial credit. Static site — no server, no backend.

```
npm install
npm run demo      # writes a synthetic "Demo Show" pack so there's something to play
npm run dev
```

## Getting real frames in

There is no public API that hands out random anime frames labelled with episode numbers
(trace.moe does the reverse: image → episode). So frames are baked ahead of time into a **frame
pack** — a folder of jpgs plus a manifest — which the site serves as plain static files.

Two ways to build one, depending on what you have:

| You have | Tool |
|---|---|
| Screenshots you captured while watching | `npm run import` |
| Episode video files | `npm run extract` |

## From screenshots — `npm run import`

Point it at a folder of per-episode zips (or per-episode subfolders) of images:

```
npm run import -- --input "D:/epguesser - rezero" --title "Re:Zero" --id rezero --dry-run
```

It reads season and episode from each zip/folder name — `2x11.zip`, `S02E11`, `ep 7.zip`, `7` —
and the timestamp from each image name (`artplayer_12_34.png` → 12:34). A folder that contains
zips is treated as a season container, so a layout like this works in one pass:

```
D:/epguesser - rezero/
  szn 1/   1.zip, ep 2.zip, ...      season from the folder name
  szn 2/   2x1.zip, 2x2.zip, ...     season from the file name
```

Names that carry their own season win; otherwise the folder name supplies it, falling back to
`--season`. The dry run prints the full `S01E01` mapping and warns if two sources collide.

Screenshots at the same second are treated as the same moment and deduped. `--max` thins what's
left down to an even spread across the episode, which is how you keep the pack hostable:

```
npm run import -- --input "D:/epguesser - rezero" --title "Re:Zero" --id rezero --max 50
```

At the defaults (960px, q80 mozjpeg) frames land around **60 KB each**, so 50 per episode over a
25-episode season is roughly 75 MB. `--season` tags everything with a season number if you're
importing one season at a time.

Conversion uses `sharp`, so no ffmpeg needed for this path.

## From video files — `npm run extract`

This path needs ffmpeg:

```
winget install Gyan.FFmpeg     # Windows — reopen the terminal afterwards
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Linux
```

Then dry-run against a folder of episodes to check the filename parsing:

```
npm run extract -- --input "D:/Anime/Frieren" --title "Frieren: Beyond Journey's End" --dry-run
```

It prints what it read out of each filename:

```
  S01E01  Frieren - 01 [1080p].mkv
  S01E02  Frieren - 02 [1080p].mkv
  ...
```

If the numbers line up, drop `--dry-run` and let it work:

```
npm run extract -- --input "D:/Anime/Frieren" --title "Frieren: Beyond Journey's End"
```

Repeat per anime. Each run adds an entry to `public/data/index.json`; the site picks it up on
next load. Re-running against a folder that gained episodes merges them in rather than starting
over.

### What the extractor does

- Recognises `S01E02`, `1x02`, `Episode 02`, `Ep02`, and fansub `- 07` naming; falls back to a
  `Season N` parent folder for the season number.
- Dedupes `(season, episode)` by keeping the largest file, which drops samples and NCOP/NCEDs.
- Spreads frames across the episode instead of clumping — the runtime is split into N buckets
  with one jittered pick each.
- Skips the first and last 90s by default so you don't get an OP/ED frame every round
  (`--skip-intro` / `--skip-outro`).
- Re-rolls near-black and near-white frames (scene transitions), up to 4 attempts per slot.
- Skips episodes that already have frames unless you pass `--force`.

`--help` lists every flag.

### Pack size

Rough guide at the defaults (12 frames/ep, 960px wide, q4): about **1.5 MB per episode**, so a
24-episode season lands near 35 MB. Turn `--frames` down or `--quality` up (higher = smaller) if
you're squeezing under a host's limit.

## Hosting

`npm run build` emits a fully static `dist/`. `base` is `'./'`, so it works from a subpath too.

| Host | Command | Notes |
|---|---|---|
| Vercel | `npx vercel --prod` | build `npm run build`, output `dist` |
| Netlify | `npx netlify deploy --prod --dir dist` | |
| Cloudflare Pages | `npx wrangler pages deploy dist` | 25 MB per-file cap, 20k files per deploy |
| GitHub Pages | push `dist/` to `gh-pages` | soft 1 GB repo limit — watch pack sizes |

Frame packs live under `public/`, so they're copied into `dist/` and deployed as ordinary files.
`.gitignore` currently excludes `public/frames/` and `public/data/` — if you want the packs to
ride along in git rather than being rebuilt per machine, drop those lines.

## Scoring

| Distance | Points |
|---|---|
| exact | 1000 |
| 1 off | 500 |
| 2 off | 250 |
| 3 off | 100 |
| 4+ off | 0 |

Consecutive exact guesses add +100 each, up to +500. The "narrow it down" hint dims all but a
quarter of the episode list and halves the round's base points. Distance is measured in absolute
episode index across the whole series, so guessing S02E01 when the answer is S01E12 is 1 off.

### Picking a game

Opening an anime shows a setup screen: how many rounds, and which seasons to play. Seasons are a
multi-select, so you can play just season 3, or seasons 2 and 4 together, or the lot. Only the
chosen seasons are dealt and only they appear in the guess grid.

Distance is still measured in absolute episode index across the whole series, so a cross-season
guess between non-adjacent selections scores zero rather than accidental partial credit. When one
season is in play the labels drop the redundant season half and read "Episode 12".

Past 40 episodes in play the layout switches to a denser grid and a smaller frame, so the whole
grid still fits on screen instead of pushing later seasons below the fold.

### Endless

The **∞** round option runs until you miss. Anything within 3 episodes keeps you alive; a guess
4 or more off ends the run. Rounds are dealt lazily rather than pre-drawn, so a run can go as
long as you survive, and the same no-repeat-until-exhausted rule still applies — you won't see
the same episode twice until every episode has come up.

Best score per (anime, season selection, round count) is kept in `localStorage` — a season-3-only
run doesn't compete with an all-seasons run, and endless is tracked separately from the
fixed-length games.

## Statistics

The **Statistics** button in the top right of the library screen tracks per-episode accuracy across every game
you've ever played — all animes, all seasons, all round lengths pooled together.

Rounds are recorded as they're answered rather than at the end of a game, so quitting halfway
still counts what you actually guessed. Each episode keeps attempts, total distance, exact count
and the last frame shown as a thumbnail.

Two rankings, by average distance: **worst known** (highest average miss) and **best known**
(lowest). Both come from one sorted list split at each end, so an episode can never appear in
both — taking the top N of two opposite sorts would repeat the middle rows whenever few episodes
qualify.

The minimum-guesses threshold filters out episodes seen too few times to mean anything; a single
unlucky guess shouldn't crown an episode your worst. Default is 2+.

Stored in `localStorage` under `epguessr.stats.v1`, separate from high scores, and resettable
from the page without touching them.

## Layout

```
src/game.js               scoring, frame draw, hint window — pure functions
src/stats.js              per-episode accuracy tracking and rankings
src/App.jsx               menu, setup, round loop, reveal, summary, statistics
tools/import-images.mjs   screenshot importer (zips/folders of stills)
tools/extract.mjs         ffmpeg frame extractor (video files)
tools/lib/manifest.mjs    manifest merge/write shared by the tools
tools/make-demo.mjs       synthetic pack for testing the UI
public/data/              one manifest per anime + index.json
public/frames/            the jpgs
```

### Manifest shape

```json
{
  "id": "frieren", "title": "Frieren", "episodeCount": 28,
  "seasons": [1], "frameCount": 336,
  "cover": "frames/frieren/s01e14/0.jpg",
  "episodes": [
    { "season": 1, "ep": 1, "abs": 1,
      "frames": ["frames/frieren/s01e01/0.jpg"], "times": [412] }
  ]
}
```

The frames the game shows are picked from the manifest, and the manifest records which episode
each frame came from — that's where the ground truth lives, so mis-parsed filenames become wrong
answers. The dry run exists for exactly that reason.
