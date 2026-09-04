#!/usr/bin/env node
/**
 * epguessr screenshot importer
 *
 * For frames you already captured rather than video you need to decode. Takes a
 * folder of per-episode zips (or per-episode subfolders) of screenshots, reads the
 * timestamp out of each filename, and bakes them into a frame pack.
 *
 * Expects episode number in the zip/folder name ("ep 7.zip", "7", "Episode 07")
 * and a timestamp in the image name (artplayer_12_34.png -> 12:34).
 *
 *   node tools/import-images.mjs --input "D:/epguesser - rezero" --title "Re:Zero" --dry-run
 *   node tools/import-images.mjs --input "D:/epguesser - rezero" --title "Re:Zero"
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import { OVA_SEASON, ROOT, bySeasonThenEp, epTag, mergeManifest, slugify } from './lib/manifest.mjs'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

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
    'epguessr screenshot importer',
    '',
    '  --input <dir>    folder of per-episode zips or subfolders            [required]',
    '  --title <name>   display title (defaults to the input folder name)',
    '  --id <slug>      url-safe id (defaults to a slug of the title)',
    '  --season <n>     season for names that do not carry one (2x11 already does)  [1]',
    `  --ova            shorthand for --season ${OVA_SEASON}; named entries land in the OVA group`,
    '  --max <n>        cap frames per episode, spread evenly by timestamp  [all]',
    '  --skip-intro <s> drop frames before this timestamp                          [0]',
    '  --skip-outro <s> drop frames within this many seconds of the episode end   [90]',
    '  --width <px>     output width, height auto                              [960]',
    '  --quality <1-100> jpeg quality                                            [80]',
    '  --jobs <n>       parallel conversions                                      [8]',
    '  --keep-extracted  leave the unzipped files behind instead of cleaning up',
    '  --dry-run        list what it found and exit',
    '  --force          re-import episodes that already have frames',
    '',
  ].join('\n'))
  process.exit(args.help ? 0 : 1)
}

const CFG = {
  input: path.resolve(String(args.input)),
  season: args.ova ? OVA_SEASON : Number(args.season ?? 1),
  max: args.max ? Number(args.max) : 0,
  skipIntro: Number(args['skip-intro'] ?? 0),
  skipOutro: Number(args['skip-outro'] ?? 90),
  width: Number(args.width ?? 960),
  quality: Number(args.quality ?? 80),
  jobs: Math.max(1, Number(args.jobs ?? 8)),
  keepExtracted: !!args['keep-extracted'],
  dryRun: !!args['dry-run'],
  force: !!args.force,
}
const TITLE = String(args.title ?? path.basename(CFG.input))
const ID = String(args.id ?? slugify(TITLE))

/* ---------------------------------------------------------------- parsing */

/**
 * "2x11.zip" -> season 2 episode 11, "ep 7.zip" -> episode 7 (season from --season).
 * Season-bearing patterns come first so "2x1" isn't read as episode 2.
 */
function parseSourceEpisode(name) {
  const base = name.replace(/\.zip$/i, '').trim()

  const withSeason =
    base.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i) ??
    base.match(/\b(\d{1,2})[xX](\d{1,3})\b/)
  if (withSeason) return { season: Number(withSeason[1]), ep: Number(withSeason[2]) }

  const epOnly =
    base.match(/\bep(?:isode)?[\s._-]*(\d{1,3})\b/i) ??
    base.match(/\bE(\d{1,3})\b/) ??
    base.match(/(\d{1,3})/)
  return epOnly ? { season: null, ep: Number(epOnly[1]) } : null
}

/** "szn 2" / "Season 02" / "S2" -> 2; an "ovas"/"specials" folder -> the OVA group. */
function parseFolderSeason(name) {
  if (/\b(ovas?|specials?|extras?)\b/i.test(name)) return OVA_SEASON
  const m = name.match(/\b(?:szn|season|series|s)[\s._-]*(\d{1,2})\b/i)
  return m ? Number(m[1]) : null
}

/**
 * "Memory snow ova.zip" -> "Memory Snow". Used for entries that carry a name
 * instead of an episode number, so the game can label them properly.
 */
