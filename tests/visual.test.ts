import { describe, expect, it } from "vitest";
import { difference } from "../src/visual.js";
describe("perceptual differences", () => {
  const a = Buffer.alloc(32 * 32 * 3, 80);
  it("recognizes identical images", () => {
    const d = difference(a, a, 32, 32); expect(d.ssim).toBe(1); expect(d.changedFraction).toBe(0);
  });
  it("detects small local changes despite low whole-frame error", () => {
    const b = Buffer.from(a); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) b.fill(180, (y * 32 + x) * 3, (y * 32 + x) * 3 + 3);
    const d = difference(a, b, 32, 32); expect(d.meanDifference).toBeLessThan(.01); expect(d.peakTileDifference).toBeGreaterThan(.08);
    const masked = difference(a, b, 32, 32, [{ x: 0, y: 0, width: .125, height: .125 }]); expect(masked.meanDifference).toBe(0);
  });
  it("catches flat color changes", () => {
    expect(difference(a, Buffer.alloc(a.length, 90), 32, 32).meanDifference).toBeGreaterThan(.03);
  });
  it("rejects mismatched frames and fully ignored comparisons", () => {
    expect(() => difference(a, Buffer.alloc(3), 32, 32)).toThrow();
    expect(() => difference(a, a, 32, 32, [{ x: 0, y: 0, width: 1, height: 1 }])).toThrow();
  });
});
