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
const { EventEmitter } = require('events');

// Configurar límites de event listeners para evitar warnings
EventEmitter.defaultMaxListeners = 20;
process.setMaxListeners(20);

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

// 3. Almacenamiento optimizado de sesiones
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.messageQueues = new Map();
        this.sessionTimeouts = new Map();
        this.sessionIntervals = new Map();
        this.globalIntervals = new Set();
    }

    createSession(sessionId, sessionData) {
        if (this.sessions.has(sessionId)) {
            logger.debug(`[${sessionId}] Limpiando sesión existente antes de crear nueva`);
            this.cleanupSession(sessionId);
        }

        this.sessions.set(sessionId, sessionData);
        this.messageQueues.set(sessionId, []);
        this.sessionTimeouts.set(sessionId, new Map());
        this.sessionIntervals.set(sessionId, new Map());
        
        logger.debug(`[${sessionId}] Sesión creada en memoria`);
    }

    updateSession(sessionId, sessionData) {
        if (!this.sessions.has(sessionId)) {
            logger.warn(`[${sessionId}] Intento de actualizar sesión inexistente`);
            return false;
        }

        // CRÍTICO: NO hacer cleanup, solo actualizar datos
        this.sessions.set(sessionId, sessionData);
        logger.debug(`[${sessionId}] Sesión actualizada (SIN destruir cliente)`);
        return true;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    deleteSession(sessionId) {
        this.cleanupSession(sessionId);
        logger.debug(`[${sessionId}] Sesión eliminada completamente`);
    }

    cleanupSession(sessionId) {
        logger.debug(`[${sessionId}] Iniciando limpieza de recursos...`);

        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            safeDestroyClient(session.client, sessionId);
        }

        // Limpiar timeouts
        const sessionTimeouts = this.sessionTimeouts.get(sessionId);
        if (sessionTimeouts) {
            sessionTimeouts.forEach((timeout, name) => {
                clearTimeout(timeout);
                logger.debug(`[${sessionId}] Timeout '${name}' limpiado`);
            });
            this.sessionTimeouts.delete(sessionId);
        }

        // Limpiar intervalos
        const sessionIntervals = this.sessionIntervals.get(sessionId);
        if (sessionIntervals) {
            sessionIntervals.forEach((interval, name) => {
                clearInterval(interval);
                logger.debug(`[${sessionId}] Interval '${name}' limpiado`);
            });
            this.sessionIntervals.delete(sessionId);
        }

        this.messageQueues.delete(sessionId);
        this.sessions.delete(sessionId);

        if (global.gc) {
            global.gc();
        }
    }

    setSessionTimeout(sessionId, name, callback, delay) {
        const timeouts = this.sessionTimeouts.get(sessionId) || new Map();
        
        if (timeouts.has(name)) {
            clearTimeout(timeouts.get(name));
        }

        const timeout = setTimeout(() => {
            callback();
            timeouts.delete(name);
        }, delay);

        timeouts.set(name, timeout);
        this.sessionTimeouts.set(sessionId, timeouts);
        
        return timeout;
    }

    setSessionInterval(sessionId, name, callback, delay) {
        const intervals = this.sessionIntervals.get(sessionId) || new Map();
        
        if (intervals.has(name)) {
            clearInterval(intervals.get(name));
        }

        const interval = setInterval(callback, delay);
        intervals.set(name, interval);
        this.sessionIntervals.set(sessionId, intervals);
        
        return interval;
    }

    clearSessionTimeout(sessionId, name) {
        const timeouts = this.sessionTimeouts.get(sessionId);
        if (timeouts && timeouts.has(name)) {
            clearTimeout(timeouts.get(name));
            timeouts.delete(name);
        }
    }

    clearSessionInterval(sessionId, name) {
        const intervals = this.sessionIntervals.get(sessionId);
        if (intervals && intervals.has(name)) {
            clearInterval(intervals.get(name));
            intervals.delete(name);
        }
    }

    addGlobalInterval(interval) {
        this.globalIntervals.add(interval);
    }

    cleanupAllSessions() {
        logger.info('Limpiando todas las sesiones...');
        for (const sessionId of this.sessions.keys()) {
            this.cleanupSession(sessionId);
        }

        this.globalIntervals.forEach(interval => clearInterval(interval));
        this.globalIntervals.clear();
    }

    getSessionCount() {
        return this.sessions.size;
    }

    getAllSessions() {
        return Array.from(this.sessions.entries());
    }

    getMessageQueue(sessionId) {
        return this.messageQueues.get(sessionId) || [];
    }

    setMessageQueue(sessionId, queue) {
        this.messageQueues.set(sessionId, queue);
    }
}

// Instancia global del gestor de sesiones
const sessionManager = new SessionManager();

// Función auxiliar para verificar si un cliente está válido
const isClientValid = (client) => {
    try {
        if (!client) return false;
        if (!client.pupBrowser || !client.pupPage) return false;
        if (client.pupPage.isClosed && client.pupPage.isClosed()) return false;
        if (client.pupBrowser.isConnected && !client.pupBrowser.isConnected()) return false;
        return true;
    } catch (err) {
        return false;
    }
};

// Función auxiliar para destruir cliente de forma segura
const safeDestroyClient = async (client, sessionId) => {
    try {
        if (!client) return;
        
        if (typeof client.removeAllListeners === 'function') {
            client.removeAllListeners();
        }
        
        if (isClientValid(client)) {
            await client.destroy();
            logger.debug(`[${sessionId}] Cliente destruido exitosamente`);
        } else {
            logger.debug(`[${sessionId}] Cliente ya cerrado o inválido, omitiendo destrucción`);
        }
    } catch (err) {
        if (err.message.includes('Cannot read properties of null') ||
            err.message.includes('Target closed') ||
            err.message.includes('Session closed') ||
            err.message.includes('Connection closed') ||
            err.message.includes('Protocol error')) {
            logger.debug(`[${sessionId}] Cliente ya cerrado: ${err.message}`);
        } else {
            logger.warn(`[${sessionId}] Error inesperado destruyendo cliente: ${err.message}`);
        }
    }
};

// Función para guardar información de sesiones
const saveSessionInfo = () => {
    try {
        const sessionInfo = sessionManager.getAllSessions().map(([id, session]) => {
            let phoneNumber = null;
            let infoData = null;

            try {
                phoneNumber = session.client?.info?.wid?.user || session.phoneNumber || null;
                
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
                infoData: infoData || session.infoData,
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
        logger.debug(`Información de sesiones guardada (${sessionInfo.length} sesiones)`);
    } catch (error) {
        logger.error(`Error guardando información de sesiones: ${error.message}`);
    }
};

// SISTEMA DE LIMPIEZA AGRESIVA Y MONITOREO
const forceCleanupSession = async (sessionId) => {
    try {
        logger.warn(`[${sessionId}] 🧹 Iniciando limpieza forzada de procesos...`);
        
        const session = sessionManager.getSession(sessionId);
        if (session && session.client) {
            try {
                // Intentar destruir el cliente
                await session.client.destroy();
                logger.debug(`[${sessionId}] Cliente destruido`);
            } catch (err) {
                logger.warn(`[${sessionId}] Error destruyendo cliente: ${err.message}`);
            }
        }
        
        // Ejecutar limpieza nuclear
        await nuclearCleanup(sessionId);
        
        // Limpieza específica para Windows (en caso de estar en Windows)
        if (process.platform === 'win32') {
            exec(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${sessionId}*"`, (err) => {
                if (!err) logger.debug(`[${sessionId}] Procesos Chrome terminados (Windows)`);
            });
        }
        
        // Forzar garbage collection
        if (global.gc) {
            global.gc();
            logger.debug(`[${sessionId}] Garbage collection ejecutado`);
        }
        
        logger.info(`[${sessionId}] ✅ Limpieza forzada completada`);
        
    } catch (error) {
        logger.error(`[${sessionId}] ❌ Error en limpieza forzada: ${error.message}`);
    }
};

// Monitoreo y limpieza automática de procesos huérfanos
const cleanupOrphanProcesses = async () => {
    try {
        if (process.platform === 'win32') {
            // Contar procesos de Chrome
            exec('tasklist | findstr chrome.exe | find /c "chrome.exe"', (err, stdout) => {
                if (!err) {
                    const chromeCount = parseInt(stdout.trim()) || 0;
                    if (chromeCount > 20) { // Más de 20 procesos es sospechoso
                        logger.warn(`🚨 Detectados ${chromeCount} procesos de Chrome. Limpiando huérfanos...`);
                        
                        // Matar procesos Chrome sin ventana padre (huérfanos)
                        exec('for /f "tokens=2" %i in (\'tasklist /fi "imagename eq chrome.exe" /fo csv | findstr /v "WindowTitle"\') do taskkill /f /pid %i', (err) => {
                            if (!err) logger.info(`✅ Procesos huérfanos de Chrome limpiados`);
                        });
                    }
                }
            });
        } else {
            // Para Linux/Unix
            exec("ps aux | grep chromium | grep -v grep | wc -l", (err, stdout) => {
                if (!err) {
                    const chromeCount = parseInt(stdout.trim()) || 0;
                    if (chromeCount > 15) {
                        logger.warn(`🚨 Detectados ${chromeCount} procesos de Chromium. Limpiando huérfanos...`);
                        exec("pkill -f 'chromium.*--user-data-dir.*tmp'", (err) => {
                            if (!err) logger.info(`✅ Procesos huérfanos de Chromium limpiados`);
                        });
                    }
                }
            });
        }
    } catch (error) {
        logger.error(`❌ Error en limpieza de procesos huérfanos: ${error.message}`);
    }
};

// Monitoreo de memoria y recursos
const monitorResources = () => {
    const used = process.memoryUsage();
    const memoryMB = Math.round(used.heapUsed / 1024 / 1024);
    const totalMB = Math.round(used.heapTotal / 1024 / 1024);
    
    if (memoryMB > 512) { // Más de 512MB es preocupante
        logger.warn(`🚨 Alto uso de memoria: ${memoryMB}MB / ${totalMB}MB`);
        
        // Forzar garbage collection
        if (global.gc) {
            global.gc();
            const afterGC = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            logger.info(`🧹 GC ejecutado: ${memoryMB}MB → ${afterGC}MB`);
        }
    }
    
    // Contar sesiones activas
    const activeSessions = sessionManager.getAllSessions().length;
    if (activeSessions > 5) {
        logger.warn(`🚨 Muchas sesiones activas: ${activeSessions}. Considerar limpieza.`);
    }
};

// Limpieza nuclear optimizada
const nuclearCleanup = async (sessionId) => {
    try {
        logger.debug(`[${sessionId}] Iniciando limpieza nuclear`);

        sessionManager.cleanupSession(sessionId);

        // Primer delay para permitir que el cliente termine completamente
        await new Promise(resolve => setTimeout(resolve, 1000));

        const dirsToRemove = [
            path.join(__dirname, `.wwebjs_auth/session-${sessionId}`),
            path.join(__dirname, `whatsapp-session-${sessionId}`),
            `/tmp/chrome-profile-${sessionId}`
        ];

        for (const dir of dirsToRemove) {
            if (fs.existsSync(dir)) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                    logger.debug(`[${sessionId}] Directorio eliminado: ${dir}`);
                } catch (err) {
                    logger.error(`[${sessionId}] Error eliminando ${dir}: ${err.message}`);
                }
            }
        }

        // Matar procesos de Chrome de forma más agresiva
        exec(`pkill -9 -f "chromium.*${sessionId}"`, (err) => {
            if (!err) logger.debug(`[${sessionId}] Procesos Chromium terminados (force)`);
        });

        // Segundo delay para asegurar que todos los procesos terminaron
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (global.gc) {
            global.gc();
        }

    } catch (error) {
        logger.error(`[${sessionId}] Error en nuclearCleanup: ${error.message}`);
    }
};

