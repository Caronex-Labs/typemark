import { describe, expect, it } from "vitest";
import { resolveQuote } from "../src/bridge";

describe("resolveQuote", () => {
  const md = "The cat sat.\n\nThe  cat\nran.";
  it("finds unique quotes", () => expect(resolveQuote(md, "sat")).toEqual({ from: 8, to: 11 }));
  it("requires occurrence when ambiguous", () => {
    expect(() => resolveQuote(md, "The")).toThrow(/appears 2 times/);
    expect(resolveQuote(md, "The", 2)).toEqual({ from: 14, to: 17 });
    expect(() => resolveQuote(md, "The", 3)).toThrow(/out of range/);
  });
  it("tolerates whitespace differences", () => expect(md.slice(...Object.values(resolveQuote(md, "The cat ran.")) as [number, number])).toBe("The  cat\nran."));
  it("reports missing quotes", () => expect(() => resolveQuote(md, "dog")).toThrow(/not found/));
});
