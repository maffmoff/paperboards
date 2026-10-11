// Share cards: a 1200×675 PNG of one wallet's or entity's stats, drawn on a canvas in the site's
// palette, with post / copy / download actions. Reads data through window.paperboards (app.js).
(() => {
  "use strict";
  const W = 1200, H = 675;
  const C = { page: "#EDE5D0", panel: "#F4ECD8", ink: "#2A2520", ink2: "#4F473D", muted: "#7A7060", faint: "#998C76", rule: "rgba(212,203,186,.9)", pos: "#2D5F3A", neg: "#8B2020", warm: "#7A6235" };
  const SITE = "https://paperboards.xyz/";
  const api = () => window.paperboards;
  const big = (s) => BigInt(s ?? "0");
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const linkFor = (q) => `${SITE}#leaderboard?q=${encodeURIComponent(q)}`;

  // Rank by PAPER among wallets, or among entities.
  function rankOf(target, list) {
    const p = big(target.paper18);
    if (p <= 0n) return null;
    let r = 1;
    for (const x of list) if (x !== target && big(x.paper18) > p) r++;
    return r;
  }

  function subject(kind, key) {
    const pb = api(), d = pb.data();
    if (kind === "entity") {
      const all = pb.entities(), e = all.find((x) => x.name === key);
      return e && { row: e, title: e.name, sub: `${e.wallets.length} wallet${e.wallets.length === 1 ? "" : "s"}`, rank: rankOf(e, all), query: e.name };
    }
    const r = d.rows.find((x) => x.address === key);
    return r && { row: r, title: pb.labelOf(r) || short(r.address), sub: pb.labelOf(r) ? short(r.address) : "wallet", rank: rankOf(r, d.rows), query: r.address };
  }

  function figures(s) {
    const pb = api(), r = s.row;
    const signed = (v) => (v == null ? "–" : `${big(v) > 0n ? "+" : ""}${pb.usd18(v)}`);
    const tone = (v) => (v == null ? C.ink : big(v) < 0n ? C.neg : big(v) > 0n ? C.pos : C.ink);
    const c = pb.costOf(r);
    const cost = c ? Number((c.num * 100000000n) / c.den) / 1e8 : null;
    const rewards = (big(r.rewardsClaimed18) + big(r.rewardsPending18)).toString();
    const share = pb.shareOf(r.paper18);
    return {
      paper: pb.paperAmt(r.paper18),
      share: share == null ? null : pb.pct(share),
      stats: [
        ["Balance", r.balance18 == null ? "–" : pb.usd18(r.balance18), C.ink],
        ["Net PnL", signed(r.netPnl18), tone(r.netPnl18)],
        ["Trade PnL", signed(r.pnl18), tone(r.pnl18)],
        ["Cost / PAPER", cost == null ? "–" : `${cost < 0 ? "-" : ""}$${Math.abs(cost).toFixed(4)}`, cost != null && cost < 0 ? C.pos : C.ink],
        ["Staking rewards", big(rewards) > 0n ? pb.usd18(rewards) : "–", big(rewards) > 0n ? C.pos : C.ink],
      ],
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fit(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
  }
  const loadImage = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });

  async function draw(s) {
    await Promise.all(["500 24px Inter", "600 24px Inter", "700 24px Inter"].map((f) => document.fonts.load(f).catch(() => null)));
    const icon = await loadImage("favicon.svg").catch(() => null);
    const f = figures(s), d = api().data();
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const font = (w, px) => `${w} ${px}px Inter, system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = C.page; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.panel; roundRect(ctx, 24, 24, W - 48, H - 48, 24); ctx.fill();
    const L = 72, R = W - 72;

    // Header: mark, name, timestamp.
    if (icon) ctx.drawImage(icon, L, 62, 52, 52);
    ctx.fillStyle = C.ink; ctx.font = font(700, 30); ctx.textBaseline = "alphabetic";
    ctx.fillText("paperboards", L + 66, 98);
    ctx.fillStyle = C.faint; ctx.font = font(500, 18); ctx.textAlign = "right";
    const asOf = new Date(d.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    ctx.fillText(`AS OF ${asOf.toUpperCase()}`, R, 96);
    ctx.textAlign = "left";

    // Subject.
    ctx.fillStyle = C.ink; ctx.font = font(700, 54);
    ctx.fillText(fit(ctx, s.title, R - L), L, 200);
    ctx.font = font(500, 24); ctx.fillStyle = C.muted;
    const sub = s.sub;
    ctx.fillText(sub, L, 240);
    if (s.rank) {
      const x = L + ctx.measureText(sub).width + 18, label = `#${s.rank.toLocaleString("en-US")} by PAPER`;
      ctx.font = font(700, 18);
      const w = ctx.measureText(label).width + 24;
      ctx.fillStyle = "rgba(122,98,53,.14)"; roundRect(ctx, x, 219, w, 30, 6); ctx.fill();
      ctx.fillStyle = C.warm; ctx.fillText(label, x + 12, 240);
    }

    // Headline: PAPER held and share of supply.
    ctx.fillStyle = C.ink; ctx.font = font(700, 120);
    ctx.fillText(f.paper, L - 4, 390);
    const pw = ctx.measureText(f.paper).width;
    ctx.fillStyle = C.muted; ctx.font = font(600, 40);
    ctx.fillText("PAPER", L + pw + 16, 390);
    if (f.share) { ctx.fillStyle = C.pos; ctx.font = font(600, 34); ctx.fillText(`${f.share} of supply`, L, 444); }

    // Stats row.
    ctx.strokeStyle = C.rule; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(L, 490); ctx.lineTo(R, 490); ctx.stroke();
    const colW = (R - L) / f.stats.length;
    f.stats.forEach(([label, value, color], i) => {
      const x = L + i * colW;
      ctx.fillStyle = C.faint; ctx.font = font(600, 16);
      ctx.fillText(label.toUpperCase(), x, 530);
      ctx.fillStyle = color; ctx.font = font(700, 32);
      ctx.fillText(fit(ctx, value, colW - 16), x, 574);
    });

    // Footer.
    ctx.fillStyle = C.faint; ctx.font = font(500, 18);
    ctx.fillText("paperboards.xyz", L, 622);
    ctx.textAlign = "right";
    ctx.fillText("papertrade public api + hyperevm logs", R, 622);
    ctx.textAlign = "left";
    return cv;
  }

  const toBlob = (cv) => new Promise((ok) => cv.toBlob(ok, "image/png"));
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function copyImage(blob) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); return true; } catch { return false; }
  }

  let dialog = null;
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("div");
    dialog.className = "cardmodal";
    dialog.hidden = true;
    dialog.innerHTML = `<div class="cardbox" role="dialog" aria-modal="true" aria-label="Share card">
      <div class="cardhead"><h2>Share card</h2><button type="button" class="cardclose" aria-label="Close">×</button></div>
      <img class="cardimg" alt="">
      <div class="cardactions">
        <button type="button" data-act="post" class="primary">Post on X</button>
        <button type="button" data-act="copy">Copy image</button>
        <button type="button" data-act="download">Download PNG</button>
        <button type="button" data-act="link">Copy link</button>
      </div>
      <p class="cardnote"></p>
    </div>`;
    document.body.appendChild(dialog);
    const close = () => { dialog.hidden = true; };
    dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    dialog.querySelector(".cardclose").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dialog.hidden) close(); });
    return dialog;
  }

  async function open(kind, key) {
    const s = subject(kind, key);
    if (!s) return;
    const dlg = ensureDialog(), note = dlg.querySelector(".cardnote"), img = dlg.querySelector(".cardimg");
    note.textContent = "drawing…"; img.removeAttribute("src"); dlg.hidden = false;
    const blob = await toBlob(await draw(s));
    img.src = URL.createObjectURL(blob);
    img.alt = `paperboards card for ${s.title}`;
    const f = figures(s), url = linkFor(s.query);
    const text = `${s.title}: ${f.paper} PAPER${f.share ? ` · ${f.share} of supply` : ""}${s.rank ? ` · #${s.rank.toLocaleString("en-US")} holder` : ""} on paperboards`;
    const file = `paperboards-${(s.query.startsWith("0x") ? short(s.query).replace("…", "-") : s.query).replace(/[^\w.-]+/g, "_")}.png`;
    note.textContent = "";
    dlg.querySelector(".cardactions").onclick = async (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "post") {
        // Phones: the share sheet hands the image itself to the X app. Desktop: copy the image (paste it into
        // the post) or download it, then open X's composer with the text and link filled in.
        const pngFile = new File([blob], file, { type: "image/png" });
        if (matchMedia("(pointer: coarse)").matches && navigator.canShare && navigator.canShare({ files: [pngFile] })) {
          try { await navigator.share({ files: [pngFile], text: `${text}\n${url}` }); return; } catch { /* cancelled: fall through */ }
        }
        const copied = await copyImage(blob);
        if (!copied) download(blob, file);
        window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
        note.textContent = copied ? "Image copied: paste it into the post (⌘V / Ctrl+V)." : "Image downloaded: attach it to the post.";
      } else if (act === "copy") {
        note.textContent = (await copyImage(blob)) ? "Image copied to the clipboard." : "Copying images is not supported here; use Download.";
      } else if (act === "download") {
        download(blob, file); note.textContent = "Downloaded.";
      } else if (act === "link") {
        try { await navigator.clipboard.writeText(url); note.textContent = `Link copied: ${url}`; } catch { note.textContent = url; }
      }
    };
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.cardbtn");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.cardEntity) open("entity", b.dataset.cardEntity);
    else if (b.dataset.cardWallet) open("wallet", b.dataset.cardWallet);
  });

  // Deep link: #leaderboard?q=<address or name> filters the table once the data has loaded.
  const m = location.hash.match(/^#leaderboard\?q=(.+)$/);
  if (m) {
    const q = decodeURIComponent(m[1]);
    const wait = setInterval(() => {
      if (!api() || !api().data()) return;
      clearInterval(wait);
      api().search(q);
    }, 200);
    setTimeout(() => clearInterval(wait), 20000);
  }
})();
