const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore } = require('baileys');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const winston = require('winston');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const cors = require('cors');
const pino = require('pino');
const crypto = require('crypto');
global.crypto = crypto;

// 1. Configuración inicial
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: 'logs/app.log',
            maxsize: 5 * 1024 * 1024 // 5MB
        })
    ]
});

const app = express();

// Permitir CORS para TODOS los dominios
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const port = process.env.PORT || 8083;

// Archivo para almacenar información de sesiones
const SESSION_INFO_FILE = path.join(__dirname, 'session-info.json');

// 2. Configuración de middleware
app.use(express.json());
app.use(express.static('public'));
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

// 3. Almacenamiento de sesiones
const sessions = new Map(); // { sessionId → { sock, qrData, status, lastActivity } }
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

// Variables globales para asignaciones Laravel
let laravelEnvPath = process.env.LARAVEL_ENV_PATH || '../redis-laravel/.env';
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

// Función para guardar información de sesiones para persistencia
const saveSessionInfo = () => {
    try {
        const sessionInfo = Array.from(sessions.entries()).map(([id, session]) => {
            let phoneNumber = null;
            let infoData = null;

            try {
                phoneNumber = session.phoneNumber || null;

                if (session.sock && session.status === 'authenticated') {
                    infoData = {
                        wid: session.sock.user?.id,
                        pushname: session.sock.user?.name,
                        platform: session.sock.user?.platform
                    };
                }
            } catch (err) {
                logger.warn(`[${id}] Error obteniendo información: ${err.message}`);
            }

            return {
                sessionId: id,
                status: session.status,
                lastActivity: session.lastActivity,
                phoneNumber: phoneNumber,
                authenticated: session.status === 'authenticated',
                reconnecting: session.status === 'reconnecting',
                infoData: infoData,
                timestamp: Date.now()
            };
        });

        if (fs.existsSync(SESSION_INFO_FILE)) {
            try {
                fs.copyFileSync(SESSION_INFO_FILE, `${SESSION_INFO_FILE}.bak`);
            } catch (err) {
                logger.warn(`Error creando backup de session-info: ${err.message}`);
            }
        }

        fs.writeFileSync(SESSION_INFO_FILE, JSON.stringify(sessionInfo, null, 2));
        logger.debug(`Información de sesiones guardada en ${SESSION_INFO_FILE}`);
    } catch (error) {
        logger.error(`Error guardando información de sesiones: ${error.message}`);
    }
};

