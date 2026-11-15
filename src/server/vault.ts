// The vault: a five-letter word a day, six tries, and the central bank pays for getting it. `/vault crane`, or the
// Vault tab on the web, which is the same game with a board and a keyboard.
//
// It costs nothing to play, so it is the one game someone with no coins at all can earn at, and what it pays depends
// only on how well they play: more for every try they didn't need. Everyone gets a word of their own, so the answer
// isn't worth passing around, and a new one each morning at the daily round. The prize comes out of the central
// bank's reserves and nothing is printed for it: an empty bank pays nobody.

import { CENTRAL, nextDraw, type Vault, type VaultRecord } from "../shared/types"
import { say, secureRand, type Line } from "./games"
import { button, loud, quiet, withButtons, type Ledger, type Message } from "./ledger"
import { money } from "./money"
import { WORDS } from "./words"

const TRIES = 6
type Row = { user_id: string; day: number; word: string; guesses: string; paid: number | null }

const CRACKED: Line[] = [
  (w) => `${w.user} cracked the vault in ${w.tries} and the central bank paid *${w.amount}*. honest work, of all things.`,
  (w) => `${w.user} got the vault open in ${w.tries}: *${w.amount}* from the central bank, earned with nothing but vocabulary.`,
  (w) => `the vault took ${w.user} ${w.tries}. *${w.amount}* from the central bank, the only money here nobody had to lose first.`,
]
const EMPTY: Line[] = [(w) => `${w.user} cracked the vault in ${w.tries} and found it empty. the central bank is broke too.`]
const SHUT: Line[] = [
  (w) => `${w.user} had six tries at the vault and it's still shut. the word was *${w.word}*, which they will now see everywhere.`,
  (w) => `the vault beat ${w.user}. it was *${w.word}*. five letters, and every one of them a surprise.`,
]

export function setupVault(sql: SqlStorage) {
  sql.exec("create table if not exists vaults (user_id text not null, day integer not null, word text not null, guesses text not null default '', primary key (user_id, day))")
  // What a cracked vault paid came a day after the vault did.
  if (!sql.exec<{ name: string }>("pragma table_info(vaults)").toArray().some((column) => column.name === "paid")) sql.exec("alter table vaults add column paid integer")
}

/** One mark a letter: 2 is right where it is, 1 is in the word somewhere else, 0 isn't in it (or not that many times). */
export function marks(word: string, guess: string) {
  const left: string[] = [...word]
  const out: string[] = [...guess].map((letter, index) => (letter === word[index] ? ((left[index] = ""), "2") : "0"))
  ;[...guess].forEach((letter, index) => {
    const at = out[index] === "0" ? left.indexOf(letter) : -1
    if (at >= 0) [out[index], left[at]] = ["1", ""]
  })
  return out.join("")
}

const tried = (row: Pick<Row, "guesses"> | null) => (row?.guesses ? row.guesses.split(" ") : [])
const cracked = (row: Pick<Row, "word" | "guesses">) => tried(row).at(-1) === row.word
const today = (ledger: Ledger, user: string) => ledger.sql.exec<Row>("select * from vaults where user_id = ? and day = ?", user, nextDraw(Date.now())).toArray()[0] ?? null

/** Someone's record, from every vault they finished. A day they didn't play doesn't end a streak: weekends exist. */
function record(ledger: Ledger, user: string): VaultRecord {
  const rows = ledger.sql.exec<Row>("select * from vaults where user_id = ? order by day", user).toArray()
  const out: VaultRecord = { played: 0, cracked: 0, streak: 0, best: 0, spread: Array.from({ length: TRIES }, () => 0) }
  for (const row of rows) {
    const won = cracked(row)
    if (!won && tried(row).length < TRIES) continue
    out.played++
    out.streak = won ? out.streak + 1 : 0
    out.best = Math.max(out.best, out.streak)
    if (!won) continue
    out.cracked++
    out.spread[tried(row).length - 1]!++
  }
  return out
}

/** How everyone who has played today is doing, fewest tries first and anyone still at it after those who got in. */
function office(ledger: Ledger): Vault["office"] {
  return ledger.sql
    .exec<Row & { name: string; image: string | null }>(
      "select vaults.*, accounts.name, accounts.image from vaults join accounts on accounts.id = vaults.user_id where day = ? and guesses != ''",
      nextDraw(Date.now()),
    )
    .toArray()
    .map((row) => ({ id: row.user_id, name: row.name, image: row.image, marks: tried(row).map((guess) => marks(row.word, guess)), solved: cracked(row) }))
    .sort((a, b) => Number(b.solved) - Number(a.solved) || a.marks.length - b.marks.length || a.name.localeCompare(b.name))
}

function view(ledger: Ledger, user: string, row: Row | null): Vault {
  const guesses = tried(row)
  const solved = row !== null && cracked(row)
  const done = solved || guesses.length >= TRIES
  return {
    rows: guesses.map((word) => ({ word, marks: marks(row!.word, word) })),
    left: done ? 0 : TRIES - guesses.length,
    solved,
    answer: done && !solved ? row!.word : null,
    pays: ledger.config().vault,
    paid: solved ? (row!.paid ?? 0) : null,
    next: nextDraw(Date.now()),
    record: record(ledger, user),
    office: office(ledger),
  }
}

/** Where someone stands with today's vault. */
export const vaultFor = (ledger: Ledger, user: string) => view(ledger, user, today(ledger, user))

/**
 * Yesterday's vault for the morning paper, read at the round that closes it: who got in and in how many, and who
 * didn't. Names, never mentions.
 */
