module.exports = {
  apps: [
    {
      name: 'whatsapp-multisession-baileys',
      script: './main-baileys.js',
      interpreter: process.env.NVM_BIN ? process.env.NVM_BIN + '/node' : 'node',
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      listen_timeout: 10000,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      shutdown_with_message: true,
      node_args: '--max-old-space-size=1024',
      env: {
        NODE_ENV: 'production',
        PORT: 8083,
        MAX_SESSIONS: 20,
        LARAVEL_ENV_PATH: '../redis-laravel/.env'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8083,
        MAX_SESSIONS: 20,
        LARAVEL_ENV_PATH: '../redis-laravel/.env'
      }
    }
  ]
}; 