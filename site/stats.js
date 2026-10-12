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
  const unit = (v) => (v == null || !Number.isFinite(v) ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1 || v === 0 ? Math.abs(v).toFixed(v === 0 ? 4 : 2) : Math.abs(v).toPrecision(3)}`);
  // Every history on the page starts at PAPER's launch, 2026-10-10 22:00 SGT (14:00 UTC); labels show the viewer's
  // local time.
  const HISTORY_START = Date.UTC(2026, 9, 10, 14);
  const hourLabel = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const kpi = (label, value, title = "", note = "") => `<div class="kpi"${title ? ` title="${esc(title)}"` : ""}><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<em>${esc(note)}</em>` : ""}</div>`;

  // ---------------------------------------------------------------------------------------------- Now
  const maxSupply = (c) => (c && c.decayScale > 0 && c.flatRate > 0 ? c.supplyPaper + (c.flatRate * c.decayScale * c.decayScale) / (c.decayScale + c.tailProgress) : null);

  function renderNow(d) {
    const c = d.curve, m = d.mint, cc = d.crossCheck || {};
    const big = (s) => BigInt(s ?? "0");
    const balances = Number(d.rows.reduce((s, r) => s + big(r.balance18), 0n) / 10n ** 12n) / 1e6;
    const max = maxSupply(c), users = cc.apiUniqueAccounts || d.totals.depositors;
    // Valuation at what one PAPER costs to mint today (hedged ±target, the Rules chart's figure) × max supply.
    const cost = m && typeof m.hedgedMintCostUsd === "number" ? m.hedgedMintCostUsd : null;
    // Staking APR over the 24 h ending at the last complete hour (the same figure as Activity's 1D apr and the Rules chart).
    const apr = d.protocol && d.protocol.periods && d.protocol.periods["1d"] ? d.protocol.periods["1d"].apr : null;
    $("now").innerHTML = [
      kpi("user balances", usd(balances), `sum of every depositor's account value (${count(users)} users); not TVL`),
      kpi("max supply ≈", paper(max), "current supply + what the mint curve can still emit, if the pool never dips below the cliff again; liquidations mint up to 2% more, and the owner can change the curve's parameters"),
      kpi("valuation", max != null && cost != null ? usd(cost * max) : "–", cost != null ? `max supply × today's cost to mint one PAPER (${unit(cost)}: a BTC long + short pair closed at ±${m.hedgedCostTargetBps ?? 15} bps, docs' price-impact model). What minting it all would cost at today's rate, not a market price` : ""),
      kpi("apr · 24h", pct(apr, 0), "USDC paid to stakers over the last complete 24 h per staked PAPER, annualized, ÷ the all-time average cost per PAPER (−cumulative trader pnl ÷ supply). Rewards come in lumps: a trailing figure, not a forecast"),
    ].join("");
  }


  // ------------------------------------------------------------------------------------------ Activity
  // Granularity of the Activity charts: hourly bars, or one bar per local day. Headline figures cover the last complete
  // hour or the 24 h ending at the last complete hour (protocol.flows / periods), not the bar in progress.
  const PERIODS = [["1h", "1H", 1], ["1d", "1D", 24]];
  // X axis of the two tail projections in Rules: estimated date (at the current tail speed) or cumulative realized loss.
  let tailAxis = "time";
  try { const v = localStorage.getItem("paperboards.tailAxis"); if (v === "time" || v === "loss") tailAxis = v; } catch { /* storage unavailable */ }
  let period = "1h";
  try { const v = localStorage.getItem("paperboards.period"); if (PERIODS.some(([k]) => k === v)) period = v; } catch { /* storage unavailable */ }

  function renderActivity(d) {
    const p = d.protocol || {}, f = p.flows && p.flows[period], m = p.market;
    const [, , hours] = PERIODS.find(([k]) => k === period);
    for (const b of document.querySelectorAll("#period button")) b.classList.toggle("on", b.dataset.period === period);
    const box = $("activity-rows");
    // Whole history, bucketed by the granularity: flows (bars) are summed per bucket, levels keep the bucket's last value.
    // Daily buckets start at local midnight; hourly buckets are the history's own hours.
    const daily = hours >= 24;
    const keyOf = (ms) => { if (!daily) return ms; const t = new Date(ms); t.setHours(0, 0, 0, 0); return t.getTime(); };
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
      flow = (arr) => bucket(raw(arr), true);
    }
    const timeLabel = daily ? (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : hourLabel;
    const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const oi = d.openInterest;
    const oiPts = oi ? bucket(oi.times.map((x, i) => [x, oi.total[i]]).filter(([x]) => x >= t0), false) : null;
    // Net exposure of open interest: (long − short) ÷ (long + short), BTC + ETH entry notional; positive = traders net
    // long (the house net short), 0 = balanced, ±100% = one-sided.
    const netAt = (i) => (oi.btcLong[i] + oi.ethLong[i]) - (oi.btcShort[i] + oi.ethShort[i]);
    const netPctAt = (i) => (oi.total[i] > 0 ? netAt(i) / oi.total[i] : null);
    const netPts = oi ? bucket(oi.times.map((x, i) => [x, netPctAt(i)]).filter(([x, v]) => x >= t0 && v != null && Number.isFinite(v)), false) : null;
    // [label, value, title, chart points, formatter, bars, overlay] — the value only (no notes); trader pnl and staker
    // rewards carry their cumulative total as a line over the bars (overlay, right axis).
    const cumPnl = m && m.traderPnl ? pts(m.traderPnl) : null, cumRewards = m && m.stakingRewards ? pts(m.stakingRewards) : null;
    const rows = [
      ["volume", f ? usd(f.volume) : "–", `total traded in the last complete ${daily ? "24 h" : "hour"}; bars = per ${daily ? "day" : "hour"}`, m && flow(m.volumePerInterval), usd, true],
      ["tvl", d.crossCheck && d.crossCheck.apiTvl18 ? usd(Number(BigInt(d.crossCheck.apiTvl18) / 10n ** 12n) / 1e6) : usd(m && last(m.tvl)), "official protocol treasury value", m && pts(m.tvl), usd],
      ["trader pnl", f ? signedUsd(f.pnlChange) : "–", `change in cumulative trader pnl in the last complete ${daily ? "24 h" : "hour"} (negative = traders lost); bars = per ${daily ? "day" : "hour"} (left axis), line = cumulative since the start (right axis)`, m && flow(m.pnlPerInterval), signedUsd, true, cumPnl && { points: cumPnl, fmt: signedUsd, label: "cumulative" }],
      ["staker rewards", f ? usd(f.rewards) : "–", `USDC paid to stakers in the last complete ${daily ? "24 h" : "hour"}; bars = per ${daily ? "day" : "hour"} (left axis), line = cumulative since the start (right axis)`, m && flow(m.rewardsPerInterval), usd, true, cumRewards && { points: cumRewards, fmt: usd, label: "cumulative" }],
      ...(oi ? [["open interest", usd(last(oi.total)), "entry notional of open positions, long + short (official house history)", oiPts, usd],
        ["net exposure, % of open interest", (() => { const v = netPctAt(oi.times.length - 1); return v == null ? "–" : `${v > 0 ? "+" : ""}${pct(v, 0)}`; })(), `(long − short) ÷ (long + short), BTC + ETH entry notional; positive = traders net long, so the house is net short. Now: ${signedUsd(netAt(oi.times.length - 1))} of ${usd(oi.total[oi.times.length - 1])} (BTC ${signedUsd(oi.btcLong[oi.times.length - 1] - oi.btcShort[oi.times.length - 1])}, ETH ${signedUsd(oi.ethLong[oi.times.length - 1] - oi.ethShort[oi.times.length - 1])})`, netPts, (v) => `${v > 0 ? "+" : ""}${pct(v, 0)}`]] : []),
      ["users", count((d.crossCheck && d.crossCheck.apiUniqueAccounts) || (m && last(m.users))), "accounts with a deposit (official)", m && pts(m.users), count],
    ];
    // Laid out like the Rules charts: the value beside the title (its note after it), then the chart; hover shows the
    // cursor label on every chart at once.
    box.className = "charts charts-2";
    box.innerHTML = rows.map(([label, value, title, points, fmt, , overlay], i) => `<figure class="chart act" data-i="${i}"${title ? ` title="${esc(title)}"` : ""}>
      <figcaption><span>${esc(label)}</span><b class="cv">${esc(value)}</b>${overlay && overlay.points.length ? `<em class="ocap"><i></i>cumulative ${esc(overlay.fmt(overlay.points[overlay.points.length - 1][1]))}</em>` : ""}</figcaption>
      ${points ? `<svg role="img" aria-label="${esc(label)} history"></svg>` : ""}
    </figure>`).join("");
    const base = `${daily ? "daily" : "hourly"} bars since genesis · headline: last complete ${daily ? "24 h" : "hour"} · hover a chart to read every row at that time`;
    $("activityhint").textContent = base;
    const draws = [];
    const hover = (msAt) => { draws.forEach((g) => g(msAt)); $("activityhint").textContent = msAt == null ? base : hourLabel(msAt); };
    rows.forEach(([, , , points, fmt, bars, overlay], i) => {
      if (!points) return;
      draws.push(timeChart(box.querySelector(`.chart[data-i="${i}"]`), points, fmt, hover, { bars, timeLabel, keepCaption: true, overlay }));
    });
  }

  // The caption of a chart with a "now" marker states the value at that marker, beside the title, so the current
  // position reads without hovering.
  const nowCaption = (text) => esc(text);

  // A small label that follows the cursor inside the chart, instead of a readout in the caption.
  // The cursor label is text only, in the marker labels' voice (small caps, muted), with a thin page-colored halo so it
  // stays legible over the line; no box, nothing bold.
  const TIP = `<g class="tip" visibility="hidden"><text class="mlabel" paint-order="stroke" stroke="var(--panel)" stroke-width="3" stroke-linejoin="round" text-anchor="middle"/></g>`;
  function moveTip(svg, W, px, py, text) {
    const g = svg.querySelector(".tip"); if (!g) return;
    if (text == null) { g.setAttribute("visibility", "hidden"); return; }
    const t = g.querySelector("text");
    t.textContent = text;
    // Pinned to the top edge of the plot (the marker-label row) at the cursor's x, so it never sits on the line or bars.
    const w = text.length * 5.6, cx = Math.max(4 + w / 2, Math.min(W - 4 - w / 2, px));
    t.setAttribute("x", cx.toFixed(1)); t.setAttribute("y", "9");
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
      const vals = [...pts.map(([, v]) => v), ...fband.flatMap(([, a, b]) => [a, b])].filter((v) => v > 0);
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
    const ov = opts.overlay && !opts.compact ? opts.overlay.points.filter(([ms, v]) => ms >= t0 && ms <= t1 && v != null && Number.isFinite(v)) : [];
    let oLo = Math.min(0, ...ov.map(([, v]) => v)), oHi = Math.max(0, ...ov.map(([, v]) => v));
    if (oLo === oHi) oHi = oLo + 1;
    const oPad = (oHi - oLo) * 0.08; oLo -= oLo < 0 ? oPad : 0; oHi += oPad;
    const oTicks = ov.length ? [oHi - oPad, (oLo + oHi - oPad) / 2, oLo < 0 ? oLo + oPad : 0] : [];
    const H = opts.compact ? 40 : 150, L = opts.compact ? 1 : Math.ceil(Math.max(...ticks.map((v) => fmt(v).length)) * 5.6) + 10, T = opts.compact ? 3 : 8, B = opts.compact ? 3 : 20;
    const R = opts.compact ? 1 : ov.length ? Math.ceil(Math.max(...oTicks.map((v) => opts.overlay.fmt(v).length)) * 5.6) + 10 : 10;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const x = (ms) => L + ((ms - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (v) => T + (1 - (tr(v) - sLo) / (sHi - sLo)) * (H - T - B);
    let marks = "";
    if (opts.bars) {
      const bw = Math.max(1, ((W - L - R) / Math.max(1, points.length)) * (opts.compact ? 0.8 : 0.7));
      marks = pts.map(([ms, v]) => `<rect class="${v < 0 ? "barneg" : "bar"}" x="${(x(ms) - bw / 2).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(y(v) - y(0))).toFixed(1)}"/>`).join("");
    } else {
      let path = "", pen = false;
      for (const [ms, v] of points) { if (v == null || !Number.isFinite(v)) { pen = false; continue; } path += `${pen ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
      marks = `<path class="line" d="${path}"/>`;
      if (future.length) {
        // The model is its own line, not joined to the last observed point: it starts at the model's value "now" (the
        // projections include h = 0), which equals the observed value unless the model differs from it (e.g. inflation).
        const proj = future.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("");
        if (fband.length) {
          const top = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`), bot = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`).reverse();
          marks += `<polygon class="projband" points="${top.join(" ")} ${bot.join(" ")}"/>`;
        }
        marks += `<path class="line proj" d="${proj}"/><line class="vmark" x1="${x(nowMs).toFixed(1)}" x2="${x(nowMs).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
      }
    }
    const bands = (opts.bands || []).filter(([a, b]) => b >= t0 && a <= t1).map(([a, b, dp]) => {
      const x0 = x(Math.max(a, t0)), x1 = Math.max(x0 + 3, x(Math.min(b, t1)));
      return `<rect class="dipband" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${H - T - B}"><title>${esc(`cliff dip ${hourLabel(a)} → ${dp.toAt ? hourLabel(b) : "now"}`)}</title></rect>`;
    }).join("");
    const hlines = (opts.hlines || []).filter((h) => h.y >= lo && h.y <= hi).map((h) => `<line class="vmark ${h.kind || ""}" x1="${L}" x2="${W - R}" y1="${y(h.y).toFixed(1)}" y2="${y(h.y).toFixed(1)}"/><text class="mlabel" x="${h.align === "left" ? L + 4 : W - R - 4}" y="${(y(h.y) - 3).toFixed(1)}" text-anchor="${h.align === "left" ? "start" : "end"}">${esc(h.label)}</text>`).join("");
    svg.innerHTML = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(fmt(v))}</text>`).join("")
      + hlines
      + (opts.compact ? (lo < 0 ? `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` : "") : `<text class="tick" x="${L}" y="${H - 5}">${esc((opts.timeLabel || hourLabel)(t0))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc((opts.timeLabel || hourLabel)(t1))}</text>`)
      + bands + marks
      + (ov.length ? (() => {
        const oy = (v) => T + (1 - (v - oLo) / (oHi - oLo)) * (H - T - B);
        return oTicks.map((v) => `<text class="tick otick" x="${W - R + 6}" y="${oy(v) + 3}">${esc(opts.overlay.fmt(v))}</text>`).join("")
          + `<path class="line" d="${ov.map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${oy(v).toFixed(1)}`).join("")}"/>`;
      })() : "")
      // The current position: a dot only (the caption states its value).
      + (opts.markNow && !opts.compact ? (() => { const p = past[past.length - 1]; return `<circle class="mark" r="4.5" cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}"/>`; })() : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${opts.compact ? "" : TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const nearest = (ms) => pts.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best), pts[0]);
    const show = (ms) => {
      const p = ms == null ? pts[pts.length - 1] : nearest(ms);
      // Compact sparklines keep the caption readout (the Activity rows share one hover); full charts use the cursor label.
      if (opts.compact) cv.textContent = ms == null ? "" : fmt(p[1]);
      else if (!opts.keepCaption) cv.innerHTML = opts.markNow ? nowCaption(fmt(past[past.length - 1][1])) : "";
      if (ms == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); moveTip(svg, W, 0, 0, null); return; }
      cross.setAttribute("x1", x(p[0])); cross.setAttribute("x2", x(p[0])); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(p[0])); dot.setAttribute("cy", y(p[1])); dot.setAttribute("visibility", opts.bars ? "hidden" : "visible");
      const o = ov.length ? ov.reduce((b, q) => (Math.abs(q[0] - p[0]) < Math.abs(b[0] - p[0]) ? q : b), ov[0]) : null;
      if (!opts.compact) moveTip(svg, W, x(p[0]), y(p[1]), `${fmt(p[1])}${o ? ` · ${opts.overlay.label || "total"} ${opts.overlay.fmt(o[1])}` : ""} · ${(opts.timeLabel || hourLabel)(p[0])}${p[0] > nowMs ? " · projected" : ""}`);
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; onHover(t0 + Math.max(0, Math.min(1, (px - L) / (W - L - R))) * (t1 - t0)); });
    hit.addEventListener("mouseleave", () => onHover(null));
    show(null);
    return show;
  }

  // Projection of a cumulative series at its recent pace, hourly for `days` after its last point: the recent 6 h pace as
  // the central line, the band from the slowest to the fastest of the recent 3 h, 6 h and 24 h (the same model as the
  // counted losses).
  function linearProjection(pts, days = 7) {
    const p = pts.filter(([, v]) => v != null && Number.isFinite(v));
    if (p.length < 2) return { future: [], futureBand: [] };
    const last = p[p.length - 1];
    const over = (h) => { const from = p.find(([t]) => t >= last[0] - h * 3_600_000) || p[0]; const dh = (last[0] - from[0]) / 3_600_000; return dh > 0 ? (last[1] - from[1]) / dh : null; };
    const mid = over(6), all = [over(3), mid, over(24)].filter((v) => v != null && Number.isFinite(v));
    if (mid == null || !all.length) return { future: [], futureBand: [] };
    const lo = Math.min(...all), hi = Math.max(...all), future = [], futureBand = [];
    for (let h = 0; h <= days * 24; h++) { const t = last[0] + h * 3_600_000; future.push([t, last[1] + mid * h]); futureBand.push([t, last[1] + lo * h, last[1] + hi * h]); }
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
      + (o.now != null ? `<circle class="mark" r="4.5" cx="${x(o.now).toFixed(1)}" cy="${y(o.f(o.now)).toFixed(1)}"/>` : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const read = (v) => { const r = o.band && o.band(v); return `${o.fmtY(o.f(v))}${r ? ` (${o.fmtY(Math.min(...r))}–${o.fmtY(Math.max(...r))})` : ""} at ${(o.fmtReadX || o.fmtX)(v)}`; };
    const show = (v) => {
      cv.innerHTML = o.now != null ? nowCaption(o.fmtY(o.f(o.now))) : "";
      if (v == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); moveTip(svg, W, 0, 0, null); return; }
      moveTip(svg, W, x(v), y(o.f(v)), read(v));
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
    const figs = [
      ["pool", "LP Balance"],
      ["mintcost", "Cost to mint"],
      ["tailloss", "Counted losses over time"],
      ["minttail", byTime ? "Mint rate over time" : "Mint rate by counted loss"],
      ["supply", byTime ? "PAPER supply over time" : "PAPER supply by counted loss"],
      ["apr", "APR (trailing 24 h)"],
      ["inflation", "Inflation (trailing 24 h)"],
    ];
    box.innerHTML = figs.map(([k, t]) => `<figure class="chart" data-curve="${k}"><figcaption><span>${esc(t)}</span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(t)}"></svg></figure>`).join("");
    const fig = (k) => box.querySelector(`[data-curve="${k}"]`);
    // The pool's own history (every summary sample), with the two thresholds the curves below key on.
    {
      const ms = d.mint && d.mint.series, pts = ms && ms.trackedLpUsd ? ms.trackedLpUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]) : [];
      const dips = (d.mint && d.mint.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
      let showPool = null;
      fig("pool").title = `dotted lines: mint-decay threshold ${usd(c.threshold)} (flat 100/$ below it) and staker threshold ${usd(c.stakerCap)} (stakers take 99% at or above it)`;
      // No projection: the pool moves with the traders' net pnl, which cannot be estimated.
      showPool = timeChart(fig("pool"), pts, usd, (ms) => showPool && showPool(ms), { bands: dips, quiet: true, markNow: true, hlines: [{ x: 0, y: c.threshold, label: usd(c.threshold), kind: "warn", align: "left" }, { y: c.stakerCap, label: usd(c.stakerCap), kind: "pos", align: "left" }] });
    }
    const rateTicks = [c.flatRate, c.flatRate / 2, c.flatRate / 4, 0];
    // Net cost of one PAPER for a hedged pair closed at ±target, over time: (1 − win ratio) ÷ (0.98 × mint rate) on every
    // mint-rate sample. The win ratio depends only on the ±target, so it is the same at every point; cliff dips shaded.
    {
      const m = d.mint, ms = m && m.series, win = m && typeof m.hedgedWinRatio === "number" ? m.hedgedWinRatio : null;
      const cost = (r) => (r > 0 && win != null ? (1 - win) / (0.98 * r) : null);
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
      // Projection: realized losses keep growing at the recent tail speed (mint.tailSpeedUsdPerHour), so
      // T(t) = T_now + speed·Δt and the rate follows flat·(D/(D+T))² — 7 days ahead, hourly. No future cliff dips assumed.
      const future = [], band = [];
      if (m && m.tailSpeedUsdPerHour > 0 && pts.length) {
        const R = c.flatRate, D = c.decayScale, t0 = m.atMs, T0 = m.tailProgressUsd, at = (pace, h) => cost(R * (D / (D + T0 + pace * h)) ** 2);
        for (let h = 0; h <= 7 * 24; h++) {
          future.push([t0 + h * 3_600_000, at(m.tailSpeedUsdPerHour, h)]);
          if (m.pace) band.push([t0 + h * 3_600_000, at(m.pace.low, h), at(m.pace.high, h)]);
        }
      }
      // Short caption; the assumptions go to the tooltip.
      const notes = [];
      if (rebuilt.length) notes.push(`before ${hourLabel(rebuilt[rebuilt.length - 1][0] + mk.intervalMs)}: rebuilt from the hourly PAPER supply`);
      const dips = (m && m.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
      let showCost = null;
      showCost = timeChart(fig("mintcost"), pts, (v) => unit(v), (t) => showCost && showCost(t), { bands: dips, quiet: true, markNow: true, future, futureBand: band });
      if (future.length) notes.push(`next 7 days: dashed line at the recent 6 h pace of losses (${usd(m.tailSpeedUsdPerHour)}/h)${m.pace ? `, band ${usd(m.pace.low)}–${usd(m.pace.high)}/h` : ""}`);
      fig("mintcost").title = notes.join(" · ");
    }
    // Realized losses over time: observed tail progress (summary samples; before them rebuilt from the hourly PAPER
    // supply as above) and the model every projection on this page uses — linear at the recent 6 h pace, with the band
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
        for (let h = 0; h <= 7 * 24; h++) {
          future.push([t0 + h * 3_600_000, T0 + m.tailSpeedUsdPerHour * h]);
          if (m.pace) band.push([t0 + h * 3_600_000, T0 + m.pace.low * h, T0 + m.pace.high * h]);
        }
      }
      let showLoss = null;
      showLoss = timeChart(fig("tailloss"), pts, usd, (t) => showLoss && showLoss(t), { quiet: true, markNow: true, future, futureBand: band,
        hlines: [{ y: c.decayScale * (Math.SQRT2 - 1), label: "½ rate" }, { y: c.decayScale, label: "¼ rate" }] });
      fig("tailloss").title = `tail progress: the losses the mint curve has counted, each losing close at its mint basis, not netted against wins and not counted while the pool is under the cliff; not the traders' net pnl. Before the samples: rebuilt from supply.${m && m.pace ? ` Projection if the pace holds: dashed at the recent 6 h pace (${usd(m.pace.mid)}/h), band from the slowest to the fastest of the recent 3 h / 6 h / 24 h (${usd(m.pace.low)}–${usd(m.pace.high)}/h); no future cliff dips assumed.` : ""}`;
    }
    // Staking APR at every complete hour: the 24 h ending there (protocol.series.apr, the indexer's trailing-window
    // definition), from its first value. In the first 24 h after PAPER began the window is shorter, so values are extreme.
    {
      const s = d.protocol && d.protocol.series, asOf = d.protocol && d.protocol.asOfMs;
      const pts = [];
      if (s && s.apr) s.apr.forEach((v, i) => {
        const end = s.startMs + (i + 1) * s.intervalMs; // each hourly value is the reading at the hour's end
        if (end >= HISTORY_START && v != null && Number.isFinite(v) && !(asOf && end > asOf)) pts.push([end, v]);
      });
      // No projection: rewards come mostly in lumps when the pool is at the staker cap and traders lose, which depends on
      // the traders' pnl and cannot be estimated.
      let showApr = null;
      showApr = timeChart(fig("apr"), pts, (v) => pct(v, 0), (t) => showApr && showApr(t), { quiet: true, markNow: true, log: true });
      fig("apr").title = "USDC paid to stakers over the trailing 24 h per staked PAPER, annualized, ÷ the all-time average cost per PAPER at that hour; from the hourly protocol history, from the first hour with PAPER (the window is shorter than 24 h in the first day). No projection: rewards come in lumps when the pool is at the staker cap and traders lose, which cannot be estimated. Log axis";
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
    if (nextHalf > D * (Math.SQRT2 - 1) * 1.05) tailMarks.push({ x: nextHalf, label: "next ½" });
    // Time axis for the two projections: tailProgress grows at the current tail speed; 30 days ahead or until the tail
    // would be exhausted, whichever is sooner. Day ticks at local midnight. Without a speed, fall back to the loss axis.
    // Time axis for the two projections: tailProgress grows at the central pace (pAt) or the slowest / fastest pace
    // (pLow / pHigh, the band); 7 days ahead or until the tail would be exhausted. Without a pace, the loss axis is used.
    let axis = null;
    if (byTime) {
      const lam = m.tailSpeedUsdPerHour, t0 = m.atMs, hoursToEnd = (tailEnd - c.tailProgress) / lam;
      const t1 = t0 + Math.min(7 * 24, hoursToEnd) * 3_600_000;
      const lo = m.pace ? m.pace.low : lam, hi = m.pace ? m.pace.high : lam;
      const at = (pace) => (ms) => c.tailProgress + ((ms - t0) / 3_600_000) * pace;
      axis = { t0, t1, pAt: at(lam), pLow: at(lo), pHigh: at(hi) };
    }
    // Time axis: the past and the projection on one line, like the cost chart above. Before the samples the tail progress
    // is rebuilt from the hourly PAPER supply (T = E·D/(flat·D − E)); the projection runs hourly at the central pace with
    // the slow–fast band, to axis.t1 (7 days, like the cost and realized-loss charts, so the four time charts share one axis).
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
      for (let t = axis.t0; t <= axis.t1; t += 3_600_000) {
        future.push([t, f(axis.pAt(t))]);
        if (m.pace) band.push([t, f(axis.pLow(t)), f(axis.pHigh(t))]);
      }
      return { future, futureBand: band };
    };
    const dipBands = (m && m.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
    if (axis) {
      // The sampled rate already includes the cliff dips (flat rate while the pool is under the cliff).
      const ms = m.series, sampled = ms && ms.ratePerUsd ? ms.ratePerUsd.map((r, i) => [ms.startMs + i * ms.intervalMs, r]).filter(([, r]) => r != null) : [];
      const past = [...tailRebuilt(sampled.length ? sampled[0][0] : Infinity).map(([at, T]) => [at, tailRate(T)]), ...sampled];
      let showRate = null;
      showRate = timeChart(fig("minttail"), past, (v) => `${v.toFixed(1)}/$`, (t) => showRate && showRate(t), { quiet: true, markNow: true, bands: dipBands, ...projection(tailRate),
        hlines: [{ y: tailRate(c.tailProgress) / 2, label: "next ½" }, { y: c.flatRate / 4, label: "¼ rate" }] });
    } else {
      curveChart(fig("minttail"), { x0: 0, x1: tailEnd, y0: 0, y1: c.flatRate * 1.08, f: tailRate, ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usd, xLabel: "counted", xTicks: lossTicks(tailEnd),
        markers: tailMarks, now: c.tailProgress });
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
      showSupply = timeChart(fig("supply"), past, (v) => `${(v / 1e9).toFixed(2)}B`, (t) => showSupply && showSupply(t), { quiet: true, markNow: true, ...projection((p) => base + minted(p)),
        hlines: [{ y: limit, label: `max ${(limit / 1e9).toFixed(2)}B` }] });
    } else {
      curveChart(fig("supply"), { x0: 0, x1: tailEnd, y0: 0, y1: limit * 1.06, f: (p) => base + minted(p), ticksY: [limit, limit / 2, 0], fmtY: (v) => `${(v / 1e9).toFixed(2)}B`, fmtX: usd, xLabel: "counted",
        asymptote: limit, asymptoteLabel: `max ${(limit / 1e9).toFixed(2)}B`, xTicks: lossTicks(tailEnd), now: c.tailProgress });
    }
    // Inflation: supply growth over the 24 h ending at each complete hour, S(t) ÷ S(t − 24 h) − 1, from the hourly PAPER
    // supply (each value is the hour's end). Next 7 days: the same ratio with the model's supply growth (counted losses
    // at the 6 h pace, band 3 h–24 h), continuous with the observed figure (see below). Log axis: right after launch the
    // supply 24 h earlier is tiny, so the first values are extreme.
    {
      const mk = d.protocol && d.protocol.market, asOf = d.protocol && d.protocol.asOfMs, hist = new Map();
      if (mk && mk.paperSupply) mk.paperSupply.forEach((v, i) => { const end = mk.startMs + (i + 1) * mk.intervalMs; if (!(asOf && end > asOf) && Number.isFinite(v)) hist.set(end, v); });
      const times = [...hist.keys()].sort((a, b) => a - b), DAY = 86_400_000, pts = [];
      for (const t of times) { const prev = hist.get(t - DAY); if (t >= HISTORY_START && prev > 0) pts.push([t, hist.get(t) / prev - 1]); }
      const future = [], futureBand = [];
      if (pts.length && m && m.pace) {
        // For comparison (temporary): the model alone over the whole range, past and future, drawn over the observed line.
        // Model supply S(t) = base + minted(T(t)) with T(t) = T_now + pace·(t − now), run backward as well as forward;
        // inflation = S(t) ÷ S(t − 24 h) − 1 on that model supply only. Central line at the 6 h pace, band 3 h–24 h.
        const tStart = pts[0][0], t1 = pts[pts.length - 1][0] + 7 * DAY;
        const model = (pace) => (t) => base + minted(c.tailProgress + (pace * (t - m.atMs)) / 3_600_000);
        const ratio = (pace, t) => { const M = model(pace), den = M(t - DAY); return den > 0 ? M(t) / den - 1 : null; };
        for (let t = tStart; t <= t1; t += 3_600_000) {
          future.push([t, ratio(m.pace.mid, t)]);
          futureBand.push([t, ratio(m.pace.low, t), ratio(m.pace.high, t)]);
        }
      }
      let showInf = null;
      showInf = timeChart(fig("inflation"), pts, (v) => pct(v, v < 0.1 ? 1 : 0), (t) => showInf && showInf(t), { quiet: true, markNow: true, future, futureBand, log: true });
      fig("inflation").title = "PAPER supply growth over the trailing 24 h at each complete hour (official hourly history). Next 7 days: the same 24 h ratio with the model's supply growth (counted losses at the recent 6 h pace, band 3 h–24 h), starting from the observed figure; the last 24 h's increase is taken as spread evenly while it leaves the window. No future cliff dips assumed. Log axis";
    }
  }

  // ------------------------------------------------------------------------------------------ wiring
  // Pace of the counted losses (tail progress per hour) for every projection on the page, from the sampled tail
  // progress: the recent 6 h as the central case, the recent 3 h and 24 h as the other two; the band runs from the
  // slowest to the fastest of the three. The indexer's tailSpeedUsdPerHour is the average since sampling began, which
  // the launch hours inflate, so the page replaces it with the central case.
  function withPace(m) {
    const s = m && m.series;
    if (!s || !s.tailProgressUsd) return m;
    const pts = s.tailProgressUsd.map((v, i) => [s.startMs + i * s.intervalMs, v]).filter(([, v]) => v != null && Number.isFinite(v));
    if (pts.length < 2) return m;
    const last = pts[pts.length - 1];
    const over = (hours) => {
      const from = pts.find(([t]) => t >= last[0] - hours * 3_600_000) || pts[0];
      const h = (last[0] - from[0]) / 3_600_000;
      return h > 0 ? (last[1] - from[1]) / h : null;
    };
    const mid = over(6), r3 = over(3), r24 = over(24);
    const all = [mid, r3, r24].filter((v) => v != null && v > 0);
    if (mid == null || !(mid > 0) || !all.length) return m;
    return { ...m, tailSpeedUsdPerHour: mid, pace: { mid, low: Math.min(...all), high: Math.max(...all), recent3h: r3, recent24h: r24 } };
  }

  function render(d) {
    if (!d) return;
    const dd = { ...d, mint: withPace(d.mint) };
    renderNow(dd);
    renderActivity(dd);
    renderRules(dd);
  }
  document.addEventListener("click", (e) => {
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
  window.paperboardsStats = { render, timeChart, linearProjection, HISTORY_START };
})();
