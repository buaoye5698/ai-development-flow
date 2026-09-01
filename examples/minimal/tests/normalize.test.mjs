import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeLabel } from "../src/normalize.mjs";

const contract = JSON.parse(await readFile(new URL("../contracts/normalize.contract.json", import.meta.url), "utf8"));

test("normalizeLabel satisfies every declared example", () => {
  for (const example of contract.cases) {
    assert.equal(normalizeLabel(example.input), example.expected, example.caseId);
  }
});

test("normalizeLabel rejects every declared invalid input", () => {
  for (const value of contract.invalidInputs) {
    assert.throws(() => normalizeLabel(value), TypeError);
  }
});
