#!/usr/bin/env node
/**
 * epguessr frame extractor
 *
 * Walks a folder of episode video files, grabs N well-spread frames from each,
 * writes them to public/frames/<id>/s01e01/N.jpg and records a manifest in
 * public/data/<id>.json so the game knows the ground-truth episode for every frame.
 *
 *   node tools/extract.mjs --input "D:/Anime/Frieren" --title "Frieren" --dry-run
 *   node tools/extract.mjs --input "D:/Anime/Frieren" --title "Frieren"
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ROOT, epTag, mergeManifest, slugify } from './lib/manifest.mjs'

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.webm', '.ts', '.mov', '.ogm'])

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.input || args.help) {
  console.log([
    '',
    'epguessr frame extractor',
    '',
    '  --input <dir>       folder holding the episode files (searched recursively)  [required]',
    '  --title <name>      display title (defaults to the input folder name)',
    '  --id <slug>         url-safe id (defaults to a slug of the title)',
    '  --frames <n>        frames to pull per episode                       [12]',
    '  --skip-intro <sec>  seconds to ignore at the start of each episode    [90]',
    '  --skip-outro <sec>  seconds to ignore at the end of each episode      [90]',
    '  --width <px>        output frame width, height auto                  [960]',
    '  --quality <2-31>    jpeg quality, lower is better                      [4]',
    '  --jobs <n>          parallel ffmpeg processes                          [4]',
    '  --no-blank-check    keep near-black / near-white frames instead of retrying',
    '  --dry-run           print the parsed episode list and exit',
    '  --force             re-extract episodes that already have frames',
    '',
  ].join('\n'))
  process.exit(args.help ? 0 : 1)
}

const CFG = {
  input: path.resolve(String(args.input)),
  frames: Number(args.frames ?? 12),
  skipIntro: Number(args['skip-intro'] ?? 90),
  skipOutro: Number(args['skip-outro'] ?? 90),
  width: Number(args.width ?? 960),
  quality: Number(args.quality ?? 4),
  jobs: Math.max(1, Number(args.jobs ?? 4)),
  blankCheck: !args['no-blank-check'],
  dryRun: !!args['dry-run'],
  force: !!args.force,
}
const TITLE = String(args.title ?? path.basename(CFG.input))
const ID = String(args.id ?? slugify(TITLE))

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function requireFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = await run(bin, ['-version'])
    if (r.code !== 0) {
      console.error([
        '',
        `  ${bin} was not found on PATH.`,
        '',
        '  Windows:  winget install Gyan.FFmpeg     (then reopen the terminal)',
        '  macOS:    brew install ffmpeg',
        '  Linux:    sudo apt install ffmpeg',
        '',
      ].join('\n'))
      process.exit(1)
    }
  }
}

/* ---------------------------------------------------------------- parsing */

// Ordered most-specific first; the first pattern that hits wins.
const EP_PATTERNS = [
  { re: /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i, season: 1, ep: 2 },
  { re: /\b(\d{1,2})x(\d{1,3})\b/i, season: 1, ep: 2 },
  { re: /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})\b/i, season: 1, ep: 2 },
  { re: /\bepisode[\s._-]*(\d{1,3})\b/i, ep: 1 },
  { re: /\bep[\s._-]*(\d{1,3})\b/i, ep: 1 },
  // fansub style: "[Group] Show - 07 [1080p]" — the dash-delimited number
  { re: /\s-\s*(\d{1,3})(?:v\d)?\s*(?:$|\.)/, ep: 1 },
  { re: /\s-\s*(\d{1,3})(?:v\d)?\s/, ep: 1 },
  { re: /\bE(\d{1,3})\b/, ep: 1 },
]

function seasonFromPath(filePath) {
  const parts = filePath.split(/[\\/]/)
  for (let i = parts.length - 2; i >= 0; i--) {
    const m = parts[i].match(/\b(?:season|series|s)[\s._-]*(\d{1,2})\b/i)
    if (m) return Number(m[1])
  }
  return null
}

function parseEpisode(filePath) {
  const name = path.basename(filePath, path.extname(filePath))
  // Strip bracketed groups and hashes so "[1080p]" / "[A1B2C3D4]" can't read as numbers.
  const cleaned = name.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  for (const pat of EP_PATTERNS) {
    for (const hay of [cleaned, name]) {
      const m = hay.match(pat.re)
      if (!m) continue
      const ep = Number(m[pat.ep])
      if (!Number.isFinite(ep)) continue
      const season = pat.season ? Number(m[pat.season]) : (seasonFromPath(filePath) ?? 1)
      return { season, ep }
    }
  }
  // last resort: the final standalone 1-3 digit number in the cleaned name
  const loose = [...cleaned.matchAll(/\b(\d{1,3})\b/g)].pop()
  if (loose) return { season: seasonFromPath(filePath) ?? 1, ep: Number(loose[1]) }
  return null
}

async function walk(dir, acc = []) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, acc)
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full)
  }
  return acc
}

/* ------------------------------------------------------------- extraction */

async function probeDuration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  const d = parseFloat(r.stdout.trim())
  return Number.isFinite(d) && d > 0 ? d : null
}

