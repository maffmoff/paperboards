// Stats page, in three groups:
//   Now      – the state at this moment (user balances, max supply, valuation).
//   Activity – a 1H / 1D switch: headline totals over the last complete hour or 24 h, and the whole history as
//              hourly or daily bars / levels (volume, trader pnl, staker rewards, tvl, users, open interest).
//   Rules    – the pool and the curves the protocol's parameters define, with the current position marked.
// Reads ranking.json through window.paperboards (app.js) and draws into #now, #activity-*, #rules-*.
(() => {
  "use strict";
  const pb = () => window.paperboards;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);
  const usd = (v) => {
    if (v == null || !Number.isFinite(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}K` : `${s}$${a.toFixed(0)}`;
  };
  const signedUsd = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${usd(v)}`);
  const count = (v) => (v == null ? "–" : Math.round(v).toLocaleString("en-US"));
  const paper = (v) => (v == null ? "–" : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : count(v));
  const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
  // Per-PAPER dollar amounts: 3 significant figures below $1 ($0.00721), cents above.
  const unit = (v) => (v == null || !Number.isFinite(v) ? "–" : v === 0 ? "$0" : `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1 ? Math.abs(v).toFixed(2) : Math.abs(v).toPrecision(3)}`);
  // Axis formats shared by the Rules charts: rate per $, PAPER in billions, and percentages compacted past 10,000%.
  const rateFmt = (v) => (v === 0 ? "0/$" : `${v.toFixed(1)}/$`);
  const supplyFmt = (v) => (v === 0 ? "0" : `${(v / 1e9).toFixed(2)}B`);
  const bigPct = (v) => { const p = v * 100; return p >= 1e6 ? `${+(p / 1e6).toFixed(1)}M%` : p >= 1e4 ? `${Math.round(p / 1e3)}K%` : pct(v, p < 10 ? 1 : 0); };
  // Every history on the page starts at PAPER's launch, 2026-10-10 22:00 SGT (14:00 UTC); labels show the viewer's
  // local time.
  const HISTORY_START = Date.UTC(2026, 9, 10, 14);
  // Every full chart shares one frame, so plots line up down each column and across the grid: the same height, the same
  // left margin (value axis) and right margin (second axis, kept even on charts without one), the same top and bottom.
  // T holds the axis titles (what each axis shows: "Cumulative", "TVL", …) above the plot, on every chart alike.
  const FRAME = { H: 160, L: 64, R: 64, T: 18, B: 20 };
  // Bars are at most this wide, so a few daily buckets do not turn into blocks.
  const MAX_BAR = 24;
  const hourLabel = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  // An "i" badge after a label; its explanation shows on hover or focus (style.css .info), instead of a native title popup.
  const info = (text) => `<button type="button" class="info" data-tip="${esc(text)}" aria-label="About this figure">i</button>`;
  const setInfo = (fig, text) => { const span = fig.querySelector("figcaption span"); const old = span.querySelector(".info"); if (old) old.remove(); if (text) span.insertAdjacentHTML("beforeend", info(text)); };
  const kpi = (label, value, title = "", note = "") => `<div class="kpi"><span>${esc(label)}${title ? info(title) : ""}</span><b>${esc(value)}</b>${note ? `<em>${esc(note)}</em>` : ""}</div>`;

  // ---------------------------------------------------------------------------------------------- Now
  const maxSupply = (c) => (c && c.decayScale > 0 && c.flatRate > 0 ? c.supplyPaper + (c.flatRate * c.decayScale * c.decayScale) / (c.decayScale + c.tailProgress) : null);

  function renderNow(d) {
    const c = d.curve, m = d.mint, cc = d.crossCheck || {};
    const max = maxSupply(c);
    // What one PAPER costs to mint today, as two bounds (the Rules cost chart): the floor for a hedged pair and no hedge.
    const rNow = c && c.decayScale > 0 ? c.flatRate * (c.decayScale / (c.decayScale + c.tailProgress)) ** 2 : null;
    const cost = rNow > 0 ? 1 / ((0.98 / (1 - 0.9 * 0.98)) * rNow) : null, costNoHedge = rNow > 0 ? 1 / (0.98 * rNow) : null;
    // Staking APR over the 24 h ending at the last complete hour: rewards per staked PAPER, annualized, ÷ what one PAPER
    // costs to mint today with no hedge (the cost basis of a fresh staker, not the all-time average of past minting).
    const p1d = d.protocol && d.protocol.periods && d.protocol.periods["1d"];
    const apr = p1d && p1d.rewardPerPaperYear != null && costNoHedge > 0 ? p1d.rewardPerPaperYear / costNoHedge : null;
    // Payback in days at that same 24 h rate: cost ÷ (USDC per PAPER per day), for both cost bounds. Trailing like APR.
    const perDay = p1d && p1d.rewardPerPaperYear > 0 ? p1d.rewardPerPaperYear / 365 : null;
    const payback = perDay && cost > 0 && costNoHedge > 0 ? { hedged: cost / perDay, noHedge: costNoHedge / perDay } : null;
    const days = (v) => (!Number.isFinite(v) ? "–" : v < 1 ? "<1 d" : v < 10 ? `${v.toFixed(1)} d` : `${Math.round(v).toLocaleString("en-US")} d`);
    // The current point of every Rules chart (the charts themselves carry no marker): pool, cost, counted losses, rate,
    // supply, inflation; the dev fee total comes from app.js's dev-fee data.
    const lpNow = m && m.series && m.series.trackedLpUsd ? m.series.trackedLpUsd.filter((v) => v != null).pop() : null;
    const rateNow = c && c.decayScale > 0 ? c.flatRate * (c.decayScale / (c.decayScale + c.tailProgress)) ** 2 : null;
    const inflation = (() => { const mk = d.protocol && d.protocol.market, asOf = d.protocol && d.protocol.asOfMs; if (!mk || !mk.paperSupply) return null; const hist = new Map(); mk.paperSupply.forEach((v, i) => { const end = mk.startMs + (i + 1) * mk.intervalMs; if (!(asOf && end > asOf) && Number.isFinite(v)) hist.set(end, v); }); const t = Math.max(...hist.keys()), prev = hist.get(t - 86_400_000); return prev > 0 ? hist.get(t) / prev - 1 : null; })();
    // Activity's current figures (the charts carry titles only): flows over the 24 h ending at the last complete hour,
    // like APR and inflation; levels as read now.
    const fl = d.protocol && d.protocol.flows && d.protocol.flows["1d"], oi = d.openInterest, oiN = oi ? oi.times.length - 1 : -1;
    const tvlNow = cc.apiTvl18 ? Number(BigInt(cc.apiTvl18) / 10n ** 12n) / 1e6 : d.protocol && d.protocol.market ? d.protocol.market.tvl.filter((v) => v != null).pop() : null;
    const netExp = oi && oi.total[oiN] > 0 ? ((oi.btcLong[oiN] + oi.ethLong[oiN]) - (oi.btcShort[oiN] + oi.ethShort[oiN])) / oi.total[oiN] : null;
    const devFee = d.devFee && d.devFee.claimedTotal18 != null ? Number(BigInt(d.devFee.claimedTotal18) / 10n ** 12n) / 1e6 + (d.devFee.unclaimed18 != null ? Number(BigInt(d.devFee.unclaimed18) / 10n ** 12n) / 1e6 : 0) : null;
    // Order: official readings first, then simple ratios, then formulas and models (the strongest assumptions last).
    $("now").innerHTML = [
      kpi("TVL", usd(tvlNow), "official protocol treasury value = deposits − withdrawals; trader pnl and staker rewards stay inside the exchange"),
      kpi("Open interest", oi ? usd(oi.total[oiN]) : "–", "entry notional of open positions, long + short (official house history, latest hourly reading)"),
      kpi("Volume · 24h", fl ? usd(fl.volume) : "–", "total traded in the last complete 24 h (official protocol history)"),
      kpi("Trader PnL · 24h", fl ? signedUsd(fl.pnlChange) : "–", "change in cumulative trader PnL in the last complete 24 h; negative = traders lost"),
      kpi("Staker rewards · 24h", fl ? usd(fl.rewards) : "–", "USDC paid to stakers in the last complete 24 h"),
      kpi("Supply", paper(c.supplyPaper), "PAPER minted so far (official)"),
      kpi("LP balance", usd(lpNow), `tracked LP, the pool balance the mint curve reads (latest 10-minute sample); mint-decay threshold ${usd(c.threshold)}, staker threshold ${usd(c.stakerCap)}`),
      kpi("Counted losses", usd(c.tailProgress), "tail progress: the losses the mint curve has counted since the pool first crossed the cliff; what sets today's mint rate"),
      kpi("Net exposure", netExp == null ? "–" : `${netExp > 0 ? "+" : ""}${pct(netExp, 0)}`, "(long − short) ÷ (long + short) of open interest; positive = traders net long, so the house is net short"),
      kpi("Inflation · 24h", pct(inflation, inflation != null && inflation < 0.1 ? 1 : 0), "PAPER supply growth over the last complete 24 h (official hourly history)"),
      kpi("Mint rate", rateNow == null ? "–" : `${rateNow.toFixed(1)}/$`, `PAPER minted per $1 of counted loss: ${c.flatRate} × (D ÷ (D + counted losses))², D = ${usd(c.decayScale)}`),
      kpi("Dev fees accrued", usd(devFee), "the dev half of trading fees since genesis: claimed (exchange events) + unclaimed (devFeeAccumulator)"),
      kpi("APR · 24h", pct(apr, 0), "USDC paid to stakers over the last complete 24 h per staked PAPER, annualized, ÷ today's cost to mint one PAPER with no hedge (1 ÷ (0.98 × mint rate)). Rewards come in lumps: a trailing figure, not a forecast"),
      kpi("Payback · 24h", payback == null ? "–" : `${days(payback.hedged)} – ${days(payback.noHedge)}`, "days of distributions, at the rate paid to stakers over the last complete 24 h, until one PAPER minted today has returned its cost: from the hedged floor to no hedge. Assumes that rate holds and the supply stays as it is; minting dilutes each PAPER and distributions follow trader losses, so new deposits must keep coming for the payback to be reached"),
      kpi("Max supply ≈", paper(max), "current supply + what the mint curve can still emit, if the pool never dips below the cliff again; liquidations mint up to 2% more, and the owner can change the curve's parameters"),
      kpi("Cost to mint", `${unit(cost)} – ${unit(costNoHedge)}`, "what one PAPER costs at today's mint rate: from the floor for a hedged long + short pair with the widest exit (the win leg recovers at most 88.2% of the loss: 1 ÷ (8.31 × rate)) to no hedge (1 ÷ (0.98 × rate))"),
      kpi("Valuation", max != null && cost != null ? `${usd(cost * max)} – ${usd(costNoHedge * max)}` : "–", "max supply × today's cost to mint one PAPER, from the hedged floor to no hedge"),
    ].join("");
  }


  // ------------------------------------------------------------------------------------------ Activity
  // Granularity of the Activity charts: hourly bars, or one bar per local day. Headline figures cover the last complete
  // hour or the 24 h ending at the last complete hour (protocol.flows / periods), not the bar in progress.
  // 5M covers the last 24 h only (the official 1-minute history, coarsened by the indexer).
  const PERIODS = [["5m", "5M", 5 / 60], ["1h", "1H", 1], ["1d", "1D", 24]];
  // X axis of the two tail projections in Rules: estimated date (at the current tail speed) or cumulative realized loss.
  let tailAxis = "time";
  try { const v = localStorage.getItem("paperboards.tailAxis"); if (v === "time" || v === "loss") tailAxis = v; } catch { /* storage unavailable */ }
  // How far the projections run (the Rules "horizon" switch): every time-axis projection and the dev-fee chart share it.
  const HORIZONS = [[7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"], [730, "2Y"], [1825, "5Y"]];
  // Projection points: hourly up to 30 days, every 6 hours up to a year, daily beyond (5 years hourly would be ~44,000
  // points per line, for a curve that is smooth at that scale).
  const stepHours = () => (horizon <= 30 ? 1 : horizon <= 365 ? 6 : 24);
  let horizon = 30;
  try { const v = Number(localStorage.getItem("paperboards.horizon")); if (HORIZONS.some(([d]) => d === v)) horizon = v; } catch { /* storage unavailable */ }
  // Time labels on the projected charts: hour precision up to 30 days, dates with the year beyond that.
  const dayLabel = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const horizonLabel = () => (horizon > 30 ? dayLabel : hourLabel);
  let period = "1h";
  try { const v = localStorage.getItem("paperboards.period"); if (PERIODS.some(([k]) => k === v)) period = v; } catch { /* storage unavailable */ }

  function renderActivity(d) {
    const five = period === "5m", p = d.protocol || {}, m = five ? d.market5m : p.market;
    const [, , hours] = PERIODS.find(([k]) => k === period);
    for (const b of document.querySelectorAll("#period button")) b.classList.toggle("on", b.dataset.period === period);
    const box = $("activity-rows");
    // Whole history, bucketed by the granularity: flows (bars) are summed per bucket, levels keep the bucket's last value.
    // Daily buckets start at local midnight; hourly buckets are the history's own hours.
    const daily = hours >= 24;
    // Daily buckets start at local midnight. The launch evening (the two hours from HISTORY_START to the next midnight)
    // joins the first full day: on its own it is too narrow for a bar or a label, and nothing precedes launch.
    const firstMidnight = (() => { const t = new Date(HISTORY_START); t.setHours(24, 0, 0, 0); return t.getTime(); })();
    const keyOf = (ms) => { if (!daily) return ms; const t = new Date(ms); t.setHours(0, 0, 0, 0); return Math.max(t.getTime(), firstMidnight); };
    const bucket = (series, sum) => {
      const out = [];
      for (const [ms, v] of series) {
        if (v == null || !Number.isFinite(v)) continue;
        const k = keyOf(ms), lastB = out[out.length - 1];
        if (lastB && lastB[0] === k) lastB[1] = sum ? lastB[1] + v : v; else out.push([k, v]);
      }
      return out;
    };
    let pts = () => [], flow = () => [], t0 = 0;
    if (m && m.tvl.length >= 2) {
      const t = (i) => m.startMs + i * m.intervalMs;
      // From HISTORY_START: bars from the first hour starting there, levels from the reading at that moment.
      t0 = HISTORY_START;
      const raw = (arr, shift = 0) => arr.map((v, i) => [t(i) + shift, v]).filter(([x]) => x >= HISTORY_START);
      // Levels: each hourly value is the reading at the hour's end, so it is plotted there.
      pts = (arr) => bucket(raw(arr, m.intervalMs), false);
      // Flows: hourly bars are complete hours only (the hour in progress holds a partial reading); daily bars run from
      // local midnight, so the last one is today so far.
      const asOf = (five ? m.asOfMs : p.asOfMs) || Infinity;
      flow = (arr) => bucket(raw(arr).filter(([x]) => daily || x + m.intervalMs <= asOf), true);
    }
    // A flow row's headline is its latest bar: the last complete hour (1H) or today so far, local time (1D).
    const latest = (bars, fmt) => (bars && bars.length ? fmt(bars[bars.length - 1][1]) : "–");
    const span = daily ? "today so far (local time)" : five ? "the last complete 5 minutes" : "the last complete hour";
    // Short form beside a flow's headline, so the value's period is read without hovering.
    const spanShort = daily ? "today" : five ? "last 5 min" : "last hour";
    const per = daily ? "day" : five ? "5 min" : "hour";
    // Deposits (inflow) and withdrawals (outflow, drawn below zero) per bar, from the Exchange events; the last bucket
    // is complete only when the data was generated after its end.
    const cf = d.capitalFlows && (five ? d.capitalFlows.fiveMinute : d.capitalFlows.hourly), genMs = Date.parse(d.generatedAt);
    const cfBars = (arr, sign) => (cf ? bucket(arr.map((v, i) => [cf.startMs + i * cf.intervalMs, sign * v]).filter(([x]) => x >= HISTORY_START && (daily || x + cf.intervalMs <= genMs)), true) : null);
    const inBars = cf && cfBars(cf.inflow, 1), outBars = cf && cfBars(cf.outflow, -1);
    // Both flows on one chart: a bar up for the deposits and a bar down for the withdrawals of each bucket.
    const flowBars = inBars && outBars ? [...inBars.map(([t, v]) => [t, v, "In"]), ...outBars.map(([t, v]) => [t, v, "Out"])].sort((a, b) => a[0] - b[0]) : null;
    const timeLabel = daily ? (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : hourLabel;
    const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const oi = five ? d.openInterest5m : d.openInterest;
    const oiPts = oi ? bucket(oi.times.map((x, i) => [x, oi.total[i]]).filter(([x]) => x >= t0), false) : null;
    // Net exposure of open interest: (long − short) ÷ (long + short), BTC + ETH entry notional; positive = traders net
    // long (the house net short), 0 = balanced, ±100% = one-sided.
    const netAt = (i) => (oi.btcLong[i] + oi.ethLong[i]) - (oi.btcShort[i] + oi.ethShort[i]);
    const netPctAt = (i) => (oi.total[i] > 0 ? netAt(i) / oi.total[i] : null);
    const netPts = oi ? bucket(oi.times.map((x, i) => [x, netPctAt(i)]).filter(([x, v]) => x >= t0 && v != null && Number.isFinite(v)), false) : null;
    // Notional opened and closed per bucket, derived (the API has no open/close split): volume counts both opening and
    // closing fills and the change in open interest is their difference, so opened = (volume + ΔOI) ÷ 2 and
    // closed = (volume − ΔOI) ÷ 2, ΔOI read from the open-interest reading at each bucket's start and end. Closed
    // includes liquidations. Drawn as bars up (opened) and down (closed) under the open-interest line.
    const oiAt = (t) => { let lo = 0, hi = oi.times.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (oi.times[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; } return best < 0 ? null : oi.total[best]; };
    const openClose = oi && m ? flow(m.volumePerInterval).map(([k, v], i, arr) => {
      const end = daily ? (i + 1 < arr.length ? arr[i + 1][0] : oi.times[oi.times.length - 1]) : k + m.intervalMs;
      const a = oiAt(k), b = oiAt(end);
      if (a == null || b == null) return null;
      const dOI = b - a, opened = Math.min(v, Math.max(0, (v + dOI) / 2));
      return [k, opened, -(v - opened)];
    }).filter(Boolean) : [];
    const ocBars = openClose.length ? [...openClose.map(([k, o]) => [k, o, "Opened"]), ...openClose.map(([k, , c]) => [k, c, "Closed"])].sort((a, b) => a[0] - b[0]) : null;
    // [label, value, title, chart points, formatter, bars, overlay, period] — the value and period are kept for the
    // tooltip and Ask ChatGPT, but the caption shows the title only (current figures live in Now); trader pnl and
    // staker rewards carry their cumulative total as a line over the bars (overlay, right axis), volume its moving
    // average. A line's value reads on hover.
    const cumPnl = m && m.traderPnl ? pts(m.traderPnl) : null, cumRewards = m && m.stakingRewards ? pts(m.stakingRewards) : null;
    // Moving average of the volume bars, one bucket wide per point: 12 × 5 min = 1 h, 24 h, or 7 days; only once the
    // window is full, so the first points are not averages of fewer bars.
    const maWindow = five ? 12 : daily ? 7 : 24, maLabel = five ? "1h avg" : daily ? "7d avg" : "24h avg";
    const movingAvg = (bars) => { const out = []; for (let i = maWindow - 1; i < bars.length; i++) { let sum = 0; for (let k = i - maWindow + 1; k <= i; k++) sum += bars[k][1]; out.push([bars[i][0], sum / maWindow]); } return out; };
    const volBars = m && flow(m.volumePerInterval), volMa = volBars && volBars.length >= maWindow ? movingAvg(volBars) : null;
    const rows = [
      ["Volume", latest(volBars, usd), `total traded in ${span} (the latest bar); bars = per ${per}; line = ${maLabel.replace(" avg", "")} moving average of the bars`, volBars, usd, true, volMa && { points: volMa, fmt: usd, label: maLabel, shift: 0, sameScale: true }, spanShort],
      // TVL equals the net of deposits and withdrawals (within the $1 withdrawal fees): trader pnl and staker rewards
      // move money inside the exchange. So the bars are the flows (deposits up, withdrawals down) and the line is TVL.
      ["TVL", d.crossCheck && d.crossCheck.apiTvl18 ? usd(Number(BigInt(d.crossCheck.apiTvl18) / 10n ** 12n) / 1e6) : usd(m && last(m.tvl)), `official protocol treasury value (line, right axis) = deposits − withdrawals, since trader pnl and staker rewards stay inside the exchange; bars = USDC deposited (up) and withdrawn (down, including the withdrawal fee) per ${per}, from the exchange events on HyperEVM; headline = tvl now`, flowBars, signedUsd, true, m && { points: pts(m.tvl), fmt: usd, label: "TVL", shift: 0, isHeadline: true }],
      ["Trader PnL", latest(m && flow(m.pnlPerInterval), signedUsd), `change in cumulative trader pnl in ${span}, the latest bar (negative = traders lost); bars = per ${per} (left axis), line = cumulative since the start (right axis)`, m && flow(m.pnlPerInterval), signedUsd, true, cumPnl && { points: cumPnl, fmt: signedUsd, label: "Cumulative", shift: daily ? 0 : m.intervalMs, fit: five }, spanShort],
      ["Staker rewards", latest(m && flow(m.rewardsPerInterval), usd), `USDC paid to stakers in ${span}, the latest bar; bars = per ${per} (left axis), line = cumulative since the start (right axis)`, m && flow(m.rewardsPerInterval), usd, true, cumRewards && { points: cumRewards, fmt: usd, label: "Cumulative", shift: daily ? 0 : m.intervalMs, fit: five }, spanShort],
      ...(oi ? [["Net exposure, % of open interest", (() => { const v = netPctAt(oi.times.length - 1); return v == null ? "–" : `${v > 0 ? "+" : ""}${pct(v, 0)}`; })(), `(long − short) ÷ (long + short), BTC + ETH entry notional; positive = traders net long, so the house is net short. Now: ${signedUsd(netAt(oi.times.length - 1))} of ${usd(oi.total[oi.times.length - 1])} (BTC ${signedUsd(oi.btcLong[oi.times.length - 1] - oi.btcShort[oi.times.length - 1])}, ETH ${signedUsd(oi.ethLong[oi.times.length - 1] - oi.ethShort[oi.times.length - 1])})`, netPts, (v) => `${v > 0 ? "+" : ""}${pct(v, 0)}`],
        ["Open interest", usd(last(oi.total)), `line (right axis) = entry notional of open positions, long + short (official house history); bars = notional opened (up) and closed (down, liquidations included) per ${per}, derived as (volume ± Δopen interest) ÷ 2 since the API has no open/close split; this assumes volume counts both opening and closing fills`, ocBars, signedUsd, true, { points: oiPts, fmt: usd, label: "Open interest", shift: 0, isHeadline: true }]] : []),
    ];
    // Laid out like the Rules charts: the value beside the title (its note after it), then the chart; hover shows the
    // cursor label on every chart at once.
    box.className = "charts charts-2";
    box.innerHTML = rows.map(([label, , title, points], i) => `<figure class="chart act" data-i="${i}">
      <figcaption><span>${esc(label)}${title ? info(title) : ""}</span><b class="cv"></b></figcaption>
      ${points ? `<svg role="img" aria-label="${esc(label)} history"></svg>` : ""}
    </figure>`).join("");
    const base = `${daily ? "daily" : "hourly"} bars since genesis · headline: last complete ${daily ? "24 h" : "hour"} · hover a chart to read every row at that time`;
    $("activityhint").textContent = base;
    const draws = [];
    const hover = (msAt) => { draws.forEach((g) => g(msAt)); $("activityhint").textContent = msAt == null ? base : hourLabel(msAt); };
    // What each axis shows, written above it (the readout boxes carry values only).
    const bucketWord = `Per ${per}`;
    const AXIS_TITLES = {
      Volume: { left: bucketWord, right: `Line: ${maLabel}` },
      TVL: { left: "In ↑ · Out ↓", right: "TVL" },
      "Trader PnL": { left: bucketWord, right: "Cumulative" },
      "Staker rewards": { left: bucketWord, right: "Cumulative" },
      "Open interest": { left: "Opened ↑ · Closed ↓", right: "Open interest" },
    };
    rows.forEach(([label, , , points, fmt, bars, overlay], i) => {
      if (!points) return;
      draws.push(timeChart(box.querySelector(`.chart[data-i="${i}"]`), points, fmt, hover, { bars, timeLabel, keepCaption: true, overlay, axisTitles: AXIS_TITLES[label] }));
    });
    // The charts share one hover, so leaving any one of them resets all; a chart redrawn under the cursor (the data
    // poll) loses its own leave listener, so the grid resets them too when the cursor leaves it.
    box.onmouseleave = () => hover(null);
  }

  // The hover readouts are axis labels, as on a trading chart: each value in a box on its axis at its own height (two
  // values at one time, such as deposits and withdrawals or a bar and its average, get two boxes), the time (or the loss
  // amount on the counted-loss axis) in a box under the x axis, a second series' value on the right axis; a dotted
  // horizontal line joins the point to its value. The boxes stay in the margins, never over the plot; what each axis
  // shows is named by its axis title (axisTitles), not inside the box.
  const TIP = `<g class="tip" visibility="hidden"><line class="crossh"/><g class="axboxes"></g></g>`;
  // geom = { L, R, W, H, T, B }: the plot frame. r = { left: [{ text, y }], x: text, right: [{ text, y }] }.
  function moveTip(svg, geom, px, py, r) {
    const g = svg.querySelector(".tip"); if (!g) return;
    if (r == null) { g.setAttribute("visibility", "hidden"); return; }
    const { L, R, W, H, T, B } = geom, boxH = 13, cw = 5.6;
    // Values on one axis, top to bottom, at least a box apart, inside the plot's height.
    const lane = (items) => {
      const out = items.filter((it) => it && it.text).map((it) => ({ ...it, y: Math.max(T + boxH / 2, Math.min(H - B - boxH / 2, it.y)) })).sort((a, b) => a.y - b.y);
      for (let k = 1; k < out.length; k++) out[k].y = Math.max(out[k].y, out[k - 1].y + boxH + 1);
      const over = out.length ? out[out.length - 1].y - (H - B - boxH / 2) : 0;
      if (over > 0) for (const it of out) it.y -= over;
      return out;
    };
    const box = (text, tx, ty, anchor) => {
      const w = text.length * cw + 8, bx = anchor === "end" ? tx - w + 4 : anchor === "middle" ? tx - w / 2 : tx - 4;
      return `<rect class="axbox" rx="2" x="${bx.toFixed(1)}" y="${(ty - 6.5).toFixed(1)}" width="${w.toFixed(1)}" height="${boxH}"/><text class="axlabel" x="${tx.toFixed(1)}" y="${(ty + 3.5).toFixed(1)}" text-anchor="${anchor}">${esc(text)}</text>`;
    };
    const w = r.x.length * cw + 8, cx = Math.max(L + w / 2, Math.min(W - R - w / 2, px));
    g.querySelector(".axboxes").innerHTML = lane(r.left).map((it) => box(it.text, L - 6, it.y, "end")).join("")
      + lane(r.right || []).map((it) => box(it.text, W - R + 6, it.y, "start")).join("")
      + box(r.x, cx, H - 8, "middle");
    const h = g.querySelector("line.crossh"); h.setAttribute("x1", L); h.setAttribute("x2", W - R); h.setAttribute("y1", py.toFixed(1)); h.setAttribute("y2", py.toFixed(1));
    g.setAttribute("visibility", "visible");
  }

  // A time-scaled chart: line (levels) or bars (per-hour flows), optional shaded bands, shared hover by time.
  function timeChart(fig, points, fmt, onHover, opts = {}) {
    const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv");
    const past = points.filter(([, v]) => v != null && Number.isFinite(v));
    if (past.length < 2) { if (!opts.keepCaption) cv.textContent = past.length ? fmt(past[0][1]) : "–"; svg.innerHTML = ""; return () => {}; }
    // opts.future: projected points after the last observed one, drawn dashed and labelled as projected on hover.
    const future = (opts.future || []).filter(([, v]) => v != null && Number.isFinite(v));
    const fband = (opts.futureBand || []).filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b));
    const pts = [...past, ...future], nowMs = past[past.length - 1][0];
    const t0 = points[0][0], t1 = future.length ? future[future.length - 1][0] : points[points.length - 1][0];
    let lo = Math.min(0, ...pts.map(([, v]) => v)), hi = Math.max(0, ...pts.map(([, v]) => v));
    for (const [, a, b] of fband) { lo = Math.min(lo, a, b); hi = Math.max(hi, a, b); }
    // opts.series2 = { points, future, band, label }: a second line on the same value scale (e.g. two cost bounds), drawn
    // in the warm color with its own dashed projection and band; included in the range and in the hover readout.
    const fin = (arr) => (arr || []).filter(([, v]) => v != null && Number.isFinite(v));
    const s2 = opts.series2 || null, s2past = s2 ? fin(s2.points) : [], s2fut = s2 ? fin(s2.future) : [];
    const s2band = s2 ? (s2.band || []).filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b)) : [];
    for (const [, v] of [...s2past, ...s2fut]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const [, a, b] of s2band) { lo = Math.min(lo, a, b); hi = Math.max(hi, a, b); }
    for (const h of opts.hlines || []) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
    if (lo === hi) hi = lo + 1;
    const pad = (hi - lo) * 0.08; lo -= lo < 0 ? pad : 0; hi += pad;
    // Three ticks: top, middle, bottom; a series that crosses zero gets 0 as its middle tick, so the sign reads at a glance.
    // When zero sits within 15% of an edge, that edge's tick would crowd it, so the ticks become 0, the far edge and their
    // midpoint.
    const top = hi - pad, bottom = lo + pad, near = 0.15 * (top - bottom);
    let ticks = opts.compact ? []
      : lo < 0 && top > 0 ? (top < near ? [0, bottom / 2, bottom] : -bottom < near ? [top, top / 2, 0] : [top, 0, bottom])
      : [top, (lo + top) / 2, lo < 0 ? bottom : 0];
    // opts.log: a log10 y axis over whole powers of ten (for series spanning several orders, e.g. the APR); ticks at
    // powers of ten, at most 5. Non-positive values sit on the bottom edge.
    let tr = (v) => v, sLo = lo, sHi = hi;
    if (opts.log) {
      const vals = [...pts.map(([, v]) => v), ...fband.flatMap(([, a, b]) => [a, b]), ...s2past.map(([, v]) => v), ...s2fut.map(([, v]) => v), ...s2band.flatMap(([, a, b]) => [a, b])].filter((v) => v > 0);
      const e0 = Math.floor(Math.log10(Math.min(...vals))), e1 = Math.max(e0 + 1, Math.ceil(Math.log10(Math.max(...vals))));
      tr = (v) => Math.log10(Math.max(v, 10 ** e0)); sLo = e0; sHi = e1;
      const step = Math.ceil((e1 - e0) / 4);
      ticks = [];
      for (let e = e1; e >= e0; e -= step) ticks.push(10 ** e);
    }
    // Full charts take the figure's width and the curve charts' height, so every chart on the page lines up.
    const W = opts.compact ? Math.max(120, fig.querySelector("svg").clientWidth || fig.clientWidth) : Math.max(220, fig.clientWidth);
    // opts.overlay = { points, fmt }: a second series (e.g. the cumulative total behind per-hour bars) drawn as a line on
    // its own scale, with its ticks on the right edge.
    // overlay.shift: how far after a bar's start its matching overlay reading is taken (an hourly bar goes with the
    // cumulative reading at the end of that hour); the reading is drawn at the bar's position.
    const ovShift = (opts.overlay && opts.overlay.shift) || 0;
    const ov = opts.overlay && !opts.compact ? opts.overlay.points.map(([ms, v]) => [ms - ovShift, v]).filter(([ms, v]) => ms >= t0 && ms <= t1 && v != null && Number.isFinite(v)) : [];
    // overlay.fit: scale the right axis to the line's own range instead of anchoring it at zero, so a cumulative total
    // that moves little over a short window (e.g. 24 h at 5 min) is not flattened into a straight line.
    const oFit = !!(opts.overlay && opts.overlay.fit);
    let oLo = Math.min(oFit ? Infinity : 0, ...ov.map(([, v]) => v)), oHi = Math.max(oFit ? -Infinity : 0, ...ov.map(([, v]) => v));
    if (oLo === oHi) oHi = oLo + 1;
    const oPad = (oHi - oLo) * 0.08; oLo -= oFit || oLo < 0 ? oPad : 0; oHi += oPad;
    // overlay.sameScale: the line is in the bars' units (a moving average), so it uses the left axis and adds no ticks.
    const oSame = !!(opts.overlay && opts.overlay.sameScale);
    const oTicks = ov.length && !oSame ? (oFit ? [oHi - oPad, (oLo + oHi) / 2, oLo + oPad] : [oHi - oPad, (oLo + oHi - oPad) / 2, oLo < 0 ? oLo + oPad : 0]) : [];
    const H = opts.compact ? 40 : FRAME.H, T = opts.compact ? 3 : FRAME.T, B = opts.compact ? 3 : FRAME.B;
    // The shared frame, widened only if a label would not fit (it never should with the compact formats below).
    const L = opts.compact ? 1 : Math.max(FRAME.L, Math.ceil(Math.max(...ticks.map((v) => fmt(v).length)) * 5.6) + 10);
    const R = opts.compact ? 1 : Math.max(FRAME.R, oTicks.length ? Math.ceil(Math.max(...oTicks.map((v) => opts.overlay.fmt(v).length)) * 5.6) + 10 : 0);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const x = (ms) => L + ((ms - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (v) => T + (1 - (tr(v) - sLo) / (sHi - sLo)) * (H - T - B);
    let marks = "";
    if (opts.bars) {
      // Bar width: from the count of buckets, but never wider than the smallest gap between neighbours (the launch-day
      // bucket is only two hours before the next midnight), and every bar kept inside the plot frame.
      const times = [...new Set(pts.map(([ms]) => ms))].sort((a, b) => a - b);
      let gap = Infinity; for (let i = 1; i < times.length; i++) gap = Math.min(gap, x(times[i]) - x(times[i - 1]));
      // Paired bars (deposits up / withdrawals down, opened / closed) share one time slot, so the width comes from the
      // count of distinct times; every bar chart then has the same width per bucket.
      const bw = Math.max(1, Math.min(((W - L - R) / Math.max(1, times.length)) * (opts.compact ? 0.8 : 0.7), Number.isFinite(gap) ? gap * 0.7 : Infinity, opts.compact ? Infinity : MAX_BAR));
      const bx = (ms) => Math.max(L, Math.min(W - R - bw, x(ms) - bw / 2));
      marks = pts.map(([ms, v]) => `<rect class="${v < 0 ? "barneg" : "bar"}" x="${bx(ms).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(y(v) - y(0))).toFixed(1)}"/>`).join("");
    } else {
      let path = "", pen = false;
      for (const [ms, v] of points) { if (v == null || !Number.isFinite(v)) { pen = false; continue; } path += `${pen ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
      marks = `<path class="line" d="${path}"/>`;
      if (s2past.length) marks += `<path class="line s2" d="${s2past.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("")}"/>`;
      if (future.length) {
        // The model is its own line, not joined to the last observed point: it starts at the model's value "now" (the
        // projections include h = 0), which equals the observed value unless the model differs from it (e.g. inflation).
        const proj = future.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("");
        if (fband.length) {
          const top = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`), bot = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`).reverse();
          marks += `<polygon class="projband" points="${top.join(" ")} ${bot.join(" ")}"/>`;
        }
        marks += `<path class="line proj" d="${proj}"/><line class="vmark" x1="${x(nowMs).toFixed(1)}" x2="${x(nowMs).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
        if (s2fut.length) {
          if (s2band.length) {
            const t2 = s2band.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`), b2 = s2band.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`).reverse();
            marks += `<polygon class="projband s2" points="${t2.join(" ")} ${b2.join(" ")}"/>`;
          }
          marks += `<path class="line proj s2" d="${s2fut.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("")}"/>`;
        }
      }
    }
    const bands = (opts.bands || []).filter(([a, b]) => b >= t0 && a <= t1).map(([a, b, dp]) => {
      const x0 = x(Math.max(a, t0)), x1 = Math.max(x0 + 3, x(Math.min(b, t1)));
      return `<rect class="dipband" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${H - T - B}"><title>${esc(`cliff dip ${hourLabel(a)} → ${dp.toAt ? hourLabel(b) : "now"}`)}</title></rect>`;
    }).join("");
    const hlines = (opts.hlines || []).filter((h) => h.y >= lo && h.y <= hi).map((h) => `<line class="vmark ${h.kind || ""}" x1="${L}" x2="${W - R}" y1="${y(h.y).toFixed(1)}" y2="${y(h.y).toFixed(1)}"/><text class="mlabel" x="${h.align === "left" ? L + 4 : W - R - 4}" y="${(y(h.y) - 3).toFixed(1)}" text-anchor="${h.align === "left" ? "start" : "end"}">${esc(h.label)}</text>`).join("");
    svg.innerHTML = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(fmt(v))}</text>`).join("")
      + hlines
      // X labels: the two ends, or, with few buckets (the daily view's first days), one under each bucket so every bar
      // is dated; the ends are then anchored inward to stay inside the frame.
      + (opts.compact ? (lo < 0 ? `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` : "") : (() => {
        const tl = opts.timeLabel || hourLabel, times = [...new Set(pts.map(([ms]) => ms))].sort((a, b) => a - b);
        if (opts.bars && times.length <= 10) return times.map((ms, i) => `<text class="tick" x="${x(ms).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? "start" : i === times.length - 1 ? "end" : "middle"}">${esc(tl(ms))}</text>`).join("");
        // The ends: dates only once the span reaches three days (an hour of "Oct 20, 00:36" says nothing there).
        const end = t1 - t0 >= 3 * 86_400_000 ? (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(t1 - t0 > 60 * 86_400_000 ? { year: "numeric" } : {}) }) : tl;
        return `<text class="tick" x="${L}" y="${H - 5}">${esc(end(t0))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(end(t1))}</text>`;
      })())
      // Axis titles in the top band: left over the value axis, right over the second axis.
      + (opts.axisTitles && !opts.compact ? `${opts.axisTitles.left ? `<text class="axtitle" x="4" y="10">${esc(opts.axisTitles.left)}</text>` : ""}${opts.axisTitles.right ? `<text class="axtitle" x="${W - 4}" y="10" text-anchor="end">${esc(opts.axisTitles.right)}</text>` : ""}` : "")
      + bands + marks
      + (ov.length ? (() => {
        const oy = oSame ? y : (v) => T + (1 - (v - oLo) / (oHi - oLo)) * (H - T - B);
        return oTicks.map((v) => `<text class="tick otick" x="${W - R + 6}" y="${oy(v) + 3}">${esc(opts.overlay.fmt(v))}</text>`).join("")
          + `<path class="line" d="${ov.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${oy(v).toFixed(1)}`).join("")}"/>`;
      })() : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${opts.compact ? "" : TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const nearest = (ms) => pts.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best), pts[0]);
    const show = (ms) => {
      // Without a cursor the crosshair rests on the current point: the last observed one (the last bar on bar charts),
      // not the end of a projection.
      const p = ms == null ? past[past.length - 1] : nearest(ms);
      // Compact sparklines keep the caption readout (the Activity rows share one hover); full charts use the cursor label.
      if (opts.compact) cv.textContent = ms == null ? "" : fmt(p[1]);
      else if (!opts.keepCaption) cv.innerHTML = "";
      if (opts.compact && ms == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); moveTip(svg, null, 0, 0, null); return; }
      cross.setAttribute("x1", x(p[0])); cross.setAttribute("x2", x(p[0])); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(p[0])); dot.setAttribute("cy", y(p[1])); dot.setAttribute("visibility", opts.bars ? "hidden" : "visible");
      const o = ov.length ? ov.reduce((b, q) => (Math.abs(q[0] - p[0]) < Math.abs(b[0] - p[0]) ? q : b), ov[0]) : null;
      // Two bars at one time (deposits up, withdrawals down) read as two boxes at their own heights.
      const twin = pts.filter((q) => q[0] === p[0] && q[2]), vals = twin.length > 1 ? twin : [p];
      if (!opts.compact) {
        const oy = o && !oSame ? T + (1 - (o[1] - oLo) / (oHi - oLo)) * (H - T - B) : null;
        // A same-scale overlay (moving average) reads on the left axis next to the bar; a second-axis one on the right.
        moveTip(svg, { L, R, W, H, T, B }, x(p[0]), y(p[1]), {
          left: [...vals.map((q) => ({ text: fmt(q[1]), y: y(q[1]) })), ...((s2past.length || s2fut.length) ? (() => { const all = [...s2past, ...s2fut], q = all.reduce((b, r) => (Math.abs(r[0] - p[0]) < Math.abs(b[0] - p[0]) ? r : b), all[0]); return [{ text: fmt(q[1]), y: y(q[1]) }]; })() : []), ...(o && oSame ? [{ text: opts.overlay.fmt(o[1]), y: y(o[1]) }] : [])],
          x: `${(opts.timeLabel || hourLabel)(p[0])}${p[0] > nowMs ? " · projected" : ""}`,
          right: o && !oSame ? [{ text: opts.overlay.fmt(o[1]), y: oy }] : [],
        });
      }
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; onHover(t0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (t1 - t0)); });
    hit.addEventListener("mouseleave", () => onHover(null));
    show(null);
    return show;
  }

  // Projection of a cumulative series at its recent pace, hourly for `days` after its last point: the median hourly
  // increase over the last 24 h as the central line, its 25th–75th percentile as the band (the same model as the counted
  // losses; the readings may be unevenly spaced, so each hour's increase is read between the nearest readings).
  function linearProjection(pts, days = 7) {
    const p = pts.filter(([, v]) => v != null && Number.isFinite(v));
    if (p.length < 2) return { future: [], futureBand: [] };
    const last = p[p.length - 1], H = 3_600_000;
    const at = (t) => p.reduce((b, q) => (Math.abs(q[0] - t) < Math.abs(b[0] - t) ? q : b), p[0]);
    const hourly = [];
    for (let h = 24; h >= 1; h--) { const a = at(last[0] - h * H), b = at(last[0] - (h - 1) * H); if (b[0] > a[0] && b[0] - a[0] <= 1.5 * H) hourly.push((b[1] - a[1]) / ((b[0] - a[0]) / H)); }
    if (hourly.length < 6) return { future: [], futureBand: [] };
    const sorted = [...hourly].sort((x, y) => x - y), q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const mid = q(0.5), lo = q(0.25), hi = q(0.75), future = [], futureBand = [];
    for (let h = 0; h <= days * 24; h++) { const t = last[0] + h * H; future.push([t, last[1] + mid * h]); futureBand.push([t, last[1] + lo * h, last[1] + hi * h]); }
    return { future, futureBand, pace: { mid, low: lo, high: hi } };
  }

  // --------------------------------------------------------------------------------------------- Rules
  const curveRate = (lp, c) => {
    if (lp < c.threshold) return c.flatRate;
    if (c.decayScale <= 0) return 0;
    const r = c.decayScale / (c.decayScale + c.tailProgress + Math.max(0, lp - Math.max(c.trackedLp, c.threshold)));
    return c.flatRate * r * r;
  };

  function curveChart(fig, o) {
    const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv");
    const W = Math.max(220, fig.clientWidth), { H, T, R } = FRAME, B = FRAME.B + 2;
    const L = Math.max(FRAME.L, Math.ceil(Math.max(...o.ticksY.map((t) => o.fmtY(t).length)) * 5.6) + 10);
    const x = (v) => L + ((v - o.x0) / (o.x1 - o.x0)) * (W - L - R), y = (v) => T + (1 - (v - o.y0) / (o.y1 - o.y0)) * (H - T - B);
    let d = "";
    for (let i = 0; i <= 360; i++) {
      const v = o.x0 + ((o.x1 - o.x0) * i) / 360, w = o.f(v);
      d += o.step && i ? `H${x(v).toFixed(1)}V${y(w).toFixed(1)}` : `${i ? "L" : "M"}${x(v).toFixed(1)},${y(w).toFixed(1)}`;
    }
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const marks = (o.markers || []).filter((m) => m.x >= o.x0 && m.x <= o.x1);
    // o.band(v) -> [a, b]: the same curve under the slowest and fastest assumption, shaded between.
    let bandPoly = "";
    if (o.band) {
      const top = [], bot = [];
      for (let i = 0; i <= 120; i++) { const v = o.x0 + ((o.x1 - o.x0) * i) / 120, [a, b] = o.band(v); top.push(`${x(v).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`); bot.push(`${x(v).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`); }
      bandPoly = `<polygon class="projband" points="${top.join(" ")} ${bot.reverse().join(" ")}"/>`;
    }
    svg.innerHTML = o.ticksY.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(o.fmtY(t))}</text>`).join("")
      + `<text class="tick" x="${L}" y="${H - 6}">${esc(o.fmtX(o.x0))}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(o.fmtX(o.x1))} ${esc(o.xLabel)}</text>`
      // Inner x ticks: a short tick and a label just under the baseline, kept clear of the end labels.
      + (o.xTicks || []).filter((t) => t.x > o.x0 && t.x < o.x1).map((t) => { const tx = x(t.x); return tx < L + 14 || tx > W - R - 96 ? "" : `<line class="grid" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${H - B}" y2="${H - B + 4}"/><text class="tick" x="${tx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(t.label)}</text>`; }).join("")
      + marks.map((m, i) => { const lx = x(m.x), right = lx > W - R - 150; return `<line class="vmark ${m.kind || ""}" x1="${lx}" x2="${lx}" y1="${T}" y2="${H - B}"/><text class="mlabel" x="${right ? lx - 4 : lx + 4}" y="${T + 9 + i * 11}" text-anchor="${right ? "end" : "start"}">${esc(m.label)}</text>`; }).join("")
      + (o.asymptote != null ? `<line class="asym" x1="${L}" x2="${W - R}" y1="${y(o.asymptote)}" y2="${y(o.asymptote)}"/>` : "")
      + (o.asymptote != null && o.asymptoteLabel ? `<text class="mlabel" x="${W - R - 4}" y="${(y(o.asymptote) - 4).toFixed(1)}" text-anchor="end">${esc(o.asymptoteLabel)}</text>` : "")
      + bandPoly + `<path class="line" d="${d}"/>`
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const show = (cursor) => {
      cv.innerHTML = "";
      // Without a cursor the crosshair rests on the current position (o.now: today's counted losses on that axis).
      const v = cursor == null ? o.now : cursor;
      if (v == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); moveTip(svg, null, 0, 0, null); return; }
      moveTip(svg, { L, R, W, H, T, B }, x(v), y(o.f(v)), { left: [{ text: o.fmtY(o.f(v)), y: y(o.f(v)) }], x: (o.fmtReadX || o.fmtX)(v), right: [] });
      cross.setAttribute("x1", x(v)); cross.setAttribute("x2", x(v)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(v)); dot.setAttribute("cy", y(o.f(v))); dot.setAttribute("visibility", "visible");
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; show(o.x0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (o.x1 - o.x0)); });
    hit.addEventListener("mouseleave", () => show(null));
    show(null);
  }

  function renderRules(d) {
    const c = d.curve, box = $("rules-curves");
    if (!c || !(c.flatRate > 0) || !(c.decayScale > 0)) { box.innerHTML = `<p class="empty">rule inputs unavailable</p>`; return; }
    const head = box.closest("section").querySelector(".panel-head");
    if (head && !head.querySelector("#tailaxis")) head.insertAdjacentHTML("beforeend", `<div class="seg" id="tailaxis" role="group" aria-label="Tail curve axis"><button type="button" data-axis="time" title="x = date reached at the current tail speed">Estimated date</button><button type="button" data-axis="loss" title="x = cumulative losses counted by the mint curve (tail progress)">Counted loss</button></div>`);
    const byTime = tailAxis === "time" && !!(d.mint && d.mint.tailSpeedUsdPerHour > 0);
    for (const b of document.querySelectorAll("#tailaxis button")) b.classList.toggle("on", b.dataset.axis === (byTime ? "time" : "loss"));
    if (head && !head.querySelector("#horizon")) head.insertAdjacentHTML("beforeend", `<div class="seg" id="horizon" role="group" aria-label="Projection horizon">${HORIZONS.map(([days, l]) => `<button type="button" data-days="${days}" title="projections run ${days} days ahead">${l}</button>`).join("")}</div>`);
    for (const b of document.querySelectorAll("#horizon button")) b.classList.toggle("on", Number(b.dataset.days) === horizon);
    // Order: observed-only charts first, then the projections, the cost bounds last.
    const figs = [
      ["pool", "LP balance"],
      ["apr", "APR · 24h"],
      ["tailloss", "Counted losses over time"],
      ["minttail", byTime ? "Mint rate over time" : "Mint rate by counted loss"],
      ["supply", byTime ? "PAPER supply over time" : "PAPER supply by counted loss"],
      ["devfee", "Dev fees accrued, cumulative"],
      ["mintcost", "Cost to mint: no hedge and floor"],
    ];
    box.innerHTML = figs.map(([k, t]) => `<figure class="chart" data-curve="${k}"><figcaption><span>${esc(t)}</span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(t)}"></svg></figure>`).join("");
    const fig = (k) => box.querySelector(`[data-curve="${k}"]`);
    // The pool's own history (every summary sample), with the two thresholds the curves below key on.
    {
      const ms = d.mint && d.mint.series, pts = ms && ms.trackedLpUsd ? ms.trackedLpUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]) : [];
      const dips = (d.mint && d.mint.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
      let showPool = null;
      setInfo(fig("pool"), `dotted lines: mint-decay threshold ${usd(c.threshold)} (flat 100/$ below it) and staker threshold ${usd(c.stakerCap)} (stakers take 99% at or above it)`);
      // No projection: the pool moves with the traders' net pnl, which cannot be estimated.
      showPool = timeChart(fig("pool"), pts, usd, (ms) => showPool && showPool(ms), { bands: dips, quiet: true, hlines: [{ x: 0, y: c.threshold, label: usd(c.threshold), kind: "warn", align: "left" }, { y: c.stakerCap, label: usd(c.stakerCap), kind: "pos", align: "left" }] });
    }
    const rateTicks = [c.flatRate, c.flatRate / 2, c.flatRate / 4, 0];
    // Net cost of one PAPER for a hedged pair closed at ±target, over time: (1 − win ratio) ÷ (0.98 × mint rate) on every
    // mint-rate sample. The win ratio depends only on the ±target, so it is the same at every point; cliff dips shaded.
    {
      // Two bounds on what one PAPER costs at a given mint rate r: no hedge = 1 ÷ (0.98·r) (a lone position, the whole
      // loss buys PAPER at 98%); floor = 1 ÷ (8.31·r) (a hedged pair with an exit so wide the win leg recovers its cap,
      // 90% impact × (1 − 2% win fee) = 88.2%: PAPER per $ of net loss ≤ 0.98 ÷ 0.118 · r). Both are ∝ 1/r, ratio 8.48.
      const m = d.mint, ms = m && m.series;
      const FLOOR_K = 0.98 / (1 - 0.9 * 0.98);
      const cost = (r) => (r > 0 ? 1 / (FLOOR_K * r) : null), costNoHedge = (r) => (r > 0 ? 1 / (0.98 * r) : null);
      const sampled = ms && ms.ratePerUsd ? ms.ratePerUsd.map((r, i) => [ms.startMs + i * ms.intervalMs, cost(r)]) : [];
      // Before the samples begin, rebuild the rate from the hourly PAPER supply: past the flat phase the tail has minted
      // flat·D·T/(D+T), so T = E·D/(flat·D − E) with E = supply − flat-phase emission, and rate = flat·(D/(D+T))².
      // The hourly history stamps each value at the start of its hour; the value is the hour's end, hence +1 interval.
      // Checked against the samples where both exist: within ~0.5% (liquidations mint up to 2% more, ignored).
      const mk = d.protocol && d.protocol.market, flat = m && m.flatEmissionPaper;
      const rebuilt = [];
      if (mk && mk.paperSupply && flat != null) {
        const sampledFrom = sampled.length ? sampled[0][0] : Infinity, R = c.flatRate, D = c.decayScale;
        // From HISTORY_START (PAPER's launch: supply 0, flat rate, nothing counted yet).
        for (let i = 0; mk && mk.paperSupply && i < mk.paperSupply.length; i++) {
          const at = mk.startMs + (i + 1) * mk.intervalMs;
          if (at < HISTORY_START) continue;
          if (at >= sampledFrom) break;
          const E = (mk.paperSupply[i] || 0) - flat, T = E > 0 ? (E * D) / (R * D - E) : 0;
          rebuilt.push([at, cost(E > 0 ? R * (D / (D + T)) ** 2 : R)]);
        }
      }
      const pts = [...rebuilt, ...sampled];
      const NH = FLOOR_K / 0.98, upper = (arr) => arr.map((q) => (q[1] == null ? [q[0], null] : q.length > 2 ? [q[0], q[1] * NH, q[2] * NH] : [q[0], q[1] * NH]));
      // Projection: realized losses keep growing at the recent tail speed (mint.tailSpeedUsdPerHour), so
      // T(t) = T_now + speed·Δt and the rate follows flat·(D/(D+T))² — the horizon ahead (7 days to a year, the Rules switch), hourly. No future cliff dips assumed.
      const future = [], band = [];
      if (m && m.tailSpeedUsdPerHour > 0 && pts.length) {
        const R = c.flatRate, D = c.decayScale, t0 = m.atMs, T0 = m.tailProgressUsd, at = (pace, h) => cost(R * (D / (D + T0 + pace * h)) ** 2);
        for (let h = 0; h <= horizon * 24; h += stepHours()) {
          future.push([t0 + h * 3_600_000, at(m.tailSpeedUsdPerHour, h)]);
          if (m.pace) band.push([t0 + h * 3_600_000, at(m.pace.low, h), at(m.pace.high, h)]);
        }
      }
      // Short caption; the assumptions go to the tooltip.
      const notes = [];
      if (rebuilt.length) notes.push(`before ${hourLabel(rebuilt[rebuilt.length - 1][0] + mk.intervalMs)}: rebuilt from the hourly PAPER supply`);
      const dips = (m && m.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
      let showCost = null;
      showCost = timeChart(fig("mintcost"), pts, (v) => unit(v), (t) => showCost && showCost(t), { bands: dips, quiet: true, log: true, timeLabel: horizonLabel(), future, futureBand: band,
        series2: { points: upper(pts), future: upper(future), band: band.map(([t, a, b]) => [t, a * NH, b * NH]) } });
      if (future.length) notes.push(`next ${horizon} days, if volume and the loss rate stay as they are: dashed line at the median hourly pace of losses over the last 24 h (${usd(m.tailSpeedUsdPerHour)}/h)${m.pace ? `, band = the 25th–75th percentile of those hours (${usd(m.pace.low)}–${usd(m.pace.high)}/h)` : ""}`);
      notes.unshift("upper line (warm) = no hedge, 1 ÷ (0.98 × mint rate); lower line = the floor for a hedged pair, 1 ÷ (8.31 × mint rate): the widest exit, where the win leg recovers at most 90% × 98% = 88.2% of the loss; any hedged miner pays between the two, and the ratio is 8.48 at every rate");
      setInfo(fig("mintcost"), notes.join(" · "));
    }
    // Realized losses over time: observed tail progress (summary samples; before them rebuilt from the hourly PAPER
    // supply as above) and the model every projection on this page uses — linear at the median hourly pace, with the band
    // between the slowest and fastest of the recent 3 h, 6 h and 24 h paces.
    {
      const m = d.mint, ms = m && m.series, mk = d.protocol && d.protocol.market, flat = m && m.flatEmissionPaper;
      const sampled = ms && ms.tailProgressUsd ? ms.tailProgressUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]).filter(([, v]) => v != null) : [];
      const rebuilt = [];
      if (mk && mk.paperSupply && flat != null) {
        const from = sampled.length ? sampled[0][0] : Infinity, R = c.flatRate, D = c.decayScale;
        // From HISTORY_START (PAPER's launch: supply 0, flat rate, nothing counted yet).
        for (let i = 0; mk && mk.paperSupply && i < mk.paperSupply.length; i++) {
          const at = mk.startMs + (i + 1) * mk.intervalMs;
          if (at < HISTORY_START) continue;
          if (at >= from) break;
          const E = (mk.paperSupply[i] || 0) - flat;
          rebuilt.push([at, E > 0 ? (E * D) / (R * D - E) : 0]);
        }
      }
      const pts = [...rebuilt, ...sampled], future = [], band = [];
      if (m && m.tailSpeedUsdPerHour > 0 && pts.length) {
        const t0 = m.atMs, T0 = m.tailProgressUsd;
        for (let h = 0; h <= horizon * 24; h += stepHours()) {
          future.push([t0 + h * 3_600_000, T0 + m.tailSpeedUsdPerHour * h]);
          if (m.pace) band.push([t0 + h * 3_600_000, T0 + m.pace.low * h, T0 + m.pace.high * h]);
        }
      }
      let showLoss = null;
      showLoss = timeChart(fig("tailloss"), pts, usd, (t) => showLoss && showLoss(t), { quiet: true, timeLabel: horizonLabel(), future, futureBand: band,
        hlines: [{ y: c.decayScale * (Math.SQRT2 - 1), label: "½ rate" }, { y: c.decayScale, label: "¼ rate" }] });
      setInfo(fig("tailloss"), `tail progress: the losses the mint curve has counted, each losing close at its mint basis, not netted against wins and not counted while the pool is under the cliff; not the traders' net pnl. Before the samples: rebuilt from supply.${m && m.pace ? ` Projection if volume and the loss rate stay as they are: dashed at the median hourly pace over the last 24 h (${usd(m.pace.mid)}/h), band = the 25th–75th percentile of those hours (${usd(m.pace.low)}–${usd(m.pace.high)}/h); no future cliff dips assumed.` : ""}`);
    }
    // Staking APR at every complete hour: the 24 h ending there, rewards per staked PAPER annualized (the indexer's
    // series.apr × series.avgCost gives that back) ÷ the no-hedge cost to mint at that hour, 1 ÷ (0.98 × rate), with the
    // rate rebuilt from the hourly PAPER supply as on the cost chart. In the first 24 h after PAPER began the window is
    // shorter, so values are extreme.
    {
      const s = d.protocol && d.protocol.series, asOf = d.protocol && d.protocol.asOfMs, mk = d.protocol && d.protocol.market;
      const flat = d.mint && d.mint.flatEmissionPaper, rateAtEnd = new Map(); // d.mint: renderRules declares its own m further down
      if (mk && mk.paperSupply && flat != null) mk.paperSupply.forEach((v, i) => { const E = v - flat, T = E > 0 ? (E * c.decayScale) / (c.flatRate * c.decayScale - E) : 0; rateAtEnd.set(mk.startMs + (i + 1) * mk.intervalMs, c.flatRate * (c.decayScale / (c.decayScale + T)) ** 2); });
      const pts = [];
      if (s && s.apr && s.avgCost) s.apr.forEach((v, i) => {
        const end = s.startMs + (i + 1) * s.intervalMs, r = rateAtEnd.get(end), ac = s.avgCost[i];
        if (!(end >= HISTORY_START) || v == null || !Number.isFinite(v) || !(ac > 0) || !(r > 0) || (asOf && end > asOf)) return;
        pts.push([end, (v * ac) / (1 / (0.98 * r))]);
      });
      // No projection: rewards come mostly in lumps when the pool is at the staker cap and traders lose, which depends on
      // the traders' pnl and cannot be estimated.
      let showApr = null;
      showApr = timeChart(fig("apr"), pts, bigPct, (t) => showApr && showApr(t), { quiet: true, log: true });
      setInfo(fig("apr"), "USDC paid to stakers over the trailing 24 h per staked PAPER, annualized, ÷ the cost to mint one PAPER with no hedge at that hour (1 ÷ (0.98 × mint rate), rate rebuilt from the hourly supply); from the hourly protocol history, from the first hour with PAPER (the window is shorter than 24 h in the first day). No projection: rewards come in lumps when the pool is at the staker cap and traders lose, which cannot be estimated. Log axis");
    }
    const D = c.decayScale, tailEnd = D * (Math.sqrt(c.flatRate) - 1), tailRate = (p) => c.flatRate * (D / (D + p)) ** 2;
    const m = d.mint;
    // The counted-loss axis is in dollars only (dates belong to the estimated-date axis): ticks at a round step, about 5.
    const lossTicks = (x1) => {
      const step = [5e7, 1e8, 2e8, 2.5e8, 5e8, 1e9].find((v) => x1 / v <= 6) || 1e9, out = [];
      for (let v = step; v < x1; v += step) out.push({ x: v, label: usd(v) });
      return out;
    };
    const nextHalf = Math.SQRT2 * (D + c.tailProgress) - D;
    const tailMarks = [{ x: D * (Math.SQRT2 - 1), label: "½" }, { x: D, label: "¼" }];
    if (nextHalf > D * (Math.SQRT2 - 1) * 1.05) tailMarks.push({ x: nextHalf, label: "Next ½" });
    // Time axis for the two projections: tailProgress grows at the current tail speed; 30 days ahead or until the tail
    // would be exhausted, whichever is sooner. Day ticks at local midnight. Without a speed, fall back to the loss axis.
    // Time axis for the two projections: tailProgress grows at the median pace (pAt) or the 25th / 75th percentile pace
    // (pLow / pHigh, the band); the horizon ahead, so every projected chart shares one axis. Without a pace, the loss axis is used.
    let axis = null;
    if (byTime) {
      const lam = m.tailSpeedUsdPerHour, t0 = m.atMs, t1 = t0 + horizon * 24 * 3_600_000;
      const lo = m.pace ? m.pace.low : lam, hi = m.pace ? m.pace.high : lam;
      const at = (pace) => (ms) => c.tailProgress + ((ms - t0) / 3_600_000) * pace;
      axis = { t0, t1, pAt: at(lam), pLow: at(lo), pHigh: at(hi) };
    }
    // Time axis: the past and the projection on one line, like the cost chart above. Before the samples the tail progress
    // is rebuilt from the hourly PAPER supply (T = E·D/(flat·D − E)); the projection runs hourly at the central pace with
    // the quartile band, to axis.t1 (the horizon, like the cost and realized-loss charts, so the four time charts share one axis).
    const tailRebuilt = (beforeMs) => {
      const mk = d.protocol && d.protocol.market, flat = m && m.flatEmissionPaper, out = [];
      if (!mk || !mk.paperSupply || flat == null) return out;
      // From HISTORY_START (PAPER's launch: supply 0, flat rate, nothing counted yet).
      for (let i = 0; mk && mk.paperSupply && i < mk.paperSupply.length; i++) {
        const at = mk.startMs + (i + 1) * mk.intervalMs;
        if (at < HISTORY_START) continue;
        if (at >= beforeMs) break;
        const E = (mk.paperSupply[i] || 0) - flat;
        out.push([at, E > 0 ? (E * D) / (c.flatRate * D - E) : 0]);
      }
      return out;
    };
    const projection = (f) => {
      const future = [], band = [];
      for (let t = axis.t0; t <= axis.t1; t += stepHours() * 3_600_000) {
        future.push([t, f(axis.pAt(t))]);
        if (m.pace) band.push([t, f(axis.pLow(t)), f(axis.pHigh(t))]);
      }
      return { future, futureBand: band };
    };
    const dipBands = (m && m.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
    // The two curves the protocol's parameters define (the other Rules charts carry their own notes).
    const paceNote = m && m.pace ? ` Projection: the counted losses at the median hourly pace of the last 24 h (${usd(m.pace.mid)}/h), band = its 25th–75th percentile (${usd(m.pace.low)}–${usd(m.pace.high)}/h); no future cliff dips assumed.` : "";
    setInfo(fig("minttail"), `PAPER minted per $1 of counted loss: ${c.flatRate} × (D ÷ (D + counted losses))², D = ${usd(c.decayScale)}; ${c.flatRate}/$ while the pool is under the cliff.${byTime ? paceNote : " X axis: the counted losses themselves."}`);
    setInfo(fig("supply"), `PAPER supply: current supply plus what the curve mints as the counted losses grow; it approaches the max supply (${(maxSupply(c) / 1e9).toFixed(2)}B) if the pool never dips below the cliff again.${byTime ? paceNote : " X axis: the counted losses themselves."}`);
    if (axis) {
      // The sampled rate already includes the cliff dips (flat rate while the pool is under the cliff).
      const ms = m.series, sampled = ms && ms.ratePerUsd ? ms.ratePerUsd.map((r, i) => [ms.startMs + i * ms.intervalMs, r]).filter(([, r]) => r != null) : [];
      const past = [...tailRebuilt(sampled.length ? sampled[0][0] : Infinity).map(([at, T]) => [at, tailRate(T)]), ...sampled];
      let showRate = null;
      showRate = timeChart(fig("minttail"), past, rateFmt, (t) => showRate && showRate(t), { quiet: true, timeLabel: horizonLabel(), bands: dipBands, ...projection(tailRate),
        hlines: [{ y: tailRate(c.tailProgress) / 2, label: "Next ½" }, { y: c.flatRate / 4, label: "¼ rate" }] });
    } else {
      curveChart(fig("minttail"), { x0: 0, x1: tailEnd, y0: 0, y1: c.flatRate * 1.08, f: tailRate, ticksY: rateTicks, fmtY: rateFmt, fmtX: usd, xLabel: "counted", xTicks: lossTicks(tailEnd), now: c.tailProgress,
        markers: tailMarks });
    }
    const minted = (p) => (c.flatRate * D * p) / (D + p), base = c.supplyPaper - minted(c.tailProgress), limit = base + c.flatRate * D;
    if (axis) {
      // Past supply: the hourly history (each value is the hour's end, hence +1 interval), ending at the current supply.
      const mk = d.protocol && d.protocol.market, past = [];
      // From HISTORY_START (PAPER's launch: supply 0, flat rate, nothing counted yet).
      for (let i = 0; mk && mk.paperSupply && i < mk.paperSupply.length; i++) {
        const at = mk.startMs + (i + 1) * mk.intervalMs;
        if (at < HISTORY_START) continue;
        if (at < axis.t0) past.push([at, mk.paperSupply[i] || 0]);
      }
      past.push([axis.t0, c.supplyPaper]);
      let showSupply = null;
      showSupply = timeChart(fig("supply"), past, supplyFmt, (t) => showSupply && showSupply(t), { quiet: true, timeLabel: horizonLabel(), ...projection((p) => base + minted(p)),
        hlines: [{ y: limit, label: `Max ${(limit / 1e9).toFixed(2)}B` }] });
    } else {
      curveChart(fig("supply"), { x0: 0, x1: tailEnd, y0: 0, y1: limit * 1.06, f: (p) => base + minted(p), ticksY: [limit, limit / 2, 0], fmtY: supplyFmt, fmtX: usd, xLabel: "counted",
        asymptote: limit, asymptoteLabel: `Max ${(limit / 1e9).toFixed(2)}B`, xTicks: lossTicks(tailEnd), now: c.tailProgress });
    }
    // The dev-fee figure in this grid is drawn by app.js (it owns the dev-fee data); tell it the grid was rebuilt.
    document.dispatchEvent(new Event("paperboards:rules"));
  }

  // ------------------------------------------------------------------------------------------ wiring
  // Pace of the counted losses (tail progress per hour) for every projection on the page, from the sampled tail
  // progress over the last 24 h, binned by hour: the median hourly loss as the central case, the 25th and 75th
  // percentiles as the band. Backtested on the first two days: a trailing mean (3 h / 6 h / 24 h) ran high while the
  // pace fell from launch, and the 24 h mean worst (median error −42% over the next 6 h); the median ignores single
  // large hours and tracks the level the pace has settled at. The indexer's tailSpeedUsdPerHour is the average since
  // sampling began, which the launch hours inflate, so the page replaces it with the median.
  function withPace(m) {
    const s = m && m.series;
    if (!s || !s.tailProgressUsd) return m;
    const pts = s.tailProgressUsd.map((v, i) => [s.startMs + i * s.intervalMs, v]).filter(([, v]) => v != null && Number.isFinite(v));
    if (pts.length < 2) return m;
    const last = pts[pts.length - 1], H = 3_600_000;
    // Loss in each of the last 24 whole hours (ending at the last sample), from the sample nearest each boundary.
    const at = (t) => pts.reduce((b, p) => (Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), pts[0]);
    const hourly = [];
    for (let h = 24; h >= 1; h--) {
      const a = at(last[0] - h * H), b = at(last[0] - (h - 1) * H);
      if (b[0] > a[0] && b[0] - a[0] <= 1.5 * H) hourly.push((b[1] - a[1]) / ((b[0] - a[0]) / H));
    }
    if (hourly.length < 6) return m;
    const sorted = [...hourly].sort((x, y) => x - y), q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const mid = q(0.5), low = q(0.25), high = q(0.75);
    if (!(mid > 0)) return m;
    return { ...m, tailSpeedUsdPerHour: mid, pace: { mid, low, high, hours: hourly.length } };
  }

  function render(d) {
    if (!d) return;
    const dd = { ...d, mint: withPace(d.mint) };
    renderNow(dd);
    renderActivity(dd);
    renderRules(dd);
  }
  document.addEventListener("click", (e) => {
    const hz = e.target.closest("#horizon button[data-days]");
    if (hz && pb() && pb().data()) {
      horizon = Number(hz.dataset.days);
      try { localStorage.setItem("paperboards.horizon", String(horizon)); } catch { /* storage unavailable */ }
      renderRules({ ...pb().data(), mint: withPace(pb().data().mint) });
      return;
    }
    const t = e.target.closest("#tailaxis button[data-axis]");
    if (t && pb() && pb().data()) {
      tailAxis = t.dataset.axis;
      try { localStorage.setItem("paperboards.tailAxis", tailAxis); } catch { /* storage unavailable */ }
      renderRules({ ...pb().data(), mint: withPace(pb().data().mint) });
      return;
    }
    const b = e.target.closest("#period button[data-period]");
    if (!b || !pb() || !pb().data()) return;
    period = b.dataset.period;
    try { localStorage.setItem("paperboards.period", period); } catch { /* storage unavailable */ }
    renderActivity({ ...pb().data(), mint: withPace(pb().data().mint) });
  });
  window.paperboardsStats = { render, timeChart, linearProjection, setInfo, HISTORY_START, horizon: () => ({ days: horizon, timeLabel: horizonLabel() }) };
})();
