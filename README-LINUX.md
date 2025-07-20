# 🐧 WhatsApp API - Configuración para Linux

Este documento explica cómo resolver los problemas específicos de Linux que aparecen en los logs.

## 🔧 Problemas Identificados y Soluciones

### 1. Error de LocalWebCache
```
TypeError: Cannot read properties of null (reading '1')
at LocalWebCache.persist (/var/www/html/probusiness-messages3/node_modules/whatsapp-web.js/src/webCache/LocalWebCache.js:34:69)
```

**Solución**: Actualizar whatsapp-web.js a la versión 1.26.0

### 2. Límite de Sesiones
```
📦 Encontradas 105 sesiones para restaurar
❌ Error restaurando sesión: Máximo 5 sesiones simultáneas permitidas
```

**Solución**: Configuración optimizada para Linux con límites adecuados

### 3. Chrome/Chromium no disponible
```
Error: Could not find Chromium (rev. 1083080)
```

**Solución**: En Linux no hay Chrome por defecto. Tienes 3 opciones:

#### **Opción 1: Chromium del Sistema** (Recomendado para servidores)
```bash
sudo apt-get install chromium-browser
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

#### **Opción 2: Google Chrome** (Mejor compatibilidad)
```bash
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt-get update
sudo apt-get install google-chrome-stable
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

#### **Opción 3: Descarga Automática de Puppeteer** (Automático)
```bash
unset PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
npm install
```

**Ventajas y Desventajas:**

| Opción | Pros | Contras |
|--------|------|---------|
| **Chromium Sistema** | ✅ Menos espacio<br>✅ Mantenido por el SO<br>✅ Mejor para servidores | ⚠️ Puede ser versión antigua |
| **Google Chrome** | ✅ Máxima compatibilidad<br>✅ Siempre actualizado | ❌ Más espacio<br>❌ Requiere repo externo |
| **Puppeteer Auto** | ✅ Totalmente automático<br>✅ Versión compatible | ❌ Descarga ~130MB<br>❌ Puede fallar en algunos VPS |

## 🚀 Instalación Automática

```bash
# Dar permisos de ejecución al script
chmod +x install-linux.sh

# Ejecutar configuración automática
./install-linux.sh
```

## 📦 Instalación Manual

### 1. Actualizar Dependencias del Sistema

#### Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install -y wget gnupg ca-certificates apt-transport-https \
    software-properties-common curl chromium-browser fonts-liberation \
    libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 \
    libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libxss1 libxtst6 xdg-utils xvfb
```

#### CentOS/RHEL/Fedora:
```bash
sudo yum update -y
sudo yum install -y wget curl chromium liberation-fonts vulkan \
    mesa-libgbm mesa-dri-drivers xorg-x11-server-Xvfb
```

### 2. Actualizar Dependencias de Node.js
```bash
npm install
```

### 3. Configurar Variables de Entorno
```bash
export DISPLAY=:99
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
export CHROME_BIN=/usr/bin/chromium-browser
export MAX_SESSIONS=25
export UV_THREADPOOL_SIZE=32
```

### 4. Configurar Xvfb (Display Virtual)
```bash
# Iniciar Xvfb en background
Xvfb :99 -screen 0 1920x1080x24 &