// CREACIÓN DE CLIENTE OPTIMIZADA PARA QR RÁPIDO
const createOptimizedClient = (sessionId, isRestore = false) => {
    const tempDir = `/tmp/chrome-profile-${sessionId}`;
    
    // LIMPIEZA MÍNIMA Y RÁPIDA
    try {
        if (fs.existsSync(tempDir)) {
            // Solo eliminar archivos problemáticos específicos
            const problematicFiles = [
                path.join(tempDir, 'SingletonLock'),
                path.join(tempDir, 'SingletonSocket'),
                path.join(tempDir, 'SingletonCookie')
            ];
            
            problematicFiles.forEach(file => {
                try {
                    if (fs.existsSync(file)) fs.unlinkSync(file);
                } catch (err) {
                    // Ignorar errores de limpieza
                }
            });
        }
    } catch (err) {
        logger.warn(`[${sessionId}] Limpieza rápida: ${err.message}`);
    }
    
    // Crear directorios solo si no existen
    [
        path.join(__dirname, `.wwebjs_auth/session-${sessionId}`),
        tempDir
    ].forEach(dir => {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
            }
        } catch (err) {
            logger.warn(`[${sessionId}] Error creando directorio ${dir}: ${err.message}`);
        }
    });

    logger.debug(`[${sessionId}] Usando configuración optimizada para QR rápido`);

    // CONFIGURACIÓN SEGÚN DOCUMENTACIÓN OFICIAL - CORREGIDA PARA SERVIDOR
    const clientOptions = {
        authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: path.resolve(__dirname, `.wwebjs_auth`)
        }),
        puppeteer: {
            // Intentar diferentes ejecutables en orden de preferencia
            executablePath: (() => {
                const paths = [
                    '/usr/bin/chromium-browser',
                    '/usr/bin/chromium',
                    '/usr/bin/google-chrome',
                    '/usr/bin/google-chrome-stable',
                    '/snap/bin/chromium',
                    '/usr/bin/chromium-browser-stable'
                ];
                
                for (const path of paths) {
                    if (fs.existsSync(path)) {
                        logger.debug(`[${sessionId}] Usando ejecutable: ${path}`);
                        return path;
                    }
                }
                
                logger.warn(`[${sessionId}] No se encontró ejecutable de Chrome/Chromium, usando por defecto`);
                return undefined; // Dejar que Puppeteer use su Chrome bundled
            })(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--user-data-dir=' + tempDir,
                '--disable-extensions',
                '--no-default-browser-check',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-field-trial-config',
                '--disable-ipc-flooding-protection',
                '--enable-automation',
                '--disable-blink-features=AutomationControlled',
                '--remote-debugging-port=0', // Puerto dinámico
                '--disable-default-apps',
                '--disable-sync',
                // OPTIMIZACIONES DE MEMORIA Y RED
                '--memory-pressure-off',
                '--max_old_space_size=256', // Límite de 256MB por proceso
                '--disable-background-networking',
                '--disable-component-extensions-with-background-pages',
                '--disable-features=TranslateUI,MediaRouter',
                '--disable-domain-reliability',
                '--disable-client-side-phishing-detection',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync-preferences',
                '--aggressive-cache-discard',
                '--force-device-scale-factor=1'
            ],
            headless: true,
            timeout: 120000, // 2 minutos para conexión inicial
            defaultViewport: { width: 1280, height: 720 },
            ignoreHTTPSErrors: true,
            ignoreDefaultArgs: ['--disable-extensions'],
            slowMo: 0,
            devtools: false
        },
        
        authTimeoutMs: 0, // Sin timeout de auth (según docs)
        qrMaxRetries: 3,
        restartOnAuthFail: true, // Habilitar según docs
        takeoverOnConflict: true,
    };

    const client = new Client(clientOptions);
    const setupEventListeners = () => {
        client.on('error', (error) => {
            const errorMessage = error.message || error.toString();
            
            // Filtrar errores no críticos que NO deben terminar la sesión
            if (errorMessage.includes('EAI_AGAIN') || 
                errorMessage.includes('ENOTFOUND') ||
                errorMessage.includes('getaddrinfo') ||
                errorMessage.includes('FetchError') ||
                errorMessage.includes('raw.githubusercontent.com') ||
                errorMessage.includes('Protocol error') ||
                errorMessage.includes('Target closed') ||
                errorMessage.includes('addScriptToEvaluateOnNewDocument') ||
                errorMessage.includes('Session closed') ||
                errorMessage.includes('Cannot read properties') ||
                errorMessage.includes('Connection closed')) {
                
                logger.warn(`[${sessionId}] Error no crítico (ignorado): ${errorMessage.substring(0, 100)}...`);
                return; // NO terminar la sesión por estos errores
            }
            
            // Solo loggear errores realmente críticos
            logger.error(`[${sessionId}] Error crítico: ${errorMessage}`);
            
            // Solo marcar como error crítico si es realmente grave
            if (errorMessage.includes('NAVIGATION') || 
                errorMessage.includes('Authentication failed') ||
                errorMessage.includes('LOGOUT')) {
                const session = sessionManager.getSession(sessionId);
                if (session) {
                    sessionManager.updateSession(sessionId, {
                        ...session,
                        status: 'critical_error',
                        error: errorMessage,
                        lastActivity: Date.now()
                    });
                    saveSessionInfo();
                }
            }
        });

        client.on('loading_screen', (percent, message) => {
            logger.info(`[${sessionId}] 📱 Cargando WhatsApp Web: ${percent}% - ${message}`);
            
            const session = sessionManager.getSession(sessionId);
            if (session) {
                sessionManager.updateSession(sessionId, {
                    ...session,
                    status: 'loading',
                    loadingPercent: percent,
                    loadingMessage: message,
                    lastActivity: Date.now(),
                    isAuthenticating: true // MARCAR que está en proceso de autenticación
                });
                
                // Actualizar más frecuentemente durante la carga
                if (percent % 10 === 0) { // Solo guardar cada 10%
                    saveSessionInfo();
                }
            }
            
            // Limpiar timeouts mientras está cargando activamente
            sessionManager.clearSessionTimeout(sessionId, 'initialization');
            sessionManager.clearSessionTimeout(sessionId, 'qr_scan_timeout');
        });

        client.on('qr', async (qr) => {
            logger.info(`[${sessionId}] 📱 QR Code recibido`);
            
            const session = sessionManager.getSession(sessionId);
            if (!session) return;
            
            // PREVENIR QRs múltiples durante la carga de WhatsApp
            if (session.status === 'loading' || session.status === 'authenticated') {
                logger.warn(`[${sessionId}] 🚫 QR ignorado - Estado actual: ${session.status}`);
                return;
            }
            
            // Si ya tenemos un QR reciente, ignorar el nuevo
            if (session.qrData && session.qrGeneratedAt) {
                const timeSinceLastQR = Date.now() - session.qrGeneratedAt;
                if (timeSinceLastQR < 30000) { // Menos de 30 segundos
                    logger.warn(`[${sessionId}] 🚫 QR ignorado - QR reciente hace ${Math.floor(timeSinceLastQR/1000)}s`);
                    return;
                }
            }
            
            // BLOQUEAR QRs durante el proceso de autenticación
            if (session.isAuthenticating) {
                logger.warn(`[${sessionId}] 🚫 QR ignorado - Proceso de autenticación en curso`);
                return;
            }
            
            // CRÍTICO: Limpiar timeouts previos
            sessionManager.clearSessionTimeout(sessionId, 'initialization');
            sessionManager.clearSessionTimeout(sessionId, 'qrExpiry');
            sessionManager.clearSessionTimeout(sessionId, 'qr_scan_timeout');
            
            try {
                // Generar imagen QR según mejores prácticas
                const qrImage = await qrcode.toDataURL(qr, { 
                    width: 300,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    },
                    errorCorrectionLevel: 'H'
                });
                
                const refreshCount = (session.qrRefreshCount || 0) + 1;
                sessionManager.updateSession(sessionId, {
                    ...session,
                    qrData: { qr, qrImage },
                    status: 'waiting_qr',
                    qrGeneratedAt: Date.now(),
                    qrRefreshCount: refreshCount,
                    lastActivity: Date.now(),
                    error: null // Limpiar errores previos
                });
                saveSessionInfo();
                
                logger.info(`[${sessionId}] ✅ QR generado exitosamente - Intento #${refreshCount}`);
                
                // Timeout más largo para escaneo de QR (15 minutos)
                sessionManager.setSessionTimeout(sessionId, 'qr_scan_timeout', () => {
                    const currentSession = sessionManager.getSession(sessionId);
                    if (currentSession && currentSession.status === 'waiting_qr') {
                        logger.info(`[${sessionId}] ✅ QR disponible, extendiendo timeout de sesión`);
                        sessionManager.updateSession(sessionId, {
                            ...currentSession,
                            lastActivity: Date.now(),
                            qrExtended: true
                        });
                        saveSessionInfo();
                    }
                }, 900000); // 15 minutos
                
            } catch (err) {
                logger.error(`[${sessionId}] Error generando QR: ${err.message}`);
            }
        });

        client.on('authenticated', async () => {
            logger.info(`[${sessionId}] ✅ Autenticado correctamente`);
            
            sessionManager.clearSessionTimeout(sessionId, 'qrExpiry');
            sessionManager.clearSessionTimeout(sessionId, 'initialization');
            sessionManager.clearSessionTimeout(sessionId, 'qr_scan_timeout');

            const session = sessionManager.getSession(sessionId);
            if (session) {
                sessionManager.updateSession(sessionId, {
                    ...session,
                    status: 'authenticated',
                    qrData: null,
                    lastActivity: Date.now(),
                    isAuthenticating: false // LIMPIAR bandera de autenticación
                });
                saveSessionInfo();
            }
        });

        client.on('ready', () => {
            logger.info(`[${sessionId}] 🚀 Sesión lista y conectada`);
            
            const session = sessionManager.getSession(sessionId);
            if (session) {
                sessionManager.updateSession(sessionId, {
                    ...session,
                    status: 'authenticated',
                    ready: true,
                    qrData: null,
                    lastActivity: Date.now(),
                    isAuthenticating: false // ASEGURAR que no está autenticando
                });
                
                // Obtener información del cliente
                sessionManager.setSessionTimeout(sessionId, 'getInfo', async () => {
                    try {
                        if (session.client && session.client.info) {
                            const phoneNumber = session.client.info.wid?.user;
                            const infoData = {
                                wid: session.client.info.wid,
                                pushname: session.client.info.pushname,
                                platform: session.client.info.platform
                            };

                            sessionManager.updateSession(sessionId, {
                                ...sessionManager.getSession(sessionId),
                                phoneNumber,
                                infoData
                            });

                            logger.info(`[${sessionId}] 📱 Información actualizada - Teléfono: ${phoneNumber}`);
                            saveSessionInfo();
                        }
                    } catch (err) {
                        logger.error(`[${sessionId}] Error obteniendo información: ${err.message}`);
                    }
                }, 1000); // Reducido a 1 segundo
                
                saveSessionInfo();
            }
        });

        client.on('auth_failure', (msg) => {
            logger.error(`[${sessionId}] ❌ Error de autenticación: ${msg}`);
            
            sessionManager.clearSessionTimeout(sessionId, 'qrExpiry');
            sessionManager.clearSessionTimeout(sessionId, 'initialization');
            sessionManager.clearSessionTimeout(sessionId, 'qr_scan_timeout');

            const session = sessionManager.getSession(sessionId);
            if (session) {
                sessionManager.updateSession(sessionId, {
                    ...session,
                    status: 'auth_failed',
                    lastActivity: Date.now(),
                    isAuthenticating: false // LIMPIAR bandera en caso de error
                });
                saveSessionInfo();
            }
        });

        client.on('disconnected', (reason) => {
            logger.warn(`[${sessionId}] 🔌 Desconectado: ${reason}`);

            const currentSession = sessionManager.getSession(sessionId);
            if (!currentSession) return;

            if (reason === 'NAVIGATION' || reason.includes('CONFLICT') || reason === 'LOGOUT') {
                logger.warn(`[${sessionId}] Desconexión crítica: ${reason}`);
                sessionManager.updateSession(sessionId, {
                    ...currentSession,
                    status: 'disconnected',
                    lastActivity: Date.now()
                });
                saveSessionInfo();
                
                // LIMPIEZA AGRESIVA DE PROCESOS PARA DESCONEXIONES CRÍTICAS
                setTimeout(async () => {
                    try {
                        await forceCleanupSession(sessionId);
                    } catch (error) {
                        logger.error(`[${sessionId}] Error en limpieza post-desconexión: ${error.message}`);
                    }
                }, 3000);
            } else {
                logger.info(`[${sessionId}] Intentando reconexión automática...`);
                sessionManager.updateSession(sessionId, {
                    ...currentSession,
                    status: 'reconnecting',
                    lastActivity: Date.now()
                });

                sessionManager.setSessionTimeout(sessionId, 'reconnect', async () => {
                    const updatedSession = sessionManager.getSession(sessionId);
                    if (updatedSession && updatedSession.status === 'reconnecting') {
                        try {
                            await client.initialize();
                            sessionManager.updateSession(sessionId, {
                                ...sessionManager.getSession(sessionId),
                                status: 'reconnecting_ready',
                                lastActivity: Date.now()
                            });
                            saveSessionInfo();
                            
                        } catch (err) {
                            const errorMessage = err.message || err.toString();
                            
                            // Aplicar mismo filtro para errores de reconexión
                            if (errorMessage.includes('Protocol error') ||
                                errorMessage.includes('Target closed') ||
                                errorMessage.includes('Runtime.addBinding') ||
                                errorMessage.includes('addScriptToEvaluateOnNewDocument') ||
                                errorMessage.includes('Session closed') ||
                                errorMessage.includes('Connection closed')) {
                                
                                logger.warn(`[${sessionId}] Error de protocolo en reconexión (IGNORADO): ${errorMessage}`);
                                
                                // Mantener estado de reconexión, no marcar como fallida
                                sessionManager.updateSession(sessionId, {
                                    ...sessionManager.getSession(sessionId),
                                    status: 'reconnecting',
                                    lastActivity: Date.now(),
                                    reconnectProtocolError: errorMessage
                                });
                                saveSessionInfo();
                                return;
                            }
                            
                            // Solo marcar como fallida si es error crítico
                            logger.error(`[${sessionId}] Error CRÍTICO en reconexión: ${errorMessage}`);
                            sessionManager.updateSession(sessionId, {
                                ...sessionManager.getSession(sessionId),
                                status: 'reconnect_failed',
                                error: errorMessage,
                                lastActivity: Date.now()
                            });
                            saveSessionInfo();
                        }
                    }
                }, 5000); // Aumentado a 5 segundos para dar más tiempo
            }
        });
    };

    setupEventListeners();

    // Timeout EXTENDIDO para permitir conexión del navegador
    sessionManager.setSessionTimeout(sessionId, 'initialization', async () => {
        const session = sessionManager.getSession(sessionId);
        // Solo hacer timeout si NO se ha generado QR y no está autenticada
        if (session && 
            (session.status === 'initializing' || session.status === 'loading') && 
            !session.qrData && 
            session.status !== 'authenticated' &&
            session.status !== 'waiting_qr') {
            
            logger.error(`[${sessionId}] ⏰ Timeout de inicialización (5 minutos) - Problema de conexión del navegador`);
            sessionManager.updateSession(sessionId, {
                ...session,
                status: 'timeout',
                error: 'Browser connection timeout - verifique instalación de Chromium'
            });
            saveSessionInfo();
            
            await safeDestroyClient(client, sessionId);
        } else if (session && session.qrData) {
            logger.info(`[${sessionId}] ✅ QR disponible, extendiendo timeout de sesión`);
            // Si ya tiene QR, extender el timeout por otros 10 minutos
            sessionManager.setSessionTimeout(sessionId, 'qr_scan_timeout', async () => {
                const currentSession = sessionManager.getSession(sessionId);
                if (currentSession && currentSession.status === 'waiting_qr') {
                    logger.info(`[${sessionId}] ⏰ Timeout de escaneo de QR (10 minutos adicionales)`);
                    // No destruir la sesión, solo marcar como expirada para regenerar QR
                    sessionManager.updateSession(sessionId, {
                        ...currentSession,
                        status: 'qr_scan_timeout',
                        lastActivity: Date.now()
                    });
                    saveSessionInfo();
                }
            }, 600000); // 10 minutos adicionales para escanear QR
        }
    }, 300000); // 5 minutos para dar tiempo suficiente al navegador

    return client;
};

