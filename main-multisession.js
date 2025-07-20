const express = require('express');
const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const cors = require('cors');
const { EventEmitter } = require('events');
const whatsappSessionManager = require('./WhatsappSessionManager');

// Configurar límites de event listeners
EventEmitter.defaultMaxListeners = 20;
process.setMaxListeners(20);

// Configuración de logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ 
            filename: './logs/app.log',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5
        })
    ]
});

// Configurar logger para el session manager
whatsappSessionManager.logger = logger;

// Configuración de Express
const app = express();
const port = process.env.PORT || 8083;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuración de Multer para uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 30 * 1024 * 1024 }
});

// Crear directorio de logs si no existe
if (!fs.existsSync('./logs')) {
    fs.mkdirSync('./logs', { recursive: true });
}

// Variables globales para asignaciones Laravel
let laravelEnvPath = process.env.LARAVEL_ENV_PATH || '../.env';
const sessionAssignments = {
    sells: null,
    coordination: null
};

// Funciones auxiliares para Laravel .env
function updateLaravelEnv(key, value) {
    try {
        if (!fs.existsSync(laravelEnvPath)) {
            logger.warn(`Archivo Laravel .env no encontrado en: ${laravelEnvPath}`);
            return false;
        }

        let envContent = fs.readFileSync(laravelEnvPath, 'utf8');
        const lines = envContent.split('\n');
        let found = false;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`${key}=`)) {
                lines[i] = `${key}=${value || ''}`;
                found = true;
                break;
            }
        }

        if (!found) {
            lines.push(`${key}=${value || ''}`);
        }

        fs.writeFileSync(laravelEnvPath, lines.join('\n'));
        logger.info(`✅ Laravel .env actualizado: ${key}=${value || 'VACÍO'}`);
        return true;

    } catch (error) {
        logger.error(`❌ Error actualizando Laravel .env: ${error.message}`);
        return false;
    }
}

function getCurrentAssignmentsFromEnv() {
    try {
        if (!fs.existsSync(laravelEnvPath)) {
            return { sells: null, coordination: null };
        }

        const envContent = fs.readFileSync(laravelEnvPath, 'utf8');
        const lines = envContent.split('\n');
        
        const assignments = { sells: null, coordination: null };
        
        for (const line of lines) {
            if (line.startsWith('WHATSAPP_VENTAS_URL=')) {
                const sessionId = line.split('sessions/')[1]?.split('/')[0];
                if (sessionId) assignments.sells = sessionId;
            } else if (line.startsWith('WHATSAPP_COORDINACION_URL=')) {
                const sessionId = line.split('sessions/')[1]?.split('/')[0];
                if (sessionId) assignments.coordination = sessionId;
            }
        }
        
        return assignments;
    } catch (error) {
        logger.error(`Error leyendo asignaciones del .env: ${error.message}`);
        return { sells: null, coordination: null };
    }
}

// Callback para cuando se genera un QR
const onQRGenerated = (sessionId, qrData, qrString) => {
    logger.info(`[${sessionId}] 📱 QR code generado y listo para escanear`);
};

// Callback para cuando una sesión está lista
const onSessionReady = (sessionId, sessionInstance) => {
    logger.info(`[${sessionId}] 🚀 Sesión lista para enviar mensajes`);
    logger.info(`[${sessionId}] 📞 Número conectado: ${sessionInstance.phoneNumber || 'Desconocido'}`);
};

// RUTAS PRINCIPALES