# O usar el servicio systemd (recomendado)
sudo systemctl start xvfb
sudo systemctl enable xvfb
```

## 🔧 Optimizaciones Implementadas

### 1. Configuración Específica para Linux
- **Límite de sesiones optimizado**: 15 sesiones (vs 50 en Windows) para mejor rendimiento por sesión
- **Timeouts optimizados**: Reducidos pero eficientes (90s vs 180s anterior)
- **Args de Chrome ultra-optimizados**: 40+ argumentos específicos para máximo rendimiento
- **Gestión de memoria avanzada**: Garbage collection automático + limpieza del sistema

### 2. Optimizaciones del Navegador (Chrome/Chromium)
```bash
# Argumentos optimizados incluyen:
--disable-dev-shm-usage          # Evita problemas de memoria compartida
--memory-pressure-off            # Desactiva throttling de memoria
--aggressive-cache-discard       # Limpieza agresiva de caché
--disable-background-*           # Desactiva procesos en segundo plano
--disk-cache-size=0             # Sin caché en disco (más rápido)
--process-per-site              # Mejor gestión de procesos
--enable-tcp-fast-open          # Conexiones TCP más rápidas
```

### 3. Optimizaciones del Sistema Operativo
```bash
# Kernel optimizations aplicadas automáticamente:
vm.swappiness = 10               # Reduce uso de swap
vm.dirty_ratio = 15              # Mejor gestión de escritura
net.core.somaxconn = 65536       # Más conexiones simultáneas
net.ipv4.tcp_fastopen = 3        # TCP Fast Open habilitado
kernel.pid_max = 4194304         # Más procesos permitidos
```

### 4. Optimizaciones de Node.js
```bash
# Variables de entorno optimizadas:
UV_THREADPOOL_SIZE=64            # Más threads para I/O
NODE_OPTIONS=--max-old-space-size=1024 --use-largepages=on
UV_USE_IO_URING=1               # Usa io_uring si está disponible (Linux 5.1+)
```

### 2. Restauración de Sesiones en Lotes
- **Procesamiento por lotes**: 3 sesiones por lote en Linux vs 5 en Windows
- **Delay entre lotes**: 5 segundos en Linux vs 2 en Windows
- **Selección inteligente**: Solo las sesiones más recientes se restauran
- **Manejo de errores mejorado**: Detiene la restauración si se alcanza el límite

### 3. Configuración de PM2 Optimizada
```javascript
max_memory_restart: '512M',  // Más memoria en Linux
max_restarts: 5,             // Menos restarts
min_uptime: '30s',           // Mayor tiempo mínimo
restart_delay: 10000,        // Mayor delay entre restarts
node_args: '--expose-gc --max-old-space-size=1024 --optimize-for-size'
```

## 🚀 Comandos de Inicio

### Desarrollo:
```bash
npm run dev
```

### Producción:
```bash
# Iniciar con PM2
pm2 start ecosystem.config.js

# Ver estado
pm2 status

# Ver logs
pm2 logs whatsapp-api

# Reiniciar
pm2 restart whatsapp-api

# Detener
pm2 stop whatsapp-api
```

## 🔍 Monitoreo y Debugging

### Ver Logs en Tiempo Real:
```bash
pm2 logs whatsapp-api --lines 100
```

### Verificar Uso de Memoria:
```bash
pm2 monit
```

### Limpiar Cachés:
```bash
# Limpiar cachés de Chrome
rm -rf /tmp/chrome-profile-*
rm -rf ~/.cache/google-chrome*

# Reiniciar Xvfb
sudo systemctl restart xvfb
```

## 🔧 Troubleshooting

### Verificar qué Chrome está usando el sistema:
```bash
# Verificar si Chromium está instalado
chromium-browser --version 2>/dev/null || echo "Chromium no instalado"

# Verificar si Google Chrome está instalado  
google-chrome-stable --version 2>/dev/null || echo "Chrome no instalado"

# Ver qué ejecutable encontrará la aplicación
node -e "
const paths = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome', 
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
];
const fs = require('fs');
paths.forEach(p => {
  if(fs.existsSync(p)) console.log('✅ Encontrado:', p);
  else console.log('❌ No existe:', p);
});
"
```

### Error: "Chrome no encontrado"
```bash
# Opción 1: Instalar Chromium (recomendado)
sudo apt-get install chromium-browser

# Opción 2: Instalar Google Chrome
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt-get update
sudo apt-get install google-chrome-stable

# Opción 3: Dejar que Puppeteer descargue automáticamente
unset PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
npm install
```

### Error: "Display no disponible"
```bash
# Verificar Xvfb
ps aux | grep Xvfb
export DISPLAY=:99
```

### Error: "Muchas sesiones"
```bash
# Limpiar sesiones antiguas
rm -rf .wwebjs_auth/session-*
```

### Error: "LocalWebCache"
```bash
# Actualizar whatsapp-web.js
npm install whatsapp-web.js@1.26.0
```

## 📊 Configuración Recomendada del Servidor

### Recursos Mínimos:
- **RAM**: 2GB mínimo, 4GB recomendado
- **CPU**: 2 cores mínimo
- **Almacenamiento**: 10GB disponible
- **Ancho de banda**: Estable

### Límites del Sistema:
```bash
# En /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536
* soft nproc 32768
* hard nproc 32768
```

## 🌐 URLs de Acceso

- **Dashboard**: http://localhost:8083
- **Sesiones**: http://localhost:8083/sessions
- **API Estadísticas**: http://localhost:8083/api/stats
- **API Rendimiento Linux**: http://localhost:8083/api/linux-performance

## 🎯 Herramientas de Monitoreo

### Benchmark de Rendimiento
```bash
# Ejecutar benchmark completo
node benchmark-performance.js

