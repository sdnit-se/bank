// The typing race: a line of plain words, typed as fast as the fingers go, on the Race tab. It is the one thing here
// that makes money out of nothing but effort: no stake, as many goes as anyone likes, and a wage for every decent
// one.
//
// The wage is newly made coins, since the central bank could never cover it, so there is a limit on what one person
// can earn in a day; after that a race still counts for the board and pays nothing. The server deals the words and
// keeps the clock honest as far as it can: nobody finishes in less time than has passed since they were dealt.
// Pasting the words in would still beat it, which is what the limit is for.

import { CENTS, nextDraw, type Race, type RaceResult } from "../shared/types"
import { secureRand } from "./games"
import type { Ledger } from "./ledger"
import { COMMON } from "./words"

const WORDS = 25
/** How long a dealt race waits to be finished. */
const WAIT = 5 * 60_000
/** Faster than anyone types: such a time isn't put on the board. */
const HUMAN = 220
const DAY = 24 * 60 * 60_000
/** What a race pays, in coins, from this many words a minute. */
export const WAGES = [
  { from: 100, pays: 4 },
  { from: 80, pays: 3 },
  { from: 60, pays: 2 },
  { from: 40, pays: 1 },
]

type Row = { id: number; user_id: string; text: string; at: number; wpm: number | null; accuracy: number | null }

export function setupRace(sql: SqlStorage) {
  sql.exec("create table if not exists races (id integer primary key autoincrement, user_id text not null, text text not null, at integer not null, wpm integer, accuracy integer)")
}

/** What someone has earned racing since the morning round, in cents. */
function earned(ledger: Ledger, user: string) {
  return ledger.sql.exec<{ n: number | null }>("select sum(amount) as n from entries where kind = 'wage' and to_id = ? and at > ?", user, nextDraw(Date.now()) - DAY).one().n ?? 0
}

/** The board, the viewer's own figures, and what a race pays. */
export function raceFor(ledger: Ledger, user: string): Race {
  const board = ledger.sql
    .exec<{ id: string; name: string; image: string | null; best: number; races: number }>(
      `select accounts.id, accounts.name, accounts.image, max(wpm) as best, count(*) as races from races join accounts on accounts.id = races.user_id
       where wpm is not null group by races.user_id order by best desc, races desc limit 10`,
    )
    .toArray()
  const mine = ledger.sql.exec<{ wpm: number }>("select wpm from races where user_id = ? and wpm is not null order by id desc limit 200", user).toArray().map((row) => row.wpm)
  const recent = mine.slice(0, 10)
  return {
    board,
    best: mine.length ? Math.max(...mine) : 0,
    average: recent.length ? Math.round(recent.reduce((sum, wpm) => sum + wpm, 0) / recent.length) : 0,
    races: mine.length,
    earned: earned(ledger, user),
    limit: ledger.config().wages,
    wages: WAGES,
  }
}

/** Deals a race: the words to type, and the number to hand them back under. */
export async function startRace(ledger: Ledger, user: string) {
  const person = (await ledger.ensure([user])).get(user)
  if (!person || person.bot || person.gone) throw new Error("Only members of this workspace get to race.")
  const text = Array.from({ length: WORDS }, () => COMMON[secureRand(COMMON.length)]!).join(" ")
  // A race that was dealt and never run is nothing worth keeping.
  ledger.sql.exec("delete from races where wpm is null and (user_id = ? or at < ?)", user, Date.now() - WAIT)
  ledger.sql.exec("insert into races (user_id, text, at) values (?, ?, ?)", user, text, Date.now())
  return { id: ledger.sql.exec<{ id: number }>("select max(id) as id from races where user_id = ?", user).one().id, text }
}

/**
 * Finishes a race. `ms` is how long the typing took by the racer's own clock, from the first key to the last, and
 * `keys` how many keys that took, mistakes included.
 */
export function finishRace(ledger: Ledger, user: string, input: { id: number; typed: string; ms: number; keys: number }): RaceResult {
  const row = ledger.sql.exec<Row>("select * from races where id = ? and user_id = ? and wpm is null", Number(input.id) || 0, user).toArray()[0]
  const waited = Date.now() - (row?.at ?? 0)
  if (!row || waited > WAIT) throw new Error("That race is over. Start another.")
  if (input.typed !== row.text) throw new Error("That isn't what was dealt. Every letter counts.")
  const ms = Number(input.ms)
  // Their clock can't have run longer than ours, give or take the trip here.
  if (!(ms >= 1000) || ms > waited + 2000) throw new Error("That time doesn't add up. Start another.")
  const wpm = Math.round(row.text.length / 5 / (ms / 60_000))
  if (wpm > HUMAN) throw new Error(`${wpm} words a minute. Nobody types that fast, so it stays off the board.`)
  const accuracy = Math.max(0, Math.min(100, Math.round((row.text.length / Math.max(row.text.length, Number(input.keys) || 0)) * 100)))
  const before = ledger.sql.exec<{ mine: number | null; office: number | null }>("select (select max(wpm) from races where user_id = ?) as mine, (select max(wpm) from races) as office", user).one()
  ledger.sql.exec("update races set wpm = ?, accuracy = ? where id = ?", wpm, accuracy, row.id)
  const left = Math.max(0, ledger.config().wages - earned(ledger, user))
  const wage = Math.min((WAGES.find((step) => wpm >= step.from)?.pays ?? 0) * CENTS, left)
  // Made, not moved: nobody is on the other side of this one.
  const paid = wage > 0 && ledger.move({ from: null, to: user, amount: wage, kind: "wage", note: `${wpm} wpm`, actor: user }).ok ? wage : 0
  return { wpm, accuracy, paid, personal: wpm > (before.mine ?? 0), record: wpm > (before.office ?? 0), race: raceFor(ledger, user) }
}

/** Yesterday's best race, for the morning paper, if it beat everything before it. */
export function raceNews(ledger: Ledger, since: number) {
  const top = ledger.sql
    .exec<{ name: string; wpm: number }>("select accounts.name, wpm from races join accounts on accounts.id = races.user_id where races.at > ? and wpm is not null order by wpm desc, races.id limit 1", since)
    .toArray()[0]
  const before = ledger.sql.exec<{ n: number | null }>("select max(wpm) as n from races where at <= ?", since).one().n ?? 0
  return top && top.wpm > before ? { ...top, before } : null
}
