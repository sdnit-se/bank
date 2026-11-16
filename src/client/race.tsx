// The typing race: words to type as fast as the fingers go, against the clock, the viewer's own best and the fastest
// anyone here has been. The rivals run on the lanes above the words at the pace of those records, so being ahead or
// behind is something to see rather than work out.
//
// It is built to be played from the keyboard and nothing else. The words are dealt as soon as the page opens, any key
// starts the clock, Esc (or Tab, then Enter) deals a fresh line, and Enter after a race goes straight into the next.
// While a race is on, everything that isn't the words steps back.

import { Avatar } from "@opencode/ui/avatar"
import { Button } from "@opencode/ui/button"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { currency, type Me, type Race, type RaceResult } from "../shared/types"
import { api } from "./api"

/** Words a minute, the usual way: five keys to a word. */
const pace = (keys: number, ms: number) => (ms > 0 ? Math.round(keys / 5 / (ms / 60_000)) : 0)
/** The speed at each second of a race: so far, and in that second alone. */
type Sample = { second: number; wpm: number; burst: number }
type Dealt = { id: number; text: string; best: number; record: { name: string; best: number } | null }

const remembered = () => {
  try {
    return Number(localStorage.getItem("bank.race.words")) || 0
  } catch {
    return 0
  }
}

