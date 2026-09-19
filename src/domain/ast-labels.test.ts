import { describe, expect, it } from "vitest";
import {
  classifyChangeKind,
  labelHunk,
  touchesAsync,
  touchesErrorHandling,
  touchesIo,
  touchesPublicApi,
} from "./ast-labels.js";

describe("classifyChangeKind", () => {
  it("classifies identical code as rename-or-format when only an identifier changes", () => {
    const before = "function add(a, b) { return a + b; }";
    const after = "function add(x, y) { return x + y; }";
    expect(classifyChangeKind(before, after)).toBe("rename-or-format");
  });

  it("classifies whitespace-only changes as rename-or-format", () => {
    const before = "function add(a,b){return a+b;}";
    const after = "function add(a, b) {\n  return a + b;\n}";
    expect(classifyChangeKind(before, after)).toBe("rename-or-format");
  });

  it("classifies added statements as add-behavior", () => {
    const before = "function run() {\n  doA();\n}";
    const after = "function run() {\n  doA();\n  doB();\n  if (flag) {\n    doC();\n  }\n}";
    expect(classifyChangeKind(before, after)).toBe("add-behavior");
  });

  it("classifies removed statements as delete", () => {
    const before = "function run() {\n  doA();\n  doB();\n  doC();\n}";
    const after = "function run() {\n  doA();\n}";
    expect(classifyChangeKind(before, after)).toBe("delete");
  });

  it("classifies emptied-out code as delete", () => {
    const before = "function run() {\n  doA();\n  doB();\n}";
    const after = "";
    expect(classifyChangeKind(before, after)).toBe("delete");
  });

  it("classifies same statement count with different content as modify-behavior", () => {
    const before = "function check(x) {\n  return x > 0;\n}";
    const after = "function check(x) {\n  return x >= 0;\n}";
    expect(classifyChangeKind(before, after)).toBe("modify-behavior");
  });

  it("tolerates an unbalanced-brace fragment without throwing", () => {
    const before = "function run() { if (x) {";
    const after = "function run() { if (x) { doThing();";
    expect(() => classifyChangeKind(before, after)).not.toThrow();
    // still yields one of the four valid kinds
    expect(["add-behavior", "modify-behavior", "delete", "rename-or-format"]).toContain(
      classifyChangeKind(before, after),
    );
  });
});

describe("touchesPublicApi", () => {
  it("is true when an exported function's parameters change", () => {
    const before = "export function greet(name: string): string { return name; }";
    const after = "export function greet(name: string, loud: boolean): string { return name; }";
    expect(touchesPublicApi(before, after)).toBe(true);
  });

  it("is true when an exported function's return type changes", () => {
    const before = "export function getValue(): number { return 1; }";
    const after = 'export function getValue(): string { return "1"; }';
    expect(touchesPublicApi(before, after)).toBe(true);
  });

  it("is false when only the internal body of an exported function changes", () => {
    const before = "export function compute(x: number): number { return x + 1; }";
    const after = "export function compute(x: number): number { return x + 2; }";
    expect(touchesPublicApi(before, after)).toBe(false);
  });

  it("is false when nothing exported appears in the hunk", () => {
    const before = "function helper() { return 1; }";
    const after = "function helper() { return 2; }";
    expect(touchesPublicApi(before, after)).toBe(false);
  });

  it("is true when an export is added", () => {
    const before = "function helper() { return 1; }";
    const after = "export function helper() { return 1; }";
    expect(touchesPublicApi(before, after)).toBe(true);
  });
});

describe("touchesErrorHandling", () => {
  it("is true when the hunk contains a try/catch", () => {
    const before = "function run() { doThing(); }";
    const after = "function run() { try { doThing(); } catch (e) { log(e); } }";
    expect(touchesErrorHandling(before, after)).toBe(true);
  });

  it("is true when the hunk throws", () => {
    const before = "function run() { return 1; }";
    const after = 'function run() { throw new Error("bad"); }';
    expect(touchesErrorHandling(before, after)).toBe(true);
  });

  it("is true when the hunk calls something named like *Error", () => {
    const before = "function run() { return 1; }";
    const after = 'function run() { return new ValidationError("bad"); }';
    expect(touchesErrorHandling(before, after)).toBe(true);
  });

  it("is false for unrelated code", () => {
    const before = "function run() { return 1; }";
    const after = "function run() { return 2; }";
    expect(touchesErrorHandling(before, after)).toBe(false);
  });
});

describe("touchesAsync", () => {
  it("is true for an async function with await", () => {
    const before = "function run() { return doThing(); }";
    const after = "async function run() { return await doThing(); }";
    expect(touchesAsync(before, after)).toBe(true);
  });

  it("is true for Promise usage", () => {
    const before = "function run() { return 1; }";
    const after = "function run() { return new Promise((resolve) => resolve(1)); }";
    expect(touchesAsync(before, after)).toBe(true);
  });

  it("is true for .then( usage", () => {
    const before = "function run() { doThing(); }";
    const after = "function run() { doThing().then(onDone); }";
    expect(touchesAsync(before, after)).toBe(true);
  });

  it("is true for setTimeout", () => {
    const before = "function run() { doThing(); }";
    const after = "function run() { setTimeout(doThing, 0); }";
    expect(touchesAsync(before, after)).toBe(true);
  });

  it("is false for unrelated synchronous code", () => {
    const before = "function run() { return 1; }";
    const after = "function run() { return 2; }";
    expect(touchesAsync(before, after)).toBe(false);
  });
});

describe("touchesIo", () => {
  it("is true for fs usage", () => {
    const before = "function run() { return 1; }";
    const after = 'function run() { return fs.readFileSync("x"); }';
    expect(touchesIo(before, after)).toBe(true);
  });

  it("is true for fetch usage", () => {
    const before = "function run() { return 1; }";
    const after = 'function run() { return fetch("https://example.com"); }';
    expect(touchesIo(before, after)).toBe(true);
  });

  it("is true for readFile identifier", () => {
    const before = "function run() { return 1; }";
    const after = 'function run() { return readFile("x"); }';
    expect(touchesIo(before, after)).toBe(true);
  });

  it("is false for unrelated code", () => {
    const before = "function run() { return 1; }";
    const after = "function run() { return 2; }";
    expect(touchesIo(before, after)).toBe(false);
  });
});

describe("labelHunk", () => {
  it("combines all five labels into one object", () => {
    const before = "function run() { return 1; }";
    const after = 'export async function run() { return await fetch("x"); }';
    const labels = labelHunk(before, after);
    expect(labels.changeKind).toBe("add-behavior");
    expect(labels.touchesPublicApi).toBe(true);
    expect(labels.touchesAsync).toBe(true);
    expect(labels.touchesIo).toBe(true);
    expect(labels.touchesErrorHandling).toBe(false);
  });
});