// ENDPOINTS OPTIMIZADOS

// Crear nueva sesión - CORRECCIÓN: initialize() retorna Promise
app.post('/api/sessions', async (req, res) => {
    const sessionId = req.body.sessionId || uuidv4();

    if (sessionManager.getSession(sessionId)) {
        return res.status(400).json({ error: 'La sesión ya existe' });
    }

    const client = createOptimizedClient(sessionId);
    sessionManager.createSession(sessionId, {
        client,
        status: 'initializing',
        lastActivity: Date.now()
    });
    saveSessionInfo();

    // RESPONDER INMEDIATAMENTE
    res.json({
        sessionId,
        qrUrl: `/api/sessions/${sessionId}/qr`,
        statusUrl: `/api/sessions/${sessionId}/status`,
        message: '⚡ Sesión creada - inicializando...'
    });

    // CORREGIDO: initialize() es una Promise, no acepta callback
    try {
        await client.initialize();
        logger.info(`[${sessionId}] Inicialización completada exitosamente`);
    } catch (err) {
        const errorMessage = err.message || err.toString();
        
        // CRÍTICO: No marcar como fallida si es error de protocolo no crítico
        if (errorMessage.includes('Protocol error') ||
            errorMessage.includes('Target closed') ||
            errorMessage.includes('Runtime.addBinding') ||
            errorMessage.includes('addScriptToEvaluateOnNewDocument') ||
            errorMessage.includes('Session closed') ||
            errorMessage.includes('Connection closed')) {
            
            logger.warn(`[${sessionId}] Error de protocolo no crítico durante inicialización (IGNORADO): ${errorMessage}`);
            
                         // Verificar si ya se generó QR exitosamente
             const session = sessionManager.getSession(sessionId);
             if (session && session.qrData) {
                 logger.info(`[${sessionId}] ✅ QR ya generado, manteniendo sesión activa a pesar del error de protocolo`);
                 sessionManager.updateSession(sessionId, {
                     ...session,
                     status: 'waiting_qr', // Mantener estado de QR activo
                     lastActivity: Date.now(),
                     protocolError: errorMessage, // Solo para logging
                     error: null // Limpiar error crítico
                 });
                 saveSessionInfo();
                 return; // NO destruir la sesión
            } else {
                logger.info(`[${sessionId}] Error de protocolo sin QR generado, reintentando en 3 segundos...`);
                // Reintentar inicialización después de un delay
                setTimeout(async () => {
                    const currentSession = sessionManager.getSession(sessionId);
                    if (!currentSession) return; // Sesión ya eliminada
                    
                    try {
                        await client.initialize();
                        logger.info(`[${sessionId}] Reintento de inicialización exitoso`);
                        
                        // Actualizar estado solo si la sesión sigue existiendo
                        if (sessionManager.getSession(sessionId)) {
                            sessionManager.updateSession(sessionId, {
                                ...sessionManager.getSession(sessionId),
                                status: 'initializing',
                                lastActivity: Date.now(),
                                retrySuccessful: true
                            });
                            saveSessionInfo();
                        }
                    } catch (retryErr) {
                        const retryErrorMessage = retryErr.message || retryErr.toString();
                        
                        // Aplicar mismo filtro en el reintento
                        if (retryErrorMessage.includes('Protocol error') ||
                            retryErrorMessage.includes('Target closed') ||
                            retryErrorMessage.includes('Runtime.addBinding')) {
                            logger.warn(`[${sessionId}] Reintento con error de protocolo (esperado): ${retryErrorMessage}`);
                        } else {
                            logger.warn(`[${sessionId}] Reintento fallido con error crítico: ${retryErrorMessage}`);
                            // Solo marcar como fallida si es error realmente crítico en el reintento
                            if (sessionManager.getSession(sessionId)) {
                                sessionManager.updateSession(sessionId, {
                                    ...sessionManager.getSession(sessionId),
                                    status: 'retry_failed',
                                    error: retryErrorMessage,
                                    lastActivity: Date.now()
                                });
                                saveSessionInfo();
                            }
                        }
                    }
                }, 3000);
                return;
            }
        }
        
        // Solo marcar como fallida si es un error realmente crítico
        logger.error(`[${sessionId}] Error CRÍTICO en inicialización: ${errorMessage}`);
        const session = sessionManager.getSession(sessionId);
        if (session) {
            sessionManager.updateSession(sessionId, {
                ...session,
                status: 'failed',
                error: errorMessage,
                lastActivity: Date.now()
            });
            saveSessionInfo();
        }
    }
});

