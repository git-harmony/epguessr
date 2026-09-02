#!/usr/bin/env node
/**
 * Generates a synthetic "Demo Show" frame pack so the game is playable before
 * you've run the real extractor. Every frame is a drawn SVG, not video — it
 * exists to exercise the UI, not to be a fun round.
 *
 *   node tools/make-demo.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, epTag, mergeManifest } from './lib/manifest.mjs'

const ID = 'demo-show'
const SEASONS = [
  { season: 1, episodes: 12 },
  { season: 2, episodes: 12 },
]
const FRAMES_PER_EP = 4

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function frameSvg(season, ep, i) {
  const rng = mulberry32(season * 10000 + ep * 100 + i)
  const hue = (season * 137 + ep * 29 + i * 7) % 360
  const shapes = Array.from({ length: 7 }, () => {
    const x = rng() * 960
    const y = rng() * 540
    const r = 30 + rng() * 130
    const h = (hue + rng() * 90 - 45 + 360) % 360
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${h.toFixed(0)} 70% 55%)" opacity="0.35"/>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 12%)"/>
</linearGradient></defs>
<rect width="960" height="540" fill="url(#g)"/>${shapes}
<text x="480" y="292" font-family="system-ui, sans-serif" font-size="150" font-weight="800" fill="#fff" opacity="0.1" text-anchor="middle">DEMO</text>
</svg>`
}

async function main() {
  const episodes = []

  for (const { season, episodes: count } of SEASONS) {
    for (let ep = 1; ep <= count; ep++) {
      const tag = epTag(season, ep)
      const dir = path.join(ROOT, 'public', 'frames', ID, tag)
      await fs.mkdir(dir, { recursive: true })

      const frames = []
      const times = []
      for (let i = 0; i < FRAMES_PER_EP; i++) {
        await fs.writeFile(path.join(dir, `${i}.svg`), frameSvg(season, ep, i))
        frames.push(`frames/${ID}/${tag}/${i}.svg`)
        times.push(120 + i * 300)
      }
      episodes.push({ season, ep, frames, times })
    }
  }

  const manifest = await mergeManifest({ id: ID, title: 'Demo Show', episodes })
  console.log(`Demo pack written: ${manifest.episodeCount} episodes, ${manifest.frameCount} frames.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