// Split the usable window into `count` buckets and jitter within each, so frames
// spread across the whole episode instead of clumping in one scene.
function pickTimestamps(duration, count, rng) {
  const start = Math.min(CFG.skipIntro, duration * 0.15)
  const end = Math.max(start + 1, duration - Math.min(CFG.skipOutro, duration * 0.15))
  const span = (end - start) / count
  return Array.from({ length: count }, (_, i) => start + span * (i + rng() * 0.92))
}

async function grabFrame(file, ts, outPath) {
  const r = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', ts.toFixed(3), '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${CFG.width}:-2:flags=lanczos`,
    '-q:v', String(CFG.quality),
    outPath,
  ])
  if (r.code !== 0) return false
  try { return (await fs.stat(outPath)).size > 1024 } catch { return false }
}

// Reject frames that are essentially a black or white card (scene transitions).
async function isBlank(imgPath) {
  const r = await run('ffmpeg', ['-hide_banner', '-i', imgPath, '-vf', 'signalstats,metadata=print', '-f', 'null', '-'])
  const m = r.stderr.match(/signalstats\.YAVG=([\d.]+)/)
  if (!m) return false
  const y = parseFloat(m[1])
  return y < 22 || y > 242
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }))
  return results
}

// Deterministic per-episode RNG so re-runs pick a stable spread.
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const byNum = (a, b) => parseInt(a, 10) - parseInt(b, 10)
const fmtDur = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`

async function extractEpisode(entry) {
  const { season, ep, file } = entry
  const tag = epTag(season, ep)
  const outDir = path.join(ROOT, 'public', 'frames', ID, tag)

  if (!CFG.force) {
    try {
      const existing = (await fs.readdir(outDir)).filter((f) => f.endsWith('.jpg'))
      if (existing.length >= CFG.frames) {
        console.log(`  ${tag}  skip (${existing.length} frames already)`)
        return { season, ep, frames: existing.sort(byNum).map((f) => `frames/${ID}/${tag}/${f}`), times: [] }
      }
    } catch { /* not extracted yet */ }
  }

  const duration = await probeDuration(file)
  if (!duration) {
    console.log(`  ${tag}  FAILED to probe ${path.basename(file)}`)
    return null
  }

  await fs.mkdir(outDir, { recursive: true })
  const rng = mulberry32(season * 1000 + ep)
  const stamps = pickTimestamps(duration, CFG.frames, rng)

  const got = []
  for (let i = 0; i < stamps.length; i++) {
    const out = path.join(outDir, `${i}.jpg`)
    let kept = null
    for (let attempt = 0; attempt < 4 && !kept; attempt++) {
      const t = attempt === 0
        ? stamps[i]
        : Math.max(1, Math.min(duration - 2, stamps[i] + (rng() - 0.5) * Math.min(60, duration * 0.08)))
      if (!(await grabFrame(file, t, out))) continue
      if (CFG.blankCheck && (await isBlank(out))) continue
      kept = { rel: `frames/${ID}/${tag}/${i}.jpg`, t }
    }
    if (kept) got.push(kept)
    else { try { await fs.unlink(out) } catch { /* nothing written */ } }
  }

  console.log(`  ${tag}  ${got.length}/${CFG.frames} frames  (${fmtDur(duration)})  ${path.basename(file)}`)
  if (!got.length) return null
  return { season, ep, frames: got.map((g) => g.rel), times: got.map((g) => Math.round(g.t)) }
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!CFG.dryRun) await requireFfmpeg()

  const files = await walk(CFG.input)
  if (!files.length) {
    console.error(`No video files found under ${CFG.input}`)
    process.exit(1)
  }

  // Parse, then dedupe (season, ep) keeping the largest file — drops samples and NCOPs.
  const byKey = new Map()
  const unparsed = []
  for (const file of files) {
    const parsed = parseEpisode(file)
    if (!parsed) { unparsed.push(file); continue }
    const key = `${parsed.season}:${parsed.ep}`
    const size = (await fs.stat(file)).size
    const prev = byKey.get(key)
    if (!prev || size > prev.size) byKey.set(key, { ...parsed, file, size })
  }

  const entries = [...byKey.values()].sort((a, b) => a.season - b.season || a.ep - b.ep)
  console.log(`\n${TITLE}  (id: ${ID})`)
  console.log(`${entries.length} episodes parsed from ${files.length} files${unparsed.length ? `, ${unparsed.length} unrecognised` : ''}\n`)
  for (const e of entries) {
    console.log(`  S${String(e.season).padStart(2, '0')}E${String(e.ep).padStart(2, '0')}  ${path.basename(e.file)}`)
  }
  if (unparsed.length) {
    console.log(`\n  no episode number found in:`)
    for (const f of unparsed) console.log(`    ${path.basename(f)}`)
  }

  if (CFG.dryRun) {
    console.log('\n(dry run — nothing extracted)\n')
    return
  }

  console.log(`\nExtracting ${CFG.frames} frames per episode, ${CFG.jobs} parallel jobs...\n`)
  const done = (await pool(entries, CFG.jobs, extractEpisode)).filter(Boolean)
  done.sort((a, b) => a.season - b.season || a.ep - b.ep)
  if (!done.length) {
    console.error('Nothing extracted.')
    process.exit(1)
  }

  const manifest = await mergeManifest({ id: ID, title: TITLE, episodes: done })

  console.log(`
Done. ${manifest.frameCount} frames across ${done.length} episodes -> public/frames/${ID}/`)
  console.log(`Manifest: public/data/${ID}.json
`)
}

main().catch((e) => { console.error(e); process.exit(1) })
