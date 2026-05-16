# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""cafe-finder — Geocode location and fetch nearby cafes with reviews from Google Maps."""
import os, json, sys
from pathlib import Path
from urllib.parse import quote_plus

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
from api_client import fetch_json
from output_writer import write_output

API_KEY = os.environ.get("GOOGLE_API_KEY", "")
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
MAX_RESULTS = int(os.environ.get("BLOCK_CONFIG_MAX_RESULTS", "20"))
RADIUS_KM = int(os.environ.get("BLOCK_CONFIG_RADIUS_KM", "5"))


def geocode(location: str) -> tuple[float, float]:
    """Convert a location name to lat/lng coordinates."""
    url = (
        f"https://maps.googleapis.com/maps/api/geocode/json"
        f"?address={quote_plus(location)}&key={API_KEY}"
    )
    data = fetch_json(url)
    if data.get("status") != "OK" or not data.get("results"):
        raise RuntimeError(f"Geocoding failed for '{location}': {data.get('status', 'no results')}")
    loc = data["results"][0]["geometry"]["location"]
    return loc["lat"], loc["lng"]


def search_cafes(lat: float, lng: float, radius_m: int) -> list[dict]:
    """Search for cafes near coordinates using Places Nearby Search."""
    url = (
        f"https://maps.googleapis.com/maps/api/place/nearbysearch/json"
        f"?location={lat},{lng}&radius={radius_m}"
        f"&type=cafe&key={API_KEY}"
    )
    data = fetch_json(url, timeout=30)
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        raise RuntimeError(f"Places search failed: {data.get('status')}")
    return data.get("results", [])[:MAX_RESULTS]


def get_place_details(place_id: str) -> dict:
    """Fetch reviews and details for a specific place."""
    fields = "name,formatted_address,rating,price_level,reviews,geometry,opening_hours,business_status,url"
    url = (
        f"https://maps.googleapis.com/maps/api/place/details/json"
        f"?place_id={place_id}&fields={fields}&key={API_KEY}"
        f"&reviews_sort=newest"
    )
    data = fetch_json(url, timeout=15)
    if data.get("status") != "OK":
        return {}
    return data.get("result", {})


def main():
    if not API_KEY:
        raise RuntimeError("GOOGLE_API_KEY env var not set")

    # Read location from input — env var, file, or CLI args (runner passes both)
    location = ""
    if INPUT_PATH:
        if Path(INPUT_PATH).exists():
            raw = Path(INPUT_PATH).read_text().strip()
            try:
                parsed = json.loads(raw)
                location = parsed.get("location", parsed.get("value", raw))
            except json.JSONDecodeError:
                location = raw
        else:
            # PIPELINE_INPUT is the raw text value (e.g. from $inputs.location)
            location = INPUT_PATH.strip()

    # Fallback: runner also passes input as CLI argument
    if not location and len(sys.argv) > 1:
        location = " ".join(sys.argv[1:])

    if not location:
        raise RuntimeError("No location provided — set PIPELINE_INPUT to a location string")

    print(f"Geocoding: {location}")
    lat, lng = geocode(location)
    print(f"Coordinates: {lat}, {lng}")

    radius_m = RADIUS_KM * 1000
    print(f"Searching cafes within {RADIUS_KM}km...")
    raw_cafes = search_cafes(lat, lng, radius_m)
    print(f"Found {len(raw_cafes)} cafes")

    if not raw_cafes:
        write_output({"location": location, "cafes": [], "message": "No cafes found nearby"})
        return

    # Enrich each cafe with reviews via Place Details
    cafes = []
    for i, place in enumerate(raw_cafes):
        place_id = place.get("place_id", "")
        print(f"  [{i+1}/{len(raw_cafes)}] Fetching details for {place.get('name', 'unknown')}...")
        details = get_place_details(place_id) if place_id else {}

        reviews = details.get("reviews", [])
        review_texts = [
            {
                "text": r.get("text", ""),
                "rating": r.get("rating"),
                "time": r.get("relative_time_description", ""),
            }
            for r in reviews
            if r.get("text")
        ]

        cafe_loc = place.get("geometry", {}).get("location", {})
        cafes.append({
            "name": details.get("name") or place.get("name", "Unknown"),
            "address": details.get("formatted_address") or place.get("vicinity", ""),
            "place_id": place_id,
            "rating": details.get("rating") or place.get("rating"),
            "price_level": details.get("price_level") or place.get("price_level"),
            "lat": cafe_loc.get("lat"),
            "lng": cafe_loc.get("lng"),
            "maps_url": details.get("url", f"https://www.google.com/maps/place/?q=place_id:{place_id}"),
            "business_status": details.get("business_status", place.get("business_status", "")),
            "reviews": review_texts,
        })

    result = {
        "location": location,
        "search_lat": lat,
        "search_lng": lng,
        "radius_km": RADIUS_KM,
        "cafe_count": len(cafes),
        "cafes": cafes,
    }

    write_output(result)
    print(f"Done — {len(cafes)} cafes with reviews")


if __name__ == "__main__":
    with_error_handling(main)()
