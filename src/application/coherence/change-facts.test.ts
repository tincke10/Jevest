import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE_THRESHOLDS,
  MAX_LISTED_FILES,
  areaOf,
  classifyFileKind,
  describeChange,
  languageOf,
} from "./change-facts.js";
import type { PrFile } from "./pr-record.js";

function file(path: string, overrides: Partial<PrFile> = {}): PrFile {
  return { path, status: "modified", additions: 1, deletions: 1, ...overrides };
}

describe("classifyFileKind", () => {
  it.each([
    ["src/__tests__/a.ts", "test"],
    ["src/a.test.ts", "test"],
    ["src/a.spec.php", "test"],
    ["test/a.go", "test"],
    ["tests/unit/a.py", "test"],
    ["e2e/login.cy.ts", "test"],
    ["README.md", "docs"],
    ["docs/guide.mdx", "docs"],
    ["docs/index.html", "docs"],
    [".changeset/pretty-cats.md", "docs"],
    ["package.json", "deps"],
    ["packages/core/package.json", "deps"],
    ["pnpm-lock.yaml", "deps"],
    ["package-lock.json", "deps"],
    ["yarn.lock", "deps"],
    ["go.mod", "deps"],
    ["go.sum", "deps"],
    ["composer.json", "deps"],
    ["composer.lock", "deps"],
    ["requirements.txt", "deps"],
    ["requirements-dev.txt", "deps"],
    ["Cargo.toml", "deps"],
    ["Cargo.lock", "deps"],
    ["Gemfile", "deps"],
    ["Gemfile.lock", "deps"],
    ["pyproject.toml", "deps"],
    [".github/workflows/ci.yml", "ci"],
    [".gitlab-ci.yml", "ci"],
    ["Dockerfile", "ci"],
    ["Dockerfile.prod", "ci"],
    ["docker-compose.yml", "ci"],
    ["docker-compose.override.yaml", "ci"],
    [".circleci/config.yml", "ci"],
    ["db/migrations/001_init.php", "migration"],
    ["migration/2024_add_users.ts", "migration"],
    ["schema/users.sql", "migration"],
    ["tsconfig.json", "config"],
    ["config/app.yml", "config"],
    ["settings.yaml", "config"],
    ["biome.toml", "config"],
    ["php.ini", "config"],
    [".env.example", "config"],
    [".editorconfig", "config"],
    [".eslintrc", "config"],
    [".prettierrc.json", "config"],
    [".nvmrc", "config"],
    ["assets/logo.png", "assets"],
    ["public/font.woff2", "assets"],
    ["src/icon.svg", "assets"],
    ["bin/tool.wasm", "assets"],
    ["src/index.ts", "source"],
    ["app/Http/Controllers/UserController.php", "source"],
    ["cmd/server/main.go", "source"],
    ["Makefile", "source"],
  ])("%s -> %s", (path, kind) => {
    expect(classifyFileKind(path)).toBe(kind);
  });

  it("puts test before source: a test file under src is still a test", () => {
    expect(classifyFileKind("src/foo/bar.test.ts")).toBe("test");
  });

  it("puts deps before config: package.json is deps although it is a .json file", () => {
    expect(classifyFileKind("apps/web/package.json")).toBe("deps");
  });

  it("puts ci before config: a workflow yml is ci although it is a .yml file", () => {
    expect(classifyFileKind(".github/workflows/release.yaml")).toBe("ci");
  });

  it("is case-insensitive on extensions", () => {
    expect(classifyFileKind("README.MD")).toBe("docs");
    expect(classifyFileKind("logo.PNG")).toBe("assets");
  });
});

describe("languageOf", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    ["a.php", "php"],
    ["a.vue", "vue"],
    ["a.py", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["a.java", "java"],
    ["a.kt", "kotlin"],
    ["a.rb", "ruby"],
    ["a.cs", "csharp"],
    ["a.swift", "swift"],
    ["a.sql", "sql"],
    ["a.sh", "shell"],
    ["a.css", "css"],
    ["a.scss", "scss"],
    ["a.html", "html"],
    ["a.md", "markdown"],
    ["a.yml", "config"],
    ["a.yaml", "config"],
    ["a.json", "config"],
    ["a.toml", "config"],
    ["a.zig", "zig"],
  ])("%s -> %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it("returns undefined for a file without an extension", () => {
    expect(languageOf("Dockerfile")).toBeUndefined();
    expect(languageOf("bin/run")).toBeUndefined();
  });
});

describe("areaOf", () => {
  it("uses the first two segments under packages/apps/src/lib", () => {
    expect(areaOf("packages/core/src/index.ts")).toBe("packages/core");
    expect(areaOf("apps/web/pages/index.tsx")).toBe("apps/web");
    expect(areaOf("src/domain/size.ts")).toBe("src/domain");
    expect(areaOf("lib/auth/token.rb")).toBe("lib/auth");
  });

  it("uses only the first segment when the second segment is the file itself", () => {
    expect(areaOf("src/index.ts")).toBe("src");
  });

  it("uses the first segment for any other top-level folder", () => {
    expect(areaOf("app/Http/Controllers/UserController.php")).toBe("app");
    expect(areaOf("cmd/server/main.go")).toBe("cmd");
  });

  it("returns <root> for files at the repository root", () => {
    expect(areaOf("Makefile")).toBe("<root>");
    expect(areaOf("main.go")).toBe("<root>");
  });
});

