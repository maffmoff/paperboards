// Wallet detail: clicking a wallet row opens its PnL breakdown (trade pnl realized / unrealized, staking
// rewards claimed / unclaimed, net pnl, balance, PAPER, cost per PAPER, flows) with links to the official
// read-only portfolio view (PnL chart, trade history), the share card and the explorer.
// Reads data through window.paperboards (app.js).
(() => {
  "use strict";
  const OFFICIAL = "https://exchange.papertrade.xyz/portfolio?view=";
  const pb = () => window.paperboards;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const big = (s) => BigInt(s ?? "0");
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  let dialog = null, opener = null;
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("div");
    dialog.className = "cardmodal";
    dialog.hidden = true;
    dialog.innerHTML = `<div class="cardbox detailbox" role="dialog" aria-modal="true" aria-label="Wallet PnL">
      <div class="cardhead"><h2 class="dtitle"></h2><button type="button" class="cardclose" aria-label="Close">×</button></div>
      <div class="dbody"></div>
      <div class="cardactions dactions"></div>
      <p class="cardnote">PnL chart and trade history: the official read-only portfolio view</p>
    </div>`;
    document.body.appendChild(dialog);
    const close = () => { dialog.hidden = true; if (opener && opener.isConnected) opener.focus(); };
    dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    dialog.querySelector(".cardclose").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dialog.hidden) close(); });
    return dialog;
  }

  function open(address) {
    const api = pb(), d = api && api.data();
    const r = d && d.rows.find((x) => x.address === address);
    if (!r) return;
    const name = api.labelOf(r);
    const signed = (v) => (v == null ? "–" : `${big(v) > 0n ? "+" : ""}${api.usd18(v)}`);
    const tone = (v) => (v == null ? "" : big(v) < 0n ? "neg" : big(v) > 0n ? "pos" : "");
    const c = api.costOf(r), cost = c ? Number((c.num * 100000000n) / c.den) / 1e8 : null;
    const share = api.shareOf(r.paper18);
    const line = (label, value, cls = "", sub = "") => `<div class="drow"><span>${esc(label)}${sub ? `<em>${esc(sub)}</em>` : ""}</span><b class="${cls}">${esc(value)}</b></div>`;
    const rewards = (big(r.rewardsClaimed18) + big(r.rewardsPending18)).toString();
    const dlg = ensureDialog();
    dlg.querySelector(".dtitle").textContent = name ? `${name} · ${short(r.address)}` : short(r.address);
    dlg.querySelector(".dbody").innerHTML = [
      `<div class="dgroup"><h3>PnL</h3>`,
      line("Net PnL", signed(r.netPnl18), tone(r.netPnl18), "trade PnL + staking rewards"),
      line("Trade PnL", signed(r.pnl18), tone(r.pnl18), "realized + unrealized"),
      line("· Realized", signed(r.realizedPnl18), tone(r.realizedPnl18)),
      line("· Unrealized", signed(r.unrealizedPnl18), tone(r.unrealizedPnl18)),
      line("Staking rewards", big(rewards) > 0n ? api.usd18(rewards) : "–", big(rewards) > 0n ? "pos" : "", "claimed + unclaimed"),
      line("· Claimed", api.usd18(r.rewardsClaimed18 ?? "0")),
      line("· Unclaimed", api.usd18(r.rewardsPending18 ?? "0")),
      `</div><div class="dgroup"><h3>Account</h3>`,
      line("Balance", r.balance18 == null ? "–" : api.usd18(r.balance18), "", "account value"),
      line("PAPER", api.paperAmt(r.paper18), "", share == null ? "" : `${api.sharePct(share)} of supply`),
      line("Cost / PAPER", cost == null ? "–" : `${cost < 0 ? "-" : ""}$${Math.abs(cost).toFixed(4)}`, cost != null && cost < 0 ? "pos" : "", "−trade PnL ÷ PAPER"),
      line("Deposited", api.usd(r.depositedUsdc)),
      line("Withdrawn", big(r.withdrawnUsdc) > 0n ? api.usd(r.withdrawnUsdc) : "–"),
      `</div>`,
    ].join("");
    dlg.querySelector(".dactions").innerHTML = `<a class="primary" href="${OFFICIAL}${r.address}" target="_blank" rel="noopener">PnL chart on Papertrade ↗</a>
      <button type="button" class="cardbtn-like" data-card-wallet="${r.address}">Share card</button>
      <a href="${d.explorer}/address/${r.address}" target="_blank" rel="noopener">Explorer ↗</a>`;
    opener = document.activeElement;
    dlg.hidden = false;
    dlg.querySelector(".cardclose").focus();
  }

  // A wallet row opens the detail: its address link and the row itself (not the card button or other links).
  document.addEventListener("click", (e) => {
    if (!pb() || !pb().data()) return;
    const tr = e.target.closest("#rows tr");
    if (!tr) return;
    if (e.target.closest("button, .tx, .ent a")) return;
    const a = tr.querySelector("td.addr a[title^='0x']");
    if (!a) return;
    if (e.metaKey || e.ctrlKey) return; // let modified clicks open the explorer as before
    e.preventDefault();
    open(a.title.toLowerCase());
  });

  // "Share card" inside the detail hands over to card.js.
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".detailbox [data-card-wallet]");
    if (!b) return;
    dialog.hidden = true;
    const btn = document.querySelector(`button.cardbtn[data-card-wallet="${b.dataset.cardWallet}"]`);
    if (btn) btn.click();
  });
})();
