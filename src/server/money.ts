// Coins and cents. People type and read coins: `/bank give @sam 10`, "you have 103.50 coins". The ledger counts in
// cents, a hundredth of a coin, so that a tax or a share price can move less than a whole coin and every sum stays a
// whole number. Everything inside the Workspace is in cents, and amounts are converted where they come in and go out.

import { CENTS, currency, type Config } from "../shared/types"

/** How a ledger amount reads in a message: "103 coins", "0.50 coins", "1 coin". */
export function money(config: Config, cents: number) {
  return currency(config, cents / CENTS)
}

/** The settings as the ledger uses them. They are saved, edited and shown in coins. */
export function inCents(config: Config): Config {
  return {
    ...config,
    starting: config.starting * CENTS,
    emoji: config.emoji.map((item) => ({ ...item, amount: item.amount * CENTS })),
    games: { ...config.games, maxBet: config.games.maxBet * CENTS, reserve: config.games.reserve * CENTS },
    taxes: { ...config.taxes, wealthAbove: config.taxes.wealthAbove * CENTS },
    shop: config.shop.map((item) => ({ ...item, price: item.price * CENTS })),
  }
}

/**
 * Turns a ledger kept in whole coins into one kept in cents, once. Every balance, total and entry is multiplied by a
 * hundred, so nobody gains or loses anything. Duels are a ten-minute offer and are simply dropped. Lottery tickets
 * stay as they are: a ticket is still one coin.
 */
export function convertToCents(sql: SqlStorage) {
  const done = sql.exec("select 1 from meta where key = 'cents'").toArray().length > 0
  if (done) return false
  sql.exec(`update accounts set balance = balance * ${CENTS}, received = received * ${CENTS}, given = given * ${CENTS}`)
  sql.exec(`update entries set amount = amount * ${CENTS}`)
  sql.exec(`update reactions set amount = amount * ${CENTS}`)
  sql.exec("delete from duels")
  sql.exec("insert into meta (key, value) values ('cents', 'true')")
  return true
}
