# REPL example

Interactive prompt → reply loop against an agentjsx agent. The simplest end-to-end demo: type a message, watch tool calls + assistant replies stream into your terminal.

```bash
cd examples/repl
pnpm install
AI_GATEWAY_API_KEY=sk-... pnpm start
```

Or under Infisical (Smithery contributors with workspace access):

```bash
infisical run --silent -- pnpm start
```

You'll see something like:

```
agentjsx REPL  ·  ctrl-c to exit

you    list the workspace
  → calling list_dir
  ← [list_dir] would have listed: ./
agent  The list_dir tool returned: [list_dir] would have listed: ./
```

## What's in `cli.tsx`

- `createAgentRuntime` with a JSX `context` tree: one persona block, the placeholder `<Workspace>`, and `<Messages />` for the running conversation.
- A `readline` loop that sends each line as a user message, then polls `agent.events()` to print tool calls and assistant replies as they land.
- Graceful ctrl-c that disposes the agent's fibers before exit.

The `<Workspace>` tools are placeholders today — they return synthetic strings rather than running real `bash` / `read_file` / etc. The real implementations land in the `@effect/platform` follow-up.
