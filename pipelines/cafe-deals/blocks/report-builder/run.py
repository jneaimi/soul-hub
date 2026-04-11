# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""report-builder — Generate a cafe guide with top picks, value spots, deals, and warnings."""
import os, json, sys
from pathlib import Path
from datetime import date

_comp = Path(os.environ.get("PIPELINE_DIR", "")).parent / "_builder" / "components"
if not _comp.is_dir():
    _comp = Path(__file__).resolve().parent
    while _comp != _comp.parent:
        if (_comp / "_builder" / "components").is_dir():
            _comp = _comp / "_builder" / "components"
            break
        _comp = _comp.parent
sys.path.insert(0, str(_comp))
from error_handler import with_error_handling
from output_writer import write_output

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
PRICE_LABELS = {0: "Free", 1: "$", 2: "$$", 3: "$$$", 4: "$$$$"}

SENTIMENT_ICON = {
    "very_positive": "+",
    "positive": "+",
    "mostly_positive": "+",
    "mixed": "~",
    "negative": "-",
    "neutral": "~",
    "unknown": "?",
}


def load_cafe_source() -> dict:
    """Load original cafe-finder data for address/maps_url/reviews."""
    pipeline_dir = os.environ.get("PIPELINE_DIR", "")
    finder_path = Path(pipeline_dir) / "output" / "find-cafes-result.json" if pipeline_dir else None
    if finder_path and finder_path.exists():
        try:
            finder_data = json.loads(finder_path.read_text())
            return {c.get("name", "").lower(): c for c in finder_data.get("cafes", [])}
        except (json.JSONDecodeError, KeyError):
            pass
    return {}


def normalize(data: dict) -> tuple[str, list[dict], dict]:
    """Normalize agent output into a unified cafe list + insights dict."""
    location = data.get("location", "Unknown")
    insights = data.get("insights", {})
    cafe_source = load_cafe_source()

    # Spec'd format: {"cafes": [{deal_score, ...}]}
    if "cafes" in data and isinstance(data["cafes"], list) and data["cafes"] and "deal_score" in data["cafes"][0]:
        for c in data["cafes"]:
            src = cafe_source.get(c.get("name", "").lower(), {})
            c.setdefault("address", src.get("address", ""))
            c.setdefault("maps_url", src.get("maps_url", ""))
            c.setdefault("highlights", [])
            c.setdefault("concerns", [])
            c.setdefault("recommendation", "")
            c.setdefault("sentiment", "neutral")
            c.setdefault("value_score", "unknown")
            c.setdefault("status", src.get("business_status", "OPERATIONAL"))
        return location, data["cafes"], insights

    # Agent format: {"all_cafes": [...], "top_picks": [...], "active_deal_signals": [...]}
    all_cafes = data.get("all_cafes", [])
    if all_cafes:
        # Build lookup from top_picks for richer data (address, maps_url, highlights)
        top_picks_by_name = {}
        for tp in data.get("top_picks", []):
            top_picks_by_name[tp.get("name", "").lower()] = tp

        # Build deal signals lookup
        deal_signals_by_cafe = {}
        for ds in data.get("active_deal_signals", []):
            deal_signals_by_cafe.setdefault(ds.get("cafe", "").lower(), []).append(ds)

        # Map deal_tier to value_score
        tier_to_value = {
            "excellent_deal": "excellent",
            "good_deal": "good",
            "average": "average",
            "flagged": "poor",
            "skip": "poor",
            "not_a_cafe": "poor",
            "insufficient_data": "unknown",
        }

        normalized = []
        for cafe in all_cafes:
            name = cafe.get("name", "Unknown")
            name_lower = name.lower()
            src = cafe_source.get(name_lower, {})
            tp = top_picks_by_name.get(name_lower, {})
            signals = deal_signals_by_cafe.get(name_lower, [])

            # Merge address/maps_url from top_picks or cafe_source
            address = tp.get("address") or src.get("address", "")
            maps_url = tp.get("maps_url") or src.get("maps_url", "")

            # Build highlights from top_picks or value_signals
            highlights = tp.get("highlights", []) or cafe.get("value_signals", [])

            # Build concerns from caveats
            caveats_str = tp.get("caveats") or cafe.get("caveats", "")
            concerns = [caveats_str] if caveats_str else []
            # Add flags as concerns
            for f in cafe.get("flags", []):
                if isinstance(f, str):
                    concerns.append(f)

            # Build deal_details from active_deal_signals
            deal_details = []
            for ds in signals:
                deal_details.append({
                    "type": "deal",
                    "description": ds.get("deal", ""),
                    "confidence": ds.get("confidence", "medium"),
                    "recency": "recent",
                })

            normalized.append({
                "name": name,
                "address": address,
                "rating": cafe.get("rating"),
                "price_level": cafe.get("price_level"),
                "maps_url": maps_url,
                "status": cafe.get("business_status", "OPERATIONAL"),
                "deal_score": cafe.get("deal_score", 0),
                "deal_summary": "; ".join(ds.get("deal", "") for ds in signals) or "",
                "deal_details": deal_details,
                "sentiment": cafe.get("sentiment", "neutral"),
                "value_score": tier_to_value.get(cafe.get("deal_tier", ""), "unknown"),
                "highlights": highlights,
                "concerns": concerns,
                "recommendation": tp.get("price_notes", ""),
            })

        return location, normalized, insights

    # Agent deviation: {"cafe_analysis": [...], "deals": [...]}
    cafes_analysis = data.get("cafe_analysis", [])
    deals_list = data.get("deals", [])
    if not cafes_analysis:
        return location, [], insights

    deals_by_cafe = {}
    for d in deals_list:
        deals_by_cafe.setdefault(d.get("cafe", "").lower(), []).append(d)

    normalized = []
    for cafe in cafes_analysis:
        name = cafe.get("name", "Unknown")
        src = cafe_source.get(name.lower(), {})
        matched_deals = deals_by_cafe.get(name.lower(), [])

        score = 0
        details = []
        for d in matched_deals:
            conf = d.get("confidence", "low")
            score += {"high": 4, "medium": 2, "low": 1}.get(conf, 1)
            details.append({
                "type": d.get("deal_type", "offer"),
                "description": d.get("description", ""),
                "confidence": conf,
                "recency": "recent" if "recent" in d.get("notes", "").lower() else "unknown",
            })

        normalized.append({
            "name": name,
            "address": src.get("address", ""),
            "rating": cafe.get("rating"),
            "price_level": cafe.get("price_level"),
            "maps_url": src.get("maps_url", ""),
            "status": cafe.get("status", src.get("business_status", "OPERATIONAL")),
            "deal_score": min(score, 10),
            "deal_summary": "; ".join(d.get("description", "") for d in matched_deals) or "",
            "deal_details": details,
            "sentiment": cafe.get("sentiment", "neutral"),
            "value_score": cafe.get("value_score", "unknown"),
            "highlights": cafe.get("highlights", []),
            "concerns": cafe.get("concerns", []),
            "recommendation": cafe.get("recommendation", ""),
        })

    return location, normalized, insights