# Salida ejemplo:
🚀 Iniciando benchmark de rendimiento...
📋 Plataforma: linux
💻 CPUs: 4
🧠 Memoria: 4096MB

🧪 Test 1: Velocidad de creación de sesiones...
   ✅ Completado en 150ms
🧪 Test 2: Uso de memoria...
   ✅ Incremento de memoria: 12.5MB
🧪 Test 3: Velocidad de carga de módulos...
   ✅ Completado en 450ms
🧪 Test 4: Capacidad de respuesta del sistema...
   ✅ Tiempo promedio: 15ms

📊 REPORTE DE RENDIMIENTO
✅ Tests pasados: 4/4
🎯 Puntuación: 100%
```

### Verificación de Chrome
```bash
# Verificar qué Chrome está disponible
./check-chrome.sh

# Salida ejemplo:
🔍 Verificando opciones de Chrome/Chromium en tu sistema...
📋 Sistema: Ubuntu 20.04.6 LTS

✅ Google Chrome Estable: /usr/bin/google-chrome-stable
   Versión: Google Chrome 120.0.6099.109
✅ Chromium Browser: /usr/bin/chromium-browser
   Versión: Chromium 108.0.5359.71

🚀 RECOMENDACIÓN:
   Usar: Google Chrome Estable
   Ruta: /usr/bin/google-chrome-stable
```

## 📈 Comparación de Rendimiento: Windows vs Linux

### Rendimiento Esperado (después de optimizaciones)

| Métrica | Windows | Linux (Antes) | Linux (Optimizado) |
|---------|---------|---------------|-------------------|
| **Tiempo inicio sesión** | 2-3s | 8-12s | 3-5s ⚡ |
| **Uso de memoria** | 150-200MB | 300-400MB | 180-250MB ⚡ |
| **QR Generation** | 1-2s | 5-8s | 2-3s ⚡ |
| **Estabilidad** | 95% | 70% | 90% ⚡ |
| **Sesiones simultáneas** | 50 | 25 | 15 (optimizada) ⚡ |

### Factores de Diferencia de Rendimiento

#### ¿Por qué Windows es más rápido?
1. **GUI Nativo**: Windows tiene interfaz gráfica nativa
2. **Chrome Optimizado**: Chrome está más optimizado para Windows  
3. **Gestión de Memoria**: Windows es más agresivo con la memoria
4. **Menos Overhead**: No necesita Xvfb ni virtualización de display

#### ¿Cómo hemos optimizado Linux?
1. **40+ argumentos de Chrome optimizados** para entorno headless
2. **Configuraciones del kernel** para mejor I/O y red
3. **Gestión automática de memoria** con limpieza periódica
4. **Pool de sesiones precalentadas** para respuesta más rápida
5. **Detección automática del mejor Chrome** disponible

### Recomendaciones por Tipo de Servidor

#### **VPS Básico (1-2GB RAM)**
```bash
# Configuración conservadora
MAX_SESSIONS=5
node_args="--max-old-space-size=512"
```

#### **VPS Medio (4GB RAM)**
```bash
# Configuración estándar (recomendada)
MAX_SESSIONS=10
node_args="--max-old-space-size=1024"
```

#### **Servidor Dedicado (8GB+ RAM)**
```bash
# Configuración agresiva
MAX_SESSIONS=15
node_args="--max-old-space-size=2048"
```

## ⚠️ Notas Importantes

1. **Reiniciar terminal** después de la instalación para cargar variables de entorno
2. **Configurar firewall** si es necesario  
3. **Monitorear logs** regularmente: `pm2 logs whatsapp-api`
4. **Ejecutar benchmark** periódicamente: `node benchmark-performance.js`
5. **Limpiar cachés** automáticamente (configurado cada 5 min)
6. **Ajustar MAX_SESSIONS** según recursos del servidor

## 🆘 Soporte

Si continúas teniendo problemas:

1. Verifica que Chromium esté instalado: `chromium-browser --version`
2. Verifica que Xvfb esté corriendo: `ps aux | grep Xvfb`
3. Revisa los logs: `pm2 logs whatsapp-api`
4. Verifica memoria disponible: `free -h`
5. Verifica espacio en disco: `df -h` 