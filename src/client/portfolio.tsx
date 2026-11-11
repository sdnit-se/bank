// The Market tab: what you hold and what it is worth now, then how everyone else is doing. Trading happens in Slack.

import { For, Show } from "solid-js"
import { amountText, type Config, type MarketStats, type Portfolio } from "../shared/types"
import { number, Ranked, Tile } from "./economy"

const percent = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1)}%`

export function PortfolioView(props: { config: Config; portfolio: Portfolio | undefined }) {
  const worth = () => (props.portfolio?.positions ?? []).reduce((sum, position) => sum + (position.value ?? position.cost), 0)
  const cost = () => (props.portfolio?.positions ?? []).reduce((sum, position) => sum + position.cost, 0)
  return (
    <section class="card overflow-hidden">
      <Show when={props.portfolio} fallback={<div class="px-4 py-8 text-center faint">Loading…</div>}>
        {(portfolio) => (
          <Show
            when={portfolio().positions.length}
            fallback={
              <div class="px-4 py-8 text-center faint">
                Nothing yet. In Slack: <span class="code">/bank buy ERIC-B.ST 20</span>
              </div>
            }
          >
            <div>
              <For each={portfolio().positions}>
                {(position) => (
                  <div class="row flex items-center gap-3 px-4 py-2.5">
                    <div class="flex-1 min-w-0 flex flex-col">
                      <span class="strong truncate">{position.symbol}</span>
                      <span class="faint truncate">
                        {position.name}
                        <Show when={!position.live}> · closed</Show>
                      </span>
                    </div>
                    <Show when={position.value !== null} fallback={<span class="faint">no price</span>}>
                      <span class="num" classList={{ positive: position.value! > position.cost, danger: position.value! < position.cost }}>
                        {percent(position.value! / position.cost - 1)}
                      </span>
                    </Show>
                    <span class="num strong min-w-20 text-right">{amountText(position.value ?? position.cost)}</span>
                  </div>
                )}
              </For>
              <div class="footer">
                <span class="flex-1 faint">
                  {props.config.plural} at today's prices · {portfolio().fee}% a trade
                </span>
                <span class="num" classList={{ positive: worth() > cost(), danger: worth() < cost() }}>
                  {percent(worth() / cost() - 1)}
                </span>
                <span class="num strong min-w-20 text-right">{amountText(worth())}</span>
              </div>
            </div>
          </Show>
        )}
      </Show>
    </section>
  )
}

const trades = (person: MarketStats["investors"][number]) => `${person.trades} ${person.trades === 1 ? "trade" : "trades"} · holds ${amountText(person.value)}`

/** How everyone is doing: the market's own books, the best and worst investors, and what is held. */
export function MarketBoard(props: { stats: MarketStats | undefined }) {
  return (
    <Show when={props.stats?.investors.length ? props.stats : undefined}>
      {(stats) => (
        <>
          <section class="card p-5 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5">
            <Tile label="The market holds" value={number(stats().holds)}>
              losses, waiting to be someone's gain
            </Tile>
            <Tile label="Printed" value={number(stats().printed)}>
              for gains it couldn't cover
            </Tile>
            <Tile label="Fees" value={number(stats().fees)}>
              to the central bank
            </Tile>
          </section>
          <Ranked title="Wolves" note="up the most" people={stats().investors.filter((person) => person.result > 0).slice(0, 5)} amount={(person) => person.result} detail={trades} />
          <Ranked title="Bagholders" note="down the most" people={[...stats().investors].reverse().filter((person) => person.result < 0).slice(0, 5)} amount={(person) => person.result} detail={trades} />
          <Show when={stats().symbols.length}>
            <section class="card overflow-hidden">
              <table class="chart-table">
                <thead>
                  <tr>
                    <th>Held</th>
                    <th>Holders</th>
                    <th>Put in</th>
                    <th>Worth</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={stats().symbols}>
                    {(row) => (
                      <tr>
                        <td title={row.name}>{row.symbol}</td>
                        <td>{row.holders}</td>
                        <td>{number(row.cost)}</td>
                        <td>{row.value === null ? "–" : number(row.value)}</td>
                        <td classList={{ positive: row.value !== null && row.value > row.cost, danger: row.value !== null && row.value < row.cost }}>
                          {row.value === null ? "–" : percent(row.value / row.cost - 1)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
          </Show>
        </>
      )}
    </Show>
  )
}
