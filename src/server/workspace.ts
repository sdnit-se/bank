import { DurableObject } from "cloudflare:workers"
import {
  CENTS,
  defaultConfig,
  EMOJI_NAME,
  type Account,
  type Admin,
  type CasinoStats,
  type Config,
  type CustomEmoji,
  type Economy,
  type Entry,
  type EntryKind,
  type History,
  type MarketStats,
  type Me,
  type Portfolio,
  toCents,
} from "../shared/types"
import { casinoHelp, economy, historyLine, play, schedule, settle, setup, type Ledger } from "./casino"
import type { Env } from "./env"
import { market, marketHelp, marketStats, portfolio, setupMarket, tradeLine } from "./market"
import { convertToCents, inCents, money as currency } from "./money"
import { slack, SlackError } from "./slack"
import { casinoStats, sources } from "./stats"
import { interact, type Message } from "./tables"
import { levy, stimulus } from "./taxes"

export type Install = {
  token: string
  botUserId: string
  appId: string
  teamId: string
  teamName: string
  domain: string | null
  icon: string | null
  installer: string
  installedAt: number
}

export type Viewer = { id: string; name: string; image: string | null }

type AccountRow = {
  id: string
  name: string
  image: string | null
  bot: number
  balance: number
  received: number
  given: number
  slack_admin: number
  gone: number
}

type EntryRow = {
  id: number
  at: number
  kind: EntryKind
  from_id: string | null
  to_id: string | null
  amount: number
  note: string | null
  actor: string | null
  link: string | null
}

type SlackMember = {
  id: string
  name: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  is_app_user?: boolean
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  is_admin?: boolean
  is_owner?: boolean
  team_id?: string
  enterprise_user?: { teams?: string[] }
  profile?: { display_name?: string; real_name?: string; image_72?: string }
}

type Profile = {
  id: string
  name: string
  image: string | null
  bot: boolean
  deleted: boolean
  admin: boolean
  /** From another organization, through a Slack Connect channel. Never gets an account. */
  outsider: boolean
  /** A single- or multi-channel guest. Can hold coins, but gets no starting grant. */
  guest: boolean
}

type Move =
  | { ok: true; id: number; from: number | null; to: number | null }
  | { ok: false; reason: "insufficient" | "unknown"; balance: number }

export type SlackMessage = Message

type ReactionEvent = {
  type: "reaction_added" | "reaction_removed"
  user: string
  reaction: string
  item_user?: string
  item: { type: string; channel?: string; ts?: string }
}

type MemberEvent = { type: "team_join" | "user_change"; user: SlackMember }

/** The events the app subscribes to (see slack-manifest.json). */
export type EventEnvelope = {
  event_id: string
  event:
    | ReactionEvent
    | MemberEvent
    | { type: "channel_created"; channel: { id: string } }
    | { type: "app_uninstalled" | "tokens_revoked" }
}

type SlackChannel = {
  id: string
  is_member?: boolean
  is_archived?: boolean
  is_shared?: boolean
  is_ext_shared?: boolean
  is_pending_ext_shared?: boolean
  is_org_shared?: boolean
}

/**
 * Channels shared with other organizations (Slack Connect, customer channels) or waiting to be. Bank never joins them
 * on its own; people can still invite it there by hand.
 */
function external(channel: SlackChannel) {
  return Boolean(channel.is_ext_shared || channel.is_pending_ext_shared || (channel.is_shared && !channel.is_org_shared))
}

/** User-written text goes into Slack messages escaped, so it can't ping @channel, mention people or fake links. */
function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/

