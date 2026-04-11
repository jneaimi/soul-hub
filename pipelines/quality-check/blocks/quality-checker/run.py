# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""quality-checker — Score data quality 0-100 and fix remaining issues."""
import os, csv, sys, re
from pathlib import Path
from collections import Counter
from statistics import median, mode

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

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Common date patterns to normalize into YYYY-MM-DD
DATE_PATTERNS = [
    (re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$"), lambda m: f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"),
    (re.compile(r"^(\d{1,2})-(\d{1,2})-(\d{4})$"), lambda m: f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"),
    (re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$"), lambda m: f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"),
]
PAYMENT_METHODS = {"cash", "credit card", "digital wallet", "debit card"}
PAYMENT_ALIASES = {
    "cc": "credit card", "credit": "credit card", "card": "credit card",
    "dc": "debit card", "debit": "debit card",
    "wallet": "digital wallet", "e-wallet": "digital wallet", "ewallet": "digital wallet",
}
LOCATIONS = {"in-store", "takeaway", "online"}
LOCATION_ALIASES = {
    "store": "in-store", "instore": "in-store", "dine-in": "in-store", "dine in": "in-store",
    "take-away": "takeaway", "take away": "takeaway", "delivery": "takeaway",
}


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)
    return fieldnames, rows


def score_completeness(rows, fieldnames):
    if not rows:
        return 100.0
    total = len(rows) * len(fieldnames)
    empty = sum(1 for r in rows for f in fieldnames if not r.get(f, "").strip())
    return ((total - empty) / total) * 100


def score_consistency(rows, fieldnames):
    issues = 0
    checks = 0
    for r in rows:
        # Date format
        date_val = r.get("Transaction Date", "").strip()
        if date_val:
            checks += 1
            if not DATE_RE.match(date_val):
                issues += 1
        # Payment method
        pm = r.get("Payment Method", "").strip().lower()
        if pm:
            checks += 1
            if pm not in PAYMENT_METHODS:
                issues += 1
        # Location
        loc = r.get("Location", "").strip().lower()
        if loc:
            checks += 1
            if loc not in LOCATIONS:
                issues += 1
    if checks == 0:
        return 100.0
    return ((checks - issues) / checks) * 100


def score_validity(rows):
    issues = 0
    checks = 0
    for r in rows:
        # Quantity > 0
        qty = r.get("Quantity", "").strip()
        if qty:
            checks += 1
            try:
                if float(qty) <= 0:
                    issues += 1
            except ValueError:
                issues += 1
        # Price > 0
        price = r.get("Price Per Unit", "").strip()
        if price:
            checks += 1
            try:
                if float(price) <= 0:
                    issues += 1
            except ValueError:
                issues += 1
        # Total Spent > 0
        total = r.get("Total Spent", "").strip()
        if total:
            checks += 1
            try:
                if float(total) < 0:
                    issues += 1
            except ValueError:
                issues += 1
    if checks == 0:
        return 100.0
    return ((checks - issues) / checks) * 100


