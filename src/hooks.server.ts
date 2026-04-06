import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { initScheduler } from '$lib/pipeline/index.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.marketplaceDir), 'pipelines');
const DATA_DIR = resolve(dirname(config.resolved.marketplaceDir), '.data');

// Initialize scheduler on server startup
initScheduler(PIPELINES_DIR, DATA_DIR);
