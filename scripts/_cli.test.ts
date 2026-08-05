import { describe, expect, it } from "vitest";
import { commaList, flag, integer, oneOf, optional, parseArgs, timestamp } from "./_cli";

/**
 * The parser is the layer between an operator's shell and the database enums,
 * so its edge cases are where a mis-scheduled or mis-attributed post would come
 * from. `fail()` exits the process, so the tests here cover the parsing and
 * narrowing that happens before that point.
 */

describe("parseArgs", () => {
  it("reads --key value", () => {
    expect(optional(parseArgs(["--brand", "My Brand"]), "brand")).toBe("My Brand");
  });

  it("reads --key=value", () => {
    expect(optional(parseArgs(["--stagger=30"]), "stagger")).toBe("30");
  });

  it("treats --key= as an empty string, not a flag", () => {
    expect(optional(parseArgs(["--caption="]), "caption")).toBe("");
  });

  it("treats a bare option before another option as a flag", () => {
    const args = parseArgs(["--approve", "--title", "Hello"]);
    expect(flag(args, "approve")).toBe(true);
    expect(optional(args, "title")).toBe("Hello");
  });

  it("treats a trailing bare option as a flag", () => {
    expect(flag(parseArgs(["--dry-run"]), "dry-run")).toBe(true);
  });

  it("reports absent flags as false", () => {
    expect(flag(parseArgs([]), "approve")).toBe(false);
  });

  it("keeps a value that begins with a dash", () => {
    expect(optional(parseArgs(["--title", "-weird-"]), "title")).toBe("-weird-");
  });

  it("ignores positional arguments", () => {
    const args = parseArgs(["junk", "--brand", "B", "more-junk"]);
    expect(optional(args, "brand")).toBe("B");
    expect(args.size).toBe(1);
  });

  it("lets a later occurrence win", () => {
    expect(optional(parseArgs(["--brand", "A", "--brand", "B"]), "brand")).toBe("B");
  });
});

describe("commaList", () => {
  it("trims entries and drops blanks", () => {
    expect(commaList(parseArgs(["--hashtags", " a, b ,,c "]), "hashtags")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns empty when absent", () => {
    expect(commaList(parseArgs([]), "hashtags")).toEqual([]);
  });
});

describe("integer", () => {
  it("parses a whole number", () => {
    expect(integer(parseArgs(["--stagger", "30"]), "stagger", 0)).toBe(30);
  });

  it("falls back when absent", () => {
    expect(integer(parseArgs([]), "stagger", 7)).toBe(7);
  });
});

describe("oneOf", () => {
  const sources = ["ai_generated", "original_shot", "licensed_stock"] as const;

  it("accepts a valid value", () => {
    expect(oneOf(parseArgs(["--source", "original_shot"]), "source", sources)).toBe(
      "original_shot"
    );
  });

  it("uses the fallback when absent", () => {
    expect(oneOf(parseArgs([]), "source", sources, "ai_generated")).toBe("ai_generated");
  });
});

describe("timestamp", () => {
  it("parses an ISO 8601 value", () => {
    expect(timestamp(parseArgs(["--at", "2026-08-06T18:00:00Z"]), "at").toISOString()).toBe(
      "2026-08-06T18:00:00.000Z"
    );
  });

  it("defaults to roughly now when absent", () => {
    const before = Date.now();
    const parsed = timestamp(parseArgs([]), "at").getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });
});
