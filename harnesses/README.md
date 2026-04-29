# Harnesses

Design sketches that model existing agent harnesses through the effectctx lens.

These are **not** ports. They're attempts to answer: *what shape does this harness take when its features are decomposed into steering extensions over an append-only event log?* The goal is to surface which behaviors are extensions, which are host adapters, and which sit outside the agent core entirely.

Each subfolder contains a `README.md` mapping the harness's features onto effectctx primitives, plus sketched extensions for the parts that aren't already in `src/extensions/`.

| Harness | Status |
| --- | --- |
| [`hermes/`](hermes/) | Wired and runnable — Nous Research's Hermes Agent |
