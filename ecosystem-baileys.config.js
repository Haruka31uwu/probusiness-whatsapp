module.exports = {
  apps: [{
    name: 'whatsapp-multisession-baileys',
    script: 'main-baileys.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8083,
      MAX_SESSIONS: 20,
      LARAVEL_ENV_PATH: '../.env'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 8083,
      MAX_SESSIONS: 20,
      LARAVEL_ENV_PATH: '../.env'
    },
    // Configuraciones específicas para estabilidad
    kill_timeout: 10000,
    listen_timeout: 10000,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    // Logs
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Manejo de señales
    shutdown_with_message: true,
    // Optimizaciones para Baileys
    node_args: '--max-old-space-size=1024'
  }]
}; 