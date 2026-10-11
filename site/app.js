(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const PAGE = 50;
  const state = { data: null, labels: {}, mode: "wallets", sort: "balance", dir: "desc", q: "", page: 0, minPaper: 0n };

  // Entity = display name with a trailing counter removed ("paperstrategy12" -> "paperstrategy").
  // Grouping is by name only; wallets without a name are not attributed to anyone.
  const entityOf = (name) => (name ? name.trim().replace(/[\s_\-#.]*\d+$/, "").toLowerCase() : "") || null;
  // Papertrade name first; a wallet with only a Hyperliquid name is grouped under that.
  // Name priority: Papertrade display name, then a label from labels.json (owner identified
  // from public sources), then the Hyperliquid display name. The others are appended small.
  const labelOf = (r) => r.name || (state.labels[r.address] && state.labels[r.address].name) || r.hlName || null;
  const nameCells = (r) => {
    const label = state.labels[r.address];
    const primary = labelOf(r);
    if (!primary) return "";
    const extras = [];
    if (label && label.name !== primary) extras.push([label.name, label.source || "identified from public sources"]);
    if (r.hlName && r.hlName !== primary) extras.push([r.hlName, "display name on the Hyperliquid leaderboard"]);
    const title = primary === (label && label.name) ? label.source : primary === r.hlName ? "display name on the Hyperliquid leaderboard" : "";
    return `<span class="name" title="${esc(title)}">${esc(primary)}</span>` + extras.map(([n, t]) => `<span class="name hl" title="${esc(t)}">${esc(n)}</span>`).join("");
  };

  const big = (s) => BigInt(s);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // Each comparator sorts descending; direction is applied on top.
  const SORTERS = {
    wallet: (a, b) => cmp(b.address, a.address),
    deposited: (a, b) => cmp(big(b.depositedUsdc), big(a.depositedUsdc)),
    withdrawn: (a, b) => cmp(big(b.withdrawnUsdc), big(a.withdrawnUsdc)),
    balance: (a, b) => cmp(big(b.balance18 ?? "0"), big(a.balance18 ?? "0")),
    rewards: (a, b) => cmp(rewardsTotal(b), rewardsTotal(a)),
    netPnl: (a, b) => cmp(big(b.netPnl18 ?? "0"), big(a.netPnl18 ?? "0")),
    count: (a, b) => b.depositCount - a.depositCount,
    largest: (a, b) => cmp(big(b.largestUsdc), big(a.largestUsdc)),
    paper: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    pnl: (a, b) => cmp(big(b.pnl18 ?? "0"), big(a.pnl18 ?? "0")),
    // Compares -pnl/paper exactly by cross-multiplying (paper is positive whenever cost exists).
    share: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    cost: (a, b) => { const x = costOf(a), y = costOf(b); return x && y ? cmp(y.num * x.den, x.num * y.den) : 0; },
    first: (a, b) => b.firstBlock - a.firstBlock,
    last: (a, b) => b.lastBlock - a.lastBlock,
  };
  // Rows without a value for the sorted column stay at the bottom in both directions.
  const MISSING = {
    paper: (r) => r.paper18 == null,
    pnl: (r) => r.pnl18 == null,
    balance: (r) => r.balance18 == null,
    netPnl: (r) => r.netPnl18 == null,
    cost: (r) => costOf(r) == null,
    share: (r) => r.paper18 == null,
  };

  // Amounts carry 8 decimals (HyperCore USDC scale).
  function usd(s, cents = true) {
    let n = big(s);
    const neg = n < 0n;
    if (neg) n = -n;
    const whole = (n / 100000000n).toLocaleString("en-US");
    const frac = (n % 100000000n).toString().padStart(8, "0").slice(0, 2);
    return `${neg ? "-" : ""}$${whole}${cents ? "." + frac : ""}`;
  }
  const usd18 = (s) => usd((big(s) / 10000000000n).toString(), false);
  function compact(s) {
    const n = Number(big(s) / 100000000n);
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n}`;
  }
  // PAPER carries 18 decimals (official leaderboard paperTotal).
  function paperAmt(s) {
    if (s == null) return "–";
    const n = Number(big(s) / 10n ** 12n) / 1e6;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  }
  // Share of total PAPER supply (protocol history), falling back to the leaderboard total.
  function shareOf(s) {
    if (s == null) return null;
    const p = state.data.protocol;
    if (p && p.paperSupply > 0) return Number(big(s) / 10n ** 12n) / 1e6 / p.paperSupply;
    const total = state.data.crossCheck && state.data.crossCheck.apiTrackedPaper18;
    return total && big(total) > 0n ? Number((big(s) * 1000000n) / big(total)) / 1e6 : null;
  }
  const pct = (x, d = 2) => (x == null ? "–" : `${(x * 100).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
  function shareCell(r) {
    const x = shareOf(r.paper18);
    return `<td class="num ${x == null ? "dim" : ""}" title="share of total PAPER supply">${x == null ? "–" : x < 0.00005 && x > 0 ? "<0.01%" : pct(x)}</td>`;
  }
  // Acquisition cost per PAPER = -(realized + unrealized pnl) / paper; both 18 decimals, so the
  // ratio is in dollars. Negative means the wallet is in profit overall. Null without PAPER.
  function costOf(r) {
    if (r.paper18 == null || r.pnl18 == null || big(r.paper18) <= 0n) return null;
    return { num: -big(r.pnl18), den: big(r.paper18) };
  }
  function costCell(r) {
    const c = costOf(r);
    if (!c) return `<td class="num dim">–</td>`;
    const v = Number((c.num * 100000000n) / c.den) / 1e8;
    const abs = Math.abs(v);
    const s = `${v < 0 ? "-" : ""}$${abs >= 1 ? abs.toFixed(2) : abs.toFixed(4)}`;
    return `<td class="num ${v < 0 ? "pos" : ""}" title="${v < 0 ? "in profit overall: PAPER at no net cost" : "net loss per PAPER held"}">${s}</td>`;
  }
  // Staking rewards (USDC, 18 decimals): claimed (Claimed events) + unclaimed (pendingReward).
  const rewardsTotal = (r) => big(r.rewardsClaimed18 ?? "0") + big(r.rewardsPending18 ?? "0");
  function rewardsCell(r) {
    const v = rewardsTotal(r);
    if (v === 0n) return `<td class="num dim">–</td>`;
    return `<td class="num pos" title="claimed ${usd18(r.rewardsClaimed18 ?? "0")} (${r.claimCount || 0} claim${r.claimCount === 1 ? "" : "s"}) · unclaimed ${usd18(r.rewardsPending18 ?? "0")}">${usd18(v.toString())}</td>`;
  }
  function netPnlCell(r) {
    if (r.netPnl18 == null) return `<td class="num dim">–</td>`;
    const v = big(r.netPnl18) / 10000000000n;
    return `<td class="num ${v < 0n ? "neg" : v > 0n ? "pos" : "dim"}" title="trade pnl ${usd18(r.pnl18 ?? "0")} + rewards ${usd18(rewardsTotal(r).toString())}">${v > 0n ? "+" : ""}${usd(v.toString(), false)}</td>`;
  }
  // PnL carries 18 decimals; shown in whole dollars with sign, realized/unrealized in the tooltip.
  const pnlCell = (r) => {
    if (r.pnl18 == null) return `<td class="num dim">–</td>`;
    const v = big(r.pnl18) / 10000000000n;
    const sign = v > 0n ? "+" : "";
    const tip = r.realizedPnl18 != null ? `realized ${usd18(r.realizedPnl18)} · unrealized ${usd18(r.unrealizedPnl18)}` : "";
    return `<td class="num ${v < 0n ? "neg" : v > 0n ? "pos" : "dim"}" title="${esc(tip)}">${sign}${usd(v.toString(), false)}</td>`;
  };
  // Times are shown in the viewer's local time zone.
  const when = (ts) => (ts == null ? "–" : new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }));
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const txLink = (tx, label) => (tx ? `<a class="tx" href="${state.data.explorer}/tx/${tx}" target="_blank" rel="noopener" title="${tx}">${label}</a>` : label);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Approximate maximum PAPER supply: what exists now plus what the tail curve can still mint,
  // flat * D^2 / (D + tailProgress). Further dips of LP below the cliff (flat-rate minting) are not included.
  function maxSupply(c) {
    if (!c || !(c.decayScale > 0) || !(c.flatRate > 0)) return null;
    return c.supplyPaper + (c.flatRate * c.decayScale * c.decayScale) / (c.decayScale + c.tailProgress);
  }

  const PERIOD_NAMES = { "1h": "1H", "1d": "1D", "7d": "7D", "30d": "30D", all: "all time" };
  let period = "1d";
  try { const v = localStorage.getItem("paperboards.period"); if (v in PERIOD_NAMES) period = v; } catch { /* storage unavailable */ }
  function periodItems(p) {
    const w = p.periods && p.periods[period];
    if (!p.periods) {
      // Older data without per-period figures: the single trailing window.
      return [["inflation", p.inflation == null ? "–" : `+${pct(p.inflation, 1)}`], ["staker rewards", p.rewards == null ? "–" : usdShort(p.rewards)], ["apr", p.apr == null ? "–" : pct(p.apr, 0)],
        ["reward / paper / yr", p.rewardPerPaperYear == null ? "–" : `$${p.rewardPerPaperYear.toFixed(4)}`], ["avg cost / paper · all-time average", p.avgCost == null ? "–" : `$${p.avgCost.toFixed(4)}`]];
    }
    const tag = `${PERIOD_NAMES[period]}${w && w.clamped ? ` (${Math.round(w.hours)}h)` : ""}`;
    const money = (v) => (v == null ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(4)}`);
    return [
      [`inflation · ${tag}`, !w || w.inflation == null ? "–" : `+${pct(w.inflation, w.inflation < 0.01 ? 2 : 1)}`],
      [`staker rewards · ${tag}`, !w || w.rewards == null ? "–" : usdShort(w.rewards)],
      [`apr · ${tag}`, !w || w.apr == null ? "–" : pct(w.apr, 0)],
      [`avg cost / paper · ${tag}`, money(w && w.costPerPaper)],
    ];
  }
  function renderPeriodSwitch() {
    for (const b of document.querySelectorAll("#period button")) b.classList.toggle("on", b.dataset.period === period);
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#period button[data-period]");
    if (!b || !state.data) return;
    period = b.dataset.period;
    try { localStorage.setItem("paperboards.period", period); } catch { /* storage unavailable */ }
    renderPeriodSwitch();
    renderTape(state.data);
  });

  function renderTape(d) {
    const t = d.totals, p = d.protocol;
    renderPeriodSwitch();
    const items = [
      ["users", (d.crossCheck && d.crossCheck.apiUniqueAccounts ? d.crossCheck.apiUniqueAccounts : t.depositors).toLocaleString("en-US")],
      ...(d.crossCheck && d.crossCheck.apiTvl18 ? [["tvl", compact((big(d.crossCheck.apiTvl18) / 10000000000n).toString())]] : []),
      // Sum of every depositor's account value (deposits − withdrawals + pnl + rewards claimed); not TVL.
      ["user balances", compact((d.rows.reduce((s, r) => s + big(r.balance18 ?? "0"), 0n) / 10000000000n).toString())],
      ...(t.rewardsClaimed18 != null ? [["staking rewards", compact(((big(t.rewardsClaimed18) + big(t.rewardsPending18 ?? "0")) / 10000000000n).toString())]] : []),
      ...(p ? [
        ["paper supply", `${(p.paperSupply / 1e6).toFixed(1)}M`],
        ["staked", pct(p.paperStaked / p.paperSupply, 1)],
        // Period metrics follow the Overview switch (1H / 1D / 7D / 30D / All); a period longer than the minted
        // history shows the hours it actually covers.
        ...periodItems(p),
        ...(maxSupply(d.curve) != null ? [
          ["max supply ≈", `${(maxSupply(d.curve) / 1e9).toFixed(2)}B`],
          ["valuation · all-time avg cost × max supply", p.avgCost == null ? "–" : usdShort(p.avgCost * maxSupply(d.curve))],
        ] : []),
      ] : d.crossCheck && d.crossCheck.apiTrackedPaper18 ? [["paper", paperAmt(d.crossCheck.apiTrackedPaper18)]] : []),
    ];
    $("tape").innerHTML = items.map(([k, v]) => `<div class="kpi"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  }

  function entities() {
    const groups = new Map();
    for (const r of state.data.rows) {
      const key = entityOf(labelOf(r));
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { address: key, name: key, wallets: [], depositedUsdc: 0n, withdrawnUsdc: 0n, netUsdc: 0n, depositCount: 0, rewardsClaimed18: 0n, rewardsPending18: 0n, netPnl18: null, claimCount: 0, paper18: null, pnl18: null, realizedPnl18: null, unrealizedPnl18: null, balance18: null, freeBalance18: null, largestUsdc: 0n, firstBlock: Infinity, lastBlock: -Infinity, firstTs: null, lastTs: null, largestTx: null, firstTx: null, lastTx: null };
        groups.set(key, g);
      }
      g.wallets.push(r);
      g.depositedUsdc += big(r.depositedUsdc);
      g.withdrawnUsdc += big(r.withdrawnUsdc);
      g.netUsdc += big(r.netUsdc);
      g.depositCount += r.depositCount;
      g.rewardsClaimed18 += big(r.rewardsClaimed18 ?? "0");
      g.rewardsPending18 += big(r.rewardsPending18 ?? "0");
      if (r.netPnl18 != null) g.netPnl18 = (g.netPnl18 ?? 0n) + big(r.netPnl18);
      g.claimCount += r.claimCount ?? 0;
      if (r.paper18 != null) g.paper18 = (g.paper18 ?? 0n) + big(r.paper18);
      for (const k of ["pnl18", "realizedPnl18", "unrealizedPnl18", "balance18", "freeBalance18"]) if (r[k] != null) g[k] = (g[k] ?? 0n) + big(r[k]);
      if (big(r.largestUsdc) > g.largestUsdc) { g.largestUsdc = big(r.largestUsdc); g.largestTx = r.largestTx; }
      if (r.firstBlock < g.firstBlock) { g.firstBlock = r.firstBlock; g.firstTs = r.firstTs; g.firstTx = r.firstTx; }
      if (r.lastBlock > g.lastBlock) { g.lastBlock = r.lastBlock; g.lastTs = r.lastTs; g.lastTx = r.lastTx; }
    }
    return [...groups.values()].map((g) => ({ ...g, depositedUsdc: g.depositedUsdc.toString(), withdrawnUsdc: g.withdrawnUsdc.toString(), netUsdc: g.netUsdc.toString(), largestUsdc: g.largestUsdc.toString(), paper18: g.paper18 == null ? null : g.paper18.toString(), pnl18: g.pnl18 == null ? null : g.pnl18.toString(), realizedPnl18: g.realizedPnl18 == null ? null : g.realizedPnl18.toString(), unrealizedPnl18: g.unrealizedPnl18 == null ? null : g.unrealizedPnl18.toString(), balance18: g.balance18 == null ? null : g.balance18.toString(), freeBalance18: g.freeBalance18 == null ? null : g.freeBalance18.toString(), rewardsClaimed18: g.rewardsClaimed18.toString(), rewardsPending18: g.rewardsPending18.toString(), netPnl18: g.netPnl18 == null ? null : g.netPnl18.toString() }));
  }

  function matches(r, q) {
    return r.address.includes(q) || (r.name && r.name.toLowerCase().includes(q)) || (r.hlName && r.hlName.toLowerCase().includes(q)) || (state.labels[r.address] && state.labels[r.address].name.toLowerCase().includes(q)) || (r.proxy && r.proxy.includes(q));
  }

  const missingCmp = (a, b) => (MISSING[state.sort] ? MISSING[state.sort](a) - MISSING[state.sort](b) : 0);

  // Minimum PAPER filter; applies to the wallet row, or to the entity's summed PAPER.
  const enough = (r) => state.minPaper === 0n || (r.paper18 != null && big(r.paper18) >= state.minPaper);

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let rows = (state.mode === "entities" ? entities() : state.data.rows).filter(enough);
    if (state.mode === "entities") {
      if (q) rows = rows.filter((g) => g.name.includes(q) || g.wallets.some((r) => r.address.includes(q)));
      const sign = state.dir === "asc" ? -1 : 1;
      return [...rows].sort((a, b) => missingCmp(a, b) || sign * SORTERS[state.sort](a, b) || cmp(a.name, b.name));
    }
    if (q) rows = rows.filter((r) => matches(r, q));
    const sign = state.dir === "asc" ? -1 : 1;
    return [...rows].sort((a, b) => missingCmp(a, b) || sign * SORTERS[state.sort](a, b) || a.firstBlock - b.firstBlock || cmp(a.address, b.address));
  }

  function renderTable() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, (state.page + 1) * PAGE);
    const ex = state.data.explorer;
    $("th-wallet").textContent = state.mode === "entities" ? "entity" : "wallet";
    $("rows").innerHTML = slice.map((r, i) => {
      const rank = state.page * PAGE + i + 1;
      const wd = big(r.withdrawnUsdc) > 0n;
      const who = state.mode === "entities"
        ? `<td class="ent"><a data-entity="${esc(r.name)}" title="show wallets">${esc(r.name)}</a><span class="n">${r.wallets.length} wallet${r.wallets.length === 1 ? "" : "s"}</span><button type="button" class="cardbtn" data-card-entity="${esc(r.name)}" title="share card">card</button></td>`
        : `<td class="addr"><a href="${ex}/address/${r.address}" target="_blank" rel="noopener" title="${r.address}">${short(r.address)}</a>${nameCells(r)}<button type="button" class="cardbtn" data-card-wallet="${r.address}" title="share card">card</button></td>`;
      return `<tr>
        <td class="num rank">${rank}</td>
        ${who}
        <td class="num ${r.balance18 == null ? "dim" : ""}" title="${r.balance18 == null ? "" : `free ${r.freeBalance18 == null ? "–" : usd18(r.freeBalance18)} · in positions ${usd18((big(r.balance18) - big(r.freeBalance18 ?? "0")).toString())} · deposited − withdrawn ${usd(r.netUsdc, false)}`}">${r.balance18 == null ? "–" : usd18(r.balance18)}</td>
        <td class="num ${r.paper18 == null ? "dim" : ""}">${paperAmt(r.paper18)}</td>
        ${shareCell(r)}
        ${pnlCell(r)}
        ${netPnlCell(r)}
        ${costCell(r)}
        ${rewardsCell(r)}
        <td class="num dim">${usd(r.depositedUsdc)}</td>
        <td class="num ${wd ? "neg" : "dim"}">${wd ? usd(r.withdrawnUsdc) : "–"}</td>
        <td class="num">${r.depositCount}</td>
        <td class="num">${txLink(r.largestTx, usd(r.largestUsdc))}</td>
        <td class="num dim">${txLink(r.firstTx, when(r.firstTs))}</td>
        <td class="num dim">${txLink(r.lastTx, when(r.lastTs))}</td>
      </tr>`;
    }).join("");
    $("empty").hidden = rows.length > 0;
    $("pageinfo").textContent = `${state.page + 1} / ${pages}`;
    $("prev").disabled = state.page === 0;
    $("next").disabled = state.page >= pages - 1;
  }

  // History: one single-series line chart per metric, sharing a crosshair (hover any chart).
  const CHARTS = [
    { key: "apr", title: "APR (protocol-wide)", fmt: (v) => pct(v, 0) },
    { key: "avgCost", title: "Cost per PAPER (all traders)", fmt: (v) => `$${v.toFixed(4)}` },
    { key: "supply", title: "PAPER supply", fmt: (v) => `${(v / 1e6).toFixed(1)}M` },
    { key: "stakedPct", title: "Staked share of supply", fmt: (v) => pct(v, 1) },
    { key: "inflationPerInterval", title: "Inflation per hour", fmt: (v) => `+${pct(v, 2)}` },
    { key: "rewardsPerInterval", title: "Staker rewards per hour", fmt: (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(0)}K`) },
  ];
  const hourLabel = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  function renderHistory(d) {
    const s = d.protocol && d.protocol.series;
    const box = $("charts");
    if (!s || s.supply.length < 2) { box.innerHTML = `<p class="empty">not enough history yet</p>`; return; }
    const n = s.supply.length;
    const timeAt = (i) => s.startMs + i * s.intervalMs;
    box.innerHTML = CHARTS.map((c) => `<figure class="chart" data-key="${c.key}">
      <figcaption><span>${esc(c.title)}</span><b class="cv"></b></figcaption>
      <svg role="img" aria-label="${esc(c.title)} by hour"></svg>
    </figure>`).join("");
    const draws = [];
    for (const fig of box.querySelectorAll(".chart")) {
      const c = CHARTS.find((x) => x.key === fig.dataset.key);
      const vals = s[c.key];
      const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv");
      const nums = vals.filter((v) => v != null && Number.isFinite(v));
      if (!nums.length) { cv.textContent = "–"; continue; }
      let lo = Math.min(...nums), hi = Math.max(...nums);
      if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      // Left gutter fits the widest tick label (~5.6px per char at 9.5px).
      const tickText = [lo + pad, (lo + hi) / 2, hi - pad].map((t) => c.fmt(t));
      const W = Math.max(200, fig.clientWidth), H = 132, L = Math.ceil(Math.max(...tickText.map((t) => t.length)) * 5.6) + 10, R = 10, T = 8, B = 20;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R));
      const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      let path = "", pen = false;
      vals.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) { pen = false; return; }
        path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
      svg.innerHTML = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(c.fmt(t))}</text>`).join("")
        + `<text class="tick" x="${L}" y="${H - 5}">${esc(hourLabel(timeAt(0)))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(hourLabel(timeAt(n - 1)))}</text>`
        + `<path class="line" d="${path}"/>`
        + `<line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>`
        + `<rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
      const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
      const show = (i) => {
        const at = i == null ? n - 1 : i;
        const v = vals[at];
        cv.textContent = v == null || !Number.isFinite(v) ? "–" : c.fmt(v);
        if (i == null || v == null || !Number.isFinite(v)) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible");
      };
      draws.push(show);
      const hit = svg.querySelector(".hit");
      hit.addEventListener("mousemove", (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
        draws.forEach((f) => f(i));
        $("histhint").textContent = hourLabel(timeAt(i));
      });
      hit.addEventListener("mouseleave", () => { draws.forEach((f) => f(null)); $("histhint").textContent = "hourly · hover a chart to read every metric at that hour"; });
      show(null);
    }
  }
  // Mint rate: the docs curve r = flat·(D/(D+P))² on the latest /query/protocol/summary sample (data/summary.jsonl via
  // src/summary-recorder.ts), with the binned samples as the curve's only history.
  function renderMint(d) {
    const m = d.mint, kp = $("mintkpis"), box = $("mintcharts");
    if (!m || typeof m.ratePerUsd !== "number") { kp.innerHTML = `<div class="kpi"><span>mint rate</span><b>–</b></div>`; box.innerHTML = ""; $("minthint").textContent = "no summary samples yet"; return; }
    const M = (v) => `$${(v / 1e6).toFixed(1)}M`, B = (v) => `${(v / 1e9).toFixed(2)}B`;
    const hrs = (h) => (h == null || !Number.isFinite(h) ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
    // D (the curve's decay constant) from the closed-form pieces: remaining / tailEmission = D / T.
    const T = m.tailProgressUsd, D = T > 0 && m.tailEmissionPaper > 0 ? T * m.remainingTailPaper / m.tailEmissionPaper : 120e6;
    const s = m.series, rates = s ? s.ratePerUsd : [], n = rates.length;
    const speed = m.tailSpeedUsdPerHour, nextHalf = Math.SQRT2 * (D + T) - D;
    const hoursToNextHalf = speed > 0 ? (nextHalf - T) / speed : null;
    const items = [
      ["rate", `${m.ratePerUsd.toFixed(1)} / $`],
      ...(typeof m.mintCostUsd === "number" ? [["cost to mint now · no hedge", `$${m.mintCostUsd.toFixed(4)}`]] : []),
      ...(typeof m.hedgedMintCostUsd === "number" ? [[`cost to mint now · hedged ±${m.hedgedCostTargetBps} bps`, `$${m.hedgedMintCostUsd.toFixed(4)}`]] : []),
      // The rate halves again once realized losses reach √2·(D + T) − D; time at the recent pace of losses.
      ["rate halves again at", `${M(nextHalf)} realized · ${hrs(hoursToNextHalf)}`],
      ["payout queue", m.queueUsd > 0 ? M(m.queueUsd) : "empty"],
    ];
    kp.innerHTML = items.map(([k, v]) => `<div class="kpi"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    $("minthint").textContent = `paper per $ of realized loss · as of ${hourLabel(m.atMs)} · ${m.samples ?? 0} samples · shaded = cliff dip (lp below ${M(m.cliffUsd)}, flat ${m.flatRate}/$) · ${m.dips && m.dips.length ? `${m.dips.length} seen` : "none seen yet"}`;
    box.innerHTML = `<figure class="chart"><figcaption><span>Mint rate (10-minute bins)</span><b id="mint-cv"></b></figcaption><svg role="img" aria-label="mint rate over time"></svg></figure>`;
    const figs = box.querySelectorAll(".chart"), H = 132, TOP = 8, BOT = 20, R = 10, L = 34;
    // Chart 1: rate by bin, gaps where nothing was sampled.
    {
      const fig = figs[0], svg = fig.querySelector("svg"), cv = $("mint-cv");
      const nums = rates.filter((v) => v != null);
      if (s && nums.length >= 2) {
        const W = Math.max(200, fig.clientWidth), timeAt = (i) => s.startMs + i * s.intervalMs;
        let lo = Math.min(...nums), hi = Math.max(...nums); if (lo === hi) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
        const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R)), y = (v) => TOP + (1 - (v - lo) / (hi - lo)) * (H - TOP - BOT);
        let path = "", pen = false;
        rates.forEach((v, i) => { if (v == null) { pen = false; return; } path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
        const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
        svg.innerHTML = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${t.toFixed(0)}</text>`).join("")
          + `<text class="tick" x="${L}" y="${H - 5}">${esc(hourLabel(timeAt(0)))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(hourLabel(timeAt(n - 1)))}</text>`
          // Cliff dips: tracked LP below the cliff, the curve back at the flat rate. Shaded so they read at a glance.
          + (m.dips || []).map((dp) => {
            const i0 = (Date.parse(dp.fromAt) - s.startMs) / s.intervalMs, i1 = dp.toAt ? (Date.parse(dp.toAt) - s.startMs) / s.intervalMs : n - 1;
            const x0 = x(Math.max(0, i0)), x1 = Math.max(x0 + 3, x(Math.min(n - 1, i1)));
            return `<rect class="dipband" x="${x0.toFixed(1)}" y="${TOP}" width="${(x1 - x0).toFixed(1)}" height="${H - TOP - BOT}"><title>${esc(`cliff dip ${hourLabel(Date.parse(dp.fromAt))} → ${dp.toAt ? hourLabel(Date.parse(dp.toAt)) : "now"} · lp down to ${M(dp.minLpUsd)} (${M(dp.depthUsd)} below the cliff)`)}</title></rect>`;
          }).join("")
          + `<path class="line" d="${path}"/><line class="cross" y1="${TOP}" y2="${H - BOT}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/><rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
        const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
        const show = (i) => { const at = i == null ? n - 1 : i, v = rates[at];
          cv.textContent = v == null ? "–" : i == null ? v.toFixed(1) : `${v.toFixed(1)} · ${hourLabel(timeAt(i))}`;
          if (i == null || v == null) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
          cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible"); dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible"); };
        hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; show(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))))); });
        hit.addEventListener("mouseleave", () => show(null));
        show(null);
      } else { cv.textContent = `${m.ratePerUsd.toFixed(1)} · not enough samples for a chart`; }
    }
  }

  // Curves: the rules that turn LP balance and realized losses into PAPER and staker revenue,
  // drawn over their whole range from /query/protocol/summary (definitions as in the official
  // frontend's reward-curve chart and reward-rate tiers; src/depositors/protocol.ts).
  const curveRate = (lp, c) => {
    if (lp < c.threshold) return c.flatRate;
    if (c.decayScale <= 0) return 0;
    const r = c.decayScale / (c.decayScale + c.tailProgress + Math.max(0, lp - Math.max(c.trackedLp, c.threshold)));
    return c.flatRate * r * r;
  };
  const stakerShare = (lp, c) => (lp < 0 ? 0 : c.stakerCap > 0 && lp >= c.stakerCap ? 99 : 1);
  const usdShort = (v) => { const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M` : `${s}$${(a / 1e3).toFixed(0)}K`; };

  // One curve chart: f sampled over [x0, x1], vertical markers, a current-point dot, and a hover readout.
  function curveChart(fig, o) {
    const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv");
    const W = Math.max(220, fig.clientWidth), H = 150, T = 10, B = 22, R = 12;
    const ticksY = o.ticksY, L = Math.ceil(Math.max(...ticksY.map((t) => o.fmtY(t).length)) * 5.6) + 10;
    const x = (v) => L + ((v - o.x0) / (o.x1 - o.x0)) * (W - L - R), y = (v) => T + (1 - (v - o.y0) / (o.y1 - o.y0)) * (H - T - B);
    const N = 360, pts = [];
    for (let i = 0; i <= N; i++) { const v = o.x0 + ((o.x1 - o.x0) * i) / N; pts.push([v, o.f(v)]); }
    let d = "";
    pts.forEach(([v, w], i) => {
      if (o.step && i) d += `H${x(v).toFixed(1)}V${y(w).toFixed(1)}`;
      else d += `${i ? "L" : "M"}${x(v).toFixed(1)},${y(w).toFixed(1)}`;
    });
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const marks = (o.markers || []).filter((m) => m.x >= o.x0 && m.x <= o.x1);
    svg.innerHTML = ticksY.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(o.fmtY(t))}</text>`).join("")
      + `<text class="tick" x="${L}" y="${H - 6}">${esc(o.fmtX(o.x0))}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(o.fmtX(o.x1))} ${esc(o.xLabel)}</text>`
      // Labels step down one row per marker so neighbours never overlap; a label near the right edge flips left.
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

  function renderCurves(d) {
    const c = d.curve, box = $("curves");
    if (!c || !(c.flatRate > 0) || !(c.decayScale > 0)) { box.innerHTML = `<p class="empty">curve inputs unavailable</p>`; return; }
    const figs = [
      ["mintlp", "Mint rate by LP balance (paper per $1 of realized loss)"],
      ["share", "Staker share of realized losses by LP balance"],
      ["minttail", "Mint rate by cumulative realized loss (tail progress)"],
      ["supply", "PAPER supply by cumulative realized loss"],
    ];
    box.innerHTML = figs.map(([k, t]) => `<figure class="chart" data-curve="${k}"><figcaption><span>${esc(t)}</span><b class="cv"></b></figcaption><svg role="img" aria-label="${esc(t)}"></svg></figure>`).join("");
    const fig = (k) => box.querySelector(`[data-curve="${k}"]`);
    // LP-balance domain exactly as the official chart: at least $12M, 4x the cliff and 2x the cap, a little below zero.
    let lp1 = Math.max(12e6, c.threshold * 4, c.stakerCap * 2);
    if (c.currentLp > lp1 * 0.9) lp1 = c.currentLp * 1.15;
    const lp0 = -Math.max(lp1 * 0.1, -c.currentLp * 1.4);
    const lpMarks = [
      { x: c.threshold, label: `mint decay ${usdShort(c.threshold)}`, kind: "warn" },
      { x: c.stakerCap, label: `staker threshold ${usdShort(c.stakerCap)}`, kind: "pos" },
    ];
    const rateTicks = [c.flatRate, c.flatRate / 2, c.flatRate / 4, 0];
    curveChart(fig("mintlp"), { x0: lp0, x1: lp1, y0: 0, y1: c.flatRate * 1.08, f: (v) => curveRate(v, c), ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usdShort, xLabel: "lp", markers: lpMarks, now: c.currentLp });
    curveChart(fig("share"), { x0: lp0, x1: lp1, y0: 0, y1: 105, f: (v) => stakerShare(v, c), step: true, ticksY: [99, 50, 1], fmtY: (v) => `${Math.round(v)}%`, fmtX: usdShort, xLabel: "lp", markers: lpMarks, now: c.currentLp });
    // Tail curve over its whole useful range: until the rate falls to 1 PAPER/$ (progress = 9 D at flat 100).
    const Dd = c.decayScale, tailEnd = Dd * (Math.sqrt(c.flatRate) - 1), tailRate = (p) => c.flatRate * (Dd / (Dd + p)) ** 2;
    curveChart(fig("minttail"), { x0: 0, x1: tailEnd, y0: 0, y1: c.flatRate * 1.08, f: tailRate, ticksY: rateTicks, fmtY: (v) => `${v.toFixed(1)}/$`, fmtX: usdShort, xLabel: "realized",
      markers: [{ x: Dd * (Math.SQRT2 - 1), label: `half rate ${usdShort(Dd * (Math.SQRT2 - 1))}` }, { x: Dd, label: `quarter ${usdShort(Dd)}` }], now: c.tailProgress });
    // Supply: what is already minted outside the tail formula stays; the tail adds flat*D*P/(D+P), approaching flat*D.
    const tailMinted = (p) => (c.flatRate * Dd * p) / (Dd + p), base = c.supplyPaper - tailMinted(c.tailProgress), limit = base + c.flatRate * Dd;
    curveChart(fig("supply"), { x0: 0, x1: tailEnd, y0: 0, y1: limit * 1.06, f: (p) => base + tailMinted(p), ticksY: [limit, limit / 2, 0], fmtY: (v) => `${(v / 1e9).toFixed(2)}B`, fmtX: usdShort, xLabel: "realized",
      asymptote: limit, markers: [{ x: Dd, label: `limit ${(limit / 1e9).toFixed(2)}B (no more cliff dips)` }], now: c.tailProgress });
    $("curvehint").textContent = `the protocol's fixed rules over their whole range · current lp ${usdShort(c.currentLp)} → staker share ${stakerShare(c.currentLp, c)}% · as of ${hourLabel(c.atMs)} · hover to read`;
  }

  // Two pages in one document, chosen by the URL hash (#leaderboard is the default).
  // Charts are drawn when the stats page becomes visible, since hidden figures have no width.
  function route() {
    const view = location.hash === "#stats" ? "stats" : "leaderboard";
    for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== view;
    for (const a of document.querySelectorAll(".views a")) a.classList.toggle("on", a.dataset.view === view);
    document.title = `paperboards · ${view}`;
    if (view === "stats" && state.data) { renderHistory(state.data); renderMint(state.data); renderCurves(state.data); }
  }
  window.addEventListener("hashchange", route);
  route();
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data && location.hash === "#stats") { renderHistory(state.data); renderMint(state.data); renderCurves(state.data); } }, 150); });

  function renderMeta(d) {
    const lines = [
      `source: deposit and withdrawal events of the exchange contract <a href="${d.explorer}/address/${d.exchange}" target="_blank" rel="noopener">${d.exchange}</a> on hyperevm (chain 999)`,
      `blocks ${d.fromBlock.toLocaleString("en-US")} – ${d.toBlock.toLocaleString("en-US")} · generated ${new Date(d.generatedAt).toLocaleString("en-US", { hour12: false })}`,
      `amounts are usdc as emitted (8 decimals); times are interpolated from sampled block timestamps`,
    ];
    if (d.crossCheck && d.crossCheck.apiTrackedBalance18) lines.push(`cross-check: official api tracked balance ${usd18(d.crossCheck.apiTrackedBalance18)} vs net deposits ${usd(d.totals.netUsdc, false)}`);
    if (d.staking) lines.push(`rewards: usdc from paperstaking <a href="${d.explorer}/address/${d.staking}" target="_blank" rel="noopener">${d.staking}</a> = claimed (Claimed events) + unclaimed (pendingReward(address) via multicall3, read at each index run) · net pnl = trade pnl + rewards`);
    lines.push(`balance: account value = deposited − withdrawn + pnl (realized + unrealized) + rewards claimed; matches the official portfolio equity. hover for free balance and margin in positions`);
    lines.push(`share: paper ÷ total paper supply · inflation, staked and reward rate: /query/protocol/history (hourly) over the last 24h, or since paper supply was first recorded if that is shorter (the window is shown); early windows give extreme rates`);
    lines.push(`apr (protocol-wide): (staker rewards over that window ÷ mean staked paper, annualized) ÷ cost per paper, where cost per paper = −cumulative trader pnl ÷ paper supply; history charts evaluate the same definitions at every hour`);
    lines.push(`cost to mint now: no hedge = 1 ÷ (0.98 × rate); hedged = (1 − win ratio) ÷ (0.98 × rate) for a btc long + short pair opened and closed together at ±target bps, win ratio = (move − 0.2 bps) × 0.9 ÷ (1 + 1/(move·15000) + 1e5/(1e6·move·814.6)) × 0.98 ÷ move (docs' impact model) · overview period switch (1H / 1D / 7D / 30D / All): inflation = supply growth, staker rewards, reward per staked paper annualized, apr = that ÷ all-time avg cost per paper, avg cost / paper = −Δ trader pnl ÷ Δ supply, all over the trailing period from /query/protocol/history (hourly); a period longer than the minted history shows its real hours · valuation uses the all-time average`);
    lines.push(`max supply ≈ current supply + flat × D² ÷ (D + tail progress) from /query/protocol/summary (further dips of lp below the cliff would mint more) · valuation = cost per paper × max supply`);
    lines.push(`$/paper: acquisition cost per paper = −pnl ÷ paper (realized + unrealized); negative = in profit overall`);
    lines.push(`pnl: totalWindowedPnl (realized + unrealized) per wallet from the same api; hover a value for the split`);
    lines.push(`paper: paperTotal per wallet from the official leaderboard api (<code>/state/leaderboard/accounts</code>, window all); – = wallet not listed there`);
    $("meta").innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  async function load() {
    try {
      const res = await fetch(`data/ranking.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      const lab = await fetch(`labels.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      state.labels = Object.fromEntries(Object.entries(lab).filter(([k, v]) => k.startsWith("0x") && v && v.name));
    } catch (e) {
      $("tape").innerHTML = `<div class="kpi"><span>no data yet — run npm run depositors:index</span><b>${esc(e.message)}</b></div>`;
      return;
    }
    renderTape(state.data);
    if (location.hash === "#stats") { renderHistory(state.data); renderMint(state.data); renderCurves(state.data); }
    $("updated").textContent = `updated ${when(Math.floor(new Date(state.data.generatedAt).getTime() / 1000))}`;
    renderMeta(state.data);
    renderTable();
  }

  $("q").addEventListener("input", (e) => { state.q = e.target.value; state.page = 0; renderTable(); });
  $("minpaper").addEventListener("change", (e) => { state.minPaper = BigInt(e.target.value) * 10n ** 18n; state.page = 0; renderTable(); });
  function renderSortMarks() {
    for (const b of document.querySelectorAll("th button[data-sort]")) {
      const on = b.dataset.sort === state.sort;
      b.classList.toggle("on", on);
      b.classList.toggle("asc", on && state.dir === "asc");
    }
  }
  document.querySelector("thead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    const key = b.dataset.sort;
    if (state.sort === key) state.dir = state.dir === "desc" ? "asc" : "desc";
    else { state.sort = key; state.dir = key === "wallet" || key === "cost" ? "asc" : "desc"; }
    state.page = 0;
    renderSortMarks();
    renderTable();
  });
  renderSortMarks();
  $("modes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    state.mode = b.dataset.mode;
    state.page = 0;
    for (const x of $("modes").children) x.classList.toggle("on", x === b);
    renderModeHint();
    renderTable();
  });
  function renderModeHint() {
    $("modehint").textContent = state.mode === "entities" ? "grouped by display name · trailing numbers ignored" : "one row per wallet";
  }
  $("rows").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-entity]");
    if (!a) return;
    state.mode = "wallets";
    state.q = a.dataset.entity;
    $("q").value = state.q;
    state.page = 0;
    for (const x of $("modes").children) x.classList.toggle("on", x.dataset.mode === "wallets");
    renderModeHint();
    renderTable();
  });
  $("prev").addEventListener("click", () => { state.page--; renderTable(); });
  $("next").addEventListener("click", () => { state.page++; renderTable(); });
  // Hooks for card.js (share cards): read-only access to the loaded data and the formatters, plus a search setter.
  window.paperboards = {
    data: () => state.data, entities, labelOf, shareOf, costOf, paperAmt, usd, usd18, pct,
    search(q) { state.q = q; $("q").value = q; state.page = 0; renderTable(); },
  };
  load();
  setInterval(load, 60000);
})();
