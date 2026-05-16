#!/usr/bin/env python3
"""fetch-orgs — Fetch website content for known UAE SME organizations."""
import os, json, sys, re, html
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from json_config import read_config
from output_writer import write_output

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

FETCH_TIMEOUT = 12  # seconds per site
MAX_WORKERS = 5
MAX_TEXT_LEN = 3000  # chars per site — enough for agent, not overwhelming
USER_AGENT = "Mozilla/5.0 (compatible; SoulHub-Pipeline/1.0)"


def strip_html(raw_html: str) -> str:
    """Strip HTML tags and collapse whitespace."""
    text = re.sub(r"<script[^>]*>.*?</script>", " ", raw_html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def fetch_site(org: dict) -> dict:
    """Fetch a single org website and return metadata + extracted text."""
    name = org.get("name", "Unknown")
    raw_url = (org.get("website") or "").strip()
    notes = org.get("notes", "")

    result = {
        "name": name,
        "website": raw_url,
        "notes": notes,
        "fetch_status": "skipped",
        "page_text": "",
    }

    if not raw_url:
        result["fetch_status"] = "no_url"
        return result

    url = raw_url if raw_url.startswith("http") else f"https://{raw_url}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        text = strip_html(raw)[:MAX_TEXT_LEN]
        result["page_text"] = text
        result["fetch_status"] = "ok"
    except urllib.error.HTTPError as e:
        result["fetch_status"] = f"http_{e.code}"
    except urllib.error.URLError as e:
        result["fetch_status"] = f"url_error"
    except TimeoutError:
        result["fetch_status"] = "timeout"
    except Exception as e:
        result["fetch_status"] = f"error: {type(e).__name__}"

    return result


def main():
    # 1. Read known orgs from config
    config_path = PIPELINE_DIR / "config" / "known-orgs.json"
    orgs = read_config(config_path)

    # Also accept orgs from pipeline input (if another step feeds in)
    if INPUT_PATH and Path(INPUT_PATH).exists():
        try:
            extra = json.loads(Path(INPUT_PATH).read_text())
            if isinstance(extra, list):
                existing_names = {o.get("name", "").lower() for o in orgs}
                for o in extra:
                    if o.get("name", "").lower() not in existing_names:
                        orgs.append(o)
        except (json.JSONDecodeError, OSError):
            pass

    if not orgs:
        write_output({"error": "No organizations to fetch", "orgs": []})
        return

    print(f"Fetching {len(orgs)} organization websites...")

    # 2. Fetch in parallel with thread pool
    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(fetch_site, org): org for org in orgs}
        for future in as_completed(futures):
            r = future.result()
            status = r["fetch_status"]
            print(f"  [{status}] {r['name']}")
            results.append(r)

    ok_count = sum(1 for r in results if r["fetch_status"] == "ok")
    fail_count = len(results) - ok_count

    output = {
        "fetch_date": __import__("datetime").date.today().isoformat(),
        "total_orgs": len(results),
        "fetched_ok": ok_count,
        "fetch_failed": fail_count,
        "organizations": results,
    }

    # 3. Write output
    write_output(output)


if __name__ == "__main__":
    with_error_handling(main)()
