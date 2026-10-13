(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const PAGE = 50;
  // entity: set by clicking an entity; lists exactly its wallets (the search box shows its name until edited).
  // ranges: column -> { min, max } in display units (dollars, PAPER, % of supply), from the filter row; empty = no bound.
  const state = { data: null, labels: {}, mode: "wallets", sort: "balance", dir: "desc", q: "", entity: null, page: 0, ranges: {} };

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
    balance: (a, b) => cmp(big(b.balance18 ?? "0"), big(a.balance18 ?? "0")),
    rewards: (a, b) => cmp(rewardsTotal(b), rewardsTotal(a)),
    netPnl: (a, b) => cmp(big(b.netPnl18 ?? "0"), big(a.netPnl18 ?? "0")),
    paper: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    pnl: (a, b) => cmp(big(b.pnl18 ?? "0"), big(a.pnl18 ?? "0")),
    // Compares -pnl/paper exactly by cross-multiplying (paper is positive whenever cost exists).
    share: (a, b) => cmp(big(b.paper18 ?? "0"), big(a.paper18 ?? "0")),
    cost: (a, b) => { const x = costOf(a), y = costOf(b); return x && y ? cmp(y.num * x.den, x.num * y.den) : 0; },
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
  // Share as shown everywhere (table, card, detail): tiny non-zero shares read "<0.01%" rather than "0.00%".
  const sharePct = (x) => (x == null ? "–" : x > 0 && x < 0.00005 ? "<0.01%" : pct(x));
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
    return `<td class="num ${x == null ? "dim" : ""}" title="share of total PAPER supply">${x == null ? "–" : bar + sharePct(x)}</td>`;
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
  // A malformed share link (e.g. a stray %) must not stop the page: fall back to the raw text.
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function entities() {
    const groups = new Map();
    for (const r of state.data.rows) {
      const key = entityOf(labelOf(r));
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { address: key, name: key, wallets: [], depositedUsdc: 0n, withdrawnUsdc: 0n, netUsdc: 0n, depositCount: 0, rewardsClaimed18: 0n, rewardsPending18: 0n, netPnl18: null, claimCount: 0, paper18: null, pnl18: null, realizedPnl18: null, unrealizedPnl18: null, balance18: null, freeBalance18: null };
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
    }
    return [...groups.values()].map((g) => ({ ...g, depositedUsdc: g.depositedUsdc.toString(), withdrawnUsdc: g.withdrawnUsdc.toString(), netUsdc: g.netUsdc.toString(), paper18: g.paper18 == null ? null : g.paper18.toString(), pnl18: g.pnl18 == null ? null : g.pnl18.toString(), realizedPnl18: g.realizedPnl18 == null ? null : g.realizedPnl18.toString(), unrealizedPnl18: g.unrealizedPnl18 == null ? null : g.unrealizedPnl18.toString(), balance18: g.balance18 == null ? null : g.balance18.toString(), freeBalance18: g.freeBalance18 == null ? null : g.freeBalance18.toString(), rewardsClaimed18: g.rewardsClaimed18.toString(), rewardsPending18: g.rewardsPending18.toString(), netPnl18: g.netPnl18 == null ? null : g.netPnl18.toString() }));
  }

  function matches(r, q) {
    return r.address.includes(q) || (r.name && r.name.toLowerCase().includes(q)) || (r.hlName && r.hlName.toLowerCase().includes(q)) || (state.labels[r.address] && state.labels[r.address].name.toLowerCase().includes(q)) || (r.proxy && r.proxy.includes(q));
  }

  const missingCmp = (a, b) => (MISSING[state.sort] ? MISSING[state.sort](a) - MISSING[state.sort](b) : 0);

  // Each numeric column as a plain number in its display units, for the range filters (null = no value, which fails
  // any bound set on that column). Works on wallet rows and on entity rows alike, since both carry the same fields.
  const n18 = (s) => (s == null ? null : Number(big(s) / 10n ** 12n) / 1e6);
  const COLUMN_VALUE = {
    balance: (r) => n18(r.balance18),
    paper: (r) => n18(r.paper18),
    share: (r) => { const x = shareOf(r.paper18); return x == null ? null : x * 100; },
    pnl: (r) => n18(r.pnl18),
    netPnl: (r) => n18(r.netPnl18),
    cost: (r) => { const c = costOf(r); return c ? Number((c.num * 100000000n) / c.den) / 1e8 : null; },
    rewards: (r) => (r.rewardsClaimed18 == null && r.rewardsPending18 == null ? null : n18(rewardsTotal(r).toString())),
  };
  const inRange = (r) => {
    for (const [k, b] of Object.entries(state.ranges)) {
      if (b.min == null && b.max == null) continue;
      const v = COLUMN_VALUE[k](r);
      if (v == null || (b.min != null && v < b.min) || (b.max != null && v > b.max)) return false;
    }
    return true;
  };

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let rows = (state.mode === "entities" ? entities() : state.data.rows).filter(inRange);
    if (state.mode === "entities") {
      if (q) rows = rows.filter((g) => g.name.includes(q) || g.wallets.some((r) => r.address.includes(q)));
      const sign = state.dir === "asc" ? -1 : 1;
      return [...rows].sort((a, b) => missingCmp(a, b) || sign * SORTERS[state.sort](a, b) || cmp(a.name, b.name));
    }
    if (state.entity) rows = rows.filter((r) => entityOf(labelOf(r)) === state.entity);
    else if (q) rows = rows.filter((r) => matches(r, q));
    const sign = state.dir === "asc" ? -1 : 1;
    return [...rows].sort((a, b) => missingCmp(a, b) || sign * SORTERS[state.sort](a, b) || a.firstBlock - b.firstBlock || cmp(a.address, b.address));
  }

  function renderTable() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, (state.page + 1) * PAGE);
    const ex = state.data.explorer;
    $("th-wallet").textContent = state.mode === "entities" ? "Entity" : "Wallet";
    $("rows").innerHTML = slice.map((r, i) => {
      const rank = state.page * PAGE + i + 1;
      const who = state.mode === "entities"
        ? `<td class="ent"><button type="button" class="entlink" data-entity="${esc(r.name)}" title="show wallets">${esc(r.name)}</button><span class="n">${r.wallets.length} wallet${r.wallets.length === 1 ? "" : "s"}</span></td>`
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
        <td class="cardcol">${state.mode === "entities" ? `<button type="button" class="cardbtn" data-card-entity="${esc(r.name)}" title="share card">Card</button>` : `<button type="button" class="cardbtn" data-card-wallet="${r.address}" title="share card">Card</button>`}</td>
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
  function renderDevFee(d) {
    // The team's fee income: how much has accrued in total (claimed + still unclaimed) and how it grew.
    // Drawn into its slot in the Rules grid (stats.js creates the figure, between the projections and cost to mint).
    const f = d.devFee, fig = document.querySelector('#rules-curves [data-curve="devfee"]');
    if (!fig) return;
    if (!f) { fig.querySelector("svg").innerHTML = ""; return; }
    const usdOf = (s18) => (s18 == null ? null : Number(big(s18) / 1000000000000n) / 1e6);
    const money = (v) => (v == null ? "–" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);
    const claimed = usdOf(f.claimedTotal18), unclaimed = usdOf(f.unclaimed18);
    const accrued = claimed == null ? null : claimed + (unclaimed ?? 0);

    // Accrued (claimed + unclaimed) is read once per index run, from the first reading on; before it only the claim
    // events are known, so the line starts with the hourly claimed total and continues with the accrued readings.
    const acc = Array.isArray(f.accrued) ? f.accrued.filter((x) => x && Number.isFinite(x.usd)).map((x) => [x.ms, x.usd]) : [];
    const s = f.series, from = acc.length ? acc[0][0] : Infinity;
    // Each hourly claimed total is the total at the hour's end, so it is plotted there. The line starts at 0 at PAPER's
    // launch (stats.js HISTORY_START), like every other history on the page; fees accrue from then.
    const ps = window.paperboardsStats;
    const claimedPts = s && s.cumulative ? s.cumulative.map((v, i) => [s.startMs + (i + 1) * s.intervalMs, v]).filter(([ms]) => ms < from) : [];
    const start = ps ? ps.HISTORY_START : null;
    const first = claimedPts.length ? claimedPts[0][0] : acc.length ? acc[0][0] : null;
    const pts = [...(start != null && first != null && start < first ? [[start, 0]] : []), ...claimedPts, ...acc];
    if (!acc.length && pts.length && accrued != null) pts[pts.length - 1] = [pts[pts.length - 1][0], Math.max(pts[pts.length - 1][1] ?? 0, accrued)];
    if (pts.length >= 2 && ps) {
      // Observed only: fee accrual follows trading volume, which nothing here forecasts, so no projection.
      const notes = ["The dev half of trading fees accrued so far: claimed + unclaimed"];
      if (claimedPts.length && acc.length) notes.push(`before ${hourLabel(from)}: claimed only (the unclaimed amount is read from then on)`);
      ps.setInfo(fig, notes.join(" · "));
      let show = null;
      show = ps.timeChart(fig, pts, money, (t) => show && show(t), { quiet: true });
    } else {
      fig.querySelector("svg").innerHTML = "";
    }
  }


  // Two pages in one document, chosen by the URL hash (#leaderboard is the default).
  // Charts are drawn when the stats page becomes visible, since hidden figures have no width.
  function route() {
    const view = location.hash === "#stats" ? "stats" : "leaderboard";
    for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== view;
    for (const a of document.querySelectorAll(".views a")) a.classList.toggle("on", a.dataset.view === view);
    document.title = `paperboards · ${view}`;
    if (view === "stats" && state.data) renderStats();
  }
  window.addEventListener("hashchange", route);
  route();
  // Share links (card.js, lp.html) open the board filtered: #leaderboard?q=<address or name>.
  const linked = /[?&]q=([^&]*)/.exec(location.hash);
  if (linked) { state.q = safeDecode(linked[1]); $("q").value = state.q; }
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data && location.hash === "#stats") renderStats(); }, 150); });

  function renderMeta(d) {
    const lines = [
      `Source: deposit and withdrawal events of the Exchange contract <a href="${d.explorer}/address/${d.exchange}" target="_blank" rel="noopener">${d.exchange}</a> on HyperEVM (chain 999), plus the official read-only API (exchange.papertrade.xyz)`,
      `Blocks ${d.fromBlock.toLocaleString("en-US")} – ${d.toBlock.toLocaleString("en-US")} · generated ${new Date(d.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} · refreshed about every 10 minutes`,
      `Deposits and withdrawals: USDC as emitted (8 decimals); a withdrawal counts the amount debited, including the withdrawal fee`,
    ];
    if (d.crossCheck && d.crossCheck.apiTrackedBalance18) lines.push(`Cross-check: official API tracked balance ${usd18(d.crossCheck.apiTrackedBalance18)} vs net deposits ${usd(d.totals.netUsdc, false)}`);
    lines.push(`Balance: account value = deposited − withdrawn + PnL (realized + unrealized) + rewards claimed; matches the official portfolio equity. Hover for free balance and margin in positions`);
    lines.push(`PAPER: paperTotal per wallet from the official leaderboard API (<code>/state/leaderboard/accounts</code>, window all); – = wallet not listed there · Share = PAPER ÷ total PAPER supply`);
    lines.push(`Trade PnL: totalWindowedPnl (realized + unrealized) per wallet from the same API; hover a value for the split · $/PAPER = −trade PnL ÷ PAPER (unrealized included; negative = in profit overall)`);
    if (d.staking) lines.push(`Rewards: USDC from PaperStaking <a href="${d.explorer}/address/${d.staking}" target="_blank" rel="noopener">${d.staking}</a> = claimed (Claimed events) + unclaimed (pendingReward(address) via Multicall3, read at each index run) · Net PnL = trade PnL + rewards`);
    lines.push(`Activity: /query/protocol/history (hourly; 1-minute for the last 24 h, shown at 5 min) and /query/house/history (open interest) · TVL bars = deposits and withdrawals per bucket from the Exchange events · Open interest bars = notional opened (up) and closed (down) per bucket, derived as (volume ± Δopen interest) ÷ 2 · Net exposure = (long − short) ÷ (long + short) of open interest · APR = the last complete 24 h's staker rewards per staked PAPER, annualized, ÷ the cost to mint one PAPER with no hedge at that time (1 ÷ (0.98 × mint rate))`);
    lines.push(`Max supply ≈ current supply + flat × D² ÷ (D + tail progress), from /query/protocol/summary; further dips of the pool below the cliff and liquidations mint more, and the owner can change the parameters`);
    lines.push(`Cost to mint = two bounds at today's mint rate r: the hedged floor 1 ÷ (8.31 × r) (a long + short pair with the widest exit; the win leg recovers at most 90% × 98% = 88.2% of the loss) and no hedge 1 ÷ (0.98 × r); the ratio is 8.48 at every rate · Valuation = max supply × today's cost to mint (not a market price)`);
    lines.push(`Counted losses = tail progress: the losses the mint curve has counted; projections assume volume and the loss rate stay as they are: the median hourly pace over the last 24 h, band = the 25th–75th percentile of those hours; before the 10-minute samples, rebuilt from the hourly PAPER supply`);
    if (d.devFee) lines.push(`Dev fee: the dev half of trading fees (docs: 2% win fee and 2% LP-side loss fee, half to stakers and half to the dev fee recipient) = claim events of the Exchange (topic 0x8163d4e6…) since genesis + the unclaimed devFeeAccumulator(), read at each index run`);
    $("meta").innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  // The data file is ~13 MB. "no-cache" revalidates with the server (ETag / Last-Modified), so an unchanged file
  // costs a 304, and an unchanged validator skips parsing. One load at a time; polls pause while the tab is hidden.
  let loading = false, version = null;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch("data/ranking.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = res.headers.get("etag") || res.headers.get("last-modified");
      if (state.data && v && v === version) return;
      state.data = await res.json();
      version = v;
      const lab = await fetch("labels.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      state.labels = Object.fromEntries(Object.entries(lab).filter(([k, v]) => k.startsWith("0x") && v && v.name));
    } catch (e) {
      // Keep showing the last data on a failed refresh; only say so when there is nothing to show.
      if (!state.data) { $("empty").hidden = false; $("empty").textContent = "The data could not be loaded. It refreshes every 10 minutes; try again shortly."; }
      console.error(`ranking.json: ${e.message}`);
      return;
    } finally {
      loading = false;
    }
    if (location.hash === "#stats") renderStats();
    $("updated").textContent = `Updated ${when(Math.floor(new Date(state.data.generatedAt).getTime() / 1000))}`;
    renderMeta(state.data);
    renderTable();
  }

  $("q").addEventListener("input", (e) => { state.q = e.target.value; state.entity = null; state.page = 0; renderTable(); });
  // Filter row: open/close, read every bound on input, clear.
  $("filtertoggle").addEventListener("click", () => { const f = $("filters"), open = f.hidden; f.hidden = !open; $("filtertoggle").setAttribute("aria-expanded", String(open)); $("filtertoggle").classList.toggle("on", open); });
  const readRanges = () => {
    const out = {};
    for (const inp of document.querySelectorAll("#filters input[data-f]")) { const v = inp.value.trim() === "" ? null : Number(inp.value); if (v == null || !Number.isFinite(v)) continue; (out[inp.dataset.f] ??= { min: null, max: null })[inp.dataset.b] = v; }
    state.ranges = out; state.page = 0;
    $("filtertoggle").classList.toggle("active", Object.keys(out).length > 0);
    renderTable();
  };
  $("filters").addEventListener("input", readRanges);
  $("filterclear").addEventListener("click", () => { for (const inp of document.querySelectorAll("#filters input[data-f]")) inp.value = ""; readRanges(); });
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
    $("modehint").textContent = state.mode === "entities" ? "Grouped by display name · trailing numbers ignored" : "One row per wallet";
  }
  $("rows").addEventListener("click", (e) => {
    const a = e.target.closest("[data-entity]");
    if (!a) return;
    state.mode = "wallets";
    state.entity = a.dataset.entity;
    state.q = "";
    $("q").value = state.entity;
    state.page = 0;
    for (const x of $("modes").children) x.classList.toggle("on", x.dataset.mode === "wallets");
    renderModeHint();
    renderTable();
  });
  $("prev").addEventListener("click", () => { state.page--; renderTable(); });
  $("next").addEventListener("click", () => { state.page++; renderTable(); });
  // Hooks for card.js (share cards): read-only access to the loaded data and the formatters, plus a search setter.
  window.paperboards = {
    data: () => state.data, entities, labelOf, shareOf, sharePct, costOf, paperAmt, usd, usd18, pct,
    search(q) { state.q = q; state.entity = null; $("q").value = q; state.page = 0; renderTable(); },
  };
  // Theme: Auto (follow the system) → Light → Dark, stored per browser; the header bar color follows the page.
  const THEMES = ["auto", "light", "dark"];
  const applyTheme = (t) => {
    if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    $("themebtn").textContent = t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark";
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--page").trim();
  };
  let theme = "auto";
  try { const t = localStorage.getItem("paperboards.theme"); if (THEMES.includes(t)) theme = t; } catch { /* storage unavailable */ }
  applyTheme(theme);
  $("themebtn").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { if (theme === "auto") localStorage.removeItem("paperboards.theme"); else localStorage.setItem("paperboards.theme", theme); } catch { /* storage unavailable */ }
    applyTheme(theme);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (theme === "auto") applyTheme("auto"); });
  // stats.js rebuilds the Rules grid (data, resize, axis or horizon switch) and then asks for the dev-fee figure in it.
  document.addEventListener("paperboards:rules", () => { if (state.data) renderDevFee(state.data); });
  // Info badges: an explanation near the right edge opens to the left so it stays on screen.
  document.addEventListener("mouseover", (e) => { const b = e.target.closest(".info"); if (b) b.classList.toggle("flip", b.getBoundingClientRect().left > innerWidth * 0.6); });
  document.addEventListener("focusin", (e) => { const b = e.target.closest(".info"); if (b) b.classList.toggle("flip", b.getBoundingClientRect().left > innerWidth * 0.6); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();
