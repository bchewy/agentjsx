# Extensions: the legacy Effect Layer API

JSX components are the modern API for adding capabilities. Extensions in `src/extensions/` are the older Effect-Layer-based pattern. Both still work; they coexist intentionally. This doc covers when to use each, the canonical extension shape, and how to migrate an extension to a JSX component (or vice versa) when it makes sense.

## When to use which

| Use case | JSX component | Layer extension |
|---|---|---|
| Add tools the model can call | ✅ preferred | ✅ works (e.g., `src/extensions/recall.ts`) |
| Emit system-prompt content (block) | ✅ preferred | ✅ works (`ctx.addAmbient`) |
| Wrap/transform message fragments | ✅ shaper component | ✅ works (`ctx.addTransform`) |
| Component state derived from event log | ✅ preferred (the Todo pattern) | ⚠️ awkward without a fiber |
| Forked fiber doing background work | ⚠️ no fiber lifecycle on JSX components | ✅ preferred (the `summarize` extension pattern) |
| Infrastructure not tied to the JSX tree (default error reporter, global hooks) | ❌ doesn't fit | ✅ correct home |
| Wrap a third-party SDK with scoped resource lifecycle | ⚠️ doable via async-cache pattern but awkward | ✅ cleaner via `Effect.acquireRelease` in a Layer |

Default to JSX components for new work. Reach for extensions when you need a forked fiber on a schedule (periodic polling, change subscriptions) or when you're wrapping infrastructure that should always be on.

## The canonical extension shape

