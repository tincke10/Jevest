import { describe, expect, it } from "vitest";
import { containsSecret, isTestPath, redact, shannonEntropy } from "./redact.js";

// Test credentials are built by concatenation so secret scanners never see a
// live-looking literal in this file.
const OPENAI_LIKE = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
const HIGH_ENTROPY_KEY = ["f3a9c2e1", "7b6d4058", "a1c9Zx9Q", "w3Er7Ty1"].join("");

describe("redact", () => {
  it("returns the text unchanged with zero redactions when there is nothing to redact", () => {
    const result = redact("const x = 1;\nfunction add(a, b) { return a + b; }");
    expect(result.redactions).toBe(0);
    expect(result.text).toBe("const x = 1;\nfunction add(a, b) { return a + b; }");
  });

  it("redacts a .env-style KEY=value assignment", () => {
    const result = redact(`TYPESAFE_API_KEY="${OPENAI_LIKE}"`);
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a JS/TS variable assignment named like a secret", () => {
    const result = redact(`const apiKey = "${OPENAI_LIKE}";`);
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a password assignment", () => {
    const result = redact('password: "hunter2-super-secret-value"');
    expect(result.text).not.toContain("hunter2-super-secret-value");
  });

  it("redacts a short quoted password literal", () => {
    const result = redact('password: "hunter2hunter2"');
    expect(result.redactions).toBe(1);
    expect(result.text).toBe('password: "[REDACTED]"');
  });

  it("redacts an unquoted .env line with a password", () => {
    const value = `S3cr3t!${"Passw0rd"}`;
    const result = redact(`DB_PASSWORD=${value}`);
    expect(result.redactions).toBe(1);
    expect(result.text).toBe("DB_PASSWORD=[REDACTED]");
  });

  it("redacts an unquoted .env line inside a diff with export", () => {
    const value = `S3cr3t!${"Passw0rd"}`;
    const result = redact(`+export DB_PASSWORD=${value}`);
    expect(result.text).not.toContain(value);
  });

  it("redacts a quoted high-entropy api key assigned to a key-named variable", () => {
    const result = redact(`const apiKey = '${HIGH_ENTROPY_KEY}';`);
    expect(result.redactions).toBe(1);
    expect(result.text).toBe("const apiKey = '[REDACTED]';");
  });

  it("redacts a secret in a JSON / PHP array with a quoted name", () => {
    expect(redact(`"api_key": "${HIGH_ENTROPY_KEY}"`).redactions).toBe(1);
    expect(redact(`'password' => 'hunter2hunter2',`).redactions).toBe(1);
  });

  it("redacts an AWS access key id", () => {
    const id = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const result = redact(`aws_key = ${id}`);
    expect(result.text).not.toContain(id);
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a GitHub personal access token", () => {
    const pat = `ghp_${"1234567890".repeat(3)}123456`;
    const result = redact(`token: ${pat}`);
    expect(result.text).not.toContain(pat);
  });

  it("redacts a full PEM private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const result = redact(`const cert = \`${key}\`;`);
    expect(result.text).not.toContain("MIIBOgIBAAJBAK");
    expect(result.text).toContain("[REDACTED]");
  });

  it("keeps the line count and the diff markers when redacting a PEM block inside a diff", () => {
    const diff = [
      "@@ -1,1 +1,5 @@",
      " const a = 1;",
      "+-----BEGIN PRIVATE KEY-----",
      "+MIIBOgIBAAJBAK",
      "+-----END PRIVATE KEY-----",
      "+const b = 2;",
    ].join("\n");
    const result = redact(diff);
    expect(result.redactions).toBe(1);
    expect(result.text.split("\n")).toEqual([
      "@@ -1,1 +1,5 @@",
      " const a = 1;",
      "+[REDACTED]",
      "+[REDACTED]",
      "+[REDACTED]",
      "+const b = 2;",
    ]);
  });

  it("counts multiple distinct redactions", () => {
    const result = redact(
      `const apiKey = "${OPENAI_LIKE}";\nconst password = "hunter2-super-secret";`,
    );
    expect(result.redactions).toBe(2);
  });

  it("does not redact ordinary identifiers that merely contain 'key' as a substring, without a suspicious value", () => {
    const result = redact("const keyboardLayout = getLayout();");
    expect(result.redactions).toBe(0);
    expect(result.text).toBe("const keyboardLayout = getLayout();");
  });

  describe("known token formats count regardless of the name", () => {
    const cases: readonly [string, string][] = [
      ["Anthropic", `sk-ant-api03-${"Ab1_Cd2-Ef3".repeat(3)}`],
      ["OpenAI project", `sk-proj-${"Ab1Cd2Ef3Gh4".repeat(2)}`],
      ["Stripe live secret", `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`],
      ["Stripe restricted", `rk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`],
      ["Google API key", `AIza${"SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q"}`],
      [
        "JWT",
        `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N"}`,
      ],
    ];
    for (const [label, token] of cases) {
      it(`redacts a ${label} token in free text`, () => {
        const result = redact(`see ${token} here`);
        expect(result.redactions).toBe(1);
        expect(result.text).toBe("see [REDACTED] here");
      });
    }

    it("redacts a long Bearer token but keeps the scheme", () => {
      const token = `${"a1B2c3D4e5".repeat(3)}`;
      const result = redact(`Authorization: Bearer ${token}`);
      expect(result.text).not.toContain(token);
      expect(result.text).toContain("Bearer [REDACTED]");
    });

    it("does not redact Bearer followed by an interpolation or a short word", () => {
      expect(redact("{ Authorization: `Bearer ${STRIPE_API_KEY}` }").redactions).toBe(0);
      expect(redact("the Bearer scheme is used").redactions).toBe(0);
    });
  });

  describe("real-world false positives are not flagged", () => {
    const lines: readonly string[] = [
      // PHP
      '$cacheKey = "cfg2d:render:v2:{$hash}";',
      "$cacheKey = 'sketch-svg:v2:' . $id;",
      "$cacheKey = $this->articlePriceCacheKey($priceScope, $currency);",
      "$titleKey = mb_strtoupper($p->getTranslation('title'));",
      "$key = mb_strtoupper(trim($title));",
      "$token = $this->resolveToken($request);",
      "$csrfToken = $this->kratos->extractCsrfToken($flow);",
      "'key' => 'EUR',",
      "'key' => 'CHF',",
      "key: code,",
      "$articleCallsByToken = collect(Http::recorded());",
      "const CONTEXT_KEY = 'acme_tracing_id';",
      "const CONTEXT_KEY = 'acme_platform_tracing_id';",
      "'token' => 'session-token',",
      // JS
      "const key = usable.join('|');",
      "if (key === prev) return;",
      "if (key == prev) return;",
      "if (key !== prev) return;",
      "if (token != null) return;",
      "if (key >= 3 || key <= 1) return;",
      "const token = ++run;",
      "const key = galleryUploadKey(img);",
      "const galleryUploadKey = (img) => `${img.id}:${img.name}`;",
      "items.map((key) => key.id);",
      "return { key: key };",
      "key = entries;",
      "const token = this.token;",
      "const token = props.token;",
      "const key = [a, b].join();",
      "const key = { a: 1 };",
      "const key = new Map();",
      "const key = !flag;",
      "const key = `row-${id}`;",
      "token: string;",
      "const tokenizer = createTokenizer();",
      "type K = keyof Props;",
      "const tokenType = 'Bearer';",
      "const storageKey = 'user-preferences-panel-state';",
      "const passwordHint = 'Enter your password';",
      "'password' => 'required|min:8|confirmed',",
    ];
    for (const line of lines) {
      it(`leaves alone: ${line}`, () => {
        for (const prefix of ["", "+    ", "-  "]) {
          const text = `${prefix}${line}`;
          const result = redact(text);
          expect(result.redactions, text).toBe(0);
          expect(result.text).toBe(text);
        }
      });
    }

    it("leaves a whole real-world hunk alone", () => {
      const hunk = lines.map((l) => `+${l}`).join("\n");
      expect(containsSecret(hunk)).toBe(false);
    });
  });

  describe("placeholders and weak literals are not flagged", () => {
    const lines: readonly string[] = [
      "password: 'changeme'",
      "password: 'example-password-1'",
      "const apiKey = 'your-api-key-goes-here-123';",
      "const apiKey = '<API_KEY_1234567890>';",
      "const apiKey = 'xxxxxxxxxxxxxxxxxxxxxxxx';",
      "const secret = '********';",
      "const apiKey = 'dummy1234567890abcdef';",
      "password: 'short'",
      "const apiKey = 'abc123';",
      "const apiKey = 'TODO_replace_1234567890';",
      "const apiKey = '[REDACTED]';",
      "password: 'test1234test'",
    ];
    for (const line of lines) {
      it(`leaves alone: ${line}`, () => {
        expect(redact(line).redactions).toBe(0);
      });
    }
  });
});

