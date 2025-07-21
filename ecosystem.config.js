module.exports = {
  apps: [
    {
      name: 'whatsapp-multisession-baileys',
      script: './main-baileys.js',
      // Usa el Node de NVM si está disponible, si no, usa el global
      interpreter: process.env.NVM_BIN ? process.env.NVM_BIN + '/node' : 'node',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}; 