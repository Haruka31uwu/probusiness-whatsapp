# 🚀 Sistema Multi-Session WhatsApp

**Solución completa para múltiples sesiones de WhatsApp sin conflictos**

## 🎯 Problema Solucionado

**ANTES:** Si 2 sesiones se inicializaban al mismo tiempo → Ambas fallaban  
**AHORA:** Cada sesión tiene su propio espacio → ✅ Sin conflictos

## 📁 Arquitectura del Sistema

```
WhatsappSessionManager (Singleton)
├── WhatsappWebSession (Clase por sesión)
│   ├── Cliente WhatsApp independiente
│   ├── Manejo de eventos propio
│   ├── QR generation individual
│   └── Limpieza automática
├── Gestión de metadatos
├── Control de límites (máx 5 sesiones)
└── Restauración automática
```

## 🛠️ Archivos Principales

### 📂 Nuevos Archivos
- `WhatsappWebSession.js` - Clase individual por sesión
- `WhatsappSessionManager.js` - Manager central (singleton)
- `main-multisession.js` - Servidor principal optimizado
- `test-multisession.js` - Script de prueba

### 📂 Archivos Actualizados
- `ecosystem.config.js` - Configurado para nuevo main
- `sessions-view.html` - Compatible con nuevas APIs

## 🚀 Cómo Usar

### **Opción 1: Prueba Simple**
```bash
# Probar sin servidor (2 sesiones simultáneas)
node test-multisession.js
```

### **Opción 2: Servidor Completo**
```bash
# Directamente con Node
node main-multisession.js

# O con PM2 (recomendado)
pm2 start ecosystem.config.js
```

### **Opción 3: PM2 Producción**
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 📱 Endpoints API

### **Crear Sesión**
```bash
POST /api/sessions
# Respuesta: { sessionId, qrUrl, statusUrl }
```

### **Ver Todas las Sesiones**
```bash
GET /api/sessions
# Respuesta: { sessions: [...], stats: {...} }
```

### **QR de Sesión**
```bash
GET /api/sessions/{sessionId}/qr
# Respuesta: Imagen PNG
```

### **Estado de Sesión**
```bash
GET /api/sessions/{sessionId}/status
# Respuesta: { status, qrAvailable, phoneNumber, ... }
```

### **Enviar Mensaje**
```bash
POST /api/sessions/{sessionId}/send-message
Body: { "phoneNumber": "1234567890", "message": "Hola!" }
```

### **Asignar a Laravel**
```bash
POST /api/assign-number
Body: { "sessionId": "abc...", "type": "sells" | "coordination" }
```

## 🌐 Interfaces Web

### **Dashboard Principal**
```
http://localhost:8083/
```
- 📊 Estadísticas en tiempo real
- 🆕 Crear nuevas sesiones
- 🔄 Restaurar sesiones
- 🎯 Ver asignaciones Laravel

### **Gestión de Sesiones**
```
http://localhost:8083/sessions
```
- 📋 Lista de todas las sesiones
- 📱 Ver QR de cada sesión
- 🔄 Reiniciar sesiones individuales
- 🗑️ Eliminar sesiones
- 💰🎯 Asignar a ventas/coordinación

## ✨ Características Principales

### **🔒 Aislamiento Completo**
- Cada sesión usa su propio directorio temporal
- Procesos Chrome independientes
- Sin interferencia entre sesiones

### **⚡ Inicialización Inteligente**
- Callback system para QR y ready events
- Inicialización asíncrona
- Restauración automática al inicio

### **🧹 Limpieza Automática**
- Limpieza de procesos Chrome huérfanos
- Eliminación de directorios temporales
- Garbage collection manual activado

### **📊 Monitoreo Avanzado**
- Estadísticas en tiempo real
- Metadatos por sesión
- Estados detallados

### **🎯 Integración Laravel**
- Actualización automática del .env
- Asignación de números a ventas/coordinación
- URLs dinámicas para cada sesión

## 🔧 Configuración Avanzada

### **Límites del Sistema**
```javascript
// En WhatsappSessionManager.js
maxConcurrentSessions: 5  // Máximo 5 sesiones simultáneas
```

