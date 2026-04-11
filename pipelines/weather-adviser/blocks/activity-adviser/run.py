# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""activity-adviser — Generate tailored activity suggestions from weather data."""
import os, json, sys
from pathlib import Path

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

# Weather code descriptions (WMO standard)
WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
    82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}

# Activity database keyed by condition tags
OUTDOOR = {
    "hot":   ["Early morning beach walk before the heat peaks", "Swimming at an outdoor pool or beach club",
              "Shaded park stroll with plenty of water", "Kayaking or paddleboarding at dawn"],
    "warm":  ["Cycling along the waterfront promenade", "Outdoor brunch at a terrace cafe",
              "Beach volleyball or frisbee", "Walking tour of the old quarter", "Jogging in the park"],
    "mild":  ["Hiking or nature trail exploration", "Outdoor yoga in the park",
              "Picnic by the waterfront", "Photography walk — great light conditions",
              "Open-air market browsing"],
    "cool":  ["Brisk morning run with layers", "Outdoor rock climbing",
              "Football or cricket at the park", "Cycling through scenic routes"],
    "cold":  ["Bundled-up walk through a winter market", "Cross-country skiing or snowshoeing",
              "Hot chocolate at an outdoor kiosk, then head inside"],
    "rainy": ["Light walking with a rain jacket — empty streets, soft light",
              "Covered souk or market exploration", "Photography — overcast skies give diffused light",
              "Driving tour — enjoy the rain from the car"],
    "windy": ["Kite flying at an open beach", "Wind-surfing or sailing if experienced",
              "Sheltered coastal walk behind a breakwater"],
    "night": ["Evening Corniche stroll under the lights", "Rooftop lounge or outdoor dining",
              "Stargazing from a low-light-pollution spot", "Night photography walk"],
}

INDOOR = {
    "hot":   ["Museum or gallery visit (cool AC)", "Indoor rock climbing gym",
              "Spa day — escape the heat", "Shopping mall exploration", "Cooking class"],
    "warm":  ["Cafe hopping with a good book", "Indoor swimming or gym session",
              "Cinema afternoon", "Art workshop or pottery class"],
    "mild":  ["Board game cafe with friends", "Indoor trampoline park",
              "Library or bookstore browsing", "Bowling alley session"],
    "cool":  ["Cozy cafe with a warm drink", "Indoor yoga or pilates",
              "Museum or heritage center visit", "Cinema double feature"],
    "cold":  ["Fireplace lounge or warm cafe", "Indoor ice skating",
              "Museum marathon", "Home cooking — soups and stews"],
    "rainy": ["Museum or cultural center visit", "Cafe hopping — rainy day reading vibes",
              "Indoor fitness — gym, yoga, or pool", "Cinema — perfect rainy day plan",
              "Cooking at home — slow cook weather"],
    "night": ["Late-night dessert cafe", "Indoor bowling or billiards",
              "Home movie marathon", "Board game night with friends"],
}

FOOD = {
    "hot":   ["Fresh fruit smoothie or juice bar", "Light seafood salad",
              "Ice cream from a local gelateria", "Cold brew or iced latte"],
    "warm":  ["Grilled kebabs at an outdoor spot", "Fresh salad and cold mezze",
              "Tropical fruit platter", "Iced tea or lemonade"],
    "mild":  ["Brunch at a terrace restaurant", "Wood-fired pizza",
              "Street food walking tour", "Craft coffee tasting"],
    "cool":  ["Hot soup or ramen bowl", "Warm apple cider or chai latte",
              "Comfort food — pasta, risotto", "Freshly baked pastries"],
    "cold":  ["Rich hot chocolate with marshmallows", "Hearty stew or chili",
              "Fondue night", "Warm bread and soup combo"],
    "rainy": ["Hot soup or ramen — rainy day comfort food", "Warm chai latte or hot chocolate",
              "Home-baked goods — cookies or banana bread", "Slow-cooked stew"],
    "night": ["Late-night shawarma or street food", "Dessert tasting at a pastry shop",
              "Hot mint tea at a traditional cafe"],
}

