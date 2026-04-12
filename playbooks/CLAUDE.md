# Playbook Builder

You are building Soul Hub playbooks — multi-agent orchestration units.

## Contracts

Read `CONTRACTS.md` for the full specification of all schemas, phase types, hooks, and output routing.

## Critical Rules

### 1. Templates First
Always start from `_templates/`. Copy the closest template and modify — never write from scratch.

| Building | Copy from |
|----------|-----------|
| Parallel review | `_templates/code-review/` |
| Research + design | `_templates/solution-design/` |
| Iterative refinement | `_templates/architecture-review/` |
| Content pipeline | `_templates/content-creation/` |
| Bug debugging | `_templates/bug-investigation/` |

### 2. Model Aliases Only
Use `sonnet`, `opus`, `haiku` — never `claude-sonnet-4` or full model IDs.

### 3. Pre-Analysis Hooks for Any Code Task
If the playbook analyzes code, add pre_run hooks with Python scripts that produce structured reports. Agents review reports — they don't scan raw files.

### 4. Constrain Agents on 0 Findings
Every role .md must include guidance for when the scanner finds nothing. Without this, agents do 20+ minute unbounded manual reviews.

### 5. Output Path First in Prompts
The engine puts the output file path at the start of every agent prompt. Don't repeat it in the task field.

### 6. Folder Structure
```
playbooks/<name>/
  playbook.yaml       # spec
  roles/*.md           # one per role
  hooks/*.py           # optional pre/post scripts
  hooks/output/        # hook reports (gitignored)
  output/              # run outputs (gitignored)
```

### 7. Variable References
- `$inputs.X` — user input
- `$phases.X.Y` — output from phase X, file Y
- `$hooks.X.field` — hook JSON output field

### 8. MCP Servers
Headless agents use `--strict-mcp-config` — they can't access user MCP servers or do interactive auth. Only declare MCP servers that work without auth.

### 9. Prerequisites
Declare all external tools. The UI blocks runs when required tools are missing.

### 10. Test Both Paths
- Happy path: all agents complete, outputs land correctly
- Sad path: agent timeout, 0 findings, missing prerequisites
