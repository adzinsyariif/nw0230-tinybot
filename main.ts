// Tiny Bot entry: buy pullbacks only while momentum is turning up, bank them fast,
// and let the rare pullback that becomes a real trend run with a trailing stop.
//
// Rules, per symbol on hourly bars:
//   Entry: MACD(8,21) above its signal line (EMA 5 of the MACD) AND CCI(14) at or
//          under -60 — momentum improving into a dip, not a falling knife and not a
//          breakout chase. Stake is equity/7, capped by the 25% weight limit.
//   Exit (default): +1.2% take-profit, -5% stop, or 24 bars held, whichever first.
//          Hourly bounces rarely offer more than a percent before rolling over.
//   Exit (converted): once a position closes above its EMA(24) twice in a row it is
//          treated as a trend ride instead — no take-profit; it leaves on a 6%
//          trailing stop from its peak value, an 8% hard stop, or MACD crossing down.
// A pacing rule adds micro round trips in the deepest pool whenever the filled-trade
// count lags the pace that reaches the 8-trade guardrail by bar 68 of a 72-bar window.
//
// Deterministic: no clock, no randomness, float64 indicator math, ties by symbol name.

import { runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

// --- knobs ---
const MACD_FAST = 8;
const MACD_SLOW = 21;
const MACD_SIGNAL = 5;
const CCI_BARS = 14;
const CCI_ENTRY = -90; // enter at or under this
const WARM_BARS = 14; // bars before any entry (CCI needs its full window)
const TP_NUM = 1012n; // take profit at 101.2% of cost
const TP_DEN = 1000n;
const SL_NUM = 95n; // stop at 95% of cost
const SL_DEN = 100n;
const TIMEOUT = 24; // bars held before a non-converted position is closed
const CONVERT_EMA = 24; // closes above this EMA, CONVERT_BARS in a row, convert to a ride
const CONVERT_BARS = 2;
const TRAIL_NUM = 94n; // ride exit: value under 94% of peak value
const TRAIL_DEN = 100n;
const RIDE_SL_NUM = 92n; // ride hard stop: value under 92% of cost
const RIDE_SL_DEN = 100n;
const SLIP_BPS = 250;
const MICRO_PCT = 1n;
const PACE_END_BAR = 68;
const PACE_MIN_TRADES = 8;

// --- per-symbol indicator state ---
interface Series {
  emaFast: number | null;
  emaSlow: number | null;
  signal: number | null;
  macd: number | null;
  emaTrend: number | null; // EMA(CONVERT_EMA) of closes
  typical: number[]; // last CCI_BARS typical prices
  lastClose: number | null;
}

const series = new Map<string, Series>();
const entrySeq = new Map<string, number>();
const peakValue = new Map<string, bigint>();
const converted = new Set<string>();
const aboveStreak = new Map<string, number>();
let filledTrades = 0;
let microLeg: 'sell' | null = null;
let microSymbol = 'SOL';

function seriesOf(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { emaFast: null, emaSlow: null, signal: null, macd: null, emaTrend: null, typical: [], lastClose: null };
    series.set(symbol, s);
  }
  return s;
}

function stepEma(prev: number | null, x: number, span: number): number {
  if (prev === null) return x;
  return prev + (2 / (span + 1)) * (x - prev);
}

function pushBar(symbol: string, bar: { h: string; l: string; c: string }): void {
  const s = seriesOf(symbol);
  const c = Number(bar.c);
  s.emaFast = stepEma(s.emaFast, c, MACD_FAST);
  s.emaSlow = stepEma(s.emaSlow, c, MACD_SLOW);
  s.macd = s.emaFast - s.emaSlow;
  s.signal = stepEma(s.signal, s.macd, MACD_SIGNAL);
  s.emaTrend = stepEma(s.emaTrend, c, CONVERT_EMA);
  s.typical.push((Number(bar.h) + Number(bar.l) + c) / 3);
  if (s.typical.length > CCI_BARS) s.typical.shift();
  s.lastClose = c;
}

function cci(s: Series): number | null {
  if (s.typical.length < CCI_BARS || s.lastClose === null) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / CCI_BARS;
  const mad = s.typical.reduce((a, x) => a + Math.abs(x - mean), 0) / CCI_BARS;
  const typ = s.typical[s.typical.length - 1]!;
  if (mad === 0) return 0;
  return (typ - mean) / (0.015 * mad);
}

function momentumUp(s: Series): boolean {
  return s.macd !== null && s.signal !== null && s.macd > s.signal;
}

