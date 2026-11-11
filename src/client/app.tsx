import { Avatar } from "@opencode/ui/avatar"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Field } from "@opencode/ui/field"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Switch as Toggle } from "@opencode/ui/switch"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, createResource, createRoot, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { CENTRAL, currency, HOUSE, type Config, type CustomEmoji, type Entry, type History, type Me } from "../shared/types"
import { api, ApiError, BASE, type Person } from "./api"
import { EconomyView } from "./economy"

export function App() {
  const [me, { refetch }] = createResource(() =>
    api.me().catch((error) => {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }),
  )
  return (
    <Switch fallback={<Centered>Loading…</Centered>}>
      <Match when={me.error}>
        <Centered>
          <span class="danger">{String(me.error?.message ?? me.error)}</span>
        </Centered>
      </Match>
      <Match when={me() === null}>
        <Landing />
      </Match>
      <Match when={me() && !me()!.installed}>
        <NotInstalled me={me()!} />
      </Match>
      <Match when={me()}>{(value) => <Dashboard me={value()} refresh={refetch} />}</Match>
    </Switch>
  )
}

function Centered(props: { children: JSX.Element }) {
  return <div class="min-h-screen flex items-center justify-center muted">{props.children}</div>
}

const bundled = `${BASE}/emoji/anomaly/coin-10.png`

function Coin(props: { size?: number; src?: string }) {
  return (
    <img
      src={props.src ?? bundled}
      alt=""
      width={props.size ?? 20}
      height={props.size ?? 20}
      class="block shrink-0 object-contain"
      style={{ width: `${props.size ?? 20}px`, height: `${props.size ?? 20}px` }}
    />
  )
}

/** The workspace's currency emoji, or nothing when the workspace hasn't uploaded it. */
function symbolUrl(me: Me) {
  return me.emoji[me.config.symbol] as string | undefined
}

/** An amount with the workspace's currency emoji, falling back to the currency's name. */
function Amount(props: { me: Me; value: number; prefix?: string; size?: number }) {
  return (
    <span class="inline-flex items-center gap-1 whitespace-nowrap num">
      {props.prefix}
      {props.value}
      <Show when={symbolUrl(props.me)} fallback={<span>{Math.abs(props.value) === 1 ? props.me.config.singular : props.me.config.plural}</span>}>
        {(src) => <Coin src={src()} size={props.size ?? 16} />}
      </Show>
    </span>
  )
}

function Brand(props: { src?: string; children?: JSX.Element }) {
  return (
    <div class="flex items-center gap-2 min-w-0 brand">
      <Coin size={22} src={props.src} />
      <span>bank</span>
      {props.children}
    </div>
  )
}

function ButtonLink(props: { href: string; variant?: string; size?: string; children: JSX.Element }) {
  return (
    <a href={props.href} data-component="button-v2" data-variant={props.variant ?? "neutral"} data-size={props.size ?? "normal"}>
      {props.children}
    </a>
  )
}

function Code(props: { children: JSX.Element }) {
  return <span class="code">{props.children}</span>
}

function errorFromUrl() {
  const error = new URLSearchParams(location.search).get("error")
  if (!error) return null
  if (error === "access_denied") return "Slack sign in was cancelled."
  if (error === "state") return "That sign in link expired, try again."
  if (error === "org_install") return "Bank can't be installed across a whole Enterprise Grid org yet. Install it in one workspace."
  // Never echo the parameter itself: a crafted link could make the page say anything.
  return "Something went wrong signing in with Slack. Try again."
}

// ---------- signed out

function Landing() {
  const error = errorFromUrl()
  return (
    <div class="page max-w-[760px] py-16 sm:py-24 flex flex-col gap-14">
      <div class="flex flex-col gap-5">
        <Brand />
        <h1 class="hero m-0">A tiny currency for your Slack.</h1>
        <p class="muted m-0 text-[15px] leading-6 max-w-[520px]">
          Everyone gets 100 coins. Give them away when someone helps you out, with a reaction or <Code>/bank give</Code>.
          Spend them on whatever your team decides they're worth.
        </p>
        <div class="flex flex-wrap gap-2 pt-1">
          <ButtonLink href={`${BASE}/install`} variant="contrast" size="large">
            Add to Slack
          </ButtonLink>
          <ButtonLink href={`${BASE}/login`} size="large">
            Sign in with Slack
          </ButtonLink>
        </div>
        <Show when={error}>
          <p class="danger m-0">{error}</p>
        </Show>
      </div>

      <div class="grid sm:grid-cols-3 gap-3">
        <Feature title="React to give">
          Add a coin emoji to someone's message and that many coins move from you to them. Gifts are final, removing the reaction
          doesn't take it back.
        </Feature>
        <Feature title="Or use the command">
          <Code>/bank give @adam 10 for the fix</Code> posts it in the channel for everyone to see.
        </Feature>
        <Feature title="Make it yours">
          Admins rename the currency, set the starting balance, choose which emoji are worth what, and adjust balances.
        </Feature>
      </div>

      <EmojiPack />
    </div>
  )
}

