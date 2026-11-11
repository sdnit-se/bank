// Brings the ledger over from another Bank, such as the hosted one a workspace used before running its own.
//
// Moving in copies balances with one admin adjustment per person, which leaves everyone's received and given totals
// at zero and the history empty. Importing the old entries puts the real history in their place. It must never change
// what anyone holds, so it checks that before it lets anything stand.

import type { EmojiValue, Entry } from "../shared/types"

/** The note on the adjustments that copied balances over. Importing removes exactly these. */
export const MIGRATED = "migrated from the hosted bank"

const KINDS = new Set(["grant", "give", "reaction", "refund", "adjust"])

type Row = { id: number; at: number; kind: string; from_id: string | null; to_id: string | null; amount: number; note: string | null; actor: string | null; link: string | null }

/**
 * Replaces this ledger's starting grants and balance-copying adjustments with `entries`, keeps everything that
 * happened since, and rebuilds the received and given totals. Call it inside a transaction: it throws, leaving the
 * caller to roll back, if the entries are malformed, name someone unknown, or would change a balance.
 */
export function importHistory(sql: SqlStorage, entries: Entry[], emoji: EmojiValue[]) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("no entries to import")
  if (entries.length > 20_000) throw new Error("too many entries to import at once")
  const text = (value: unknown, max: number) => (typeof value === "string" && value ? value.slice(0, max) : null)
  const incoming = [...entries]
    .sort((a, b) => a.id - b.id)
    .map((entry): Omit<Row, "id"> => {
      if (!KINDS.has(entry.kind) || !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || !Number.isFinite(entry.at)) {
        throw new Error(`entry ${entry.id} is not one this bank understands`)
      }
      return {
        at: Math.floor(entry.at),
        kind: entry.kind,
        from_id: text(entry.from, 32),
        to_id: text(entry.to, 32),
        amount: entry.amount,
        note: text(entry.note, 280),
        actor: text(entry.actor, 32),
        link: text(entry.link, 500),
      }
    })

  const balances = () =>
    new Map(sql.exec<{ id: string; balance: number }>("select id, balance from accounts").toArray().map((row) => [row.id, row.balance]))
  const before = balances()
  const strangers = new Set(incoming.flatMap((entry) => [entry.from_id, entry.to_id]).filter((id): id is string => id !== null && !before.has(id)))
  if (strangers.size) throw new Error(`these people have no account here: ${[...strangers].slice(0, 10).join(", ")}`)

  // Out go the adjustments that copied balances over, and this bank's own starting grant for anyone the old one
  // already granted. Everything else happened here and stays, after the imported entries.
  const granted = new Set(incoming.filter((entry) => entry.kind === "grant" && entry.to_id).map((entry) => entry.to_id))
  const kept = sql
    .exec<Row>("select * from entries order by id")
    .toArray()
    .filter((row) => !(row.kind === "adjust" && row.note === MIGRATED) && !(row.kind === "grant" && granted.has(row.to_id)))
  sql.exec("delete from entries")
  let id = 0
  for (const row of [...incoming, ...kept]) {
    sql.exec(
      "insert into entries (id, at, kind, from_id, to_id, amount, note, actor, link) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ++id,
      row.at,
      row.kind,
      row.from_id,
      row.to_id,
      row.amount,
      row.note,
      row.actor,
      row.link,
    )
  }

  // The ledger is what's true. If it now disagrees with what anyone holds, the import was not a faithful copy.
  const expected = sql
    .exec<{ id: string; name: string; balance: number; received: number; given: number }>(
      `select a.id, a.name,
        coalesce((select sum(amount) from entries where to_id = a.id), 0)
          - coalesce((select sum(amount) from entries where from_id = a.id), 0) as balance,
        coalesce((select sum(amount) from entries where to_id = a.id and from_id is not null and kind in ('give', 'reaction')), 0)
          - coalesce((select sum(amount) from entries where from_id = a.id and to_id is not null and kind = 'refund'), 0) as received,
        coalesce((select sum(amount) from entries where from_id = a.id and to_id is not null and kind in ('give', 'reaction')), 0)
          - coalesce((select sum(amount) from entries where to_id = a.id and from_id is not null and kind = 'refund'), 0) as given
      from accounts a`,
    )
    .toArray()
  const off = expected.filter((row) => row.balance !== before.get(row.id))
  if (off.length) {
    throw new Error(
      `importing would change balances, so nothing was imported: ${off
        .slice(0, 5)
        .map((row) => `${row.name} has ${before.get(row.id)}, the history says ${row.balance}`)
        .join("; ")}`,
    )
  }
  for (const row of expected) sql.exec("update accounts set received = ?, given = ? where id = ?", row.received, row.given, row.id)

  // A reaction that already gave here must not give again if someone removes it and puts it back.
  const names = new Map<number, string | null>()
  for (const item of emoji) names.set(item.amount, names.has(item.amount) ? null : item.name)
  let reactions = 0
  for (const entry of incoming) {
    const where = entry.kind === "reaction" ? entry.link?.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/) : null
    const name = names.get(entry.amount)
    if (!where || !name || !entry.from_id || !entry.to_id) continue
    reactions += sql.exec(
      "insert or ignore into reactions (key, from_id, to_id, amount) values (?, ?, ?, ?)",
      `${where[1]}:${where[2]}.${where[3]}:${entry.from_id}:${name}`,
      entry.from_id,
      entry.to_id,
      entry.amount,
    ).rowsWritten
  }

  return { imported: incoming.length, kept: kept.length, reactions }
}