### **Timeouts Optimizados**
```javascript
// En WhatsappWebSession.js
timeout: 120000          // 2 minutos conexión
protocolTimeout: 180000  // 3 minutos protocolo
```

### **Límites de Memoria**
```javascript
// En ecosystem.config.js
max_memory_restart: '800M'
node_args: '--expose-gc --max-old-space-size=768'
```

## 📋 Comandos Útiles

### **Estado del Sistema**
```bash
# Ver todas las sesiones activas
curl http://localhost:8083/api/sessions

# Ver estadísticas del sistema
curl http://localhost:8083/api/stats

# Ver asignaciones actuales
curl http://localhost:8083/api/current-assignments
```

### **Crear Sesión Programáticamente**
```bash
curl -X POST http://localhost:8083/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "mi-sesion-123"}'
```

### **Enviar Mensaje**
```bash
curl -X POST http://localhost:8083/api/sessions/mi-sesion-123/send-message \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "1234567890", "message": "Hola desde API!"}'
```

## 🐛 Debugging

### **Logs Detallados**
```bash
# Ver logs en tiempo real
pm2 logs whatsapp-api

# Ver solo errores
pm2 logs whatsapp-api --err

# Logs de una sesión específica
pm2 logs whatsapp-api | grep "[abc12345]"
```

### **Verificar Procesos**
```bash
# Procesos Chrome activos
tasklist | findstr chrome

# Memoria utilizada
pm2 show whatsapp-api
```

### **Limpiar Sistema**
```bash
# Limpiar procesos Chrome huérfanos
taskkill /F /IM chrome.exe

# Reiniciar PM2
pm2 restart whatsapp-api

# Limpieza completa
pm2 delete whatsapp-api
pm2 start ecosystem.config.js
```

## 🎯 Casos de Uso

### **1. Centro de Atención**
- 5 agentes con sesiones independientes
- Asignación dinámica por departamento
- Sin conflictos entre sesiones

### **2. Bot Multi-Cliente**
- Múltiples clientes con sus propios números
- Envío masivo sin interferencias
- Escalado horizontal

### **3. Integración Laravel**
- Ventas y coordinación separadas
- URLs dinámicas en .env
- Switch automático entre números

## ⚠️ Notas Importantes

### **Límites Recomendados**
- **Máximo 5 sesiones** simultáneas
- **1 sesión por agente** para mejor rendimiento
- **Reinicio cada 6 horas** para limpiar memoria

### **Recursos del Sistema**
- **RAM:** ~200MB por sesión
- **CPU:** 15-30% durante inicialización
- **Disk:** ~50MB por sesión (temporal)

### **Seguridad**
- Cada sesión usa directorio temporal único
- Limpieza automática al desconectar
- Sin interferencia entre usuarios

## 🔄 Migración del Sistema Anterior

### **Backup de Sesiones**
```bash
# Respaldar sesiones existentes
cp -r .wwebjs_auth .wwebjs_auth_backup
```

### **Cambiar al Nuevo Sistema**
```bash
# Parar el sistema anterior
pm2 stop whatsapp-api

# Iniciar el nuevo sistema
pm2 start ecosystem.config.js

# Verificar funcionamiento
pm2 logs whatsapp-api
```

### **Restaurar si es Necesario**
```bash
# Volver al sistema anterior
pm2 stop whatsapp-api
# Cambiar script en ecosystem.config.js a 'main.js'
pm2 start ecosystem.config.js
```

## 🎉 Ventajas del Nuevo Sistema

### **✅ Estabilidad**
- Sin conflictos entre sesiones
- Inicialización más confiable
- Menos errores de protocolo

### **✅ Escalabilidad**
- Fácil añadir más sesiones
- Gestión independiente
- Límites configurables

### **✅ Mantenimiento**
- Limpieza automática
- Logs organizados por sesión
- Reinicio individual

### **✅ Integración**
- APIs RESTful completas
- Dashboard web intuitivo
- Compatible con Laravel

---

## 🚀 **¡Listo para Producción!**

El sistema está diseñado para resolver completamente el problema de sesiones concurrentes, permitiendo múltiples conexiones WhatsApp estables y sin interferencias. 