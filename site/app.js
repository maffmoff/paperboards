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
    paper: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    pnl: (a, b) => cmp(big(b.pnl18 ?? "0"), big(a.pnl18 ?? "0")),
    // Compares -pnl/paper exactly by cross-multiplying (paper is positive whenever cost exists).
    share: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    cost: (a, b) => { const x = costOf(a), y = costOf(b); return x && y ? cmp(y.num * x.den, x.num * y.den) : 0; },
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
  // Largest single-wallet share, cached per data load; the share bar (shown in v2 only) is scaled to it.
  let topShare = { data: null, x: 1 };
  function topShareOf() {
    if (topShare.data !== state.data) {
      const max = state.data.rows.reduce((m, r) => (r.paper18 != null && big(r.paper18) > m ? big(r.paper18) : m), 0n);
      topShare = { data: state.data, x: shareOf(max.toString()) || 1 };
    }
    return topShare.x;
  }
  function shareCell(r) {
    const x = shareOf(r.paper18);
    const bar = x == null ? "" : `<span class="sharebar"><i style="width:${Math.min(100, (x / topShareOf()) * 100).toFixed(1)}%"></i></span>`;
    return `<td class="num ${x == null ? "dim" : ""}" title="share of total PAPER supply">${x == null ? "–" : bar + (x < 0.00005 && x > 0 ? "<0.01%" : pct(x))}</td>`;
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
        ? `<td class="ent"><a data-entity="${esc(r.name)}" title="show wallets">${esc(r.name)}</a><span class="n">${r.wallets.length} wallet${r.wallets.length === 1 ? "" : "s"}</span></td>`
        : `<td class="addr"><a href="${ex}/address/${r.address}" target="_blank" rel="noopener" title="${r.address}">${short(r.address)}</a>${nameCells(r)}</td>`;
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
        <td class="num ${wd ? "neg" : "dim"}">${wd ? usd(r.withdrawnUsdc) : "–"}</td>
        <td class="cardcol">${state.mode === "entities" ? `<button type="button" class="cardbtn" data-card-entity="${esc(r.name)}" title="share card">card</button>` : `<button type="button" class="cardbtn" data-card-wallet="${r.address}" title="share card">card</button>`}</td>
      </tr>`;
    }).join("");
    $("empty").hidden = rows.length > 0;
    $("pageinfo").textContent = `${state.page + 1} / ${pages}`;
    $("prev").disabled = state.page === 0;
    $("next").disabled = state.page >= pages - 1;
  }

  const hourLabel = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  // The Stats page (Now / Activity / Rules) is drawn by stats.js.
  const renderStats = () => window.paperboardsStats && state.data && window.paperboardsStats.render(state.data);

  // Dev fee: the owner-set dev fee recipient's claims of the dev half of trading fees (docs: 2% win fee and
  // 2% LP-side loss fee, half to stakers and half to the dev fee recipient), every claim event since genesis
  // (src/depositors/devfee.ts), plus the live unclaimed accumulator and the recipient's Exchange balance.
  function lineChart(fig, vals, timeAt, fmt, onHover) {
    const svg = fig.querySelector("svg"), cv = fig.querySelector(".cv"), n = vals.length;
    const nums = vals.filter((v) => v != null && Number.isFinite(v));
    if (nums.length < 2) { cv.textContent = nums.length ? fmt(nums[nums.length - 1]) : "–"; return () => {}; }
    let lo = Math.min(0, ...nums), hi = Math.max(...nums);
    if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const tickText = [lo + pad, (lo + hi) / 2, hi - pad].map((t) => fmt(t));
    const W = Math.max(220, fig.clientWidth), H = 150, L = Math.ceil(Math.max(...tickText.map((t) => t.length)) * 5.6) + 10, R = 10, T = 8, B = 20;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R)), y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let path = "", pen = false;
    vals.forEach((v, i) => { if (v == null || !Number.isFinite(v)) { pen = false; return; } path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    svg.innerHTML = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(fmt(t))}</text>`).join("")
      + `<text class="tick" x="${L}" y="${H - 5}">${esc(hourLabel(timeAt(0)))}</text><text class="tick" x="${W - R}" y="${H - 5}" text-anchor="end">${esc(hourLabel(timeAt(n - 1)))}</text>`
      + `<path class="line" d="${path}"/><line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/><rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>`;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), hit = svg.querySelector(".hit");
    const show = (i) => {
      const at = i == null ? n - 1 : i, v = vals[at];
      cv.textContent = v == null || !Number.isFinite(v) ? "–" : fmt(v);
      if (i == null || v == null || !Number.isFinite(v)) { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible"); dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible");
    };
    hit.addEventListener("mousemove", (e) => { const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; onHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))))); });
    hit.addEventListener("mouseleave", () => onHover(null));
    show(null);
    return show;
  }

  function renderDevFee(d) {
    // The team's fee income: how much has accrued in total (claimed + still unclaimed) and how it grew.
    const f = d.devFee, kp = $("devfeekpis"), box = $("devfeecharts"), tbl = $("devfeeclaims");
    const baseHint = "the team's half of every trading fee (1% of settled pnl) · accrued = claimed + unclaimed";
    if (tbl) tbl.innerHTML = "";
    if (!f) { kp.innerHTML = `<div class="kpi"><span>dev fees accrued</span><b>–</b></div>`; box.innerHTML = ""; $("devfeehint").textContent = "not indexed yet"; return; }
    const usdOf = (s18) => (s18 == null ? null : Number(big(s18) / 1000000000000n) / 1e6);
    const money = (v) => (v == null ? "–" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
    const claimed = usdOf(f.claimedTotal18), unclaimed = usdOf(f.unclaimed18);
    const accrued = claimed == null ? null : claimed + (unclaimed ?? 0);
    kp.innerHTML = `<div class="kpi"><span>dev fees accrued · all time</span><b>${esc(money(accrued))}</b></div>`;
    $("devfeehint").textContent = baseHint;
    box.innerHTML = `<figure class="chart"><figcaption><span>Dev fees accrued, cumulative</span><b class="cv"></b></figcaption><svg role="img" aria-label="cumulative dev fees accrued"></svg></figure>`;
    const fig = box.querySelector(".chart");
    // Preferred: one accrued reading (claimed + unclaimed) per index run, which grows smoothly. Readings are
    // about 10 minutes apart; the x axis spaces them evenly by reading.
    const acc = Array.isArray(f.accrued) ? f.accrued.filter((x) => x && Number.isFinite(x.usd)) : [];
    if (acc.length >= 2) {
      const draws = [], at = (i) => acc[i].ms;
      const hover = (i) => { draws.forEach((g) => g(i)); $("devfeehint").textContent = i == null ? baseHint : hourLabel(at(i)); };
      draws.push(lineChart(fig, acc.map((x) => x.usd), at, money, hover));
      return;
    }
    const s = f.series, n = s ? s.cumulative.length : 0, timeAt = (i) => s.startMs + i * s.intervalMs;
    if (s && n >= 2) {
      // Claims arrive in batches; the last point carries what has accrued but is not claimed yet, so the line
      // ends at the accrued total shown above.
      const series = s.cumulative.slice();
      if (accrued != null) series[n - 1] = Math.max(series[n - 1] ?? 0, accrued);
      const draws = [];
      const hover = (i) => { draws.forEach((g) => g(i)); $("devfeehint").textContent = i == null ? baseHint : hourLabel(timeAt(i)); };
      draws.push(lineChart(fig, series, timeAt, money, hover));
    } else {
      box.querySelector(".cv").textContent = "not enough history yet";
    }
  }


  // Two pages in one document, chosen by the URL hash (#leaderboard is the default).
  // Charts are drawn when the stats page becomes visible, since hidden figures have no width.
  function route() {
    const view = location.hash === "#stats" ? "stats" : "leaderboard";
    for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== view;
    for (const a of document.querySelectorAll(".views a")) a.classList.toggle("on", a.dataset.view === view);
    document.title = `paperboards · ${view}`;
    if (view === "stats" && state.data) { renderStats(); renderDevFee(state.data); }
  }
  window.addEventListener("hashchange", route);
  route();
  // Share links (card.js, lp.html) open the board filtered: #leaderboard?q=<address or name>.
  const linked = /[?&]q=([^&]*)/.exec(location.hash);
  if (linked) { state.q = decodeURIComponent(linked[1]); $("q").value = state.q; }
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data && location.hash === "#stats") { renderStats(); renderDevFee(state.data); } }, 150); });

  function renderMeta(d) {
    const lines = [
      `source: deposit and withdrawal events of the exchange contract <a href="${d.explorer}/address/${d.exchange}" target="_blank" rel="noopener">${d.exchange}</a> on hyperevm (chain 999)`,
      `blocks ${d.fromBlock.toLocaleString("en-US")} – ${d.toBlock.toLocaleString("en-US")} · generated ${new Date(d.generatedAt).toLocaleString("en-US", { hour12: false })}`,
      `amounts are usdc as emitted (8 decimals); times are interpolated from sampled block timestamps`,
    ];
    if (d.crossCheck && d.crossCheck.apiTrackedBalance18) lines.push(`cross-check: official api tracked balance ${usd18(d.crossCheck.apiTrackedBalance18)} vs net deposits ${usd(d.totals.netUsdc, false)}`);
    if (d.devFee) lines.push(`dev fee: the dev half of trading fees (docs: 2% win fee and 2% lp-side loss fee, half to stakers and half to the dev fee recipient) = claim events of the exchange (topic 0x8163d4e6…) since genesis, binned hourly; unclaimed = devFeeAccumulator(), balance = the recipient's exchange balance, both read at each index run`);
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
    if (location.hash === "#stats") { renderStats(); renderDevFee(state.data); }
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
