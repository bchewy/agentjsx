import { useMemo, useState } from "react"
import { HeroCodeBlock } from "./HeroCodeBlock"

const DEMO_CODE = `const agent = createAgentRuntime({
  infer: createOpenRouterInfer({
    model: "openai/gpt-oss-20b:free",
  }),
  platform: NodeContext.layer,
  context: () => render(
    <Agent>
      <Block name="role">You are a coding assistant.</Block>
      <Workspace root="./" />
      <Skills root="./skills" />
      <Todo />
      <Compact strategy="summary" threshold={4000}>
        <Messages />
      </Compact>
    </Agent>
  ),
})

await agent.run("Inspect this repo. Use todos.")`

type StageId = "tree" | "render" | "context" | "model" | "tools" | "eventlog"
type Slice = "role" | "workspace" | "skills" | "todo" | "messages" | "model"

const STAGES: Array<{
	id: StageId
	label: string
	kicker: string
	title: string
	body: string
	line: number
	slice: Slice
}> = [
	{
		id: "tree",
		label: "01 Tree",
		kicker: "Author",
		title: "Compose the agent as JSX",
		body: "Each component owns a capability: prompt text, tools, state, or history shaping.",
		line: 6,
		slice: "role",
	},
	{
		id: "render",
		label: "02 Render",
		kicker: "Walker",
		title: "Render into fragments and tools",
		body: "The JSX walk collects model-visible fragments and callable tools every turn.",
		line: 8,
		slice: "workspace",
	},
	{
		id: "context",
		label: "03 Context",
		kicker: "Adapter",
		title: "Build ProviderContext",
		body: "System blocks, messages, and tool schemas become the model request.",
		line: 12,
		slice: "messages",
	},
	{
		id: "model",
		label: "04 Model",
		kicker: "OpenRouter",
		title: "Route to a cheap tool model",
		body: "The demo defaults to openai/gpt-oss-20b:free and still supports tool calls.",
		line: 1,
		slice: "model",
	},
	{
		id: "tools",
		label: "05 Tools",
		kicker: "Runtime",
		title: "Execute local capabilities",
		body: "The model asks for list_dir; the runtime executes the workspace tool locally.",
		line: 8,
		slice: "workspace",
	},
	{
		id: "eventlog",
		label: "06 Log",
		kicker: "State",
		title: "Append durable events",
		body: "Messages, tool calls, tool results, and todo updates drive the next render.",
		line: 10,
		slice: "todo",
	},
]

const LINE_STAGE: Record<number, StageId> = {
	1: "model",
	6: "tree",
	7: "tree",
	8: "render",
	9: "render",
	10: "eventlog",
	11: "context",
	12: "context",
	13: "context",
	18: "eventlog",
}

const HIGHLIGHTED_LINES = new Set(Object.keys(LINE_STAGE).map(Number))

const TOOLS = [
	{ name: "bash", group: "workspace" },
	{ name: "read_file", group: "workspace" },
	{ name: "write_file", group: "workspace" },
	{ name: "grep", group: "workspace" },
	{ name: "list_dir", group: "workspace" },
	{ name: "skill_lookup", group: "skills" },
	{ name: "skill_invoke", group: "skills" },
	{ name: "todo_add", group: "todo" },
	{ name: "todo_complete", group: "todo" },
]

const TRACE = [
	{ label: "assistant", text: 'list_dir({"path":"."})' },
	{ label: "runtime", text: "calling list_dir" },
	{ label: "tool", text: "README.md, agent.tsx, cli.tsx, openrouter-agent.tsx" },
	{ label: "assistant", text: "The root contains source files, a README, skills, and config." },
]

function cls(...parts: Array<string | false | null | undefined>) {
	return parts.filter(Boolean).join(" ")
}

function LandingHeader() {
	return (
		<header className="showcase-head">
			<a className="showcase-brand" href="/">
				<span className="brand-mark" aria-hidden="true">ax</span>
				<span>agentjsx</span>
			</a>
			<a className="showcase-head-link" href="https://github.com/bchewy/agentjsx">
				GitHub
			</a>
		</header>
	)
}

