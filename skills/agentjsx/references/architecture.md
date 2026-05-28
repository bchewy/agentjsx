# Architecture: the render walk + reconciler

Everything fits in one mental model: the JSX tree is a pure function of `RenderContext`; the runtime walks it on every render trigger; the reconciler diffs tools by name across renders and applies side effects via Effect scopes.

## The pieces

```
┌──────────────────────────────────────────────────────────────────────┐
│  createAgentRuntime({ infer, platform, context, extensions })        │
│                                                                       │
│  ┌─────────────────────┐    ┌──────────────────────────────────┐    │
│  │  ManagedRuntime     │    │  AgentCtx (forked fibers,        │    │
│  │  (Effect runtime    │    │   render driver, reconciler,     │    │
│  │   with platform     │    │   event log, etc.)               │    │
│  │   layer composed)   │    │                                  │    │
│  └─────────┬───────────┘    └──────────┬───────────────────────┘    │
│            │                            │                            │
│            └── runEffect ──────────────►│                            │
│                                         │                            │
│                                         ▼                            │
│                   ┌──────────────────────────────────────────┐      │
│                   │  Render driver (forked fiber)            │      │
│                   │                                          │      │
│                   │  on each trigger (event log change,      │      │
│                   │  invalidate, etc.):                      │      │
│                   │                                          │      │
│                   │    1. snapshot events                    │      │
│                   │    2. _setExternalContext({              │      │
│                   │         events, runEffect, infer })      │      │
│                   │    3. call user's context() callback     │      │
│                   │    4. render(<tree>) walks the JSX       │      │
│                   │    5. reconcile rendered.tools           │      │
│                   │       (per-tool Scope)                   │      │
│                   │    6. feed rendered.fragments into       │      │
│                   │       adaptToProviderContext             │      │
│                   │    7. update ctx.rendered                │      │
│                   └──────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

## The walker

Lives in `src/jsx/render.ts`. Entry point: `render(root, context?)` (the user's `context()` callback wraps a call to it).

### The render loop, step by step

1. The walker maintains a **module-level ambient context** (`currentContext: RenderContext | null`). The runtime sets it via `_setExternalContext` before invoking the user's callback. `useRenderContext()` reads from this ambient — that's the bridge from runtime state into pure component bodies.

2. The walker also maintains a **local collector stack**. Each `render()` or `renderChildren()` call pushes a fresh collector onto the stack; the top of stack is where emits go. Pop on return. This is what lets shapers walk a subtree into their own collector without polluting the outer one.

3. **Walk a Node**:
   - `null` / `undefined` / `boolean` → skip
   - `string` / `number` → not emitted as fragments by default; component bodies typically string-stringify these themselves (e.g., `<Block>` joins its children into text content)
   - `Array` → walk each element
   - `Element` with sentinel type (from `emitFragment` / `emitTool`) → push the embedded fragment/tool into the current collector
   - `Element` with a function-component type → call the function with `props` (with `children` injected from the element's children), recurse on the returned Node
   - `Element` with `Fragment` type → recurse on children

4. After the walk finishes, return the collector's accumulated `{ fragments, tools }` as a `Rendered` value.

### Function-component invocation

```ts
function invokeComponent(fn: ComponentFunction, props: Record<string, unknown>, children: Node[]): Node {
  const propsWithChildren = { ...props, children }
  return fn(propsWithChildren)
}
```

Components are pure. They receive their props (with children injected), and return a `Node`. They can call `useRenderContext()` from within the body to read events / runEffect / infer. The walker handles their return value by recursing.

### Why function components only

The walker explicitly throws on intrinsic string-type elements (`<div>`, `<foo>`). agentjsx's JSX is for component composition, not for emitting HTML/XML. Intrinsic elements would invite confusion (is `<div>` a model-visible block? a wrapper?). Function components with explicit `emitFragment` / `emitTool` calls keep the data flow visible.

## `RenderContext`

Three fields, injected by the runtime before each `context()` invocation:

```ts
interface RenderContext {
  readonly events: ReadonlyArray<Event>
  readonly runEffect: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>
  readonly infer: InferFn
}
```

- **`events`**: the current event log snapshot. Components use this for state projection (Todo, future Errors / GitState).
- **`runEffect`**: bound to the agent's `ManagedRuntime`. Returns a Promise. The public signature pins `R = never`, but the runtime resolves any service the platform layer provides at execution. The standard pattern at call sites is `runEffect(eff as unknown as Effect.Effect<A, E, never>)`.
- **`infer`**: the agent's `InferFn`. Used by `<Compact strategy="summary">` to drive a side LLM call for summarization. Other components can use it too (e.g., a hypothetical `<Translate>` component that runs each user message through translation).

The default when `useRenderContext()` is called outside any agent (e.g., in unit tests of pure components):
- `events`: empty array
- `runEffect`: rejects with a clear "no agent runtime wired" error
- `infer`: rejects with a clear "no inferFn provided" error

Lazy stubs — invoking is the only way to trip the error. Just reading the context object is safe.

## `renderChildren()`

The primitive that makes shapers possible.

```ts
export function renderChildren(children: Node | ReadonlyArray<Node>): Rendered {
  // Push a fresh collector on the stack
  // Walk the children Node(s) into it
  // Pop the collector
  // Return its accumulated { fragments, tools }
}
```

Used inside shaper components to "look at what my subtree emits, then transform and re-emit." Without this primitive, you'd have no way to inspect/transform descendants' emits — the walker would push their emits straight into the outer collector.

Composes naturally: `<Compact><Compact><Messages /></Compact></Compact>`. Outer Compact's `renderChildren` walks the inner Compact (which itself calls `renderChildren` on `<Messages />`, transforms, re-emits). Outer Compact then sees the inner Compact's transformed output and applies its own transform. Each layer only sees its child's output.

## The reconciler

Lives in `src/core/agent-ctx.ts` (the render driver). After `render()` returns the new `Rendered`:

```ts
// Maintained across renders:
const toolScopes: Map<string, Scope.CloseableScope> = new Map()

