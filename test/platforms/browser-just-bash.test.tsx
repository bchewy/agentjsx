// End-to-end test for the browser platform's just-bash adapter.
//
// just-bash is pure TypeScript, so it runs fine under Node/vitest. The
// test drives a real `<Workspace>` against `justBashPlatform()` and
// asserts the four tools (write_file, read_file, bash, list_dir) all
// hit the same VFS — bash-tool writes and fs-tool reads see consistent
// state across `Bash.exec()` calls.

import { describe, expect, it } from "vitest"
import { createAgentRuntime, render } from "@flamecast/agentjsx"
import {
  Agent,
  Block,
  createElement,
  Messages,
  Workspace,
} from "@flamecast/agentjsx/components"
import type { Event, InferFn, ProviderContext } from "@flamecast/agentjsx"
import { justBashPlatform } from "../../src/platforms/browser"

void createElement

describe("@flamecast/agentjsx/platforms/browser just-bash workspace e2e", () => {
  it("wires FileSystem + CommandExecutor against a shared VFS", async () => {
    const seenContexts: ProviderContext[] = []
    let turn = 0
    const infer: InferFn = async (context) => {
      seenContexts.push(context)
      turn++
      if (turn === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "hello.txt",
                  contents: "world",
                }),
              },
            },
          ],
        }
      }
      if (turn === 2) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_read",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "hello.txt" }),
              },
            },
          ],
        }
      }
      if (turn === 3) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_bash",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: "echo greetings > /tmp/g.txt && cat /tmp/g.txt",
                }),
              },
            },
          ],
        }
      }
      if (turn === 4) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_list",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ path: "/tmp" }),
              },
            },
          ],
        }
      }
      return { content: "done", tool_calls: [] }
    }

    const agent = createAgentRuntime({
      infer,
      platform: justBashPlatform(),
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <Workspace root="/tmp" />
            <Messages />
          </Agent>,
        ),
    })

    try {
      await agent.run("go")
      const finalMsg = await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!
          if (e.type === "assistant.message" && e.content === "done") return e
        }
        return null
      })
      expect(finalMsg.type).toBe("assistant.message")

      const events = await agent.events()
      const findResult = (id: string) =>
        events.find(
          (e) => e.type === "tool.result" && e.tool_call_id === id,
        ) as Extract<Event, { type: "tool.result" }> | undefined

      const writeRes = findResult("call_write")
      expect(writeRes).toBeDefined()
      expect(writeRes!.content).toMatch(/Wrote 5 chars/)

      const readRes = findResult("call_read")
      expect(readRes).toBeDefined()
      expect(readRes!.content).toBe("world")
      expect(readRes!.content).not.toMatch(/\[read_file\] Error/)

      const bashRes = findResult("call_bash")
      expect(bashRes).toBeDefined()
      expect(bashRes!.content).toContain("greetings")
      expect(bashRes!.content).not.toMatch(/\[bash\] Error/)

      const listRes = findResult("call_list")
      expect(listRes).toBeDefined()
      // Workspace root is /tmp, so both files land here. list_dir
      // listing /tmp must see hello.txt (written via fs tool) AND
      // g.txt (written via bash tool) — proves VFS is shared across
      // CommandExecutor and FileSystem.
      expect(listRes!.content).toContain("hello.txt")
      expect(listRes!.content).toContain("g.txt")

      expect(turn).toBe(5)
    } finally {
      await agent.dispose()
    }
  })
})
