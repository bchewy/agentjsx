// OpenRouter REPL — interactive or one-shot non-interactive mode.
//
// Interactive:
//   OPENROUTER_API_KEY=... pnpm start:openrouter
//
// Non-interactive:
//   OPENROUTER_API_KEY=... pnpm start:openrouter "list files in src/"
//   echo "what's in here?" | OPENROUTER_API_KEY=... pnpm start:openrouter --stdin
//
// Optional:
//   OPENROUTER_MODEL=qwen/qwen3-coder-next pnpm start:openrouter "..."

import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises"
import { DEFAULT_OPENROUTER_MODEL, createOpenRouterCodingAgent } from "./openrouter-agent"

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
const BLUE = (s: string) => `\x1b[34m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`

type AgentRuntime = ReturnType<typeof createOpenRouterCodingAgent>

async function turn(agent: AgentRuntime, input: string): Promise<void> {
	const startLen = (await agent.events()).length
	await agent.run(input)

	let printed = startLen
	while (true) {
		await new Promise((r) => setTimeout(r, 80))
		const events = await agent.events()
		for (let i = printed; i < events.length; i++) {
			const e = events[i]!
			if (e.type === "tool.call.started") {
				console.log(DIM(`  ${YELLOW("->")} calling ${e.tool_name}`))
			} else if (e.type === "tool.result") {
				const snippet = e.content.length > 80 ? `${e.content.slice(0, 80)}...` : e.content
				console.log(DIM(`  ${YELLOW("<-")} ${snippet}`))
			} else if (e.type === "assistant.message") {
				if (e.content.length > 0) console.log(`${GREEN("agent")}  ${e.content}`)
				if (e.tool_calls?.length) {
					for (const tc of e.tool_calls) {
						console.log(DIM(`  ${tc.function.name}(${tc.function.arguments})`))
					}
				}
			} else if (e.type === "inference.failed") {
				console.log(DIM(`  ${YELLOW("!")} inference failed: ${e.cause}`))
			} else if (e.type === "assistant.halted") {
				console.log(DIM(`  ${YELLOW("!")} halted: ${e.reason}`))
			}
		}
		printed = events.length

		const last = events[events.length - 1]
		const noPendingTools = !last || last.type !== "assistant.message" || !last.tool_calls?.length
		const isTerminal =
			(last?.type === "assistant.message" && noPendingTools) ||
			last?.type === "assistant.halted" ||
			last?.type === "inference.failed"
		if (isTerminal) break
	}
}

const program = Effect.gen(function* () {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		return yield* Effect.die(new Error("Set OPENROUTER_API_KEY before running this demo."))
	}

	const model = process.env.OPENROUTER_MODEL
	const agent = createOpenRouterCodingAgent({ apiKey, ...(model ? { model } : {}) })

	yield* Effect.addFinalizer(() => Effect.promise(() => agent.dispose()))

	const args = process.argv.slice(2)
	const useStdin = args.includes("--stdin")
	const positional = args.filter((a) => !a.startsWith("--")).join(" ").trim()

	if (positional || useStdin) {
		const prompt = useStdin
			? (yield* Effect.promise(() => readAllStdin())).trim()
			: positional
		if (!prompt) {
			return yield* Effect.die(new Error("Empty prompt (positional args or --stdin)."))
		}
		yield* Effect.promise(() => turn(agent, prompt))
		return
	}

	const rl: ReadlineInterface = createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	yield* Effect.addFinalizer(() => Effect.sync(() => rl.close()))

	yield* Console.log(
		DIM(`agentjsx OpenRouter REPL  ·  model ${model ?? DEFAULT_OPENROUTER_MODEL}  ·  ctrl-c to exit`) +
			"\n",
	)

	while (true) {
		const raw = yield* Effect.tryPromise({
			try: () => rl.question(`${BLUE("you")}    `),
			catch: () => "__exit__" as const,
		})
		const input = raw.trim()
		if (input === "__exit__") return
		if (!input) continue

		yield* Effect.promise(() => turn(agent, input))
		yield* Console.log("")
	}
}).pipe(Effect.scoped)

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString("utf8")
}

NodeRuntime.runMain(program)