function cleanTitle(name) {
  return name
    .replace(/\.zip$/i, '')
    .replace(/[._]+/g, ' ')
    // Drop a standalone "ova"/"ovas" token; a word merely containing it survives.
    .replace(/\bovas?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** A folder holding zips is a season container, not an episode. */
async function holdsZips(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'))
  } catch {
    return false
  }
}

/** "artplayer_12_34.png" -> 754 seconds. Also accepts 1_02_03 as h_m_s. */
function parseTimestamp(fileName) {
  const base = path.basename(fileName, path.extname(fileName))
  const parts = base.match(/(\d{1,2})[_:-](\d{1,2})(?:[_:-](\d{1,2}))?/)
  if (!parts) return null
  const a = Number(parts[1])
  const b = Number(parts[2])
  const c = parts[3] === undefined ? null : Number(parts[3])
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c
}

/* -------------------------------------------------------------- unzipping */

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', (e) => resolve({ code: -1, stderr: String(e) }))
    p.on('close', (code) => resolve({ code, stderr }))
  })
}

// PowerShell ships with Windows, so no unzip binary is assumed.
async function unzip(zipPath, destDir) {
  await fs.mkdir(destDir, { recursive: true })
  const r = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
  ])
  if (r.code === 0) return true
  const alt = await run('unzip', ['-qo', zipPath, '-d', destDir])
  return alt.code === 0
}

async function collectImages(dir, acc = []) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await collectImages(full, acc)
    else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full)
  }
  return acc
}

/* ------------------------------------------------------------- conversion */

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

/** Thin an oversized list down to `max`, keeping an even spread across the episode. */
function thin(list, max) {
  if (!max || list.length <= max) return list
  const step = list.length / max
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)])
}

/* ------------------------------------------------------------------- main */