function Feature(props: { title: string; children: JSX.Element }) {
  return (
    <div class="card p-4 flex flex-col gap-1">
      <div class="strong">{props.title}</div>
      <div class="muted">{props.children}</div>
    </div>
  )
}

const coins = [1, 5, 10, 20]

function EmojiPack(props: { domain?: string | null }) {
  return (
    <Panel
      title="Anomaly coins"
      description={
        <>
          Slack doesn't let apps upload emoji, so add these yourself. Download each coin and upload it under the same name and the
          default reactions just work.
        </>
      }
      action={
        <Show when={props.domain}>
          <ButtonLink href={`https://${props.domain}.slack.com/customize/emoji`}>Add emoji in Slack</ButtonLink>
        </Show>
      }
    >
      <div class="px-4 pb-4 grid grid-cols-4 gap-2">
        <For each={coins}>
          {(value) => (
            <a class="coin" href={`${BASE}/emoji/anomaly/coin-${value}.png`} download={`coin-${value}.png`} title={`Download coin-${value}.png`}>
              <img src={`${BASE}/emoji/anomaly/coin-${value}.png`} width={48} height={48} alt={`coin-${value}`} />
              <span class="coin-name">:coin-{value}:</span>
              <span class="coin-action">Download</span>
            </a>
          )}
        </For>
      </div>
    </Panel>
  )
}

function NotInstalled(props: { me: Me }) {
  return (
    <div class="page max-w-[560px] py-24 flex flex-col gap-4">
      <Brand />
      <h1 class="hero m-0 text-[32px] leading-9">Bank isn't in {props.me.team.name} yet.</h1>
      <p class="muted m-0">Install it to give everyone their starting coins. Whoever installs it becomes the first admin.</p>
      <div class="flex gap-2">
        <ButtonLink href={`${BASE}/install`} variant="contrast" size="large">
          Add to Slack
        </ButtonLink>
        <ButtonLink href={`${BASE}/logout`} variant="ghost" size="large">
          Sign out
        </ButtonLink>
      </div>
    </div>
  )
}

// ---------- signed in

function Dashboard(props: { me: Me; refresh: () => void }) {
  const config = () => props.me.config
  const [tab, setTab] = createSignal("leaderboard")
  const [leaderboard, leaderboardActions] = createResource(() => api.leaderboard())
  const [history, historyActions] = createResource(() => api.history())
  const [economy, economyActions] = createResource(() => api.economy())
  const reload = () => {
    props.refresh()
    leaderboardActions.refetch()
    historyActions.refetch()
    economyActions.refetch()
  }
  const balance = () => props.me.account?.balance ?? 0

  return (
    <div class="page max-w-[760px] py-6 sm:py-8 flex flex-col gap-6">
      <header class="flex items-center justify-between gap-3 h-8">
        <Brand src={symbolUrl(props.me)}>
          <span class="faint">/</span>
          <span class="truncate">{props.me.team.name}</span>
        </Brand>
        <div class="flex items-center gap-2 shrink-0">
          <span class="muted hidden sm:inline">{props.me.user.name}</span>
          <Avatar src={props.me.user.image ?? undefined} fallback={props.me.user.name} size="large" />
          <ButtonLink href={`${BASE}/logout`} variant="ghost-muted" size="small">
            Sign out
          </ButtonLink>
        </div>
      </header>

      <section class="card p-5 flex items-end justify-between gap-x-6 gap-y-4 flex-wrap">
        <div class="flex flex-col gap-1">
          <span class="muted">Your balance</span>
          <div class="flex items-center gap-2.5">
            <span class="display">{balance()}</span>
            <Show when={symbolUrl(props.me)}>{(src) => <Coin src={src()} size={32} />}</Show>
            <span class="muted text-[15px] self-end pb-1.5">{balance() === 1 ? config().singular : config().plural}</span>
          </div>
        </div>
        <div class="flex gap-8">
          <Stat label="Received" value={props.me.account?.received ?? 0} />
          <Stat label="Given" value={props.me.account?.given ?? 0} />
        </div>
      </section>

      <div class="flex flex-col gap-4">
        <Tabs value={tab()} onChange={setTab} variant="line" class="tabs">
          <Tabs.List>
            <Tabs.Trigger value="leaderboard">Leaderboard</Tabs.Trigger>
            <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
            <Tabs.Trigger value="economy">Economy</Tabs.Trigger>
            <Tabs.Trigger value="give">Give</Tabs.Trigger>
            <Show when={props.me.admin}>
              <Tabs.Trigger value="admin">Admin</Tabs.Trigger>
            </Show>
          </Tabs.List>
        </Tabs>

        <Switch>
          <Match when={tab() === "leaderboard"}>
            <LeaderboardView me={props.me} accounts={leaderboard()?.accounts} />
          </Match>
          <Match when={tab() === "activity"}>
            <ActivityView me={props.me} history={history()} />
          </Match>
          <Match when={tab() === "economy"}>
            <EconomyView config={config()} economy={economy()} />
          </Match>
          <Match when={tab() === "give"}>
            <GiveView me={props.me} done={reload} />
          </Match>
          <Match when={tab() === "admin"}>
            <AdminView me={props.me} changed={reload} />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: number }) {
  return (
    <div class="flex flex-col sm:items-end">
      <span class="faint">{props.label}</span>
      <span class="num strong text-[15px]">{props.value}</span>
    </div>
  )
}

