// The Race tab: a line of words to type as fast as the fingers go, against the clock, the viewer's own best and the
// fastest anyone here has been. The two rivals run on the lanes above the words at the pace of those records, so
// being ahead or behind is something to see rather than work out.

import { Avatar } from "@opencode/ui/avatar"
import { Button } from "@opencode/ui/button"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { currency, type Me, type RaceResult } from "../shared/types"
import { api } from "./api"

/** Words a minute, the usual way: five keys to a word. */
const pace = (keys: number, ms: number) => (ms > 0 ? Math.round(keys / 5 / (ms / 60_000)) : 0)

export function RaceView(props: { me: Me; done: () => void }) {
  const [race, { mutate }] = createResource(() => api.race())
  /** The words, and who there is to beat: the records as they stood when the race was dealt. */
  const [dealt, setDealt] = createSignal<{ id: number; text: string; best: number; record: { name: string; best: number } | null } | null>(null)
  const [typed, setTyped] = createSignal("")
  const [started, setStarted] = createSignal<number | null>(null)
  const [now, setNow] = createSignal(0)
  const [result, setResult] = createSignal<RaceResult | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  let field: HTMLInputElement | undefined
  let keys = 0
  const coins = (amount: number) => currency(props.me.config, amount)
  const text = () => dealt()?.text ?? ""
  const elapsed = () => (started() === null ? 0 : now() - started()!)
  /** How much of what has been typed is right, from the start: the rest has to be taken back. */
  const right = createMemo(() => {
    let index = 0
    while (index < typed().length && typed()[index] === text()[index]) index++
    return index
  })
  /** How far along the words someone typing at `wpm` would be by now, from 0 to 1. */
  const along = (wpm: number) => (text() ? Math.min(1, (wpm * 5 * (elapsed() / 60_000)) / text().length) : 0)

  const tick = setInterval(() => started() !== null && !result() && setNow(performance.now()), 100)
  onCleanup(() => clearInterval(tick))

  const deal = async () => {
    if (busy()) return
    setBusy(true)
    setProblem(null)
    try {
      const next = await api.startRace()
      keys = 0
      setResult(null)
      setTyped("")
      setStarted(null)
      const fastest = race()?.board[0]
      setDealt({ ...next, best: race()?.best ?? 0, record: fastest && fastest.id !== props.me.user.id ? fastest : null })
      field?.focus()
    } catch (error) {
      setProblem((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const finish = async (ms: number) => {
    setBusy(true)
    try {
      const done = await api.finishRace({ id: dealt()!.id, typed: typed(), ms, keys })
      setResult(done)
      mutate(done.race)
      if (done.paid > 0) props.done()
    } catch (error) {
      setProblem((error as Error).message)
      setDealt(null)
    } finally {
      setBusy(false)
    }
  }

  const type = (value: string) => {
    if (!dealt() || result() || busy()) return
    const next = value.slice(0, text().length)
    if (next.length > typed().length) keys += next.length - typed().length
    if (started() === null && next) {
      setStarted(performance.now())
      setNow(performance.now())
    }
    setTyped(next)
    if (next === text()) void finish(performance.now() - started()!)
  }

  onMount(() => {
    // Enter deals the first race and the next one, so a run of them never needs the mouse.
    const again = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return
      if (target !== field && target?.closest("input, textarea, select, button, a, [contenteditable]")) return
      if (dealt() && !result()) return
      event.preventDefault()
      void deal()
    }
    window.addEventListener("keydown", again)
    onCleanup(() => window.removeEventListener("keydown", again))
  })

  const Lane = (lane: { name: string; at: number; mine?: boolean }) => (
    <div class="race-lane" classList={{ "race-lane-mine": lane.mine }}>
      <span class="race-lane-name">{lane.name}</span>
      <span class="race-track">
        <i style={{ left: `${lane.at * 100}%` }} />
      </span>
    </div>
  )

  return (
    <section class="card">
      <div class="p-4 flex flex-col gap-0.5">
        <h2 class="strong m-0 text-[13px] leading-5 min-h-7 flex items-center">Typing race</h2>
        <div class="muted text-pretty max-w-[62ch]">
          Type the line as fast as you can. It costs nothing, you can go as often as you like, and a decent run pays a wage in newly made coins, up to{" "}
          {coins(props.me.config.wages)} a day. The dots are you, your best and the office record.
        </div>
      </div>
      <Show when={race()} fallback={<div class="px-4 py-8 text-center faint">Loading…</div>}>
        {(state) => (
          <div class="race px-4 pb-5">
            <div class="race-game">
              <Show
                when={dealt()}
                fallback={
                  <div class="race-idle">
                    <Button variant="contrast" onClick={deal} disabled={busy()}>
                      Start a race
                    </Button>
                    <span class="faint">or press Enter</span>
                    <Show when={problem()}>{(message) => <span class="danger">{message()}</span>}</Show>
                  </div>
                }
              >
                <div class="race-lanes" aria-hidden="true">
                  <Lane mine name="You" at={text() ? right() / text().length : 0} />
                  <Show when={dealt()!.best > 0}>
                    <Lane name={`Your best, ${dealt()!.best}`} at={along(dealt()!.best)} />
                  </Show>
                  <Show when={dealt()!.record}>{(rival) => <Lane name={`${rival().name}, ${rival().best}`} at={along(rival().best)} />}</Show>
                </div>

                {/* The words are a picture of what has been typed; the field under them is what takes the keys. */}
                <div class="race-words" onClick={() => field?.focus()}>
                  <For each={[...text()]}>
                    {(letter, index) => (
                      <span
                        classList={{
                          "race-done": index() < right(),
                          "race-wrong": index() >= right() && index() < typed().length,
                          "race-next": index() === typed().length && !result(),
                        }}
                      >
                        {letter}
                      </span>
                    )}
                  </For>
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
                    onPaste={(event) => event.preventDefault()}
                    onDrop={(event) => event.preventDefault()}
                  />
                </div>

                <Show
                  when={result()}
                  fallback={
                    <div class="race-live">
                      <span>
                        <span class="strong num">{pace(right(), elapsed())}</span> <span class="muted">words a minute</span>
                      </span>
                      <span class="muted">
                        {started() === null ? "The clock starts on your first key." : typed().length > right() ? "Take the wrong letters back to go on." : `${(elapsed() / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                  }
                >
                  {(done) => (
                    <div class="race-result">
                      <div class="race-score">
                        <span class="num">{done().wpm}</span>
                        <span class="muted">words a minute, {done().accuracy}% of your keys right</span>
                      </div>
                      <div class="text-pretty">
                        <Show when={done().record || done().personal}>
                          <span class="strong">{done().record ? "The fastest anyone here has typed. " : "Your best yet. "}</span>
                        </Show>
                        <Show
                          when={done().paid > 0}
                          fallback={
                            <span class="muted">
                              {done().race.limit > 0 && done().race.earned >= done().race.limit
                                ? `You've earned today's ${coins(done().race.limit)} already, so this one was for the board.`
                                : done().race.limit > 0
                                  ? `A wage starts at ${done().race.wages.at(-1)!.from} words a minute.`
                                  : ""}
                            </span>
                          }
                        >
                          <span class="positive">You earned {coins(done().paid)}.</span>{" "}
                          <span class="muted">
                            That's {coins(done().race.earned)} of today's {coins(done().race.limit)}.
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-3">
                        <Button variant="contrast" onClick={deal} disabled={busy()}>
                          Race again
                        </Button>
                        <span class="faint">or press Enter</span>
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
            </div>

            <aside class="race-side">
              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Your running</h3>
                <dl class="vault-figures">
                  <Figure label="Best" value={state().best || "–"} />
                  <Figure label="Lately" value={state().average || "–"} />
                  <Figure label="Races" value={state().races} />
                  <Figure label="Today" value={state().earned} />
                </dl>
              </div>

              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Fastest in the office</h3>
                <Show when={state().board.length} fallback={<div class="faint">Nobody has raced yet. The record is yours for the taking.</div>}>
                  <ol class="race-board">
                    <For each={state().board}>
                      {(person, index) => (
                        <li>
                          <span class="faint num w-4">{index() + 1}</span>
                          <Avatar src={person.image ?? undefined} fallback={person.name} size="small" />
                          <span class="flex-1 min-w-0 truncate">{person.id === props.me.user.id ? "You" : person.name}</span>
                          <span class="faint num">{person.races === 1 ? "1 race" : `${person.races} races`}</span>
                          <span class="strong num w-8 text-right">{person.best}</span>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </div>

              <Show when={state().limit > 0}>
                <div class="flex flex-col gap-2">
                  <h3 class="strong m-0 text-[13px]">What a race pays, up to {coins(state().limit)} a day</h3>
                  <ul class="race-pay muted">
                    <For each={[...state().wages].reverse()}>
                      {(step) => (
                        <li>
                          <span class="num">from {step.from} words a minute</span>
                          <span class="num">{coins(step.pays)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </aside>
          </div>
        )}
      </Show>
    </section>
  )
}

function Figure(props: { label: string; value: string | number }) {
  return (
    <div>
      <dd class="strong num m-0 text-[20px] leading-6">{props.value}</dd>
      <dt class="muted">{props.label}</dt>
    </div>
  )
}
