import { describe, expect, it } from "vitest";
import { type SizeThresholds, classifySize } from "./size.js";

const thresholds: SizeThresholds = {
  smallMaxChangedLines: 20,
  mediumMaxChangedLines: 200,
};

describe("classifySize", () => {
  it("classifies zero changes as small", () => {
    expect(classifySize(0, 0, thresholds)).toBe("small");
  });

  it("classifies changes at the small boundary as small", () => {
    expect(classifySize(10, 10, thresholds)).toBe("small");
  });

  it("classifies changes just past the small boundary as medium", () => {
    expect(classifySize(11, 10, thresholds)).toBe("medium");
  });

  it("classifies changes at the medium boundary as medium", () => {
    expect(classifySize(100, 100, thresholds)).toBe("medium");
  });

  it("classifies changes just past the medium boundary as large", () => {
    expect(classifySize(101, 100, thresholds)).toBe("large");
  });

  it("classifies a very large diff as large", () => {
    expect(classifySize(5000, 5000, thresholds)).toBe("large");
  });

  it("throws on negative additions", () => {
    expect(() => classifySize(-1, 0, thresholds)).toThrow();
  });

  it("throws on negative deletions", () => {
    expect(() => classifySize(0, -1, thresholds)).toThrow();
  });
});
