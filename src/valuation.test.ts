import { beforeEach, describe, expect, it } from "vitest";
import { REFERENCE_HPP_USD, capAmount, configureValuation, hppUsd, isRateValued } from "./valuation.js";

const NET = "eip155:181228";
const USDC = "0x401eCb1D350407f13ba348573E5630B83638E30D";
const CHIP = "0x0Ac610E77ec39AB5c6B402B376548Ac02ACc5a48";
const HPP = "0x8ebCaf48D2D91b8CEcF1668A4519823881Bf8fc3";
const fresh = () => new Date().toISOString();
const serve = (body: unknown, ok = true) => {
  let calls = 0;
  configureValuation({ ratesUrl: "http://rates.test/x", fetch: async () => { calls += 1; return { ok, json: async () => body }; } });
  return () => calls;
};

describe("capAmount", () => {
  beforeEach(() => configureValuation({ ratesUrl: "http://rates.test/x", fetch: async () => { throw new Error("offline"); } }));

  it("leaves 6-decimal dollar tokens untouched and never asks for a rate", async () => {
    const calls = serve({ hpp_usd: 0.004, updatedAt: fresh() });
    expect(await capAmount(USDC, 10_000n, NET)).toEqual({ units: 10_000n });
    expect(await capAmount(CHIP.toLowerCase(), 1_500_000n, NET)).toEqual({ units: 1_500_000n });
    expect(await capAmount(undefined, 7n, NET)).toEqual({ units: 7n });
    expect(calls()).toBe(0);
    expect(isRateValued(HPP)).toBe(true);
    expect(isRateValued(USDC)).toBe(false);
  });

  it("values HPP in micro-dollars with the published rate, rounding up", async () => {
    serve({ hpp_usd: 0.004, updatedAt: fresh() });
    // 200 HPP × $0.004 = $0.80 → 800,000 micro-dollars: under the default 1,000,000 per-call cap
    const r = await capAmount(HPP, 200n * 10n ** 18n, NET);
    expect(r.units).toBe(800_000n);
    expect(r.note).toMatch(/200 HPP ≈ \$0\.800000 at 0\.004 USD\/HPP \(published rate\)/);
    // a dust amount still counts as at least one unit
    expect((await capAmount(HPP, 1n, NET)).units).toBe(1n);
  });

  it("falls back to the reference price when the endpoint is down", async () => {
    const r = await capAmount(HPP, 10n ** 18n, NET);
    expect(r.units).toBe(BigInt(REFERENCE_HPP_USD * 1e6));
    expect(r.note).toMatch(/reference rate/);
  });

  it("does not trust an absurd, stale or malformed rate", async () => {
    for (const body of [
      { hpp_usd: REFERENCE_HPP_USD * 1000, updatedAt: fresh() },           // far above the band
      { hpp_usd: REFERENCE_HPP_USD / 1000, updatedAt: fresh() },           // far below: would loosen the cap
      { hpp_usd: 0.004, updatedAt: "2020-01-01T00:00:00Z" },               // stale
      { hpp_usd: 0.004 },                                                  // no timestamp
      { hpp_usd: null, updatedAt: null },                                  // network without an HPP rate
      "nonsense",
    ]) {
      serve(body);
      expect(await hppUsd(NET)).toMatchObject({ hppUsd: REFERENCE_HPP_USD, source: "reference" });
    }
    serve({ hpp_usd: 0.004, updatedAt: fresh() }, false);                   // HTTP error
    expect((await hppUsd(NET)).source).toBe("reference");
  });

  it("caches a rate, and after an outage keeps the higher of the last published rate and the reference", async () => {
    const calls = serve({ hpp_usd: 0.02, updatedAt: fresh() });
    const t0 = Date.now();
    expect((await hppUsd(NET, t0)).hppUsd).toBe(0.02);
    expect((await hppUsd(NET, t0 + 60_000)).hppUsd).toBe(0.02);
    expect(calls()).toBe(1);                                                // served from cache
    // the endpoint dies and the cache expires → the last published 0.02 (higher than the reference) is kept
    configureValuation({ ratesUrl: "http://rates.test/x", keepCache: true, fetch: async () => { throw new Error("down"); } });
    expect(await hppUsd(NET, t0 + 11 * 60_000)).toMatchObject({ hppUsd: 0.02, source: "reference" });
    // had the last published rate been below the reference, the reference wins
    serve({ hpp_usd: 0.001, updatedAt: fresh() });
    expect((await hppUsd(NET, t0)).hppUsd).toBe(0.001);
    configureValuation({ ratesUrl: "http://rates.test/x", keepCache: true, fetch: async () => { throw new Error("down"); } });
    expect((await hppUsd(NET, t0 + 11 * 60_000)).hppUsd).toBe(REFERENCE_HPP_USD);
  });
});