function ProviderPanel({ active }: { active: Slice }) {
	return (
		<section className="provider-panel" aria-label="Provider context preview">
			<div className="panel-head">
				<span>ProviderContext</span>
				<span className="panel-chip">rendered each turn</span>
			</div>
			<div className="provider-body">
				<div className={cls("ctx-block", active === "role" && "is-active")}>
					<div className="ctx-block-label">system.role</div>
					<p>You are a coding assistant.</p>
				</div>
				<div className={cls("ctx-block", active === "workspace" && "is-active")}>
					<div className="ctx-block-label">system.workspace</div>
					<p>&lt;workspace root="./"&gt; use list_dir to inspect &lt;/workspace&gt;</p>
				</div>
				<div className={cls("ctx-block", active === "skills" && "is-active")}>
					<div className="ctx-block-label">system.skills</div>
					<p>effect-doctor: Effect primitives, anti-patterns, audit checklist</p>
				</div>
				<div className={cls("ctx-block", active === "todo" && "is-active")}>
					<div className="ctx-block-label">system.todo</div>
					<p>[ ] 0: Inspect repo<br />[ ] 1: Explain architecture</p>
				</div>
				<div className={cls("ctx-block", active === "messages" && "is-active")}>
					<div className="ctx-block-label">messages</div>
					<p>user: Inspect this repo. Use todos.</p>
				</div>
				<div className="tool-cloud" aria-label="Registered tools">
					{TOOLS.map(tool => (
						<span
							key={tool.name}
							className={cls(
								"tool-pill",
								active === tool.group && "is-active",
							)}
						>
							{tool.name}
						</span>
					))}
				</div>
			</div>
		</section>
	)
}

function RuntimeRail({ stage }: { stage: StageId }) {
	const rail = [
		["tree", "JSX tree"],
		["render", "render()"],
		["context", "ProviderContext"],
		["model", "OpenRouter"],
		["tools", "tool loop"],
		["eventlog", "event log"],
	] as const

	return (
		<div className="runtime-rail" aria-label="Runtime pipeline">
			{rail.map(([id, label], index) => (
				<div
					key={id}
					className={cls(
						"rail-node",
						stage === id && "is-active",
						index < rail.findIndex(([candidate]) => candidate === stage) && "is-done",
					)}
				>
					<span className="rail-dot" />
					<span>{label}</span>
				</div>
			))}
		</div>
	)
}

function TracePanel() {
	return (
		<section className="trace-panel" aria-label="OpenRouter test trace">
			<div className="panel-head">
				<span>OpenRouter trace</span>
				<span className="panel-chip">gpt-oss-20b:free</span>
			</div>
			<div className="trace-lines">
				{TRACE.map((row, index) => (
					<div className="trace-line" key={`${row.label}-${index}`}>
						<span className="trace-label">{row.label}</span>
						<span className="trace-text">{row.text}</span>
					</div>
				))}
			</div>
		</section>
	)
}

export function AgentShowcase() {
	const [stageId, setStageId] = useState<StageId>("tree")
	const activeStage = useMemo(
		() => STAGES.find(stage => stage.id === stageId) ?? STAGES[0],
		[stageId],
	)

	return (
		<div className="showcase" data-theme="dark">
			<LandingHeader />
			<main className="showcase-main">
				<section className="showcase-hero" aria-labelledby="showcase-title">
					<div className="hero-copy">
						<div className="eyebrow">AgentJSX showcase</div>
						<h1 id="showcase-title">Agent behavior as a component tree</h1>
						<p>
							A JSX tree renders into system context, tools, messages, and durable
							state. The runtime still does the hard work; JSX makes the agent easy
							to compose and inspect.
						</p>
					</div>
					<TracePanel />
				</section>

				<section className="stage-board" aria-label="Interactive AgentJSX runtime visualization">
					<div className="stage-tabs" role="tablist" aria-label="Visualization stages">
						{STAGES.map(stage => (
							<button
								key={stage.id}
								type="button"
								className={cls("stage-tab", stage.id === stageId && "is-active")}
								onClick={() => setStageId(stage.id)}
							>
								{stage.label}
							</button>
						))}
					</div>

					<div className="stage-inspector">
						<div className="stage-copy">
							<span>{activeStage.kicker}</span>
							<h2>{activeStage.title}</h2>
							<p>{activeStage.body}</p>
						</div>
						<RuntimeRail stage={stageId} />
					</div>

					<div className="visual-grid">
						<section className="code-panel" aria-label="Agent JSX source">
							<div className="panel-head">
								<span>openrouter-agent.tsx</span>
								<span className="panel-chip">source map</span>
							</div>
							<HeroCodeBlock
								code={DEMO_CODE}
								highlightedLines={HIGHLIGHTED_LINES}
								activeLine={activeStage.line}
								onLineClick={(line) => setStageId(LINE_STAGE[line] ?? "tree")}
							/>
						</section>

						<ProviderPanel active={activeStage.slice} />
					</div>
				</section>
			</main>
		</div>
	)
}
