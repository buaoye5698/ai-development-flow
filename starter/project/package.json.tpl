{
  "name": __PROJECT_ID_JSON__,
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "ai:doctor": "node tools/ai-flow/bin/ai-flow.mjs doctor .",
    "ai:upgrade-check": "node tools/ai-flow/bin/ai-flow.mjs upgrade-check ."
  }
}