describe("describeChange", () => {
  it("computes totals, size and the flags for a mixed change", () => {
    const facts = describeChange([
      file("src/auth/login.ts", { additions: 30, deletions: 5 }),
      file("src/auth/login.test.ts", { status: "added", additions: 40, deletions: 0 }),
      file("README.md", { additions: 2, deletions: 1 }),
      file("package.json", { additions: 1, deletions: 1 }),
      file(".github/workflows/ci.yml", { additions: 3, deletions: 0 }),
      file("db/migrations/002.sql", { status: "added", additions: 10, deletions: 0 }),
      file("tsconfig.json", { additions: 1, deletions: 0 }),
      file("old/legacy.ts", { status: "removed", additions: 0, deletions: 20 }),
      file("src/auth/session.ts", { status: "renamed", additions: 0, deletions: 0 }),
    ]);

    expect(facts.fileCount).toBe(9);
    expect(facts.additions).toBe(87);
    expect(facts.deletions).toBe(27);
    expect(facts.size).toBe("medium");
    expect(facts.hasTests).toBe(true);
    expect(facts.testsOnly).toBe(false);
    expect(facts.docsOnly).toBe(false);
    expect(facts.touchesDeps).toBe(true);
    expect(facts.touchesCi).toBe(true);
    expect(facts.touchesMigration).toBe(true);
    expect(facts.touchesConfig).toBe(true);
    expect(facts.addsFiles).toBe(true);
    expect(facts.removesFiles).toBe(true);
    expect(facts.renamesFiles).toBe(true);
    expect(facts.truncated).toBe(false);
  });

  it("collects distinct languages and source areas, in first-seen order", () => {
    const facts = describeChange([
      file("src/auth/login.ts"),
      file("src/auth/login.test.ts"),
      file("packages/ui/Button.tsx"),
      file("app/Models/User.php"),
      file("README.md"),
      file("Makefile"),
      file("main.go"),
    ]);

    expect(facts.languages).toEqual(["typescript", "php", "markdown", "go"]);
    expect(facts.areas).toEqual(["src/auth", "packages/ui", "app", "<root>"]);
  });

  it("flags testsOnly and docsOnly when every file is of that kind", () => {
    expect(describeChange([file("a.test.ts"), file("tests/b.py")]).testsOnly).toBe(true);
    expect(describeChange([file("a.test.ts"), file("tests/b.py")]).hasTests).toBe(true);
    expect(describeChange([file("README.md"), file("docs/x.md")]).docsOnly).toBe(true);
    expect(describeChange([file("README.md"), file("src/x.ts")]).docsOnly).toBe(false);
  });

  it("uses the size thresholds from src/domain/size.ts, with overridable thresholds", () => {
    const small = describeChange([file("a.ts", { additions: 25, deletions: 25 })]);
    expect(small.size).toBe("small");
    const large = describeChange([file("a.ts", { additions: 300, deletions: 1 })]);
    expect(large.size).toBe("large");
    const custom = describeChange([file("a.ts", { additions: 300, deletions: 1 })], {
      smallMaxChangedLines: 1000,
      mediumMaxChangedLines: 2000,
    });
    expect(custom.size).toBe("small");
    expect(DEFAULT_SIZE_THRESHOLDS).toEqual({
      smallMaxChangedLines: 50,
      mediumMaxChangedLines: 300,
    });
  });

  it("handles an empty file list", () => {
    const facts = describeChange([]);
    expect(facts.fileCount).toBe(0);
    expect(facts.size).toBe("small");
    expect(facts.languages).toEqual([]);
    expect(facts.areas).toEqual([]);
    expect(facts.files).toEqual([]);
    expect(facts.hasTests).toBe(false);
    expect(facts.testsOnly).toBe(false);
    expect(facts.docsOnly).toBe(false);
  });

  it("lists each file with its kind, status and counts, source files first", () => {
    const facts = describeChange([
      file("README.md", { additions: 2, deletions: 0 }),
      file("src/a.ts", { status: "added", additions: 5, deletions: 0 }),
      file("src/a.test.ts", { additions: 3, deletions: 1 }),
      file("src/b.ts", { additions: 1, deletions: 1 }),
    ]);

    expect(facts.files).toEqual([
      { path: "src/a.ts", kind: "source", status: "added", additions: 5, deletions: 0 },
      { path: "src/b.ts", kind: "source", status: "modified", additions: 1, deletions: 1 },
      { path: "README.md", kind: "docs", status: "modified", additions: 2, deletions: 0 },
      { path: "src/a.test.ts", kind: "test", status: "modified", additions: 3, deletions: 1 },
    ]);
  });

  it("caps the listed files at MAX_LISTED_FILES keeping source first and flags truncation", () => {
    const docs = Array.from({ length: 30 }, (_, i) => file(`docs/page-${i}.md`));
    const sources = Array.from({ length: 30 }, (_, i) => file(`src/mod-${i}.ts`));
    const facts = describeChange([...docs, ...sources]);

    expect(MAX_LISTED_FILES).toBe(40);
    expect(facts.fileCount).toBe(60);
    expect(facts.files).toHaveLength(40);
    expect(facts.truncated).toBe(true);
    expect(facts.files.slice(0, 30).every((f) => f.kind === "source")).toBe(true);
    expect(facts.files.slice(30).every((f) => f.kind === "docs")).toBe(true);
    // Totals and flags still consider every file, not only the listed ones.
    expect(facts.docsOnly).toBe(false);
  });

  it("does not flag truncation at exactly MAX_LISTED_FILES files", () => {
    const facts = describeChange(Array.from({ length: 40 }, (_, i) => file(`src/m-${i}.ts`)));
    expect(facts.files).toHaveLength(40);
    expect(facts.truncated).toBe(false);
  });
});