// On each render:
const newTools = rendered.tools
const newToolNames = new Set(newTools.map(t => t.name))

// Install new tools
for (const tool of newTools) {
  if (!toolScopes.has(tool.name)) {
    const scope = yield* Scope.make()
    toolScopes.set(tool.name, scope)
    yield* ctx.addTool(tool).pipe(Scope.extend(scope))
  }
}

// Release removed tools
for (const [name, scope] of toolScopes) {
  if (!newToolNames.has(name)) {
    yield* Scope.close(scope, Exit.void)
    toolScopes.delete(name)
  }
}
```

**Keyed by name only.** Closure identity doesn't matter — components recreate their tool closures on every render (closing over the current `runEffect`), but as long as the name matches, the reconciler treats it as unchanged.

When the agent is disposed, a finalizer iterates the `toolScopes` map and closes everything. Each tool's individual scope ran its `addTool`'s acquire/release pair; closing the scope triggers the release.

## Fragment composition: `adaptToProviderContext`

After tool reconciliation, `rendered.fragments` is fed through `adaptToProviderContext` (in `src/core/render-adapter.ts`). This:

1. Splits fragments by `tag` (`core/system` vs message-shaped tags)
2. Concatenates system fragments into the final `system: string`
3. Groups message fragments into the `messages: ProviderMessage[]` array (with alternating-role invariant enforcement, role coercion, etc.)
4. Adds the reconciled `tools` from the agent ctx as `tools: ToolDefinition[]`

The result is a `ProviderContext` — the shape `infer` expects.

## What re-triggers a render

The render driver in `agent-ctx.ts` subscribes to several streams that all flow into a single "should re-render" trigger:

- `events.changes` — new events appended (user messages, tool results, etc.)
- `tools.changes` — programmatic tool changes (rare, mostly for extensions)
- `ambients.changes` — extension-emitted ambient changes (legacy)
- `transforms.changes` — extension-registered transforms
- `invalidateRef.changes` — explicit re-render triggers

Any of these firing causes the driver to call `context()` again, get fresh `Rendered`, reconcile, and update `ctx.rendered`.

**Notable absence**: there's no proactive re-render from inside a component. If a fire-and-forget async task (like the Skills cache fill) wants to trigger a re-render after it resolves, it has no mechanism today. That's the "loading on turn 1, ready on turn 2" wart. The fix would be exposing `ctx.invalidate()` through `RenderContext`; punted because real conversations always have a turn 2.

## Test-only escape hatches

Most components with module-level state export a `__testing__` object (convention, not enforced):

```ts
export const __testing__ = {
  reset(): void { cache.clear() },
  seed(key: string, data: T): void { cache.set(key, { state: "ready", data }) },
}
```

Tests `reset()` in `beforeEach` to avoid cross-test bleed, and `seed()` to bypass async setup when exercising the hot-path branch. The convention is documented inline; treat it as the expected pattern when new components have caches.

## Common gotchas

- **The walker doesn't recurse on tools.** `emitTool(tool)` packages the tool into a sentinel Element; the walker recognizes the sentinel and pushes the tool into the collector. It does NOT call the tool's `run` function — that happens later, when the model calls it via the tool-exec loop.
- **Components are called on every render.** Don't expect closure state to survive between renders. If you need state, it lives in: (a) the event log via `extraEvents`, (b) a module-level cache, or (c) refs in the existing extension Layer system. Never component-local closures.
- **`useRenderContext()` only works during a render walk.** Calling it from outside (e.g., synchronously at module top-level, or inside a `setTimeout`) returns the default stubs which reject on invoke.
- **Tool descriptions should be concrete.** The model uses these to decide which tools to call. Vague descriptions = bad tool calls. Look at `<Workspace>`'s tool descriptions for the right tone.
