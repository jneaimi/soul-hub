---
name: weather-fetcher
type: script
runtime: python
description: Fetch current weather for a city using the free Open-Meteo API
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: weather
    type: file
    format: json
    description: Current weather data including temperature, humidity, wind, and condition description

config:
  - name: city
    type: text
    label: City Name
    description: The city to fetch weather for
    default: Dubai
    required: true
  - name: country
    type: text
    label: Country
    description: Country to disambiguate cities (e.g. UAE, United Kingdom)
    default: ""
    required: false

env: []

data: {}
---

# weather-fetcher

Fetch current weather for any city using the Open-Meteo API (free, no API key required). Uses Open-Meteo's geocoding to resolve city names, then fetches current conditions including temperature, humidity, wind speed, and WMO weather code (mapped to human-readable descriptions).