def fix_rows(rows, fieldnames):
    # Collect numeric columns for median imputation
    numeric_cols = ["Quantity", "Price Per Unit", "Total Spent"]
    numeric_vals = {c: [] for c in numeric_cols if c in fieldnames}
    for r in rows:
        for c in numeric_vals:
            v = r.get(c, "").strip()
            if v:
                try:
                    numeric_vals[c].append(float(v))
                except ValueError:
                    pass
    medians = {}
    for c, vals in numeric_vals.items():
        if vals:
            medians[c] = median(vals)

    # Categorical columns for mode imputation
    cat_cols = ["Payment Method", "Location", "Item"]
    cat_vals = {c: [] for c in cat_cols if c in fieldnames}
    for r in rows:
        for c in cat_vals:
            v = r.get(c, "").strip()
            if v:
                cat_vals[c].append(v.lower())
    modes = {}
    for c, vals in cat_vals.items():
        if vals:
            modes[c] = Counter(vals).most_common(1)[0][0]

    # Title-case mapping for categorical display
    cat_title = {
        "Payment Method": {"cash": "Cash", "credit card": "Credit Card",
                           "digital wallet": "Digital Wallet", "debit card": "Debit Card"},
        "Location": {"in-store": "In-Store", "takeaway": "Takeaway", "online": "Online"},
    }

    seen = set()
    fixed = []
    for r in rows:
        # Normalize date formats to YYYY-MM-DD
        date_val = r.get("Transaction Date", "").strip()
        if date_val and not DATE_RE.match(date_val):
            for pattern, formatter in DATE_PATTERNS:
                m = pattern.match(date_val)
                if m:
                    r["Transaction Date"] = formatter(m)
                    break

        # Normalize payment method (resolve aliases, then title-case) — only fix format, never impute missing
        pm = r.get("Payment Method", "").strip()
        if pm:
            lower = pm.lower()
            if lower in PAYMENT_ALIASES:
                lower = PAYMENT_ALIASES[lower]
            if lower not in PAYMENT_METHODS:
                lower = ""  # unrecognized value — leave empty rather than guessing
            if lower:
                r["Payment Method"] = cat_title.get("Payment Method", {}).get(lower, pm.title())
            else:
                r["Payment Method"] = ""

        # Normalize location (resolve aliases, then title-case) — only fix format, never impute missing
        loc = r.get("Location", "").strip()
        if loc:
            lower = loc.lower()
            if lower in LOCATION_ALIASES:
                lower = LOCATION_ALIASES[lower]
            if lower not in LOCATIONS:
                lower = ""  # unrecognized value — leave empty rather than guessing
            if lower:
                r["Location"] = cat_title.get("Location", {}).get(lower, loc.title())
            else:
                r["Location"] = ""

        # Fill missing numeric with median
        for c in numeric_vals:
            v = r.get(c, "").strip()
            if not v and c in medians:
                r[c] = str(medians[c])

        # Do not impute missing categorical values — missing data should remain missing
        # to give an honest picture of data quality

        # Fix invalid numeric values (negative or zero)
        for c in numeric_vals:
            v = r.get(c, "").strip()
            if v:
                try:
                    if float(v) <= 0 and c in medians:
                        r[c] = str(medians[c])
                except ValueError:
                    if c in medians:
                        r[c] = str(medians[c])

        # Recalculate Total Spent if Quantity and Price exist
        qty = r.get("Quantity", "").strip()
        price = r.get("Price Per Unit", "").strip()
        if qty and price:
            try:
                r["Total Spent"] = str(round(float(qty) * float(price), 2))
            except ValueError:
                pass

        # Deduplicate exact rows
        key = tuple(r.get(f, "") for f in fieldnames)
        if key not in seen:
            seen.add(key)
            fixed.append(r)

    return fixed


def write_csv(path, fieldnames, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        print("No input file", file=sys.stderr)
        sys.exit(1)

    fieldnames, rows = read_csv(INPUT_PATH)

    completeness = score_completeness(rows, fieldnames)
    consistency = score_consistency(rows, fieldnames)
    validity = score_validity(rows)
    score = completeness * 0.4 + consistency * 0.3 + validity * 0.3

    print(f"Completeness: {completeness:.1f}  Consistency: {consistency:.1f}  Validity: {validity:.1f}")
    print(f"Quality score: {score:.1f}")

    out_path = OUTPUT_PATH or INPUT_PATH
    if score >= 90:
        write_csv(out_path, fieldnames, rows)
        print(f"Output: {out_path}")
        print("QUALITY: PASS")
    else:
        fixed = fix_rows(rows, fieldnames)
        # Re-score after fixing to report accurate post-fix quality
        post_comp = score_completeness(fixed, fieldnames)
        post_cons = score_consistency(fixed, fieldnames)
        post_val = score_validity(fixed)
        post_score = post_comp * 0.4 + post_cons * 0.3 + post_val * 0.3
        print(f"Post-fix: Completeness: {post_comp:.1f}  Consistency: {post_cons:.1f}  Validity: {post_val:.1f}")
        print(f"Post-fix score: {post_score:.1f}")
        print(f"Removed {len(rows) - len(fixed)} duplicate rows")
        write_csv(out_path, fieldnames, fixed)
        print(f"Output: {out_path}")
        if post_score >= 90:
            print("QUALITY: PASS")
        else:
            print(f"QUALITY: IMPROVED: {score:.0f} -> {post_score:.0f}")


if __name__ == "__main__":
    with_error_handling(main)()
