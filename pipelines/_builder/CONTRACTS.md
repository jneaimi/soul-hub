# Soul Hub Builder Contracts

## 1. Input Contract

### Config Files
- Location: `config/*.json`
- Schema defined in `pipeline.yaml` under `shared_config[].columns`
- Column types: `text`, `select`, `number`
- Read at runtime via `BLOCK_CONFIG_*` env vars or `json_config.py` component

### Runtime Parameters (BLOCK_CONFIG_*)
- Each `config` field in BLOCK.md maps to `BLOCK_CONFIG_<UPPER_NAME>`
- Types: `text`, `number`, `select`, `multiselect`, `toggle`, `file`, `textarea`
- Set by runner before block execution

### Pipeline Inputs (PIPELINE_INPUT)
- Declared in `pipeline.yaml` under `inputs`
- Passed as env var `PIPELINE_INPUT` (file path or value)
- Types: `text`, `number`, `select`, `file`

### Secrets (env)
- Declared in BLOCK.md under `env:`
- Values from platform environment, never hardcoded
- `required: true` blocks execution if missing

## 2. Output Contract

### File Outputs
- Written to `PIPELINE_OUTPUT` env var path
- `format` field in BLOCK.md determines UI renderer

| Format | Renderer |
|--------|----------|
| `json` | JSON viewer |
| `markdown` | Markdown preview |
| `csv` | Table view |
| `image/png` | Image viewer |
| `image/jpg` | Image viewer |
| `image/svg` | SVG inline |
| `video/mp4` | Video player |
| `audio/mp3` | Audio player |
| `pdf` | PDF viewer |
| `html` | HTML iframe |
| `text` | Plain text |

### Action Outputs
- Non-file side effects declared in BLOCK.md `outputs` with `type: action`

| Action | Description |
|--------|-------------|
| `log` | Append to log file |
| `channel` | Post to channel/webhook |
| `db-write` | Write rows to SQLite |
| `api-push` | Push to external API |
| `webhook` | Fire outbound webhook |

### Output Declaration in BLOCK.md
```yaml
outputs:
  - name: report
    type: file
    format: markdown
    description: Weekly summary report
  - name: notify
    type: action
    action: channel
    description: Post summary to Slack
```

## 3. Storage Contract

### SQLite
- Path: `db/data.db`
- Schema: `db/schema.sql` (applied on first run via `db_init.py`)
- One DB per pipeline, blocks share it

### Config
- Path: `config/*.json`
- Must be JSON with columns defined in `pipeline.yaml`
- Editable via UI (SharedConfigEditor)

### Output
- Path: `output/`
- Each step writes to `output/<step-id>-result.<ext>`
- Created at runtime, not committed

### Temp
- Path: `/tmp/pipeline-runs/<run-id>/`
- Cleared after run completes

## 4. Manifest Contract (BLOCK.md)

### Required Fields
```yaml
name: string          # unique block identifier
type: script|agent    # execution type
description: string   # one-line summary
```

### Optional Fields
```yaml
runtime: python|node  # for script blocks
author: string
version: semver
model: sonnet|opus|haiku  # for agent blocks
```

### Config Field Types
| Type | Widget | Value |
|------|--------|-------|
| `text` | Text input | string |
| `number` | Number input | number (min/max) |
| `select` | Dropdown | string (from options) |
| `multiselect` | Multi-checkbox | string[] (from options) |
| `toggle` | Switch | boolean |
| `file` | File picker | path string |
| `textarea` | Text area | string |

### Output Format Declarations
Every block MUST declare its outputs in BLOCK.md:
```yaml
outputs:
  - name: output_name
    type: file|action|db-table
    format: json|markdown|csv|...  # for type: file
    action: log|channel|...        # for type: action
    table: table_name              # for type: db-table
    description: what this output is
```

### Env Declarations
```yaml
env:
  - name: ENV_VAR_NAME
    description: what it's for
    required: true|false
```

## 5. Pipeline YAML Contract

### Required Sections
```yaml
name: string
description: string
steps: [...]
```

### Optional Sections
```yaml
version: semver
env: [...]
inputs: [...]
shared_config: [...]
on_failure: { strategy: halt|continue|retry }
```

### shared_config with Columns
```yaml
shared_config:
  - name: Display Name
    file: config/data.json
    description: what this config controls
    columns:
      - name: field_name
        type: text|select|number
        label: Human Label
        placeholder: "hint"
        required: true
        options: [a, b]  # select only
```

### Step Types Whitelist
Only valid types: `script`, `agent`, `approval`, `prompt`, `channel`

### Output Paths
Each step should declare its output path:
```yaml
steps:
  - id: step-id
    block: block-name
    output: output/step-id-result.json
    timeout: 300
```
