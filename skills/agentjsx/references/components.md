# Authoring components

Three shapes. Pick by what you contribute. Each section has a full template, the patterns to follow, and the canonical example in the repo.

## 1. Content components

Pure fragment emitters. They take props (and maybe children that get serialized to text) and emit one or more `Fragment` objects that become the model's system prompt.

### Canonical examples

- `<Agent>` — transparent root, just passes children through. Doesn't emit anything itself.
- `<Block name="role">…</Block>` — emits a single fragment with `tag: "core/system"`, the children-as-text content, and `source: "role"` (used for routing in shapers).
- `<Messages />` — projects the event log via `renderHistoryFragments` and emits one fragment per turn.

### Template

```tsx
import type { Node } from "../runtime"
import { emitFragment } from "../runtime"

export function MyBlock({ name, children }: { name: string; children?: Node | Node[] }) {
  const content = stringifyChildren(children)
  return emitFragment({
    tag: "core/system",
    source: name,
    content: `<${name}>\n${content}\n</${name}>`,
  })
}

function stringifyChildren(children: Node | Node[] | undefined): string {
  if (children === undefined) return ""
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(c => stringifyChildren(c as any)).join("")
  // Element with deeper structure — projects can refuse and require leaf text
  throw new Error(`MyBlock children must be text, got nested element`)
}
```

### Notes

- The `source` field is what shapers dispatch on. `<Compact strategy="snip">` keeps fragments with `source === "history"` (messages) and passes everything else through unchanged. If you author a new content component, pick a stable `source` string that shapers can pattern-match on.
- The `tag` field is `"core/system"` for system blocks. The other current tag is `"core/user-message"` / `"core/assistant-message"` etc. for projected messages — see `src/core/types.ts` for the `FragmentMap` definition.
- Block content should be a string. If you want to compose nested JSX inside a block, you'll hit the "leaf text only" guard. Either compose strings outside the JSX, or write multiple sibling blocks.

## 2. Capability components

Declare tools the model can call + (optionally) emit a fragment describing what they do.

### Canonical examples

- `<Workspace root="./" />` — declares 5 fs/shell tools backed by `@effect/platform`'s `FileSystem` + `Path` + `CommandExecutor`. Emits a `<workspace>` block.
- `<Skills root="./skills" />` — reads MD files from a directory, declares `skill_lookup` + `skill_invoke`, emits a menu block. Uses the async-cache pattern.
- `<McpServer name="..." url="..." headers={...} />` — connects to an MCP server lazily, namespaces its tools as `<name>_<toolname>`, emits a status block. Async-cache pattern.
- `<Todo />` — declares `todo_add` / `todo_complete`, projects state from `todo.added` / `todo.completed` events in the log. Event-log-state pattern.

### Template (synchronous tool implementation)

```tsx
import { Schema } from "effect"
import { defineTool } from "../../core/define-tool"
import { emitFragment, emitTool } from "../runtime"
import { useRenderContext } from "../render"

export function MyCapability({ config }: { config: string }) {
  // useRenderContext gives access to events, runEffect, infer.
  // For purely synchronous tools, you may not need it.
  // const { events } = useRenderContext()

  const my_tool = defineTool({
    name: "my_tool",
    description: "What the model should use this for.",
    parameters: Schema.Struct({
      arg: Schema.String,
    }),
    run: async ({ arg }) => {
      // Plain async work — no platform services needed.
      return `result for ${arg}`
    },
  })

  return [
    emitTool(my_tool),
    emitFragment({
      tag: "core/system",
      source: "my-capability",
      content: `<my-capability>tool my_tool available with config=${config}</my-capability>`,
    }),
  ]
}
```

### Template (with platform services via runEffect)

When the tool needs `FileSystem`, `Path`, `CommandExecutor`, or anything else from the platform layer:

