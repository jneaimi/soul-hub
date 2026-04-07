---
name: activity-adviser
type: agent
model: sonnet
description: Analyze weather data and generate a tailored activity report with categorized suggestions
author: jasem
version: 1.0.0

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

Reads weather data for a city and generates a rich, categorized activity report. The agent reasons about what activities are suitable given the temperature, conditions, wind, UV index, and time of day, then produces a markdown report with practical suggestions across multiple categories.
