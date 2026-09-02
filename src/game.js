/* Pure game rules — no React, no DOM, so they're easy to reason about and test. */

export const ENDLESS = 'endless'
export const ROUND_OPTIONS = [5, 10, 20, ENDLESS]

/** Misses allowed in endless before the run ends. */
export const ENDLESS_LIVES = 1

export const isEndless = (rounds) => rounds === ENDLESS

/** A guess this far off (or worse) costs a life in endless. */
export const isMiss = (distance) => distance > MAX_PARTIAL_DISTANCE

// Points by how many episodes off the guess was. Index === distance.
const DISTANCE_POINTS = [1000, 500, 250, 100]
export const MAX_PARTIAL_DISTANCE = DISTANCE_POINTS.length - 1

const HINT_MULTIPLIER = 0.5
const STREAK_BONUS = 100
const MAX_STREAK_BONUS_STEPS = 5

export function pointsForDistance(distance) {
  return DISTANCE_POINTS[distance] ?? 0
}

/**
 * @param {number} distance  episodes between the guess and the answer
 * @param {boolean} usedHint whether the narrow-down hint was spent this round
 * @param {number} streak    exact guesses in a row *before* this one
 */
export function scoreRound(distance, usedHint, streak) {
  const base = pointsForDistance(distance)
  const afterHint = usedHint ? Math.round(base * HINT_MULTIPLIER) : base
  const bonus = distance === 0 ? STREAK_BONUS * Math.min(streak, MAX_STREAK_BONUS_STEPS) : 0
  return { base, points: afterHint + bonus, bonus, usedHint }
}

export function verdictFor(distance) {
  if (distance === 0) return { label: 'Exact', tone: 'exact' }
  if (distance <= MAX_PARTIAL_DISTANCE) {
    return { label: `${distance} episode${distance === 1 ? '' : 's'} off`, tone: 'close' }
  }
  return { label: `${distance} episodes off`, tone: 'miss' }
}

// Spelled out rather than S02E05 — the season half is only worth saying when
// the series actually has more than one.
export const epLabel = (e, multiSeason = true) =>
  (multiSeason ? `Season ${e.season}, Episode ${e.ep}` : `Episode ${e.ep}`)

/**
 * Every (episode, frame) pair in a manifest, flattened into a draw pool.
 * `seasons` limits it to a subset; null/undefined means the whole series.
 */
export function buildFramePool(anime, seasons = null) {
  const allowed = seasons ? new Set(seasons) : null
  const pool = []
  for (const episode of anime.episodes) {
    if (allowed && !allowed.has(episode.season)) continue
    episode.frames.forEach((src, i) => {
      pool.push({ src, episode, time: episode.times?.[i] ?? null })
    })
  }
  return pool
}

/** Episodes in play for a season selection, in running order. */
export function playableEpisodes(anime, seasons = null) {
  const allowed = seasons ? new Set(seasons) : null
  return anime.episodes.filter((e) => !allowed || allowed.has(e.season))
}

/**
 * Deals frames one at a time, avoiding repeats of the same episode until every
 * episode has been used once. Lazy rather than pre-drawn so endless runs can go
 * as long as the player survives.
 */
export function createDealer(anime, seasons = null, rng = Math.random) {
  const byEpisode = new Map()
  for (const item of buildFramePool(anime, seasons)) {
    const key = item.episode.abs
    if (!byEpisode.has(key)) byEpisode.set(key, [])
    byEpisode.get(key).push(item)
  }

  let bag = []
  return {
    empty: byEpisode.size === 0,
    next() {
      if (!byEpisode.size) return null
      if (!bag.length) bag = shuffle([...byEpisode.keys()], rng)
      const frames = byEpisode.get(bag.pop())
      return frames[Math.floor(rng() * frames.length)]
    },
  }
}

export function shuffle(arr, rng = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * The hint: a contiguous run of the episodes actually in play, guaranteed to
 * contain the answer, roughly a quarter of them, positioned so the answer isn't
 * always dead centre.
 */
export function hintWindow(answerAbs, inPlay, rng = Math.random) {
  const idx = inPlay.findIndex((e) => e.abs === answerAbs)
  if (idx < 0) return null
  const size = Math.max(4, Math.min(inPlay.length, Math.ceil(inPlay.length * 0.25)))
  const offset = Math.floor(rng() * size)
  const start = Math.max(0, Math.min(idx - offset, inPlay.length - size))
  const slice = inPlay.slice(start, start + size)
  return {
    allowed: new Set(slice.map((e) => e.abs)),
    first: slice[0],
    last: slice[slice.length - 1],
    size: slice.length,
  }
}

/* ------------------------------------------------------------ persistence */

const BEST_KEY = 'epguessr.best.v3'

/** Stable label for a season selection, so bests don't mix across configs. */
export function seasonsKey(seasons, allSeasons) {
  if (!seasons || seasons.length === allSeasons.length) return 'all'
  return [...seasons].sort((a, b) => a - b).join('+')
}

export const bestKey = (animeId, seasonsLabel, rounds) => `${animeId}:${seasonsLabel}:${rounds}`

export function loadBests() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY)) ?? {}
  } catch {
    return {}
  }
}

export function saveBest(animeId, seasonsLabel, rounds, score) {
  const bests = loadBests()
  const key = bestKey(animeId, seasonsLabel, rounds)
  if (!(key in bests) || score > bests[key]) {
    bests[key] = score
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(bests))
    } catch { /* private mode, storage full — the game still plays */ }
    return true
  }
  return false
}
