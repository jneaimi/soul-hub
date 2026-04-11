const { resolve } = require('path');
const { homedir } = require('os');

const LOG_DIR = resolve(homedir(), '.soul-hub', 'logs');

module.exports = {
  apps: [
    {
      name: 'soul-hub',
      script: './server.js',
      env: {
        PORT: 2400,
        NODE_ENV: 'production',
        // Pipeline env vars — inherited from shell so blocks can use them
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
        APIDIRECT_API_KEY: process.env.APIDIRECT_API_KEY || '',
        YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
      },
      // Restart policy
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '5s',
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 8000,
      shutdown_with_message: true,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: resolve(LOG_DIR, 'error.log'),
      out_file: resolve(LOG_DIR, 'out.log'),
      merge_logs: true,
      // Don't watch files (we restart manually)
      watch: false,
    },
    {
      name: 'soul-hub-tunnel',
      script: 'cloudflared',
      args: 'tunnel run soul-hub',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      exp_backoff_restart_delay: 1000,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: resolve(LOG_DIR, 'tunnel-error.log'),
      out_file: resolve(LOG_DIR, 'tunnel-out.log'),
      merge_logs: true,
      watch: false,
    },
  ],
};
