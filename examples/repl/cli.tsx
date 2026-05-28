// Interactive agentjsx REPL.
//
// Run from this directory:
//
//   AI_GATEWAY_API_KEY=... npx tsx cli.tsx
//
// or under Infisical (Smithery contributors):
//
//   infisical run --silent -- npx tsx cli.tsx

import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import { Agent, Block, Workspace, Messages } from "@flamecast/agentjsx/components"
import { createInterface } from "node:readline/promises"

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
const BLUE = (s: string) => `\x1b[34m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`

const apiKey = process.env.AI_GATEWAY_API_KEY
if (!apiKey) {
	console.error("Set AI_GATEWAY_API_KEY (or run under `infisical run --silent`).")
	process.exit(1)
}

const agent = createAgentRuntime({
	infer: createAiGatewayInfer({ apiKey, model: "anthropic/claude-sonnet-4-6" }),
	context: () => render(
		<Agent>
			<Block name="role">You are a helpful coding assistant. Be concise. Use tools when the user asks about files.</Block>
			<Workspace root="./" />
			<Messages />
		</Agent>
	),
})

const rl = createInterface({ input: process.stdin, output: process.stdout })

console.log(DIM(`agentjsx REPL  ·  ctrl-c to exit\n`))

let shuttingDown = false
const shutdown = async () => {
	if (shuttingDown) return
	shuttingDown = true
	rl.close()
	await agent.dispose()
	process.exit(0)
}
process.on("SIGINT", shutdown)

async function turn(input: string): Promise<void> {
	const startLen = (await agent.events()).length
	await agent.send(input)

	let printed = startLen
	while (true) {
		await new Promise((r) => setTimeout(r, 80))
		const events = await agent.events()
		for (let i = printed; i < events.length; i++) {
			const e = events[i]!
			if (e.type === "tool.call.started") {
				console.log(DIM(`  ${YELLOW("→")} calling ${e.tool_name}`))
			} else if (e.type === "tool.result") {
				const snippet = e.content.length > 80 ? `${e.content.slice(0, 80)}…` : e.content
				console.log(DIM(`  ${YELLOW("←")} ${snippet}`))
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

try {
	while (true) {
		const input = (await rl.question(`${BLUE("you")}    `)).trim()
		if (!input) continue
		await turn(input)
		console.log()
	}
} catch (err) {
	if (!shuttingDown) console.error(err)
	await shutdown()
}
