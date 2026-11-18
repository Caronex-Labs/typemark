import { expect, it } from "vitest";
import { parse, serialize } from "../src/block";
import { registerExtension } from "../src/extension";
import { coreExtensions } from "../src/extensions";
import sample from "../demo/sample.md?raw";

it("the demo document round-trips byte for byte", () => {
  coreExtensions.forEach(registerExtension);
  const md = sample.trimEnd();
  expect(serialize(parse(md))).toBe(md);
});
