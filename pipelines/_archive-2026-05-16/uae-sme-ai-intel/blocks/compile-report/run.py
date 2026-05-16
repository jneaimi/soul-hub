#!/usr/bin/env python3
"""compile-report — Compile all research outputs into a final intelligence report."""
import os, json, sys
from pathlib import Path
from datetime import date

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

# Multi-input support
INPUT_COUNT = int(os.environ.get("PIPELINE_INPUT_COUNT", "1"))


def read_input(index):
    """Read input file by index."""
    if index == 0:
        path = os.environ.get("PIPELINE_INPUT", "")
    else:
        path = os.environ.get(f"PIPELINE_INPUT_{index}", "")
    if path and Path(path).exists():
        with open(path) as f:
            return f.read()
    return ""


def main():
    # Read all inputs
    org_landscape_raw = read_input(0)  # JSON
    ai_analysis = read_input(1)        # Markdown
    leads_raw = read_input(2)          # JSON

    # Parse JSON inputs
    try:
        org_data = json.loads(org_landscape_raw) if org_landscape_raw else {}
    except json.JSONDecodeError:
        org_data = {}

    try:
        leads_data = json.loads(leads_raw) if leads_raw else {}
    except json.JSONDecodeError:
        leads_data = {}

    # Build org summary table
    org_table = "| # | Organization | Type | Emirate | AI Relevance |\n|---|---|---|---|---|\n"
    orgs = org_data.get("organizations", [])
    for i, org in enumerate(orgs, 1):
        org_table += f"| {i} | {org.get('name_en', 'N/A')} | {org.get('type', 'N/A')} | {org.get('emirate', 'N/A')} | {org.get('ai_tech_relevance', 'N/A')} |\n"

    # Build leads summary table
    leads_table = "| # | Lead | Org | Type | Priority | Deadline |\n|---|---|---|---|---|---|\n"
    leads = leads_data.get("leads", [])
    for i, lead in enumerate(leads, 1):
        leads_table += f"| {i} | {lead.get('title', 'N/A')} | {lead.get('organization', 'N/A')} | {lead.get('type', 'N/A')} | {lead.get('priority', 'N/A')} | {lead.get('deadline', 'N/A')} |\n"

    # Lead summary stats
    lead_summary = leads_data.get("summary", {})
    high = lead_summary.get("high_priority", 0)
    medium = lead_summary.get("medium_priority", 0)
    low = lead_summary.get("low_priority", 0)

    # Compile final report
    report = f"""# UAE SME AI Intelligence Report
**Generated:** {date.today().isoformat()}
**Pipeline:** uae-sme-ai-intel

---

## Table of Contents
1. [Executive Dashboard](#executive-dashboard)
2. [Organization Landscape](#organization-landscape)
3. [AI Programs Analysis](#ai-programs-analysis)
4. [Actionable Leads](#actionable-leads)

---

## Executive Dashboard

- **Organizations Discovered:** {len(orgs)}
- **Total Leads Extracted:** {len(leads)}
- **High Priority Leads:** {high}
- **Medium Priority Leads:** {medium}
- **Low Priority Leads:** {low}

---

## Organization Landscape

{org_table}

---

## AI Programs Analysis

{ai_analysis if ai_analysis else "*No AI analysis data available.*"}

---

## Actionable Leads

{leads_table}

### Immediate Actions
"""
    immediate = lead_summary.get("immediate_actions", [])
    for action in immediate:
        report += f"- {action}\n"

    if not immediate:
        report += "*No immediate actions extracted.*\n"

    report += """
---

*Report compiled automatically by the UAE SME AI Intel pipeline.*
"""

    # Write output
    if OUTPUT_PATH:
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            f.write(report)
        print(f"Output: {OUTPUT_PATH}")
    else:
        print(report)


if __name__ == "__main__":
    with_error_handling(main)()