async function main() {
  const sources = []

  // A folder of zips is a season container: descend into it and let its name
  // supply the season for any zip whose own name omits one ("szn 1/ep 4.zip").
  async function collect(dir, inherited) {
    let children
    try { children = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of children) {
      const full = path.join(dir, e.name)
      const isZip = e.isFile() && e.name.toLowerCase().endsWith('.zip')
      if (e.isDirectory() && (await holdsZips(full))) {
        await collect(full, parseFolderSeason(e.name) ?? inherited)
        continue
      }
      if (!isZip && !e.isDirectory()) continue
      // No number in the name means a named entry (an OVA); it gets numbered below.
      const parsed = parseSourceEpisode(e.name)
      sources.push({
        season: parsed?.season ?? inherited ?? CFG.season,
        ep: parsed?.ep ?? null,
        title: parsed ? undefined : cleanTitle(e.name),
        name: e.name,
        isZip,
        full,
      })
    }
  }

  await collect(CFG.input, parseFolderSeason(path.basename(CFG.input)))

  // Named entries get sequential numbers per season, after any numbered ones,
  // so "Memory Snow" and "Frozen Bond" become OVA 1 and 2 in name order.
  const named = sources.filter((s) => s.ep === null)
  if (named.length) {
    const highest = new Map()
    for (const s of sources) {
      if (s.ep === null) continue
      highest.set(s.season, Math.max(highest.get(s.season) ?? 0, s.ep))
    }
    named.sort((a, b) => a.title.localeCompare(b.title))
    for (const s of named) {
      const next = (highest.get(s.season) ?? 0) + 1
      highest.set(s.season, next)
      s.ep = next
    }
  }
  sources.sort(bySeasonThenEp)

  if (!sources.length) {
    console.error(`\n  No per-episode zips or folders found in ${CFG.input}\n`)
    process.exit(1)
  }

  const key = (x) => `${x.season}:${x.ep}`
  const dupes = sources.filter((s, i) => sources.findIndex((o) => key(o) === key(s)) !== i)
  console.log(`\n${TITLE}  (id: ${ID})`)
  console.log(`${sources.length} episodes found\n`)
  for (const s of sources) {
    console.log(`  ${epTagOf(s)}  ${s.name}${s.title ? `  -> "${s.title}"` : ''}`)
  }
  if (dupes.length) {
    console.log(`\n  WARNING: more than one source maps to ${[...new Set(dupes.map(epTagOf))].join(', ')}`)
  }

  if (CFG.dryRun) {
    console.log('\n(dry run — nothing imported)\n')
    return
  }

  const workRoot = path.join(os.tmpdir(), `epguessr-${ID}-${Date.now()}`)
  const cleanup = []
  console.log(`\nImporting at ${CFG.width}px q${CFG.quality}${CFG.max ? `, max ${CFG.max}/episode` : ''}...\n`)

  const done = []
  for (const src of sources) {
    const tag = epTag(src.season, src.ep)
    const outDir = path.join(ROOT, 'public', 'frames', ID, tag)

    if (!CFG.force) {
      try {
        const have = (await fs.readdir(outDir)).filter((f) => f.endsWith('.jpg'))
        if (have.length) {
          console.log(`  ${tag}  skip (${have.length} frames already)`)
          done.push({
            season: src.season,
            ep: src.ep,
            title: src.title,
            frames: have.sort(byNum).map((f) => `frames/${ID}/${tag}/${f}`),
            times: [],
          })
          continue
        }
      } catch { /* not imported yet */ }
    }

    let imageDir = src.full
    if (src.isZip) {
      imageDir = path.join(workRoot, epTag(src.season, src.ep))
      if (!(await unzip(src.full, imageDir))) {
        console.log(`  ${tag}  FAILED to unzip ${src.name}`)
        continue
      }
      cleanup.push(imageDir)
    }

    const files = await collectImages(imageDir)
    // Two screenshots at the same second are the same moment — keep one.
    const byTime = new Map()
    for (const f of files) {
      const t = parseTimestamp(f)
      if (t === null) continue
      if (!byTime.has(t)) byTime.set(t, f)
    }
    const sorted = [...byTime.entries()].sort((a, b) => a[0] - b[0])
    // Credit-roll frames look the same in every episode, so drop the tail. "The end"
    // is the last screenshot taken, since stills don't tell us the real runtime.
    const lastAt = sorted.length ? sorted[sorted.length - 1][0] : 0
    const kept = sorted.filter(([t]) => t >= CFG.skipIntro && t <= lastAt - CFG.skipOutro)
    const inRange = kept.length ? kept : sorted
    const picked = thin(inRange, CFG.max)
    if (!picked.length) {
      console.log(`  ${tag}  no timestamped images in ${src.name}`)
      continue
    }
    const trimmedEnds = sorted.length - inRange.length

    await fs.rm(outDir, { recursive: true, force: true })
    await fs.mkdir(outDir, { recursive: true })

    const saved = await pool(picked, CFG.jobs, async ([time, file], i) => {
      try {
        await sharp(file)
          .resize({ width: CFG.width, withoutEnlargement: true })
          .jpeg({ quality: CFG.quality, mozjpeg: true })
          .toFile(path.join(outDir, `${i}.jpg`))
        return { rel: `frames/${ID}/${tag}/${i}.jpg`, time }
      } catch {
        return null
      }
    })

    const ok = saved.filter(Boolean)
    const dupes = files.length - sorted.length
    console.log(
      `  ${tag}  ${ok.length} frames` +
      `${dupes > 0 ? `  -${dupes} dup` : ''}` +
      `${trimmedEnds > 0 ? `  -${trimmedEnds} credits` : ''}` +
      `  ${src.name}`,
    )
    if (ok.length) {
      done.push({
        season: src.season,
        ep: src.ep,
        title: src.title,
        frames: ok.map((s) => s.rel),
        times: ok.map((s) => s.time),
      })
    }
  }

  if (!cleanup.length || !CFG.keepExtracted) {
    await fs.rm(workRoot, { recursive: true, force: true })
  }

  if (!done.length) {
    console.error('\nNothing imported.\n')
    process.exit(1)
  }

  const manifest = await mergeManifest({ id: ID, title: TITLE, episodes: done })
  console.log(`\nDone. ${manifest.frameCount} frames across ${manifest.episodeCount} episodes -> public/frames/${ID}/`)
  console.log(`Manifest: public/data/${ID}.json\n`)
}

const byNum = (a, b) => parseInt(a, 10) - parseInt(b, 10)
const epTagOf = (x) => epTag(x.season, x.ep).toUpperCase()

main().catch((e) => { console.error(e); process.exit(1) })