```tsx
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { defineTool } from "../../core/define-tool"
import { emitFragment, emitTool } from "../runtime"
import { useRenderContext } from "../render"

export function MyFsCapability({ root }: { root: string }) {
  const { runEffect } = useRenderContext()

  const read_thing = defineTool({
    name: "read_thing",
    description: "Read a thing from disk under the configured root.",
    parameters: Schema.Struct({ path: Schema.String }),
    run: async ({ path }) => {
      try {
        return await runEffect(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const p = yield* Path.Path
          const target = p.resolve(root, path)
          const exists = yield* fs.exists(target)
          if (!exists) return `File not found: ${path}`
          return yield* fs.readFileString(target)
        }) as unknown as Effect.Effect<string, never, never>)
      } catch (e) {
        return `[read_thing] Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  })

  return [
    emitTool(read_thing),
    emitFragment({
      tag: "core/system",
      source: "my-fs",
      content: `<my-fs root="${root}">(use read_thing to inspect)</my-fs>`,
    }),
  ]
}
```

### Template (event-log state — the Todo pattern)

When the component has state that should survive renders and hydrate across restarts, drive it through the event log:

**Step 1**: Add event variants to `src/core/types.ts`:

```ts
// In the Event union:
| { type: "my.added"; data: string }
| { type: "my.completed"; index: number }
```

**Step 2**: Update `src/core/projections.ts`. Two tables to extend:

```ts
// PROJECTORS map (events → message fragments)
"my.added": () => null,        // not visible in messages
"my.completed": () => null,    // not visible in messages

// EVENT_META map
"my.added":     { projectable: false, hiddenByRecall: true, structural: true },
"my.completed": { projectable: false, hiddenByRecall: true, structural: true },
```

The TS mapped-type exhaustiveness check WILL break the compile if you forget either table. That's the seam.

**Step 3**: Author the component:

```tsx
import { Schema } from "effect"
import { defineTool } from "../../core/define-tool"
import { emitFragment, emitTool } from "../runtime"
import { useRenderContext } from "../render"
import type { Event } from "../../core/types"

interface MyItem { data: string; done: boolean }

function reduce(events: ReadonlyArray<Event>): MyItem[] {
  const items: MyItem[] = []
  for (const e of events) {
    if (e.type === "my.added") items.push({ data: e.data, done: false })
    else if (e.type === "my.completed" && items[e.index]) items[e.index]!.done = true
  }
  return items
}

export function MyState() {
  const { events } = useRenderContext()
  const items = reduce(events)

  const my_action = defineTool({
    name: "my_action",
    description: "Add a new thing.",
    parameters: Schema.Struct({ data: Schema.String }),
    run: async ({ data }) => ({
      content: "ok",
      extraEvents: [{ type: "my.added", data }],
    }),
  })

  const lines = items.map((it, i) => `[${it.done ? "x" : " "}] ${i}: ${it.data}`)
  const content = items.length === 0
    ? "<my-state>(empty)</my-state>"
    : `<my-state>\n${lines.join("\n")}\n</my-state>`

  return [
    emitTool(my_action),
    emitFragment({ tag: "core/system", source: "my-state", content }),
  ]
}
```

### Template (async data cache — Skills / McpServer pattern)

When you need async data at render time (read a directory, connect to a server, fetch from a remote) — the JSX render walk is sync, so you can't await inside. Use a module-level cache + fire-and-forget:

```tsx
import { Schema } from "effect"
import { defineTool } from "../../core/define-tool"
import { emitFragment, emitTool } from "../runtime"
import { useRenderContext } from "../render"

interface CacheEntry {
  state: "loading" | "ready" | "failed"
  data?: MyData
  error?: string
}

// Module-level. Survives the JS module lifetime; shared across all
// instances of MyAsync in the process. Key by whatever uniquely
// identifies the resource (URL, root path, etc.).
const cache = new Map<string, CacheEntry>()

// Test-only escape hatch. Convention: name it __testing__ and export.
// Lets tests pre-seed the cache or reset it between runs.
export const __testing__ = {
  reset(): void { cache.clear() },
  seed(key: string, data: MyData): void {
    cache.set(key, { state: "ready", data })
  },
}

