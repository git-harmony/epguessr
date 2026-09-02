import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ENDLESS,
  ENDLESS_LIVES,
  ROUND_OPTIONS,
  MAX_PARTIAL_DISTANCE,
  bestKey,
  createDealer,
  epLabel,
  isEndless,
  isMiss,
  hintWindow,
  loadBests,
  saveBest,
  scoreRound,
  verdictFor,
} from './game.js'

const asset = (rel) => `${import.meta.env.BASE_URL}${rel}`.replace(/([^:])\/\//g, '$1/')

export default function App() {
  const [index, setIndex] = useState(null)
  const [indexError, setIndexError] = useState(null)
  const [session, setSession] = useState(null)
  const [rounds, setRounds] = useState(10)
  const [bests, setBests] = useState(() => loadBests())
  // Bumped per game so <Game> always remounts fresh, even on an identical draw.
  const seq = useRef(0)

  useEffect(() => {
    fetch(asset('data/index.json'))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setIndex(data.animes ?? []))
      .catch((e) => setIndexError(e))
  }, [])

  const startGame = useCallback(async (entry) => {
    setSession({ loading: true, entry })
    try {
      const res = await fetch(asset(`data/${entry.id}.json`))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const anime = await res.json()
      const dealer = createDealer(anime)
      const endless = isEndless(rounds)
      // Endless deals as it goes; fixed games get the whole deck up front.
      const opening = (endless ? [dealer.next()] : Array.from({ length: rounds }, () => dealer.next()))
        .filter(Boolean)
      seq.current += 1
      setSession({
        anime,
        dealer,
        opening,
        endless,
        roundCount: endless ? null : rounds,
        rounds,
        seq: seq.current,
      })
    } catch (e) {
      setSession({ error: e, entry })
    }
  }, [rounds])

  const finish = useCallback((anime, roundCount, score) => {
    saveBest(anime.id, roundCount, score)
    setBests(loadBests())
  }, [])

  if (indexError || (index && index.length === 0)) return <NoData error={indexError} />
  if (!index) return <Splash>Loading…</Splash>

  if (session?.loading) return <Splash>Loading {session.entry.title}…</Splash>
  if (session?.error) {
    return (
      <Splash>
        Couldn&apos;t load {session.entry.title}.
        <button className="btn" onClick={() => setSession(null)}>Back</button>
      </Splash>
    )
  }

  if (session?.anime) {
    return (
      <Game
        key={session.seq}
        anime={session.anime}
        dealer={session.dealer}
        opening={session.opening}
        endless={session.endless}
        roundCount={session.roundCount}
        best={bests[bestKey(session.anime.id, session.rounds)] ?? 0}
        onFinish={(score) => finish(session.anime, session.rounds, score)}
        onReplay={() => startGame({ id: session.anime.id, title: session.anime.title })}
        onExit={() => setSession(null)}
      />
    )
  }

  return (
    <Menu
      animes={index}
      rounds={rounds}
      setRounds={setRounds}
      bests={bests}
      onPick={startGame}
    />
  )
}

/* -------------------------------------------------------------- shell bits */

function Splash({ children }) {
  return (
    <div className="shell centre">
      <div className="splash">{children}</div>
    </div>
  )
}

