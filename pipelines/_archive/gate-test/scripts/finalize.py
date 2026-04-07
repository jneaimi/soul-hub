#!/usr/bin/env python3
"""Finalize the draft after approval and style selection."""
import os
import json
from datetime import datetime

input_path = os.environ.get('PIPELINE_INPUT', '')
style = os.environ.get('PIPELINE_INPUT_1', 'detailed')
output_path = os.environ.get('PIPELINE_OUTPUT', '/tmp/final.md')
os.makedirs(os.path.dirname(output_path), exist_ok=True)

# Read the draft
draft = ''
if input_path and os.path.exists(input_path):
    with open(input_path) as f:
        draft = f.read()

# Apply style
if style == 'minimal':
    # Strip to essentials: title + key points only
    lines = draft.strip().split('\n')
    title = next((l for l in lines if l.startswith('# ')), '# Report')
    points = [l for l in lines if l.startswith('- ')]
    final = f"{title}\n\n" + '\n'.join(points) + '\n'
elif style == 'bullet-points':
    # Convert everything to bullet points
    lines = draft.strip().split('\n')
    title = next((l for l in lines if l.startswith('# ')), '# Report')
    content_lines = [l.strip() for l in lines if l.strip() and not l.startswith('#')]
    final = f"{title}\n\n" + '\n'.join(f'- {l.lstrip("- ")}' for l in content_lines) + '\n'
else:
    # detailed: keep everything, add metadata
    final = f"{draft}\n---\n*Style: {style} | Finalized: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n"

with open(output_path, 'w') as f:
    f.write(final)

print(json.dumps({"status": "ok", "style": style, "output": output_path}))
