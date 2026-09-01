# Minimal example

This neutral example normalizes a string. Its small size makes the control flow visible without hiding it behind application code.

Tracked inputs are the product specification, decision register, impact map, verifier registry, contract, implementation, and tests. SpecIndex, task packets, context manifests, review reports, run records, and evidence bundles are generated for the current subject revision; no historical PASS artifact is committed.

From the repository root, run:

```text
node --test examples/minimal/tests/normalize.test.mjs
node --test tests/golden-flow.test.mjs
```

The root golden-flow test compiles and validates every control artifact in memory, performs the contract examples against the real function, and proves the stop conditions. It does not execute commands embedded in the specification or verifier registry.
