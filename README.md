# paperboards

Leaderboard and protocol stats for [Papertrade](https://exchange.papertrade.xyz), built only from its public API and HyperEVM logs.

- **Leaderboard**: every depositor with balance (deposits − withdrawals + pnl + rewards claimed), PAPER held and share of supply, trade pnl, net pnl (trade pnl + staking rewards), acquisition cost per PAPER, staking rewards (claimed + unclaimed), deposits and withdrawals.
- **Stats**: supply, staking, inflation, staker rewards, protocol-wide APR and the mint curve, with hourly history.

## Data

| What | Source |
|---|---|
| Deposits / withdrawals | Exchange `0x6cd5…d0a2` logs on HyperEVM (chain 999) |
| Claimed rewards | PaperStaking `0xaad6…f016` `Claimed(address,uint256)` logs |
| Unclaimed rewards | `PaperStaking.pendingReward(address)` via Multicall3 |
| PAPER, pnl, names | `/state/leaderboard/accounts` (window `all`) |
| Hourly history | `/query/protocol/history?interval=1h` |
| Mint curve | `/query/protocol/summary`, one sample per index run |

## Run

```bash
npm ci
npm run depositors:index   # writes site/data/ranking.json (first run scans from genesis)
npm run depositors:serve   # http://localhost:8790/
```

`.github/workflows/depositors.yml` re-indexes every 10 minutes and publishes `site/` to GitHub Pages.