def cafe_line(c: dict, idx: int) -> list[str]:
    """Render a single cafe card."""
    name = c.get("name", "Unknown")
    rating = c.get("rating")
    price = PRICE_LABELS.get(c.get("price_level"), "")
    maps_url = c.get("maps_url", "")
    address = c.get("address", "")
    recommendation = c.get("recommendation", "")

    rating_str = f"{rating}/5" if rating else "N/A"
    price_str = f" | {price}" if price else ""
    sentiment = SENTIMENT_ICON.get(c.get("sentiment", ""), "")

    lines = [f"### {idx}. {name}"]
    lines.append(f"Rating: **{rating_str}**{price_str} | Vibe: {sentiment}")
    lines.append("")

    if recommendation:
        lines.append(f"> {recommendation}")
        lines.append("")

    highlights = c.get("highlights", [])
    if highlights:
        for h in highlights[:3]:
            lines.append(f"- {h}")
        lines.append("")

    concerns = c.get("concerns", [])
    if concerns:
        for w in concerns[:2]:
            lines.append(f"- **Watch out:** {w}")
        lines.append("")

    # Deals if any
    deal_details = c.get("deal_details", [])
    if deal_details:
        for d in deal_details:
            lines.append(f"- **Deal — {d.get('type', 'offer')}:** {d.get('description', '')} *({d.get('confidence', '?')})*")
        lines.append("")

    if address:
        lines.append(f"*{address}*")
    if maps_url:
        lines.append(f"[Google Maps]({maps_url})")
    lines.append("")
    return lines


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise RuntimeError("No input file — PIPELINE_INPUT not set or file missing")

    data = json.loads(Path(INPUT_PATH).read_text())
    location, cafes, insights = normalize(data)

    # Classify cafes into buckets
    operational = [c for c in cafes if c.get("status", "") != "CLOSED_TEMPORARILY"]
    closed = [c for c in cafes if c.get("status", "") == "CLOSED_TEMPORARILY"]

    top_picks = sorted(
        [c for c in operational if (c.get("rating") or 0) >= 4.3 and c.get("sentiment") in ("very_positive", "positive", "mostly_positive")],
        key=lambda c: c.get("rating") or 0, reverse=True
    )[:5]
    top_pick_names = {c["name"] for c in top_picks}

    best_value = [c for c in operational if c.get("value_score") in ("excellent", "good") and c["name"] not in top_pick_names]
    best_value.sort(key=lambda c: {"excellent": 0, "good": 1}.get(c.get("value_score", ""), 9))
    best_value = best_value[:5]
    value_names = {c["name"] for c in best_value}

    hidden_gems = [
        c for c in operational
        if (c.get("rating") or 0) >= 4.5
        and c.get("value_score") == "unknown"
        and c["name"] not in top_pick_names | value_names
    ][:3]

    with_deals = [c for c in operational if c.get("deal_score", 0) > 0]

    skip_these = [
        c for c in cafes
        if c.get("sentiment") in ("negative",)
        or c.get("value_score") == "poor"
        or c.get("status") == "CLOSED_TEMPORARILY"
    ]

    # --- Build report ---
    lines = [
        f"# Cafe Guide — {location.title()}",
        f"*{date.today().isoformat()}*",
        "",
        f"**{len(operational)}** cafes open | **{len(with_deals)}** with deals | **{len(skip_these)}** to skip",
        "",
    ]

    # Insights summary if available
    if insights:
        lines.append("---")
        lines.append("")
        lines.append("## At a Glance")
        lines.append("")
        if isinstance(insights, list):
            for item in insights:
                lines.append(f"- {item}")
        else:
            for key, label in [
                ("best_overall", "Best Overall"),
                ("best_for_coffee", "Best Coffee"),
                ("best_for_healthy", "Best Healthy"),
                ("best_budget", "Best Budget"),
            ]:
                val = insights.get(key)
                if val:
                    lines.append(f"- **{label}:** {val}")
            apps = insights.get("app_deals_available", [])
            if apps:
                lines.append(f"- **App Deals:** {', '.join(apps)}")
            park_cafes = insights.get("cafes_inside_theme_parks", [])
            if park_cafes:
                lines.append(f"- **Inside Theme Parks:** {', '.join(park_cafes)}")
            svc = insights.get("service_sentiment")
            if svc:
                lines.append(f"- **Service Trend:** {svc}")
        lines.append("")

    # Top Picks
    if top_picks:
        lines.append("---")
        lines.append("")
        lines.append("## Top Picks")
        lines.append("")
        for i, c in enumerate(top_picks, 1):
            lines.extend(cafe_line(c, i))

    # Best Value
    if best_value:
        lines.append("---")
        lines.append("")
        lines.append("## Best Value")
        lines.append("")
        for i, c in enumerate(best_value, 1):
            lines.extend(cafe_line(c, i))

    # Hidden Gems
    if hidden_gems:
        lines.append("---")
        lines.append("")
        lines.append("## Hidden Gems")
        lines.append("*High rated but few reviews — worth exploring*")
        lines.append("")
        for i, c in enumerate(hidden_gems, 1):
            lines.extend(cafe_line(c, i))

    # Deals & Offers
    if with_deals:
        lines.append("---")
        lines.append("")
        lines.append("## Deals & Offers")
        lines.append("")
        for i, c in enumerate(with_deals, 1):
            lines.extend(cafe_line(c, i))

    # Skip These
    if skip_these:
        lines.append("---")
        lines.append("")
        lines.append("## Skip These")
        lines.append("")
        for c in skip_these:
            name = c.get("name", "Unknown")
            reason_parts = []
            if c.get("status") == "CLOSED_TEMPORARILY":
                reason_parts.append("temporarily closed")
            if c.get("sentiment") == "negative":
                reason_parts.append("negative reviews")
            if c.get("value_score") == "poor":
                reason_parts.append("poor value")
            concerns = c.get("concerns", [])
            if concerns:
                reason_parts.append(concerns[0].lower())
            reason = " — ".join(reason_parts) if reason_parts else "not recommended"
            lines.append(f"- **{name}**: {reason}")
        lines.append("")

    # Quick Reference Table
    lines.append("---")
    lines.append("")
    lines.append("## Quick Reference")
    lines.append("")
    lines.append("| Cafe | Rating | Price | Vibe | Value |")
    lines.append("|------|--------|-------|------|-------|")
    for c in sorted(operational, key=lambda c: c.get("rating") or 0, reverse=True):
        name = c.get("name", "Unknown")
        rating = c.get("rating")
        r_str = f"{rating}" if rating else "—"
        price = PRICE_LABELS.get(c.get("price_level"), "—")
        sent = SENTIMENT_ICON.get(c.get("sentiment", ""), "~")
        value = c.get("value_score", "—")
        lines.append(f"| {name} | {r_str} | {price} | {sent} | {value} |")
    lines.append("")

    report = "\n".join(lines)
    write_output(report, fmt="md")
    section_count = sum(1 for x in [top_picks, best_value, hidden_gems, with_deals, skip_these] if x)
    print(f"Guide generated — {len(operational)} cafes across {section_count} sections")


if __name__ == "__main__":
    with_error_handling(main)()
