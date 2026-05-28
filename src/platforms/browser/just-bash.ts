// just-bash wrapper for the browser platform.
//
// Vercel Labs' `just-bash` is a pure-TypeScript in-browser bash
// interpreter with a virtual filesystem. This module adapts it to
// Effect's `FileSystem.FileSystem` and `CommandExecutor.CommandExecutor`
// services so `<Workspace>` (and any other component that depends on
// the platform layer) works inside a browser tab — no Node, no system
// binaries, no WASM.
//
// Single shared `Bash` instance per layer: the FileSystem wrap and the
// CommandExecutor wrap both read/write the same VFS, so a `write_file`
// followed by `bash cat /tmp/x` sees consistent state.
//
// Coverage of Effect's FileSystem interface is intentionally narrow:
// only what `<Workspace>` invokes (readFileString, writeFileString,
// exists, stat, readDirectory, makeDirectory). Everything else falls
// through to `FileSystem.makeNoop`'s defaults (which raise BadArgument
// for unimplemented methods).

import {
  CommandExecutor,
  FileSystem,
  Path,
  Error as PlatformErrorMod,
} from "@effect/platform"
import type { Command as PlatformCommand } from "@effect/platform"
import { Bash, type BashOptions, type FsStat } from "just-bash"
import {
  Brand,
  Effect,
  Inspectable,
  Layer,
  Option,
  Sink,
  Stream,
} from "effect"

// -----------------------------------------------------------------
// Error helpers
// -----------------------------------------------------------------

const fsNotFound = (path: string, method: string): PlatformErrorMod.SystemError =>
  new PlatformErrorMod.SystemError({
    module: "FileSystem",
    reason: "NotFound",
    method,
    pathOrDescriptor: path,
    description: `File not found: ${path}`,
  })

