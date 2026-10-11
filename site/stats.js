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
  // Estimated date a cumulative-realized-loss level is reached, at the current tail speed (null when behind us or unknown).
  const etaAt = (m, p) => (m && m.tailSpeedUsdPerHour > 0 && p > m.tailProgressUsd ? new Date(m.atMs + ((p - m.tailProgressUsd) / m.tailSpeedUsdPerHour) * 3_600_000) : null);
  const fmtEta = (t) => (t ? t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : null);

  function renderNow(d) {
    const c = d.curve, m = d.mint, cc = d.crossCheck || {};
    const big = (s) => BigInt(s ?? "0");
    const balances = Number(d.rows.reduce((s, r) => s + big(r.balance18), 0n) / 10n ** 12n) / 1e6;
    const max = maxSupply(c), users = cc.apiUniqueAccounts || d.totals.depositors;
    // Valuation at what one PAPER costs to mint today (hedged ±target, the Rules chart's figure) × max supply.
    const cost = m && typeof m.hedgedMintCostUsd === "number" ? m.hedgedMintCostUsd : null;
    $("now").innerHTML = [
      kpi("user balances", usd(balances), `sum of every depositor's account value (${count(users)} users); not TVL`),
      kpi("max supply ≈", paper(max), "if lp never dips below the cliff"),
      kpi("valuation", max != null && cost != null ? usd(cost * max) : "–", cost != null ? `cost to mint now, hedged ±${m.hedgedCostTargetBps ?? 15} bps (${unit(cost)}) × max supply` : ""),
    ].join("");
  }


  // ------------------------------------------------------------------------------------------ Activity
  // Granularity of the Activity charts: hourly bars, or one bar per local day. Headline figures cover the latest bucket.
  const PERIODS = [["1h", "1H", 1], ["1d", "1D", 24]];
  // X axis of the two tail projections in Rules: estimated date (at the current tail speed) or cumulative realized loss.
  let tailAxis = "time";
  try { const v = localStorage.getItem("paperboards.tailAxis"); if (v === "time" || v === "loss") tailAxis = v; } catch { /* storage unavailable */ }
  let period = "1d";
  try { const v = localStorage.getItem("paperboards.period"); if (PERIODS.some(([k]) => k === v)) period = v; } catch { /* storage unavailable */ }

  function renderActivity(d) {
    const p = d.protocol || {}, f = p.flows && p.flows[period], a = p.periods && p.periods[period], m = p.market;
    const [, name, hours] = PERIODS.find(([k]) => k === period);
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
      // Skip the empty hours before the protocol had any value locked.
      let from = m.tvl.findIndex((v) => v > 0); if (from < 0) from = 0;
      t0 = t(from);
      const raw = (arr) => arr.slice(from).map((v, i) => [t(from + i), v]);
      pts = (arr) => bucket(raw(arr), false);
      flow = (arr) => bucket(raw(arr), true);
    }
    const per = daily ? "d" : "h";
    const timeLabel = daily ? (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : hourLabel;
    const ms = d.mint && d.mint.series;
    const mintPts = ms && ms.ratePerUsd ? ms.ratePerUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]).filter(([x]) => x >= t0) : [];
    // The pool: tracked LP (the lp balance the mint curve looks at), from the same summary samples; the cliff is the mint-decay threshold.
    const lpPts = ms && ms.trackedLpUsd ? ms.trackedLpUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]).filter(([x]) => x >= t0) : [];
    const dips = (d.mint && d.mint.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
    const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const oi = d.openInterest;
    const oiPts = oi ? bucket(oi.times.map((x, i) => [x, oi.total[i]]).filter(([x]) => x >= t0), false) : null;
    // [label, value, title, chart points, formatter, bars, bands]
    // One row per quantity; figures derived from the same numbers share its row instead of repeating it.
    const apr = a && a.apr != null ? `apr ${pct(a.apr, 0)}` : null;
    const cost = a && a.costPerPaper != null ? `${unit(a.costPerPaper)}/paper` : null;
    const growth = f ? `+${paper(f.paperMinted)}${a && a.inflation != null ? ` (+${pct(a.inflation, a.inflation < 0.01 ? 2 : 1)})` : ""}` : null;
    const peak = (arr, fmt) => { const v = arr ? arr.map(([, x]) => x).filter((x) => x != null && Number.isFinite(x)) : []; return v.length ? `peak ${fmt(Math.max(...v))}` : null; };
    // [label, value, sub-value, title, chart points, formatter, bars, bands]
    const rows = [
      ["volume", f ? usd(f.volume) : "–", m && peak(flow(m.volumePerInterval), usd), `total traded in the latest ${daily ? "24 h" : "hour"}; bars = per ${daily ? "day" : "hour"}`, m && flow(m.volumePerInterval), usd, true],
      ["trader pnl", f ? signedUsd(f.pnlChange) : "–", cost, `change in cumulative trader pnl in the latest ${daily ? "24 h" : "hour"} (negative = traders lost) and the net loss per PAPER minted; bars = per ${daily ? "day" : "hour"}`, m && flow(m.pnlPerInterval), signedUsd, true],
      ["staker rewards", f ? usd(f.rewards) : "–", apr, `USDC paid to stakers in the latest ${daily ? "24 h" : "hour"}; apr = per staked PAPER, annualized, ÷ all-time average cost per PAPER; bars = per ${daily ? "day" : "hour"}`, m && flow(m.rewardsPerInterval), usd, true],
      ["tvl", d.crossCheck && d.crossCheck.apiTvl18 ? usd(Number(BigInt(d.crossCheck.apiTvl18) / 10n ** 12n) / 1e6) : usd(m && last(m.tvl)), m && m.tvl.length > 1 ? (() => { const b = pts(m.tvl); return b.length > 1 ? `${signedUsd(b[b.length - 1][1] - b[b.length - 2][1])}` : null; })() : null, "official protocol treasury value", m && pts(m.tvl), usd],
      ["users", count((d.crossCheck && d.crossCheck.apiUniqueAccounts) || (m && last(m.users))), f ? `+${count(f.newUsers)}` : null, "accounts now and added over the period", m && pts(m.users), count],
      ...(oi ? [["open interest", usd(last(oi.total)), `btc ${usd(last(oi.btcLong) + last(oi.btcShort))} · eth ${usd(last(oi.ethLong) + last(oi.ethShort))}`, "entry notional of open positions, long + short (official house history)", oiPts, usd]] : []),
    ];
    // Same figures as Rules: a headline (name, value, note) above a full chart; hover shows the cursor label on every chart.
    box.className = "charts charts-2";
    box.innerHTML = rows.map(([label, value, sub, title, points], i) => `<figure class="chart act" data-i="${i}"${title ? ` title="${esc(title)}"` : ""}>
      <figcaption><span>${esc(label)}</span><b class="cv"></b></figcaption>
      <div class="aval"><b>${esc(value)}</b><em>${esc(sub || "")}</em></div>
      ${points ? `<svg role="img" aria-label="${esc(label)} history"></svg>` : ""}
    </figure>`).join("");
    const base = `hourly · ${hours == null ? "since genesis" : hours < 24 ? "last 24 h" : `last ${hours >= 168 ? `${hours / 24} days` : `${hours} h`}`} · hover a chart to read every row at that time`;
    $("activityhint").textContent = base;
    const draws = [];
    const hover = (msAt) => { draws.forEach((g) => g(msAt)); $("activityhint").textContent = msAt == null ? base : hourLabel(msAt); };
    rows.forEach(([, , , , points, fmt, bars, bands], i) => {
      if (!points) return;
      draws.push(timeChart(box.querySelector(`.chart[data-i="${i}"]`), points, fmt, hover, { bars, bands, timeLabel }));
    });
  }

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
    if (past.length < 2) { cv.textContent = past.length ? fmt(past[0][1]) : "–"; svg.innerHTML = ""; return () => {}; }
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
    const ticks = opts.compact ? [] : [hi - pad, (lo + hi - pad) / 2, lo < 0 ? lo + pad : 0];
    // Full charts take the figure's width and the curve charts' height, so every chart on the page lines up.
    const W = opts.compact ? Math.max(120, fig.querySelector("svg").clientWidth || fig.clientWidth) : Math.max(220, fig.clientWidth);
    const H = opts.compact ? 40 : 150, L = opts.compact ? 1 : Math.ceil(Math.max(...ticks.map((v) => fmt(v).length)) * 5.6) + 10, R = opts.compact ? 1 : 10, T = opts.compact ? 3 : 8, B = opts.compact ? 3 : 20;
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
      if (future.length) {
        const proj = [past[past.length - 1], ...future].map(([ms, v], i) => `${i ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join("");
        if (fband.length) {
          const top = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`), bot = fband.map(([ms, a, b]) => `${x(ms).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`).reverse();
          const p0 = past[past.length - 1];
          marks += `<polygon class="projband" points="${x(p0[0]).toFixed(1)},${y(p0[1]).toFixed(1)} ${top.join(" ")} ${bot.join(" ")}"/>`;
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
      + (opts.markNow && !opts.compact ? (() => { const p = past[past.length - 1], px = x(p[0]), py = y(p[1]), left = px > W - R - 40; return `<circle class="mark" r="4.5" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}"/><text class="mlabel" x="${(left ? px - 7 : px + 7).toFixed(1)}" y="${(py - 6).toFixed(1)}" text-anchor="${left ? "end" : "start"}">now</text>`; })() : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${opts.compact ? "" : TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const nearest = (ms) => pts.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best), pts[0]);
    const show = (ms) => {
      const p = ms == null ? pts[pts.length - 1] : nearest(ms);
      // Compact sparklines keep the caption readout (the Activity rows share one hover); full charts use the cursor label.
      cv.textContent = opts.compact ? (ms == null ? "" : fmt(p[1])) : "";
      if (ms == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); moveTip(svg, W, 0, 0, null); return; }
      cross.setAttribute("x1", x(p[0])); cross.setAttribute("x2", x(p[0])); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(p[0])); dot.setAttribute("cy", y(p[1])); dot.setAttribute("visibility", opts.bars ? "hidden" : "visible");
      if (!opts.compact) moveTip(svg, W, x(p[0]), y(p[1]), `${fmt(p[1])} · ${(opts.timeLabel || hourLabel)(p[0])}${p[0] > nowMs ? " · projected" : ""}`);
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
    // o.band(v) -> [a, b]: the same curve under the slowest and fastest assumption, shaded between.
    let bandPoly = "";
    if (o.band) {
      const top = [], bot = [];
      for (let i = 0; i <= 120; i++) { const v = o.x0 + ((o.x1 - o.x0) * i) / 120, [a, b] = o.band(v); top.push(`${x(v).toFixed(1)},${y(Math.max(a, b)).toFixed(1)}`); bot.push(`${x(v).toFixed(1)},${y(Math.min(a, b)).toFixed(1)}`); }
      bandPoly = `<polygon class="projband" points="${top.join(" ")} ${bot.reverse().join(" ")}"/>`;
    }
    svg.innerHTML = o.ticksY.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(o.fmtY(t))}</text>`).join("")
      + (o.xTicks && o.xTicks.length ? "" : `<text class="tick" x="${L}" y="${H - 6}">${esc(o.fmtX(o.x0))}</text>`) + `<text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(o.fmtX(o.x1))} ${esc(o.xLabel)}</text>`
      // Secondary x ticks (e.g. estimated dates): a short tick and a label just under the baseline, kept clear of the end labels.
      + (o.xTicks || []).filter((t) => t.x > o.x0 && t.x < o.x1).map((t) => { const tx = x(t.x); return tx < L + 14 || tx > W - R - 96 ? "" : `<line class="grid" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${H - B}" y2="${H - B + 4}"/><text class="tick" x="${tx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(t.label)}</text>`; }).join("")
      + marks.map((m, i) => { const lx = x(m.x), right = lx > W - R - 150; return `<line class="vmark ${m.kind || ""}" x1="${lx}" x2="${lx}" y1="${T}" y2="${H - B}"/><text class="mlabel" x="${right ? lx - 4 : lx + 4}" y="${T + 9 + i * 11}" text-anchor="${right ? "end" : "start"}">${esc(m.label)}</text>`; }).join("")
      + (o.asymptote != null ? `<line class="asym" x1="${L}" x2="${W - R}" y1="${y(o.asymptote)}" y2="${y(o.asymptote)}"/>` : "")
      + (o.asymptote != null && o.asymptoteLabel ? `<text class="mlabel" x="${W - R - 4}" y="${(y(o.asymptote) - 4).toFixed(1)}" text-anchor="end">${esc(o.asymptoteLabel)}</text>` : "")
      + bandPoly + `<path class="line" d="${d}"/>`
      + (o.now != null ? (() => { const px = x(o.now), py = y(o.f(o.now)), left = px > W - R - 40; return `<circle class="mark" r="4.5" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}"/><text class="mlabel" x="${(left ? px - 7 : px + 7).toFixed(1)}" y="${(py - 6).toFixed(1)}" text-anchor="${left ? "end" : "start"}">now</text>`; })() : "")
      + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>${TIP}<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const read = (v) => { const r = o.band && o.band(v); return `${o.fmtY(o.f(v))}${r ? ` (${o.fmtY(Math.min(...r))}–${o.fmtY(Math.max(...r))})` : ""} at ${(o.fmtReadX || o.fmtX)(v)}`; };
    const show = (v) => {
      cv.textContent = "";
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
    if (head && !head.querySelector("#tailaxis")) head.insertAdjacentHTML("beforeend", `<div class="seg" id="tailaxis" role="group" aria-label="Tail curve axis"><button type="button" data-axis="time" title="x = date reached at the current tail speed">Estimated date</button><button type="button" data-axis="loss" title="x = cumulative realized loss">Realized loss</button></div>`);
    const byTime = tailAxis === "time" && !!(d.mint && d.mint.tailSpeedUsdPerHour > 0);
    for (const b of document.querySelectorAll("#tailaxis button")) b.classList.toggle("on", b.dataset.axis === (byTime ? "time" : "loss"));
    const figs = [
      ["pool", "Pool (tracked LP)"],
      ["mintcost", `Cost to mint · hedged ±${(d.mint && d.mint.hedgedCostTargetBps) || 15} bps`],
      ["tailloss", "Realized losses over time"],
      ["minttail", byTime ? "Mint rate by estimated date" : "Mint rate by cumulative realized loss"],
      ["supply", byTime ? "PAPER supply by estimated date" : "PAPER supply by cumulative realized loss"],
    ];
    box.innerHTML = figs.map(([k, t]) => `<figure class="chart" data-curve="${k}"><figcaption><span>${esc(t)}</span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(t)}"></svg></figure>`).join("");
    const fig = (k) => box.querySelector(`[data-curve="${k}"]`);
    // The pool's own history (every summary sample), with the two thresholds the curves below key on.
    {
      const ms = d.mint && d.mint.series, pts = ms && ms.trackedLpUsd ? ms.trackedLpUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]) : [];
      const dips = (d.mint && d.mint.dips || []).map((dp) => [Date.parse(dp.fromAt), dp.toAt ? Date.parse(dp.toAt) : Date.now(), dp]);
      let showPool = null;
      fig("pool").title = `dotted lines: mint-decay threshold ${usd(c.threshold)} (flat 100/$ below it) and staker threshold ${usd(c.stakerCap)} (stakers take 99% at or above it)`;
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
        const first = mk.paperSupply.findIndex((v) => v > 0);
        for (let i = Math.max(0, first - 1); first >= 0 && i < mk.paperSupply.length; i++) {
          const at = mk.startMs + (i + 1) * mk.intervalMs;
          if (at >= sampledFrom) break;
          const E = mk.paperSupply[i] - flat, T = E > 0 ? (E * D) / (R * D - E) : 0;
          rebuilt.push([at, cost(E > 0 ? R * (D / (D + T)) ** 2 : R)]);
        }
      }
      const pts = [...rebuilt, ...sampled];
      // Projection: realized losses keep growing at the recent tail speed (mint.tailSpeedUsdPerHour), so
      // T(t) = T_now + speed·Δt and the rate follows flat·(D/(D+T))² — 7 days ahead, hourly. No future cliff dips assumed.
      const future = [], band = [];
      if (m && m.tailSpeedUsdPerHour > 0 && pts.length) {
        const R = c.flatRate, D = c.decayScale, t0 = m.atMs, T0 = m.tailProgressUsd, at = (pace, h) => cost(R * (D / (D + T0 + pace * h)) ** 2);
        for (let h = 1; h <= 7 * 24; h++) {
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
    // between the slowest and fastest of the recent 3 h, recent 6 h and since-start paces.
    {
      const m = d.mint, ms = m && m.series, mk = d.protocol && d.protocol.market, flat = m && m.flatEmissionPaper;
      const sampled = ms && ms.tailProgressUsd ? ms.tailProgressUsd.map((v, i) => [ms.startMs + i * ms.intervalMs, v]).filter(([, v]) => v != null) : [];
      const rebuilt = [];
      if (mk && mk.paperSupply && flat != null) {
        const from = sampled.length ? sampled[0][0] : Infinity, R = c.flatRate, D = c.decayScale;
        const first = mk.paperSupply.findIndex((v) => v > 0);
        for (let i = Math.max(0, first - 1); first >= 0 && i < mk.paperSupply.length; i++) {
          const at = mk.startMs + (i + 1) * mk.intervalMs;
          if (at >= from) break;
          const E = mk.paperSupply[i] - flat;
          rebuilt.push([at, E > 0 ? (E * D) / (R * D - E) : 0]);
        }
      }
      const pts = [...rebuilt, ...sampled], future = [], band = [];
      if (m && m.tailSpeedUsdPerHour > 0 && pts.length) {
        const t0 = m.atMs, T0 = m.tailProgressUsd;
        for (let h = 1; h <= 7 * 24; h++) {
          future.push([t0 + h * 3_600_000, T0 + m.tailSpeedUsdPerHour * h]);
          if (m.pace) band.push([t0 + h * 3_600_000, T0 + m.pace.low * h, T0 + m.pace.high * h]);
        }
      }
      let showLoss = null;
      showLoss = timeChart(fig("tailloss"), pts, usd, (t) => showLoss && showLoss(t), { quiet: true, markNow: true, future, futureBand: band,
        hlines: [{ y: c.decayScale * (Math.SQRT2 - 1), label: "½ rate" }, { y: c.decayScale, label: "¼ rate" }] });
      if (m && m.pace) fig("tailloss").title = `observed tail progress (before the samples: rebuilt from supply) · model: dashed line at ${usd(m.pace.mid)}/h, band ${usd(m.pace.low)}–${usd(m.pace.high)}/h`;
    }
    const D = c.decayScale, tailEnd = D * (Math.sqrt(c.flatRate) - 1), tailRate = (p) => c.flatRate * (D / (D + p)) ** 2;
    // The hover readout of the two realized-loss curves adds the estimated date of reaching that level at the current
    // tail speed (d.mint.tailSpeedUsdPerHour); levels already passed say so. Markers stay fixed labels without dates.
    const m = d.mint, readRealized = (v) => {
      const e = fmtEta(etaAt(m, v));
      const r = e && m.pace ? ` (${fmtEta(new Date(m.atMs + ((v - m.tailProgressUsd) / m.pace.high) * 3_600_000))} – ${fmtEta(new Date(m.atMs + ((v - m.tailProgressUsd) / m.pace.low) * 3_600_000))})` : "";
      return `${usd(v)}${e ? ` · ~${e}${r}` : v < c.tailProgress ? " · passed" : ""}`;
    };
    // Estimated-date ticks: whole days (local midnight) reached at the current tail speed, thinned to ~6 labels per chart.
    const dateTicks = (x1) => {
      if (!(m && m.tailSpeedUsdPerHour > 0)) return [];
      const perDay = m.tailSpeedUsdPerHour * 24, days = Math.max(1, Math.ceil((x1 - c.tailProgress) / perDay / 8));
      const out = []; const d0 = new Date(m.atMs); d0.setHours(24, 0, 0, 0);
      for (let i = 0; i < 400; i++) { const t = new Date(d0.getTime() + i * days * 86_400_000); const p = c.tailProgress + ((t.getTime() - m.atMs) / 3_600_000) * m.tailSpeedUsdPerHour; if (p >= x1) break; out.push({ x: p, label: t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) }); }
      return out;
    };
    const nextHalf = Math.SQRT2 * (D + c.tailProgress) - D;
    const tailMarks = [{ x: D * (Math.SQRT2 - 1), label: "½" }, { x: D, label: "¼" }];
    if (nextHalf > D * (Math.SQRT2 - 1) * 1.05) tailMarks.push({ x: nextHalf, label: "next ½" });
    // Time axis for the two projections: tailProgress grows at the current tail speed; 30 days ahead or until the tail
    // would be exhausted, whichever is sooner. Day ticks at local midnight. Without a speed, fall back to the loss axis.
    let axis = null;
    if (byTime) {
      const lam = m.tailSpeedUsdPerHour, t0 = m.atMs, hoursToEnd = (tailEnd - c.tailProgress) / lam;
      const t1 = t0 + Math.min(30 * 24, hoursToEnd) * 3_600_000;
      const pAt = (ms) => c.tailProgress + ((ms - t0) / 3_600_000) * lam, atP = (p) => t0 + ((p - c.tailProgress) / lam) * 3_600_000;
      const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const fmtWhen = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
      const spanDays = (t1 - t0) / 86_400_000, step = Math.max(1, Math.ceil(spanDays / 8)), dayTicks = [];
      const d0 = new Date(t0); d0.setHours(24, 0, 0, 0);
      for (let t = d0.getTime(); t < t1; t += step * 86_400_000) dayTicks.push({ x: t, label: fmtDay(t) });
      // The band: the same projection at the slowest and fastest pace (m.pace from withPace). Dates of a level get a range.
      const lo = m.pace ? m.pace.low : lam, hi = m.pace ? m.pace.high : lam;
      const pLow = (ms) => c.tailProgress + ((ms - t0) / 3_600_000) * lo, pHigh = (ms) => c.tailProgress + ((ms - t0) / 3_600_000) * hi;
      const when = (p, pace) => t0 + ((p - c.tailProgress) / pace) * 3_600_000;
      const range = (p) => (m.pace ? ` (${fmtDay(when(p, hi))}–${fmtDay(when(p, lo))})` : "");
      const marks = [];
      if (atP(D) > t0 && atP(D) < t1) marks.push({ x: atP(D), label: "¼" });
      if (atP(nextHalf) > t0 && atP(nextHalf) < t1) marks.push({ x: atP(nextHalf), label: "next ½" });
      axis = { lam, t0, t1, pAt, pLow, pHigh, fmtDay, fmtWhen, dayTicks, marks, readX: (ms) => `${fmtWhen(ms)} (${usd(pAt(ms))} realized)` };
    }
    if (axis) {
      curveChart(fig("minttail"), { x0: axis.t0, x1: axis.t1, y0: 0, y1: c.flatRate * 1.08, f: (ms) => tailRate(axis.pAt(ms)), band: m && m.pace ? (ms) => [tailRate(axis.pLow(ms)), tailRate(axis.pHigh(ms))] : null, ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: axis.fmtDay, fmtReadX: axis.readX,
        xLabel: "", xTicks: axis.dayTicks, markers: axis.marks, now: axis.t0 });
    } else {
      curveChart(fig("minttail"), { x0: 0, x1: tailEnd, y0: 0, y1: c.flatRate * 1.08, f: tailRate, ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usd, fmtReadX: readRealized, xLabel: "realized", xTicks: dateTicks(tailEnd),
        markers: tailMarks, now: c.tailProgress });
    }
    const minted = (p) => (c.flatRate * D * p) / (D + p), base = c.supplyPaper - minted(c.tailProgress), limit = base + c.flatRate * D;
    if (axis) {
      curveChart(fig("supply"), { x0: axis.t0, x1: axis.t1, y0: 0, y1: limit * 1.06, f: (ms) => base + minted(axis.pAt(ms)), band: m && m.pace ? (ms) => [base + minted(axis.pLow(ms)), base + minted(axis.pHigh(ms))] : null, ticksY: [limit, limit / 2, 0], fmtY: (v) => `${(v / 1e9).toFixed(2)}B`, fmtX: axis.fmtDay,
        fmtReadX: axis.readX, xLabel: "", xTicks: axis.dayTicks, asymptote: limit, asymptoteLabel: `max ${(limit / 1e9).toFixed(2)}B`, now: axis.t0 });
    } else {
      curveChart(fig("supply"), { x0: 0, x1: tailEnd, y0: 0, y1: limit * 1.06, f: (p) => base + minted(p), ticksY: [limit, limit / 2, 0], fmtY: (v) => `${(v / 1e9).toFixed(2)}B`, fmtX: usd, xLabel: "realized",
        asymptote: limit, asymptoteLabel: `max ${(limit / 1e9).toFixed(2)}B`, fmtReadX: readRealized, xTicks: dateTicks(tailEnd), now: c.tailProgress });
    }
  }

  // ------------------------------------------------------------------------------------------ wiring
  // Pace of realized losses (tail progress per hour) for every projection on the page, from the sampled tail progress:
  // the recent 6 h as the central case, the recent 3 h and the average since sampling began as the other two; the low
  // and high ends of the band are the smallest and largest of the three. The indexer's tailSpeedUsdPerHour is the
  // since-start average, which the launch hours inflate, so the page replaces it with the central case.
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
    const mid = over(6), r3 = over(3), avg = m.tailSpeedUsdPerHour;
    const all = [mid, r3, avg].filter((v) => v != null && v > 0);
    if (mid == null || !(mid > 0) || !all.length) return m;
    return { ...m, tailSpeedUsdPerHour: mid, pace: { mid, low: Math.min(...all), high: Math.max(...all), recent3h: r3, sinceStart: avg } };
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
  window.paperboardsStats = { render };
})();