export function MyAsync({ id }: { id: string }) {
  const { runEffect } = useRenderContext()

  let entry = cache.get(id)
  if (!entry) {
    entry = { state: "loading" }
    cache.set(id, entry)
    void runEffect(fetchSomething(id) as never)
      .then((data) => { cache.set(id, { state: "ready", data: data as MyData }) })
      .catch((e) => { cache.set(id, { state: "failed", error: String(e) }) })
  }

  const blockContent =
    entry.state === "loading" ? `<my-async id="${id}">(loading...)</my-async>` :
    entry.state === "failed"  ? `<my-async id="${id}">failed: ${entry.error}</my-async>` :
                                `<my-async id="${id}">ready, ${entry.data?.summary}</my-async>`

  const tools = entry.state === "ready" ? [/* declare tools that use entry.data */] : []

  return [
    ...tools.map(emitTool),
    emitFragment({ tag: "core/system", source: "my-async", content: blockContent }),
  ]
}
```

**UX caveat to know**: on the first render after the component mounts, `state === "loading"` because the fire-and-forget hasn't resolved. The next render (triggered by any agent event — user message, tool result, etc.) sees `state === "ready"`. There is no proactive re-render trigger — `RenderContext` doesn't expose `invalidate()` today. Acceptable because real conversations always have a turn 2; the loading state lasts at most one turn.

If a future component genuinely needs a sync initial render, you'd need to extend `RenderContext` with an invalidation hook + plumb it through `agent-ctx.ts`. Don't add that unless something forces it.

## 3. Shaper components

Wrap children, inspect their emits via `renderChildren()`, re-emit a transformed version.

### Canonical example

`<Compact strategy="..." {opts}>` — supports four strategies (`snip`, `truncate-tool-outputs`, `clip-messages`, `summary`). Each transforms the message-shaped fragments in the children's output.

### Template

```tsx
import { renderChildren } from "../render"
import type { Node } from "../runtime"
import { emitFragment, emitTool } from "../runtime"
import type { Fragment as RenderedFragment } from "../../core/types"

export function MyShaper({ threshold, children }: {
  threshold: number
  children: Node | ReadonlyArray<Node>
}) {
  // Walks the JSX subtree into a fresh local collector. Returns the
  // collected fragments + tools. The outer collector won't see the
  // children's raw emits — only what we re-emit below.
  const inner = renderChildren(children)

  // Partition by source. Compact's pattern:
  //   - `source === "history"` → message-shaped, eligible for shaping
  //   - everything else → pass through (system blocks like <role>, <workspace>)
  const messages: RenderedFragment[] = []
  const preserved: RenderedFragment[] = []
  for (const f of inner.fragments) {
    if (f.source === "history") messages.push(f)
    else preserved.push(f)
  }

  const transformed = transformMessages(messages, threshold)

  return [
    ...preserved.map(emitFragment),
    ...transformed.map(emitFragment),
    ...inner.tools.map(emitTool),
  ]
}

function transformMessages(messages: RenderedFragment[], threshold: number): RenderedFragment[] {
  // Strategy-specific logic.
  return messages
}
```

### Notes

- The walker's outer collector ONLY sees the shaper's re-emits. The inner emits are local. That's what makes nested shapers compose without interference.
- Pass-through fragments (system blocks above `<Messages />` like `<role>`, `<workspace>`) need explicit re-emission. If you forget to re-emit them, the model loses its persona / workspace tree. Always partition and pass through.
- Re-emit tools unchanged unless your shaper specifically wants to filter/wrap them. Most shapers shape fragments only.
- Async work inside a shaper follows the cache pattern, same as capability components. See `<Compact strategy="summary">` for the canonical async-shaper example — it caches summarized fragment ranges keyed by content hash.

## Putting it together: the JSX you write

```tsx
<Agent>                                          // content (transparent)
  <Block name="role">You are a coding assistant.</Block>   // content
  <Workspace root="./" />                                  // capability
  <Skills root={SKILLS_ROOT} />                            // capability (async)
  <McpServer name="deepwiki" url="https://..." />          // capability (async)
  <Todo />                                                 // capability (event-log state)
  <Compact strategy="summary" threshold={4000}>            // shaper
    <Messages />                                           // content (projects events)
  </Compact>
</Agent>
```

Five different component shapes, one unified mental model. The runtime walks this tree, collects emits, reconciles tools, and the model sees a coherent ProviderContext.
