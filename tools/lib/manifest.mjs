/**
 * Shared manifest read/merge/write.
 *
 * One anime = one manifest at public/data/<id>.json. Merging rather than
 * overwriting means a second extractor run can add episodes without discarding
 * the ones already there.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DATA_DIR = path.join(ROOT, 'public', 'data')

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

export const epTag = (season, ep) =>
  `s${String(season).padStart(2, '0')}e${String(ep).padStart(2, '0')}`

/** Season 0 holds OVAs/specials, which belong after the numbered seasons. */
export const OVA_SEASON = 0
const seasonRank = (season) => (season === OVA_SEASON ? Infinity : season)
export const bySeasonThenEp = (a, b) =>
  seasonRank(a.season) - seasonRank(b.season) || a.ep - b.ep

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Merge a batch of episodes into <id>.json and refresh index.json.
 *
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.title
 * @param {Array}  opts.episodes  [{ season, ep, frames, times }]
 */
export async function mergeManifest({ id, title, episodes }) {
  const manifestPath = path.join(DATA_DIR, `${id}.json`)
  const existing = await readJson(manifestPath, null)

  const byKey = new Map()
  for (const e of existing?.episodes ?? []) byKey.set(`${e.season}:${e.ep}`, { ...e })

  for (const incoming of episodes) {
    const key = `${incoming.season}:${incoming.ep}`
    const prev = byKey.get(key)
    const frames = incoming.frames ?? []
    const times = incoming.times ?? []
    byKey.set(key, {
      season: incoming.season,
      ep: incoming.ep,
      // Named entries (OVAs) carry a title; numbered episodes don't need one.
      ...(incoming.title || prev?.title ? { title: incoming.title ?? prev.title } : {}),
      frames,
      // A skipped re-run reports no timestamps; don't drop the ones we already had.
      times: times.length ? times : (prev?.times?.length === frames.length ? prev.times : []),
    })
  }

  const ordered = [...byKey.values()]
    .filter((e) => e.frames.length)
    .sort(bySeasonThenEp)
    .map((e, i) => ({ ...e, abs: i + 1 }))

  if (!ordered.length) throw new Error('nothing to write — no frames')

  const frameCount = ordered.reduce((n, e) => n + e.frames.length, 0)
  const manifest = {
    id,
    title: title || existing?.title || id,
    episodeCount: ordered.length,
    seasons: [...new Set(ordered.map((e) => e.season))].sort(
      (a, b) => seasonRank(a) - seasonRank(b),
    ),
    frameCount,
    // Mid-series so the card art isn't always episode 1.
    cover: ordered[Math.floor(ordered.length / 2)].frames[0],
    episodes: ordered,
  }

  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify(manifest))

  const indexPath = path.join(DATA_DIR, 'index.json')
  const index = await readJson(indexPath, { animes: [] })
  index.animes = index.animes.filter((a) => a.id !== id)
  index.animes.push({
    id,
    title: manifest.title,
    cover: manifest.cover,
    episodeCount: manifest.episodeCount,
    seasons: manifest.seasons,
    frameCount,
  })
  index.animes.sort((a, b) => a.title.localeCompare(b.title))
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2))

  return manifest
}
