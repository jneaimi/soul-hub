#!/usr/bin/env python3
"""clean-output — Validate and normalize discover-orgs agent output."""
import os, json, sys, re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from output_writer import write_output

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

VALID_TYPES = {"federal", "emirate", "semi-gov", "accelerator", "free-zone", "private", "unknown"}
VALID_RELEVANCE = {"high", "medium", "low", "unknown"}
VALID_QUALITY = {"complete", "partial", "minimal"}
VALID_SOURCE = {"seed_list", "discovered"}


def normalize_org(org: dict) -> dict:
    """Ensure org dict conforms to schema with sensible defaults."""
    return {
        "name_en": str(org.get("name_en") or org.get("name", "Unknown")).strip(),
        "name_ar": str(org.get("name_ar", "")).strip(),
        "type": org.get("type", "unknown") if org.get("type") in VALID_TYPES else "unknown",
        "emirate": str(org.get("emirate", "Unknown")).strip(),
        "website": str(org.get("website", "")).strip(),
        "mandate": str(org.get("mandate", "")).strip(),
        "key_programs": org.get("key_programs") if isinstance(org.get("key_programs"), list) else [],
        "ai_tech_relevance": org.get("ai_tech_relevance", "unknown") if org.get("ai_tech_relevance") in VALID_RELEVANCE else "unknown",
        "ai_programs_found": org.get("ai_programs_found") if isinstance(org.get("ai_programs_found"), list) else [],
        "data_quality": org.get("data_quality", "minimal") if org.get("data_quality") in VALID_QUALITY else "minimal",
        "source": org.get("source", "seed_list") if org.get("source") in VALID_SOURCE else "seed_list",
        "notes": str(org.get("notes", "")).strip(),
    }


def dedup_orgs(orgs: list[dict]) -> list[dict]:
    """Remove duplicate orgs by normalized name."""
    seen = {}
    for org in orgs:
        key = re.sub(r"\s+", " ", org["name_en"].lower().strip())
        if key not in seen:
            seen[key] = org
        else:
            # Keep the one with more data
            existing = seen[key]
            if len(json.dumps(org)) > len(json.dumps(existing)):
                seen[key] = org
    return list(seen.values())


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        write_output({"error": "No input file", "organizations": []})
        return

    raw = json.loads(Path(INPUT_PATH).read_text())

    # Handle both direct array and wrapped object
    if isinstance(raw, list):
        raw_orgs = raw
    else:
        raw_orgs = raw.get("organizations", [])

    # Normalize each org
    orgs = [normalize_org(o) for o in raw_orgs if isinstance(o, dict)]

    # Deduplicate
    orgs = dedup_orgs(orgs)

    # Sort: complete data first, then by name
    quality_order = {"complete": 0, "partial": 1, "minimal": 2}
    orgs.sort(key=lambda o: (quality_order.get(o["data_quality"], 2), o["name_en"]))

    seed_count = sum(1 for o in orgs if o["source"] == "seed_list")
    discovered_count = sum(1 for o in orgs if o["source"] == "discovered")

    output = {
        "discovery_date": raw.get("discovery_date", __import__("datetime").date.today().isoformat()),
        "total_orgs_found": len(orgs),
        "from_seed_list": seed_count,
        "newly_discovered": discovered_count,
        "organizations": orgs,
    }

    print(f"Cleaned: {len(raw_orgs)} raw -> {len(orgs)} unique orgs")
    print(f"  Seed: {seed_count}, Discovered: {discovered_count}")
    print(f"  Complete: {sum(1 for o in orgs if o['data_quality'] == 'complete')}")
    print(f"  Partial: {sum(1 for o in orgs if o['data_quality'] == 'partial')}")
    print(f"  Minimal: {sum(1 for o in orgs if o['data_quality'] == 'minimal')}")

    write_output(output)


if __name__ == "__main__":
    with_error_handling(main)()
