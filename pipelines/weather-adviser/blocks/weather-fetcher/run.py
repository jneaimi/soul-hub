#!/usr/bin/env python3
"""weather-fetcher — Fetch current weather for a city using Open-Meteo API."""
import os, json, sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import quote

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")
CITY = os.environ.get("BLOCK_CONFIG_CITY", "Dubai")

# WMO Weather Codes -> human-readable descriptions
WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}


def fetch_json(url):
    req = Request(url, headers={"User-Agent": "SoulHub-WeatherFetcher/1.0"})
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def geocode(city):
    url = f"https://geocoding-api.open-meteo.com/v1/search?name={quote(city)}&count=1&language=en"
    data = fetch_json(url)
    if not data.get("results"):
        return None
    r = data["results"][0]
    return {
        "name": r["name"],
        "country": r.get("country", ""),
        "latitude": r["latitude"],
        "longitude": r["longitude"],
        "timezone": r.get("timezone", "UTC"),
    }


def fetch_weather(lat, lon, timezone):
    url = (
        f"https://api.open-meteo.com/v1/forecast?"
        f"latitude={lat}&longitude={lon}"
        f"&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
        f"weather_code,wind_speed_10m,wind_gusts_10m,uv_index,is_day"
        f"&timezone={quote(timezone)}"
    )
    return fetch_json(url)


def main():
    city = CITY.strip()
    if not city:
        print(json.dumps({"error": "No city provided"}))
        sys.exit(1)

    # Geocode city name
    location = geocode(city)
    if not location:
        print(json.dumps({"error": f"City not found: {city}"}))
        sys.exit(1)

    # Fetch weather
    weather_data = fetch_weather(location["latitude"], location["longitude"], location["timezone"])
    current = weather_data.get("current", {})
    units = weather_data.get("current_units", {})

    weather_code = current.get("weather_code", 0)
    result = {
        "city": location["name"],
        "country": location["country"],
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "timezone": location["timezone"],
        "temperature_c": current.get("temperature_2m"),
        "feels_like_c": current.get("apparent_temperature"),
        "humidity_percent": current.get("relative_humidity_2m"),
        "wind_speed_kmh": current.get("wind_speed_10m"),
        "wind_gusts_kmh": current.get("wind_gusts_10m"),
        "uv_index": current.get("uv_index"),
        "is_day": current.get("is_day", 1) == 1,
        "weather_code": weather_code,
        "condition": WMO_CODES.get(weather_code, "Unknown"),
    }

    # Write output
    if OUTPUT_PATH:
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Output: {OUTPUT_PATH}")
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