export class Workspace extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists accounts (
        id text primary key,
        name text not null,
        image text,
        bot integer not null default 0,
        balance integer not null default 0,
        received integer not null default 0,
        given integer not null default 0,
        slack_admin integer not null default 0,
        created_at integer not null
      );
      create table if not exists entries (
        id integer primary key autoincrement,
        at integer not null,
        kind text not null,
        from_id text,
        to_id text,
        amount integer not null,
        note text,
        actor text,
        link text
      );
      create index if not exists entries_from on entries (from_id, id);
      create index if not exists entries_to on entries (to_id, id);
      create table if not exists reactions (
        key text primary key,
        from_id text not null,
        to_id text not null,
        amount integer not null
      );
      create table if not exists admins (id text primary key, source text not null, added_by text, at integer not null);
      create table if not exists events (id text primary key, at integer not null);
    `)
    const columns = this.sql.exec<{ name: string }>("pragma table_info(accounts)").toArray()
    if (!columns.some((column) => column.name === "gone")) {
      this.sql.exec("alter table accounts add column gone integer not null default 0")
    }
    setup(this.sql)
    setupMarket(this.sql)
    this.ctx.storage.transactionSync(() => convertToCents(this.sql))
  }

  /** What the casino is lent: see casino.ts. */
  private ledger(): Ledger {
    return {
      sql: this.sql,
      storage: this.ctx.storage,
      env: this.env,
      config: () => this.config(),
      row: (id) => this.row(id),
      ensure: (ids) => this.ensure(ids),
      move: (input) => this.move(input),
      meta: (key) => this.meta(key),
      setMeta: (key, value) => this.setMeta(key, value),
      call: (method, params) => this.call(method, params),
    }
  }

  /** A click on a button under one of the casino's messages. */
  async interaction(input: { user: string; action: string; value: string }): Promise<SlackMessage> {
    return interact(this.ledger(), input)
  }

  /** The daily lottery draw. */
  async alarm() {
    await settle(this.ledger())
  }

  async economy(): Promise<Economy> {
    return economy(this.ledger())
  }

  /** Where someone's coins came from, in coins. */
  private sourcesOf(id: string) {
    const found = sources(this.ledger(), id)
    return { colleagues: found.colleagues / CENTS, casino: found.casino / CENTS, market: found.market / CENTS, taxes: found.taxes / CENTS }
  }

  async casino(): Promise<CasinoStats> {
    return casinoStats(this.ledger())
  }

  async market(): Promise<MarketStats> {
    return marketStats(this.ledger())
  }

  async portfolio(viewer: Viewer): Promise<Portfolio> {
    return portfolio(this.ledger(), viewer.id)
  }

  // ---------- storage helpers

  private meta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("select value from meta where key = ?", key).toArray()[0]
    return row ? (JSON.parse(row.value) as T) : null
  }

  private setMeta(key: string, value: unknown) {
    this.sql.exec("insert or replace into meta (key, value) values (?, ?)", key, JSON.stringify(value))
  }

  private install() {
    return this.meta<Install>("install")
  }

  /** The settings in cents, which is how everything in here counts. */
  private config(): Config {
    return inCents(this.settings())
  }

  /** The settings as an admin saved them and as the web app shows them, in coins. */
  private settings(): Config {
    const config = { ...defaultConfig, ...this.meta<Partial<Config>>("config") }
    // Configs saved before the symbol became an emoji held a literal character.
    if (!EMOJI_NAME.test(config.symbol)) config.symbol = defaultConfig.symbol
    config.games = { ...defaultConfig.games, ...config.games }
    config.market = { ...defaultConfig.market, ...config.market }
    config.taxes = { ...defaultConfig.taxes, ...config.taxes }
    return config
  }

  /** The workspace's custom emoji by name, with aliases resolved. Cached for five minutes. */
  private async emojiUrls(force = false): Promise<Record<string, string>> {
    const cached = this.meta<{ at: number; urls: Record<string, string> }>("emoji")
    if (cached && !force && Date.now() - cached.at < 5 * 60 * 1000) return cached.urls
    try {
      const result = await this.call<{ emoji: Record<string, string> }>("emoji.list")
      const urls: Record<string, string> = {}
      for (const [name, url] of Object.entries(result.emoji)) {
        const target = url.startsWith("alias:") ? result.emoji[url.slice(6)] : url
        if (target && !target.startsWith("alias:")) urls[name] = target
      }
      this.setMeta("emoji", { at: Date.now(), urls })
      return urls
    } catch (error) {
      console.error("emoji.list failed", error)
      return cached?.urls ?? {}
    }
  }

  private row(id: string) {
    return this.sql.exec<AccountRow>("select * from accounts where id = ?", id).toArray()[0] ?? null
  }

  private account(row: AccountRow): Account {
    return {
      id: row.id,
      name: row.name,
      image: row.image,
      balance: row.balance / CENTS,
      received: row.received / CENTS,
      given: row.given / CENTS,
    }
  }

  private entry(row: EntryRow): Entry {
    return {
      id: row.id,
      at: row.at,
      kind: row.kind,
      from: row.from_id,
      to: row.to_id,
      amount: row.amount / CENTS,
      note: row.note,
      actor: row.actor,
      link: row.link,
    }
  }

  private async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    const install = this.install()
    if (!install) throw new SlackError(method, "not_installed")
    return slack<T>(method, install.token, params)
  }

  private async profile(id: string): Promise<Profile | null> {
    try {
      const result = await this.call<{
        user: {
          id: string
          name: string
          real_name?: string
          is_bot?: boolean
          deleted?: boolean
          is_admin?: boolean
          is_owner?: boolean
          is_restricted?: boolean
          is_ultra_restricted?: boolean
          team_id?: string
          enterprise_user?: { teams?: string[] }
          profile?: { display_name?: string; real_name?: string; image_72?: string }
        }
      }>("users.info", { user: id })
      const user = result.user
      return {
        id: user.id,
        name: user.profile?.display_name || user.profile?.real_name || user.real_name || user.name,
        image: user.profile?.image_72 ?? null,
        bot: Boolean(user.is_bot) || user.id === "USLACKBOT",
        deleted: Boolean(user.deleted),
        admin: Boolean(user.is_admin || user.is_owner),
        outsider: this.outsider(user),
        guest: Boolean(user.is_restricted || user.is_ultra_restricted),
      }
    } catch (error) {
      console.error("users.info failed", id, error)
      return null
    }
  }

  /** True for people whose home workspace isn't this one, such as Slack Connect members from other companies. */
  private outsider(user: { team_id?: string; enterprise_user?: { teams?: string[] } }) {
    const team = this.install()?.teamId
    if (!team || !user.team_id) return true
    return user.team_id !== team && !(user.enterprise_user?.teams ?? []).includes(team)
  }

  /** Opens accounts for people seen for the first time, each with the starting grant. */
  private async ensure(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !this.row(id))
    const profiles = await Promise.all(missing.map((id) => this.profile(id)))
    const config = this.config()
    for (const profile of profiles) {
      if (!profile) continue
      if (profile.outsider) {
        console.log("outsider refused", { user: profile.id })
        continue
      }
      this.ctx.storage.transactionSync(() => {
        const created = this.sql.exec(
          "insert or ignore into accounts (id, name, image, bot, slack_admin, created_at) values (?, ?, ?, ?, ?, ?)",
          profile.id,
          profile.name,
          profile.image,
          profile.bot ? 1 : 0,
          profile.admin ? 1 : 0,
          Date.now(),
        ).rowsWritten
        if (!created || profile.bot || profile.deleted || profile.guest || config.starting <= 0) return
        this.sql.exec("update accounts set balance = ? where id = ?", config.starting, profile.id)
        this.sql.exec(
          "insert into entries (at, kind, to_id, amount, note) values (?, 'grant', ?, ?, ?)",
          Date.now(),
          profile.id,
          config.starting,
          "starting balance",
        )
      })
    }
    return new Map(ids.map((id) => [id, this.row(id)]))
  }

  /** Moves coins between accounts. A null side is the bank itself, for grants and admin adjustments. */
  private move(input: {
    from: string | null
    to: string | null
    amount: number
    kind: EntryKind
    note?: string | null
    actor?: string | null
    link?: string | null
  }): Move {
    return this.ctx.storage.transactionSync((): Move => {
      const from = input.from ? this.row(input.from) : null
      const to = input.to ? this.row(input.to) : null
      if ((input.from && !from) || (input.to && !to)) return { ok: false, reason: "unknown", balance: 0 }
      if (from && from.balance < input.amount) return { ok: false, reason: "insufficient", balance: from.balance }
      if (from) this.sql.exec("update accounts set balance = balance - ? where id = ?", input.amount, from.id)
      if (to) this.sql.exec("update accounts set balance = balance + ? where id = ?", input.amount, to.id)
      if (from && to && (input.kind === "give" || input.kind === "reaction")) {
        this.sql.exec("update accounts set given = given + ? where id = ?", input.amount, from.id)
        this.sql.exec("update accounts set received = received + ? where id = ?", input.amount, to.id)
      }
      // A refund goes from the person who got the gift back to the person who gave it, undoing both totals.
      if (from && to && input.kind === "refund") {
        this.sql.exec("update accounts set received = received - ? where id = ?", input.amount, from.id)
        this.sql.exec("update accounts set given = given - ? where id = ?", input.amount, to.id)
      }
      const id = this.sql
        .exec<{ id: number }>(
          "insert into entries (at, kind, from_id, to_id, amount, note, actor, link) values (?, ?, ?, ?, ?, ?, ?, ?) returning id",
          Date.now(),
          input.kind,
          input.from,
          input.to,
          input.amount,
          input.note ?? null,
          input.actor ?? null,
          input.link ?? null,
        )
        .one().id
      return {
        ok: true,
        id,
        from: input.from ? this.row(input.from)!.balance : null,
        to: input.to ? this.row(input.to)!.balance : null,
      }
    })
  }

  /**
   * Applies one Slack member to the ledger. Full members get an account with the starting grant the first time they're
   * seen; known accounts get their name, photo and admin flag refreshed. Deactivated people drop off the leaderboard but
   * keep their balance. Guests only get an account once they use Bank, and bots never do.
   */
  private applyMember(member: SlackMember, config: Config, now: number) {
    if (member.is_bot || member.is_app_user || member.id === "USLACKBOT") return
    // Bank's member list and user_change events include Slack Connect members of other companies. They never get an
    // account; one opened before this check is hidden and its coins go back to the bank.
    if (this.outsider(member)) return this.removeOutsider(member.id, now)
    const name = member.profile?.display_name || member.profile?.real_name || member.real_name || member.name
    const image = member.profile?.image_72 ?? null
    const admin = member.is_admin || member.is_owner ? 1 : 0
    const gone = member.deleted ? 1 : 0
    const known = this.row(member.id)
    if (known || gone || member.is_restricted || member.is_ultra_restricted) {
      if (known) {
        this.sql.exec(
          "update accounts set name = ?, image = ?, slack_admin = ?, gone = ? where id = ?",
          name,
          image,
          admin,
          gone,
          member.id,
        )
      }
      return
    }
    this.sql.exec(
      "insert into accounts (id, name, image, bot, slack_admin, created_at) values (?, ?, ?, 0, ?, ?)",
      member.id,
      name,
      image,
      admin,
      now,
    )
    if (config.starting <= 0) return
    this.sql.exec("update accounts set balance = ? where id = ?", config.starting, member.id)
    this.sql.exec(
      "insert into entries (at, kind, to_id, amount, note) values (?, 'grant', ?, ?, 'starting balance')",
      now,
      member.id,
      config.starting,
    )
  }

  /** Hides an account that turned out to belong to another organization and returns its coins to the bank. */
  private removeOutsider(id: string, now: number) {
    const known = this.row(id)
    if (!known || known.gone) return
    this.sql.exec("update accounts set gone = 1, balance = 0 where id = ?", id)
    if (known.balance > 0) {
      this.sql.exec(
        "insert into entries (at, kind, from_id, amount, note) values (?, 'adjust', ?, ?, 'not a member of this workspace')",
        now,
        id,
        known.balance,
      )
    }
    console.log("outsider removed", { user: id, balance: known.balance })
  }

  /** Reads the whole member list from Slack and applies everyone. */
  private async syncMembers() {
    const members: SlackMember[] = []
    let cursor: string | undefined
    do {
      const page = await this.call<{ members: SlackMember[]; response_metadata?: { next_cursor?: string } }>(
        "users.list",
        { limit: 200, cursor },
      )
      members.push(...page.members)
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    const config = this.config()
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      for (const member of members) this.applyMember(member, config, now)
    })
    // Accounts opened outside the member list (a reaction from a Slack Connect channel, say) get checked one by one.
    const listed = new Set(members.map((member) => member.id))
    const unlisted = this.sql
      .exec<{ id: string }>("select id from accounts where gone = 0 and bot = 0")
      .toArray()
      .filter((row) => !listed.has(row.id))
    for (const { id } of unlisted) {
      const profile = await this.profile(id)
      if (profile?.outsider) this.ctx.storage.transactionSync(() => this.removeOutsider(id, Date.now()))
    }
    this.setMeta("synced", now)
    return members.length
  }

  /**
   * Slack pushes joins and profile changes as events. This full sync only runs the first time and then daily, in the
   * background, as a safety net for events Slack failed to deliver.
   */
  private async freshen() {
    if (!this.install()?.token) return
    const synced = this.meta<number>("synced")
    if (!synced) {
      await this.syncMembers().catch((error) => console.error("sync failed", error))
      return
    }
    if (Date.now() - synced > 24 * 60 * 60 * 1000) {
      this.setMeta("synced", Date.now())
      this.ctx.waitUntil(this.syncMembers().catch((error) => console.error("sync failed", error)))
    }
    // Channel creation is pushed as an event; this daily pass catches anything missed, and workspaces installed
    // before Bank joined channels on its own.
    const joined = this.meta<number>("joined")
    if (!joined || Date.now() - joined > 24 * 60 * 60 * 1000) {
      this.setMeta("joined", Date.now())
      this.ctx.waitUntil(this.joinPublicChannels().catch((error) => console.error("join failed", error)))
    }
  }

  private isAdmin(id: string) {
    // Only the installer and people an admin added. Slack workspace admins get no say over the ledger by default.
    return this.sql.exec("select 1 from admins where id = ?", id).toArray().length > 0
  }

  // ---------- install and sign in

  async installed(data: Omit<Install, "installedAt">): Promise<Viewer> {
    // Only the first install makes someone an admin. Otherwise any member allowed to install apps could re-run the
    // install to promote themselves.
    const first = !this.install()
    this.setMeta("install", { ...data, installer: this.install()?.installer ?? data.installer, installedAt: Date.now() } satisfies Install)
    if (first) {
      this.sql.exec(
        "insert or ignore into admins (id, source, added_by, at) values (?, 'installer', null, ?)",
        data.installer,
        Date.now(),
      )
      console.log("install", { team: data.teamId, name: data.teamName, domain: data.domain, by: data.installer })
    } else {
      console.log("reinstall", { team: data.teamId, name: data.teamName, by: data.installer })
    }
    await this.syncMembers().catch((error) => console.error("sync failed", error))
    this.ctx.waitUntil(this.joinPublicChannels().catch((error) => console.error("join failed", error)))
    const accounts = await this.ensure([data.installer])
    const row = accounts.get(data.installer)
    return { id: data.installer, name: row?.name ?? "someone", image: row?.image ?? null }
  }

  /**
   * Rebuilds every stored balance, and the received and given totals, from the ledger entries, which are the source of
   * truth, and reports the accounts that don't match. With `apply`, sets the stored numbers back to what the ledger says.
   * No entries are added: the ledger was right, only the stored balances drifted.
   */
  async reconcile(apply: boolean) {
    const rows = this.sql
      .exec<{ id: string; name: string; balance: number; received: number; given: number; expected: number; expected_received: number; expected_given: number }>(
        `select a.id, a.name, a.balance, a.received, a.given,
          coalesce((select sum(amount) from entries where to_id = a.id), 0)
            - coalesce((select sum(amount) from entries where from_id = a.id), 0) as expected,
          coalesce((select sum(amount) from entries where to_id = a.id and from_id is not null and kind in ('give', 'reaction')), 0)
            - coalesce((select sum(amount) from entries where from_id = a.id and to_id is not null and kind = 'refund'), 0) as expected_received,
          coalesce((select sum(amount) from entries where from_id = a.id and to_id is not null and kind in ('give', 'reaction')), 0)
            - coalesce((select sum(amount) from entries where to_id = a.id and from_id is not null and kind = 'refund'), 0) as expected_given
        from accounts a`,
      )
      .toArray()
    const drift = rows.filter(
      (row) => row.balance !== row.expected || row.received !== row.expected_received || row.given !== row.expected_given,
    )
    if (apply && drift.length) {
      this.ctx.storage.transactionSync(() => {
        for (const row of drift) {
          this.sql.exec(
            "update accounts set balance = ?, received = ?, given = ? where id = ?",
            row.expected,
            row.expected_received,
            row.expected_given,
            row.id,
          )
        }
      })
      console.log("reconciled", { team: this.install()?.teamId, accounts: drift.map((row) => [row.id, row.balance, row.expected]) })
    }
    return {
      team: this.install()?.teamName ?? null,
      applied: apply,
      drift: drift.map((row) => ({
        id: row.id,
        name: row.name,
        balance: row.balance,
        expected: row.expected,
        received: [row.received, row.expected_received],
        given: [row.given, row.expected_given],
      })),
    }
  }

  /** What the operator sees about a workspace: no balances or notes, just who installed it and how big it is. */
  async summary() {
    const install = this.install()
    const counts = this.sql
      .exec<{ accounts: number; entries: number }>(
        "select (select count(*) from accounts where gone = 0 and bot = 0) as accounts, (select count(*) from entries) as entries",
      )
      .one()
    return {
      team: install?.teamId ?? null,
      name: install?.teamName ?? null,
      domain: install?.domain ?? null,
      installer: install?.installer ?? null,
      installedAt: install?.installedAt ?? null,
      active: Boolean(install?.token),
      ...counts,
    }
  }

  async uninstalled() {
    const install = this.install()
    if (install) this.setMeta("install", { ...install, token: "" })
  }

  async login(viewer: Viewer) {
    if (!this.install()?.token) return
    await this.ensure([viewer.id])
    const profile = await this.profile(viewer.id)
    if (profile) {
      this.sql.exec(
        "update accounts set name = ?, image = ?, slack_admin = ? where id = ?",
        profile.name,
        profile.image,
        profile.admin ? 1 : 0,
        viewer.id,
      )
    }
  }

  async me(viewer: Viewer, team: { id: string; name: string; domain: string | null; icon: string | null }): Promise<Me> {
    await this.freshen()
    const install = this.install()
    const row = this.row(viewer.id)
    const config = this.settings()
    const all = install?.token ? await this.emojiUrls() : {}
    const emoji: Record<string, string> = {}
    for (const name of [config.symbol, ...config.emoji.map((item) => item.name)]) {
      if (all[name]) emoji[name] = all[name]
    }
    return {
      emoji,
      user: viewer,
      team: install
        ? { id: install.teamId, name: install.teamName, domain: install.domain, icon: install.icon }
        : team,
      installed: Boolean(install?.token),
      admin: this.isAdmin(viewer.id),
      account: row ? this.account(row) : null,
      sources: this.sourcesOf(viewer.id),
      config,
    }
  }

  async leaderboard() {
    await this.freshen()
    return {
      accounts: this.sql
        .exec<AccountRow>("select * from accounts where bot = 0 and gone = 0 order by balance desc, received desc, name asc limit 500")
        .toArray()
        .map((row) => this.account(row)),
    }
  }

  async history(viewer: Viewer, scope: "mine" | "all", limit = 200): Promise<History> {
    if (scope === "all" && !this.isAdmin(viewer.id)) throw new Error("forbidden")
    const rows =
      scope === "all"
        ? this.sql.exec<EntryRow>("select * from entries order by id desc limit ?", limit).toArray()
        : this.sql
            .exec<EntryRow>(
              "select * from entries where from_id = ?1 or to_id = ?1 order by id desc limit ?2",
              viewer.id,
              limit,
            )
            .toArray()
    const ids = new Set<string>()
    for (const row of rows) {
      if (row.from_id) ids.add(row.from_id)
      if (row.to_id) ids.add(row.to_id)
      if (row.actor) ids.add(row.actor)
    }
    const people: History["people"] = {}
    for (const id of ids) {
      const row = this.row(id)
      people[id] = { name: row?.name ?? id, image: row?.image ?? null }
    }
    return { entries: rows.map((row) => this.entry(row)), people }
  }

  async give(viewer: Viewer, to: string, amount: number, note: string | null) {
    this.assertActive(viewer)
    const result = await this.transfer(viewer.id, to, amount, note?.slice(0, 280) ?? null, "give")
    if (!result.ok) throw new Error(result.message)
    return { balance: result.balance / CENTS }
  }

  // ---------- admin

  private assertAdmin(viewer: Viewer) {
    this.assertActive(viewer)
    if (!this.isAdmin(viewer.id)) throw new Error("forbidden")
  }

  /** Web sessions last 30 days; people deactivated in Slack lose access right away. */
  private assertActive(viewer: Viewer) {
    if (this.row(viewer.id)?.gone) throw new Error("forbidden")
  }

  async saveConfig(viewer: Viewer, input: Config): Promise<Config> {
    this.assertAdmin(viewer)
    const clean = (text: string, max: number) => String(text ?? "").trim().slice(0, max)
    const names = new Set<string>()
    const emoji = (input.emoji ?? [])
      .map((item) => ({ name: clean(item.name, 100).replace(/^:|:$/g, "").toLowerCase(), amount: Math.floor(Number(item.amount)) }))
      .filter((item) => EMOJI_NAME.test(item.name) && item.amount > 0 && item.amount <= 1_000_000)
      .filter((item) => !names.has(item.name) && names.add(item.name))
      .slice(0, 24)
    // A client from before the games existed sends none, and shouldn't switch them off by saving.
    const games = input.games ?? this.settings().games
    const market = input.market ?? this.settings().market
    const taxes = input.taxes ?? this.settings().taxes
    const rate = (value: unknown, most: number) => Math.max(0, Math.min(most, Math.round(Number(value) * 10) / 10 || 0))
    const whole = (value: unknown, least: number) => Math.max(least, Math.min(1_000_000, Math.floor(Number(value) || 0)))
    const config: Config = {
      singular: clean(input.singular, 32).replace(/[<>&*_~`]/g, "") || defaultConfig.singular,
      plural: clean(input.plural, 32).replace(/[<>&*_~`]/g, "") || defaultConfig.plural,
      symbol: EMOJI_NAME.test(clean(input.symbol, 100).replace(/^:|:$/g, "").toLowerCase())
        ? clean(input.symbol, 100).replace(/^:|:$/g, "").toLowerCase()
        : defaultConfig.symbol,
      starting: Math.max(0, Math.min(1_000_000, Math.floor(Number(input.starting) || 0))),
      emoji,
      notify: Boolean(input.notify),
      games: { enabled: Boolean(games.enabled), maxBet: whole(games.maxBet, 1), reserve: whole(games.reserve, 0) },
      market: { enabled: Boolean(market.enabled), fee: rate(market.fee, 25) },
      taxes: { transfer: rate(taxes.transfer, 50), winnings: rate(taxes.winnings, 90), wealth: rate(taxes.wealth, 50), wealthAbove: whole(taxes.wealthAbove, 0) },
    }
    this.setMeta("config", config)
    // The daily alarm settles the house, draws the lottery and collects the wealth tax, so make sure one is coming.
    if (config.games.enabled || config.taxes.wealth > 0) await schedule(this.ledger())
    return config
  }

  async adjust(viewer: Viewer, target: string, amount: number, note: string | null) {
    this.assertAdmin(viewer)
    amount = Math.trunc(amount)
    if (!Number.isSafeInteger(amount) || !amount) throw new Error("the amount has to be a number other than zero, to the cent at most")
    if (Math.abs(amount) > 1_000_000 * CENTS) throw new Error("adjust at most 1,000,000 at a time")
    note = note?.slice(0, 280) ?? null
    console.log("adjust", { by: viewer.id, target, amount })
    const accounts = await this.ensure([target])
    if (!accounts.get(target)) throw new Error("unknown person")
    const result =
      amount > 0
        ? this.move({ from: null, to: target, amount, kind: "adjust", note, actor: viewer.id })
        : this.move({ from: target, to: null, amount: -amount, kind: "adjust", note, actor: viewer.id })
    if (!result.ok) throw new Error(result.reason === "insufficient" ? `they only have ${result.balance / CENTS}` : "unknown person")
    return { ok: true }
  }

  /** Pays an equal share of `amount` from the central bank's reserves to everyone. */
  async stimulus(viewer: Viewer, amount: number) {
    this.assertAdmin(viewer)
    const result = this.ctx.storage.transactionSync(() => stimulus(this.ledger(), amount, viewer.id))
    console.log("stimulus", { by: viewer.id, ...result })
    return { each: result.each / CENTS, people: result.people }
  }

  /** Replaces a transaction's note. The amount and the people involved stay as they were. */
  async redact(viewer: Viewer, id: number) {
    this.assertAdmin(viewer)
    const changed = this.sql.exec("update entries set note = 'redacted' where id = ? and note is not null", id).rowsWritten
    if (!changed) throw new Error("no note to redact")
    console.log("redact", { by: viewer.id, entry: id })
    return { ok: true }
  }

  async admins(viewer: Viewer): Promise<Admin[]> {
    this.assertAdmin(viewer)
    const added = this.sql.exec<{ id: string; source: "installer" | "added" }>("select id, source from admins").toArray()
    const result = new Map<string, Admin>()
    for (const { id, source } of added) result.set(id, { id, name: id, image: null, source })
    for (const admin of result.values()) {
      const row = this.row(admin.id)
      if (row) {
        admin.name = row.name
        admin.image = row.image
      }
    }
    return [...result.values()]
  }

  async addAdmin(viewer: Viewer, id: string) {
    this.assertAdmin(viewer)
    await this.ensure([id])
    this.sql.exec("insert or ignore into admins (id, source, added_by, at) values (?, 'added', ?, ?)", id, viewer.id, Date.now())
  }

  async removeAdmin(viewer: Viewer, id: string) {
    this.assertAdmin(viewer)
    this.sql.exec("delete from admins where id = ? and source = 'added'", id)
  }

  async customEmoji(viewer: Viewer): Promise<CustomEmoji[]> {
    this.assertAdmin(viewer)
    // Admins come here right after adding emoji in Slack, so skip the cache.
    return Object.entries(await this.emojiUrls(true))
      .map(([name, url]) => ({ name, url }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async people(viewer: Viewer) {
    const members: Viewer[] = []
    let cursor: string | undefined
    do {
      const page = await this.call<{
        members: { id: string; name: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string; image_72?: string } }[]
        response_metadata?: { next_cursor?: string }
      }>("users.list", { limit: 200, cursor })
      for (const member of page.members) {
        if (member.deleted || member.is_bot || member.id === "USLACKBOT") continue
        members.push({
          id: member.id,
          name: member.profile?.display_name || member.profile?.real_name || member.name,
          image: member.profile?.image_72 ?? null,
        })
      }
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    void viewer
    return members.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Re-reads the member list from Slack now instead of waiting for the daily pass. */
  async resyncMembers(viewer: Viewer) {
    this.assertAdmin(viewer)
    return { members: await this.syncMembers() }
  }

  async joinChannels(viewer: Viewer) {
    this.assertAdmin(viewer)
    return this.joinPublicChannels()
  }

  /** Slack only sends reaction events from channels the app is in, so Bank joins every public channel itself. */
  private async joinPublicChannels() {
    this.setMeta("joined", Date.now())
    let joined = 0
    let cursor: string | undefined
    do {
      const page = await this.call<{
        channels: SlackChannel[]
        response_metadata?: { next_cursor?: string }
      }>("conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, cursor })
      for (const channel of page.channels) {
        if (channel.is_member || channel.is_archived || external(channel)) continue
        try {
          await this.call("conversations.join", { channel: channel.id })
          joined++
        } catch (error) {
          console.error("join failed", channel.id, error)
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return { joined }
  }

  // ---------- Slack: slash command

  private async transfer(
    from: string,
    to: string,
    amount: number,
    note: string | null,
    kind: "give" | "reaction",
    link: string | null = null,
  ): Promise<{ ok: true; balance: number } | { ok: false; message: string }> {
    const config = this.config()
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, message: "the amount has to be more than 0, to the cent at most" }
    if (from === to) return { ok: false, message: `you can't give ${config.plural} to yourself` }
    if (this.row(from)?.gone) return { ok: false, message: "your account is deactivated" }
    // At most 30 gifts a minute per person, so nobody can flood a channel.
    const recent = this.sql
      .exec<{ n: number }>(
        "select count(*) as n from entries where from_id = ? and kind in ('give', 'reaction') and at > ?",
        from,
        Date.now() - 60_000,
      )
      .one().n
    if (recent >= 30) return { ok: false, message: "slow down, try again in a minute" }
    const accounts = await this.ensure([from, to])
    const recipient = accounts.get(to)
    if (!accounts.get(from)) return { ok: false, message: `only members of ${this.install()?.teamName ?? "this workspace"} can give ${config.plural}` }
    if (!recipient) return { ok: false, message: `only members of ${this.install()?.teamName ?? "this workspace"} can get ${config.plural}` }
    if (recipient.bot) return { ok: false, message: `bots can't hold ${config.plural}` }
    if (recipient.gone) return { ok: false, message: `that account is no longer active` }
    const result = this.move({ from, to, amount, kind, note, actor: from, link })
    if (result.ok) levy(this.ledger(), { from: to, amount, rate: config.taxes.transfer, note: "transfer tax", actor: from })
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === "insufficient"
            ? `you only have ${currency(config, result.balance)}`
            : "something went wrong, try again",
      }
    }
    return { ok: true, balance: result.from ?? 0 }
  }

  async command(params: {
    text: string
    user_id: string
    request: string
    channel?: string | null
    command?: string | null
  }): Promise<SlackMessage> {
    const fresh = this.sql
      .exec("insert or ignore into events (id, at) values (?, ?)", `command:${params.request}`, Date.now()).rowsWritten
    if (!fresh) return { response_type: "ephemeral", text: "already handled" }
    console.log("command", { user: params.user_id, text: params.text.slice(0, 200) })
    const config = this.config()
    // Slack shows one hint per command, so the common ones are also registered on their own: /bank-flip 10 is
    // /bank flip 10.
    const own = params.command?.match(/^\/bank-([a-z]+)$/)?.[1]
    const text = `${own ?? ""} ${params.text}`.trim()
    const words = text.split(/\s+/).filter(Boolean)
    const sub = (words[0] ?? "").toLowerCase()
    const reply = (text: string): SlackMessage => ({ response_type: "ephemeral", text })

    if (sub === "" || sub === "help") return reply(this.help(config))

    if (sub === "balance" || sub === "bal") {
      const row = (await this.ensure([params.user_id])).get(params.user_id)
      const from = sources(this.ledger(), params.user_id)
      const signed = (cents: number) => `${cents < 0 ? "−" : "+"}${currency(config, Math.abs(cents)).split(" ")[0]}`
      // What colleagues gave is the point of the bank, so it is spelled out apart from winnings and losses.
      const parts = [
        `${currency(config, row?.received ?? 0)} given to you by people`,
        from.casino ? `casino ${signed(from.casino)}` : "",
        from.market ? `market ${signed(from.market)}` : "",
      ].filter(Boolean)
      return reply(`you have *${currency(config, row?.balance ?? 0)}* :${config.symbol}:\n${parts.join(" · ")}`.trim())
    }

    if (sub === "top" || sub === "leaderboard") {
      await this.freshen()
      // Two lists: who people have thanked the most, which is what the bank is for, and who simply has the most.
      const top = (order: string) =>
        this.sql.exec<AccountRow>(`select * from accounts where bot = 0 and gone = 0 order by ${order} limit 5`).toArray()
      const thanked = top("received desc, balance desc, name asc").filter((row) => row.received > 0)
      const rich = top("balance desc, received desc, name asc")
      if (!rich.length) return reply("nobody has any yet")
      const list = (rows: AccountRow[], amount: (row: AccountRow) => number) =>
        rows.map((row, i) => `${i + 1}. <@${row.id}> · ${currency(config, amount(row))}`).join("\n")
      return reply(
        [
          thanked.length ? `*most appreciated* · given to them by people\n${list(thanked, (row) => row.received)}` : "",
          `*richest* · however they got it\n${list(rich, (row) => row.balance)}`,
          `<${this.env.PUBLIC_URL}|see everything>`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      )
    }

    if (sub === "history") {
      const rows = this.sql
        .exec<EntryRow>("select * from entries where from_id = ?1 or to_id = ?1 order by id desc limit 10", params.user_id)
        .toArray()
      if (!rows.length) return reply("nothing yet")
      const lines = rows.map((row) => {
        const amount = currency(config, row.amount)
        const note = row.note ? ` · ${escape(row.note)}` : ""
        const game = historyLine(row, params.user_id, amount) ?? tradeLine(row, params.user_id, amount)
        if (game) return game
        if (row.kind === "grant") return `+${amount} starting balance`
        if (row.kind === "adjust") return row.to_id === params.user_id ? `+${amount} from an admin${note}` : `-${amount} by an admin${note}`
        if (row.kind === "refund") return row.to_id === params.user_id ? `+${amount} refunded by <@${row.from_id}>` : `-${amount} refunded to <@${row.to_id}>`
        return row.from_id === params.user_id ? `-${amount} to <@${row.to_id}>${note}` : `+${amount} from <@${row.from_id}>${note}`
      })
      return reply(`*your recent activity*\n${lines.join("\n")}`)
    }

    if (sub === "admin" || sub === "settings") return reply(`<${this.env.PUBLIC_URL}|open bank>`)

    // The games claim their own words before anything with a mention and a number is taken for a gift.
    const played = await play(this.ledger(), { sub, words: words.slice(1), user: params.user_id, channel: params.channel ?? null })
    if (played) return played
    const traded = await market(this.ledger(), { sub, words: words.slice(1), user: params.user_id })
    if (traded) return traded

    // give / send / pay, or just "/bank @someone 10"
    const rest = ["give", "send", "pay", "tip"].includes(sub) ? words.slice(1) : words
    const mention = rest.find((word) => MENTION.test(word))
    const amountWord = rest.find((word) => /^\d+(\.\d{1,2})?$/.test(word))
    if (!mention || !amountWord) return reply(`didn't get that.\n\n${this.help(config)}`)
    const to = mention.match(MENTION)![1]!
    const amount = toCents(amountWord) ?? 0
    const note =
      rest
        .filter((word) => word !== mention && word !== amountWord)
        .join(" ")
        .replace(/^for\s+/i, "")
        .trim()
        .slice(0, 280) || null
    const result = await this.transfer(params.user_id, to, amount, note, "give")
    if (!result.ok) return reply(result.message)
    return {
      response_type: "in_channel",
      text: `:${config.symbol}: <@${params.user_id}> gave <@${to}> *${currency(config, amount)}*${note ? ` · ${escape(note)}` : ""}`.trim(),
    }
  }

  private help(config: Config) {
    const emoji = config.emoji.map((item) => `:${item.name}: ${item.amount / CENTS}`).join("  ")
    // One block per part of the bank, and only the parts that are switched on.
    return [
      [
        `*bank* · everyone starts with ${currency(config, config.starting)}`,
        `\`/bank give @someone 10 for fixing the deploy\``,
        emoji ? `or react to a message to give: ${emoji}` : "",
        `\`/bank balance\` · how many you have`,
        `\`/bank top\` · leaderboard`,
        `\`/bank history\` · your recent activity`,
      ],
      casinoHelp(config),
      marketHelp(config),
      [`<${this.env.PUBLIC_URL}|open bank> · the leaderboard, the economy, and who the casino has ruined`],
    ]
      .map((lines) => lines.filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n")
  }

  // ---------- Slack: events

  async event(envelope: EventEnvelope) {
    const fresh = this.sql
      .exec("insert or ignore into events (id, at) values (?, ?)", envelope.event_id, Date.now()).rowsWritten
    if (!fresh) return
    this.sql.exec("delete from events where at < ?", Date.now() - 24 * 60 * 60 * 1000)
    const event = envelope.event
    if (event.type === "app_uninstalled" || event.type === "tokens_revoked") return this.uninstalled()
    if (!this.install()?.token) return
    if (event.type === "reaction_added" || event.type === "reaction_removed") {
      return this.reaction(event)
    }
    if (event.type === "channel_created") {
      // The event carries little about the channel, so look it up before joining.
      const info = await this.call<{ channel: SlackChannel }>("conversations.info", { channel: event.channel.id }).catch(() => null)
      if (!info || external(info.channel)) return
      await this.call("conversations.join", { channel: event.channel.id }).catch((error) =>
        console.error("join failed", event.channel.id, error),
      )
      return
    }
    if (event.type === "team_join" || event.type === "user_change") {
      const config = this.config()
      this.ctx.storage.transactionSync(() => this.applyMember(event.user, config, Date.now()))
    }
  }

  private async reaction(event: ReactionEvent) {
    const config = this.config()
    const name = event.reaction.split("::")[0]!
    const value = config.emoji.find((item) => item.name === name)
    const channel = event.item.channel
    const ts = event.item.ts
    const to = event.item_user
    if (!value || event.item.type !== "message" || !channel || !ts || !to || to === event.user) return
    // A reaction gift is final: removing the reaction doesn't take it back, and adding it again doesn't give again.
    if (event.type === "reaction_removed") return
    const key = `${channel}:${ts}:${event.user}:${name}`
    // Claim the gift before any await, so a quick remove-and-re-add can't give twice.
    const claimed = this.sql.exec(
      "insert or ignore into reactions (key, from_id, to_id, amount) values (?, ?, ?, ?)",
      key,
      event.user,
      to,
      value.amount,
    ).rowsWritten
    if (!claimed) return
    const link = await this.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts })
      .then((result) => result.permalink)
      .catch(() => null)
    const result = await this.transfer(event.user, to, value.amount, null, "reaction", link)
    if (!result.ok) {
      // Nothing moved, so let them try again once they have enough.
      this.sql.exec("delete from reactions where key = ?", key)
      await this.call("chat.postEphemeral", {
        channel,
        user: event.user,
        text: `your :${name}: didn't go through: ${result.message}`,
      }).catch((error) => console.error("ephemeral failed", error))
      return
    }
    if (config.notify) {
      const where = link ? ` for <${link}|your message>` : ""
      await this.call("chat.postMessage", {
        channel: to,
        text: `:${config.symbol}: <@${event.user}> gave you *${currency(config, value.amount)}*${where}`.trim(),
        unfurl_links: false,
      }).catch((error) => console.error("notify failed", error))
    }
  }
}