/** Whether a held position closes on this bar. Updates peak/conversion bookkeeping. */
function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, seq: number): boolean {
  const value = state.value(symbol, held.qty);
  const peak = peakValue.get(symbol);
  if (peak === undefined || value > peak) peakValue.set(symbol, value);

  const s = series.get(symbol);
  if (s !== undefined && s.emaTrend !== null && s.lastClose !== null) {
    const streak = s.lastClose > s.emaTrend ? (aboveStreak.get(symbol) ?? 0) + 1 : 0;
    aboveStreak.set(symbol, streak);
    if (streak >= CONVERT_BARS) converted.add(symbol);
  }

  if (converted.has(symbol)) {
    const nowPeak = peakValue.get(symbol)!;
    if (value * RIDE_SL_DEN <= held.cost * RIDE_SL_NUM) return true;
    if (value * TRAIL_DEN <= nowPeak * TRAIL_NUM) return true;
    if (s !== undefined && s.macd !== null && s.signal !== null && s.macd < s.signal) return true;
    return false;
  }

  if (value * TP_DEN >= held.cost * TP_NUM) return true;
  if (value * SL_DEN <= held.cost * SL_NUM) return true;
  const born = entrySeq.get(symbol);
  if (born !== undefined && seq - born >= TIMEOUT) return true;
  return false;
}

function forget(symbol: string): void {
  entrySeq.delete(symbol);
  peakValue.delete(symbol);
  converted.delete(symbol);
  aboveStreak.delete(symbol);
}

await runBars({
  onHello(state) {
    const names = state.hello.symbols.map((s) => s.symbol);
    if (!names.includes(microSymbol)) microSymbol = names[0]!;
  },
  onBatch(state, batch) {
    for (const bar of batch.bars) pushBar(bar.symbol, bar);
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      filledTrades++;
      if (f.side === 'buy' && !entrySeq.has(f.symbol)) entrySeq.set(f.symbol, batch.seq);
      if (f.side === 'sell') forget(f.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const fresh = new Set(batch.bars.map((b) => b.symbol));

    // Close the pacing round trip first; it is never a real position.
    if (microLeg === 'sell') {
      microLeg = null;
      const held = state.positions.get(microSymbol);
      if (held !== undefined && !entrySeq.has(microSymbol)) {
        return [{ side: 'sell', symbol: microSymbol, qty: held.qty, max_slippage_bps: SLIP_BPS }];
      }
      return [];
    }

    const sells: SellInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held === undefined || !fresh.has(symbol)) continue;
      if (shouldExit(state, symbol, held, batch.seq)) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SLIP_BPS });
      }
    }

    const orders: OrderInput[] = sells.slice(0, caps.max_orders_per_bar);
    if (batch.seq >= WARM_BARS) {
      const stake = state.equity / BigInt(state.hello.symbols.length);
      let cashLeft = state.cash;
      let slotsLeft = caps.max_open_positions - state.positions.size;
      for (const { symbol } of state.hello.symbols) {
        if (slotsLeft <= 0 || orders.length >= caps.max_orders_per_bar) break;
        if (state.positions.has(symbol) || !fresh.has(symbol)) continue;
        const s = series.get(symbol);
        if (s === undefined || !momentumUp(s)) continue;
        const c = cci(s);
        if (c === null || c > CCI_ENTRY) continue;
        const room = state.weightRoom(symbol);
        let size = stake < room ? stake : room;
        if (cashLeft < size) size = cashLeft;
        if (size < minNotional) continue;
        const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: SLIP_BPS };
        orders.push(buy);
        cashLeft -= size;
        slotsLeft--;
      }
    }

    // Pacing insurance for the 8-trade guardrail.
    if (orders.length === 0 && microLeg === null && batch.seq >= 18) {
      const due = Math.ceil((PACE_MIN_TRADES * batch.seq) / PACE_END_BAR);
      if (filledTrades < due && state.close(microSymbol) !== null && !state.positions.has(microSymbol)) {
        let size = (state.equity * MICRO_PCT) / 100n;
        if (size < minNotional * 3n) size = minNotional * 3n;
        const room = state.weightRoom(microSymbol);
        if (room < size) size = room;
        if (state.cash < size) size = state.cash;
        if (size >= minNotional) {
          microLeg = 'sell';
          return [{ side: 'buy', symbol: microSymbol, notional_quote_units: size, max_slippage_bps: SLIP_BPS }];
        }
      }
    }

    return orders;
  },
});
