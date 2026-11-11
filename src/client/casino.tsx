// The Casino tab: what the games have done to everyone, read off the ledger.

import { For, Show } from "solid-js"
import { amountText, nextDraw, type CasinoStats, type Config } from "../shared/types"
import { Chart, date, number, Ranked, Section, signed, Tile } from "./economy"

const NAMES: Record<string, string> = { flip: "Coin flip", slots: "Slots", roulette: "Roulette", blackjack: "Blackjack", lottery: "Lottery", duel: "Duels" }
/** The next daily draw in the viewer's own time: "today 09:00" or "tomorrow 09:00". */
function drawTime() {
  const at = new Date(nextDraw(Date.now()))
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return `${at.toDateString() === new Date().toDateString() ? "today" : "tomorrow"} ${time}`
}

/** The viewer's own calendar day for a moment, as YYYY-MM-DD. */
const localDay = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–")

const record = (person: CasinoStats["people"][number]) => `${person.bets} bets · won ${person.wins} · worst run ${person.streak}`

export function CasinoView(props: { config: Config; stats: CasinoStats | undefined }) {
  const coins = (value: number) => `${number(value)} ${Math.abs(value) === 1 ? props.config.singular : props.config.plural}`
  return (
    <Show when={props.stats} fallback={<section class="card px-4 py-8 text-center faint">Loading…</section>}>
      {(stats) => {
        const house = () => stats().games.filter((game) => game.game !== "lottery" && game.game !== "duel")
        const staked = () => house().reduce((sum, game) => sum + game.staked, 0)
        const paid = () => house().reduce((sum, game) => sum + game.paid, 0)
        const losers = () => [...stats().people].reverse().filter((person) => person.net < 0).slice(0, 5)
        const winners = () => stats().people.filter((person) => person.net > 0).slice(0, 5)
        const busiest = () => [...stats().people].sort((a, b) => b.bets - a.bets)[0]
        const coldest = () => [...stats().people].sort((a, b) => b.streak - a.streak)[0]
        return (
          <div class="flex flex-col gap-4">
            <section class="card p-5 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5">
              <Tile label="Staked" value={number(stats().staked)}>
                {number(stats().bets)} bets
              </Tile>
              <Tile label={stats().houseProfit < 0 ? "The house is down" : "The house is up"} value={number(Math.abs(stats().houseProfit))}>
                returned {share(paid(), staked())} of stakes
              </Tile>
              <Tile label="Casino vs honest work" value={stats().gifts > 0 ? `${(stats().staked / stats().gifts).toFixed(1)}×` : "–"}>
                staked per {props.config.singular} given
              </Tile>
              <Tile label="Biggest win" value={stats().biggestWin ? `+${number(stats().biggestWin!.paid - stats().biggestWin!.stake)}` : "–"}>
                <Show when={stats().biggestWin} fallback="nobody yet">
                  {stats().biggestWin!.name} · {(NAMES[stats().biggestWin!.game] ?? stats().biggestWin!.game).toLowerCase()} · on {amountText(stats().biggestWin!.stake)}
                </Show>
              </Tile>
              <Tile label="Lottery pot" value={number(stats().pot)}>
                {stats().tickets} tickets · next draw {drawTime()}
              </Tile>
              <Tile label="Worst losing run" value={coldest() ? String(coldest()!.streak) : "–"}>
                <Show when={coldest()} fallback="nobody yet">
                  {coldest()!.name} · most bets: {busiest()!.name}, {busiest()!.bets}
                </Show>
              </Tile>
            </section>

            <Ranked title="Hall of shame" note="lost the most" people={losers()} amount={(person) => person.net} detail={record} />
            <Ranked title="Somehow ahead" note="won the most" people={winners()} amount={(person) => person.net} detail={record} />

            <section class="card overflow-hidden">
              <table class="chart-table">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Plays</th>
                    <th>Staked</th>
                    <th>Paid back</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={stats().games}>
                    {(game) => (
                      <tr>
                        <td>{NAMES[game.game] ?? game.game}</td>
                        <td>{number(game.plays)}</td>
                        <td>{number(game.staked)}</td>
                        <td>{number(game.paid)}</td>
                        <td>{share(game.paid, game.staked)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>

            <Section title="House profit" note="running total, 30 days">
              <Chart days={stats().days} value={(day) => day.profit} kind="line" unit={(value) => `${signed(value)} ${props.config.plural}`} />
            </Section>

            <Section title="Lottery pot" note="hour by hour, 7 days">
              <Chart
                days={stats().potHours.map((hour) => ({ ...hour, day: localDay(hour.at) }))}
                value={(hour) => hour.pot}
                kind="line"
                unit={coins}
                label={(hour) => new Date(hour.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
              />
            </Section>

            <Show when={stats().draws.length}>
              <Section title="Lottery draws" note="pot and who took it">
                <Chart
                  days={stats().draws.map((draw) => ({ ...draw, day: new Date(draw.at).toISOString().slice(0, 10) }))}
                  value={(draw) => draw.pot}
                  kind="bars"
                  unit={coins}
                  label={(draw) => `${draw.winner.name} · ${date(draw.day)}`}
                />
              </Section>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
