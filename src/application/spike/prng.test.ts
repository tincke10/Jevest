import { describe, expect, it } from "vitest";
import { hashString, mulberry32 } from "./prng.js";

describe("mulberry32", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a()]).not.toEqual([b(), b()]);
  });

  it("always returns values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("hashString", () => {
  it("is deterministic for the same input", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
  });

  it("differs for different inputs (no trivial collisions on these cases)", () => {
    expect(hashString("hello")).not.toBe(hashString("world"));
    expect(hashString("")).not.toBe(hashString("a"));
  });

  it("returns a non-negative integer", () => {
    const h = hashString("some-hunk-id-123");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });
});