function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / (60 * 24))}d ago`
}

export function RaceView(props: { me: Me; done: () => void }) {
  const [race, { mutate }] = createResource(() => api.race())
  const [words, setWords] = createSignal(remembered())
  /** The words, and who there is to beat: the records as they stood when the race was dealt. */
  const [dealt, setDealt] = createSignal<Dealt | null>(null)
  const [typed, setTyped] = createSignal("")
  const [started, setStarted] = createSignal<number | null>(null)
  const [now, setNow] = createSignal(0)
  const [result, setResult] = createSignal<(RaceResult & { raw: number; seconds: number; slips: number; samples: Sample[] }) | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [caps, setCaps] = createSignal(false)
  /** Where the caret is among the words, and how far they have scrolled to keep it in view. */
  const [caret, setCaret] = createSignal({ left: 0, top: 0, height: 0, scrolled: 0 })
  const [scope, setScope] = createSignal<"today" | "board">("board")
  let field: HTMLInputElement | undefined
  let letters: HTMLDivElement | undefined
  let keys = 0
  let slips = 0
  let samples: Sample[] = []
  const coins = (amount: number) => currency(props.me.config, amount)
  const text = () => dealt()?.text ?? ""
  const elapsed = () => (started() === null ? 0 : now() - started()!)
  const racing = () => started() !== null && !result()
  /** How many letters are right where they stand. Wrong ones can be left behind, but not at the finish. */
  const right = createMemo(() => {
    let count = 0
    for (let index = 0; index < typed().length; index++) if (typed()[index] === text()[index]) count++
    return count
  })
  const stuck = () => typed().length === text().length && typed() !== text()
  /** How far along the words someone typing at `wpm` would be by now, from 0 to 1. */
  const along = (wpm: number) => (text() ? Math.min(1, (wpm * 5 * (elapsed() / 60_000)) / text().length) : 0)
  const ready = createMemo(() => race() !== undefined)
  const length = createMemo(() => (race()?.lengths.includes(words()) ? words() : (race()?.lengths[0] ?? 25)))

  const tick = setInterval(() => {
    if (!racing()) return
    setNow(performance.now())
    const second = Math.floor(elapsed() / 1000)
    if (second < 1 || samples.at(-1)?.second === second) return
    const before = samples.reduce((sum, sample) => sum + sample.burst, 0)
    samples.push({ second, wpm: pace(right(), second * 1000), burst: Math.max(0, right() * 12 - before) })
  }, 100)
  onCleanup(() => clearInterval(tick))

  const deal = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const next = await api.startRace(length())
      keys = slips = 0
      samples = []
      setResult(null)
      setTyped("")
      setStarted(null)
      setProblem(null)
      const fastest = race()?.board[0]
      setDealt({ ...next, best: race()?.best ?? 0, record: fastest && fastest.id !== props.me.user.id ? fastest : null })
      field?.focus()
    } catch (error) {
      setProblem((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // The words are there before anyone asks: opening the page, or choosing another length, deals them.
  createEffect(on([ready, length], ([loaded]) => loaded && void deal()))

  const finish = async (ms: number) => {
    setBusy(true)
    try {
      const done = await api.finishRace({ id: dealt()!.id, typed: typed(), ms, keys })
      setResult({ ...done, raw: pace(keys, ms), seconds: ms / 1000, slips, samples })
      mutate(done.race)
      // Their balance and their experience have both moved.
      if (done.paid > 0 || done.xp > 0) props.done()
    } catch (error) {
      setBusy(false)
      await deal()
      setProblem((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const type = (value: string) => {
    if (!dealt() || result() || busy()) return
    const next = value.slice(0, text().length)
    for (let index = typed().length; index < next.length; index++) {
      keys++
      if (next[index] !== text()[index]) slips++
    }
    if (started() === null && next) {
      setStarted(performance.now())
      setNow(performance.now())
    }
    setTyped(next)
    if (next === text()) void finish(performance.now() - started()!)
  }

  const pick = (count: number) => {
    try {
      localStorage.setItem("bank.race.words", String(count))
    } catch {
      // Remembering the length is a nicety.
    }
    setWords(count)
  }

  onMount(() => {
    const press = (event: KeyboardEvent) => {
      setCaps(event.getModifierState?.("CapsLock") ?? false)
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const elsewhere = target !== field && target?.closest("input, textarea, select, [contenteditable]")
      if (elsewhere) return
      if (event.key === "Escape" || (event.key === "Enter" && result() && !target?.closest("button, a"))) {
        event.preventDefault()
        return void deal()
      }
      // A key pressed anywhere on the page is a key for the race, as long as it could be a letter.
      if (target !== field && !target?.closest("button, a") && !result() && (event.key.length === 1 || event.key === "Backspace")) field?.focus()
    }
    window.addEventListener("keydown", press)
    onCleanup(() => window.removeEventListener("keydown", press))
  })

  // The caret is its own thing, slid to wherever the next letter is, and the words scroll to keep it on the second
  // of the three lines in view.
  const place = () => {
    const next = letters?.children[Math.min(typed().length, text().length - 1)] as HTMLElement | undefined
    if (!next) return
    const end = typed().length >= text().length
    const line = parseFloat(getComputedStyle(letters!).lineHeight) || next.offsetHeight
    const row = Math.round((next.offsetTop - (letters!.children[0] as HTMLElement).offsetTop) / line)
    setCaret({ left: next.offsetLeft + (end ? next.offsetWidth : 0), top: next.offsetTop, height: next.offsetHeight, scrolled: Math.max(0, row - 1) * line })
  }
  createEffect(() => {
    typed()
    dealt()
    result()
    queueMicrotask(place)
  })
  // The words wrap differently when the window changes, and the caret has to follow them.
  const watcher = new ResizeObserver(place)
  onCleanup(() => watcher.disconnect())

  const Lane = (lane: { name: string; at: number; mine?: boolean }) => (
    <div class="race-lane" classList={{ "race-lane-mine": lane.mine }}>
      <span class="race-lane-name">{lane.name}</span>
      <span class="race-track">
        <i style={{ left: `${lane.at * 100}%` }} />
      </span>
    </div>
  )

  return (
    <section class="card race-card" classList={{ "race-on": racing() }}>
      <div class="race-top race-away">
        <div class="flex flex-col gap-0.5 min-w-0">
          <h2 class="strong m-0 text-[13px] leading-5 min-h-7 flex items-center">Typing race</h2>
          <div class="muted text-pretty max-w-[62ch]">
            No stake, as many goes as you like, and a decent run pays a wage in newly made coins, up to {coins(props.me.config.wages)} a day.
          </div>
        </div>
        <Show when={race()}>
          {(state) => (
            <div class="flex items-center gap-1.5 shrink-0" role="group" aria-label="How many words">
              <For each={state().lengths}>
                {(count) => (
                  <Button variant={length() === count ? "neutral" : "ghost-muted"} size="small" onClick={() => pick(count)}>
                    {count} words
                  </Button>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>

      <Show when={race()} fallback={<div class="px-4 py-8 text-center faint">Loading…</div>}>
        {(state) => (
          <>
            <div class="race-stage">
              <div class="race-lanes" aria-hidden="true">
                <Lane mine name="You" at={text() ? right() / text().length : 0} />
                <Show when={(dealt()?.best ?? 0) > 0}>
                  <Lane name={`Your best, ${dealt()!.best}`} at={along(dealt()!.best)} />
                </Show>
                <Show when={dealt()?.record}>{(rival) => <Lane name={`${rival().name}, ${rival().best}`} at={along(rival().best)} />}</Show>
              </div>

              {/* The words are a picture of what has been typed; the field over them is what takes the keys. */}
              <div class="race-window" classList={{ "race-blurred": !focused() && !result() && dealt() !== null }} onClick={() => field?.focus()}>
                <div class="race-words" ref={(element) => (watcher.observe(element), (letters = element))} style={{ transform: `translateY(${-(result() ? 0 : caret().scrolled)}px)` }}>
                  <For each={[...text()]}>
                    {(letter, index) => (
                      <span classList={{ "race-done": index() < typed().length && typed()[index()] === letter, "race-wrong": index() < typed().length && typed()[index()] !== letter }}>{letter}</span>
                    )}
                  </For>
                  <Show when={!result() && dealt()}>
                    <i class="race-caret" classList={{ "race-caret-idle": started() === null }} style={{ left: `${caret().left}px`, top: `${caret().top}px`, height: `${caret().height}px` }} />
                  </Show>
                </div>
                <input
                  ref={field}
                  class="race-field"
                  aria-label="Type the words here"
                  value={typed()}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  disabled={result() !== null}
                  onInput={(event) => type(event.currentTarget.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onPaste={(event) => event.preventDefault()}
                  onDrop={(event) => event.preventDefault()}
                />
                <div class="race-nudge">Click here, or press any key, to carry on</div>
              </div>

              <div class="race-live">
                <Show
                  when={!result()}
                  fallback={
                    <span class="flex items-center gap-3">
                      <Button variant="contrast" onClick={deal} disabled={busy()}>
                        Next race
                      </Button>
                      <span class="faint">
                        <kbd>enter</kbd>
                      </span>
                    </span>
                  }
                >
                  <span>
                    <span class="race-speed num">{pace(right(), elapsed())}</span> <span class="muted">words a minute</span>
                    <Show when={started() !== null}>
                      <span class="muted num"> · {(elapsed() / 1000).toFixed(1)}s</span>
                    </Show>
                  </span>
                  <span classList={{ danger: problem() !== null || stuck() || caps(), muted: !(problem() !== null || stuck() || caps()) }}>
                    {problem() ?? (stuck() ? "Fix the red letters to finish." : caps() ? "Caps Lock is on." : started() === null ? "The clock starts on your first key." : "")}
                  </span>
                </Show>
                <span class="race-binds faint race-away">
                  <Button variant="ghost-muted" size="small" onClick={deal} disabled={busy()}>
                    New words
                  </Button>
                  <span>
                    <kbd>esc</kbd> or <kbd>tab</kbd> <kbd>enter</kbd>
                  </span>
                  <span>
                    <kbd>ctrl</kbd> <kbd>backspace</kbd> takes a word back
                  </span>
                </span>
              </div>
            </div>

            <Show when={result()}>
              {(done) => (
                <div class="race-result">
                  <div class="race-score">
                    <span class="num">{done().wpm}</span>
                    <span class="muted">words a minute</span>
                    <Show when={done().record || done().personal}>
                      <span class="race-flag">{done().record ? "Office record" : "Your best yet"}</span>
                    </Show>
                  </div>
                  <dl class="race-facts">
                    <Fact label="Keys right" value={`${done().accuracy}%`} />
                    <Fact label="Counting every key" value={done().raw} />
                    <Fact label="Time" value={`${done().seconds.toFixed(1)}s`} />
                    <Fact label="Slips" value={done().slips} />
                    <Fact label="Experience" value={`+${done().xp}`} note={done().xp > 0 ? undefined : "today's share is used up"} />
                    <Fact
                      label="Earned"
                      value={done().paid > 0 ? `+${done().paid}` : "0"}
                      note={
                        done().paid > 0
                          ? `${done().race.earned} of ${done().race.limit} today`
                          : done().race.limit > 0 && done().race.earned >= done().race.limit
                            ? "today's limit is reached"
                            : done().race.limit > 0
                              ? `a wage starts at ${done().race.wages.at(-1)!.from}`
                              : undefined
                      }
                    />
                  </dl>
                  <Speeds samples={done().samples} wpm={done().wpm} />
                </div>
              )}
            </Show>

            <div class="race-below race-away">
              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Your running</h3>
                <dl class="race-figures">
                  <Fact label="Best" value={state().best || "–"} />
                  <Fact label="Lately" value={state().average || "–"} />
                  <Fact label="Races" value={state().races} />
                  <Fact label="Today" value={state().earned} />
                </dl>
                <Show when={state().limit > 0}>
                  <ul class="race-pay muted">
                    <For each={[...state().wages].reverse()}>
                      {(step) => (
                        <li>
                          <span class="num">from {step.from} words a minute</span>
                          <span class="num">{coins(step.pays)}</span>
                        </li>
                      )}
                    </For>
                    <li class="faint">
                      for {state().lengths[0]} words, more for longer, up to {coins(state().limit)} a day
                    </li>
                  </ul>
                </Show>
              </div>

              <div class="flex flex-col gap-3">
                <div class="flex items-center justify-between gap-2 min-h-5">
                  <h3 class="strong m-0 text-[13px]">Fastest in the office</h3>
                  <span class="flex items-center gap-1">
                    <Button variant={scope() === "board" ? "neutral" : "ghost-muted"} size="small" onClick={() => setScope("board")}>
                      All time
                    </Button>
                    <Button variant={scope() === "today" ? "neutral" : "ghost-muted"} size="small" onClick={() => setScope("today")}>
                      Today
                    </Button>
                  </span>
                </div>
                <Board rows={state()[scope()]} me={props.me.user.id} empty={scope() === "today" ? "Nobody has raced today. The day's best is one race away." : "Nobody has raced yet. The record is yours for the taking."} />
              </div>

              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Your last races</h3>
                <Show when={state().recent.length} fallback={<div class="faint">None yet.</div>}>
                  <ul class="race-recent">
                    <For each={state().recent}>
                      {(run) => (
                        <li>
                          <span class="strong num w-8">{run.wpm}</span>
                          <span class="muted num flex-1">
                            {run.accuracy}%, {run.words} words
                          </span>
                          <span class="faint num">{ago(run.at)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

function Fact(props: { label: string; value: string | number; note?: string }) {
  return (
    <div>
      <dd class="strong num m-0 text-[20px] leading-6">{props.value}</dd>
      <dt class="muted">{props.label}</dt>
      <Show when={props.note}>
        <div class="faint">{props.note}</div>
      </Show>
    </div>
  )
}

function Board(props: { rows: Race["board"]; me: string; empty: string }) {
  return (
    <Show when={props.rows.length} fallback={<div class="faint">{props.empty}</div>}>
      <ol class="race-board">
        <For each={props.rows}>
          {(person, index) => (
            <li>
              <span class="faint num w-4">{index() + 1}</span>
              <Avatar src={person.image ?? undefined} fallback={person.name} size="small" />
              <span class="flex-1 min-w-0 truncate">{person.id === props.me ? "You" : person.name}</span>
              <span class="faint num">{person.races === 1 ? "1 race" : `${person.races} races`}</span>
              <span class="strong num w-8 text-right">{person.best}</span>
            </li>
          )}
        </For>
      </ol>
    </Show>
  )
}

/** How the speed went over a race: the speed so far as the line, each second by itself as the faint one behind it. */
function Speeds(props: { samples: Sample[]; wpm: number }) {
  const [at, setAt] = createSignal<number | null>(null)
  const [width, height, pad] = [640, 110, 6]
  const all = () => props.samples.flatMap((sample) => [sample.wpm, sample.burst])
  // Speeds never come near zero, so the scale runs from just under the slowest second to just over the fastest.
  const floor = () => Math.max(0, Math.min(props.wpm, ...all()) - 10)
  const top = () => Math.max(props.wpm, ...all()) + 10
  const x = (index: number) => pad + (props.samples.length > 1 ? (index / (props.samples.length - 1)) * (width - pad * 2) : 0)
  const y = (value: number) => height - pad - ((value - floor()) / (top() - floor())) * (height - pad * 2)
  const path = (key: "wpm" | "burst") => props.samples.map((sample, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(sample[key]).toFixed(1)}`).join(" ")
  const nearest = (event: MouseEvent) => {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect()
    setAt(Math.max(0, Math.min(props.samples.length - 1, Math.round(((event.clientX - box.left) / box.width) * (props.samples.length - 1)))))
  }
  return (
    <Show when={props.samples.length > 2}>
      <figure class="race-chart">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Speed through the race, second by second, ending at ${props.wpm} words a minute`} onMouseMove={nearest} onMouseLeave={() => setAt(null)}>
          <line class="race-chart-rule" x1={pad} x2={width - pad} y1={y(props.wpm)} y2={y(props.wpm)} />
          <path class="race-chart-burst" d={path("burst")} />
          <path class="race-chart-line" d={path("wpm")} />
          <Show when={at() !== null}>
            <line class="race-chart-cross" x1={x(at()!)} x2={x(at()!)} y1={pad} y2={height - pad} />
            <circle class="race-chart-dot" cx={x(at()!)} cy={y(props.samples[at()!]!.wpm)} r="4" />
          </Show>
        </svg>
        <figcaption class="muted">
          <Show
            when={at() !== null}
            fallback={
              <>
                <span class="race-key race-key-line" /> speed so far <span class="race-key race-key-burst" /> each second by itself
                <span class="faint num"> · from {floor()} to {top()} words a minute</span>
              </>
            }
          >
            <span class="num">
              At {props.samples[at()!]!.second}s: {props.samples[at()!]!.wpm} so far, {props.samples[at()!]!.burst} in that second
            </span>
          </Show>
        </figcaption>
      </figure>
    </Show>
  )
}