WELLNESS = {
    "hot":   ["Indoor yoga in air conditioning", "Cold plunge or pool recovery",
              "Hydration focus — electrolyte drinks", "Meditation in a cool, quiet room"],
    "warm":  ["Outdoor stretching or tai chi", "Spa treatment — massage or facial",
              "Gentle evening walk for decompression", "Journaling at a quiet cafe"],
    "mild":  ["Park meditation or breathing exercises", "Outdoor yoga session",
              "Nature walk for mental clarity", "Forest bathing (or garden equivalent)"],
    "cool":  ["Hot bath or sauna session", "Warm-up yoga flow",
              "Mindful walking in crisp air", "Aromatherapy at home"],
    "cold":  ["Sauna or steam room", "Hot stone massage",
              "Indoor stretching with warm blankets", "Gratitude journaling by the window"],
    "rainy": ["Rain meditation — listen to the rain with eyes closed",
              "Gentle indoor stretching", "Long bath with essential oils",
              "Journaling — rainy days are reflective"],
    "night": ["Evening wind-down yoga", "Sleep meditation or body scan",
              "Chamomile tea ritual", "Gentle foam rolling before bed"],
}


def classify(w):
    """Return a list of condition tags for activity selection."""
    tags = []
    temp = w.get("temperature_c", 20)
    if temp > 35:
        tags.append("hot")
    elif temp > 25:
        tags.append("warm")
    elif temp > 15:
        tags.append("mild")
    elif temp > 5:
        tags.append("cool")
    else:
        tags.append("cold")

    code = w.get("weather_code", 0)
    if code in range(51, 68) or code in range(80, 83):
        tags.append("rainy")
    if code in range(71, 78) or code in range(85, 87):
        tags.append("cold")  # snow implies cold activities
    if code in (95, 96, 99):
        tags.append("rainy")  # thunderstorms

    wind = w.get("wind_speed_kmh", 0)
    if wind > 30:
        tags.append("windy")

    if not w.get("is_day", True):
        tags.append("night")

    return tags


def pick(pool, tags, n=4):
    """Pick up to n unique activities from pool, prioritizing weather-specific tags."""
    # Weather-condition tags first, then temperature
    priority = ["rainy", "windy", "night"]
    ordered = [t for t in priority if t in tags] + [t for t in tags if t not in priority]
    seen = set()
    items = []
    for tag in ordered:
        for item in pool.get(tag, []):
            if item not in seen:
                seen.add(item)
                items.append(item)
    return items[:n]


def uv_label(uv):
    if uv <= 2:
        return "Low"
    if uv <= 5:
        return "Moderate"
    if uv <= 7:
        return "High"
    if uv <= 10:
        return "Very High"
    return "Extreme"


def avoid_list(w, tags):
    """Generate activities to avoid based on conditions."""
    items = []
    code = w.get("weather_code", 0)
    wind = w.get("wind_speed_kmh", 0)
    temp = w.get("temperature_c", 20)
    uv = w.get("uv_index", 0)

    if "rainy" in tags:
        items.append("Beach and water sports — rain makes conditions unpleasant and unpredictable")
        items.append("Desert excursions — wet sand and off-road conditions are risky")
        items.append("Outdoor sports on grass — slippery surfaces increase injury risk")
    if code in (95, 96, 99):
        items.append("Any outdoor activity — thunderstorm with potential lightning")
    if "windy" in tags:
        items.append("Lightweight outdoor activities — strong winds make cycling and running uncomfortable")
    if temp > 40:
        items.append("Prolonged outdoor exercise — extreme heat risk, stay hydrated indoors")
    if uv > 8:
        items.append("Extended sun exposure without protection — UV is very high")
    if not items:
        items.append("No major restrictions — conditions are favorable for most activities")
    return items


def wear_tips(w, tags):
    temp = w.get("temperature_c", 20)
    tips = []
    if temp > 35:
        tips += ["Light, breathable fabrics — linen or moisture-wicking materials",
                 "Wide-brimmed hat and UV-blocking sunglasses"]
    elif temp > 25:
        tips += ["Light layers — t-shirt with an optional light jacket for AC indoors",
                 "Comfortable walking shoes"]
    elif temp > 15:
        tips += ["Medium layers — long sleeves with a light jacket",
                 "Comfortable shoes for walking"]
    elif temp > 5:
        tips += ["Warm layers — sweater or fleece with a wind-resistant outer layer",
                 "Closed-toe shoes or boots"]
    else:
        tips += ["Heavy layers — thermal base, insulating mid, windproof outer",
                 "Warm hat, gloves, and scarf"]
    if "rainy" in tags:
        tips.append("Waterproof jacket or rain poncho")
    return tips


