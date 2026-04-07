"""Shared path config for market-intel pipeline scripts."""
import os
from pathlib import Path
from datetime import datetime

MI_BASE = Path(os.environ.get('PIPELINE_DIR', str(Path(__file__).resolve().parent.parent)))
MI_CONFIG = MI_BASE / 'config'
MI_DB = MI_BASE / 'db' / 'signals.db'
MI_AGENTS = MI_BASE / 'agents'
MI_SCRIPTS = MI_BASE / 'scripts'
MI_OUTPUT = Path.home() / 'SecondBrain' / '02-areas' / 'pipelines' / 'market-intel'
MI_DATE = datetime.now().strftime('%Y-%m-%d')

# Ensure output dirs exist
MI_OUTPUT.mkdir(parents=True, exist_ok=True)
(MI_OUTPUT / '_prep').mkdir(exist_ok=True)
