// The Vault tab: today's word on a board, played from the keyboard or the keys on screen, with how the viewer has
// done so far and how everyone else is doing today beside it.
//
// The board is always the same thirty tiles. A try is typed into the next row, and when the server has marked it the
// row's letters roll into place one after another, like the wheels of a combination lock, and take their colours as
// they land. The keys only catch up once the last one has.

import { Avatar } from "@opencode/ui/avatar"
import { Button } from "@opencode/ui/button"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { currency, type Me, type Vault } from "../shared/types"
import { api } from "./api"

const LENGTH = 5
const TRIES = 6
const KEYS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
/** How long after one letter starts rolling the next one does, and how long each takes. The stylesheet uses the same. */
const STAGGER = 140
const ROLL = 420
const SIGN: Record<string, string> = { 2: "🟢", 1: "🟡", 0: "⚪" }

/** The next word's time in the viewer's own clock: "today at 09:00" or "tomorrow at 09:00". */
function at(time: number) {
  const date = new Date(time)
  const clock = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return `${date.toDateString() === new Date().toDateString() ? "today" : "tomorrow"} at ${clock}`
}

export function VaultView(props: { me: Me; done: () => void }) {
  const [vault, { mutate }] = createResource(() => api.vault())
  const [typed, setTyped] = createSignal("")
  const [problem, setProblem] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  /** The row whose letters are rolling in, if one is. */
  const [rolling, setRolling] = createSignal<number | null>(null)
  const [shaking, setShaking] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  /** Only a vault cracked just now swings open; one cracked this morning just sits there cracked. */
  const [opened, setOpened] = createSignal(false)
  const coins = (amount: number) => currency(props.me.config, amount)
  const rows = () => vault()?.rows ?? []
  const playing = () => (vault()?.left ?? 0) > 0
  /** The rows the keys and the result go by: all of them, less the one still rolling. */
  const settled = createMemo(() => (rolling() === null ? rows() : rows().slice(0, rolling()!)))
  const over = () => vault() !== undefined && !playing() && rolling() === null

  /** The best any try has shown for each letter. */
  const known = createMemo(() => {
    const best: Record<string, string> = {}
    for (const row of settled()) [...row.word].forEach((letter, index) => (best[letter] = row.marks[index]! > (best[letter] ?? "") ? row.marks[index]! : best[letter]!))
    return best
  })

  const refuse = (text: string) => {
    setProblem(text)
    setShaking(true)
    setTimeout(() => setShaking(false), 400)
  }

  const submit = async () => {
    if (busy() || !playing() || rolling() !== null) return
    if (typed().length < LENGTH) return refuse("Five letters.")
    setBusy(true)
    setProblem(null)
    try {
      const next = await api.crack(typed())
      const row = next.rows.length - 1
      mutate(next)
      setTyped("")
      setRolling(row)
      setTimeout(() => {
        setRolling(null)
        setOpened(next.solved)
        // The prize is in their balance now.
        if (next.solved) props.done()
      }, STAGGER * (LENGTH - 1) + ROLL)
    } catch (error) {
      refuse((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const press = (key: string) => {
    if (!playing() || rolling() !== null) return
    if (key === "enter") return void submit()
    setProblem(null)
    if (key === "back") return setTyped((word) => word.slice(0, -1))
    if (typed().length < LENGTH) setTyped((word) => word + key)
  }

  onMount(() => {
    const typing = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      // Typing into a field is typing into the field, and Enter on a button or a link is for that.
      if (target?.closest("input, textarea, select, [contenteditable]")) return
      if (event.key === "Enter" && target?.closest("button, a")) return
      if (event.key === "Enter") press("enter")
      else if (event.key === "Backspace") press("back")
      else if (/^[a-zA-Z]$/.test(event.key)) press(event.key.toLowerCase())
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", typing)
    onCleanup(() => window.removeEventListener("keydown", typing))
  })

  const copy = async () => {
    const state = vault()!
    const score = state.solved ? state.rows.length : "X"
    const lines = state.rows.map((row) => [...row.marks].map((mark) => SIGN[mark]).join(""))
    await navigator.clipboard.writeText([`The vault, ${score}/${TRIES}`, ...lines].join("\n")).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** What is in a tile: a letter that has been tried and marked, one being typed, or nothing yet. */
  const tile = (row: number, column: number) => {
    const tried = rows()[row]
    if (tried) return { letter: tried.word[column]!, mark: tried.marks[column] }
    return { letter: row === rows().length ? (typed()[column] ?? "") : "", mark: undefined }
  }

  const Key = (key: { name: string; label: string; wide?: boolean }) => (
    <button
      type="button"
      class="vault-key"
      classList={{ "vault-key-wide": key.wide }}
      data-mark={known()[key.name]}
      aria-label={key.name === "back" ? "Delete" : key.name === "enter" ? "Enter" : undefined}
      disabled={!playing()}
      onClick={(event) => {
        press(key.name)
        // Otherwise Enter on the keyboard would press this key again.
        event.currentTarget.blur()
      }}
    >
      {key.label}
    </button>
  )

  return (
    <section class="card">
      <div class="p-4 flex flex-col gap-0.5">
        <h2 class="strong m-0 text-[13px] leading-5 min-h-7 flex items-center">The vault</h2>
        <div class="muted text-pretty max-w-[62ch]">
          A five-letter word a day, yours alone, and six tries. It costs nothing, and the central bank pays {coins(props.me.config.vault)} for every try you
          don't need. Type, or use the keys.
        </div>
      </div>
      <Show when={vault()} fallback={<div class="px-4 py-8 text-center faint">Loading…</div>}>
        {(state) => (
          <div class="vault px-4 pb-5">
            <div class="vault-game">
              <div class="vault-board" role="group" aria-label="Your tries">
                <For each={Array.from({ length: TRIES }, (_, row) => row)}>
                  {(row) => (
                    <div class="vault-row" classList={{ "vault-shake": shaking() && row === rows().length, "vault-rolling": rolling() === row, "vault-open": opened() && row === rows().length - 1 }}>
                      <For each={Array.from({ length: LENGTH }, (_, column) => column)}>
                        {(column) => (
                          <span class="vault-tile" data-mark={tile(row, column).mark} data-filled={tile(row, column).letter ? "" : undefined} style={{ "--i": column }}>
                            <span class="vault-letter">{tile(row, column).letter}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>

              <div class="vault-status" aria-live="polite" hidden={over()}>
                <Show when={problem()} fallback={<Show when={playing()}>{<span class="muted">Getting it on this try pays {coins(state().left * state().pays)}.</span>}</Show>}>
                  {(text) => <span class="danger">{text()}</span>}
                </Show>
              </div>

              <Show
                when={over()}
                fallback={
                  <div class="vault-keys">
                    <For each={KEYS}>
                      {(line, index) => (
                        <div class="vault-keyline">
                          <Show when={index() === 2}>
                            <Key name="enter" label="Enter" wide />
                          </Show>
                          <For each={[...line]}>{(letter) => <Key name={letter} label={letter} />}</For>
                          <Show when={index() === 2}>
                            <Key name="back" label="⌫" wide />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                }
              >
                <div class="vault-result">
                  <Show
                    when={state().solved}
                    fallback={
                      <>
                        <div class="strong text-[15px]">
                          It was <span class="vault-answer">{state().answer}</span>.
                        </div>
                        <div class="muted">Six tries, and the vault stays shut. A new word comes {at(state().next)}.</div>
                      </>
                    }
                  >
                    <div class="strong text-[15px]">
                      Cracked in {state().rows.length === 1 ? "one try" : `${state().rows.length} tries`}.
                    </div>
                    <div class="muted">
                      {state().paid ? `The central bank paid you ${coins(state().paid!)}.` : "The central bank had nothing left to pay you with."} A new word comes{" "}
                      {at(state().next)}.
                    </div>
                  </Show>
                  <div>
                    <Button variant="neutral" size="small" onClick={copy}>
                      {copied() ? "Copied" : "Copy result"}
                    </Button>
                  </div>
                </div>
              </Show>

              <div class="vault-legend faint">
                <span>
                  <i class="vault-swatch" data-mark="2" /> right place
                </span>
                <span>
                  <i class="vault-swatch" data-mark="1" /> in the word, elsewhere
                </span>
                <span>
                  <i class="vault-swatch" data-mark="0" /> not in it
                </span>
              </div>
            </div>

            <aside class="vault-side">
              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Your record</h3>
                <dl class="vault-figures">
                  <Figure label="Played" value={state().record.played} />
                  <Figure label="Cracked" value={state().record.played ? `${Math.round((state().record.cracked / state().record.played) * 100)}%` : "–"} />
                  <Figure label="In a row" value={state().record.streak} />
                  <Figure label="Best run" value={state().record.best} />
                </dl>
                <Show when={state().record.cracked > 0}>
                  <div class="vault-spread" role="img" aria-label={`Tries needed: ${state().record.spread.map((count, index) => `${count} in ${index + 1}`).join(", ")}`}>
                    <For each={state().record.spread}>
                      {(count, index) => (
                        <div class="vault-spread-row">
                          <span class="faint num">{index() + 1}</span>
                          <span class="vault-bar" style={{ width: `${(count / Math.max(...state().record.spread)) * 100}%` }} data-today={state().solved && over() && state().rows.length === index() + 1 ? "" : undefined} />
                          <span class="muted num">{count}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="flex flex-col gap-3">
                <h3 class="strong m-0 text-[13px]">Today in the office</h3>
                <Show when={state().office.length} fallback={<div class="faint">Nobody has had a go yet. Everyone's word is different, so there's nothing to copy.</div>}>
                  <ul class="vault-office">
                    <For each={state().office}>
                      {(person) => (
                        <li>
                          <Avatar src={person.image ?? undefined} fallback={person.name} size="small" />
                          <span class="flex-1 min-w-0 truncate">{person.id === props.me.user.id ? "You" : person.name}</span>
                          <span class="vault-mini" aria-hidden="true">
                            <For each={person.marks}>{(marks) => <span>{[...marks].map((mark) => <i data-mark={mark} />)}</span>}</For>
                          </span>
                          <span class="num w-16 text-right whitespace-nowrap" classList={{ muted: !person.solved }}>
                            {person.solved ? `${person.marks.length}/${TRIES}` : person.marks.length >= TRIES ? "shut out" : "at it"}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
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