// Dashboard principal
app.get('/', (req, res) => {
    const stats = whatsappSessionManager.getStats();
    const currentAssignments = getCurrentAssignmentsFromEnv();
    
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Multi-Session Dashboard</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    color: white; 
                    padding: 30px; 
                    min-height: 100vh; 
                }
                .container { max-width: 1200px; margin: 0 auto; }
                .header { text-align: center; margin-bottom: 40px; }
                .header h1 { font-size: 3rem; margin-bottom: 10px; }
                .header p { font-size: 1.2rem; opacity: 0.9; }
                .stats { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                    gap: 20px; 
                    margin-bottom: 40px; 
                }
                .stat-card { 
                    background: rgba(255,255,255,0.1); 
                    padding: 20px; 
                    border-radius: 15px; 
                    text-align: center; 
                    backdrop-filter: blur(10px); 
                }
                .stat-number { font-size: 2.5rem; font-weight: bold; margin-bottom: 5px; }
                .stat-label { font-size: 0.9rem; opacity: 0.8; }
                .actions { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
                    gap: 20px; 
                    margin-bottom: 40px; 
                }
                .action-card { 
                    background: rgba(255,255,255,0.15); 
                    padding: 30px; 
                    border-radius: 15px; 
                    backdrop-filter: blur(10px); 
                }
                .action-card h3 { margin-bottom: 15px; font-size: 1.5rem; }
                .btn { 
                    background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); 
                    color: white; 
                    border: none; 
                    padding: 12px 24px; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    font-size: 1rem; 
                    transition: all 0.3s ease; 
                    text-decoration: none; 
                    display: inline-block; 
                }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
                .btn-secondary { background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%); }
                .assignments { 
                    background: rgba(255,255,255,0.1); 
                    padding: 20px; 
                    border-radius: 15px; 
                    backdrop-filter: blur(10px); 
                }
                .assignment-row { 
                    display: flex; 
                    justify-content: space-between; 
                    align-items: center; 
                    padding: 10px 0; 
                    border-bottom: 1px solid rgba(255,255,255,0.1); 
                }
                .assignment-type { font-weight: bold; }
                .assignment-value { opacity: 0.8; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📱 WhatsApp Multi-Session</h1>
                    <p>Dashboard de gestión de sesiones múltiples</p>
                </div>

                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${stats.totalSessions}</div>
                        <div class="stat-label">Total Sesiones</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${stats.readySessions}</div>
                        <div class="stat-label">Sesiones Listas</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${stats.sessionsWithQR}</div>
                        <div class="stat-label">Con QR Disponible</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${stats.loadingSessions}</div>
                        <div class="stat-label">Cargando</div>
                    </div>
                </div>

                <div class="actions">
                    <div class="action-card">
                        <h3>🆕 Nueva Sesión</h3>
                        <p>Crear una nueva sesión de WhatsApp</p>
                        <br>
                        <button class="btn" onclick="createSession()">Crear Sesión</button>
                    </div>
                    <div class="action-card">
                        <h3>📋 Ver Sesiones</h3>
                        <p>Administrar sesiones existentes</p>
                        <br>
                        <a href="/sessions" class="btn btn-secondary">Ver Sesiones</a>
                    </div>
                    <div class="action-card">
                        <h3>🔄 Restaurar Sesiones</h3>
                        <p>Restaurar sesiones guardadas</p>
                        <br>
                        <button class="btn btn-secondary" onclick="restoreSessions()">Restaurar</button>
                    </div>
                    <div class="action-card">
                        <h3>📊 Estadísticas</h3>
                        <p>Ver estadísticas detalladas</p>
                        <br>
                        <a href="/api/stats" class="btn btn-secondary" target="_blank">Ver Stats</a>
                    </div>
                </div>

                <div class="assignments">
                    <h3>🎯 Asignaciones Laravel</h3>
                    <div class="assignment-row">
                        <span class="assignment-type">💰 Ventas:</span>
                        <span class="assignment-value">${currentAssignments.sells || 'No asignado'}</span>
                    </div>
                    <div class="assignment-row">
                        <span class="assignment-type">🎯 Coordinación:</span>
                        <span class="assignment-value">${currentAssignments.coordination || 'No asignado'}</span>
                    </div>
                </div>
            </div>

            <script>
                async function createSession() {
                    try {
                        const response = await fetch('/api/sessions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({})
                        });
                        
                        const data = await response.json();
                        
                        if (response.ok) {
                            alert('✅ Sesión creada: ' + data.sessionId.substring(0, 8) + '...');
                            window.location.reload();
                        } else {
                            throw new Error(data.error);
                        }
                    } catch (error) {
                        alert('❌ Error: ' + error.message);
                    }
                }

                async function restoreSessions() {
                    try {
                        const response = await fetch('/api/restore-sessions', {
                            method: 'POST'
                        });
                        
                        const data = await response.json();
                        
                        if (response.ok) {
                            alert('✅ ' + data.message);
                            window.location.reload();
                        } else {
                            throw new Error(data.error);
                        }
                    } catch (error) {
                        alert('❌ Error: ' + error.message);
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// API: Crear nueva sesión
app.post('/api/sessions', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || uuidv4();
        
        // Verificar si ya existe
        const existingSession = whatsappSessionManager.getClientFromSessionId(sessionId);
        if (existingSession) {
            return res.status(400).json({ error: 'La sesión ya existe' });
        }

        // Crear sesión usando el manager
        const session = whatsappSessionManager.createWAClient(
            sessionId,
            onQRGenerated,
            onSessionReady
        );

        res.json({
            success: true,
            sessionId: sessionId,
            message: 'Sesión creada exitosamente',
            qrUrl: `/api/sessions/${sessionId}/qr`,
            statusUrl: `/api/sessions/${sessionId}/status`
        });

    } catch (error) {
        logger.error(`Error creando sesión: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Obtener todas las sesiones
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = whatsappSessionManager.getAllSessions();
        const stats = whatsappSessionManager.getStats();
        
        res.json({
            success: true,
            sessions: sessions,
            stats: stats
        });
    } catch (error) {
        logger.error(`Error obteniendo sesiones: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Obtener QR de una sesión
app.get('/api/sessions/:id/qr', (req, res) => {
    try {
        const sessionId = req.params.id;
        const session = whatsappSessionManager.getClientFromSessionId(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        if (!session.qrData) {
            return res.status(404).json({ error: 'QR no disponible' });
        }

        // Retornar imagen QR
        const base64Data = session.qrData.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        
        res.set('Content-Type', 'image/png');
        res.send(imgBuffer);

    } catch (error) {
        logger.error(`Error obteniendo QR: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Estado de una sesión
app.get('/api/sessions/:id/status', (req, res) => {
    try {
        const sessionId = req.params.id;
        const session = whatsappSessionManager.getClientFromSessionId(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        res.json(session.getStatus());

    } catch (error) {
        logger.error(`Error obteniendo estado: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Regenerar QR de una sesión
app.post('/api/sessions/:id/regenerate-qr', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const session = whatsappSessionManager.getClientFromSessionId(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        // Regenerar QR a través del método de la sesión
        await session.generateQR();
        
        res.json({
            success: true,
            message: 'QR regenerado exitosamente'
        });

    } catch (error) {
        logger.error(`Error regenerando QR: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Reiniciar sesión
app.post('/api/sessions/:id/restart', async (req, res) => {
    try {
        const sessionId = req.params.id;
        
        await whatsappSessionManager.restartSession(sessionId);
        
        res.json({
            success: true,
            message: 'Sesión reiniciada exitosamente'
        });

    } catch (error) {
        logger.error(`Error reiniciando sesión: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Eliminar sesión
app.delete('/api/sessions/:id', async (req, res) => {
    try {
        const sessionId = req.params.id;
        
        const success = await whatsappSessionManager.removeSession(sessionId);
        
        if (success) {
            res.json({
                success: true,
                message: 'Sesión eliminada exitosamente'
            });
        } else {
            res.status(404).json({ error: 'Sesión no encontrada' });
        }

    } catch (error) {
        logger.error(`Error eliminando sesión: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Restaurar sesiones previas
app.post('/api/restore-sessions', async (req, res) => {
    try {
        await whatsappSessionManager.restorePreviousSessions();
        
        res.json({
            success: true,
            message: 'Sesiones restauradas exitosamente'
        });

    } catch (error) {
        logger.error(`Error restaurando sesiones: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Enviar mensaje
app.post('/api/sessions/:id/send-message', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const { phoneNumber, message } = req.body;

        if (!phoneNumber || !message) {
            return res.status(400).json({ error: 'phoneNumber y message son requeridos' });
        }

        const result = await whatsappSessionManager.sendMessage(sessionId, phoneNumber, message);
        
        res.json({
            success: true,
            message: 'Mensaje enviado exitosamente',
            messageId: result.id
        });

    } catch (error) {
        logger.error(`Error enviando mensaje: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Asignar número a Laravel
app.post('/api/assign-number', (req, res) => {
    try {
        const { sessionId, type } = req.body;

        if (!type || !['sells', 'coordination'].includes(type)) {
            return res.status(400).json({ error: 'Tipo debe ser "sells" o "coordination"' });
        }

        const session = sessionId ? whatsappSessionManager.getClientFromSessionId(sessionId) : null;
        
        if (sessionId && !session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        if (sessionId && (!session.isReady || !session.phoneNumber)) {
            return res.status(400).json({ error: 'Sesión no está lista o no tiene número' });
        }

        // Actualizar asignaciones
        const envKey = type === 'sells' ? 'WHATSAPP_VENTAS_URL' : 'WHATSAPP_COORDINACION_URL';
        const url = sessionId ? `http://localhost:${port}/api/sessions/${sessionId}/send-message` : '';
        
        const success = updateLaravelEnv(envKey, url);
        
        if (success) {
            sessionAssignments[type] = sessionId;
            
            res.json({
                success: true,
                message: `Número ${sessionId ? 'asignado' : 'desasignado'} exitosamente`,
                assignment: {
                    type: type,
                    sessionId: sessionId,
                    phoneNumber: session?.phoneNumber || null
                }
            });
        } else {
            res.status(500).json({ error: 'Error actualizando archivo .env' });
        }

    } catch (error) {
        logger.error(`Error en asignación: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Obtener asignaciones actuales
app.get('/api/current-assignments', (req, res) => {
    try {
        const assignments = getCurrentAssignmentsFromEnv();
        res.json(assignments);
    } catch (error) {
        logger.error(`Error obteniendo asignaciones: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Estadísticas del sistema
app.get('/api/stats', (req, res) => {
    try {
        const stats = whatsappSessionManager.getStats();
        const assignments = getCurrentAssignmentsFromEnv();
        const linuxStats = whatsappSessionManager.getLinuxPerformanceStats();
        
        res.json({
            sessionStats: stats,
            assignments: assignments,
            systemInfo: {
                platform: os.platform(),
                arch: os.arch(),
                nodeVersion: process.version,
                uptime: Math.floor(process.uptime()),
                totalMemory: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
                freeMemory: Math.round(os.freemem() / 1024 / 1024) + 'MB',
                cpus: os.cpus().length
            },
            linuxOptimizations: linuxStats
        });
    } catch (error) {
        logger.error(`Error obteniendo estadísticas: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Rendimiento específico de Linux
app.get('/api/linux-performance', (req, res) => {
    try {
        if (process.platform !== 'linux') {
            return res.json({ 
                error: 'Este endpoint solo está disponible en Linux',
                platform: process.platform 
            });
        }

        const linuxStats = whatsappSessionManager.getLinuxPerformanceStats();
        const loadavg = os.loadavg();
        
        res.json({
            ...linuxStats,
            systemLoad: {
                '1min': loadavg[0].toFixed(2),
                '5min': loadavg[1].toFixed(2),
                '15min': loadavg[2].toFixed(2)
            },
            timestamp: new Date().toISOString(),
            recommendations: generateLinuxRecommendations(linuxStats)
        });
    } catch (error) {
        logger.error(`Error obteniendo stats de Linux: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Función para generar recomendaciones de rendimiento
function generateLinuxRecommendations(stats) {
    const recommendations = [];
    
    if (!stats.memoryUsage) return recommendations;
    
    const heapUsed = parseInt(stats.memoryUsage.heapUsed);
    const rss = parseInt(stats.memoryUsage.rss);
    
    if (heapUsed > 300) {
        recommendations.push('⚠️ Alto uso de memoria heap - considera reiniciar algunas sesiones');
    }
    
    if (rss > 500) {
        recommendations.push('⚠️ Alto uso de memoria RSS - ejecuta limpieza automática');
    }
    
    const uptime = parseInt(stats.uptime);
    if (uptime > 720) { // 12 horas
        recommendations.push('💡 Considera reiniciar el servicio para optimizar rendimiento');
    }
    
    if (Date.now() - stats.lastCleanup > 600000) { // 10 minutos
        recommendations.push('🧹 Ejecutar limpieza de memoria recomendada');
    }
    
    return recommendations;
}

// Página de sesiones (reutilizar la existente)
app.get('/sessions', (req, res) => {
    res.sendFile(path.join(__dirname, 'sessions-view.html'));
});

// Inicializar servidor
async function startServer() {
    try {
        // Crear directorios necesarios
        const dirs = ['./logs', './uploads', './.wwebjs_auth'];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        // Restaurar sesiones previas al inicio
        await whatsappSessionManager.restorePreviousSessions();

        // Iniciar servidor
        app.listen(port, () => {
            logger.info(`🚀 WhatsApp Multi-Session Server corriendo en http://localhost:${port}`);
            logger.info(`📱 Sistema de sesiones múltiples ACTIVADO`);
            logger.info(`🔧 Máximo ${whatsappSessionManager.maxConcurrentSessions} sesiones simultáneas`);
            logger.info(`📊 Dashboard: http://localhost:${port}`);
            logger.info(`📋 Sesiones: http://localhost:${port}/sessions`);
        });

        // Limpieza al cerrar
        process.on('SIGINT', async () => {
            logger.info('🛑 Cerrando servidor...');
            await whatsappSessionManager.cleanup();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('🛑 Cerrando servidor...');
            await whatsappSessionManager.cleanup();
            process.exit(0);
        });

    } catch (error) {
        logger.error(`❌ Error iniciando servidor: ${error.message}`);
        process.exit(1);
    }
}

// Iniciar el servidor
startServer(); 