// QR endpoint SUPER OPTIMIZADO
app.get('/api/sessions/:id/qr', async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).send('Sesión no encontrada');

    session.lastActivity = Date.now();

    if (session.status === 'authenticated') {
        const phoneNumber = session.phoneNumber || session.client.info?.wid?.user || null;
        return res.send(`
            <html><body style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>📱 Sesión ${req.params.id}</h1>
                <p style="color:green; font-size: 24px;">✅ Autenticada</p>
                <p>📞 Número: ${phoneNumber || 'No disponible'}</p>
                <p>Estado: ${session.status}</p>
                <p>
                <button onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())" 
                    style="padding: 10px 20px; background: #ff9800; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 5px;">
                    🔃 Reiniciar Sesión
                </button>
                </p>
            </body></html>
        `);
    }

    if (!session.qrData) {
        let statusMessage = '⚡ Generando QR a máxima velocidad...';
        let statusColor = '#007bff';
        
        if (session.status === 'failed') {
            statusMessage = '❌ Error de inicialización. Puedes reiniciar la sesión.';
            statusColor = '#dc3545';
        } else if (session.status === 'timeout') {
            statusMessage = '⏰ Timeout de inicialización. Reinicia la sesión.';
            statusColor = '#ffc107';
        }
        
        return res.send(`
            <html><body style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>📱 Sesión ${req.params.id}</h1>
                <p style="color: ${statusColor}; font-size: 18px;">${statusMessage}</p>
                <div style="margin: 20px auto; width: 60px; height: 60px; border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                <p>Estado: ${session.status}</p>
                <button onclick="fetch('/api/sessions/${req.params.id}/regenerate-qr', {method: 'POST'}).then(() => window.location.reload())" 
                    style="padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 5px;">
                    🔥 Regenerar QR
                </button>
                <button onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())" 
                    style="padding: 10px 20px; background: #ff9800; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 5px;">
                    🔃 Reiniciar Sesión
                </button>
                <style>
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
                <script>setTimeout(()=>location.reload(),2000)</script>
            </body></html>
        `);
    }

                // QR disponible - mostrar inmediatamente con refresh frecuente
    const qrGeneratedAt = session.qrGeneratedAt || Date.now();
    const qrRefreshCount = session.qrRefreshCount || 1;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp QR - ${req.params.id}</title>
            <meta http-equiv="refresh" content="8"> <!-- Auto refresh cada 8 segundos -->
            <style>
                body { font-family: Arial, sans-serif; text-align: center; margin-top: 30px; background: #f5f5f5; }
                .container { max-width: 450px; margin: 0 auto; background: white; padding: 25px; border-radius: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                .qr-container { 
                    margin: 20px auto; 
                    width: 320px; 
                    border: 3px solid #25D366; 
                    border-radius: 15px; 
                    padding: 15px; 
                    background: white; 
                    box-shadow: 0 2px 10px rgba(37,211,102,0.2);
                }
                .qr-container img { width: 100%; border-radius: 8px; }
                .status { 
                    padding: 15px; 
                    margin: 20px 0; 
                    border-radius: 10px; 
                    background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); 
                    color: #155724; 
                    border: 2px solid #25D366;
                    font-weight: bold;
                }
                .fresh-indicator {
                    background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
                    color: white;
                    padding: 8px 15px;
                    border-radius: 20px;
                    font-size: 12px;
                    margin: 10px 0;
                    display: inline-block;
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); }
                }
                .timer { font-size: 16px; font-weight: bold; color: #007bff; margin: 15px 0; }
                .expired { color: #dc3545; }
                button { 
                    padding: 12px 20px; 
                    background: #25D366; 
                    color: white; 
                    border: none; 
                    border-radius: 8px; 
                    cursor: pointer; 
                    font-size: 14px; 
                    margin: 8px; 
                    transition: all 0.3s ease;
                }
                button:hover { background: #128C7E; transform: translateY(-2px); }
                .refresh-btn { background: #007bff; }
                .refresh-btn:hover { background: #0056b3; }
                .restart-btn { background: #ff9800; }
                .restart-btn:hover { background: #f57c00; }
                .instructions {
                    background: #f8f9fa;
                    border: 1px solid #dee2e6;
                    border-radius: 8px;
                    padding: 15px;
                    margin: 15px 0;
                    font-size: 14px;
                    color: #495057;
                }
                .highlight { color: #25D366; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 WhatsApp QR Code</h1>
                
                <div class="fresh-indicator">
                    📱 QR Válido - Intento #${qrRefreshCount}
                </div>
                
                <div class="qr-container">
                    <img src="${session.qrData.qrImage}" alt="QR Code WhatsApp">
                </div>
                
                <div class="instructions">
                    <strong>📋 Instrucciones:</strong><br>
                    1. Abre <span class="highlight">WhatsApp</span> en tu teléfono<br>
                    2. Ve a <span class="highlight">Menú ⋮ > Dispositivos vinculados</span><br>
                    3. Toca <span class="highlight">"Vincular un dispositivo"</span><br>
                    4. <span class="highlight">Escanea este QR</span> inmediatamente
                </div>
                
                <div class="status">
                    ✅ QR ACTIVO - Escanea ahora (se renueva automáticamente)
                </div>
                
                <div class="timer" id="qr-info">
                    📱 WhatsApp renovará este QR automáticamente cada ~20 segundos
                </div>
                
                <div>
                    <p><strong>Sesión:</strong> ${req.params.id}</p>
                    <p><strong>Estado:</strong> ${session.status}</p>
                    <p><strong>QR generado:</strong> ${new Date(qrGeneratedAt).toLocaleTimeString()}</p>
                    
                    <button class="refresh-btn" onclick="location.reload()">
                        🔄 Actualizar QR
                    </button>
                    <button onclick="fetch('/api/sessions/${req.params.id}/regenerate-qr', {method: 'POST'}).then(() => window.location.reload())">
                        🔥 Regenerar QR
                    </button>
                    <button class="restart-btn" onclick="fetch('/api/sessions/${req.params.id}/reiniciar', {method: 'POST'}).then(() => window.location.reload())">
                        🔃 Reiniciar Sesión
                    </button>
                </div>
            </div>
            <script>
                // Auto-refresh cada 8 segundos para detectar cambios de QR o autenticación
                setTimeout(function() {
                    fetch('/api/sessions/${req.params.id}/status')
                        .then(function(r) { return r.json(); })
                        .then(function(data) {
                            if (data.authenticated) {
                                location.reload();
                            } else {
                                // Recargar para obtener QR actualizado automáticamente
                                setTimeout(function() { location.reload(); }, 3000);
                            }
                        })
                        .catch(function() { 
                            setTimeout(function() { location.reload(); }, 8000); 
                        });
                }, 8000);
                
                // Mostrar información sobre renovación automática
                var qrInfoElement = document.getElementById('qr-info');
                var qrGeneratedAtMs = ${qrGeneratedAt};
                
                if (qrGeneratedAtMs && qrInfoElement) {
                    var updateInfo = function() {
                        var elapsed = Math.floor((Date.now() - qrGeneratedAtMs) / 1000);
                        qrInfoElement.innerHTML = '🔄 QR generado hace ' + elapsed + ' segundos - Se renueva automáticamente';
                        
                        // Si han pasado más de 25 segundos, avisar que puede renovarse pronto
                        if (elapsed > 25) {
                            qrInfoElement.innerHTML += ' (puede renovarse pronto)';
                            qrInfoElement.style.color = '#ffc107';
                        }
                    };
                    
                    updateInfo();
                    setInterval(updateInfo, 1000);
                }
                
                // Mostrar instrucciones claras
                console.log('✅ QR ACTIVO - WhatsApp lo renueva automáticamente');
                console.log('📱 Abre WhatsApp > Menú > Dispositivos vinculados');
                console.log('📷 Escanea el QR - Si falla, espera unos segundos para QR nuevo');
            </script>
        </body>
        </html>
    `);

               
});

// Estado de sesión OPTIMIZADO
app.get('/api/sessions/:id/status', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    session.lastActivity = Date.now();

    const phoneNumber = session.phoneNumber || session.client?.info?.wid?.user || null;

    res.json({
        sessionId: req.params.id,
        status: session.status,
        authenticated: session.status === 'authenticated',
        qrAvailable: !!session.qrData,
        qrValid: session.qrValid || false,
        whatsappLoaded: session.whatsappLoaded || false,
        loadingPercent: session.loadingPercent || null,
        loadingMessage: session.loadingMessage || null,
        phoneNumber: phoneNumber,
        lastActivity: session.lastActivity,
        queueLength: sessionManager.getMessageQueue(req.params.id)?.length || 0,
        error: session.error || null,
        retryAttempt: session.retryAttempt || null,
        qrGeneratedAt: session.qrGeneratedAt || null,
        qrTimeRemaining: null, // No calculamos tiempo restante ya que WhatsApp maneja la renovación
        optimized: true // Indicador de versión optimizada
    });
});

// Enviar mensaje OPTIMIZADO
app.post('/api/sessions/:id/send-message', upload.single('archivo'), async (req, res) => {
    const sessionId = req.params.id;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    if (session.status !== 'authenticated') {
        return res.status(400).json({
            error: 'La sesión no está autenticada',
            status: session.status
        });
    }

    const { numero, mensaje, typing_time } = req.body;
    const archivo = req.file;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }

    try {
        const client = session.client;

        // Verificar el número con timeout
        const numberId = await Promise.race([
            client.getNumberId(numero),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout verificando número')), 10000))
        ]);

        if (!numberId) {
            if (archivo) {
                try { fs.unlinkSync(archivo.path); } catch (e) {}
            }
            return res.status(400).json({ error: 'El número no está registrado en WhatsApp' });
        }

        const chatId = numberId._serialized;
        session.lastActivity = Date.now();

        const chat = await client.getChatById(chatId);

        // Simular que está escribiendo (opcional)
        if (!archivo && mensaje && typing_time !== 0) {
            const typingDuration = typing_time || Math.min(Math.max(mensaje.length * 50, 1000), 5000);
            logger.info(`[${sessionId}] Mostrando 'escribiendo...' por ${typingDuration}ms`);
            
            await chat.sendStateTyping();
            await new Promise(resolve => setTimeout(resolve, typingDuration));
            await chat.clearState();
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (archivo) {
            logger.info(`[${sessionId}] Preparando archivo: ${archivo.originalname}`);

            if (archivo.size > 15 * 1024 * 1024) {
                fs.unlinkSync(archivo.path);
                return res.status(400).json({ error: 'El archivo es demasiado grande. Límite: 15MB' });
            }

            if (!fs.existsSync(archivo.path)) {
                logger.error(`[${sessionId}] El archivo no existe: ${archivo.path}`);
                return res.status(400).json({ error: 'El archivo no se pudo procesar' });
            }

            const fileMimeType = archivo.mimetype || mime.lookup(archivo.path) || 'application/octet-stream';
            const fileName = archivo.originalname || `file_${Date.now()}${path.extname(archivo.originalname) || '.dat'}`;

            let fileData;
            try {
                fileData = fs.readFileSync(archivo.path, { encoding: 'base64' });
            } catch (readError) {
                logger.error(`[${sessionId}] Error leyendo archivo: ${readError.message}`);
                try { fs.unlinkSync(archivo.path); } catch (e) {}
                return res.status(500).json({ error: 'Error procesando el archivo' });
            }

            if (!fileData || fileData.length === 0) {
                logger.error(`[${sessionId}] El archivo está vacío`);
                try { fs.unlinkSync(archivo.path); } catch (e) {}
                return res.status(400).json({ error: 'El archivo está vacío' });
            }

            let media;
            try {
                media = new MessageMedia(fileMimeType, fileData, fileName);
            } catch (mediaError) {
                logger.error(`[${sessionId}] Error creando MessageMedia: ${mediaError.message}`);
                try { fs.unlinkSync(archivo.path); } catch (e) {}
                return res.status(500).json({ error: 'Error preparando el archivo' });
            }

            let options = {
                caption: mensaje || '',
                sendMediaAsSticker: false
            };

            const forceDocument = req.body.force_document === 'true' || req.body.force_document === true;

            if (forceDocument || fileMimeType.startsWith('video/')) {
                options.sendMediaAsDocument = true;
            } else if (fileMimeType.startsWith('image/') && archivo.size < 1024 * 1024) {
                options.sendMediaAsDocument = false;
            } else if (fileMimeType.startsWith('audio/') && archivo.size < 10 * 1024 * 1024) {
                options.sendMediaAsDocument = false;
                options.sendAudioAsVoice = fileMimeType.includes('ogg') || fileMimeType.includes('opus');
            } else {
                options.sendMediaAsDocument = true;
            }

            let result;
            let messageId = null;
            let messageSent = false;

            try {
                logger.info(`[${sessionId}] Enviando archivo...`);
                
                result = await Promise.race([
                    client.sendMessage(chatId, media, options),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout enviando archivo')), 60000))
                ]);

                messageSent = true;
                logger.info(`[${sessionId}] Archivo enviado exitosamente`);

                try {
                    if (result && result.id) {
                        messageId = result.id._serialized || result.id.id || result.id;
                    }
                } catch (e) {
                    logger.warn(`[${sessionId}] No se pudo obtener ID del mensaje`);
                }

            } catch (sendError) {
                const errorMsg = sendError.message || '';
                logger.error(`[${sessionId}] Error enviando: ${errorMsg}`);

                if (errorMsg.includes('serialize') || 
                    errorMsg.includes('getMessageModel') ||
                    errorMsg.includes('Cannot read properties') ||
                    errorMsg === 'Evaluation failed: a') {
                    logger.warn(`[${sessionId}] Error post-envío, mensaje probablemente enviado`);
                    messageSent = true;
                } else {
                    throw sendError;
                }
            }

            try {
                fs.unlinkSync(archivo.path);
            } catch (err) {
                logger.warn(`[${sessionId}] Error eliminando archivo: ${err.message}`);
            }

            if (messageSent) {
                return res.json({
                    success: true,
                    message: `Archivo enviado como ${options.sendMediaAsDocument ? 'documento' : 'multimedia'}`,
                    sessionId,
                    destinatario: numero,
                    messageId: messageId,
                    fileInfo: {
                        name: fileName,
                        type: fileMimeType,
                        size: archivo.size,
                        sentAs: options.sendMediaAsDocument ? 'document' : 'media'
                    }
                });
            }

        } else if (mensaje) {
            logger.info(`[${sessionId}] Enviando mensaje de texto`);

            let result;
            let messageId = null;
            let messageSent = false;

            try {
                result = await Promise.race([
                    client.sendMessage(chatId, mensaje),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 20000))
                ]);

                messageSent = true;
                
                try {
                    if (result && result.id) {
                        messageId = result.id._serialized || result.id.id || result.id;
                    }
                } catch (e) {
                    logger.warn(`[${sessionId}] No se pudo obtener ID`);
                }

            } catch (sendError) {
                const errorMsg = sendError.message || '';
                
                if (errorMsg.includes('serialize') || errorMsg === 'Evaluation failed: a') {
                    logger.warn(`[${sessionId}] Error post-envío en texto`);
                    messageSent = true;
                } else {
                    throw sendError;
                }
            }

            if (messageSent) {
                logger.info(`[${sessionId}] Mensaje enviado exitosamente`);
                return res.json({
                    success: true,
                    message: 'Mensaje de texto enviado con éxito',
                    sessionId,
                    destinatario: numero,
                    messageId: messageId
                });
            }

        } else {
            return res.status(400).json({ error: 'Se requiere un mensaje o un archivo' });
        }

    } catch (err) {
        logger.error(`[${sessionId}] Error: ${err.message}`);
        
        if (archivo) {
            try { fs.unlinkSync(archivo.path); } catch (e) {}
        }

        const errorMessage = err.message || '';

        if (errorMessage.includes('Timeout')) {
            return res.status(504).json({
                error: 'Timeout al enviar. Verifique si el mensaje se envió antes de reintentar.',
                sessionId,
                timeout: true
            });
        }

        if (errorMessage.includes('not connected') || errorMessage.includes('disconnected')) {
            return res.status(503).json({
                error: 'Sesión desconectada',
                sessionId,
                status: 'disconnected'
            });
        }

        return res.status(500).json({
            error: errorMessage || 'Error al enviar mensaje',
            sessionId
        });
    }
});

// Regenerar QR sin destruir sesión
app.post('/api/sessions/:id/regenerate-qr', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    if (!session.client) {
        return res.status(400).json({ error: 'No hay cliente activo para regenerar QR' });
    }

    try {
        logger.info(`[${sessionId}] 🔄 Forzando regeneración de QR SIN destruir cliente...`);

        // Solo limpiar QR anterior y actualizar timestamp
        sessionManager.updateSession(sessionId, {
            ...session,
            qrData: null,
            status: 'regenerating_qr',
            lastActivity: Date.now()
        });
        saveSessionInfo();

        // El cliente automáticamente emitirá un nuevo QR
        // No necesitamos hacer nada más, el evento 'qr' se triggera automáticamente

        res.json({
            success: true,
            message: `🔥 Regenerando QR para sesión ${sessionId} - Cliente mantenido`,
            qrUrl: `/api/sessions/${sessionId}/qr`,
            statusUrl: `/api/sessions/${sessionId}/status`
        });

        logger.info(`[${sessionId}] QR regeneration request processed - waiting for new QR event`);

    } catch (err) {
        logger.error(`[${sessionId}] Error regenerando QR: ${err.message}`);
        res.status(500).json({ error: 'Error al regenerar QR' });
    }
});

// Reiniciar sesión CORREGIDO
app.post('/api/sessions/:id/reiniciar', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    try {
        logger.info(`[${sessionId}] 🔄 Reiniciando sesión...`);

        await nuclearCleanup(sessionId);

        const client = createOptimizedClient(sessionId);
        sessionManager.createSession(sessionId, {
            client,
            status: 'initializing',
            lastActivity: Date.now()
        });
        saveSessionInfo();

        // Responder inmediatamente
        res.json({
            success: true,
            message: `⚡ Sesión ${sessionId} reiniciándose`,
            qrUrl: `/api/sessions/${sessionId}/qr`,
            statusUrl: `/api/sessions/${sessionId}/status`
        });

        // CORREGIDO: initialize() es Promise
        try {
            await client.initialize();
            logger.info(`[${sessionId}] Reinicialización completada`);
        } catch (err) {
            const errorMessage = err.message || err.toString();
            
            // Aplicar mismo filtro de errores de protocolo
            if (errorMessage.includes('Protocol error') ||
                errorMessage.includes('Target closed') ||
                errorMessage.includes('Runtime.callFunctionOn') ||
                errorMessage.includes('Runtime.addBinding') ||
                errorMessage.includes('addScriptToEvaluateOnNewDocument') ||
                errorMessage.includes('Session closed') ||
                errorMessage.includes('Connection closed')) {
                
                logger.warn(`[${sessionId}] Error de protocolo en reinicialización (IGNORADO): ${errorMessage}`);
                
                // Verificar si ya se generó QR exitosamente
                const currentSession = sessionManager.getSession(sessionId);
                if (currentSession && currentSession.qrData) {
                    logger.info(`[${sessionId}] ✅ QR ya generado en reinicio, manteniendo sesión activa`);
                    sessionManager.updateSession(sessionId, {
                        ...currentSession,
                        status: 'waiting_qr',
                        lastActivity: Date.now(),
                        reinitProtocolError: errorMessage,
                        error: null
                    });
                    saveSessionInfo();
                    return;
                }
            }
            
            // Solo marcar como fallida si es error crítico
            logger.error(`[${sessionId}] Error CRÍTICO reinicializando: ${errorMessage}`);
            const currentSession = sessionManager.getSession(sessionId);
            if (currentSession) {
                sessionManager.updateSession(sessionId, {
                    ...currentSession,
                    status: 'failed',
                    error: errorMessage
                });
                saveSessionInfo();
            }
        }

    } catch (err) {
        logger.error(`[${sessionId}] Error en reinicio: ${err.message}`);
        res.status(500).json({ error: 'Error al reiniciar sesión' });
    }
});

// Eliminar sesión
app.delete('/api/sessions/:id', async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    try {
        const preserveFiles = req.query.preserve === 'true';

        if (!preserveFiles) {
            await nuclearCleanup(req.params.id);
        } else {
            if (session.client) {
                await safeDestroyClient(session.client, req.params.id);
            }
        }

        sessionManager.deleteSession(req.params.id);
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

// Listar todas las sesiones
app.get('/api/sessions', (req, res) => {
    const sessionList = sessionManager.getAllSessions().map(([id, session]) => ({
        sessionId: id,
        status: session.status,
        authenticated: session.status === 'authenticated',
        phoneNumber: session.phoneNumber || session.client?.info?.wid?.user || null,
        lastActivity: session.lastActivity,
        queueLength: sessionManager.getMessageQueue(id)?.length || 0,
        qrAvailable: !!session.qrData,
        qrAge: session.qrGeneratedAt ? Math.floor((Date.now() - session.qrGeneratedAt) / 1000) : null
    }));

    res.json({
        count: sessionList.length,
        sessions: sessionList,
        optimized: true
    });
});

// DASHBOARD PRINCIPAL - Interfaz para crear sesiones
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp API Dashboard</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    min-height: 100vh; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    padding: 20px; 
                }
                .container { 
                    background: white; 
                    border-radius: 20px; 
                    padding: 40px; 
                    box-shadow: 0 20px 60px rgba(0,0,0,0.2); 
                    text-align: center; 
                    max-width: 500px; 
                    width: 100%; 
                }
                h1 { 
                    color: #333; 
                    margin-bottom: 10px; 
                    font-size: 2.5rem; 
                }
                .subtitle { 
                    color: #666; 
                    margin-bottom: 30px; 
                    font-size: 1.1rem; 
                }
                .create-btn { 
                    background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); 
                    color: white; 
                    border: none; 
                    padding: 15px 30px; 
                    font-size: 1.2rem; 
                    border-radius: 50px; 
                    cursor: pointer; 
                    transition: all 0.3s ease; 
                    margin: 10px; 
                    min-width: 250px;
                    font-weight: bold;
                }
                .create-btn:hover { 
                    transform: translateY(-2px); 
                    box-shadow: 0 10px 25px rgba(37, 211, 102, 0.3); 
                }
                .view-btn { 
                    background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); 
                    color: white; 
                    border: none; 
                    padding: 12px 25px; 
                    font-size: 1rem; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    transition: all 0.3s ease; 
                    margin: 10px; 
                    text-decoration: none;
                    display: inline-block;
                }
                .view-btn:hover { 
                    transform: translateY(-2px); 
                    box-shadow: 0 8px 20px rgba(0, 123, 255, 0.3); 
                }
                .status { 
                    margin: 20px 0; 
                    padding: 15px; 
                    border-radius: 10px; 
                    background: #f8f9fa; 
                    border-left: 4px solid #25D366; 
                }
                .loading { 
                    display: none; 
                    margin: 20px 0; 
                }
                .spinner { 
                    border: 3px solid #f3f3f3; 
                    border-top: 3px solid #25D366; 
                    border-radius: 50%; 
                    width: 30px; 
                    height: 30px; 
                    animation: spin 1s linear infinite; 
                    display: inline-block; 
                    margin-right: 10px; 
                }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                                 .footer { 
                     margin-top: 30px; 
                     font-size: 0.9rem; 
                     color: #888; 
                 }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 WhatsApp API</h1>
                <p class="subtitle">Panel de Control - Probusiness</p>
                
                <button class="create-btn" onclick="createSession()">
                    🚀 Crear Nueva Sesión
                </button>
                
                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    Creando sesión...
                </div>
                
                <div class="status" id="status" style="display: none;"></div>
                
                                 <div style="margin-top: 30px;">
                     <a href="/sessions" class="view-btn">📋 Ver Todas las Sesiones</a>
                     <a href="/health" class="view-btn">💚 Estado del Servidor</a>
                 </div>
                 
                 <div class="footer">
                     <p>⚡ Sistema optimizado para QR súper rápido</p>
                 </div>
            </div>

            <script>
                async function createSession() {
                    const createBtn = document.querySelector('.create-btn');
                    const loading = document.getElementById('loading');
                    const status = document.getElementById('status');
                    
                    createBtn.disabled = true;
                    loading.style.display = 'block';
                    status.style.display = 'none';
                    
                    try {
                        const response = await fetch('/api/sessions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({})
                        });
                        
                        const data = await response.json();
                        
                        if (response.ok) {
                            status.innerHTML = \`
                                <strong>✅ Sesión creada exitosamente!</strong><br>
                                <p>ID: \${data.sessionId}</p>
                                <p style="margin-top: 10px;">
                                    <a href="\${data.qrUrl}" target="_blank" style="background: #25D366; color: white; padding: 8px 15px; text-decoration: none; border-radius: 5px;">
                                        📱 Ver QR Code
                                    </a>
                                </p>
                            \`;
                            status.style.display = 'block';
                            status.style.borderLeftColor = '#25D366';
                            
                            // Abrir QR en nueva pestaña automáticamente
                            setTimeout(() => {
                                window.open(data.qrUrl, '_blank');
                            }, 1000);
                        } else {
                            throw new Error(data.error || 'Error al crear sesión');
                        }
                    } catch (error) {
                        status.innerHTML = \`<strong>❌ Error:</strong> \${error.message}\`;
                        status.style.display = 'block';
                        status.style.borderLeftColor = '#dc3545';
                    } finally {
                        createBtn.disabled = false;
                        loading.style.display = 'none';
                    }
                }
                
                // Auto-refresh cada 30 segundos para mantener la página actualizada
                setInterval(() => {
                    fetch('/health').catch(() => {});
                }, 30000);
            </script>
        </body>
        </html>
    `);
});

// VISTA MEJORADA DE LISTA DE SESIONES
app.get('/sessions', (req, res) => {
    res.sendFile(path.join(__dirname, 'sessions-view.html'));
});

// OBTENER ASIGNACIONES ACTUALES
app.get('/api/current-assignments', (req, res) => {
    try {
        const envPath = path.join(__dirname, '../redis-laravel/.env');
        
        if (!fs.existsSync(envPath)) {
            return res.json({ sells: null, coordination: null });
        }

        const envContent = fs.readFileSync(envPath, 'utf8');
        
        // Extraer session IDs de las URLs
        const sellsMatch = envContent.match(/SELLS_API_URL="[^"]*\/sessions\/([^\/]+)\/send-message"/);
        const coordinationMatch = envContent.match(/COORDINATION_API_URL="[^"]*\/sessions\/([^\/]+)\/send-message"/);
        
        const assignments = {
            sells: sellsMatch ? sellsMatch[1] : null,
            coordination: coordinationMatch ? coordinationMatch[1] : null
        };

        res.json(assignments);
    } catch (error) {
        logger.error('Error obteniendo asignaciones actuales:', error.message);
        res.status(500).json({ error: 'Error leyendo asignaciones' });
    }
});

// ASIGNAR NÚMEROS A VENTAS O COORDINACIÓN
app.post('/api/assign-number', async (req, res) => {
    const { sessionId, type } = req.body;

    if (typeof sessionId === 'undefined' || !type) {
        return res.status(400).json({ error: 'SessionId y type son requeridos' });
    }

    if (!['sells', 'coordination'].includes(type)) {
        return res.status(400).json({ error: 'Type debe ser "sells" o "coordination"' });
    }

    // Verificar que la sesión existe y está autenticada (solo si sessionId no está vacío)
    if (sessionId && sessionId.trim() !== '') {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        if (session.status !== 'authenticated') {
            return res.status(400).json({ error: 'La sesión debe estar autenticada' });
        }
    }

    try {
        const variableName = type === 'sells' ? 'SELLS_API_URL' : 'COORDINATION_API_URL';
        const envPath = path.join(__dirname, '../redis-laravel/.env');
        
        // Leer el archivo .env actual
        let envContent = '';
        try {
            envContent = fs.readFileSync(envPath, 'utf8');
        } catch (err) {
            return res.status(500).json({ 
                error: 'No se pudo leer el archivo .env. Verifica que existe ../redis-laravel/.env' 
            });
        }

        if (!sessionId || sessionId.trim() === '') {
            // DESASIGNAR - Eliminar la línea
            logger.info(`🔄 Desasignando ${type.toUpperCase()}`);
            
            const regex = new RegExp(`^${variableName}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${variableName}=""`);
            } else {
                envContent += `\n${variableName}=""`;
            }
            
            fs.writeFileSync(envPath, envContent, 'utf8');
            
            logger.info(`✅ ${variableName} desasignado exitosamente`);
            
            res.json({
                success: true,
                message: `${type.toUpperCase()} desasignado exitosamente`,
                type,
                action: 'unassigned',
                variableUpdated: variableName
            });
        } else {
            // ASIGNAR
            logger.info(`[${sessionId}] 🎯 Asignando a ${type.toUpperCase()}`);
            
            const newUrl = `"https://whatsapp2.probusiness.pe/api/sessions/${sessionId}/send-message"`;
            const regex = new RegExp(`^${variableName}=.*$`, 'm');
            const newLine = `${variableName}=${newUrl}`;

            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, newLine);
            } else {
                envContent += `\n${newLine}`;
            }

            fs.writeFileSync(envPath, envContent, 'utf8');

            const session = sessionManager.getSession(sessionId);
            const phoneNumber = session ? (session.phoneNumber || session.client?.info?.wid?.user || 'Desconocido') : 'Desconocido';
            
            logger.info(`[${sessionId}] ✅ ${variableName} actualizado a: ${newUrl}`);
            logger.info(`[${sessionId}] 📱 Número ${phoneNumber} asignado a ${type.toUpperCase()}`);

            res.json({
                success: true,
                message: `Número ${phoneNumber} asignado a ${type.toUpperCase()} exitosamente`,
                sessionId,
                type,
                phoneNumber,
                action: 'assigned',
                variableUpdated: variableName,
                newUrl: newUrl.replace(/"/g, '')
            });
        }

    } catch (error) {
        logger.error(`Error en asignación: ${error.message}`);
        res.status(500).json({ 
            error: 'Error actualizando configuración: ' + error.message 
        });
    }
});

// Health check MEJORADO
app.get('/health', (req, res) => {
    const memory = process.memoryUsage();
    
    res.json({
        status: 'running - OPTIMIZADO PARA QR RÁPIDO ⚡',
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
            rss: `${Math.round(memory.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`
        },
        sessions: {
            total: sessionManager.getSessionCount(),
            authenticated: sessionManager.getAllSessions().filter(s => s[1].status === 'authenticated').length,
            waiting_qr: sessionManager.getAllSessions().filter(s => s[1].status === 'waiting_qr').length,
            loading: sessionManager.getAllSessions().filter(s => s[1].status === 'loading').length,
            ready_for_qr: sessionManager.getAllSessions().filter(s => s[1].status === 'ready_for_qr').length,
            initializing: sessionManager.getAllSessions().filter(s => s[1].status === 'initializing').length,
            failed: sessionManager.getAllSessions().filter(s => s[1].status === 'failed').length
        },
        optimizations: {
            puppeteerTimeout: '2 minutos para conexión inicial',
            browserDetection: 'Auto-detección de Chromium/Chrome instalado',
            initializationTimeout: '3 minutos (extendido para conexión del navegador)',
            qrAutoRenewal: 'Automático por WhatsApp (~20s)',
            refreshRate: '3s durante inicialización, 5s con QR',
            balancedArgs: 'Argumentos optimizados para servidores',
            smartCleanup: 'Limpieza mínima pero efectiva',
            browserPaths: 'Múltiples rutas de ejecutables probadas'
        }
    });
});

// Restauración de sesiones OPTIMIZADA
const restorePreviousSessions = async () => {
    try {
        if (!fs.existsSync(SESSION_INFO_FILE)) {
            logger.info('No hay sesiones previas para restaurar');
            return;
        }

        const sessionInfo = JSON.parse(fs.readFileSync(SESSION_INFO_FILE, 'utf8'));
        logger.info(`🔄 Encontradas ${sessionInfo.length} sesiones para evaluar`);

        const sessionsToRestore = [];
        const sessionsToDelete = [];

        for (const info of sessionInfo) {
            const now = Date.now();
            const sessionAge = info.timestamp ? (now - info.timestamp) : (now - (info.lastActivity || 0));
            const isOldSession = sessionAge > 24 * 60 * 60 * 1000; // 24 horas

            const shouldDelete = (
                (!info.authenticated && !info.phoneNumber) ||
                (isOldSession && ['failed', 'timeout', 'auth_failed', 'qr_expired'].includes(info.status))
            );

            if (shouldDelete) {
                sessionsToDelete.push(info);
                logger.info(`🗑️ Programada para eliminación: ${info.sessionId}`);
            } else if (['authenticated', 'reconnecting', 'awaiting_restart'].includes(info.status)) {
                sessionsToRestore.push(info);
                logger.info(`✅ Programada para restauración: ${info.sessionId}`);
            }
        }

        // Eliminar sesiones marcadas
        if (sessionsToDelete.length > 0) {
            logger.info(`🧹 Limpiando ${sessionsToDelete.length} sesiones automáticamente...`);
            
            for (const info of sessionsToDelete) {
                try {
                    await nuclearCleanup(info.sessionId);
                    logger.info(`🗑️ Eliminada: ${info.sessionId}`);
                } catch (err) {
                    logger.warn(`Error eliminando sesión ${info.sessionId}: ${err.message}`);
                }
            }
        }

        // Restaurar sesiones válidas CON CONFIGURACIÓN OPTIMIZADA
        if (sessionsToRestore.length > 0) {
            logger.info(`⚡ Restaurando ${sessionsToRestore.length} sesiones con configuración OPTIMIZADA...`);
            
            for (const [index, info] of sessionsToRestore.entries()) {
                logger.info(`Restaurando sesión OPTIMIZADA: ${info.sessionId}`);

                const client = createOptimizedClient(info.sessionId, true); // Usar versión optimizada

                sessionManager.createSession(info.sessionId, {
                    client,
                    status: 'restoring',
                    lastActivity: Date.now(),
                    phoneNumber: info.phoneNumber,
                    infoData: info.infoData
                });

                // Inicializar con delay REDUCIDO
                sessionManager.setSessionTimeout(info.sessionId, 'restoreInit', async () => {
                    try {
                        await client.initialize();
                        logger.info(`[${info.sessionId}] ✅ Restauración exitosa`);
                    } catch (err) {
                        logger.error(`[${info.sessionId}] Error en restauración: ${err.message}`);
                        sessionManager.createSession(info.sessionId, {
                            ...sessionManager.getSession(info.sessionId),
                            status: 'failed',
                            error: err.message
                        });
                        saveSessionInfo();
                    }
                }, 1000 + (index * 1000)); // Delay reducido y escalonado
            }
        }

        logger.info(`✨ Proceso de restauración OPTIMIZADA completado`);

    } catch (error) {
        logger.error(`Error restaurando sesiones: ${error.message}`);
    }
};

// INICIALIZACIÓN OPTIMIZADA
(async () => {
    // Crear directorios necesarios
    ['logs', 'uploads', 'public', '.wwebjs_auth'].forEach(dir => {
        fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
    });

    logger.info('🚀 Iniciando servidor OPTIMIZADO para QR RÁPIDO...');

    // Limpiar procesos huérfanos
    exec('pkill -f "chromium.*puppeteer"', () => {
        logger.info('Procesos Chromium huérfanos terminados');
    });

    // Restaurar sesiones previas
    await restorePreviousSessions();

    // Iniciar servidor
    app.listen(port, () => {
        logger.info(`⚡ Servidor OPTIMIZADO escuchando en http://localhost:${port}`);
        logger.info(`🏎️ Modo de QR RÁPIDO: ACTIVADO`);
        logger.info(`⏱️ Timeouts optimizados: Inicialización 30s, QR 3min`);
        logger.info(`🖼️ QR optimizado: 256px, margen 1px`);
    });

    // Guardar información cada 3 minutos (reducido de 5)
    const saveInterval = setInterval(() => {
        saveSessionInfo();
    }, 180000);
    sessionManager.addGlobalInterval(saveInterval);
    
    // MONITOREO DE RECURSOS CADA 2 MINUTOS
    const resourceMonitorInterval = setInterval(() => {
        monitorResources();
    }, 120000);
    sessionManager.addGlobalInterval(resourceMonitorInterval);
    
    // LIMPIEZA DE PROCESOS HUÉRFANOS CADA 5 MINUTOS
    const orphanCleanupInterval = setInterval(() => {
        cleanupOrphanProcesses();
    }, 300000);
    sessionManager.addGlobalInterval(orphanCleanupInterval);
    
    // Ejecutar limpieza inicial de procesos huérfanos al inicio
    setTimeout(() => {
        logger.info('🧹 Ejecutando limpieza inicial de procesos huérfanos...');
        cleanupOrphanProcesses();
    }, 30000);

    // Limpieza INTELIGENTE cada 30 minutos
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        let cleanedSessions = 0;

        sessionManager.getAllSessions().forEach(([sessionId, session]) => {
            const sessionAge = now - (session.lastActivity || 0);
            
            // CRITERIOS MÁS ESTRICTOS PARA LIMPIEZA
            const shouldClean = (
                // Solo limpiar sesiones realmente abandonadas (2 horas)
                sessionAge > 2 * 60 * 60 * 1000 && 
                // Y que NO tengan QR activo
                !session.qrData &&
                // Y que NO estén autenticadas
                session.status !== 'authenticated' &&
                session.status !== 'waiting_qr' &&
                session.status !== 'loading' &&
                session.status !== 'initializing' &&
                // Y que NO tengan teléfono asociado
                !session.phoneNumber
            );
            
            if (shouldClean) {
                logger.info(`🗑️ [${sessionId}] Limpieza inteligente - sesión abandonada (${Math.floor(sessionAge / 60000)} min)`);
                sessionManager.cleanupSession(sessionId);
                cleanedSessions++;
            } else if (session.qrData && sessionAge > 30 * 60 * 1000) {
                // Solo loggear sesiones con QR antigua pero NO eliminar
                logger.info(`📱 [${sessionId}] QR activo de ${Math.floor(sessionAge / 60000)} minutos - MANTENIENDO sesión`);
            }
        });

        if (cleanedSessions > 0) {
            logger.info(`🧹 Limpieza inteligente: ${cleanedSessions} sesiones realmente abandonadas eliminadas`);
            saveSessionInfo();
        }

        if (global.gc) {
            global.gc();
        }
    }, 1800000); // Cada 30 minutos (menos frecuente)
    sessionManager.addGlobalInterval(cleanupInterval);

})();

