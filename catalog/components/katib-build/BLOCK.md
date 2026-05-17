---
name: katib-build
version: 1.0.0
type: component
category: build
tier: 2
runtime: node
description: Render a katib recipe to PDF via `uv run scripts/build.py` in ~/dev/katib. Tier-2 domain adapter per ADR-006 D4 — owns brand/lang/skip-audit semantics + build.log failure parsing. Reusable for any Naseej recipe that produces a katib PDF.
author: jasem
project: naseej

inputs:
  - name: recipe_path
    type: string
    required: true
    description: Absolute path to the katib recipe YAML (the synthesised recipe, not the Naseej recipe). Passed verbatim as the first positional arg to scripts/build.py.
  - name: out_pdf
    type: string
    required: true
    description: Absolute path where katib should write the rendered PDF.
  - name: lang
    type: string
    enum: [en, ar]
    default: en
    description: Render language — en (LTR) or ar (RTL). Passed as `--lang`.
  - name: brand
    type: string
    default: jasem
    description: Brand identifier resolved by katib's brand registry. Passed as `--brand`.
  - name: skip_audit_check
    type: boolean
    default: true
    description: When true, passes `--skip-audit-check` to katib (the daily peer-brief path; PDFs that are not audit-gated). Set false for audit-gated builds.
  - name: katib_project_dir
    type: string
    description: Katib repo dir. Defaults to ~/dev/katib. Override for tests or sibling katib clones.
  - name: timeout_sec
    type: integer
    default: 300
    description: Wall-clock cap on the katib subprocess. Typical daily peer-brief builds complete in 30-60s; default 300 gives headroom for cold WeasyPrint imports + large signal-cluster pages.

outputs:
  - name: pdf_path
    type: string
    description: Absolute path of the rendered PDF (echo of out_pdf input on success).
  - name: pdf_size_bytes
    type: integer
    description: Size of the rendered PDF on disk. Useful for parity checks during shadow runs.
  - name: build_duration_ms
    type: integer
    description: Wall-clock time the katib subprocess ran.
  - name: brand_resolved
    type: string
    description: Echo of the brand input — surfaced so the recipe can branch on it without re-templating.
  - name: error_summary
    type: string
    description: 'Set only on failure. Last ERROR/WeasyPrint line found in the build.log tail (last 40 lines). For full triage, read build_log_tail.'
  - name: build_log_tail
    type: string
    description: Set only on failure. Last 20 lines of combined stdout+stderr from katib.

invocation:
  protocol: stdin-json
  request: '{ recipe_path, out_pdf, lang?, brand?, skip_audit_check?, katib_project_dir?, timeout_sec? }'
  response: '{ pdf_path, pdf_size_bytes, build_duration_ms, brand_resolved } | { error, error_summary?, build_log_tail?, exit_code, build_duration_ms }'
  exit_codes:
    0: PDF rendered + stat-checked successfully
    1: katib subprocess exited non-zero OR succeeded but PDF missing from disk
    2: bad input (missing recipe_path/out_pdf, invalid lang enum, non-absolute paths, etc.)
    124: katib subprocess exceeded timeout_sec and was killed
---

# katib-build

Naseej's Tier-2 domain adapter for katib PDF renders. Wraps the `uv run scripts/build.py` invocation pattern already used by `scripts/peer-brief-render.py`, owning the failure-parsing + PDF-stat semantics so recipes don't have to.

## When to use

Any Naseej recipe that needs to render a katib recipe to PDF. The classic case is the daily peer-brief flow (ADR-007), where a synthesis agent produces a katib recipe and this component renders it.

## When NOT to use

Don't wrap `katib build` in `shell-exec` — this component exists for that exact reason. If you find yourself templating `uv run scripts/build.py …` into a `shell-exec` step, switch to `katib-build` instead.

## Failure parsing

On non-zero exit from katib, the component:

1. Captures combined stdout + stderr from the subprocess
2. Splits into lines and takes the last 40
3. Scans (in reverse) for the most recent line matching `/ERROR|WeasyPrint/i`
4. Surfaces that line as `error_summary` and the last 20 lines as `build_log_tail`

This mirrors the triage flow `peer-brief-render.py` did manually — saves the operator a tmp-dir grep when shadow runs diverge.

## Example

```yaml
- id: render
  component: katib-build@1.0.0
  inputs:
    recipe_path: "{{steps.synth.outputs.artifact_path}}"
    out_pdf: "{{inputs.out_pdf}}"
    lang: en
    brand: jasem
    skip_audit_check: true
```

## Security

Spawns `uv` directly via `child_process.spawn` (no shell, no `/bin/sh -c`). All arguments — `recipe_path`, `out_pdf`, `brand` — are passed verbatim as argv slots, so no shell-metacharacter injection. `katib_project_dir` controls the subprocess cwd; ensure recipes use trusted paths (`~/dev/katib` by default).
