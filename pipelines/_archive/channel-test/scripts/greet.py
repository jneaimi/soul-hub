#!/usr/bin/env python3
"""Generate a greeting file for the channel-test pipeline."""
import os
import datetime

output = os.environ.get("PIPELINE_OUTPUT", "/tmp/greeting.txt")
greeting = os.environ.get("PIPELINE_INPUT", "Hello from Soul Hub!")

with open(output, "w") as f:
    f.write(f"Greeting: {greeting}\n")
    f.write(f"Generated at: {datetime.datetime.now().isoformat()}\n")
    f.write("Source: Soul Hub V2 channel-test pipeline\n")

print(f"Wrote greeting to {output}")