// MANEJO DE ERRORES OPTIMIZADO - MÁS PERMISIVO
process.on('unhandledRejection', (err, promise) => {
    const errorMessage = err.message || err.toString();
    
    // Filtrar errores no críticos más agresivamente - LISTA AMPLIADA
    if (errorMessage.includes('Protocol error') ||
        errorMessage.includes('Target closed') ||
        errorMessage.includes('EAI_AGAIN') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('Evaluation failed') ||
        errorMessage.includes('Cannot read properties') ||
        errorMessage.includes('addScriptToEvaluateOnNewDocument') ||
        errorMessage.includes('Session closed') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('Page.evaluate') ||
        errorMessage.includes('Runtime.evaluate') ||
        errorMessage.includes('WebSocket connection') ||
        errorMessage.includes('net::ERR_') ||
        errorMessage.includes('fetch')) {
        
        // Solo loggear cada 10 errores similares para evitar spam
        if (!process.errorCount) process.errorCount = {};
        const errorKey = errorMessage.substring(0, 50);
        process.errorCount[errorKey] = (process.errorCount[errorKey] || 0) + 1;
        
        if (process.errorCount[errorKey] % 10 === 1) {
            logger.warn(`Promesa rechazada (no crítica) #${process.errorCount[errorKey]}: ${errorMessage.substring(0, 100)}...`);
        }
        return;
    }
    
    logger.error(`Promesa rechazada: ${errorMessage}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Excepción no capturada: ${err.message}`);
    
    if (err.message.includes('ENOSPC') || err.message.includes('EMFILE')) {
        logger.error('Error crítico del sistema, reiniciando...');
        saveSessionInfo();
        process.exit(1);
    }
});

// Cierre limpio OPTIMIZADO
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} recibido, iniciando cierre RÁPIDO...`);

    try {
        // Marcar sesiones para restauración RÁPIDAMENTE
        sessionManager.getAllSessions().forEach(([id, session]) => {
            sessionManager.updateSession(id, {
                ...session,
                status: 'awaiting_restart',
                lastActivity: Date.now()
            });
        });

        saveSessionInfo();
        sessionManager.cleanupAllSessions();

        logger.info('✅ Cierre optimizado completado');
    } catch (err) {
        logger.error(`Error durante cierre: ${err.message}`);
    }

    setTimeout(() => {
        process.exit(0);
    }, 1000); // Reducido a 1 segundo
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

logger.info('⚡ Sistema WhatsApp API OPTIMIZADO iniciado - QR SÚPER RÁPIDO ACTIVADO ⚡');

module.exports = app;