// Browser runtime adapter.
//
// `@effect/platform-browser` does NOT export a unified context layer
// like Node and Bun do — browsers don't have a uniform FileSystem or
// CommandExecutor surface. What IS available: HTTP client (fetch-
// backed), key-value store (localStorage), WebSocket, plus Clipboard /
// Geolocation / Permissions.
//
// Two platform shapes are exposed here:
//
//   `partialPlatform` — HttpClient only (fetch-backed). `<Workspace>`
//   does not work. Use for browser agents that don't need a workspace.
//
//   `justBashPlatform()` — wires in Vercel Labs' `just-bash` library,
//   exposing a virtual filesystem (Effect's FileSystem.FileSystem) and
//   bash interpreter (Effect's CommandExecutor.CommandExecutor) both
//   backed by one shared `Bash` instance. `<Workspace>` works fully,
//   modulo just-bash's "broad bash subset, no system binaries" limit.
//
// Usage (partial):
//
//   import { createAgentRuntime } from "@flamecast/agentjsx"
//   import { partialPlatform } from "@flamecast/agentjsx/platforms/browser"
//
//   const agent = createAgentRuntime({
//     platform: partialPlatform,
//     infer: myFetchBackedInferFn,
//     context: () => render(
//       <Agent>
//         <Block name="role">...</Block>
//         <Messages />
//       </Agent>
//     ),
//   })
//
// Usage (with workspace, via just-bash):
//
//   import { justBashPlatform } from "@flamecast/agentjsx/platforms/browser"
//   const agent = createAgentRuntime({
//     platform: justBashPlatform({ files: { "/etc/hello": "world" } }),
//     ...
//   })

import { BrowserHttpClient } from "@effect/platform-browser"

export {
  BrowserHttpClient,
  BrowserKeyValueStore,
  BrowserRuntime,
  BrowserSocket,
  BrowserStream,
  BrowserWorker,
  BrowserWorkerRunner,
  Clipboard,
  Geolocation,
  Permissions,
} from "@effect/platform-browser"

// Partial platform layer for browser context. Wires the HTTP client
// (fetch-backed) because most agent setups need it. No FileSystem,
// no CommandExecutor — bring your own if components need them.
export const partialPlatform = BrowserHttpClient.layerXMLHttpRequest

export {
  justBashCommandExecutorLayer,
  justBashFileSystemLayer,
  justBashPlatform,
  type JustBashPlatformOptions,
} from "./just-bash"
