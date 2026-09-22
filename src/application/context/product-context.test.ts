import { describe, expect, it } from "vitest";
import {
  EMPTY_PRODUCT_CONTEXT,
  ProductContextError,
  loadProductContext,
  matchAreas,
  maxCriticality,
  parseProductContext,
} from "./product-context.js";

const VALID_YAML = `
product:
  name: Acme Shop
  description: Online store for widgets.
areas:
  - name: checkout
    paths: ["src/checkout/**", "src/payments/*.ts"]
    criticality: critical
    owners: ["@acme/payments"]
    rules:
      - "Prices are always computed server side."
  - name: docs
    paths: ["docs/**"]
    criticality: none
defaults:
  criticality: low
`;

describe("parseProductContext", () => {
  it("parses product, areas (with defaults for owners/rules) and defaults", () => {
    const context = parseProductContext(VALID_YAML, ".jevest/context.yml");
    expect(context.product).toEqual({
      name: "Acme Shop",
      description: "Online store for widgets.",
    });
    expect(context.areas).toEqual([
      {
        name: "checkout",
        paths: ["src/checkout/**", "src/payments/*.ts"],
        criticality: "critical",
        owners: ["@acme/payments"],
        rules: ["Prices are always computed server side."],
      },
      { name: "docs", paths: ["docs/**"], criticality: "none", owners: [], rules: [] },
    ]);
    expect(context.defaults).toEqual({ criticality: "low" });
  });

  it("returns the empty context (no areas, no product) for a null file, never an error", () => {
    expect(parseProductContext(null, ".jevest/context.yml")).toEqual(EMPTY_PRODUCT_CONTEXT);
    expect(EMPTY_PRODUCT_CONTEXT.areas).toEqual([]);
    expect(EMPTY_PRODUCT_CONTEXT.product).toBeNull();
  });

  it("treats an empty file as the empty context", () => {
    expect(parseProductContext("", ".jevest/context.yml")).toEqual(EMPTY_PRODUCT_CONTEXT);
  });

  it("fills a missing area criticality from defaults.criticality, else 'none'", () => {
    const withDefault = parseProductContext(
      "areas:\n  - name: a\n    paths: ['a/**']\ndefaults:\n  criticality: high\n",
      "ctx",
    );
    expect(withDefault.areas[0]?.criticality).toBe("high");
    const without = parseProductContext("areas:\n  - name: a\n    paths: ['a/**']\n", "ctx");
    expect(without.areas[0]?.criticality).toBe("none");
  });

  it("throws ProductContextError naming the path on invalid YAML", () => {
    expect(() => parseProductContext("areas: [", "owner/repo@base:.jevest/context.yml")).toThrow(
      ProductContextError,
    );
    expect(() => parseProductContext("areas: [", "owner/repo@base:.jevest/context.yml")).toThrow(
      /owner\/repo@base:\.jevest\/context\.yml/,
    );
  });

  it("throws ProductContextError naming the path on a schema violation", () => {
    const bad = "areas:\n  - name: a\n    paths: ['a/**']\n    criticality: enormous\n";
    expect(() => parseProductContext(bad, "ctx.yml")).toThrow(ProductContextError);
    expect(() => parseProductContext(bad, "ctx.yml")).toThrow(/ctx\.yml/);
  });

  it("throws ProductContextError on an unknown top-level key (typo protection)", () => {
    expect(() => parseProductContext("aeras: []\n", "ctx.yml")).toThrow(/unknown key "aeras"/);
  });

  it("throws when the YAML is not a mapping", () => {
    expect(() => parseProductContext("- just\n- a list\n", "ctx.yml")).toThrow(ProductContextError);
  });
});

describe("matchAreas", () => {
  const context = parseProductContext(VALID_YAML, "ctx.yml");

  it("returns the areas touched, in file order without duplicates, with their rules", () => {
    const match = matchAreas(
      ["docs/README.md", "src/checkout/cart.ts", "src/checkout/total.ts"],
      context,
    );
    expect(match.areas.map((a) => a.name)).toEqual(["docs", "checkout"]);
    expect(match.rules).toEqual(["Prices are always computed server side."]);
    expect(match.maxCriticality).toBe("critical");
  });

  it("returns no areas and maxCriticality null when nothing matches", () => {
    const match = matchAreas(["src/other/x.ts"], context);
    expect(match.areas).toEqual([]);
    expect(match.rules).toEqual([]);
    expect(match.maxCriticality).toBeNull();
    expect(match.unmatchedFiles).toEqual(["src/other/x.ts"]);
  });

  it("matches globs against the whole path (no basename-only matching) and supports single-star", () => {
    const match = matchAreas(["src/payments/stripe.ts", "src/payments/deep/x.ts"], context);
    expect(match.areas.map((a) => a.name)).toEqual(["checkout"]);
    expect(match.unmatchedFiles).toEqual(["src/payments/deep/x.ts"]);
  });

  it("matches dotfiles and paths with a leading ./", () => {
    const ctx = parseProductContext("areas:\n  - name: ci\n    paths: ['.github/**']\n", "c");
    expect(matchAreas([".github/workflows/ci.yml"], ctx).areas.map((a) => a.name)).toEqual(["ci"]);
    expect(matchAreas(["./.github/workflows/ci.yml"], ctx).areas.map((a) => a.name)).toEqual([
      "ci",
    ]);
  });

  it("returns nothing for the empty context", () => {
    const match = matchAreas(["a.ts"], EMPTY_PRODUCT_CONTEXT);
    expect(match.areas).toEqual([]);
    expect(match.maxCriticality).toBeNull();
  });
});

describe("maxCriticality", () => {
  it("orders none < low < medium < high < critical", () => {
    expect(maxCriticality("low", "high")).toBe("high");
    expect(maxCriticality("critical", "medium")).toBe("critical");
    expect(maxCriticality("none", "none")).toBe("none");
  });
});

describe("loadProductContext", () => {
  it("fetches the file at the BASE sha and parses it", async () => {
    const calls: Array<{ path: string; sha: string }> = [];
    const context = await loadProductContext({
      fetchFile: async (path, sha) => {
        calls.push({ path, sha });
        return VALID_YAML;
      },
      path: ".jevest/context.yml",
      baseSha: "base123",
      label: "acme/shop@base123:.jevest/context.yml",
    });
    expect(calls).toEqual([{ path: ".jevest/context.yml", sha: "base123" }]);
    expect(context.areas).toHaveLength(2);
  });

  it("returns the empty context when the file is missing (fetch returns null)", async () => {
    const context = await loadProductContext({
      fetchFile: async () => null,
      path: ".jevest/context.yml",
      baseSha: "base123",
      label: "x",
    });
    expect(context).toEqual(EMPTY_PRODUCT_CONTEXT);
  });

  it("propagates a fetch error other than not-found (fail closed)", async () => {
    await expect(
      loadProductContext({
        fetchFile: async () => {
          throw new Error("contents API 500");
        },
        path: ".jevest/context.yml",
        baseSha: "base123",
        label: "x",
      }),
    ).rejects.toThrow("contents API 500");
  });

  it("wraps an invalid file in ProductContextError naming the label", async () => {
    await expect(
      loadProductContext({
        fetchFile: async () => "areas: [",
        path: ".jevest/context.yml",
        baseSha: "base123",
        label: "acme/shop@base123:.jevest/context.yml",
      }),
    ).rejects.toThrow(/acme\/shop@base123/);
  });
});
