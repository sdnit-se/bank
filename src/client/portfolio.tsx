// The Portfolio tab: what someone holds in the stock market and what it is worth now. Trading happens in Slack.

import { For, Show } from "solid-js"
import { amountText, type Config, type Portfolio } from "../shared/types"

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