function NoData({ error }) {
  return (
    <div className="shell centre">
      <div className="empty card">
        <h1 className="wordmark">epguessr</h1>
        <p className="lede">No frame packs yet. Point the extractor at a folder of episodes:</p>
        <pre>
          <code>{'npm run extract -- --input "D:/Anime/Frieren" --title "Frieren" --dry-run'}</code>
        </pre>
        <p className="muted">
          The dry run prints what it parsed out of your filenames. Drop <code>--dry-run</code> once the
          episode numbers look right and it will write frames into <code>public/frames/</code>.
        </p>
        {error ? <p className="muted small">({String(error.message ?? error)})</p> : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- menu */

function Menu({ animes, rounds, setRounds, bests, onPick }) {
  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">epguessr</h1>
        <p className="lede">One random frame. Name the episode it came from.</p>
      </header>

      <div className="rounds-picker">
        <span className="label">Rounds</span>
        {ROUND_OPTIONS.map((n) => (
          <button
            key={n}
            className={`chip ${rounds === n ? 'chip-on' : ''}`}
            onClick={() => setRounds(n)}
            title={n === ENDLESS ? `Endless — ${ENDLESS_LIVES} lives` : `${n} rounds`}
          >
            {n === ENDLESS ? '∞' : n}
          </button>
        ))}
      </div>

      <div className="library">
        {animes.map((a) => (
          <button key={a.id} className="anime-card" onClick={() => onPick(a)}>
            <div className="anime-art">
              <img src={asset(a.cover)} alt="" loading="lazy" />
            </div>
            <div className="anime-meta">
              <span className="anime-title">{a.title}</span>
              <span className="muted small">
                {a.episodeCount} episodes
                {a.seasons?.length > 1 ? ` · ${a.seasons.length} seasons` : ''}
                {a.frameCount ? ` · ${a.frameCount} frames` : ''}
              </span>
              {bests[bestKey(a.id, rounds)] ? (
                <span className="best small">best {bests[bestKey(a.id, rounds)].toLocaleString()}</span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- game */

function Game({ anime, dealer, opening, endless, roundCount, best, onFinish, onReplay, onExit }) {
  const [deck, setDeck] = useState(opening)
  const [roundIndex, setRoundIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [result, setResult] = useState(null)
  const [hint, setHint] = useState(null)
  const [history, setHistory] = useState([])
  const [done, setDone] = useState(false)
  // Snapshot the record before this game counts, so the summary can say "new best".
  const bestBefore = useRef(best)

  const current = deck[roundIndex]
  const multiSeason = anime.seasons.length > 1
  const score = history.reduce((n, h) => n + h.points, 0)
  const livesLeft = ENDLESS_LIVES - history.filter((h) => isMiss(h.distance)).length
  // A miss showing in the current reveal hasn't reached history yet.
  const livesAfter = livesLeft - (result && isMiss(result.distance) ? 1 : 0)
  const lastRound = endless ? livesAfter <= 0 : roundIndex + 1 >= roundCount
  const streak = useMemo(() => {
    let s = 0
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].distance !== 0) break
      s++
    }
    return s
  }, [history])

  const submit = useCallback(() => {
    if (selected == null || result) return
    const answer = current.episode
    const distance = Math.abs(selected - answer.abs)
    const scored = scoreRound(distance, !!hint, streak)
    setResult({ distance, ...scored, answerAbs: answer.abs, guessAbs: selected })
  }, [selected, result, current, hint, streak])

  const next = useCallback(() => {
    if (!result) return
    const entry = {
      frame: current,
      guessAbs: result.guessAbs,
      answerAbs: result.answerAbs,
      distance: result.distance,
      points: result.points,
      usedHint: result.usedHint,
    }
    const nextHistory = [...history, entry]
    const total = nextHistory.reduce((n, h) => n + h.points, 0)
    setHistory(nextHistory)
    setResult(null)
    setSelected(null)
    setHint(null)

    if (lastRound) {
      setDone(true)
      onFinish(total)
      return
    }
    if (endless && roundIndex + 1 >= deck.length) {
      const card = dealer.next()
      if (!card) {
        setDone(true)
        onFinish(total)
        return
      }
      setDeck([...deck, card])
    }
    setRoundIndex(roundIndex + 1)
  }, [result, current, history, roundIndex, deck, dealer, endless, lastRound, onFinish])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        result ? next() : submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [result, next, submit])

  if (done) {
    return (
      <Summary
        anime={anime}
        history={history}
        score={score}
        endless={endless}
        best={bestBefore.current}
        onReplay={onReplay}
        onExit={onExit}
      />
    )
  }

  return (
    <div className="shell">
      <header className="hud">
        <button className="btn ghost" onClick={onExit}>← library</button>
        <div className="hud-title">{anime.title}</div>
        <div className="hud-stats">
          <span>
            Round <b>{roundIndex + 1}</b>
            {endless ? null : `/${roundCount}`}
          </span>
          <span>Score <b>{score.toLocaleString()}</b></span>
          {endless ? (
            <span className={livesAfter > 0 ? 'lives' : 'lives lives-out'}>
              {'♥'.repeat(Math.max(livesAfter, 0)) || '♡'}
            </span>
          ) : null}
          {streak > 1 ? <span className="streak">🔥 {streak}</span> : null}
        </div>
      </header>

      <Frame src={asset(current.src)} key={current.src} />

      <div className="controls">
        {!result && !hint ? (
          <button
            className="btn ghost"
            onClick={() => setHint(hintWindow(current.episode.abs, anime.episodeCount))}
          >
            Narrow it down <span className="muted small">— half points</span>
          </button>
        ) : null}
        {hint && !result ? (
          <span className="hint-note">
            Somewhere in episodes {hint.start}–{hint.end}. Half points.
          </span>
        ) : null}
        {result ? <Verdict result={result} anime={anime} /> : null}
      </div>

      <EpisodeGrid
        anime={anime}
        selected={selected}
        onSelect={setSelected}
        result={result}
        hint={hint}
      />

      <div className="submit-bar">
        {result ? (
          <button className="btn primary" onClick={next} autoFocus>
            {lastRound ? 'See results' : 'Next round'} <kbd>↵</kbd>
          </button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={selected == null}>
            {selected == null
              ? 'Pick an episode'
              : `Lock in ${epLabel(episodeByAbs(anime, selected), multiSeason)}`}
            {selected == null ? null : <kbd>↵</kbd>}
          </button>
        )}
      </div>
    </div>
  )
}

const episodeByAbs = (anime, abs) => anime.episodes.find((e) => e.abs === abs)

function Frame({ src }) {
  const [zoom, setZoom] = useState(false)
  const [origin, setOrigin] = useState('50% 50%')
  const boxRef = useRef(null)

  const track = (e) => {
    if (!zoom) return
    const r = boxRef.current.getBoundingClientRect()
    setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`)
  }

  return (
    <div
      ref={boxRef}
      className={`frame ${zoom ? 'zoomed' : ''}`}
      onClick={() => setZoom((z) => !z)}
      onMouseMove={track}
      title={zoom ? 'Click to zoom out' : 'Click to zoom in'}
    >
      <img src={src} alt="A frame from the episode you are guessing" style={{ transformOrigin: origin }} />
    </div>
  )
}

function Verdict({ result, anime }) {
  const v = verdictFor(result.distance)
  const answer = episodeByAbs(anime, result.answerAbs)
  const multiSeason = anime.seasons.length > 1
  return (
    <div className={`verdict verdict-${v.tone}`}>
      <span className="verdict-label">{v.label}</span>
      <span className="verdict-answer">
        It was <b>{epLabel(answer, multiSeason)}</b>
      </span>
      <span className="verdict-points">
        +{result.points.toLocaleString()}
        {result.bonus ? <span className="muted small"> (incl. {result.bonus} streak)</span> : null}
        {result.usedHint && result.base ? <span className="muted small"> · halved for hint</span> : null}
      </span>
    </div>
  )
}

function EpisodeGrid({ anime, selected, onSelect, result, hint }) {
  const multiSeason = anime.seasons.length > 1
  const groups = multiSeason
    ? anime.seasons.map((s) => ({ season: s, episodes: anime.episodes.filter((e) => e.season === s) }))
    : [{ season: null, episodes: anime.episodes }]

  return (
    <div className="grid-wrap">
      {groups.map((g) => (
        <section key={g.season ?? 'all'} className="season">
          {g.season != null ? <h2 className="season-label">Season {g.season}</h2> : null}
          <div className="grid">
            {g.episodes.map((e) => {
              const outside = hint && (e.abs < hint.start || e.abs > hint.end)
              const classes = ['tile']
              if (selected === e.abs) classes.push('tile-selected')
              if (outside) classes.push('tile-dimmed')
              if (result) {
                if (e.abs === result.answerAbs) classes.push('tile-answer')
                else if (e.abs === result.guessAbs) {
                  classes.push(result.distance <= MAX_PARTIAL_DISTANCE ? 'tile-close' : 'tile-wrong')
                }
              }
              return (
                <button
                  key={e.abs}
                  className={classes.join(' ')}
                  disabled={!!result}
                  onClick={() => onSelect(e.abs)}
                  title={epLabel(e, multiSeason)}
                >
                  {e.ep}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------------- summary */

function Summary({ anime, history, score, endless, best, onReplay, onExit }) {
  const exact = history.filter((h) => h.distance === 0).length
  const close = history.filter((h) => h.distance > 0 && h.distance <= MAX_PARTIAL_DISTANCE).length
  const avg = history.length
    ? (history.reduce((n, h) => n + h.distance, 0) / history.length).toFixed(1)
    : '0'
  const isRecord = score > best
  const multiSeason = anime.seasons.length > 1

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">{score.toLocaleString()}</h1>
        <p className="lede">
          {anime.title}
          {endless ? ` · survived ${history.length} round${history.length === 1 ? '' : 's'}` : ''}
          {` · ${exact} exact, ${close} close · ${avg} episodes off on average`}
        </p>
        {isRecord ? <p className="record">New personal best</p> : <p className="muted small">Best {best.toLocaleString()}</p>}
      </header>

      <div className="submit-bar">
        <button className="btn primary" onClick={onReplay}>Play again</button>
        <button className="btn ghost" onClick={onExit}>Pick another anime</button>
      </div>

      <div className="recap">
        {history.map((h, i) => {
          const v = verdictFor(h.distance)
          return (
            <div key={i} className={`recap-row recap-${v.tone}`}>
              <img src={asset(h.frame.src)} alt="" loading="lazy" />
              <div className="recap-body">
                <span className="recap-answer">
                  {epLabel(episodeByAbs(anime, h.answerAbs), multiSeason)}
                </span>
                <span className="muted small">
                  you said {epLabel(episodeByAbs(anime, h.guessAbs), multiSeason)} · {v.label}
                  {h.usedHint ? ' · hinted' : ''}
                </span>
              </div>
              <span className="recap-points">+{h.points.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
