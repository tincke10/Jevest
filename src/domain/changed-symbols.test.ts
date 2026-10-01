import { describe, expect, it } from "vitest";
import { MAX_SYMBOLS_PER_HUNK, SYMBOL_STOPLIST, extractChangedSymbols } from "./changed-symbols.js";

function hunk(
  file: string,
  body: string[],
  header = "@@ -10,4 +10,5 @@",
): {
  file: string;
  hunkHeader: string;
  diff: string;
} {
  return { file, hunkHeader: header, diff: [header, ...body].join("\n") };
}

describe("extractChangedSymbols — PHP", () => {
  it("takes function, class and method-call names from added and removed lines", () => {
    const symbols = extractChangedSymbols(
      hunk("app/Services/InvoiceService.php", [
        " class InvoiceService",
        "-    public function computeTotals(array $lines)",
        "+    public function computeTotalsWithTax(array $lines)",
        "+        $rate = $this->taxResolver->resolveRate($country);",
        "+        return Totals::fromLines($lines, $rate);",
      ]),
    );
    expect(symbols).toEqual(
      expect.arrayContaining(["computeTotals", "computeTotalsWithTax", "resolveRate", "fromLines"]),
    );
    // Context lines are not changes: the unchanged class line adds nothing.
    expect(symbols).not.toContain("InvoiceService");
  });

  it("takes the enclosing definition from the hunk header", () => {
    const symbols = extractChangedSymbols(
      hunk(
        "app/Http/Controllers/InvoiceController.php",
        ["-        $x = 1;", "+        $x = 2;"],
        "@@ -40,3 +40,3 @@ public function downloadInvoicePdf(Request $request)",
      ),
    );
    expect(symbols[0]).toBe("downloadInvoicePdf");
  });

  it("takes route names, config keys and cache keys as strings", () => {
    const symbols = extractChangedSymbols(
      hunk("routes/web.php", [
        "+Route::get('/p/{id}', ShowAction::class)->name('invoices.download');",
        "+$ttl = config('invoices.cache_ttl');",
        "+Cache::remember('invoice-pdf:v2:' . $id, $ttl, fn () => null);",
        "+return redirect()->route('invoices.show');",
      ]),
    );
    expect(symbols).toEqual(
      expect.arrayContaining([
        "invoices.download",
        "invoices.cache_ttl",
        "invoice-pdf:v2:",
        "invoices.show",
      ]),
    );
  });

  it("takes static calls (Class::method)", () => {
    const symbols = extractChangedSymbols(
      hunk("app/Models/Order.php", ["+        return self::scopeVisibleTo($query, $user);"]),
    );
    expect(symbols).toContain("scopeVisibleTo");
  });
});

describe("extractChangedSymbols — JS / TS / Vue", () => {
  it("takes function, const, class and exported names", () => {
    const symbols = extractChangedSymbols(
      hunk("src/lib/pricing.ts", [
        "+export function applyDiscount(total: number) {",
        "+export const DISCOUNT_RATE = 0.1;",
        "+const formatPrice = (value) => value.toFixed(2);",
        "+export class PriceCalculator {}",
        "+export interface PriceBreakdown {}",
        "+export type PriceMode = 'net' | 'gross';",
      ]),
    );
    expect(symbols).toEqual(
      expect.arrayContaining([
        "applyDiscount",
        "DISCOUNT_RATE",
        "formatPrice",
        "PriceCalculator",
        "PriceBreakdown",
        "PriceMode",
      ]),
    );
  });

  it("takes method definitions and member calls, but not control-flow keywords", () => {
    const symbols = extractChangedSymbols(
      hunk("src/store/cart.js", [
        "+  async refreshCart(userId) {",
        "+    if (this.items.length === 0) {",
        "+      await api.fetchCartForUser(userId);",
        "+    }",
      ]),
    );
    expect(symbols).toEqual(expect.arrayContaining(["refreshCart", "fetchCartForUser"]));
    expect(symbols).not.toContain("if");
    expect(symbols).not.toContain("length");
    expect(symbols).not.toContain("items");
  });

  it("takes Vue props, emits, route names and test ids", () => {
    const symbols = extractChangedSymbols(
      hunk("resources/js/Pages/InvoiceCard.vue", [
        "+const props = defineProps({ invoiceToken: String, readOnly: Boolean });",
        "+const emit = defineEmits(['invoice-opened', 'closed']);",
        "+emit('invoice-opened');",
        "+router.visit(route('invoices.download', props.invoiceToken));",
        '+<button data-testid="invoice-download-button" @click="open">',
      ]),
    );
    expect(symbols).toEqual(
      expect.arrayContaining([
        "invoiceToken",
        "readOnly",
        "invoice-opened",
        "closed",
        "invoices.download",
        "invoice-download-button",
      ]),
    );
  });

  it("takes object keys at the start of a changed line", () => {
    const symbols = extractChangedSymbols(
      hunk("src/config/features.ts", ["+  enableBulkExport: true,", "+  maxExportRows: 5,"]),
    );
    expect(symbols).toEqual(expect.arrayContaining(["enableBulkExport", "maxExportRows"]));
  });
});

