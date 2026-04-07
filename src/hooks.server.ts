import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { initScheduler } from '$lib/pipeline/index.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');
const DATA_DIR = resolve(dirname(config.resolved.catalogDir), '.data');

// Initialize scheduler on server startup
initScheduler(PIPELINES_DIR, DATA_DIR);
