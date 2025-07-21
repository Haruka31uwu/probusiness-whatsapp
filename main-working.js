const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const multer = require('multer');
const mime = require('mime-types');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const cors = require('cors');

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

// Permitir CORS para TODOS los dominios (no recomendado en producción)
app.use(cors({
  origin: '*', // Cualquier dominio puede acceder
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Métodos permitidos
  allowedHeaders: ['Content-Type', 'Authorization'], // Cabeceras permitidas
}));
const port = process.env.PORT || 8083;

// Archivo para almacenar información de sesiones
const SESSION_INFO_FILE = path.join(__dirname, 'session-info.json');

// 2. Configuración de middleware
app.use(express.json());
app.use(express.static('public'));
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 30 * 1024 * 1024 } // 15MB
});

// 3. Almacenamiento de sesiones
const sessions = new Map(); // { sessionId → { client, qrData, status, lastActivity } }

// Función para guardar información de sesiones para persistencia
const saveSessionInfo = () => {
    try {
        const sessionInfo = Array.from(sessions.entries()).map(([id, session]) => {
            // Recopilar más información útil para la restauración
            let phoneNumber = null;
            let infoData = null;

            try {
                phoneNumber = session.client?.info?.wid?.user || null;

                // Guardar datos relevantes del cliente para restauración
                if (session.client && session.status === 'authenticated') {
                    infoData = {
                        wid: session.client.info?.wid,
                        pushname: session.client.info?.pushname,
                        platform: session.client.info?.platform
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

        // Crear backup del archivo anterior antes de sobreescribir
        if (fs.existsSync(SESSION_INFO_FILE)) {
            try {
                fs.copyFileSync(SESSION_INFO_FILE, `${SESSION_INFO_FILE}.bak`);
            } catch (err) {
                logger.warn(`Error creando backup de session-info: ${err.message}`);
            }
        }

        // Guardar nuevo archivo
        fs.writeFileSync(SESSION_INFO_FILE, JSON.stringify(sessionInfo, null, 2));
        logger.debug(`Información de sesiones guardada en ${SESSION_INFO_FILE}`);
    } catch (error) {
        logger.error(`Error guardando información de sesiones: ${error.message}`);
    }
};

// 4. Limpieza nuclear mejorada (solo usada para eliminar sesiones específicas)
const nuclearCleanup = (sessionId) => {
    try {
        logger.debug(`[${sessionId}] Iniciando limpieza nuclear`);

        // Eliminar directorios específicos de la sesión
        [`.wwebjs_auth/session-${sessionId}`, `whatsapp-session-${sessionId}`].forEach(dir => {
            const dirPath = path.join(__dirname, dir);
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
                logger.debug(`[${sessionId}] Directorio eliminado: ${dir}`);
            }
        });

        // NO limpiar directorios comunes que podrían afectar a otras sesiones

        // Eliminar archivos temporales de Chromium
        // const tempDir = `/tmp/chrome-profile-${sessionId}`;
        // if (fs.existsSync(tempDir)) {
        //     fs.rmSync(tempDir, { recursive: true, force: true });
        //     logger.debug(`[${sessionId}] Directorio temporal eliminado: ${tempDir}`);
        // }

        // Matar procesos específicos
        exec(`pkill -f "chromium.*${sessionId}"`, (err) => {
            if (!err) logger.debug(`[${sessionId}] Procesos Chromium terminados`);
        });

    } catch (error) {
        logger.error(`[${sessionId}] Error en nuclearCleanup: ${error.message}`);
    }
};

// 5. Creación de cliente con aislamiento mejorado y preservación de datos de sesión
const createIsolatedClient = (sessionId, isRestore = false) => {
    // Solo crear directorios temporales de Chromium específicos para esta sesión
    // NO eliminar archivos existentes si es restauración
    const tempDir = `/tmp/chrome-profile-${sessionId}`;
    const sessionDir = path.join(__dirname, `.wwebjs_auth/session-${sessionId}`);

    // Crear directorios necesarios si no existen
    fs.mkdirSync(path.join(__dirname, `.wwebjs_auth/session-${sessionId}`), { recursive: true });
    fs.mkdirSync(path.join(__dirname, `whatsapp-session-${sessionId}`), { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    // Configurar opciones específicas para whatsapp-web.js
    const clientOptions = {
        authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: path.resolve(__dirname, `.wwebjs_auth`),
            restartOnAuthFail: true,
            clearAuthDataOnLogout: false // No limpiar datos de autenticación al cerrar sesión
        }),
        puppeteer: {
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-application-cache',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-sync',
                '--no-default-browser-check',
                '--no-first-run',
                '--disable-features=LockProfileCookieDatabase',
                '--disable-features=IsolateOrigins',
                '--disable-features=site-per-process',
                '--disable-features=TranslateUI',
                '--ignore-certificate-errors',
                '--ignore-ssl-errors',
                '--single-process',
                '--no-zygote',
                '--user-data-dir=' + tempDir,
                `--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.${Math.floor(Math.random() * 10000)}.0 Safari/537.36 Edg/123.0.${Math.floor(Math.random() * 1000)}.0`
            ],
            headless: true,
            timeout: isRestore ? 120000 : 90000, // Incrementar timeout para restauración
            devtools: false
        },
        webVersionCache: {
            type: 'none' // Desactivar caché de versión web
        },
        takeoverOnConflict: true, // Permitir toma de control al restaurar una sesión
        qrMaxRetries: isRestore ? 0 : 5, // No generar QR para sesiones restauradas
        authTimeoutMs: isRestore ? 90000 : 100000, // Más tiempo para restaurar
        linkingMethod: 'promptStandard',
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.${Math.floor(Math.random() * 10000)}.0 Safari/537.36 Edg/123.0.${Math.floor(Math.random() * 1000)}.0`,
        restartOnAuthFail: true,
        webVersion: '2.2414.6' // Mantener versión web fija para consistencia
    };

    const client = new Client(clientOptions);

    // Manejadores de eventos mejorados
    client.on('qr', async (qr) => {
        // No generar QR para restauraciones a menos que falle explícitamente
        if (isRestore) {
            logger.warn(`[${sessionId}] QR generado durante restauración - posible fallo de autenticación`);
            sessions.set(sessionId, {
                ...sessions.get(sessionId),
                status: 'auth_failed', // Cambiar estado si se genera QR en restauración
                lastActivity: Date.now()
            });
            saveSessionInfo();
        } else {
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
    });

    client.on('loading_screen', (percent, message) => {
        logger.debug(`[${sessionId}] Cargando: ${percent}% - ${message}`);
    });

    client.on('authenticated', async () => {
        logger.info(`[${sessionId}] Autenticado correctamente`);

        // Obtener información del cliente si está disponible
        let phoneNumber = null;
        let infoData = null;

        try {
            // Intentar obtener información del cliente
            const clientInfo = await client.getState();
            logger.info(`[${sessionId}] Estado del cliente: ${clientInfo}`);

            // Esperar un momento para que la información esté disponible
            setTimeout(async () => {
                try {
                    phoneNumber = client.info?.wid?.user;
                    infoData = {
                        wid: client.info?.wid,
                        pushname: client.info?.pushname,
                        platform: client.info?.platform
                    };

                    logger.info(`[${sessionId}] Teléfono: ${phoneNumber || 'No disponible aún'}`);

                    // Actualizar la sesión con la información obtenida
                    sessions.set(sessionId, {
                        ...sessions.get(sessionId),
                        status: 'authenticated',
                        qrData: null,
                        lastActivity: Date.now(),
                        phoneNumber: phoneNumber,
                        infoData: infoData
                    });

                    // Guardar inmediatamente la información de sesión
                    saveSessionInfo();
                } catch (err) {
                    logger.error(`[${sessionId}] Error obteniendo información adicional: ${err.message}`);
                }
            }, 2000);
        } catch (err) {
            logger.error(`[${sessionId}] Error obteniendo estado: ${err.message}`);
        }

        // Actualizar estado básico de inmediato
        sessions.set(sessionId, {
            ...sessions.get(sessionId),
            status: 'authenticated',
            qrData: null,
            lastActivity: Date.now()
        });

        saveSessionInfo();
    });

    client.on('auth_failure', (msg) => {
        logger.error(`[${sessionId}] Error de autenticación: ${msg}`);

        // Estrategia específica para problemas de autenticación
        if (isRestore) {
            logger.info(`[${sessionId}] Fallo de autenticación en restauración: ${msg}`);
            sessions.set(sessionId, {
                ...sessions.get(sessionId),
                status: 'auth_failed',
                lastActivity: Date.now()
            });
        } else {
            // Para nuevas sesiones, cambiar estado y dejar que se genere QR
            sessions.set(sessionId, {
                ...sessions.get(sessionId),
                status: 'auth_failed',
                lastActivity: Date.now()
            });
        }
        saveSessionInfo();
    });

    client.on('ready', () => {
        logger.info(`[${sessionId}] Sesión lista y conectada`);
        sessions.set(sessionId, {
            ...sessions.get(sessionId),
            status: 'authenticated',
            qrData: null,
            lastActivity: Date.now()
        });
        saveSessionInfo();
    });

    client.on('disconnected', (reason) => {
        logger.warn(`[${sessionId}] Desconectado: ${reason}`);

        // Estrategia de reconexión mejorada
        const currentSession = sessions.get(sessionId);
        if (currentSession) {
            if (reason === 'NAVIGATION' || reason.includes('CONFLICT') || reason === 'LOGOUT') {
                logger.warn(`[${sessionId}] Desconexión crítica: ${reason}, requiere reautenticación`);
                sessions.set(sessionId, {
                    ...currentSession,
                    status: 'disconnected',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
            } else {
                logger.info(`[${sessionId}] Intentando reconectar automáticamente...`);
                sessions.set(sessionId, {
                    ...currentSession,
                    status: 'reconnecting',
                    lastActivity: Date.now()
                });

                // Intentar reconexión después de un breve período
                setTimeout(() => {
                    const updatedSession = sessions.get(sessionId);
                    if (updatedSession && updatedSession.status === 'reconnecting') {
                        try {
                            logger.info(`[${sessionId}] Ejecutando reconexión...`);
                            client.initialize().catch(err => {
                                logger.error(`[${sessionId}] Error en reconexión: ${err.message}`);
                                sessions.set(sessionId, {
                                    ...sessions.get(sessionId),
                                    status: 'failed',
                                    lastActivity: Date.now()
                                });
                                saveSessionInfo();
                            });
                        } catch (err) {
                            logger.error(`[${sessionId}] Error en reconexión: ${err.message}`);
                        }
                    }
                }, 5000);
            }
        } else {
            logger.warn(`[${sessionId}] Desconectado pero la sesión ya no existe`);
        }
    });

    // Añadir manejador de errores para aumentar la robustez
    client.on('error', (err) => {
        logger.error(`[${sessionId}] Error en cliente: ${err.message}`);

        // Si hay error grave, intentar reiniciar cliente
        if (err.message.includes('disconnected') || err.message.includes('ECONNRESET')) {
            logger.info(`[${sessionId}] Intentando reiniciar después de error...`);
            setTimeout(() => {
                const currentSession = sessions.get(sessionId);
                if (currentSession && (currentSession.status === 'authenticated' || currentSession.status === 'reconnecting')) {
                    try {
                        client.initialize().catch(e => {
                            logger.error(`[${sessionId}] Error reiniciando cliente: ${e.message}`);
                        });
                    } catch (e) {
                        logger.error(`[${sessionId}] Error reiniciando cliente: ${e.message}`);
                    }
                }
            }, 3000);
        }
    });

    return client;
};

// Función específica para recuperar sesiones rotas
const recoverBrokenSession = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    logger.info(`[${sessionId}] Iniciando recuperación de sesión rota...`);

    try {
        // Intentar cerrar cliente actual si existe
        try {
            await session.client.destroy();
        } catch (e) {
            // Ignorar errores al destruir cliente roto
        }

        // Guardar información importante antes de recrear
        const savedInfo = {
            phoneNumber: session.phoneNumber,
            infoData: session.infoData
        };

        // Forzar cierre de procesos de Chromium residuales
        exec(`pkill -f "chromium.*${sessionId}"`, () => {
            logger.debug(`[${sessionId}] Procesos Chromium terminados forzosamente`);
        });

        // Esperar un momento para que los procesos terminen
        setTimeout(async () => {
            // Recrear cliente con nueva configuración
            const client = createIsolatedClient(sessionId, true);

            // Actualizar sesión
            sessions.set(sessionId, {
                client,
                status: 'restoring',
                lastActivity: Date.now(),
                phoneNumber: savedInfo.phoneNumber,
                infoData: savedInfo.infoData
            });
            saveSessionInfo();

            // Inicializar
            try {
                await client.initialize();
                logger.info(`[${sessionId}] Sesión recuperada exitosamente`);
            } catch (err) {
                logger.error(`[${sessionId}] Error recuperando sesión: ${err.message}`);

                // Programar segundo intento
                setTimeout(() => {
                    try {
                        client.initialize().catch(e => {
                            logger.error(`[${sessionId}] Segundo intento fallido: ${e.message}`);
                        });
                    } catch (e) {
                        logger.error(`[${sessionId}] Error en segundo intento: ${e.message}`);
                    }
                }, 10000);
            }
        }, 3000);
    } catch (err) {
        logger.error(`[${sessionId}] Error crítico en proceso de recuperación: ${err.message}`);
    }
};

const restorePreviousSessions = async () => {
    try {
        if (!fs.existsSync(SESSION_INFO_FILE)) {
            logger.info('No hay sesiones previas para restaurar');
            return;
        }

        const sessionInfo = JSON.parse(fs.readFileSync(SESSION_INFO_FILE, 'utf8'));
        logger.info(`Encontradas ${sessionInfo.length} sesiones para restaurar`);

        // Restaurar sesiones de forma escalonada para evitar sobrecarga
        for (const [index, info] of sessionInfo.entries()) {
            // Solo restaurar sesiones que estaban autenticadas o en reconexión
            if (info.status !== 'authenticated' && info.status !== 'reconnecting' && info.status !== 'awaiting_restart') {
                logger.info(`Omitiendo sesión ${info.sessionId} (estado: ${info.status})`);
                continue;
            }

            logger.info(`Restaurando sesión: ${info.sessionId}, teléfono: ${info.phoneNumber || 'No disponible'}`);

            // Crear directorios necesarios para la sesión (aunque no se usen realmente)
            const sessionAuthPath = path.join(__dirname, `.wwebjs_auth/session-${info.sessionId}`);
            fs.mkdirSync(sessionAuthPath, { recursive: true });

            // Crear cliente con la configuración apropiada
            const client = createIsolatedClient(info.sessionId, true);

            // Actualizar el registro de la sesión
            sessions.set(info.sessionId, {
                client,
                status: 'restoring',
                lastActivity: Date.now(),
                phoneNumber: info.phoneNumber,
                infoData: info.infoData
            });

            // Programar la inicialización con retraso escalonado
            setTimeout(() => {
                try {
                    logger.info(`[${info.sessionId}] Iniciando restauración...`);

                    // Inicializar cliente
                    client.initialize()
                        .then(() => {
                            logger.info(`[${info.sessionId}] Restauración exitosa`);

                            // Restaurar datos adicionales si están disponibles
                            if (info.infoData) {
                                try {
                                    // No podemos asignar directamente client.info, pero almacenamos
                                    // la información en la sesión para usarla más tarde
                                    sessions.set(info.sessionId, {
                                        ...sessions.get(info.sessionId),
                                        status: 'authenticated',
                                        phoneNumber: info.phoneNumber,
                                        infoData: info.infoData
                                    });
                                } catch (err) {
                                    logger.error(`[${info.sessionId}] Error restaurando info: ${err.message}`);
                                }
                            }
                        })
                        .catch(err => {
                            logger.error(`[${info.sessionId}] Error inicializando sesión restaurada: ${err.message}`);

                            // Configurar reintentos
                            let retryCount = 0;
                            const maxRetries = 2;

                            const retryRestore = () => {
                                if (retryCount >= maxRetries) {
                                    logger.error(`[${info.sessionId}] Máximo de reintentos alcanzado, marcando como fallida`);
                                    sessions.set(info.sessionId, {
                                        ...sessions.get(info.sessionId),
                                        status: 'failed'
                                    });
                                    saveSessionInfo();
                                    return;
                                }

                                retryCount++;
                                logger.info(`[${info.sessionId}] Reintento ${retryCount}/${maxRetries} de restauración...`);

                                setTimeout(() => {
                                    client.initialize().catch(e => {
                                        logger.error(`[${info.sessionId}] Error en reintento ${retryCount}: ${e.message}`);
                                        retryRestore();
                                    });
                                }, 5000 * retryCount);
                            };

                            retryRestore();
                        });
                } catch (error) {
                    logger.error(`[${info.sessionId}] Error crítico en restauración: ${error.message}`);
                    sessions.set(info.sessionId, {
                        ...sessions.get(info.sessionId),
                        status: 'failed'
                    });
                    saveSessionInfo();
                }
            }, 3000 + (index * 2000));
        }
    } catch (error) {
        logger.error(`Error crítico restaurando sesiones: ${error.message}`);
    }
};

// 6. Endpoints
app.post('/api/sessions', async (req, res) => {
    const sessionId = uuidv4();

    const client = createIsolatedClient(sessionId);
    sessions.set(sessionId, {
        client,
        status: 'initializing',
        lastActivity: Date.now()
    });
    saveSessionInfo();

    setTimeout(() => {
        client.initialize().catch(err => {
            logger.error(`[${sessionId}] Error inicializando: ${err.message}`);
            sessions.set(sessionId, {
                ...sessions.get(sessionId),
                status: 'failed',
                lastActivity: Date.now()
            });
            saveSessionInfo();
        });
    }, 1000);

    res.json({
        sessionId,
        qrUrl: `/api/sessions/${sessionId}/qr`,
        statusUrl: `/api/sessions/${sessionId}/status`
    });
});

app.post('/api/sessions/:id/send-message', upload.single('archivo'), async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    if (session.status !== 'authenticated') {
        return res.status(400).json({
            error: 'La sesión no está autenticada',
            status: session.status
        });
    }

    const { numero, mensaje } = req.body;
    const archivo = req.file;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }

    try {
        const client = session.client;
        const numberId = await client.getNumberId(numero);

        if (!numberId) {
            return res.status(400).json({ error: 'El número no está registrado en WhatsApp' });
        }

        const chatId = numberId._serialized;

        if (archivo) {
            logger.info(`[${sessionId}] Recibido archivo: ${archivo.originalname || archivo.filename}, tamaño: ${archivo.size}, tipo: ${archivo.mimetype}`);

            if (archivo.size > 15 * 1024 * 1024) {
                return res.status(400).json({ error: 'El archivo es demasiado grande. WhatsApp tiene un límite de 16MB' });
            }

            const fileMimeType = archivo.mimetype || mime.lookup(archivo.path) || 'application/octet-stream';
            const fileName = archivo.originalname || `file_${Date.now()}${path.extname(archivo.originalname) || '.dat'}`;
            const fileData = fs.readFileSync(archivo.path, { encoding: 'base64' });

            const media = new MessageMedia(fileMimeType, fileData, fileName);
            let options = { caption: mensaje || '' };

            if (fileMimeType.startsWith('video/') || fileMimeType.startsWith('audio/')) {
                options.sendMediaAsDocument = false;
            } else if (fileMimeType === 'application/pdf' || !fileMimeType.startsWith('image/')) {
                options.sendMediaAsDocument = true;
            }

            logger.info(`[${sessionId}] Enviando archivo como ${options.sendMediaAsDocument ? 'documento' : 'multimedia'}`);
            await client.sendMessage(chatId, media, options);

            // Limpiar archivo temporal
            try {
                fs.unlinkSync(archivo.path);
            } catch (err) {
                logger.warn(`[${sessionId}] Error al eliminar archivo temporal: ${err.message}`);
            }

            return res.json({
                success: true,
                message: `Archivo enviado con éxito como ${options.sendMediaAsDocument ? 'documento' : 'multimedia'}`,
                sessionId,
                destinatario: numero
            });
        } else if (mensaje) {
            logger.info(`[${sessionId}] Enviando mensaje de texto a ${numero}`);
            await client.sendMessage(chatId, mensaje);

            return res.json({
                success: true,
                message: 'Mensaje de texto enviado con éxito',
                sessionId,
                destinatario: numero
            });
        } else {
            return res.status(400).json({ error: 'Se requiere un mensaje o un archivo' });
        }
    } catch (err) {
        logger.error(`[${sessionId}] Error al enviar el mensaje a ${numero}: ${err.message}`);
        logger.error(err.stack);

        // Verificar si es un error relacionado con la sesión
        if (err.message.includes('not connected') || err.message.includes('disconnected') ||
            err.message.includes('Protocol error') ||
            err.message.includes('Session closed')
        ) {
            sessions.set(sessionId, {
                ...session,
                status: 'reconnecting',
                lastActivity: Date.now()
            });
            saveSessionInfo();

            // Programar recuperación con algo de retraso
            setTimeout(() => {
                recoverBrokenSession(sessionId);
            }, 2000);

            return res.status(503).json({
                error: `Error temporal en la sesión. Se ha iniciado recuperación automática. Intente nuevamente en 30 segundos.`,
                sessionId,
                status: 'recovering'
            });
        }
    }
});

// Endpoint para reiniciar una sesión específica
app.post('/api/sessions/:id/reiniciar', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    try {
        logger.info(`[${sessionId}] Reiniciando sesión por solicitud...`);

        // Desconectar cliente actual
        try {
            await session.client.destroy();
        } catch (err) {
            logger.warn(`[${sessionId}] Error destruyendo cliente: ${err.message}`);
        }

        // Mantener archivos de sesión pero crear nuevo cliente
        const client = createIsolatedClient(sessionId);

        sessions.set(sessionId, {
            client,
            status: 'initializing',
            lastActivity: Date.now()
        });
        saveSessionInfo();

        // Inicializar con retraso
        setTimeout(() => {
            client.initialize().catch(err => {
                logger.error(`[${sessionId}] Error reinicializando: ${err.message}`);
                sessions.set(sessionId, {
                    ...sessions.get(sessionId),
                    status: 'failed',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
            });
        }, 1000);

        res.json({
            success: true,
            message: `Sesión ${sessionId} está siendo reiniciada`,
            qrUrl: `/api/sessions/${sessionId}/qr`,
            statusUrl: `/api/sessions/${sessionId}/status`
        });
    } catch (err) {
        logger.error(`[${sessionId}] Error en reinicio: ${err.message}`);
        res.status(500).json({ error: 'Error al reiniciar sesión' });
    }
});

app.get('/api/sessions/:id/qr', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Sesión no encontrada');

    // Actualizar timestamp de última actividad
    sessions.set(req.params.id, {
        ...session,
        lastActivity: Date.now()
    });
    saveSessionInfo();

    if (session.status === 'authenticated') {
        // Usar phoneNumber de la información almacenada si está disponible
        const phoneNumber = session.phoneNumber || session.client.info?.wid?.user || null;
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
                        <h1>📱 WhatsApp Sesión</h1>
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

    // El resto del código permanece igual...
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
                body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                .qr-container { margin: 20px auto; width: 300px; }
                .status { padding: 10px; margin: 20px; border-radius: 5px; }
                .waiting { background: #fff3cd; color: #856404; }
                button { padding: 10px 15px; background-color: #4CAF50; color: white; border: none;
                    cursor: pointer; border-radius: 5px; font-size: 14px; margin-top: 20px; }
                button:hover { background-color: #45a049; }
            </style>
        </head>
        <body>
            <h1>WhatsApp QR</h1>
            <div class="qr-container">
                <img src="${session.qrData.qrImage}" alt="QR Code" style="width:100%;">
            </div>
            <div class="status waiting">
                ⏳ Escanea este código en WhatsApp > Dispositivos vinculados
            </div>
            <div>
                <p>Sesión ID: ${req.params.id}</p>
                <p>Estado: ${session.status}</p>
                <button onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())">
                    Reiniciar sesión
                </button>
            </div>
            <script>
                // Recargar página automáticamente cada 5 segundos si está esperando QR
                if ('${session.status}' === 'waiting_qr' || '${session.status}' === 'initializing') {
                    setTimeout(() => location.reload(), 5000);
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/api/sessions/:id/status', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    // Actualizar timestamp de última actividad
    sessions.set(req.params.id, {
        ...session,
        lastActivity: Date.now()
    });
    saveSessionInfo();

    // Usar phoneNumber de la información almacenada si está disponible
    const phoneNumber = session.phoneNumber || session.client.info?.wid?.user || null;

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
        await session.client.destroy();

        // Decidir si eliminar completamente o preservar los archivos
        const preserveFiles = req.query.preserve === 'true';

        if (!preserveFiles) {
            nuclearCleanup(req.params.id);
        } else {
            // Solo eliminar archivos temporales
            const tempDir = `/tmp/chrome-profile-${req.params.id}`;
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            logger.info(`[${req.params.id}] Archivos de sesión preservados`);
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

// Endpoint para recuperar todas las sesiones activas
app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
        sessionId: id,
        status: session.status,
        authenticated: session.status === 'authenticated',
        phoneNumber: session.client.info?.wid?.user || null,
        lastActivity: session.lastActivity
    }));

    res.json({
        count: sessionList.length,
        sessions: sessionList
    });
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
                            const sessionId = data.sessionId;
                            const shortId = sessionId.substring(0, 8) + '...';
                            
                            // Mostrar mensaje de éxito
                            alert('✅ Sesión creada: ' + shortId);
                            
                            // Abrir la vista de QR en nueva pestaña
                            window.open('/api/sessions/' + sessionId + '/qr', '_blank');
                            
                            // Recargar el dashboard
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

        if (sessionId && (!session.status === 'authenticated' || !session.phoneNumber)) {
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

// Página de sesiones (reutilizar la existente)
app.get('/sessions', (req, res) => {
    res.sendFile(path.join(__dirname, 'sessions-view.html'));
});

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

// 7. Inicialización mejorada
(async () => {
    // Crear directorios necesarios
    ['logs', 'uploads', 'public', '.wwebjs_auth'].forEach(dir => {
        fs.mkdirSync(path.join(__dirname, dir), { recursive: true });

    });

    logger.info('Iniciando servidor con preservación de sesiones...');

    // Solo matar procesos de Chromium huérfanos
    exec('pkill -f "chromium.*puppeteer"', () => {
        logger.info('Procesos Chromium huérfanos terminados');
    });

    // Limpiar solo archivos temporales generales
    exec('rm -rf /tmp/puppeteer_dev_*', () => {
        logger.info('Archivos temporales generales eliminados');
    });

    // Restaurar sesiones previas
    await restorePreviousSessions();

    // Iniciar servidor
    app.listen(port, () => {
        logger.info(`Servidor escuchando en http://localhost:${port}`);
        logger.info(`Modo de persistencia de sesiones: ACTIVADO`);
    });

    // Guardar información de sesiones periódicamente
    setInterval(() => {
        saveSessionInfo();
    }, 300000); // Cada 5 minutos

    // Comprobar estado de conexión y reconectar si es necesario
    setInterval(() => {
        Array.from(sessions.entries()).forEach(([id, session]) => {
            if (session.status === 'authenticated' && session.client) {
                try {
                    // Verificar si el cliente sigue conectado
                    session.client.getState().then(state => {
                        if (state !== 'CONNECTED') {
                            logger.warn(`[${id}] Estado detectado: ${state}, reconectando...`);
                            session.client.initialize().catch(err => {
                                logger.error(`[${id}] Error reconectando: ${err.message}`);
                            });
                        }
                    }).catch(err => {
                        logger.warn(`[${id}] Error verificando estado: ${err.message}`);
                    });
                } catch (err) {
                    logger.error(`[${id}] Error verificando sesión: ${err.message}`);
                }
            }
        });
    }, 900000); // Cada 15 minutos
})();

// 8. Manejo de errores y cierre limpio
process.on('unhandledRejection', (err) => {
    logger.error(`Error no manejado: ${err.stack}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Excepción no capturada: ${err.stack}`);
});

// Manejo de señales para cierre limpio
process.on('SIGTERM', async () => {
    logger.info('Apagando limpiamente (SIGTERM)...');

    // Marcar todas las sesiones como desconectadas pero mantener archivos
    await Promise.all(
        Array.from(sessions.keys()).map(async id => {
            try {
                // Actualizar estado a 'awaiting_restart' para que sepa que fue un cierre controlado
                sessions.set(id, {
                    ...sessions.get(id),
                    status: 'awaiting_restart',
                    lastActivity: Date.now()
                });

                // Intentar destruir cliente correctamente
                await sessions.get(id).client.destroy();
                logger.info(`[${id}] Sesión marcada para reinicio`);
            } catch (err) {
                logger.error(`[${id}] Error cerrando sesión: ${err.message}`);
            }
        })
    );

    // Guardar estados actualizados antes de salir
    saveSessionInfo();

    // Esperar un momento para permitir que se complete la escritura
    setTimeout(() => {
        logger.info('Proceso terminado correctamente');
        process.exit(0);
    }, 1000);
});

process.on('SIGINT', async () => {
    logger.info('Interrupción recibida (SIGINT/Ctrl+C), apagando limpiamente...');

    // Marcar todas las sesiones como desconectadas pero mantener archivos
    await Promise.all(
        Array.from(sessions.keys()).map(async id => {
            try {
                // Actualizar estado a 'awaiting_restart' para que sepa que fue un cierre controlado
                sessions.set(id, {
                    ...sessions.get(id),
                    status: 'awaiting_restart',
                    lastActivity: Date.now()
                });

                // Intentar destruir cliente correctamente
                await sessions.get(id).client.destroy();
                logger.info(`[${id}] Sesión marcada para reinicio`);
            } catch (err) {
                logger.error(`[${id}] Error cerrando sesión: ${err.message}`);
            }
        })
    );

    // Guardar estados actualizados antes de salir
    saveSessionInfo();

    // Esperar un momento para permitir que se complete la escritura
    setTimeout(() => {
        logger.info('Proceso terminado correctamente');
        process.exit(0);
    }, 1000);
}); 