describe("extractChangedSymbols — Python, Go, Ruby", () => {
  it("python def and class", () => {
    expect(
      extractChangedSymbols(
        hunk("app/billing.py", ["+def charge_customer(customer):", "+class InvoiceBatch:"]),
      ),
    ).toEqual(expect.arrayContaining(["charge_customer", "InvoiceBatch"]));
  });

  it("go func (with receiver) and type", () => {
    expect(
      extractChangedSymbols(
        hunk("pkg/store/store.go", [
          "+func (s *Store) LoadOrders(ctx context.Context) error {",
          "+type OrderFilter struct {",
        ]),
      ),
    ).toEqual(expect.arrayContaining(["LoadOrders", "OrderFilter"]));
  });

  it("ruby def, self.def, class and module", () => {
    expect(
      extractChangedSymbols(
        hunk("lib/shipping.rb", [
          "+  def self.rate_for(order)",
          "+  def eligible?(order)",
          "+module Shipping",
          "+class RateTable",
        ]),
      ),
    ).toEqual(expect.arrayContaining(["rate_for", "eligible?", "Shipping", "RateTable"]));
  });
});

describe("extractChangedSymbols — referenced identifiers", () => {
  it("takes compound identifiers a changed line only references, ranked after calls", () => {
    const symbols = extractChangedSymbols(
      hunk("src/cart/total.ts", [
        "-  return items.reduce(sumPlain, 0);",
        "+  return items.reduce(sumWithTax, 0) + api.lookupRate();",
        "+  const flag = LEGACY_FLAGS[tax_rate];",
      ]),
    );
    expect(symbols).toEqual([
      "flag",
      "lookupRate",
      "sumPlain",
      "sumWithTax",
      "LEGACY_FLAGS",
      "tax_rate",
    ]);
  });

  it("ignores plain lowercase words and words inside comments' prose", () => {
    expect(
      extractChangedSymbols(hunk("src/a.ts", ["+  return total + price; // keep the rounding"])),
    ).toEqual([]);
  });
});

describe("extractChangedSymbols — measured noise", () => {
  it("drops short plain-lowercase calls and keys, keeps long or compound ones", () => {
    const symbols = extractChangedSymbols(
      hunk("tests/e2e/invoice.spec.js", [
        "+  assert.equal(res.status(), 404);",
        "+  return response()->header('X-Frame', 'deny');",
        "+  const payload = { body: raw, disambiguate: true, retryCount: 2 };",
        "+  service.disambiguate(term);",
      ]),
    );
    expect(symbols).toEqual(expect.arrayContaining(["disambiguate", "retryCount"]));
    for (const noise of ["equal", "status", "header", "body"]) {
      expect(symbols).not.toContain(noise);
    }
  });

  it("does not take URL globs or paths as route names", () => {
    const symbols = extractChangedSymbols(
      hunk("e2e/tests/invoice.spec.js", [
        "+  await page.route('**/api/widgets/**', handler);",
        "+  await page.route('/api/projects', handler);",
      ]),
    );
    expect(symbols.some((s) => s.includes("*") || s.includes("/"))).toBe(false);
  });
});

describe("extractChangedSymbols — noise and caps", () => {
  it("skips names of 3 characters or fewer and the stoplist", () => {
    const symbols = extractChangedSymbols(
      hunk("src/a.ts", [
        "+const foo = get(data);",
        "+const value = items.map((item) => item.id).filter(Boolean);",
        "+function set() {}",
        "+function then() {}",
      ]),
    );
    expect(symbols).toEqual([]);
  });

  it("the stoplist is a constant with common names and keywords", () => {
    for (const word of ["get", "set", "data", "value", "id", "name", "type", "item", "items"]) {
      expect(SYMBOL_STOPLIST.has(word)).toBe(true);
    }
    for (const word of ["key", "index", "map", "filter", "then", "push", "length", "return"]) {
      expect(SYMBOL_STOPLIST.has(word)).toBe(true);
    }
  });

  it("dedupes, keeps definitions first, and caps the list", () => {
    const body: string[] = [];
    for (let i = 0; i < 20; i++) body.push(`+  client.callRemoteThing${i}();`);
    body.push("+function definedHere() {}", "+function definedHere() {}");
    const symbols = extractChangedSymbols(hunk("src/many.ts", body));
    expect(symbols).toHaveLength(MAX_SYMBOLS_PER_HUNK);
    expect(symbols[0]).toBe("definedHere");
    expect(symbols.filter((s) => s === "definedHere")).toHaveLength(1);
  });

  it("honors a custom cap", () => {
    const symbols = extractChangedSymbols(
      hunk("src/a.ts", ["+function alphaOne() {}", "+function alphaTwo() {}"]),
      1,
    );
    expect(symbols).toEqual(["alphaOne"]);
  });

  it("ignores the diff header line and no-newline markers", () => {
    const symbols = extractChangedSymbols({
      file: "src/a.ts",
      hunkHeader: "@@ -1 +1 @@",
      diff: "@@ -1 +1 @@\n-const oldName = 1;\n+const newName = 1;\n\\ No newline at end of file",
    });
    expect(symbols).toEqual(["oldName", "newName"]);
  });

  it("returns nothing for a file in an unknown language with no recognizable definitions", () => {
    expect(extractChangedSymbols(hunk("README.md", ["+Some prose here."]))).toEqual([]);
  });
});
