# gta6-trophy-rarity-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/ansunchiang/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/ansunchiang/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A deterministic Node 22 forecast of GTA VI PS5 trophy earn rates on Exophase. It emits the 5th, 25th, 50th, 75th, and 95th percentiles for each trophy using only the case history.

Repeated snapshots count as one page state. The model projects the tracked player pool and each trophy's estimated earner count on a log-time scale, weights recent refreshes more heavily, and shrinks noisy trends toward comparable trophy groups. Count growth and player growth shift the forecast in log-odds space. Longer horizons widen the intervals, with more room for progress on late unlocks. Short horizons include a chance that the page has yet to refresh.

Both practice files contain the same unchanged launch-night page, with 638 tracked players and 943 trophy earns. Four 90-minute rolling cuts score against later reads inside those files. A separate check forecasts from the p01 cutoff to a public launch-day snapshot observed around 14:47 UTC on November 19, with 14,028 players. The week-ahead column uses four simulated player and trophy trajectories. [Exophase trophy page](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/)

| Model | Flat rolling cuts | Public launch-day read | Simulated week ahead |
| --- | ---: | ---: | ---: |
| House last read | 0.024854 | 2.375484 | 1.129790 |
| House curve (local reconstruction) | 0.024854 | 2.375484 | 1.840521 |
| Round 1 · Pooled logit trends | 0.127025 | 1.321761 | 1.081684 |
| Round 2 · Player and earner growth | 0.060979 | 0.550530 | 0.926097 |
| Round 3 · Recent trends and late unlocks | 0.069773 | 0.473237 | 1.015614 |
| Round 4 · Damped odds projection | 0.064937 | 0.491624 | 0.728999 |

Lower mean logit pinball loss is better. Round 4 covered 86.36% of simulated week-ahead outcomes with its 90% interval. The exact official practice answers are server-side. The flat cuts cover one unchanged page state, and the public check and simulations were used during development. Final performance remains unmeasured.

## Run it

```sh
K="$HOME/makefun/gta6-trophy-rarity-forecast-01-kit"
MAKEFUN_INPUT_DIR="$K/input" MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vxfctj3d&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
