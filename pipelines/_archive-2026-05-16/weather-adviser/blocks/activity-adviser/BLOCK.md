---
name: activity-adviser
type: script
runtime: python
description: Analyze weather data and generate a tailored activity report with categorized suggestions
author: jasem
version: 2.0.0

inputs:
  - name: weather
    type: file
    format: json
    description: Weather data from weather-fetcher block

outputs:
  - name: activity-report
    type: file
    format: markdown
    description: Categorized activity report tailored to the current weather

config: []

env: []

data: {}
---

# activity-adviser

Reads weather data for a city and generates a rich, categorized activity report. Classifies conditions by temperature, rain, wind, UV, and time of day, then picks relevant activities from a curated database across outdoor, indoor, food, and wellness categories.
