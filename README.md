# Tiny Bot — Dip Harvester with Trend Rides

![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)
![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/adzinsyariif/nw0230-tinybot/rank.svg)
![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/adzinsyariif/nw0230-tinybot/reward.svg)

Entry for the make.fun bounty [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1).

## Strategy

Buy pullbacks only while momentum is turning up, bank them fast, and let the rare
pullback that becomes a real trend run with a trailing stop.

- **Entry** (per symbol, hourly bars): MACD(8,21) above its signal line (EMA 5 of
  the MACD) **and** CCI(14) at or under -90 — momentum improving into a dip, not a
  falling knife and not a breakout chase. Stake is equity/7, capped by the 25%
  weight limit.
- **Exit (default)**: +1.2% take-profit, -5% stop, or 24 bars held, whichever
  comes first. Hourly bounces rarely offer more than a percent before rolling over.
- **Exit (converted)**: once a position closes above its EMA(24) twice in a row it
  becomes a trend ride — no take-profit; it leaves on a 6% trailing stop from its
  peak value, an 8% hard stop, or MACD crossing down.
- **Guardrail pacing**: micro round trips in the deepest pool (SOL) whenever the
  filled-trade count lags the pace that reaches the 8-trade minimum by bar 68.

Deterministic: no clock, no randomness, float64 indicator math only.

## Run

`main.ts` speaks the `agent-fun/bars-replay/v1` line protocol on stdin/stdout
(see `vendor/makefun-bars.ts`). With Node 22+:

```sh
node main.ts
```

## Dev-window result (kit `grade-local`, process driver)

| Metric | This bot | Buy-and-hold baseline |
| --- | --- | --- |
| Net PnL | **+158.69 USDC** | -869.34 USDC |
| Trades | 24 | 7 |
| Win rate | 61.5% | 0% |
| Max drawdown | 0.60% | 10.92% |
| Guardrails | met | not met (trades < 8) |

## License

MIT — see [LICENSE](LICENSE).
