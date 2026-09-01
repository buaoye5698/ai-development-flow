import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLabel } from "../src/normalize.mjs";

test("normalizes labels according to the demo contract", () => {
  assert.equal(normalizeLabel("  Ａ\tB  "), "A B");
  assert.equal(normalizeLabel("MiXeD"), "MiXeD");
});

test("rejects non-string input", () => {
  assert.throws(() => normalizeLabel(42), TypeError);
});
