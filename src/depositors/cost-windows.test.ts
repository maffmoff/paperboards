import { describe, expect, it } from "vitest";
import { costWindows } from "./cost-windows.js";

const H = 3_600_000;
const hist = (supply: number[], pnl: number[]) => ({ startMs: Date.UTC(2026, 9, 10, 0), intervalMs: H, columns: { paperSupply: supply, traderPnl: pnl } });

describe("costWindows", () => {
  it("is −ΔPnL ÷ Δsupply per trailing window, clamped to the history", () => {
    // 31 hourly points: nothing minted for 2 h, then 1e9 PAPER for $5M, then 1e8 per hour for $1M each.
    const supply = [0, 0, 1e9]; const pnl = [0, 0, -5e6];
    for (let i = 3; i < 31; i++) { supply.push(supply[i - 1] + 1e8); pnl.push(pnl[i - 1] - 1e6); }
    const w = costWindows(hist(supply, pnl))!;
    expect(w["1d"]).toMatchObject({ hours: 24, clamped: false, paperMinted: 24e8, netLoss: 24e6, costPerPaper: 0.01 });
    expect(w["7d"]).toMatchObject({ hours: 30, clamped: true, paperMinted: supply[30], netLoss: -pnl[30] });
    expect(w["30d"]!.costPerPaper).toBeCloseTo(w.all!.costPerPaper!, 12);
    expect(w.all).toMatchObject({ hours: 30, clamped: false, fromMs: Date.UTC(2026, 9, 10, 0), toMs: Date.UTC(2026, 9, 11, 6) });
    expect(w.all!.costPerPaper).toBeCloseTo(33e6 / 3.8e9, 12);
  });
  it("is negative when wins outweighed losses and null when nothing was minted", () => {
    const w = costWindows(hist([1e9, 1e9, 1.01e9], [-5e6, -4e6, -3e6]))!;
    expect(w["1d"]!.costPerPaper).toBeCloseTo(-2e6 / 1e7, 12);
    const flat = costWindows(hist([1e9, 1e9], [-5e6, -5e6]))!;
    expect(flat["1d"]!.costPerPaper).toBeNull();
    expect(flat["1d"]!.paperMinted).toBe(0);
  });
  it("survives a one-point or empty history", () => {
    expect(costWindows(hist([], []))).toBeNull();
    const one = costWindows(hist([1e9], [-5e6]))!;
    expect(one).toEqual({ "1d": null, "7d": null, "30d": null, all: null }); // no interval to measure over
  });
});
