# bank

A tiny currency for your Slack. Everyone starts with 100 coins and gives them away with a reaction or `/bank give`.

Live at https://labs.shebang.se/bank. Forked from https://github.com/anomalyco/bank.

## How it works

- `/bank give @someone 10 for the fix`, `/bank balance`, `/bank top`, `/bank history`
- React to a message with a coin emoji (`:coin-1:`, `:coin-5:`, `:coin-10:`, `:coin-20:` by default) to give that many. A gift is final: removing the reaction doesn't take it back, and adding it again doesn't give again.
- Admins (whoever installed it, Slack admins, and anyone they add) can rename the currency, set the starting balance, map any custom emoji to an amount, adjust balances, and join every public channel.

Slack doesn't let apps upload custom emoji, so workspaces add the coin images themselves. The default pack is in `public/emoji` (rendered by `scripts/emoji.ts`).

## What this fork adds

- **A casino**, off until an admin opens it: `/bank flip`, `/bank slots`, `/bank duel`, `/bank lottery`, all listed by
  `/bank casino`. Games move coins and never create or destroy them. Stakes go to the house or the lottery pot; what
  the house wins beyond its reserve goes to a central bank at the daily draw, which puts a tenth of what it holds
  back into the pot.
- **An Economy tab**: money supply, GDP (coins given between people), inflation, and who holds what.
- **A Casino tab**: what the games have done to everyone. Total staked, the house's take, biggest winners and
  losers, losing streaks, returns by game and every lottery draw, all read off the ledger (`src/server/stats.ts`).
- **A stock market**, off until an admin opens it: `/bank buy ERIC-B.ST 20`, `/bank sell`, `/bank portfolio`,
  `/bank price`. Real prices from Yahoo Finance, play money. A position follows its share's percentage move. Losses
  stay in the market and pay for gains; it prints only what it lacks. Each trade is taxed to the central bank.
  `src/server/market.ts`.
- **Taxes**, all off until an admin sets a rate: on gifts, on winnings and market gains, and weekly on wealth above
  a threshold. All of it goes to the central bank, which an admin can pay back out to everyone as a stimulus.
  `src/server/taxes.ts`.
- **Recognition kept apart from winnings.** The leaderboard ranks by coins received from colleagues first, with
  "richest" as a separate view, and everyone's card says how much came from people, the casino and the market.
- **Cents.** The ledger counts in hundredths of a coin (`src/server/money.ts`), so `/bank give @someone 0.5` works and
  a tax or a share price can move less than a whole coin. People still type and read coins; reactions and lottery
  tickets stay whole. A ledger kept in whole coins is converted once, on the first start of this version.

`src/server/games.ts` has the odds and the wording, `src/server/casino.ts` the parts that touch the ledger, and
`src/server/migrate.ts` the import. `bun test` checks the payout maths and that no game changes the number of coins.
The art is drawn by `bun scripts/brand.ts`.

## Layout

- `src/server/worker.ts`: routes, Slack OAuth (install and Sign in with Slack), request signatures, the JSON API
- `src/server/workspace.ts`: the `Workspace` Durable Object, one per Slack team. SQLite ledger of accounts, entries, reaction gifts, admins and settings.
- `src/client`: the web app, Solid and `@opencode/ui`
- `slack-manifest.json`: the Slack app manifest

## Deploy

```sh
bun install
bun run deploy   # vite build && cf deploy --prebuilt
```

The Worker needs these secrets, set on the Worker only: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SESSION_SECRET`.