function Panel(props: {
  title?: string
  description?: JSX.Element
  action?: JSX.Element
  /** Let popovers inside the panel spill past its edges. */
  overflow?: boolean
  children?: JSX.Element
}) {
  return (
    <section class="card" classList={{ "overflow-hidden": !props.overflow }}>
      <Show when={props.title}>
        <div class="p-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div class="flex-1 min-w-[min(100%,20rem)] flex flex-col gap-0.5">
            <h2 class="strong m-0 text-[13px] leading-5 min-h-7 flex items-center">{props.title}</h2>
            <Show when={props.description}>
              <div class="muted text-pretty">{props.description}</div>
            </Show>
          </div>
          <Show when={props.action}>
            <div class="flex items-center gap-2 shrink-0 min-h-7">{props.action}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </section>
  )
}

function Empty(props: { children: JSX.Element }) {
  return <div class="px-4 py-8 text-center faint">{props.children}</div>
}

function LeaderboardView(props: { me: Me; accounts: Me["account"][] | undefined }) {
  return (
    <Panel>
      <Show when={props.accounts} fallback={<Empty>Loading…</Empty>}>
        <Show when={props.accounts!.length} fallback={<Empty>Nobody has any yet.</Empty>}>
          <div>
            <For each={props.accounts}>
              {(account, index) => (
                <div class="row flex items-center gap-3 px-4 py-2.5" classList={{ self: account!.id === props.me.user.id }}>
                  <span class="num faint w-6 text-right shrink-0">{index() + 1}</span>
                  <Avatar src={account!.image ?? undefined} fallback={account!.name} size="large" />
                  <span class="flex-1 min-w-0 flex items-center gap-2">
                    <span class="truncate">{account!.name}</span>
                    <Show when={account!.id === props.me.user.id}>
                      <Badge variant="subtle">You</Badge>
                    </Show>
                  </span>
                  <span class="faint num hidden sm:inline">{account!.received} received</span>
                  <span class="strong min-w-16 flex justify-end">
                    <Amount me={props.me} value={account!.balance} />
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </Panel>
  )
}

function ago(at: number) {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`
  return new Date(at).toLocaleDateString()
}

function describe(entry: Entry, history: History, viewer: string | null) {
  const name = (id: string | null) => (id ? (id === viewer ? "you" : (history.people[id]?.name ?? id)) : "the bank")
  const possessive = (id: string | null) => (id && id === viewer ? "your" : `${name(id)}'s`)
  const via = entry.kind === "reaction" ? " with a reaction" : ""
  switch (entry.kind) {
    case "grant":
      return `${name(entry.to)} got a starting balance`
    case "adjust":
      return entry.to
        ? `${name(entry.actor)} added to ${possessive(entry.to)} balance`
        : `${name(entry.actor)} took from ${possessive(entry.from)} balance`
    case "refund":
      return `${name(entry.from)} got back a reaction from ${name(entry.to)}`.replace(/^you got back/, "you returned")
    case "bet":
      return `${name(entry.from)} staked on ${entry.note === "lottery" ? "lottery tickets" : (entry.note ?? "a bet")}`
    case "payout":
      return `${name(entry.to)} won at ${entry.note === "lottery" ? "the lottery" : (entry.note ?? "the casino")}`
    case "duel":
      return `${name(entry.to)} beat ${name(entry.from)} in a duel`
    case "sweep":
      return "the house paid its winnings to the central bank"
    case "stimulus":
      return `the central bank paid ${name(entry.to)}`
    default:
      return `${name(entry.from)} gave ${name(entry.to)}${via}`
  }
}

/** Entries whose note is written by Bank and already part of the description. */
function fixedNote(entry: Entry) {
  return ["grant", "bet", "payout", "duel", "sweep", "stimulus"].includes(entry.kind)
}

const page = 30

function ActivityList(props: { history: History | undefined; me: Me; viewer: string | null; onRedact?: (id: number) => void }) {
  const [limit, setLimit] = createSignal(page)
  const entries = () => props.history?.entries ?? []
  return (
    <Show when={props.history} fallback={<Empty>Loading…</Empty>}>
      <Show when={entries().length} fallback={<Empty>Nothing yet.</Empty>}>
        <div>
          <For each={entries().slice(0, limit())}>
            {(entry) => {
              const incoming = () => props.viewer !== null && entry.to === props.viewer
              const outgoing = () => props.viewer !== null && entry.from === props.viewer
              const other = () => (incoming() ? entry.from : entry.to)
              const person = () => (other() ? props.history!.people[other()!] : undefined)
              return (
                <div class="row flex items-center gap-3 px-4 py-2.5">
                  <Show when={other()} fallback={<span class="bank-avatar"><Coin src={symbolUrl(props.me)} size={20} /></span>}>
                    <Avatar src={person()?.image ?? undefined} fallback={person()?.name ?? "?"} size="large" />
                  </Show>
                  <div class="flex-1 min-w-0 flex flex-col">
                    <span class="truncate">{describe(entry, props.history!, props.viewer)}</span>
                    <span class="faint truncate">
                      {ago(entry.at)}
                      <Show when={entry.note && !fixedNote(entry)}> · {entry.note}</Show>
                      <Show when={props.onRedact && entry.note && entry.note !== "redacted" && !fixedNote(entry)}>
                        {" · "}
                        <button type="button" class="link bg-transparent border-0 p-0 cursor-pointer" onClick={() => props.onRedact!(entry.id)}>
                          redact
                        </button>
                      </Show>
                      <Show when={entry.link}>
                        {" · "}
                        <a class="link" href={entry.link!} target="_blank" rel="noreferrer">
                          message
                        </a>
                      </Show>
                    </span>
                  </div>
                  <span class="strong" classList={{ positive: incoming(), muted: !incoming() && !outgoing() }}>
                    <Amount me={props.me} value={entry.amount} prefix={incoming() ? "+" : outgoing() ? "−" : ""} />
                  </span>
                </div>
              )
            }}
          </For>
          <Show when={entries().length > limit()}>
            <div class="row px-4 py-2 flex justify-center">
              <Button variant="ghost-muted" size="small" onClick={() => setLimit((value) => value + page * 2)}>
                Show more · {entries().length - limit()} left
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  )
}

function ActivityView(props: { me: Me; history: History | undefined }) {
  return (
    <Panel>
      <ActivityList history={props.history} me={props.me} viewer={props.me.user.id} />
    </Panel>
  )
}

// ---------- give

// Everyone in the workspace, loaded once the first time a picker needs it and shared by every picker.
let directory: (() => Person[] | undefined) | undefined
function people() {
  directory ??= createRoot(() => createResource(() => api.people())[0])
  return directory()
}

function PersonPicker(props: { value: Person | null; onChange: (person: Person | null) => void; exclude?: string }) {
  const [query, setQuery] = createSignal("")
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const matches = createMemo(() => {
    const text = query().trim().toLowerCase()
    if (!text) return []
    return (people() ?? [])
      .filter((person) => person.id !== props.exclude && person.name.toLowerCase().includes(text))
      .slice(0, 8)
  })
  const choose = (person: Person) => {
    props.onChange(person)
    setQuery("")
    setOpen(false)
  }
  const keydown = (event: KeyboardEvent) => {
    const count = matches().length
    if (event.key === "ArrowDown" && count) {
      event.preventDefault()
      setActive((index) => (index + 1) % count)
    }
    if (event.key === "ArrowUp" && count) {
      event.preventDefault()
      setActive((index) => (index - 1 + count) % count)
    }
    if (event.key === "Enter" && open() && count) {
      event.preventDefault()
      choose(matches()[Math.min(active(), count - 1)]!)
    }
    if (event.key === "Escape") setOpen(false)
  }
  return (
    <Show
      when={props.value}
      fallback={
        <div class="relative w-full">
          <TextInput
            class="w-full"
            leadingIcon={<Icon name="magnifying-glass" size="small" />}
            placeholder={people() ? "Search people" : "Loading people…"}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={keydown}
          />
          <Show when={open() && query().trim()}>
            <div class="popover" role="listbox">
              <Show when={matches().length} fallback={<div class="px-2 py-1.5 faint">No one matches “{query().trim()}”</div>}>
                <For each={matches()}>
                  {(person, index) => (
                    <button
                      type="button"
                      role="option"
                      class="option"
                      aria-selected={index() === active()}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(index())}
                      onClick={() => choose(person)}
                    >
                      <Avatar src={person.image ?? undefined} fallback={person.name} size="normal" />
                      <span class="truncate">{person.name}</span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      }
    >
      {(person) => (
        <div class="chosen">
          <Avatar src={person().image ?? undefined} fallback={person().name} size="normal" />
          <span class="flex-1 truncate">{person().name}</span>
          <Button variant="ghost-muted" size="small" onClick={() => props.onChange(null)}>
            Change
          </Button>
        </div>
      )}
    </Show>
  )
}

function Label(props: { text: string; hint?: string; class?: string; children: JSX.Element }) {
  return (
    <Field class={props.class}>
      <Field.Label>
        {props.text}
        <Show when={props.hint}>
          <span class="faint font-normal ml-1">{props.hint}</span>
        </Show>
      </Field.Label>
      {props.children}
    </Field>
  )
}

function Status(props: { value: { kind: "error" | "ok"; text: string } | null }) {
  return (
    <Show when={props.value}>
      {(value) => (
        <span class="min-w-0" classList={{ danger: value().kind === "error", positive: value().kind === "ok" }}>
          {value().text}
        </span>
      )}
    </Show>
  )
}

function AmountFields(props: {
  amount: string
  setAmount: (value: string) => void
  note: string
  setNote: (value: string) => void
  noteLabel: string
  notePlaceholder?: string
  symbol?: string
}) {
  return (
    <div class="grid grid-cols-[112px_1fr] gap-3">
      <Label text="Amount">
        <TextInput
          class="w-full"
          numeric
          inputmode="numeric"
          placeholder="10"
          value={props.amount}
          onInput={(event) => props.setAmount(event.currentTarget.value.replace(/[^0-9]/g, ""))}
          trailing={
            <Show when={props.symbol}>
              {(src) => (
                <span class="pr-1">
                  <Coin src={src()} size={16} />
                </span>
              )}
            </Show>
          }
        />
      </Label>
      <Label text={props.noteLabel} hint="optional">
        <TextInput
          class="w-full"
          placeholder={props.notePlaceholder}
          value={props.note}
          onInput={(event) => props.setNote(event.currentTarget.value)}
        />
      </Label>
    </div>
  )
}

function GiveView(props: { me: Me; done: () => void }) {
  const [person, setPerson] = createSignal<Person | null>(null)
  const [amount, setAmount] = createSignal("")
  const [note, setNote] = createSignal("")
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const submit = async (event: Event) => {
    event.preventDefault()
    if (!person()) return setStatus({ kind: "error", text: "Pick someone first." })
    setBusy(true)
    setStatus(null)
    try {
      await api.give(person()!.id, Number(amount()), note())
      setStatus({ kind: "ok", text: `Sent ${currency(props.me.config, Number(amount()))} to ${person()!.name}.` })
      setAmount("")
      setNote("")
      setPerson(null)
      props.done()
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel
      overflow
      title={`Give ${props.me.config.plural}`}
      description={
        <>
          Or use <Code>/bank give @someone 10</Code> in Slack.
        </>
      }
    >
      <form class="px-4 pb-4 flex flex-col gap-4 max-w-[520px]" onSubmit={submit}>
        <Label text="To">
          <PersonPicker value={person()} onChange={setPerson} exclude={props.me.user.id} />
        </Label>
        <AmountFields
          amount={amount()}
          setAmount={setAmount}
          note={note()}
          setNote={setNote}
          noteLabel="For"
          notePlaceholder="fixing the deploy"
          symbol={symbolUrl(props.me)}
        />
        <div class="flex items-center gap-3">
          <Button type="submit" variant="contrast" disabled={busy() || !amount() || !person()}>
            {busy() ? "Sending…" : "Give"}
          </Button>
          <Status value={status()} />
        </div>
      </form>
    </Panel>
  )
}

// ---------- admin

function EmojiImage(props: { url: string | undefined; size?: number }) {
  return (
    <Show
      when={props.url}
      fallback={
        <span class="emoji-missing" title="Not a custom emoji in your workspace">
          ?
        </span>
      }
    >
      {(url) => <Coin src={url()} size={props.size ?? 20} />}
    </Show>
  )
}

function EmojiField(props: {
  value: string
  onChange: (name: string) => void
  urls: Map<string, string>
  custom: CustomEmoji[] | undefined
}) {
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const shown = createMemo(() => {
    const text = filter().trim().toLowerCase().replace(/:/g, "")
    return (props.custom ?? []).filter((item) => !text || item.name.includes(text)).slice(0, 120)
  })
  return (
    <div class="relative w-full">
      <TextInput
        class="w-full"
        placeholder="emoji-name"
        value={props.value}
        leadingIcon={<EmojiImage url={props.urls.get(props.value)} size={16} />}
        onInput={(event) => props.onChange(event.currentTarget.value.replace(/[:\s]/g, ""))}
        trailing={
          <IconButton
            size="small"
            variant="ghost-muted"
            aria-label="Pick an emoji"
            aria-expanded={open()}
            icon={<Icon name="chevron-down" size="small" />}
            onClick={() => setOpen((value) => !value)}
          />
        }
      />
      <Show when={open()}>
        <div class="fixed inset-0 z-10" onClick={() => setOpen(false)} />
        <div class="popover emoji-popover">
          <TextInput
            class="w-full"
            appearance="small"
            leadingIcon={<Icon name="magnifying-glass" size="small" />}
            placeholder="Filter emoji"
            value={filter()}
            ref={(element) => queueMicrotask(() => element.focus())}
            onInput={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
          />
          <Show when={props.custom} fallback={<Empty>Loading emoji…</Empty>}>
            <Show when={shown().length} fallback={<Empty>No custom emoji match.</Empty>}>
              <div class="picker px-0 pb-0">
                <For each={shown()}>
                  {(item) => (
                    <button
                      type="button"
                      class="pick"
                      aria-pressed={item.name === props.value}
                      title={`:${item.name}:`}
                      onClick={() => {
                        props.onChange(item.name)
                        setOpen(false)
                      }}
                    >
                      <img class="emoji block" src={item.url} alt={item.name} loading="lazy" />
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function AdminView(props: { me: Me; changed: () => void }) {
  return (
    <div class="flex flex-col gap-4">
      <SettingsPanel me={props.me} changed={props.changed} />
      <EmojiPack domain={props.me.team.domain} />
      <AdjustPanel me={props.me} changed={props.changed} />
      <PrintPanel me={props.me} changed={props.changed} />
      <AdminsPanel me={props.me} />
      <ChannelsPanel />
      <ImportPanel changed={props.changed} />
      <AllActivityPanel me={props.me} />
    </div>
  )
}

function SettingsPanel(props: { me: Me; changed: () => void }) {
  const [saved, setSaved] = createSignal<Config>(structuredClone(props.me.config))
  const [draft, setDraft] = createStore<Config>(structuredClone(props.me.config))
  const [custom] = createResource(() => api.emoji().catch(() => []))
  const urls = createMemo(
    () => new Map([...Object.entries(props.me.emoji), ...(custom() ?? []).map((item) => [item.name, item.url] as const)]),
  )
  const [filter, setFilter] = createSignal("")
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const dirty = createMemo(() => JSON.stringify(draft) !== JSON.stringify(saved()))
  const used = createMemo(() => new Set(draft.emoji.map((item) => item.name)))

  const save = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await api.saveConfig(unwrap(draft))
      setDraft(reconcile(structuredClone(result)))
      setSaved(structuredClone(result))
      setStatus({ kind: "ok", text: "Saved." })
      props.changed()
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (name: string) => {
    setStatus(null)
    if (used().has(name)) return setDraft("emoji", (list) => list.filter((item) => item.name !== name))
    setDraft("emoji", (list) => [...list, { name, amount: 1 }])
  }

  const matching = createMemo(() => {
    const text = filter().trim().toLowerCase().replace(/:/g, "")
    return (custom() ?? []).filter((item) => !text || item.name.includes(text))
  })
  const shown = createMemo(() => matching().slice(0, 120))

  return (
    <Panel overflow title="Currency" description="What it's called, how much everyone starts with, and which reactions give how much.">
      <div class="px-4 pb-5 flex flex-col gap-6">
        <div class="flex flex-col gap-2">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Label text="Singular">
              <TextInput class="w-full" value={draft.singular} onInput={(event) => setDraft("singular", event.currentTarget.value)} />
            </Label>
            <Label text="Plural">
              <TextInput class="w-full" value={draft.plural} onInput={(event) => setDraft("plural", event.currentTarget.value)} />
            </Label>
            <Label text="Symbol">
              <EmojiField value={draft.symbol} onChange={(name) => setDraft("symbol", name)} urls={urls()} custom={custom()} />
            </Label>
            <Label text="Starting balance">
              <TextInput
                class="w-full"
                numeric
                inputmode="numeric"
                value={String(draft.starting)}
                onInput={(event) => setDraft("starting", Number(event.currentTarget.value.replace(/[^0-9]/g, "")) || 0)}
              />
            </Label>
          </div>
          <p class="faint m-0">The starting balance applies to people the first time Bank sees them. Existing balances don't change.</p>
        </div>

        <div class="setting">
          <div class="min-w-0">
            <div class="strong">Notify on reaction gifts</div>
            <div class="muted">Bank messages people when someone gives them {draft.plural} with a reaction.</div>
          </div>
          <Toggle
            checked={draft.notify}
            onChange={(value: boolean) => setDraft("notify", value)}
            aria-label="Message people when they get a reaction gift"
          />
        </div>

        <div class="setting">
          <div class="min-w-0">
            <div class="strong">Casino</div>
            <div class="muted">
              Coin flips, slots, duels and a daily lottery, all listed under <Code>/bank casino</Code>. Results are posted
              where the command is run. The house needs a bankroll before it will take a bet.
            </div>
          </div>
          <Toggle checked={draft.games.enabled} onChange={(value: boolean) => setDraft("games", "enabled", value)} aria-label="Open the casino" />
        </div>

        <Show when={draft.games.enabled}>
          <div class="flex flex-col gap-2">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Label text="Biggest bet">
                <TextInput
                  class="w-full"
                  numeric
                  inputmode="numeric"
                  value={String(draft.games.maxBet)}
                  onInput={(event) => setDraft("games", "maxBet", Number(event.currentTarget.value.replace(/[^0-9]/g, "")) || 0)}
                />
              </Label>
              <Label text="House reserve">
                <TextInput
                  class="w-full"
                  numeric
                  inputmode="numeric"
                  value={String(draft.games.reserve)}
                  onInput={(event) => setDraft("games", "reserve", Number(event.currentTarget.value.replace(/[^0-9]/g, "")) || 0)}
                />
              </Label>
            </div>
            <p class="faint m-0">
              The house keeps its reserve to pay winners. At the daily draw, whatever it won beyond that goes to the central
              bank, which puts a tenth of what it holds into the lottery pot.
            </p>
          </div>
        </Show>

        <div class="flex flex-col gap-2">
          <div class="flex items-baseline justify-between gap-3">
            <span class="strong">Reactions</span>
            <span class="faint">Each reaction moves this many {draft.plural}</span>
          </div>
          <div class="inset">
            <For each={draft.emoji} fallback={<Empty>No reactions set up yet. Pick some emoji below.</Empty>}>
              {(item, index) => (
                <div class="row flex items-center gap-2 px-2 py-1.5">
                  <span class="emoji-slot">
                    <EmojiImage url={urls().get(item.name)} />
                  </span>
                  <TextInput
                    class="flex-1 min-w-0 w-auto"
                    surface="invisible"
                    aria-label="Emoji name"
                    placeholder="emoji-name"
                    value={item.name}
                    onInput={(event) => setDraft("emoji", index(), "name", event.currentTarget.value.replace(/[:\s]/g, ""))}
                  />
                  <TextInput
                    class="w-[104px] shrink-0"
                    numeric
                    inputmode="numeric"
                    aria-label="Amount"
                    value={String(item.amount)}
                    onInput={(event) =>
                      setDraft("emoji", index(), "amount", Number(event.currentTarget.value.replace(/[^0-9]/g, "")) || 0)
                    }
                    trailing={<span class="faint pr-1 truncate max-w-12">{item.amount === 1 ? draft.singular : draft.plural}</span>}
                  />
                  <IconButton
                    variant="ghost-muted"
                    aria-label={`Remove :${item.name}:`}
                    title="Remove"
                    icon={<Icon name="outline-trash" size="small" />}
                    onClick={() => setDraft("emoji", (list) => list.filter((_, i) => i !== index()))}
                  />
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div class="flex flex-col">
              <span class="strong">Your workspace's emoji</span>
              <span class="faint">Click one to add it as a reaction, click again to remove it.</span>
            </div>
            <TextInput
              class="w-full sm:w-52"
              appearance="small"
              leadingIcon={<Icon name="magnifying-glass" size="small" />}
              placeholder="Filter emoji"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          </div>
          <div class="inset">
            <Show when={custom()} fallback={<Empty>Loading emoji…</Empty>}>
              <Show when={custom()!.length} fallback={<Empty>No custom emoji yet. Add some in Slack, then reload.</Empty>}>
                <Show when={shown().length} fallback={<Empty>No emoji match “{filter().trim()}”.</Empty>}>
                  <div class="picker">
                    <For each={shown()}>
                      {(item) => (
                        <button
                          type="button"
                          class="pick"
                          aria-pressed={used().has(item.name)}
                          title={`:${item.name}:`}
                          onClick={() => toggle(item.name)}
                        >
                          <img class="emoji block" src={item.url} alt={item.name} loading="lazy" />
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={matching().length > shown().length}>
                    <div class="row px-3 py-1.5 faint">
                      Showing {shown().length} of {matching().length}. Filter to find the rest.
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
      <div class="footer">
        <span class="flex-1 min-w-0">
          <Show when={status()} fallback={<span class="faint">{dirty() ? "You have unsaved changes." : ""}</span>}>
            <Status value={status()} />
          </Show>
        </span>
        <Show when={dirty()}>
          <Button
            variant="ghost-muted"
            onClick={() => {
              setDraft(reconcile(structuredClone(saved())))
              setStatus(null)
            }}
          >
            Discard
          </Button>
        </Show>
        <Button variant="contrast" onClick={save} disabled={busy() || !dirty()}>
          {busy() ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Panel>
  )
}

function AdjustPanel(props: { me: Me; changed: () => void }) {
  const [person, setPerson] = createSignal<Person | null>(null)
  const [amount, setAmount] = createSignal("")
  const [note, setNote] = createSignal("")
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const run = async (sign: 1 | -1) => {
    if (!person()) return setStatus({ kind: "error", text: "Pick someone first." })
    try {
      await api.adjust(person()!.id, sign * Number(amount()), note())
      setStatus({ kind: "ok", text: `${sign > 0 ? "Added" : "Removed"} ${currency(props.me.config, Number(amount()))}.` })
      setAmount("")
      setNote("")
      props.changed()
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    }
  }
  return (
    <Panel overflow title="Adjust a balance" description="Mint new coins for someone, or take some away.">
      <div class="px-4 pb-4 flex flex-col gap-4 max-w-[520px]">
        <Label text="Person">
          <PersonPicker value={person()} onChange={setPerson} />
        </Label>
        <AmountFields
          amount={amount()}
          setAmount={setAmount}
          note={note()}
          setNote={setNote}
          noteLabel="Reason"
          notePlaceholder="prize for the hackathon"
          symbol={symbolUrl(props.me)}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="contrast" disabled={!amount() || !person()} onClick={() => run(1)}>
            Add
          </Button>
          <Button variant="neutral" disabled={!amount() || !person()} onClick={() => run(-1)}>
            Remove
          </Button>
          <span class="ml-1">
            <Status value={status()} />
          </span>
        </div>
      </div>
    </Panel>
  )
}

function PrintPanel(props: { me: Me; changed: () => void }) {
  const [amount, setAmount] = createSignal("")
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const run = async (target: string, name: string, sign: 1 | -1) => {
    try {
      await api.adjust(target, sign * Number(amount()), "monetary policy")
      setStatus({ kind: "ok", text: `${sign > 0 ? "Printed" : "Destroyed"} ${currency(props.me.config, Number(amount()))} ${sign > 0 ? "for" : "from"} ${name}.` })
      setAmount("")
      props.changed()
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    }
  }
  return (
    <Panel
      title="Print money"
      description="Create coins for the casino's house or the central bank, or destroy some. Along with adjusting a balance, this is the only thing that changes how many coins exist."
    >
      <div class="px-4 pb-4 flex flex-col gap-4 max-w-[520px]">
        <Label text="Amount" class="max-w-[112px]">
          <TextInput
            class="w-full"
            numeric
            inputmode="numeric"
            placeholder="500"
            value={amount()}
            onInput={(event) => setAmount(event.currentTarget.value.replace(/[^0-9]/g, ""))}
          />
        </Label>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="contrast" disabled={!amount()} onClick={() => run(HOUSE, "the house", 1)}>
            Print for the house
          </Button>
          <Button variant="neutral" disabled={!amount()} onClick={() => run(CENTRAL, "the central bank", 1)}>
            Print for the central bank
          </Button>
          <Button variant="neutral" disabled={!amount()} onClick={() => run(CENTRAL, "the central bank", -1)}>
            Destroy from the central bank
          </Button>
          <span class="ml-1">
            <Status value={status()} />
          </span>
        </div>
      </div>
    </Panel>
  )
}

function AdminsPanel(props: { me: Me }) {
  const [admins, { refetch }] = createResource(() => api.admins())
  const [person, setPerson] = createSignal<Person | null>(null)
  const label = { installer: "Installed Bank", added: "Added", slack: "Slack admin" } as const
  return (
    <Panel overflow title="Admins" description="Whoever installed Bank, plus anyone an admin adds here. Slack admins aren't admins here unless added.">
      <div class="border-t divider">
        <Show when={admins()} fallback={<Empty>Loading…</Empty>}>
          <For each={admins()}>
            {(admin) => (
              <div class="row flex items-center gap-3 px-4 py-2.5 min-h-12">
                <Avatar src={admin.image ?? undefined} fallback={admin.name} size="large" />
                <span class="flex-1 min-w-0 truncate">{admin.name}</span>
                <Badge variant="subtle">{label[admin.source]}</Badge>
                <Show when={admin.source === "added" && admin.id !== props.me.user.id}>
                  <Button variant="ghost-muted" size="small" onClick={() => api.removeAdmin(admin.id).then(refetch)}>
                    Remove
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <div class="row px-4 py-3 flex items-center gap-2 bg-subtle rounded-b-[10px]">
          <div class="flex-1 min-w-0">
            <PersonPicker value={person()} onChange={setPerson} />
          </div>
          <Button
            disabled={!person()}
            onClick={() =>
              api.addAdmin(person()!.id).then(() => {
                setPerson(null)
                refetch()
              })
            }
          >
            Add admin
          </Button>
        </div>
      </div>
    </Panel>
  )
}

function ChannelsPanel() {
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const join = async () => {
    setBusy(true)
    try {
      const result = await api.join()
      setStatus({ kind: "ok", text: result.joined ? `Joined ${result.joined} channels.` : "Already in every public channel." })
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel
      title="Channels"
      description={
        <>
          Slack only tells Bank about reactions in channels it's in. Invite it with <Code>/invite @Bank</Code>, or join every public
          channel at once.
        </>
      }
      action={
        <Button onClick={join} disabled={busy()}>
          {busy() ? "Joining…" : "Join public channels"}
        </Button>
      }
    >
      <Show when={status()}>
        <div class="px-4 pb-4 -mt-1">
          <Status value={status()} />
        </div>
      </Show>
    </Panel>
  )
}

function ImportPanel(props: { changed: () => void }) {
  let input!: HTMLInputElement
  const [status, setStatus] = createSignal<{ kind: "error" | "ok"; text: string } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const run = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setStatus(null)
    try {
      // Either a saved export with the admin history inside, or just the list of entries.
      const data = JSON.parse(await file.text())
      const entries = Array.isArray(data) ? data : (data.adminHistory?.entries ?? data.entries)
      if (!Array.isArray(entries)) throw new Error("That file has no history in it.")
      const result = await api.importHistory(entries)
      setStatus({ kind: "ok", text: `Imported ${result.imported} entries and kept ${result.kept} from here. Nobody's balance changed.` })
      props.changed()
    } catch (error) {
      setStatus({ kind: "error", text: (error as Error).message })
    } finally {
      setBusy(false)
      input.value = ""
    }
  }
  return (
    <Panel
      title="Import history"
      description="Moved here from another Bank? Its exported history replaces the adjustments that copied balances over, so everyone's received and given totals are real again. It refuses to run if it would change what anyone holds, and it only runs once."
      action={
        <Button variant="neutral" disabled={busy()} onClick={() => input.click()}>
          {busy() ? "Importing…" : "Choose export file"}
        </Button>
      }
    >
      <input ref={input} type="file" accept="application/json,.json" class="hidden" onChange={(event) => run(event.currentTarget.files?.[0])} />
      <Show when={status()}>
        <div class="px-4 pb-4">
          <Status value={status()} />
        </div>
      </Show>
    </Panel>
  )
}

function AllActivityPanel(props: { me: Me }) {
  const [history, { refetch }] = createResource(() => api.allHistory())
  const redact = async (id: number) => {
    if (!confirm("Replace this note with \"redacted\"? The coins stay as they are.")) return
    await api.redact(id)
    refetch()
  }
  return (
    <Panel title="Everything" description="Every transaction in the workspace, newest first.">
      <div class="border-t divider">
        <ActivityList history={history()} me={props.me} viewer={null} onRedact={redact} />
      </div>
    </Panel>
  )
}
