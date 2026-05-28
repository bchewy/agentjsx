// The agent definition for the REPL example.
//
// Pulled out of cli.tsx so the JSX context tree (role, workspace, skills,
// MCP, todos, summarization) is readable without grinding through readline
// and lifecycle plumbing.

import { NodeContext } from "@effect/platform-node"
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
	Agent,
	Block,
	Compact,
	McpServer,
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

export function createCodingAgent(opts: { apiKey: string }): ReturnType<typeof createAgentRuntime> {
	return createAgentRuntime({
		infer: createAiGatewayInfer({ apiKey: opts.apiKey, model: "anthropic/claude-sonnet-4-6" }),
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
					<McpServer
						name="deepwiki"
						url="https://mcp.deepwiki.com/mcp"
					/>
					<Todo />
					<Compact strategy="summary" threshold={4000}>
						<Messages />
					</Compact>
				</Agent>,
			),
	})
}
