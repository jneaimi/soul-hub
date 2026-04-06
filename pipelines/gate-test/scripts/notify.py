#!/usr/bin/env python3
"""Simulated notification step — only runs when style is not minimal."""
import os
import json

input_path = os.environ.get('PIPELINE_INPUT', '')
output_path = os.environ.get('PIPELINE_OUTPUT', '/tmp/notify.log')
os.makedirs(os.path.dirname(output_path), exist_ok=True)

with open(output_path, 'w') as f:
    f.write(f"Notification sent for: {input_path}\n")

print(json.dumps({"status": "ok", "notified": True}))
