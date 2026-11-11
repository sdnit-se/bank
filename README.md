# bank

A tiny currency for your Slack. Everyone starts with 100 coins and gives them away with a reaction or `/bank give`.

Live at https://labs.shebang.se/bank. Forked from https://github.com/anomalyco/bank.

## How it works

- `/bank give @someone 10 for the fix`, `/bank balance`, `/bank top`, `/bank history`
- React to a message with a coin emoji (`:coin-1:`, `:coin-5:`, `:coin-10:`, `:coin-20:` by default) to give that many. A gift is final: removing the reaction doesn't take it back, and adding it again doesn't give again.
- Admins (whoever installed it, Slack admins, and anyone they add) can rename the currency, set the starting balance, map any custom emoji to an amount, adjust balances, and join every public channel.

Slack doesn't let apps upload custom emoji, so workspaces add the coin images themselves. The default pack is in `public/emoji` (rendered by `scripts/emoji.ts`).

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
