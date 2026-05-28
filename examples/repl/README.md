# REPL

A coding agent with shell, files, skills, todos, summarization, and deepwiki lookups. Interactive or one-shot.

## Run

```bash
cd examples/repl
pnpm install

infisical run --silent -- pnpm start                          # interactive
infisical run --silent -- pnpm start "list files in src/"     # one-shot
echo "what's in here?" | infisical run --silent -- pnpm start --stdin
```

Without Infisical: `AI_GATEWAY_API_KEY=sk-... pnpm start`.

## What's where

- [`agent.tsx`](./agent.tsx): the agent definition. JSX tree, model, MCPs, platform layer. Edit to change behavior.
- [`cli.tsx`](./cli.tsx): the CLI loop. Readline, polling, graceful shutdown via `NodeRuntime.runMain`.
- [`skills/`](./skills/): markdown files the agent reads via `skill_lookup`.

## License

MIT.
