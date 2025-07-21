module.exports = {
  apps: [{
    name: 'whatsapp-multisession-working',
    script: 'main-working.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8083,
      MAX_SESSIONS: 15
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 8083,
      MAX_SESSIONS: 15
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
    // Optimizaciones para Linux
    node_args: process.platform === 'linux' ? '--max-old-space-size=512' : '--max-old-space-size=1024'
  }]
}; 