Extensions are `Layer.Layer<never, never, AgentCtx | PendingSends | Scope.Scope>` — they consume `AgentCtx` and `PendingSends`, register tools / ambients / transforms via the `ctx.add*` methods, and have their lifetime bound to the surrounding scope (the agent's `ManagedRuntime`).

```ts
// src/extensions/my-extension.ts
import { Effect, Layer } from "effect"
import { AgentCtx } from "../core/agent-ctx"
import { defineTool, type Extension } from "../core"

export interface MyExtensionOptions {
  readonly someConfig: string
}

export const myExtension = (opts: MyExtensionOptions): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx

      // Add a tool. The acquireRelease semantics inside addTool mean
      // the tool gets removed when the surrounding scope (this Layer's
      // scope) closes.
      yield* ctx.addTool(
        defineTool({
          name: "my_tool",
          description: "What it does",
          parameters: /* schema */,
          run: async (args) => /* impl */,
        }),
      )

      // Add an ambient block (system-prefix content).
      yield* ctx.addAmbient({
        name: "my-block",
        content: "...",
      })

      // Add a transform that shapes the fragment list before it hits
      // adaptToProviderContext.
      yield* ctx.addTransform({
        name: "my-shaper",
        run: (fragments) => fragments.map(/* transform */),
      })

      // For background work, fork a fiber. forkScoped ties the fiber's
      // lifetime to this Layer's scope.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("5 seconds")
            // do periodic work
          }
        }),
      )
    }),
  )
```

### Wiring into the agent

Pass it via the `extensions` array on `createAgentRuntime`:

```ts
import { createAgentRuntime } from "@flamecast/agentjsx"
import { myExtension } from "./my-extension"

const agent = createAgentRuntime({
  infer,
  extensions: [
    myExtension({ someConfig: "value" }),
  ],
  // ... context, platform, etc.
})
```

The `extensions` array works alongside `context: () => render(<Agent>...</Agent>)`. Extensions register tools/ambients/transforms at agent startup; the JSX `context` callback registers them per-render with name-keyed reconciliation. Both contribute to the final ProviderContext the model sees.

If both an extension and a JSX component try to register a tool with the same name, you'll get a `DuplicateToolError`. The JSX render driver catches this and surfaces it via `ctx.reportError("context", ...)` rather than tearing down the agent.

## The shipped extensions (reference)

Look in `src/extensions/` for working examples:

| File | What it does | Pattern shown |
|---|---|---|
| `recall.ts` | A `recall` tool that fetches older log entries | Simple tool registration |
| `workspace.ts` | The legacy localWorkspace shim — wraps `shell` + `fileSystem` extensions | Composition of extensions |
| `compact.ts` | Auto-compaction (model-driven) | Forked fiber subscribing to `ctx.rendered.changes` |
| `summarize.ts` | Threshold-driven summarization | Forked fiber + structural event emission |
| `truncate-tool-outputs.ts` | Clip oversized tool result blocks | Transform registration |
| `clip-messages.ts` | Per-message content cap | Transform registration |
| `snip.ts` | Keep last N messages | Transform registration |
| `max-steps.ts` | Halt the agent after N inference loops | Forked fiber + event log inspection |
| `subagents.ts` | Spawn helper agents | Tool registration + sub-runtime composition |
| `mcp-servers.ts` | Connect to MCP servers (legacy of `<McpServer>`) | Scoped resource (`Effect.acquireRelease`) + dynamic tool registration |
| `skills.ts` | Markdown skill loader (legacy of `<Skills>`) | Backend abstraction + ambient registration |

Read `src/extensions/summarize.ts` if you need to add a forked fiber that does periodic work — it's the cleanest example. Read `src/extensions/snip.ts` for the simplest transform shape.

## When to migrate

### Extension → JSX component

Migrate when:

- The extension's only contribution is tools + (optionally) a block. The Todo and Workspace migrations were exactly this — moving from extension to component made the wiring more visible at the call site.
- The state is per-render-computable (no background fiber needed). E.g., Skills was migrated; the menu listing comes from a fire-and-forget cache populated by file reads.

Don't migrate when:

- The extension owns a forked fiber. Today there's no clean fiber-per-component primitive — components are pure render-time functions. Adding fibers would require a new lifecycle layer on JSX components (mount/unmount semantics, effect cleanup). The `summarize` extension stays as an extension for this reason.

### JSX component → extension

Migrate when:

- You discover you need a forked fiber. Refactor as an extension; the JSX component disappears.
- The functionality should always be on (not gated by the JSX tree's structure). Move to extension.

## Tools and the `Extension` type

The `Extension` type (in `src/core/agent.ts`):

```ts
export type Extension = Layer.Layer<never, never, AgentCtx | PendingSends | Scope.Scope>
```

Output is `never` because extensions don't expose new services — they only mutate the AgentCtx via its `add*` methods. Errors are `never` because failures inside an extension should be caught and surfaced via `ctx.reportError`, not propagate up. Requirements are `AgentCtx | PendingSends | Scope.Scope` because that's what the agent runtime provides.

The `Scope.Scope` requirement is what makes the extension's resources (tools acquired via `addTool`, fibers forked via `forkScoped`, etc.) get cleaned up when the agent disposes. Don't elide the scope requirement — your finalizers won't fire.

## A migration walkthrough

Hypothetical: migrate `src/extensions/clip-messages.ts` (a fragment shaper) into a JSX shaper component.

### Before (extension)

```ts
// src/extensions/clip-messages.ts
export const clipMessages = (opts: { limit: number }): Extension =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx
      yield* ctx.addTransform({
        name: "clip-messages",
        run: (fragments) => fragments.map(f =>
          f.source === "history" && f.content.length > opts.limit
            ? { ...f, content: f.content.slice(0, opts.limit) + "\n[truncated]" }
            : f
        ),
      })
    }),
  )

// Usage:
createAgentRuntime({
  extensions: [clipMessages({ limit: 2000 })],
  context: () => render(<Agent>...<Messages />...</Agent>),
})
```

### After (JSX shaper)

Already shipped as `<Compact strategy="clip-messages" limit={2000}>`. See `src/jsx/components/compact.tsx`.

```tsx
<Agent>
  ...
  <Compact strategy="clip-messages" limit={2000}>
    <Messages />
  </Compact>
</Agent>
```

The migration moved the shaping from a global transform (applied to ALL fragments) to a wrapping component (applied only to the fragments inside the `<Compact>` subtree). That's the architectural difference: extensions apply globally, JSX components apply locally to their position in the tree.

## Closing rules

- **New work**: default to JSX components.
- **Extensions are not deprecated**: they remain valid, especially for fibers + infrastructure.
- **One concept, one place**: don't ship the same capability as BOTH an extension and a JSX component unless the public-API story explicitly calls for it (e.g., `<Workspace>` is the JSX face; the underlying `shell` + `fileSystem` extensions still ship for non-JSX consumers — that's a deliberate split).
- **Read `src/extensions/` before assuming the extension API is the right answer.** It's a tighter, more constrained surface than you might expect; if the JSX shape fits, prefer it.
