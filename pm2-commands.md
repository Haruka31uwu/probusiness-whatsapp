# 🚀 Comandos PM2 Optimizados para WhatsApp API

## 📋 Comandos Básicos

### Iniciar el servidor con PM2
```bash
pm2 start ecosystem.config.js
```

### Ver estado y monitoreo
```bash
# Estado de la aplicación
pm2 status

# Logs en tiempo real
pm2 logs whatsapp-api

# Logs con filtro
pm2 logs whatsapp-api --lines 100

# Monitoreo en tiempo real (CPU, RAM)
pm2 monit
```

### Control de la aplicación
```bash
# Reiniciar
pm2 restart whatsapp-api

# Parar
pm2 stop whatsapp-api

# Eliminar del PM2
pm2 delete whatsapp-api

# Reinicio sin downtime
pm2 reload whatsapp-api
```

## 🧹 Comandos de Limpieza de Procesos

### Verificar procesos de Chrome
```bash
# Windows
tasklist | findstr chrome.exe

# Linux
ps aux | grep chromium | grep -v grep
```

### Limpiar procesos Chrome huérfanos
```bash
# Windows - Matar todos los Chrome
taskkill /F /IM chrome.exe

# Linux - Matar Chromium huérfanos
pkill -f "chromium.*--user-data-dir.*tmp"
```

### Monitoreo de memoria
```bash
# Ver uso de memoria del proceso PM2
pm2 show whatsapp-api

# Ver procesos que más consumen memoria (Windows)
tasklist /fo csv | findstr "chrome.exe" | sort /r /+5

# Ver procesos que más consumen memoria (Linux)
ps aux --sort=-%mem | head -20
```

## ⚡ Optimización y Mantenimiento

### Configuración actual optimizada:
- **Memoria máxima**: 800MB (reinicio automático)
- **Garbage Collection**: Activado manualmente
- **Reinicio automático**: Cada 6 horas
- **Límite de procesos Chrome**: Monitoreo cada 5 minutos
- **Limpieza de huérfanos**: Automática

### Scripts de monitoreo manual
```bash
# Contar procesos Chrome activos (Windows)
tasklist | findstr chrome.exe | find /c "chrome.exe"

# Ver memoria total usada por Chrome (Windows)
wmic process where "name='chrome.exe'" get WorkingSetSize /format:value

# Verificar puertos abiertos
netstat -an | findstr :8083
```

## 🚨 Comandos de Emergencia

### Si el servidor se cuelga
```bash
# Forzar reinicio completo
pm2 kill
pm2 resurrect

# O reiniciar desde cero
pm2 delete all
pm2 start ecosystem.config.js
```

### Limpieza completa de procesos
```bash
# Windows - Limpieza total
taskkill /F /IM chrome.exe
taskkill /F /IM node.exe
pm2 kill

# Linux - Limpieza total
pkill -f chromium
pkill -f node
pm2 kill
```

## 📊 Logs y Debugging

### Ubicación de logs
```
./logs/out.log      - Salida estándar
./logs/err.log      - Errores
./logs/combined.log - Todo junto
```

### Ver logs específicos
```bash
# Solo errores
pm2 logs whatsapp-api --err

# Solo salida estándar
pm2 logs whatsapp-api --out

# Filtrar por texto
pm2 logs whatsapp-api | findstr "QR"
pm2 logs whatsapp-api | findstr "Error"
```

## 🔧 Configuración Automática

El servidor ahora incluye:
- ✅ **Limpieza automática** de procesos huérfanos cada 5 minutos
- ✅ **Monitoreo de memoria** cada 2 minutos
- ✅ **Límites estrictos** de memoria (256MB por proceso Chrome)
- ✅ **Reinicio automático** cada 6 horas para mantener limpio el sistema
- ✅ **Garbage Collection** manual activado
- ✅ **Bloqueo de QR múltiples** durante carga de WhatsApp

## 📈 Estadísticas Recomendadas

### Uso normal esperado:
- **Procesos Chrome**: < 15 (más de 20 es problemático)
- **Memoria Node.js**: < 400MB 
- **Memoria total**: < 1GB
- **CPU**: < 30% en promedio

### Alertas automáticas en logs:
- 🚨 Más de 20 procesos Chrome
- 🚨 Memoria > 512MB
- 🚨 Más de 5 sesiones activas
- 🧹 Limpieza automática ejecutándose 