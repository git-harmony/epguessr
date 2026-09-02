/* Pure game rules — no React, no DOM, so they're easy to reason about and test. */

export const ROUND_OPTIONS = [5, 10, 20]

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

/** Every (episode, frame) pair in a manifest, flattened into a draw pool. */
export function buildFramePool(anime) {
  const pool = []
  for (const episode of anime.episodes) {
    episode.frames.forEach((src, i) => {
      pool.push({ src, episode, time: episode.times?.[i] ?? null })
    })
  }
  return pool
}

/**
 * Draw `count` frames, avoiding repeats of the same episode until every episode
 * has been used once. Keeps a 10-round game from showing episode 3 four times.
 */
export function drawRounds(anime, count, rng = Math.random) {
  const pool = buildFramePool(anime)
  if (!pool.length) return []

  const byEpisode = new Map()
  for (const item of pool) {
    const key = item.episode.abs
    if (!byEpisode.has(key)) byEpisode.set(key, [])
    byEpisode.get(key).push(item)
  }

  const rounds = []
  let bag = []
  while (rounds.length < count) {
    if (!bag.length) bag = shuffle([...byEpisode.keys()], rng)
    const abs = bag.pop()
    const frames = byEpisode.get(abs)
    rounds.push(frames[Math.floor(rng() * frames.length)])
  }
  return rounds
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
 * The hint: a contiguous run of episodes guaranteed to contain the answer,
 * roughly a quarter of the series, positioned so the answer isn't always centred.
 */
export function hintWindow(answerAbs, episodeCount, rng = Math.random) {
  const size = Math.max(4, Math.min(episodeCount, Math.ceil(episodeCount * 0.25)))
  const offset = Math.floor(rng() * size)
  let start = answerAbs - offset
  start = Math.max(1, Math.min(start, episodeCount - size + 1))
  return { start, end: start + size - 1, size }
}

/* ------------------------------------------------------------ persistence */

const BEST_KEY = 'epguessr.best.v3'

export const bestKey = (animeId, rounds) => `${animeId}:${rounds}`

export function loadBests() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY)) ?? {}
  } catch {
    return {}
  }
}

export function saveBest(animeId, rounds, score) {
  const bests = loadBests()
  const key = bestKey(animeId, rounds)
  if (!(key in bests) || score > bests[key]) {
    bests[key] = score
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(bests))
    } catch { /* private mode, storage full — the game still plays */ }
    return true
  }
  return false
}
