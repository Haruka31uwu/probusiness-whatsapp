  module.exports = {
    apps: [{
      name: 'whatsapp-api',
      script: 'main-multisession.js',
      instances: 1,
      autorestart: true,
      watch: false,
          max_memory_restart: process.platform === 'linux' ? '768M' : '300M', // Más memoria pero no excesiva
    max_restarts: process.platform === 'linux' ? 3 : 10, // Menos restarts en Linux - más estable
    min_uptime: process.platform === 'linux' ? '60s' : '10s', // Tiempo mínimo mayor en Linux
    restart_delay: process.platform === 'linux' ? 15000 : 5000, // Delay mayor para estabilidad
    node_args: process.platform === 'linux' 
      ? '--expose-gc --max-old-space-size=1024 --optimize-for-size --use-largepages=on --max-semi-space-size=64 --initial-old-space-size=1024'
      : '--expose-gc --max-old-space-size=768', // Optimizaciones específicas de V8 para Linux
    env: {
      NODE_ENV: 'production',
      PORT: 8083,
      NODE_OPTIONS: process.platform === 'linux' 
        ? '--max-old-space-size=1024 --use-largepages=on --experimental-worker'
        : '--max-old-space-size=768',
      UV_THREADPOOL_SIZE: process.platform === 'linux' ? 64 : 16, // Muchos más threads en Linux para IO
      MAX_SESSIONS: process.platform === 'linux' ? 15 : 50, // Limitar más sesiones en Linux para mejor rendimiento por sesión
      PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true', // Usar Chrome del sistema
      // Optimizaciones específicas para Linux
      ...(process.platform === 'linux' ? {
        DISPLAY: ':99',
        XVFB_WHD: '1920x1080x24',
        CHROME_FLAGS: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage',
        NODE_TLS_REJECT_UNAUTHORIZED: '0', // Para conexiones SSL más rápidas en desarrollo
        UV_USE_IO_URING: '1' // Usar io_uring si está disponible (Linux 5.1+)
      } : {})
    },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Rotación de logs automática
      log_type: 'json',
      // Kill timeout más agresivo para evitar procesos colgados
      kill_timeout: 3000,
      listen_timeout: 5000,
      // Configuración específica para evitar memory leaks
      exec_mode: 'fork', // En lugar de cluster para WhatsApp
      ignore_watch: ['node_modules', 'logs', '.wwebjs_auth', 'whatsapp_sessions', 'uploads'],
      // Limpieza automática de procesos
      cron_restart: '0 */6 * * *', // Reiniciar cada 6 horas para limpiar memoria
      // Monitoreo adicional
      pmx: true,
      automation: false
    }]
  }; 