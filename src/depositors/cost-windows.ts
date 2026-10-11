// Net cost per PAPER over trailing windows, from the hourly protocol history (cumulative traderPnl and
// paperSupply columns): what the traders who minted in that window paid per PAPER, net of their wins.
//
//   cost(window) = −(traderPnl[last] − traderPnl[from]) ÷ (paperSupply[last] − paperSupply[from])
//
// "all" is the cumulative average the site already shows (−traderPnl ÷ supply). A window can be negative
// when wins outweighed losses while little was minted (2026-10-10 21:00–23:00 UTC), and is null when
// nothing was minted in it. Windows longer than the history are clamped to it and say so.

import type { ProtocolHistory } from "./protocol.js";

export interface CostWindow {
  /** Window actually covered, in hours (shorter than asked when the history is younger). */
  hours: number;
  clamped: boolean;
  fromMs: number;
  toMs: number;
  paperMinted: number;
  /** −ΔtraderPnl: positive = traders lost money net over the window. */
  netLoss: number;
  /** USD per PAPER; null when nothing was minted in the window. */
  costPerPaper: number | null;
}

export type CostWindows = Record<"1d" | "7d" | "30d" | "all", CostWindow | null>;

export const COST_WINDOW_HOURS: Record<keyof CostWindows, number | null> = { "1d": 24, "7d": 7 * 24, "30d": 30 * 24, all: null };

export function costWindows(h: ProtocolHistory): CostWindows | null {
  const supply = h.columns.paperSupply ?? [], pnl = h.columns.traderPnl ?? [];
  const n = Math.min(supply.length, pnl.length);
  if (n === 0 || h.intervalMs <= 0) return null;
  const last = n - 1;
  const perInterval = h.intervalMs / 3_600_000;
  const one = (hours: number | null): CostWindow | null => {
    const want = hours === null ? last : Math.round(hours / perInterval);
    const from = Math.max(0, last - want);
    if (from >= last) return null;
    const minted = supply[last] - supply[from];
    const loss = pnl[from] - pnl[last];
    return {
      hours: (last - from) * perInterval,
      clamped: hours !== null && last - from < want,
      fromMs: h.startMs + from * h.intervalMs,
      toMs: h.startMs + last * h.intervalMs,
      paperMinted: minted,
      netLoss: loss,
      costPerPaper: minted > 0 ? loss / minted : null,
    };
  };
  return { "1d": one(24), "7d": one(7 * 24), "30d": one(30 * 24), all: one(null) };
}
