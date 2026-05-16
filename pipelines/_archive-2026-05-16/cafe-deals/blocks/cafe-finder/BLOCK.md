---
name: cafe-finder
type: script
runtime: python
description: Geocode a location name and search Google Maps Places API for nearby cafes with reviews
author: jasem
version: 1.0.0

inputs:
  - name: location
    type: text
    format: text
    description: Area or neighborhood name (e.g. "JBR, Dubai")

outputs:
  - name: cafes
    type: file
    format: json
    description: Array of cafe objects with name, address, rating, price_level, place_id, location, and reviews

config:
  - name: max_results
    type: number
    label: Max Results
    description: Maximum number of cafes to return
    default: "20"
    required: false

env:
  - GOOGLE_API_KEY
---

# cafe-finder

Geocodes a location name to coordinates using Google Geocoding API, then searches for nearby cafes within a configurable radius using the Places API. Fetches reviews for each cafe via Place Details. Returns structured JSON with cafe metadata and recent reviews for downstream deal analysis.