def bring_items(w, tags):
    items = []
    if "rainy" in tags:
        items.append("Umbrella — rain is expected")
    uv = w.get("uv_index", 0)
    if uv > 3:
        items.append(f"Sunscreen (SPF 30+) — UV index is {uv_label(uv).lower()}")
    if w.get("temperature_c", 20) > 28:
        items.append("Water bottle — stay hydrated in the warmth")
    if not w.get("is_day", True):
        items.append("Phone flashlight or small torch for poorly lit areas")
    if not items:
        items.append("Water bottle and a light snack")
    return items


def build_report(w):
    city = w.get("city", "Unknown")
    country = w.get("country", "")
    tags = classify(w)
    time_label = "Day" if w.get("is_day", True) else "Night"
    condition = w.get("condition", WEATHER_CODES.get(w.get("weather_code", 0), "Unknown"))
    uv = w.get("uv_index", 0)

    outdoor = pick(OUTDOOR, tags)
    indoor = pick(INDOOR, tags)
    food = pick(FOOD, tags)
    wellness = pick(WELLNESS, tags)
    avoid = avoid_list(w, tags)
    wear = wear_tips(w, tags)
    bring = bring_items(w, tags)

    lines = []
    lines.append(f"# Activity Recommendations — {city}")
    header_parts = [
        f"**Condition:** {condition}",
        f"**Temp:** {w.get('temperature_c', '?')}°C (feels {w.get('feels_like_c', '?')}°C)",
        f"**Humidity:** {w.get('humidity_percent', '?')}%",
        f"**UV Index:** {uv} ({uv_label(uv)})",
    ]
    lines.append(" | ".join(header_parts))
    lines.append("")
    lines.append("---")
    lines.append("")

    # Current conditions summary
    lines.append("## Current Conditions Summary")
    lines.append("")
    temp = w.get("temperature_c", 20)
    wind = w.get("wind_speed_kmh", 0)
    gusts = w.get("wind_gusts_kmh", 0)
    summary_parts = [f"The weather in {city} is {condition.lower()} at {temp}°C (feels like {w.get('feels_like_c', temp)}°C)."]
    summary_parts.append(f"Wind is {wind} km/h with gusts up to {gusts} km/h.")
    summary_parts.append(f"Humidity sits at {w.get('humidity_percent', '?')}% and UV index is {uv} ({uv_label(uv).lower()}).")
    if "rainy" in tags:
        summary_parts.append("Carry an umbrella and prefer covered areas.")
    elif temp > 35:
        summary_parts.append("Stay hydrated and seek shade during peak hours.")
    elif "night" in tags:
        summary_parts.append("Great evening weather for being out and about.")
    lines.append(" ".join(summary_parts))
    lines.append("")
    lines.append("---")
    lines.append("")

    def section(title, items):
        lines.append(f"## {title}")
        lines.append("")
        for item in items:
            lines.append(f"- **{item.split(' — ')[0]}** — {item.split(' — ')[1]}" if " — " in item else f"- {item}")
        lines.append("")

    section("Outdoor Activities", outdoor)
    section("Indoor Activities", indoor)
    section("Food & Drink", food)
    section("Wellness & Relaxation", wellness)

    lines.append("---")
    lines.append("")

    section("Activities to Avoid", avoid)

    lines.append("---")
    lines.append("")

    lines.append("## What to Wear")
    lines.append("")
    for tip in wear:
        lines.append(f"- {tip}")
    lines.append("")

    lines.append("## What to Bring")
    lines.append("")
    for item in bring:
        lines.append(f"- {item}")
    lines.append("")

    lines.append("---")
    lines.append("")
    quick = []
    if uv < 3:
        quick.append(f"UV is only {uv} ({uv_label(uv).lower()}) — sunscreen is optional today.")
    if "rainy" in tags and temp > 20:
        quick.append(f"If the rain eases, a short outdoor walk would be pleasant at {temp}°C.")
    if temp > 25 and temp <= 35 and "rainy" not in tags:
        quick.append("Great day for any outdoor activity — enjoy it!")
    if quick:
        lines.append("## Quick Tip")
        lines.append("")
        lines.append(" ".join(quick))
        lines.append("")

    return "\n".join(lines)


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        print(json.dumps({"error": "No input weather data found"}))
        sys.exit(1)

    with open(INPUT_PATH) as f:
        weather = json.load(f)

    report = build_report(weather)

    if OUTPUT_PATH:
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            f.write(report)
        print(f"Output: {OUTPUT_PATH}")
    else:
        print(report)


if __name__ == "__main__":
    with_error_handling(main)()
