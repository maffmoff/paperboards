// "Ask ChatGPT": opens chatgpt.com with a prompt holding what is on screen (the visible figures, chart
// readouts or table rows) and the page's own definitions, so the answer can explain this data, not guess.
(() => {
  "use strict";
  const MAX = 4500; // keep the URL well inside what browsers and chatgpt.com accept
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  function visibleSections() {
    return [...document.querySelectorAll("main section")].filter((s) => !s.hidden && s.offsetParent !== null);
  }

  function screenText() {
    const out = [];
    for (const sec of visibleSections()) {
      const title = clean(sec.querySelector("h2") && sec.querySelector("h2").textContent);
      if (!title || title === "Sources") continue;
      const lines = [];
      for (const k of sec.querySelectorAll(".kpi")) {
        const label = clean(k.querySelector("span") && k.querySelector("span").textContent), value = clean(k.querySelector("b") && k.querySelector("b").textContent);
        if (label) lines.push(`- ${label}: ${value}`);
      }
      for (const f of sec.querySelectorAll(".chart figcaption")) {
        const label = clean(f.querySelector("span") && f.querySelector("span").textContent), value = clean(f.querySelector("b") && f.querySelector("b").textContent);
        if (label) lines.push(`- chart "${label}": ${value || "–"}`);
      }
      const table = sec.querySelector("#table");
      if (table && !table.hidden) {
        const heads = [...table.querySelectorAll("thead th")].filter((th) => getComputedStyle(th).display !== "none").map((th) => clean(th.textContent));
        lines.push(`columns: ${heads.join(" | ")}`);
        [...table.querySelectorAll("#rows tr")].slice(0, 15).forEach((tr) => {
          const cells = [...tr.children].filter((td) => getComputedStyle(td).display !== "none").map((td) => clean(td.textContent.replace(/\bcard\b/i, "")));
          lines.push(cells.join(" | "));
        });
        const q = document.getElementById("q");
        if (q && q.value) lines.push(`(filtered by "${q.value}")`);
      }
      const hint = clean(sec.querySelector(".panel-head .sub") && sec.querySelector(".panel-head .sub").textContent);
      if (lines.length) out.push(`## ${title}${hint ? ` (${hint})` : ""}\n${lines.join("\n")}`);
    }
    return out.join("\n\n");
  }

  function definitions() {
    return [...document.querySelectorAll("#meta div")].map((d) => `- ${clean(d.textContent)}`).join("\n");
  }

  function prompt() {
    const view = location.hash.startsWith("#stats") ? "Stats" : "Leaderboard";
    const lang = navigator.language || "en";
    const head = `I'm looking at the ${view} page of paperboards (${location.origin}/), a community dashboard for Papertrade, a perpetuals exchange on Hyperliquid's HyperEVM where realized trading losses mint PAPER, a token whose stakers receive USDC from losses. Explain what these numbers mean and what stands out, briefly and concretely. Reply in ${lang}.`;
    let body = `${head}\n\n# On screen\n${screenText()}\n\n# Definitions used by the page\n${definitions()}`;
    if (body.length > MAX) body = `${body.slice(0, MAX - 20)}\n…(truncated)`;
    return body;
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("#askgpt");
    if (!b) return;
    e.preventDefault();
    window.open(`https://chatgpt.com/?q=${encodeURIComponent(prompt())}`, "_blank", "noopener");
  });
})();
