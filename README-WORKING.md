# WhatsApp Multi-Session - Versión Funcional

Esta es la versión del código que **funcionaba perfectamente** sin problemas de eventos `ready` ni otros errores.

## 🚀 Características

- ✅ **Gestión simple y directa de sesiones** - Sin capas de abstracción complejas
- ✅ **Manejo robusto del evento `ready`** - Sin problemas de timing
- ✅ **Persistencia de sesiones** - Las sesiones se mantienen entre reinicios
- ✅ **Recuperación automática** - Manejo inteligente de desconexiones
- ✅ **Dashboard moderno** - Interfaz web para gestión de sesiones
- ✅ **Envío de mensajes y archivos** - Funcionalidad completa de WhatsApp
- ✅ **Asignación a Laravel** - Integración con ventas y coordinación
- ✅ **Vista de QR mejorada** - Con botones de asignación automática

## 📋 Diferencias con la versión actual

### ✅ Lo que funciona en esta versión:
1. **Manejo directo de eventos** - Sin abstracciones complejas
2. **Gestión simple de sesiones** - Usando `Map` directamente
3. **Configuración de Puppeteer optimizada** - Menos propensa a errores
4. **Persistencia confiable** - Guardado y restauración de sesiones
5. **Recuperación automática** - Manejo inteligente de errores

### ❌ Problemas en la versión actual:
1. **Eventos `ready` problemáticos** - Debido a capas de abstracción
2. **Gestión compleja de sesiones** - Clases y managers innecesarios
3. **Configuración de Puppeteer compleja** - Más propensa a errores
4. **Problemas de timing** - Debido a múltiples callbacks

## 🛠️ Instalación

```bash
# Instalar dependencias
npm install

# Crear directorios necesarios
mkdir -p logs uploads public .wwebjs_auth
```

## 🚀 Uso

### Opción 1: Ejecución directa
```bash
node main-working.js
```

### Opción 2: Con PM2 (Recomendado)
```bash
# Usar la configuración específica para esta versión
pm2 start ecosystem-working.config.js

# Ver logs
pm2 logs whatsapp-multisession-working

# Reiniciar
pm2 restart whatsapp-multisession-working
```

## 📱 Uso del Dashboard

1. **Acceder al dashboard**: `http://localhost:8083`
2. **Crear nueva sesión**: Click en "Crear Sesión" (se abre automáticamente en nueva pestaña)
3. **Escanear QR**: La vista de QR se abre automáticamente
4. **Asignar a Laravel**: Usar los botones de asignación en la vista de sesión
5. **Enviar mensajes**: Usar la API o el dashboard

## 🔧 API Endpoints

### Crear sesión
```bash
POST /api/sessions
```

### Ver QR
```bash
GET /api/sessions/{sessionId}/qr
```

### Estado de sesión
```bash
GET /api/sessions/{sessionId}/status
```

### Enviar mensaje
```bash
POST /api/sessions/{sessionId}/send-message
Content-Type: multipart/form-data

{
  "numero": "34612345678",
  "mensaje": "Hola mundo"
}
```

### Enviar archivo
```bash
POST /api/sessions/{sessionId}/send-message
Content-Type: multipart/form-data

{
  "numero": "34612345678",
  "mensaje": "Mira este archivo",
  "archivo": [archivo]
}
```

### Asignar a Laravel
```bash
POST /api/assign-number
Content-Type: application/json

{
  "sessionId": "uuid-session-id",
  "type": "sells"  // o "coordination"
}
```

### Obtener asignaciones actuales
```bash
GET /api/current-assignments
```

### Reiniciar sesión
```bash
POST /api/sessions/{sessionId}/reiniciar
```

### Eliminar sesión
```bash
DELETE /api/sessions/{sessionId}
```

## 🔄 Migración desde la versión actual

Si tienes sesiones en la versión actual y quieres migrar:

1. **Detener la versión actual**:
   ```bash
   pm2 stop whatsapp-multisession
   ```

2. **Iniciar esta versión**:
   ```bash
   pm2 start ecosystem-working.config.js
   ```

3. **Las sesiones se restaurarán automáticamente** desde `session-info.json`

## 📊 Monitoreo

### Logs
- **Archivo**: `logs/app.log`
- **Nivel**: `debug` (configurable)
- **Rotación**: 5MB máximo, 5 archivos

### Estadísticas
- **Dashboard**: `http://localhost:8083`
- **API**: `GET /api/stats`

## 🛡️ Características de estabilidad

1. **Persistencia de sesiones** - Se mantienen entre reinicios
2. **Recuperación automática** - Manejo inteligente de desconexiones
3. **Limpieza de procesos** - Eliminación de procesos huérfanos
4. **Manejo de errores** - Captura y logging de errores
5. **Cierre limpio** - Guardado de estado antes de cerrar
6. **Integración Laravel** - Actualización automática del .env

## 🔧 Configuración

### Variables de entorno
```bash
PORT=8083                    # Puerto del servidor
MAX_SESSIONS=15             # Máximo de sesiones simultáneas
NODE_ENV=production         # Entorno de ejecución
LARAVEL_ENV_PATH=../.env    # Ruta al archivo .env de Laravel
```

### Configuración de Puppeteer
- **Executable**: `/usr/bin/chromium-browser` (Linux)
- **Modo**: Headless
- **Timeout**: 90 segundos
- **User Agent**: Personalizado para evitar detección

## 🚨 Solución de problemas

### Sesión no se conecta
1. Verificar que Chromium esté instalado
2. Revisar logs en `logs/app.log`
3. Reiniciar la sesión desde el dashboard

### Error de memoria
1. Reducir `MAX_SESSIONS`
2. Reiniciar el proceso PM2
3. Verificar uso de memoria del sistema

### QR no se genera
1. Verificar permisos de directorios
2. Revisar configuración de Puppeteer
3. Reiniciar la sesión

## 📝 Notas importantes

1. **Esta versión es más estable** que la versión actual
2. **Mantiene la funcionalidad completa** del dashboard
3. **Es compatible** con las sesiones existentes
4. **No requiere cambios** en el código de integración

## 🔄 Actualizaciones

Para actualizar esta versión:

1. **Hacer backup** de `session-info.json`
2. **Detener el proceso** actual
3. **Actualizar el código**
4. **Reiniciar** el proceso
5. **Verificar** que las sesiones se restauren correctamente

---

**Esta versión está basada en el código que funcionaba perfectamente y mantiene toda la funcionalidad del dashboard actual.** 