const fsUnknown = (
  path: string,
  method: string,
  cause: unknown,
): PlatformErrorMod.SystemError =>
  new PlatformErrorMod.SystemError({
    module: "FileSystem",
    reason: "Unknown",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const cmdUnknown = (
  method: string,
  cause: unknown,
): PlatformErrorMod.SystemError =>
  new PlatformErrorMod.SystemError({
    module: "Command",
    reason: "Unknown",
    method,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

// -----------------------------------------------------------------
// FileSystem wrap
// -----------------------------------------------------------------

const mapStat = (s: FsStat): FileSystem.File.Info => ({
  type: s.isDirectory
    ? "Directory"
    : s.isSymbolicLink
      ? "SymbolicLink"
      : "File",
  mtime: Option.some(s.mtime),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: s.mode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(s.size),
  blksize: Option.none(),
  blocks: Option.none(),
})

export const justBashFileSystemLayer = (
  bash: Bash,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      exists: (path) =>
        Effect.tryPromise({
          try: () => bash.fs.exists(path),
          catch: (e) => fsUnknown(path, "exists", e),
        }),
      readFileString: (path, _encoding) =>
        Effect.tryPromise({
          try: async () => {
            if (!(await bash.fs.exists(path))) {
              throw fsNotFound(path, "readFileString")
            }
            return await bash.fs.readFile(path)
          },
          catch: (e) =>
            e instanceof PlatformErrorMod.SystemError
              ? e
              : fsUnknown(path, "readFileString", e),
        }),
      readFile: (path) =>
        Effect.tryPromise({
          try: async () => {
            if (!(await bash.fs.exists(path))) {
              throw fsNotFound(path, "readFile")
            }
            return await bash.fs.readFileBuffer(path)
          },
          catch: (e) =>
            e instanceof PlatformErrorMod.SystemError
              ? e
              : fsUnknown(path, "readFile", e),
        }),
      writeFileString: (path, data, _options) =>
        Effect.tryPromise({
          try: () => bash.fs.writeFile(path, data),
          catch: (e) => fsUnknown(path, "writeFileString", e),
        }),
      writeFile: (path, data, _options) =>
        Effect.tryPromise({
          try: () => bash.fs.writeFile(path, data),
          catch: (e) => fsUnknown(path, "writeFile", e),
        }),
      makeDirectory: (path, options) =>
        Effect.tryPromise({
          try: () =>
            bash.fs.mkdir(path, { recursive: options?.recursive ?? false }),
          catch: (e) => fsUnknown(path, "makeDirectory", e),
        }),
      readDirectory: (path, _options) =>
        Effect.tryPromise({
          try: () => bash.fs.readdir(path),
          catch: (e) => fsUnknown(path, "readDirectory", e),
        }),
      stat: (path) =>
        Effect.tryPromise({
          try: async () => mapStat(await bash.fs.stat(path)),
          catch: (e) => {
            const msg = e instanceof Error ? e.message : String(e)
            if (/no such file|not exist|ENOENT/i.test(msg)) {
              return fsNotFound(path, "stat")
            }
            return fsUnknown(path, "stat", e)
          },
        }),
      remove: (path, options) =>
        Effect.tryPromise({
          try: () =>
            bash.fs.rm(path, {
              recursive: options?.recursive ?? false,
              force: options?.force ?? false,
            }),
          catch: (e) => fsUnknown(path, "remove", e),
        }),
      rename: (oldPath, newPath) =>
        Effect.tryPromise({
          try: () => bash.fs.mv(oldPath, newPath),
          catch: (e) => fsUnknown(oldPath, "rename", e),
        }),
    }),
  )

// -----------------------------------------------------------------
// CommandExecutor wrap
// -----------------------------------------------------------------

// Render a Command back into a shell script for just-bash.exec. Most
// callers will be `Command.make("bash", "-c", script)` from Workspace's
// `bash` tool — that path forwards the script verbatim. For other
// invocations (e.g. Workspace's `grep` tool calling
// `Command.make("grep", "-rIn", pattern, path)`) we concatenate command
// + args back into a single quoted script and let just-bash's bash
// interpret it (grep is one of just-bash's built-ins).
const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const renderCommandAsScript = (cmd: PlatformCommand.StandardCommand): string => {
  if (cmd.command === "bash" && cmd.args[0] === "-c" && cmd.args.length === 2) {
    return cmd.args[1]!
  }
  return [cmd.command, ...cmd.args].map(shellEscape).join(" ")
}

const flattenCommand = (
  command: PlatformCommand.Command,
): PlatformCommand.StandardCommand => {
  // PipedCommand: glue with `|`. Workspace doesn't currently emit piped
  // commands; this fallback exists so the wrapper handles user-defined
  // tools that do.
  if (command._tag === "PipedCommand") {
    const left = flattenCommand(command.left)
    const right = flattenCommand(command.right)
    const joined = `${renderCommandAsScript(left)} | ${renderCommandAsScript(right)}`
    return {
      ...left,
      command: "bash",
      args: ["-c", joined],
    } as PlatformCommand.StandardCommand
  }
  return command
}

export const justBashCommandExecutorLayer = (
  bash: Bash,
): Layer.Layer<CommandExecutor.CommandExecutor> =>
  Layer.succeed(
    CommandExecutor.CommandExecutor,
    CommandExecutor.makeExecutor((command) =>
      Effect.gen(function* () {
        const std = flattenCommand(command)
        const script = renderCommandAsScript(std)
        const result = yield* Effect.tryPromise({
          try: () => bash.exec(script),
          catch: (e) => cmdUnknown("start", e),
        })
        const encoder = new TextEncoder()
        const stdoutBytes = encoder.encode(result.stdout)
        const stderrBytes = encoder.encode(result.stderr)
        const exit = CommandExecutor.ExitCode(result.exitCode)
        const process: CommandExecutor.Process = {
          [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
          pid: CommandExecutor.ProcessId(0),
          exitCode: Effect.succeed(exit),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stderr: Stream.succeed(stderrBytes),
          stdout: Stream.succeed(stdoutBytes),
          stdin: Sink.drain,
          toJSON() {
            return {
              _id: "@effect/platform/CommandExecutor/Process",
              pid: 0,
              command: std.command,
              args: std.args,
            }
          },
          toString() {
            return `Process(just-bash) ${std.command} ${std.args.join(" ")}`
          },
          [Inspectable.NodeInspectSymbol]() {
            return this.toJSON()
          },
        }
        return process
      }),
    ),
  )

// -----------------------------------------------------------------
// Composed platform layer
// -----------------------------------------------------------------

export interface JustBashPlatformOptions {
  readonly files?: BashOptions["files"]
  readonly env?: BashOptions["env"]
  readonly cwd?: BashOptions["cwd"]
  /**
   * Pre-constructed Bash instance. When provided, takes precedence over
   * `files`/`env`/`cwd`. Use this when you need to share one VFS across
   * multiple layers, or seed it with custom commands.
   */
  readonly bash?: Bash
}

/**
 * Compose a browser-side platform layer that provides FileSystem, Path,
 * and CommandExecutor backed by a single shared `just-bash` instance.
 * `<Workspace>` works fully against this layer, modulo just-bash's
 * "broad bash subset, no system binaries" limit — there is no `cargo`,
 * no `rg`, no real `python3` unless you opt in via the underlying Bash
 * options.
 */
export const justBashPlatform = (
  opts?: JustBashPlatformOptions,
): Layer.Layer<
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> => {
  const bash =
    opts?.bash ??
    new Bash({
      files: opts?.files,
      env: opts?.env,
      cwd: opts?.cwd,
    })
  return Layer.mergeAll(
    justBashFileSystemLayer(bash),
    justBashCommandExecutorLayer(bash),
    Path.layer,
  )
}

// Quiet "imported but not used" for Brand re-export — kept available
// for consumers that want to construct branded values directly.
void Brand