describe("shannonEntropy", () => {
  it("is 0 for a repeated character and grows with variety", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBe(1);
    expect(shannonEntropy("")).toBe(0);
  });
});

describe("containsSecret", () => {
  it("is false for text with nothing to redact", () => {
    expect(containsSecret("const x = 1;")).toBe(false);
  });

  it("is true for text containing a secret", () => {
    expect(containsSecret(`const apiKey = "${OPENAI_LIKE}";`)).toBe(true);
  });
});

describe("the secret warning (secrets) for password-like names", () => {
  // Built by concatenation so secret scanners never see these literals whole.
  const READABLE = `Secret-${"pass-123"}`;
  const WORD_JOINED = `correct-horse-${"pass-123"}`;
  const RANDOM = `kX9#mQ2$${"vL7@pR4!"}`;

  it("still redacts a short readable password but does not warn about it", () => {
    const result = redact('password: "hunter2hunter2"');
    expect(result.redactions).toBe(1);
    expect(result.secrets).toBe(0);
    expect(containsSecret('password: "hunter2hunter2"')).toBe(false);
  });

  it("warns about a mixed-class password of length >= 12 outside test paths", () => {
    const line = `'password' => '${READABLE}',`;
    expect(redact(line, { path: "app/Services/Login.php" }).secrets).toBe(1);
    expect(containsSecret(line)).toBe(true);
  });

  it("warns about a high-entropy password of length >= 12", () => {
    expect(redact(`password: "${WORD_JOINED}"`).secrets).toBe(1);
  });

  it("does not warn about a password shorter than 12 even with mixed classes", () => {
    const result = redact(`password: "Ab1!${"xyzw"}"`);
    expect(result.redactions).toBe(1);
    expect(result.secrets).toBe(0);
  });

  it("warns about an .env password with mixed classes", () => {
    expect(containsSecret(`DB_PASSWORD=S3cr3t!${"Passw0rd"}`)).toBe(true);
  });

  describe("in a test file", () => {
    const testPaths = [
      "tests/Feature/LoginTest.php",
      "app/test/login.js",
      "src/__tests__/login.ts",
      "src/login.test.ts",
      "src/login.spec.js",
      "spec/login_spec.rb",
      "tests/fixtures/users.json",
      "e2e/tests/login.ts",
    ];
    for (const path of testPaths) {
      it(`treats a word-joined password as a placeholder in ${path}, still redacted`, () => {
        const line = `+        'password' => '${READABLE}',`;
        const result = redact(line, { path });
        expect(result.redactions).toBe(1);
        expect(result.text).not.toContain(READABLE);
        expect(result.secrets).toBe(0);
        expect(containsSecret(`password: "${WORD_JOINED}"`, { path })).toBe(false);
      });
    }

    it("never warns about a named assignment: test credentials are fixtures, still redacted", () => {
      const path = "tests/Feature/Auth/LoginTest.php";
      const mixedClass = `Str0ng${"Pass"}w0rd!!`;
      const line = `+    $this->postJson('/auth/login', ['email' => 'a@b.test', 'password' => '${mixedClass}'])`;
      const result = redact(line, { path });
      expect(result.redactions).toBe(1);
      expect(result.text).not.toContain(mixedClass);
      expect(result.secrets).toBe(0);
      expect(redact(`password: "${RANDOM}"`, { path: "tests/a.test.ts" }).secrets).toBe(0);
      expect(
        redact(`const apiKey = '${HIGH_ENTROPY_KEY}';`, { path: "tests/a.test.ts" }).secrets,
      ).toBe(0);
    });

    it("still warns about a known token format", () => {
      expect(redact(`see ${OPENAI_LIKE} here`, { path: "tests/a.test.ts" }).secrets).toBe(1);
    });
  });
});

describe("isTestPath", () => {
  it("recognizes test directories and test file names", () => {
    for (const path of [
      "tests/a.php",
      "a/test/b.js",
      "a/__tests__/b.ts",
      "a/b.test.ts",
      "a/b.spec.tsx",
      "spec/b.rb",
      "a/fixtures/b.json",
      "e2e/b.ts",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("rejects production paths that only look similar", () => {
    for (const path of ["src/testing-utils.ts", "app/latest/b.php", "src/contest.ts", "e2e.md"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});