export function vaultNews(ledger: Ledger, now = Date.now()) {
  const rows = ledger.sql
    .exec<Row & { name: string }>("select vaults.*, accounts.name from vaults join accounts on accounts.id = vaults.user_id where day > ? and day <= ? and guesses != ''", now - 24 * 60 * 60_000, now + 60_000)
    .toArray()
  const got = rows.filter(cracked).map((row) => ({ name: row.name, tries: tried(row).length })).sort((a, b) => a.tries - b.tries || a.name.localeCompare(b.name))
  return { got, shut: rows.filter((row) => !cracked(row)).map((row) => row.name).sort() }
}

/**
 * One try at today's word. `name` is how the news names them when the try ends it: a mention where they played in
 * Slack, their plain name when it goes to the bank's channel from the web.
 */
export async function crack(ledger: Ledger, user: string, typed: string, name: string): Promise<{ vault: Vault; problem?: string; news?: string }> {
  const config = ledger.config()
  const refused = (problem: string) => ({ vault: vaultFor(ledger, user), problem })
  if (!(config.vault > 0)) return refused("the vault is shut. an admin can open it.")
  const person = (await ledger.ensure([user])).get(user)
  if (!person || person.bot || person.gone) return refused("only members of this workspace get a go at the vault.")
  const guess = typed.trim().toLowerCase()
  if (!/^[a-z]{5}$/.test(guess)) return refused("five letters, a to z: `/vault crane`")
  const day = nextDraw(Date.now())
  let row = today(ledger, user)
  if (!row) {
    ledger.sql.exec("insert into vaults (user_id, day, word) values (?, ?, ?)", user, day, WORDS[secureRand(WORDS.length)]!)
    row = today(ledger, user)!
  }
  const before = tried(row)
  if (before.at(-1) === row.word) return refused("you've cracked today's. there's a new one after the morning draw.")
  if (before.length >= TRIES) return refused(`that was six. the word was ${row.word}, and there's a new one after the morning draw.`)
  if (before.includes(guess)) return refused("you've tried that one.")
  ledger.sql.exec("update vaults set guesses = ? where user_id = ? and day = ?", [...before, guess].join(" "), user, day)
  const tries = before.length + 1
  const words = { user: name, tries: tries === 1 ? "one try" : `${tries} tries`, word: row.word }
  if (guess === row.word) {
    // Every try they didn't need is worth the same again.
    const prize = (TRIES + 1 - tries) * config.vault
    const paid = ledger.move({ from: CENTRAL, to: user, amount: prize, kind: "stimulus", note: "the vault" }).ok
    ledger.sql.exec("update vaults set paid = ? where user_id = ? and day = ?", paid ? prize : 0, user, day)
    return { vault: vaultFor(ledger, user), news: `:unlock: ${say(secureRand, paid ? CRACKED : EMPTY, { ...words, amount: money(config, prize) })}` }
  }
  if (tries >= TRIES) return { vault: vaultFor(ledger, user), news: `:lock: ${say(secureRand, SHUT, words)}` }
  return { vault: vaultFor(ledger, user) }
}

const SIGN: Record<string, string> = { 2: ":large_green_circle:", 1: ":large_yellow_circle:", 0: ":white_circle:" }
const signs = (vault: Vault) => vault.rows.map((row) => [...row.marks].map((mark) => SIGN[mark]).join(""))

/** Answers `/bank vault`, or returns null when the words aren't about it. Only the result is for the channel. */
export async function vaultCommand(ledger: Ledger, input: { sub: string; words: string[]; user: string }): Promise<Message | null> {
  if (input.sub !== "vault") return null
  const config = ledger.config()
  const typed = input.words[0]
  const result = typed ? await crack(ledger, input.user, typed, `<@${input.user}>`) : { vault: vaultFor(ledger, input.user) }
  if (!typed && !(config.vault > 0)) return quiet("the vault is shut. an admin can open it.")
  // The same game with a keyboard and a board, for anyone who'd rather not type commands. A link needs no answer.
  const web = (label: string) => ({ ...button(label, "vault_open", "open"), url: `${ledger.env.PUBLIC_URL}#vault` })
  // What they tried stays between them and the bank; the channel only gets how it went.
  if (result.news) return withButtons(loud(`${result.news}\n${signs(result.vault).join("\n")}`), [web("Try yours")])
  const { vault } = result
  const board = signs(vault).map((line, index) => `${line}  \`${vault.rows[index]!.word.toUpperCase()}\``)
  const key = `${SIGN[2]} right letter, right place · ${SIGN[1]} in the word, somewhere else · ${SIGN[0]} not in it`
  const status = vault.solved
    ? "cracked. there's a new one after the morning draw."
    : vault.left === 0
      ? `the word was *${vault.answer}*. there's a new one after the morning draw.`
      : `${vault.left} ${vault.left === 1 ? "try" : "tries"} left. getting it now pays ${money(config, vault.left * config.vault)}.`
  const how = vault.rows.length ? [] : ["today's vault opens with a five-letter word, and you get six tries: `/vault crane`", key]
  const text = quiet([result.problem, ...board, ...how, result.problem ? null : status].filter(Boolean).join("\n"))
  return vault.left > 0 ? withButtons(text, [web("Play in the browser")]) : text
}

/** The vault's part of `/bank help`: nothing while it's shut. */
export function vaultHelp(ledger: Ledger) {
  const config = ledger.config()
  if (!(config.vault > 0)) return []
  return [`*the vault* · \`/vault crane\` · guess the day's five-letter word in six. free to play, and the central bank pays up to ${money(config, TRIES * config.vault)} for it, more the fewer tries you need`]
}
