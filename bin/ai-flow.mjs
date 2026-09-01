#!/usr/bin/env node

import { main } from "../src/cli/main.mjs";

main(process.argv.slice(2)).catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: "error",
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 2;
});