// 4. Creación de cliente Baileys
const createBaileysClient = async (sessionId, isRestore = false) => {
    const sessionDir = path.join(__dirname, 'sessions', sessionId);
    
    // Crear directorio de sesión
    await fs.ensureDir(sessionDir);
    
    // Obtener estado de autenticación
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Obtener versión más reciente de Baileys
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`[${sessionId}] Usando Baileys v${version.join('.')}, última versión: ${isLatest}`);

    // Configurar socket
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['WhatsApp Multi-Session', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return {
                conversation: 'Hello'
            };
        },
        // Configuraciones adicionales para compatibilidad
        markOnlineOnConnect: false,
        retryRequestDelayMs: 2000,
        shouldIgnoreJid: jid => jid.includes('@broadcast'),
        patchMessageBeforeSending: (msg) => {
            const requiresPatch = !!(
                msg.buttonsMessage 
                || msg.templateMessage
                || msg.listMessage
            );
            if (requiresPatch) {
                msg = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...msg,
                        },
                    },
                };
            }
            return msg;
        }
    });

    // Conectar store
    store.bind(sock.ev);

    // Manejadores de eventos
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info(`[${sessionId}] Nuevo QR generado`);
            try {
                const qrImage = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
                sessions.set(sessionId, {
                    ...sessions.get(sessionId),
                    qrData: { qr, qrImage },
                    status: 'waiting_qr',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
            } catch (err) {
                logger.error(`[${sessionId}] Error generando QR: ${err.message}`);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
            logger.warn(`[${sessionId}] Conexión cerrada debido a ${lastDisconnect?.error}, reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                sessions.set(sessionId, {
                    ...sessions.get(sessionId),
                    status: 'reconnecting',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
                
                // Reintentar conexión
                setTimeout(() => {
                    createBaileysClient(sessionId, true);
                }, 5000);
            } else {
                sessions.set(sessionId, {
                    ...sessions.get(sessionId),
                    status: 'logged_out',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
            }
        } else if (connection === 'open') {
            logger.info(`[${sessionId}] Conexión establecida`);
            
            // Obtener información del usuario
            const user = sock.user;
            const phoneNumber = user?.id?.split('@')[0];
            
            sessions.set(sessionId, {
                ...sessions.get(sessionId),
                status: 'authenticated',
                qrData: null,
                lastActivity: Date.now(),
                phoneNumber: phoneNumber,
                user: user
            });
            saveSessionInfo();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
};

// 5. Restaurar sesiones previas mejorado
const restorePreviousSessions = async () => {
    try {
        if (!fs.existsSync(SESSION_INFO_FILE)) {
            logger.info('No hay sesiones previas para restaurar');
            return;
        }

        const sessionInfo = JSON.parse(fs.readFileSync(SESSION_INFO_FILE, 'utf8'));
        logger.info(`Encontradas ${sessionInfo.length} sesiones para restaurar`);

        // Filtrar sesiones que deben restaurarse
        const sessionsToRestore = sessionInfo.filter(info => {
            // Restaurar sesiones autenticadas, reconectando, o que estaban en proceso
            return info.status === 'authenticated' || 
                   info.status === 'reconnecting' || 
                   info.status === 'awaiting_restart' ||
                   info.status === 'initializing' ||
                   info.status === 'loading';
        });

        if (sessionsToRestore.length === 0) {
            logger.info('No hay sesiones válidas para restaurar');
            return;
        }

        logger.info(`Restaurando ${sessionsToRestore.length} sesiones válidas...`);

        // Restaurar sesiones de forma escalonada para evitar sobrecarga
        for (const [index, info] of sessionsToRestore.entries()) {
            logger.info(`[${info.sessionId}] Programando restauración (${index + 1}/${sessionsToRestore.length})`);

            setTimeout(async () => {
                try {
                    logger.info(`[${info.sessionId}] Iniciando restauración...`);
                    
                    // Verificar si el directorio de sesión existe
                    const sessionDir = path.join(__dirname, 'sessions', info.sessionId);
                    if (!fs.existsSync(sessionDir)) {
                        logger.warn(`[${info.sessionId}] Directorio de sesión no encontrado, omitiendo`);
                        return;
                    }

                    const sock = await createBaileysClient(info.sessionId, true);
                    
                    sessions.set(info.sessionId, {
                        sock,
                        status: 'restoring',
                        lastActivity: Date.now(),
                        phoneNumber: info.phoneNumber,
                        user: info.infoData,
                        restoreAttempt: (info.restoreAttempt || 0) + 1
                    });
                    saveSessionInfo();
                    
                    logger.info(`[${info.sessionId}] Restauración iniciada exitosamente`);
                } catch (error) {
                    logger.error(`[${info.sessionId}] Error en restauración: ${error.message}`);
                    
                    // Configurar reintentos automáticos
                    const currentSession = sessions.get(info.sessionId);
                    const restoreAttempt = (currentSession?.restoreAttempt || 0) + 1;
                    const maxRetries = 3;

                    if (restoreAttempt < maxRetries) {
                        logger.info(`[${info.sessionId}] Reintentando restauración (${restoreAttempt}/${maxRetries}) en 30 segundos...`);
                        
                        sessions.set(info.sessionId, {
                            sock: null,
                            status: 'retry_restore',
                            lastActivity: Date.now(),
                            phoneNumber: info.phoneNumber,
                            user: info.infoData,
                            restoreAttempt: restoreAttempt,
                            lastError: error.message
                        });
                        saveSessionInfo();

                        // Reintentar después de 30 segundos
                        setTimeout(() => {
                            restoreSessionWithRetry(info.sessionId, info);
                        }, 30000);
                    } else {
                        logger.error(`[${info.sessionId}] Máximo de reintentos alcanzado, marcando como fallida`);
                        sessions.set(info.sessionId, {
                            sock: null,
                            status: 'failed',
                            lastActivity: Date.now(),
                            phoneNumber: info.phoneNumber,
                            user: info.infoData,
                            restoreAttempt: restoreAttempt,
                            lastError: error.message
                        });
                        saveSessionInfo();
                    }
                }
            }, 5000 + (index * 3000)); // Más tiempo entre restauraciones
        }
    } catch (error) {
        logger.error(`Error crítico restaurando sesiones: ${error.message}`);
    }
};

// Función auxiliar para reintentos de restauración
const restoreSessionWithRetry = async (sessionId, sessionInfo) => {
    try {
        logger.info(`[${sessionId}] Reintentando restauración...`);
        
        const sock = await createBaileysClient(sessionId, true);
        
        sessions.set(sessionId, {
            sock,
            status: 'restoring',
            lastActivity: Date.now(),
            phoneNumber: sessionInfo.phoneNumber,
            user: sessionInfo.infoData,
            restoreAttempt: sessionInfo.restoreAttempt || 1
        });
        saveSessionInfo();
        
        logger.info(`[${sessionId}] Reintento de restauración exitoso`);
    } catch (error) {
        logger.error(`[${sessionId}] Error en reintento de restauración: ${error.message}`);
        
        const currentSession = sessions.get(sessionId);
        const restoreAttempt = (currentSession?.restoreAttempt || 1) + 1;
        const maxRetries = 3;

        if (restoreAttempt < maxRetries) {
            logger.info(`[${sessionId}] Programando siguiente reintento (${restoreAttempt}/${maxRetries}) en 60 segundos...`);
            
            sessions.set(sessionId, {
                sock: null,
                status: 'retry_restore',
                lastActivity: Date.now(),
                phoneNumber: sessionInfo.phoneNumber,
                user: sessionInfo.infoData,
                restoreAttempt: restoreAttempt,
                lastError: error.message
            });
            saveSessionInfo();

            setTimeout(() => {
                restoreSessionWithRetry(sessionId, sessionInfo);
            }, 60000);
        } else {
            logger.error(`[${sessionId}] Máximo de reintentos alcanzado, marcando como fallida`);
            sessions.set(sessionId, {
                sock: null,
                status: 'failed',
                lastActivity: Date.now(),
                phoneNumber: sessionInfo.phoneNumber,
                user: sessionInfo.infoData,
                restoreAttempt: restoreAttempt,
                lastError: error.message
            });
            saveSessionInfo();
        }
    }
};

// --- MEJORA 1: monitorAndRestoreSessions ---
const forceReconnectTimeout = 15 * 60 * 1000; // 15 minutos para forzar reconexión

const monitorAndRestoreSessions = async () => {
    try {
        const now = Date.now();
        const sessionTimeout = 5 * 60 * 1000; // 5 minutos sin actividad

        for (const [sessionId, session] of sessions.entries()) {
            const inactiveTime = now - (session.lastActivity || 0);

            // Forzar reconexión si la sesión lleva mucho tiempo inactiva
            if (inactiveTime > forceReconnectTimeout) {
                logger.warn(`[${sessionId}] Sesión inactiva por ${Math.floor(inactiveTime / 1000)}s, forzando reconexión...`);
                try {
                    if (session.sock) {
                        await session.sock.logout().catch(() => {});
                    }
                    const newSock = await createBaileysClient(sessionId, true);
                    sessions.set(sessionId, {
                        sock: newSock,
                        status: 'restoring',
                        lastActivity: Date.now(),
                        phoneNumber: session.phoneNumber,
                        user: session.user
                    });
                    saveSessionInfo();
                    logger.info(`[${sessionId}] Reconexión forzada exitosa`);
                } catch (error) {
                    logger.error(`[${sessionId}] Error en reconexión forzada: ${error.message}`);
                }
                continue;
            }

            // Verificar sesiones que han estado inactivas por mucho tiempo
            if (session.lastActivity && (now - session.lastActivity) > sessionTimeout) {
                logger.warn(`[${sessionId}] Sesión inactiva por ${Math.floor((now - session.lastActivity) / 1000)}s`);
                
                // Si la sesión está autenticada pero inactiva, intentar reconectar
                if (session.status === 'authenticated' && session.sock) {
                    try {
                        // Verificar si la conexión sigue activa
                        const isConnected = session.sock.user && session.sock.user.id;
                        if (!isConnected) {
                            logger.warn(`[${sessionId}] Sesión desconectada detectada, iniciando reconexión...`);
                            
                            sessions.set(sessionId, {
                                ...session,
                                status: 'reconnecting',
                                lastActivity: now
                            });
                            saveSessionInfo();

                            // Intentar reconectar
                            setTimeout(async () => {
                                try {
                                    const newSock = await createBaileysClient(sessionId, true);
                                    sessions.set(sessionId, {
                                        sock: newSock,
                                        status: 'restoring',
                                        lastActivity: Date.now(),
                                        phoneNumber: session.phoneNumber,
                                        user: session.user
                                    });
                                    saveSessionInfo();
                                    logger.info(`[${sessionId}] Reconexión iniciada`);
                                } catch (error) {
                                    logger.error(`[${sessionId}] Error en reconexión automática: ${error.message}`);
                                    sessions.set(sessionId, {
                                        ...session,
                                        status: 'failed',
                                        lastActivity: Date.now(),
                                        lastError: error.message
                                    });
                                    saveSessionInfo();
                                }
                            }, 5000);
                        }
                    } catch (error) {
                        logger.error(`[${sessionId}] Error verificando conexión: ${error.message}`);
                    }
                }
            }

            // Verificar sesiones en estado de reintento que han estado así por mucho tiempo
            if (session.status === 'retry_restore' && session.lastActivity) {
                const retryTimeout = 10 * 60 * 1000; // 10 minutos
                if ((now - session.lastActivity) > retryTimeout) {
                    logger.warn(`[${sessionId}] Sesión en reintento por mucho tiempo, forzando nuevo intento...`);
                    
                    // Forzar nuevo intento de restauración
                    setTimeout(async () => {
                        try {
                            const newSock = await createBaileysClient(sessionId, true);
                            sessions.set(sessionId, {
                                sock: newSock,
                                status: 'restoring',
                                lastActivity: Date.now(),
                                phoneNumber: session.phoneNumber,
                                user: session.user,
                                restoreAttempt: (session.restoreAttempt || 0) + 1
                            });
                            saveSessionInfo();
                            logger.info(`[${sessionId}] Restauración forzada iniciada`);
                        } catch (error) {
                            logger.error(`[${sessionId}] Error en restauración forzada: ${error.message}`);
                        }
                    }, 10000);
                }
            }
        }
    } catch (error) {
        logger.error(`Error en monitoreo automático: ${error.message}`);
    }
};
// --- FIN MEJORA 1 ---

// 6. Endpoints
app.post('/api/sessions', async (req, res) => {
    const sessionId = uuidv4();

    try {
        const sock = await createBaileysClient(sessionId);
        sessions.set(sessionId, {
            sock,
            status: 'initializing',
            lastActivity: Date.now()
        });
        saveSessionInfo();

        res.json({
            sessionId,
            qrUrl: `/api/sessions/${sessionId}/qr`,
            statusUrl: `/api/sessions/${sessionId}/status`
        });
    } catch (error) {
        logger.error(`[${sessionId}] Error creando sesión: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// --- MEJORA 2: Envío de mensajes con reconexión en caliente ---
app.post('/api/sessions/:id/send-message', upload.single('archivo'), async (req, res) => {
    const sessionId = req.params.id;
    let session = sessions.get(sessionId);

    let { numero, mensaje } = req.body;
    const archivo = req.file;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }
    numero = numero.replace(/@.*$/, '');
    const jid = `${numero}@s.whatsapp.net`;

    // Función auxiliar para intentar enviar el mensaje
    async function trySend(sock) {
        if (archivo) {
            logger.info(`[${sessionId}] Recibido archivo: ${archivo.originalname}, tamaño: ${archivo.size}, tipo: ${archivo.mimetype}`);
            if (archivo.size > 15 * 1024 * 1024) {
                return res.status(400).json({ error: 'El archivo es demasiado grande. WhatsApp tiene un límite de 16MB' });
            }
            const fileData = fs.readFileSync(archivo.path);
            const fileMimeType = archivo.mimetype || mime.lookup(archivo.path) || 'application/octet-stream';
            const fileName = archivo.originalname || `file_${Date.now()}${path.extname(archivo.originalname) || '.dat'}`;
            await sock.sendMessage(jid, {
                document: fileData,
                mimetype: fileMimeType,
                fileName: fileName,
                caption: mensaje || ''
            });
            try { fs.unlinkSync(archivo.path); } catch (err) { logger.warn(`[${sessionId}] Error al eliminar archivo temporal: ${err.message}`); }
            return res.json({ success: true, message: 'Archivo enviado con éxito', sessionId, destinatario: numero });
        } else if (mensaje) {
            logger.info(`[${sessionId}] Enviando mensaje de texto a ${jid}`);
            await sock.sendMessage(jid, { text: mensaje });
            return res.json({ success: true, message: 'Mensaje de texto enviado con éxito', sessionId, destinatario: numero });
        } else {
            return res.status(400).json({ error: 'Se requiere un mensaje o un archivo' });
        }
    }

    // Si la sesión no está lista, intentar reconectar una vez y reintentar el envío
    if (!session || session.status !== 'authenticated' || !session.sock || !session.sock.user) {
        logger.warn(`[${sessionId}] Intento de envío con sesión no autenticada o socket desconectado. Intentando reconectar...`);
        try {
            if (session && session.sock) {
                await session.sock.logout().catch(() => {});
            }
            const newSock = await createBaileysClient(sessionId, true);
            sessions.set(sessionId, {
                ...session,
                sock: newSock,
                status: 'restoring',
                lastActivity: Date.now()
            });
            saveSessionInfo();
            // Esperar a que la sesión esté lista (máximo 10 segundos)
            let ready = false;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                session = sessions.get(sessionId);
                if (session && session.status === 'authenticated' && session.sock && session.sock.user) {
                    ready = true;
                    break;
                }
            }
            if (ready) {
                logger.info(`[${sessionId}] Reconexión exitosa, reintentando envío...`);
                return await trySend(session.sock);
            } else {
                logger.error(`[${sessionId}] No se pudo reconectar la sesión a tiempo.`);
                return res.status(503).json({ error: 'No se pudo reconectar la sesión. Intente nuevamente en unos segundos.', sessionId, status: 'recovering' });
            }
        } catch (err) {
            logger.error(`[${sessionId}] Error al reconectar y enviar: ${err.message}`);
            return res.status(503).json({ error: 'Error al reconectar la sesión. Intente nuevamente.', sessionId, status: 'recovering' });
        }
    }

    // Si la sesión está lista, intentar enviar normalmente
    try {
        return await trySend(session.sock);
    } catch (err) {
        logger.error(`[${sessionId}] Error al enviar el mensaje a ${jid}: ${err.message}`);
        if (err.message.includes('not-authorized') || err.message.includes('connection closed') || err.message.includes('Connection Closed') || err.message.includes('Timed Out')) {
            sessions.set(sessionId, {
                ...session,
                status: 'reconnecting',
                lastActivity: Date.now()
            });
            saveSessionInfo();
            return res.status(503).json({ error: 'Error temporal en la sesión. Se ha iniciado recuperación automática. Por favor, reintente en unos segundos.', sessionId, status: 'recovering' });
        }
        return res.status(500).json({ error: err.message });
    }
});
// --- FIN MEJORA 2 ---

app.get('/api/sessions/:id/qr', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Sesión no encontrada');

    sessions.set(req.params.id, {
        ...session,
        lastActivity: Date.now()
    });
    saveSessionInfo();

    if (session.status === 'authenticated') {
        const phoneNumber = session.phoneNumber || session.user?.id?.split('@')[0] || null;
        const currentAssignments = getCurrentAssignmentsFromEnv();

        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Sesión - ${req.params.id}</title>
                <style>
                    body { 
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        text-align: center; 
                        margin-top: 50px; 
                        padding: 20px;
                    }
                    .container { max-width: 600px; margin: 0 auto; }
                    .status-card { 
                        background: rgba(255,255,255,0.1); 
                        padding: 30px; 
                        border-radius: 15px; 
                        backdrop-filter: blur(10px); 
                        margin-bottom: 20px;
                    }
                    .phone-number { 
                        font-size: 1.5rem; 
                        font-weight: bold; 
                        margin: 20px 0; 
                        color: #25D366; 
                    }
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
                        margin: 5px;
                    }
                    .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
                    .btn-secondary { background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%); }
                    .btn-warning { background: linear-gradient(135deg, #fdcb6e 0%, #e17055 100%); }
                    .btn-custom { background: linear-gradient(135deg, #6f42c1 0%, #5a32a3 100%); }
                    .assignments { 
                        background: rgba(255,255,255,0.1); 
                        padding: 20px; 
                        border-radius: 15px; 
                        backdrop-filter: blur(10px); 
                        margin-top: 20px;
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
                    <div class="status-card">
                        <h1>📱 WhatsApp Sesión (Baileys)</h1>
                        <p style="color:#25D366; font-size: 1.2rem;">✅ Autenticada y lista</p>
                        <div class="phone-number">📞 ${phoneNumber || 'Número no disponible'}</div>
                        <p><strong>Sesión ID:</strong> ${req.params.id}</p>
                        
                        <div style="margin: 30px 0;">
                            <button class="btn" onclick="window.open('/api/sessions/${req.params.id}/status', '_blank')">
                                📊 Ver Estado
                            </button>
                            <button class="btn btn-secondary" onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())">
                                🔄 Reiniciar
                            </button>
                        </div>
                    </div>

                    <div class="assignments">
                        <h3>🎯 Asignar a Laravel</h3>
                        <div class="assignment-row">
                            <span class="assignment-type">💰 Ventas:</span>
                            <span class="assignment-value">${currentAssignments.sells || 'No asignado'}</span>
                        </div>
                        <div class="assignment-row">
                            <span class="assignment-type">🎯 Coordinación:</span>
                            <span class="assignment-value">${currentAssignments.coordination || 'No asignado'}</span>
                        </div>
                        
                        <div style="margin-top: 20px;">
                            <button class="btn" onclick="assignSession('${req.params.id}', 'sells')">
                                🎯 Asignar a Ventas
                            </button>
                            <button class="btn btn-secondary" onclick="assignSession('${req.params.id}', 'coordination')">
                                🎯 Asignar a Coordinación
                            </button>
                            <button class="btn btn-custom" onclick="assignCustomNumber('${req.params.id}')">
                                📝 Asignar Número Específico
                            </button>
                            <br><br>
                            <button class="btn btn-warning" onclick="unassignSession('sells')">
                                ❌ Desasignar Ventas
                            </button>
                            <button class="btn btn-warning" onclick="unassignSession('coordination')">
                                ❌ Desasignar Coordinación
                            </button>
                        </div>
                    </div>
                </div>

                <script>
                    async function assignSession(sessionId, type) {
                        try {
                            const response = await fetch('/api/assign-number', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId, type })
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

                    async function assignCustomNumber(sessionId) {
                        const type = prompt('¿A qué tipo asignar?\n1. ventas\n2. coordinacion\n\nEscribe "ventas" o "coordinacion":');
                        if (!type || !['ventas', 'coordinacion'].includes(type.toLowerCase())) {
                            alert('❌ Tipo inválido. Debe ser "ventas" o "coordinacion"');
                            return;
                        }
                        
                        const phoneNumber = prompt('Ingresa el número de teléfono (solo números):');
                        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
                            alert('❌ Número inválido. Debe contener solo números');
                            return;
                        }
                        
                        try {
                            const response = await fetch('/api/sessions/' + sessionId + '/assign-number', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ type: type.toLowerCase(), phoneNumber })
                            });
                            
                            const data = await response.json();
                            
                            if (response.ok) {
                                alert('✅ Número ' + phoneNumber + ' asignado a ' + type.toUpperCase() + ' exitosamente!');
                                window.location.reload();
                            } else {
                                throw new Error(data.error);
                            }
                        } catch (error) {
                            alert('❌ Error: ' + error.message);
                        }
                    }

                    async function unassignSession(type) {
                        try {
                            const response = await fetch('/api/assign-number', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sessionId: null, type })
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
    }

    if (!session.qrData) {
        return res.send(`
            <html><body>
                <h1>Sesión ${req.params.id}</h1>
                <p>Generando QR o conectando... <script>setTimeout(()=>location.reload(),2000)</script></p>
                <p>Estado: ${session.status}</p>
                <p><button onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())">Reiniciar sesión</button></p>
            </body></html>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp QR - ${req.params.id}</title>
            <style>
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    color: white; 
                    text-align: center; 
                    margin: 0; 
                    padding: 20px; 
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .container { 
                    max-width: 500px; 
                    background: rgba(255,255,255,0.1); 
                    padding: 40px; 
                    border-radius: 20px; 
                    backdrop-filter: blur(10px);
                    box-shadow: 0 15px 35px rgba(0,0,0,0.1);
                }
                .qr-container { 
                    margin: 20px auto; 
                    width: 280px; 
                    background: white; 
                    padding: 20px; 
                    border-radius: 15px;
                    box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                }
                .qr-container img { 
                    width: 100%; 
                    border-radius: 10px;
                }
                .status { 
                    padding: 15px; 
                    margin: 20px 0; 
                    border-radius: 10px; 
                    background: rgba(255,255,255,0.1);
                    border-left: 4px solid #25D366;
                }
                .waiting { 
                    background: rgba(255, 193, 7, 0.2); 
                    color: #fff; 
                    border-left-color: #ffc107;
                }
                .timer { 
                    font-size: 1.2rem; 
                    font-weight: bold; 
                    color: #25D366; 
                    margin: 10px 0;
                }
                .btn { 
                    background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); 
                    color: white; 
                    border: none; 
                    padding: 12px 24px; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    font-size: 1rem; 
                    transition: all 0.3s ease; 
                    margin: 10px 5px;
                }
                .btn:hover { 
                    transform: translateY(-2px); 
                    box-shadow: 0 5px 15px rgba(0,0,0,0.3); 
                }
                .btn-secondary { 
                    background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%); 
                }
                .session-info { 
                    background: rgba(255,255,255,0.1); 
                    padding: 15px; 
                    border-radius: 10px; 
                    margin: 20px 0;
                    font-size: 0.9rem;
                }
                .auto-refresh { 
                    background: rgba(255,255,255,0.1); 
                    padding: 10px; 
                    border-radius: 8px; 
                    margin: 15px 0;
                    font-size: 0.8rem;
                    opacity: 0.8;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 WhatsApp QR (Baileys)</h1>
                
                <div class="qr-container">
                    <img src="${session.qrData.qrImage}" alt="QR Code">
                </div>
                
                <div class="status waiting">
                    <div style="font-size: 1.1rem; margin-bottom: 10px;">⏳ Escanea este código en WhatsApp</div>
                    <div style="font-size: 0.9rem; opacity: 0.9;">WhatsApp > Dispositivos vinculados</div>
                </div>
                
                <div class="timer" id="timer">⏰ Recarga automática en: <span id="countdown">30</span>s</div>
                
                <div class="session-info">
                    <p><strong>Sesión ID:</strong> ${req.params.id.substring(0, 8)}...</p>
                    <p><strong>Estado:</strong> ${session.status}</p>
                </div>
                
                <div>
                    <button class="btn" onclick="refreshQR()">
                        🔄 Recargar QR
                    </button>
                    <button class="btn btn-secondary" onclick="restartSession()">
                        🔃 Reiniciar Sesión
                    </button>
                </div>
                
                <div class="auto-refresh">
                    🔄 Auto-recarga activada - El QR se actualizará automáticamente
                </div>
            </div>
            
            <script>
                let countdown = 30;
                let autoRefreshInterval;
                let statusCheckInterval;
                
                function updateTimer() {
                    document.getElementById('countdown').textContent = countdown;
                    if (countdown <= 0) {
                        location.reload();
                    }
                    countdown--;
                }
                
                function startTimer() {
                    updateTimer();
                    autoRefreshInterval = setInterval(updateTimer, 1000);
                }
                
                function checkSessionStatus() {
                    fetch('/api/sessions/${req.params.id}/status')
                        .then(response => response.json())
                        .then(data => {
                            if (data.authenticated) {
                                clearInterval(autoRefreshInterval);
                                clearInterval(statusCheckInterval);
                                alert('✅ ¡WhatsApp conectado exitosamente!');
                                window.location.href = '/api/sessions/${req.params.id}/qr';
                            }
                        })
                        .catch(error => console.log('Error checking status:', error));
                }
                
                function refreshQR() {
                    location.reload();
                }
                
                function restartSession() {
                    if (confirm('¿Reiniciar la sesión? Esto generará un nuevo QR.')) {
                        fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'})
                            .then(() => location.reload())
                            .catch(error => alert('Error: ' + error.message));
                    }
                }
                
                // Iniciar temporizador y verificación de estado
                startTimer();
                statusCheckInterval = setInterval(checkSessionStatus, 3000);
                
                // Verificar estado cada 3 segundos
                checkSessionStatus();
                
                // Limpiar intervalos al cerrar la página
                window.addEventListener('beforeunload', () => {
                    clearInterval(autoRefreshInterval);
                    clearInterval(statusCheckInterval);
                });
            </script>
        </body>
        </html>
    `);
});

app.get('/api/sessions/:id/status', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    sessions.set(req.params.id, {
        ...session,
        lastActivity: Date.now()
    });
    saveSessionInfo();

    const phoneNumber = session.phoneNumber || session.user?.id?.split('@')[0] || null;

    res.json({
        sessionId: req.params.id,
        status: session.status,
        authenticated: session.status === 'authenticated',
        qrAvailable: !!session.qrData,
        phoneNumber: phoneNumber,
        lastActivity: session.lastActivity
    });
});

app.delete('/api/sessions/:id', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    try {
        if (session.sock) {
            await session.sock.logout();
        }

        const preserveFiles = req.query.preserve === 'true';
        if (!preserveFiles) {
            const sessionDir = path.join(__dirname, 'sessions', req.params.id);
            if (fs.existsSync(sessionDir)) {
                fs.removeSync(sessionDir);
            }
        }

        sessions.delete(req.params.id);
        saveSessionInfo();

        res.json({
            success: true,
            message: `Sesión ${req.params.id} eliminada correctamente`,
            preserved: preserveFiles
        });
    } catch (err) {
        logger.error(`Error eliminando sesión ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: 'Error al eliminar sesión' });
    }
});

app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
        sessionId: id,
        status: session.status,
        authenticated: session.status === 'authenticated',
        phoneNumber: session.phoneNumber || session.user?.id?.split('@')[0] || null,
        lastActivity: session.lastActivity
    }));

    res.json({
        count: sessionList.length,
        sessions: sessionList
    });
});

// API: Asignar número a Laravel
app.post('/api/assign-number', (req, res) => {
    try {
        const { sessionId, type } = req.body;

        if (!type || !['sells', 'coordination'].includes(type)) {
            return res.status(400).json({ error: 'Tipo debe ser "sells" o "coordination"' });
        }

        const session = sessionId ? sessions.get(sessionId) : null;
        
        if (sessionId && !session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        if (sessionId && session.status !== 'authenticated') {
            return res.status(400).json({ error: 'Sesión no está lista' });
        }

        const envKey = type === 'sells' ? 'SELLS_API_URL' : 'COORDINATION_API_URL';
        const url = sessionId ? `https://whatsapp2.probusiness.pe/api/sessions/${sessionId}/send-message` : '';
        
        const success = updateLaravelEnv(envKey, url);
        
        if (success) {
            sessionAssignments[type] = sessionId;
            
            res.json({
                success: true,
                message: `Número ${sessionId ? 'asignado' : 'desasignado'} exitosamente`,
                assignment: {
                    type: type,
                    service: type === 'sells' ? 'ventas' : 'coordinacion', // <-- NUEVO CAMPO
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

app.get('/api/current-assignments', (req, res) => {
    try {
        const assignments = getCurrentAssignmentsFromEnv();
        res.json(assignments);
    } catch (error) {
        logger.error(`Error obteniendo asignaciones: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Asignar número específico a Laravel
app.post('/api/sessions/:sessionId/assign-number', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { type, phoneNumber } = req.body; // 'ventas' o 'coordinacion' + número
        
        if (!type || !['ventas', 'coordinacion'].includes(type)) {
            return res.status(400).json({ error: 'Tipo de asignación inválido' });
        }

        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
            return res.status(400).json({ error: 'Número de teléfono inválido' });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        // Actualizar archivo .env de Laravel
        const envPath = path.join(__dirname, '..', '../redis-laravel/.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            
            // Actualizar o agregar la variable correspondiente
            const envVar = type === 'ventas' ? 'WHATSAPP_VENTAS' : 'WHATSAPP_COORDINACION';
            
            const regex = new RegExp(`^${envVar}=.*`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${envVar}=${phoneNumber}`);
            } else {
                envContent += `\n${envVar}=${phoneNumber}`;
            }
            
            fs.writeFileSync(envPath, envContent);
            logger.info(`[${sessionId}] Número ${phoneNumber} asignado a ${type}`);
        } else {
            logger.warn('Archivo Laravel .env no encontrado en: ' + envPath);
        }

        res.json({
            success: true,
            message: `Número ${phoneNumber} asignado a ${type}`,
            phoneNumber: phoneNumber
        });

    } catch (error) {
        logger.error(`Error asignando número: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Dashboard principal
app.get('/', (req, res) => {
    const stats = {
        totalSessions: sessions.size,
        readySessions: Array.from(sessions.values()).filter(s => s.status === 'authenticated').length,
        sessionsWithQR: Array.from(sessions.values()).filter(s => s.qrData).length,
        loadingSessions: Array.from(sessions.values()).filter(s => s.status === 'initializing' || s.status === 'loading').length
    };
    const currentAssignments = getCurrentAssignmentsFromEnv();
    
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Multi-Session Dashboard (Baileys)</title>
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
                    <h1>📱 WhatsApp Multi-Session (Baileys)</h1>
                    <p>Dashboard de gestión de sesiones múltiples - Versión estable</p>
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
                    <div class="stat-card">
                        <div class="stat-number">${Array.from(sessions.values()).filter(s => s.status === 'restoring' || s.status === 'retry_restore').length}</div>
                        <div class="stat-label">Restaurando</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${Array.from(sessions.values()).filter(s => s.status === 'failed').length}</div>
                        <div class="stat-label">Fallidas</div>
                    </div>
                </div>

                <div class="actions">
                    <div class="action-card">
                        <h3>🆕 Nueva Sesión</h3>
                        <p>Crear una nueva sesión de WhatsApp con Baileys</p>
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
                        <button class="btn btn-warning" onclick="forceRestoreAll()" style="margin-left: 10px;">Forzar Restauración</button>
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
                            const sessionId = data.sessionId;
                            const shortId = sessionId.substring(0, 8) + '...';
                            
                            alert('✅ Sesión creada: ' + shortId);
                            window.open('/api/sessions/' + sessionId + '/qr', '_blank');
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

                async function forceRestoreAll() {
                    if (!confirm('¿Estás seguro de que quieres forzar la restauración de todas las sesiones? Esto puede tomar varios minutos.')) {
                        return;
                    }
                    
                    try {
                        const response = await fetch('/api/force-restore-all', {
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

// API: Restaurar sesiones previas
app.post('/api/restore-sessions', async (req, res) => {
    try {
        await restorePreviousSessions();
        
        res.json({
            success: true,
            message: 'Sesiones restauradas exitosamente'
        });

    } catch (error) {
        logger.error(`Error restaurando sesiones: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Forzar restauración de todas las sesiones
app.post('/api/force-restore-all', async (req, res) => {
    try {
        logger.info('Iniciando restauración forzada de todas las sesiones...');
        
        const sessionIds = Array.from(sessions.keys());
        let restoredCount = 0;
        let failedCount = 0;

        for (const sessionId of sessionIds) {
            try {
                const session = sessions.get(sessionId);
                if (session && session.status !== 'authenticated') {
                    logger.info(`[${sessionId}] Forzando restauración...`);
                    
                    // Cerrar conexión actual si existe
                    if (session.sock) {
                        try {
                            await session.sock.logout();
                        } catch (e) {
                            // Ignorar errores al cerrar
                        }
                    }

                    // Crear nueva conexión
                    const newSock = await createBaileysClient(sessionId, true);
                    sessions.set(sessionId, {
                        sock: newSock,
                        status: 'restoring',
                        lastActivity: Date.now(),
                        phoneNumber: session.phoneNumber,
                        user: session.user,
                        restoreAttempt: (session.restoreAttempt || 0) + 1
                    });
                    saveSessionInfo();
                    
                    restoredCount++;
                    logger.info(`[${sessionId}] Restauración forzada iniciada`);
                }
            } catch (error) {
                failedCount++;
                logger.error(`[${sessionId}] Error en restauración forzada: ${error.message}`);
            }
        }

        res.json({
            success: true,
            message: `Restauración forzada completada: ${restoredCount} restauradas, ${failedCount} fallidas`,
            restored: restoredCount,
            failed: failedCount,
            total: sessionIds.length
        });

    } catch (error) {
        logger.error(`Error en restauración forzada: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API: Estadísticas del sistema
app.get('/api/stats', (req, res) => {
    try {
        const stats = {
            totalSessions: sessions.size,
            readySessions: Array.from(sessions.values()).filter(s => s.status === 'authenticated').length,
            sessionsWithQR: Array.from(sessions.values()).filter(s => s.qrData).length,
            loadingSessions: Array.from(sessions.values()).filter(s => s.status === 'initializing' || s.status === 'loading').length
        };
        
        res.json({
            sessionStats: stats,
            systemInfo: {
                platform: os.platform(),
                arch: os.arch(),
                nodeVersion: process.version,
                uptime: Math.floor(process.uptime()),
                totalMemory: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
                freeMemory: Math.round(os.freemem() / 1024 / 1024) + 'MB',
                cpus: os.cpus().length
            }
        });
    } catch (error) {
        logger.error(`Error obteniendo estadísticas: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Página de sesiones
app.get('/sessions', (req, res) => {
    res.sendFile(path.join(__dirname, 'sessions-view.html'));
});

// 7. Inicialización
(async () => {
    // Crear directorios necesarios
    ['logs', 'uploads', 'public', 'sessions'].forEach(dir => {
        fs.ensureDirSync(path.join(__dirname, dir));
    });

    logger.info('Iniciando servidor con Baileys...');

    // Restaurar sesiones previas
    await restorePreviousSessions();

    // Iniciar servidor
    app.listen(port, () => {
        logger.info(`Servidor escuchando en http://localhost:${port}`);
        logger.info(`Modo Baileys: ACTIVADO`);
    });

    // Guardar información de sesiones periódicamente
    setInterval(() => {
        saveSessionInfo();
    }, 300000); // Cada 5 minutos

    // Monitoreo automático de sesiones caídas
    setInterval(() => {
        monitorAndRestoreSessions();
    }, 60000); // Cada minuto
})();

// 8. Manejo de errores y cierre limpio
process.on('unhandledRejection', (err) => {
    logger.error(`Error no manejado: ${err.stack}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Excepción no capturada: ${err.stack}`);
});

process.on('SIGTERM', async () => {
    logger.info('Apagando limpiamente (SIGTERM)...');

    await Promise.all(
        Array.from(sessions.keys()).map(async id => {
            try {
                sessions.set(id, {
                    ...sessions.get(id),
                    status: 'awaiting_restart',
                    lastActivity: Date.now()
                });

                if (sessions.get(id).sock) {
                    await sessions.get(id).sock.logout();
                }
                logger.info(`[${id}] Sesión marcada para reinicio`);
            } catch (err) {
                logger.error(`[${id}] Error cerrando sesión: ${err.message}`);
            }
        })
    );

    saveSessionInfo();

    setTimeout(() => {
        logger.info('Proceso terminado correctamente');
        process.exit(0);
    }, 1000);
});

process.on('SIGINT', async () => {
    logger.info('Interrupción recibida (SIGINT/Ctrl+C), apagando limpiamente...');

    await Promise.all(
        Array.from(sessions.keys()).map(async id => {
            try {
                sessions.set(id, {
                    ...sessions.get(id),
                    status: 'awaiting_restart',
                    lastActivity: Date.now()
                });

                if (sessions.get(id).sock) {
                    await sessions.get(id).sock.logout();
                }
                logger.info(`[${id}] Sesión marcada para reinicio`);
            } catch (err) {
                logger.error(`[${id}] Error cerrando sesión: ${err.message}`);
            }
        })
    );

    saveSessionInfo();

    setTimeout(() => {
        logger.info('Proceso terminado correctamente');
        process.exit(0);
    }, 1000);
}); 