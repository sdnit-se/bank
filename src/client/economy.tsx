// The Economy tab: how many coins exist, where they sit, and how much they move.

import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import type { Config, Economy, EconomyDay } from "../shared/types"

const number = (value: number) => value.toLocaleString("en-US")
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value))}`
const date = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** Round tick values covering low to high, in steps of 1, 2 or 5 times a power of ten. */
function ticks(low: number, high: number) {
  const rough = Math.max((high - low) / 3, 1)
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= rough)!
  const first = Math.floor(low / step) * step
  const values: number[] = []
  for (let value = first; value < high + step; value += step) values.push(value)
  return values
}

function Tile(props: { label: string; value: string; children?: JSX.Element }) {
  return (
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="faint">{props.label}</span>
      <span class="num strong text-[22px] leading-7 tracking-[-0.4px]">{props.value}</span>
      <span class="muted text-pretty">{props.children}</span>
    </div>
  )
}

const HEIGHT = 176
const MARGIN = { top: 10, right: 12, bottom: 24, left: 46 }

/** One series over the last 30 days, as a line or as bars from zero. Hovering reads off the day under the pointer. */
function Chart(props: { days: EconomyDay[]; value: (day: EconomyDay) => number; kind: "line" | "bars"; unit: (value: number) => string }) {
  let box!: HTMLDivElement
  const [width, setWidth] = createSignal(680)
  const [hover, setHover] = createSignal<number | null>(null)
  onMount(() => {
    const observer = new ResizeObserver(() => setWidth(box.clientWidth))
    observer.observe(box)
    onCleanup(() => observer.disconnect())
  })

  const values = createMemo(() => props.days.map(props.value))
  const marks = createMemo(() => {
    const low = Math.min(...values())
    const high = Math.max(...values())
    // Bars measure from zero. A line may zoom in, with a little room so a flat series sits mid-chart.
    if (props.kind === "bars") return ticks(0, Math.max(high, 3))
    const room = Math.max((high - low) * 0.1, high * 0.005, 1)
    // Nothing here can go below zero, so the axis doesn't either.
    return ticks(low >= 0 ? Math.max(0, low - room) : low - room, high + room)
  })
  const inner = () => ({ width: width() - MARGIN.left - MARGIN.right, height: HEIGHT - MARGIN.top - MARGIN.bottom })
  const band = () => inner().width / props.days.length
  const x = (index: number) => MARGIN.left + band() * (index + 0.5)
  const y = (value: number) => {
    const [low, high] = [marks()[0]!, marks()[marks().length - 1]!]
    return MARGIN.top + inner().height * (1 - (value - low) / (high - low))
  }
  const bar = (index: number) => {
    const wide = Math.max(1, Math.min(24, band() - 2))
    const top = y(values()[index]!)
    const base = y(0)
    const round = Math.min(4, (base - top) / 2, wide / 2)
    const left = x(index) - wide / 2
    // Rounded at the data end, square on the baseline.
    return `M${left},${base}V${top + round}Q${left},${top} ${left + round},${top}H${left + wide - round}Q${left + wide},${top} ${left + wide},${top + round}V${base}Z`
  }
  const point = (event: PointerEvent) => {
    const offset = event.clientX - box.getBoundingClientRect().left - MARGIN.left
    setHover(Math.max(0, Math.min(props.days.length - 1, Math.floor(offset / band()))))
  }
  const labelled = () => [0, Math.floor((props.days.length - 1) / 2), props.days.length - 1]

  return (
    <div ref={box} class="relative select-none" onPointerMove={point} onPointerLeave={() => setHover(null)}>
      <svg width={width()} height={HEIGHT} role="img" class="block">
        <For each={marks()}>
          {(mark) => (
            <>
              <line x1={MARGIN.left} x2={width() - MARGIN.right} y1={y(mark)} y2={y(mark)} class="chart-grid" />
              <text x={MARGIN.left - 8} y={y(mark)} dy="0.32em" text-anchor="end" class="chart-axis">
                {number(mark)}
              </text>
            </>
          )}
        </For>
        <For each={labelled()}>
          {(index, position) => (
            <text x={x(index)} y={HEIGHT - 6} text-anchor={position() === 0 ? "start" : position() === 2 ? "end" : "middle"} class="chart-axis">
              {date(props.days[index]!.day)}
            </text>
          )}
        </For>
        <Show
          when={props.kind === "line"}
          fallback={
            <For each={props.days}>
              {(_, index) => (
                <Show when={values()[index()]! > 0}>
                  <path d={bar(index())} class="chart-fill" opacity={hover() === null || hover() === index() ? 1 : 0.45} />
                </Show>
              )}
            </For>
          }
        >
          <path d={values().map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join("")} class="chart-line" />
          <Show when={hover() !== null}>
            <line x1={x(hover()!)} x2={x(hover()!)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} class="chart-crosshair" />
            <circle cx={x(hover()!)} cy={y(values()[hover()!]!)} r="4" class="chart-dot" />
          </Show>
        </Show>
      </svg>
      <Show when={hover() !== null}>
        <div
          class="chart-tip"
          style={{
            left: `${Math.max(64, Math.min(width() - 64, x(hover()!)))}px`,
            top: `${Math.max(0, y(values()[hover()!]!) - 40)}px`,
          }}
        >
          <span class="strong num">{props.unit(values()[hover()!]!)}</span>
          <span class="faint">{date(props.days[hover()!]!.day)}</span>
        </div>
      </Show>
    </div>
  )
}

function Section(props: { title: string; note: string; children: JSX.Element }) {
  return (
    <section class="card overflow-hidden">
      <h2 class="m-0 p-4 pb-2 text-[13px] leading-5 font-[inherit]">
        <span class="strong">{props.title}</span> <span class="faint">· {props.note}</span>
      </h2>
      <div class="px-2 pb-3">{props.children}</div>
    </section>
  )
}

export function EconomyView(props: { config: Config; economy: Economy | undefined }) {
  const coins = (value: number) => `${number(value)} ${Math.abs(value) === 1 ? props.config.singular : props.config.plural}`
  const percent = (value: number) => `${Math.round(value * 100)}%`
  return (
    <Show when={props.economy} fallback={<section class="card px-4 py-8 text-center faint">Loading…</section>}>
      {(economy) => {
        const before = () => economy().supply.total - economy().growth.month
        return (
          <div class="flex flex-col gap-4">
            <section class="card p-5 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5">
              <Tile label="Money supply" value={number(economy().supply.total)}>
                {number(economy().supply.people)} held by {economy().members} people
              </Tile>
              <Tile label="GDP · 7 days" value={number(economy().gdp.week)}>
                {number(economy().gdp.month)} in 30 days
              </Tile>
              <Tile label="Inflation · 30 days" value={before() > 0 ? `${signed(Math.round((economy().growth.month / before()) * 1000) / 10)}%` : "new"}>
                {signed(economy().growth.month)} {props.config.plural}
              </Tile>
              <Tile label="Central bank" value={number(economy().supply.central)}>
                house {number(economy().supply.house)} · pot {number(economy().supply.pot)} · market {number(economy().supply.market)}
              </Tile>
              <Tile label="Casino · 7 days" value={number(economy().turnover.week)}>
                {number(economy().turnover.month)} in 30 days
              </Tile>
              <Tile label="Richest holds" value={percent(economy().richestShare)}>
                {economy().broke} broke · gini {economy().gini.toFixed(2)}
              </Tile>
            </section>

            <Section title="Money supply" note="30 days">
              <Chart days={economy().days} value={(day) => day.supply} kind="line" unit={coins} />
            </Section>

            <Section title="GDP per day" note={`${props.config.plural} given between people`}>
              <Chart days={economy().days} value={(day) => day.gifts} kind="bars" unit={coins} />
            </Section>

            <details class="card">
              <summary class="px-4 py-3 cursor-pointer muted">Table</summary>
              <div class="overflow-x-auto">
                <table class="chart-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Supply</th>
                      <th>Given</th>
                      <th>Staked</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={[...economy().days].reverse()}>
                      {(day) => (
                        <tr>
                          <td>{date(day.day)}</td>
                          <td>{number(day.supply)}</td>
                          <td>{number(day.gifts)}</td>
                          <td>{number(day.bets)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )
      }}
    </Show>
  )
}
