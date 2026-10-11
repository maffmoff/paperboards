// Stats page, in three groups:
//   Now      – the state at this moment (no period).
//   Activity – a 1H / 1D / 7D / 30D / All switch. Totals over the period (volume, trades, trader pnl,
//              staker rewards, PAPER minted, new users) and the history behind them; time-averaged
//              figures (inflation, APR, average cost per PAPER) follow the switch but have no history.
//   Rules    – the protocol's fixed parameters and the curves they define.
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
  const unit = (v, d = 4) => (v == null || !Number.isFinite(v) ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`);
  const hourLabel = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const kpi = (label, value, title = "", note = "") => `<div class="kpi"${title ? ` title="${esc(title)}"` : ""}><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<em>${esc(note)}</em>` : ""}</div>`;

  // ---------------------------------------------------------------------------------------------- Now
  const maxSupply = (c) => (c && c.decayScale > 0 && c.flatRate > 0 ? c.supplyPaper + (c.flatRate * c.decayScale * c.decayScale) / (c.decayScale + c.tailProgress) : null);
  const stakerShare = (lp, c) => (lp < 0 ? 0 : c.stakerCap > 0 && lp >= c.stakerCap ? 99 : 1);

  function renderNow(d) {
    const p = d.protocol || {}, c = d.curve, m = d.mint, cc = d.crossCheck || {};
    const big = (s) => BigInt(s ?? "0");
    const balances = Number(d.rows.reduce((s, r) => s + big(r.balance18), 0n) / 10n ** 12n) / 1e6;
    const max = maxSupply(c), users = cc.apiUniqueAccounts || d.totals.depositors;
    const items = [];
    if (m && typeof m.ratePerUsd === "number") {
      const T = m.tailProgressUsd, D = c && c.decayScale > 0 ? c.decayScale : 120e6, next = Math.SQRT2 * (D + T) - D;
      const hrs = m.tailSpeedUsdPerHour > 0 ? (next - T) / m.tailSpeedUsdPerHour : null;
      items.push(
        kpi("cost to mint now · no hedge", unit(m.mintCostUsd), "", `1 ÷ (0.98 × ${m.ratePerUsd.toFixed(1)}/$)`),
        kpi(`cost to mint now · hedged ±${m.hedgedCostTargetBps ?? 15} bps`, unit(m.hedgedMintCostUsd), "", m.hedgedWinRatio ? `win leg recovers ${pct(m.hedgedWinRatio, 0)}` : ""),
        kpi("rate halves again at", usd(next), "realized losses", hrs != null ? `~${hrs < 48 ? `${hrs.toFixed(1)} h` : `${(hrs / 24).toFixed(1)} d`} at ${usd(m.tailSpeedUsdPerHour)}/h` : ""),
        kpi("payout queue", m.queueUsd > 0 ? usd(m.queueUsd) : "empty", "", m.queueUsd > 0 ? "wins are queued; loss fee waived" : "wins paid at once"),
      );
    }
    items.push(
      kpi("user balances", usd(balances), "sum of every depositor's account value; not TVL", `${count(users)} users`),
      kpi("max supply ≈", paper(max), "", "if lp never dips below the cliff"),
      kpi("valuation", max != null && p.avgCost != null ? usd(p.avgCost * max) : "–", "all-time average cost per PAPER × max supply", p.avgCost != null ? `${unit(p.avgCost)} / paper × max supply` : ""),
    );
    $("now").innerHTML = items.join("");
  }

  // ------------------------------------------------------------------------------------------ Activity
  const PERIODS = [["1h", "1H", 1], ["1d", "1D", 24], ["7d", "7D", 168], ["30d", "30D", 720], ["all", "All", null]];
  let period = "1d";
  try { const v = localStorage.getItem("paperboards.period"); if (PERIODS.some(([k]) => k === v)) period = v; } catch { /* storage unavailable */ }

  function renderActivity(d) {
    const p = d.protocol || {}, f = p.flows && p.flows[period], a = p.periods && p.periods[period], m = p.market;
    const [, name, hours] = PERIODS.find(([k]) => k === period);
    for (const b of document.querySelectorAll("#period button")) b.classList.toggle("on", b.dataset.period === period);
    const tag = (w) => `${name}${w && w.clamped ? ` (${Math.round(w.hours)}h)` : ""}`;
    const box = $("activity-rows");
    // History window: the selected period, at least the last 24 h since the data is hourly.
    let pts = () => [], t0 = 0;
    if (m && m.tvl.length >= 2) {
      const n = m.tvl.length, keep = hours == null ? n : Math.min(n, Math.max(24, hours) + 1), from = n - keep;
      const t = (i) => m.startMs + i * m.intervalMs;
      t0 = t(from);
      pts = (arr) => arr.slice(from).map((v, i) => [t(from + i), v]);
    }
    const ms = d.mint && d.mint.series;
    const mintPts = ms && ms.ratePerUsd ? ms.ratePerUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]).filter(([x]) => x >= t0) : [];
    const dips = (d.mint && d.mint.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
    const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const oi = d.openInterest;
    const oiPts = oi ? oi.times.map((x, i) => [x, oi.total[i]]).filter(([x]) => x >= t0) : null;
    // [label, value, title, chart points, formatter, bars, bands]
    // One row per quantity; figures derived from the same numbers share its row instead of repeating it.
    const apr = a && a.apr != null ? `apr ${pct(a.apr, 0)}` : null;
    const cost = a && a.costPerPaper != null ? `${unit(a.costPerPaper)} per paper minted` : null;
    const growth = f ? `+${paper(f.paperMinted)}${a && a.inflation != null ? ` (+${pct(a.inflation, a.inflation < 0.01 ? 2 : 1)})` : ""} · ${tag(f)}` : null;
    const peak = (arr, fmt) => { const v = arr ? arr.map(([, x]) => x).filter((x) => x != null && Number.isFinite(x)) : []; return v.length ? `peak ${fmt(Math.max(...v))} / h` : null; };
    // [label, value, sub-value, title, chart points, formatter, bars, bands]
    const rows = [
      [`volume · ${tag(f)}`, f ? usd(f.volume) : "–", m && peak(pts(m.volumePerInterval), usd), "total traded over the period; bars = per hour", m && pts(m.volumePerInterval), usd, true],
      [`trades · ${tag(f)}`, f ? count(f.trades) : "–", m && peak(pts(m.tradesPerInterval), count), "trades over the period; bars = per hour", m && pts(m.tradesPerInterval), count, true],
      [`trader pnl · ${tag(f)}`, f ? signedUsd(f.pnlChange) : "–", cost, "change in cumulative trader pnl (negative = traders lost) and the net loss per PAPER minted in the period; bars = per hour", m && pts(m.pnlPerInterval), signedUsd, true],
      [`staker rewards · ${tag(f)}`, f ? usd(f.rewards) : "–", apr, "USDC paid to stakers over the period; apr = per staked PAPER, annualized, ÷ all-time average cost per PAPER; bars = per hour", m && pts(m.rewardsPerInterval), usd, true],
      ["tvl", d.crossCheck && d.crossCheck.apiTvl18 ? usd(Number(BigInt(d.crossCheck.apiTvl18) / 10n ** 12n) / 1e6) : usd(m && last(m.tvl)), m && m.tvl.length > 1 ? `${signedUsd(last(m.tvl) - pts(m.tvl)[0][1])} · ${tag(f)}` : null, "official protocol treasury value", m && pts(m.tvl), usd],
      ["users", count((d.crossCheck && d.crossCheck.apiUniqueAccounts) || (m && last(m.users))), f ? `+${count(f.newUsers)} · ${tag(f)}` : null, "accounts now and added over the period", m && pts(m.users), count],
      ["paper supply", paper(p.paperSupply), growth, "PAPER now, minted over the period and the growth that is (inflation)", m && pts(m.paperSupply), paper],
      ...(oi ? [["open interest", usd(last(oi.total)), `btc ${usd(last(oi.btcLong) + last(oi.btcShort))} · eth ${usd(last(oi.ethLong) + last(oi.ethShort))}`, "entry notional of open positions, long + short (official house history)", oiPts, usd]] : []),
      ["mint rate", d.mint && typeof d.mint.ratePerUsd === "number" ? `${d.mint.ratePerUsd.toFixed(1)} / $` : "–", (d.mint && d.mint.dips && d.mint.dips.length) ? `${d.mint.dips.length} cliff dips shaded` : "cliff dips shaded · none so far", "PAPER per $1 of realized loss now; shaded = cliff dip (lp below the mint-decay threshold)", mintPts, (v) => `${v.toFixed(1)}/$`, false, dips],
    ];
    // Cards: name / value / note on the left, a 150x40 sparkline on the right (hover to read a point).
    box.innerHTML = rows.map(([label, value, sub, title, points], i) => `<div class="acard"${title ? ` title="${esc(title)}"` : ""}>
      <div class="atext"><span>${esc(label)}</span><b>${esc(value)}</b><em>${esc(sub || "")}</em></div>
      ${points ? `<figure class="chart spark" data-i="${i}"><figcaption><span></span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(label)} history"></svg></figure>` : ""}
    </div>`).join("");
    const base = `hourly · ${hours == null ? "since genesis" : hours < 24 ? "last 24 h" : `last ${hours >= 168 ? `${hours / 24} days` : `${hours} h`}`} · hover a chart to read every row at that time`;
    $("activityhint").textContent = base;
    const draws = [];
    const hover = (msAt) => { draws.forEach((g) => g(msAt)); $("activityhint").textContent = msAt == null ? base : hourLabel(msAt); };
    rows.forEach(([, , , , points, fmt, bars, bands], i) => {
      if (!points) return;
      draws.push(timeChart(box.querySelector(`.chart[data-i="${i}"]`), points, fmt, hover, { bars, bands, compact: true }));
    });
  }

  // A time-scaled chart: line (levels) or bars (per-hour flows), optional shaded bands, shared hover by time.
  function timeChart(fig, points, fmt, onHover, opts = {}) {
    const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv");
    const pts = points.filter(([, v]) => v != null && Number.isFinite(v));
    if (pts.length < 2) { cv.textContent = pts.length ? fmt(pts[0][1]) : "–"; svg.innerHTML = ""; return () => {}; }
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    let lo = Math.min(0, ...pts.map(([, v]) => v)), hi = Math.max(0, ...pts.map(([, v]) => v));
    if (lo === hi) hi = lo + 1;
    const pad = (hi - lo) * 0.08; lo -= lo < 0 ? pad : 0; hi += pad;
    const ticks = opts.compact ? [] : [hi - pad, (lo + hi - pad) / 2, lo < 0 ? lo + pad : 0];
    const W = Math.max(opts.compact ? 120 : 200, fig.querySelector("svg").clientWidth || fig.clientWidth);
    const H = opts.compact ? 40 : 132, L = opts.compact ? 1 : Math.ceil(Math.max(...ticks.map((v) => fmt(v).length)) * 5.6) + 10, R = opts.compact ? 1 : 10, T = opts.compact ? 3 : 8, B = opts.compact ? 3 : 20;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const x = (ms) => L + ((ms - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let marks = "";
    if (opts.bars) {
      const bw = Math.max(1, ((W - L - R) / Math.max(1, points.length)) * (opts.compact ? 0.8 : 0.7));
      marks = pts.map(([ms, v]) => `<rect class="${v < 0 ? "barneg" : "bar"}" x="${(x(ms) - bw / 2).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(y(v) - y(0))).toFixed(1)}"/>`).join("");
    } else {
      let path = "", pen = false;
      for (const [ms, v] of points) { if (v == null || !Number.isFinite(v)) { pen = false; continue; } path += `${pen ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
      marks = `<path class="line" d="${path}"/>`;
    }
    const bands = (opts.bands || []).filter(([a, b]) => b >= t0 && a <= t1).map(([a, b, dp]) => {
      const x0 = x(Math.max(a, t0)), x1 = Math.max(x0 + 3, x(Math.min(b, t1)));
      return `<rect class="dipband" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${H - T - B}"><title>${esc(`cliff dip ${hourLabel(a)} → ${dp.toAt ? hourLabel(b) : "now"}`)}</title></rect>`;
    }).join("");
    svg.innerHTML = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(fmt(v))}</text>`).join("")
      + (opts.compact ? (lo < 0 ? `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` : "") : `<text class="tick" x="${L}" y="${H - 5}">${esc(hourLabel(t0))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(hourLabel(t1))}</text>`)
      + bands + marks + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/><rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const nearest = (ms) => pts.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best), pts[0]);
    const show = (ms) => {
      const p = ms == null ? pts[pts.length - 1] : nearest(ms);
      cv.textContent = opts.compact && ms == null ? "" : fmt(p[1]);
      if (ms == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
      cross.setAttribute("x1", x(p[0])); cross.setAttribute("x2", x(p[0])); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(p[0])); dot.setAttribute("cy", y(p[1])); dot.setAttribute("visibility", opts.bars ? "hidden" : "visible");
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; onHover(t0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (t1 - t0)); });
    hit.addEventListener("mouseleave", () => onHover(null));
    show(null);
    return show;
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
    const W = Math.max(220, fig.clientWidth), H = 150, T = 10, B = 22, R = 12;
    const L = Math.ceil(Math.max(...o.ticksY.map((t) => o.fmtY(t).length)) * 5.6) + 10;
    const x = (v) => L + ((v - o.x0) / (o.x1 - o.x0)) * (W - L - R), y = (v) => T + (1 - (v - o.y0) / (o.y1 - o.y0)) * (H - T - B);
    let d = "";
    for (let i = 0; i <= 360; i++) {
      const v = o.x0 + ((o.x1 - o.x0) * i) / 360, w = o.f(v);
      d += o.step && i ? `H${x(v).toFixed(1)}V${y(w).toFixed(1)}` : `${i ? "L" : "M"}${x(v).toFixed(1)},${y(w).toFixed(1)}`;
    }
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const marks = (o.markers || []).filter((m) => m.x >= o.x0 && m.x <= o.x1);
    svg.innerHTML = o.ticksY.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(o.fmtY(t))}</text>`).join("")
      + `<text class="tick" x="${L}" y="${H - 6}">${esc(o.fmtX(o.x0))}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(o.fmtX(o.x1))} ${esc(o.xLabel)}</text>`
      + marks.map((m, i) => { const lx = x(m.x), right = lx > W - R - 150; return `<line class="vmark ${m.kind || ""}" x1="${lx}" x2="${lx}" y1="${T}" y2="${H - B}"/><text class="mlabel" x="${right ? lx - 4 : lx + 4}" y="${T + 9 + i * 11}" text-anchor="${right ? "end" : "start"}">${esc(m.label)}</text>`; }).join("")
      + (o.asymptote != null ? `<line class="asym" x1="${L}" x2="${W - R}" y1="${y(o.asymptote)}" y2="${y(o.asymptote)}"/>` : "")
      + `<path class="line" d="${d}"/>`
      + (o.now != null ? `<circle class="mark" r="4.5" cx="${x(o.now).toFixed(1)}" cy="${y(o.f(o.now)).toFixed(1)}"/>` : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/><rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const read = (v) => `${o.fmtY(o.f(v))} at ${o.fmtX(v)}`;
    const show = (v) => {
      cv.textContent = v == null ? (o.now != null ? read(o.now) : "") : read(v);
      if (v == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
      cross.setAttribute("x1", x(v)); cross.setAttribute("x2", x(v)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(v)); dot.setAttribute("cy", y(o.f(v))); dot.setAttribute("visibility", "visible");
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; show(o.x0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (o.x1 - o.x0)); });
    hit.addEventListener("mouseleave", () => show(null));
    show(null);
  }

  function renderRules(d) {
    const c = d.curve, params = $("rules-params"), box = $("rules-curves");
    if (!c || !(c.flatRate > 0) || !(c.decayScale > 0)) { params.innerHTML = ""; box.innerHTML = `<p class="empty">rule inputs unavailable</p>`; return; }
    params.innerHTML = [
      kpi("flat mint rate", `${c.flatRate} / $`, "PAPER per $1 of realized loss while lp is below the mint-decay threshold"),
      kpi("mint decay threshold", usd(c.threshold), "lp above which the mint rate follows the tail curve"),
      kpi("tail decay constant D", usd(c.decayScale), "rate = flat × (D ÷ (D + realized losses past the threshold))²"),
      kpi("staker threshold", usd(c.stakerCap), "lp at which stakers receive 99% of realized losses"),
      kpi("staker share", "0% / 1% / 99%", "of realized losses: lp below 0 / between 0 and the staker threshold / at or above it"),
    ].join("");
    const figs = [
      ["mintlp", "Mint rate by LP balance"],
      ["share", "Staker share of realized losses by LP balance"],
      ["minttail", "Mint rate by cumulative realized loss"],
      ["supply", "PAPER supply by cumulative realized loss"],
    ];
    box.innerHTML = figs.map(([k, t]) => `<figure class="chart" data-curve="${k}"><figcaption><span>${esc(t)}</span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(t)}"></svg></figure>`).join("");
    const fig = (k) => box.querySelector(`[data-curve="${k}"]`);
    let lp1 = Math.max(12e6, c.threshold * 4, c.stakerCap * 2);
    if (c.currentLp > lp1 * 0.9) lp1 = c.currentLp * 1.15;
    const lp0 = -Math.max(lp1 * 0.1, -c.currentLp * 1.4);
    const lpMarks = [{ x: c.threshold, label: `mint decay ${usd(c.threshold)}`, kind: "warn" }, { x: c.stakerCap, label: `staker threshold ${usd(c.stakerCap)}`, kind: "pos" }];
    const rateTicks = [c.flatRate, c.flatRate / 2, c.flatRate / 4, 0];
    curveChart(fig("mintlp"), { x0: lp0, x1: lp1, y0: 0, y1: c.flatRate * 1.08, f: (v) => curveRate(v, c), ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usd, xLabel: "lp", markers: lpMarks, now: c.currentLp });
    curveChart(fig("share"), { x0: lp0, x1: lp1, y0: 0, y1: 105, f: (v) => stakerShare(v, c), step: true, ticksY: [99, 50, 1], fmtY: (v) => `${Math.round(v)}%`, fmtX: usd, xLabel: "lp", markers: lpMarks, now: c.currentLp });
    const D = c.decayScale, tailEnd = D * (Math.sqrt(c.flatRate) - 1), tailRate = (p) => c.flatRate * (D / (D + p)) ** 2;
    curveChart(fig("minttail"), { x0: 0, x1: tailEnd, y0: 0, y1: c.flatRate * 1.08, f: tailRate, ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usd, xLabel: "realized",
      markers: [{ x: D * (Math.SQRT2 - 1), label: `half rate ${usd(D * (Math.SQRT2 - 1))}` }, { x: D, label: `quarter ${usd(D)}` }], now: c.tailProgress });
    const minted = (p) => (c.flatRate * D * p) / (D + p), base = c.supplyPaper - minted(c.tailProgress), limit = base + c.flatRate * D;
    curveChart(fig("supply"), { x0: 0, x1: tailEnd, y0: 0, y1: limit * 1.06, f: (p) => base + minted(p), ticksY: [limit, limit / 2, 0], fmtY: (v) => `${(v / 1e9).toFixed(2)}B`, fmtX: usd, xLabel: "realized",
      asymptote: limit, markers: [{ x: D, label: `limit ${(limit / 1e9).toFixed(2)}B (no more cliff dips)` }], now: c.tailProgress });
  }

  // ------------------------------------------------------------------------------------------ wiring
  function render(d) {
    if (!d) return;
    renderNow(d);
    renderActivity(d);
    renderRules(d);
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#period button[data-period]");
    if (!b || !pb() || !pb().data()) return;
    period = b.dataset.period;
    try { localStorage.setItem("paperboards.period", period); } catch { /* storage unavailable */ }
    renderActivity(pb().data());
  });
  window.paperboardsStats = { render };
})();
