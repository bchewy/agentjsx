// OpenRouter-backed agent definition for the REPL example.
//
// This mirrors agent.tsx, but swaps the provider to OpenRouter so the demo can
// run with OPENROUTER_API_KEY and an OpenRouter model id.

import { NodeContext } from "@effect/platform-node"
import { createAgentRuntime, createOpenRouterInfer, render } from "@flamecast/agentjsx"
import {
	Agent,
	Block,
	Compact,
	Messages,
	Skills,
	Todo,
	Workspace,
} from "@flamecast/agentjsx/components"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SKILLS_ROOT = path.resolve(__dirname, "./skills")
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-20b:free"

export function createOpenRouterCodingAgent(opts: {
	apiKey: string
	model?: string
}): ReturnType<typeof createAgentRuntime> {
	return createAgentRuntime({
		infer: createOpenRouterInfer({
			apiKey: opts.apiKey,
			model: opts.model ?? DEFAULT_OPENROUTER_MODEL,
			appName: "agentjsx-openrouter-demo",
			referer: "https://github.com/bchewy/agentjsx",
		}),
		platform: NodeContext.layer,
		context: () =>
			render(
				<Agent>
					<Block name="role">
						You are a helpful coding assistant working in the current directory. Use
						tools to inspect and modify files. Track multi-step work as todos. Look
						up skills for guidance on conventions.
					</Block>
					<Workspace root="./" />
					<Skills root={SKILLS_ROOT} />
					<Todo />
					<Compact strategy="summary" threshold={4000}>
						<Messages />
					</Compact>
				</Agent>,
			),
	})
}
