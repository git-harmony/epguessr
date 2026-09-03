/**
 * Per-episode accuracy tracking, kept across every game in localStorage.
 *
 * Rounds are recorded as they're answered rather than at the end of a game, so
 * quitting halfway still counts what you actually guessed. Keys are short
 * because this is one record per episode you've ever seen.
 */

const STATS_KEY = 'epguessr.stats.v1'

/** Stored per episode: a = attempts, d = total distance, x = exact guesses. */
const emptyRecord = (season, ep) => ({ a: 0, d: 0, x: 0, s: season, e: ep })

export const statKey = (animeId, season, ep) => `${animeId}:${season}:${ep}`

export function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY)) ?? {}
  } catch {
    return {}
  }
}

function persist(stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  } catch { /* private mode or full — tracking is best-effort, the game plays on */ }
  return stats
}

/**
 * @param {object} round
 * @param {string} round.animeId
 * @param {number} round.season
 * @param {number} round.ep
 * @param {number} round.distance  episodes between the guess and the answer
 * @param {string} [round.src]     frame shown, kept as a thumbnail for the table
 */
export function recordRound({ animeId, season, ep, distance, src }) {
  const stats = loadStats()
  const key = statKey(animeId, season, ep)
  const rec = stats[key] ?? emptyRecord(season, ep)
  rec.a += 1
  rec.d += distance
  if (distance === 0) rec.x += 1
  if (src) rec.src = src
  stats[key] = rec
  return persist(stats)
}

export function clearStats() {
  try {
    localStorage.removeItem(STATS_KEY)
  } catch { /* nothing to do */ }
  return {}
}

/**
 * Flatten the store into display rows, newest schema tolerated defensively so a
 * half-written record can't blank the page.
 */
export function statRows(stats, titles = {}) {
  return Object.entries(stats)
    .map(([key, rec]) => {
      const attempts = Number(rec?.a) || 0
      if (!attempts) return null
      const animeId = key.slice(0, key.indexOf(':'))
      return {
        key,
        animeId,
        title: titles[animeId] ?? animeId,
        season: rec.s,
        ep: rec.e,
        attempts,
        exact: Number(rec.x) || 0,
        avgDistance: (Number(rec.d) || 0) / attempts,
        exactRate: (Number(rec.x) || 0) / attempts,
        src: rec.src,
      }
    })
    .filter(Boolean)
}

/** Overall totals across every recorded round. */
export function statTotals(rows) {
  const attempts = rows.reduce((n, r) => n + r.attempts, 0)
  const exact = rows.reduce((n, r) => n + r.exact, 0)
  const distance = rows.reduce((n, r) => n + r.avgDistance * r.attempts, 0)
  return {
    episodes: rows.length,
    attempts,
    exact,
    exactRate: attempts ? exact / attempts : 0,
    avgDistance: attempts ? distance / attempts : 0,
  }
}

/**
 * Split the qualifying episodes into a worst-first and a best-first list.
 *
 * Taking the top N of two opposite sorts would repeat the middle rows when few
 * episodes qualify, so this sorts once and takes from each end — the two lists
 * can never share a row.
 */
export function splitRankings(rows, minAttempts = 2, limit = 10) {
  const sorted = rows
    .filter((r) => r.attempts >= minAttempts)
    .sort((a, b) => a.avgDistance - b.avgDistance || b.attempts - a.attempts)

  if (sorted.length < 2) return { best: sorted, worst: [], eligible: sorted.length }

  const n = Math.min(limit, Math.floor(sorted.length / 2))
  return {
    best: sorted.slice(0, n),
    worst: sorted.slice(sorted.length - n).reverse(),
    eligible: sorted.length,
  }
}
