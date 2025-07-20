const { readdir } = require("fs/promises");
const fs = require('fs');
const path = require('path');
const { WhatsappWebSession } = require('./WhatsappWebSession');

const getDirectories = async source => {
    try {
        return (await readdir(source, { withFileTypes: true }))
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    } catch (error) {
        return [];
    }
};

class WhatsappSessionManager {
    constructor(logger) {
        this.sessionIdVsClientInstance = {};
        this.logger = logger || console;
        this.sessionMetadata = new Map(); // Metadatos adicionales por sesión
        this.messageQueues = new Map(); // Colas de mensajes por sesión
        this.sessionTimeouts = new Map(); // Timeouts por sesión
        this.maxConcurrentSessions = process.env.MAX_SESSIONS || (process.platform === 'linux' ? 15 : 50); // Límite optimizado
        this.isLinux = process.platform === 'linux';
        this.sessionPool = new Map(); // Pool de sesiones precalentadas para Linux
        this.lastCleanup = Date.now();
        this.cleanupInterval = this.isLinux ? 300000 : 600000; // Limpieza más frecuente en Linux
        
        return this;
    }

    /**
     * Crear una nueva sesión de WhatsApp
     */
    createWAClient = (sessionId, qrGenerationCallback, readyInstanceCallback) => {
        // Verificar límite de sesiones
        if (Object.keys(this.sessionIdVsClientInstance).length >= this.maxConcurrentSessions) {
            throw new Error(`Máximo ${this.maxConcurrentSessions} sesiones simultáneas permitidas`);
        }

        // Verificar si la sesión ya existe
        if (this.sessionIdVsClientInstance[sessionId]) {
            this.logger.warn(`[${sessionId}] Sesión ya existe, retornando existente`);
            return this.sessionIdVsClientInstance[sessionId];
        }

        this.logger.info(`[${sessionId}] 🆕 Creando nueva sesión WhatsApp...`);

        // Callbacks personalizados que incluyen registro en el manager
        const customQrCallback = (sessionId, qrData, qrString) => {
            this.logger.info(`[${sessionId}] 📱 QR generado en manager`);
            this.updateSessionMetadata(sessionId, { 
                qrGeneratedAt: Date.now(),
                qrData: qrData
            });
            
            if (qrGenerationCallback) {
                qrGenerationCallback(sessionId, qrData, qrString);
            }
        };

        const customReadyCallback = (sessionId, sessionInstance) => {
            this.logger.info(`[${sessionId}] ✅ Sesión lista en manager`);
            this.updateSessionMetadata(sessionId, { 
                readyAt: Date.now(),
                status: 'ready',
                phoneNumber: sessionInstance.phoneNumber
            });
            
            if (readyInstanceCallback) {
                readyInstanceCallback(sessionId, sessionInstance);
            }
        };

        // Crear la sesión
        const session = new WhatsappWebSession(
            sessionId, 
            customQrCallback, 
            customReadyCallback, 
            this.logger
        );

        // Registrar en el manager
        this.sessionIdVsClientInstance[sessionId] = session;
        this.sessionMetadata.set(sessionId, {
            createdAt: Date.now(),
            status: 'initializing',
            lastActivity: Date.now()
        });

        // Inicializar la sesión de forma asíncrona
        this.initializeSessionAsync(sessionId, session);

        return session;
    };

    /**
     * Inicializar sesión de forma asíncrona
     */
    async initializeSessionAsync(sessionId, session) {
        try {
            this.logger.info(`[${sessionId}] 🚀 Inicializando sesión asíncronamente...`);
            await session.initialize();
            this.updateSessionMetadata(sessionId, { status: 'initialized' });
        } catch (error) {
            this.logger.error(`[${sessionId}] ❌ Error en inicialización asíncrona: ${error.message}`);
            this.updateSessionMetadata(sessionId, { 
                status: 'failed',
                lastError: error.message 
            });
        }
    }

    /**
     * Restaurar sesiones previas del disco
     */
    async restorePreviousSessions() {
        this.logger.info('🔄 Restaurando sesiones previas...');
        
        const authDir = path.resolve(__dirname, '.wwebjs_auth');
        if (!fs.existsSync(authDir)) {
            this.logger.info('📁 No se encontró directorio de autenticación, omitiendo restauración');
            return;
        }

        try {
            const directoryNames = await getDirectories(authDir);
            let sessionIds = directoryNames
                .filter(name => name.startsWith('session-'))
                .map(name => name.split("-")[1])
                .filter(id => id && id.length > 0);

            this.logger.info(`📦 Encontradas ${sessionIds.length} sesiones guardadas`);

            // En Linux, limitar la restauración para evitar problemas de recursos
            if (this.isLinux && sessionIds.length > this.maxConcurrentSessions) {
                this.logger.warn(`⚠️ Linux detectado: Limitando restauración a ${this.maxConcurrentSessions} sesiones más recientes`);
                
                // Ordenar por fecha de modificación más reciente
                const sessionPaths = sessionIds.map(id => ({
                    id,
                    path: path.join(authDir, `session-${id}`),
                    mtime: 0
                }));

                for (const session of sessionPaths) {
                    try {
                        const stats = fs.statSync(session.path);
                        session.mtime = stats.mtime.getTime();
                    } catch (error) {
                        this.logger.warn(`No se pudo obtener stats para ${session.id}`);
                    }
                }

                // Tomar solo las más recientes
                sessionIds = sessionPaths
                    .sort((a, b) => b.mtime - a.mtime)
                    .slice(0, this.maxConcurrentSessions)
                    .map(s => s.id);
                
                this.logger.info(`📦 Restaurando ${sessionIds.length} sesiones más recientes`);
            }

            // Configurar batch para restauración en lotes
            const batchSize = this.isLinux ? 3 : 5; // Menores lotes en Linux
            const delay = this.isLinux ? 5000 : 2000; // Mayor delay en Linux
            
            for (let i = 0; i < sessionIds.length; i += batchSize) {
                const batch = sessionIds.slice(i, i + batchSize);
                this.logger.info(`🔄 Procesando lote ${Math.floor(i/batchSize) + 1}/${Math.ceil(sessionIds.length/batchSize)}`);
                
                // Procesar lote en paralelo
                const batchPromises = batch.map(async (sessionId) => {
                    try {
                        // Verificar si ya existe
                        if (this.sessionIdVsClientInstance[sessionId]) {
                            this.logger.warn(`[${sessionId}] Sesión ya existe, omitiendo...`);
                            return;
                        }

                        this.logger.info(`[${sessionId}] 🔄 Restaurando sesión...`);
                        
                        const session = this.createWAClient(
                            sessionId,
                            (id, qrData) => {
                                this.logger.info(`[${id}] 📱 QR restaurado disponible`);
                            },
                            (id, instance) => {
                                this.logger.info(`[${id}] ✅ Sesión restaurada y lista`);
                            }
                        );

                        this.updateSessionMetadata(sessionId, { 
                            restored: true,
                            restoredAt: Date.now(),
                            platform: process.platform
                        });

                    } catch (error) {
                        this.logger.error(`[${sessionId}] ❌ Error restaurando sesión: ${error.message}`);
                        if (error.message.includes('Máximo') && this.isLinux) {
                            this.logger.warn(`[${sessionId}] Límite alcanzado en Linux, deteniendo restauración`);
                            throw new Error('LIMIT_REACHED');
                        }
                    }
                });

                try {
                    await Promise.allSettled(batchPromises);
                } catch (error) {
                    if (error.message === 'LIMIT_REACHED') {
                        this.logger.warn('⚠️ Límite de sesiones alcanzado, deteniendo restauración');
                        break;
                    }
                }

                // Esperar entre lotes
                if (i + batchSize < sessionIds.length) {
                    this.logger.info(`⏳ Esperando ${delay}ms antes del siguiente lote...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            const activeCount = Object.keys(this.sessionIdVsClientInstance).length;
            this.logger.info(`✅ Restauración completada. ${activeCount} sesiones activas de ${sessionIds.length} intentadas`);

            // Limpiar memoria después de la restauración en Linux
            if (this.isLinux && global.gc) {
                this.logger.info('🧹 Ejecutando garbage collection en Linux...');
                global.gc();
            }

            // Iniciar optimizaciones automáticas para Linux
            if (this.isLinux) {
                this.startLinuxOptimizations();
            }

        } catch (error) {
            this.logger.error(`❌ Error en restauración de sesiones: ${error.message}`);
        }
    }

    /**
     * Obtener instancia de cliente por sessionId
     */
    getClientFromSessionId = sessionId => {
        return this.sessionIdVsClientInstance[sessionId];
    };

    /**
     * Obtener todas las sesiones
     */
    getAllSessions() {
        return Object.keys(this.sessionIdVsClientInstance).map(sessionId => {
            const session = this.sessionIdVsClientInstance[sessionId];
            const metadata = this.sessionMetadata.get(sessionId) || {};
            
            return {
                sessionId,
                status: session.status,
                qrAvailable: !!session.qrData,
                isReady: session.isReady,
                phoneNumber: session.phoneNumber,
                lastActivity: session.lastActivity,
                loadingPercent: session.loadingPercent,
                metadata: metadata
            };
        });
    }

    /**
     * Eliminar sesión
     */
    async removeSession(sessionId) {
        const session = this.sessionIdVsClientInstance[sessionId];
        if (!session) {
            this.logger.warn(`[${sessionId}] Sesión no encontrada para eliminar`);
            return false;
        }

        try {
            this.logger.info(`[${sessionId}] 🗑️ Eliminando sesión...`);
            
            // Limpiar timeouts
            this.clearSessionTimeouts(sessionId);
            
            // Forzar limpieza de la sesión
            await session.forceCleanup();
            
            // Remover del manager
            delete this.sessionIdVsClientInstance[sessionId];
            this.sessionMetadata.delete(sessionId);
            this.messageQueues.delete(sessionId);
            this.sessionTimeouts.delete(sessionId);
            
            this.logger.info(`[${sessionId}] ✅ Sesión eliminada exitosamente`);
            return true;

        } catch (error) {
            this.logger.error(`[${sessionId}] ❌ Error eliminando sesión: ${error.message}`);
            return false;
        }
    }

    /**
     * Reiniciar sesión
     */
    async restartSession(sessionId) {
        const session = this.sessionIdVsClientInstance[sessionId];
        if (!session) {
            throw new Error('Sesión no encontrada');
        }

        try {
            this.logger.info(`[${sessionId}] 🔄 Reiniciando sesión desde manager...`);
            
            this.updateSessionMetadata(sessionId, { 
                status: 'restarting',
                lastRestart: Date.now()
            });

            await session.restart();
            
            this.updateSessionMetadata(sessionId, { 
                status: 'restarted',
                restartedAt: Date.now()
            });

            return session;

        } catch (error) {
            this.logger.error(`[${sessionId}] ❌ Error reiniciando sesión: ${error.message}`);
            this.updateSessionMetadata(sessionId, { 
                status: 'restart_failed',
                lastError: error.message
            });
            throw error;
        }
    }

    /**
     * Enviar mensaje a través de una sesión específica
     */
    async sendMessage(sessionId, phoneNumber, message) {
        const session = this.sessionIdVsClientInstance[sessionId];
        if (!session) {
            throw new Error('Sesión no encontrada');
        }

        if (!session.isReady) {
            throw new Error('Sesión no está lista');
        }

        try {
            const result = await session.sendMessage(phoneNumber, message);
            this.updateSessionMetadata(sessionId, { 
                lastMessageSent: Date.now(),
                messageCount: (this.sessionMetadata.get(sessionId)?.messageCount || 0) + 1
            });
            return result;
        } catch (error) {
            this.logger.error(`[${sessionId}] Error enviando mensaje: ${error.message}`);
            throw error;
        }
    }

    /**
     * Actualizar metadatos de sesión
     */
    updateSessionMetadata(sessionId, updates) {
        const current = this.sessionMetadata.get(sessionId) || {};
        this.sessionMetadata.set(sessionId, {
            ...current,
            ...updates,
            lastUpdated: Date.now()
        });
    }

    /**
     * Obtener estadísticas del manager
     */
    getStats() {
        const sessions = this.getAllSessions();
        const stats = {
            totalSessions: sessions.length,
            readySessions: sessions.filter(s => s.isReady).length,
            authenticatedSessions: sessions.filter(s => s.status === 'authenticated').length,
            failedSessions: sessions.filter(s => s.status === 'failed').length,
            loadingSessions: sessions.filter(s => s.status === 'loading').length,
            waitingQRSessions: sessions.filter(s => s.status === 'waiting_qr').length,
            sessionsWithQR: sessions.filter(s => s.qrAvailable).length,
            maxConcurrent: this.maxConcurrentSessions
        };

        return stats;
    }

    /**
     * Limpiar timeouts de una sesión
     */
    clearSessionTimeouts(sessionId) {
        const timeouts = this.sessionTimeouts.get(sessionId) || {};
        Object.values(timeouts).forEach(timeout => {
            if (timeout) clearTimeout(timeout);
        });
        this.sessionTimeouts.delete(sessionId);
    }

    /**
     * Establecer timeout para una sesión
     */
    setSessionTimeout(sessionId, timeoutName, callback, delay) {
        if (!this.sessionTimeouts.has(sessionId)) {
            this.sessionTimeouts.set(sessionId, {});
        }
        
        const sessionTimeouts = this.sessionTimeouts.get(sessionId);
        
        // Limpiar timeout existente si existe
        if (sessionTimeouts[timeoutName]) {
            clearTimeout(sessionTimeouts[timeoutName]);
        }
        
        // Establecer nuevo timeout
        sessionTimeouts[timeoutName] = setTimeout(callback, delay);
    }

    /**
     * Limpieza completa del manager
     */
    async cleanup() {
        this.logger.info('🧹 Ejecutando limpieza completa del manager...');
        
        const sessionIds = Object.keys(this.sessionIdVsClientInstance);
        
        for (const sessionId of sessionIds) {
            try {
                await this.removeSession(sessionId);
            } catch (error) {
                this.logger.error(`Error limpiando sesión ${sessionId}: ${error.message}`);
            }
        }
        
        // Limpiar todas las estructuras de datos
        this.sessionIdVsClientInstance = {};
        this.sessionMetadata.clear();
        this.messageQueues.clear();
        this.sessionTimeouts.clear();
        
        this.logger.info('✅ Limpieza completa del manager terminada');
    }

    /**
     * Optimizaciones específicas para Linux
     */
    startLinuxOptimizations() {
        if (!this.isLinux) return;

        this.logger.info('🐧 Iniciando optimizaciones específicas para Linux...');

        // Limpieza automática de memoria cada 5 minutos
        setInterval(() => {
            this.performLinuxCleanup();
        }, this.cleanupInterval);

        // Optimización de sesiones cada 2 minutos
        setInterval(() => {
            this.optimizeLinuxSessions();
        }, 120000);

        // Pre-calentamiento de pool si hay pocas sesiones
        setTimeout(() => {
            this.warmupSessionPool();
        }, 30000);
    }

    /**
     * Limpieza específica para Linux
     */
    performLinuxCleanup() {
        if (!this.isLinux) return;

        try {
            // Ejecutar garbage collection si está disponible
            if (global.gc) {
                global.gc();
            }

            // Limpiar cachés temporales
            const { exec } = require('child_process');
            exec('sync && echo 3 > /proc/sys/vm/drop_caches', { timeout: 5000 }, (error) => {
                if (error) {
                    this.logger.debug('No se pudo limpiar caché del sistema (normal en contenedores)');
                }
            });

            // Limpiar directorios temporales de Chrome
            exec('find /tmp -name "chrome-profile-*" -type d -mtime +1 -exec rm -rf {} +', { timeout: 10000 }, () => {
                this.logger.debug('Limpieza de perfiles temporales de Chrome completada');
            });

            this.lastCleanup = Date.now();
            this.logger.debug('🧹 Limpieza automática de Linux completada');

        } catch (error) {
            this.logger.debug(`Limpieza automática: ${error.message}`);
        }
    }

    /**
     * Optimización de sesiones para Linux
     */
    optimizeLinuxSessions() {
        if (!this.isLinux) return;

        const sessions = this.getAllSessions();
        let optimized = 0;

        sessions.forEach(sessionInfo => {
            const session = this.sessionIdVsClientInstance[sessionInfo.sessionId];
            if (!session) return;

            // Verificar si la sesión está inactiva por mucho tiempo
            const inactiveTime = Date.now() - (session.lastActivity || 0);
            
            if (inactiveTime > 1800000 && session.status !== 'loading') { // 30 minutos
                // Limpiar recursos de sesiones inactivas
                try {
                    if (session.client && session.client.pupPage) {
                        session.client.pupPage.setDefaultTimeout(30000);
                        session.client.pupPage.setDefaultNavigationTimeout(30000);
                    }
                    optimized++;
                } catch (error) {
                    this.logger.debug(`Optimización de sesión ${sessionInfo.sessionId}: ${error.message}`);
                }
            }
        });

        if (optimized > 0) {
            this.logger.debug(`⚡ Optimizadas ${optimized} sesiones en Linux`);
        }
    }

    /**
     * Pre-calentamiento de pool de sesiones para Linux
     */
    warmupSessionPool() {
        if (!this.isLinux) return;
        
        const activeSessions = Object.keys(this.sessionIdVsClientInstance).length;
        
        // Si hay pocas sesiones activas, pre-calentar el sistema
        if (activeSessions < 3) {
            this.logger.info('🔥 Pre-calentando sistema para mejor rendimiento...');
            
            try {
                // Pre-cargar módulos importantes
                require('whatsapp-web.js');
                require('qrcode');
                
                // Optimizar V8
                if (global.gc) {
                    setTimeout(() => global.gc(), 5000);
                }

                this.logger.debug('✅ Pre-calentamiento completado');
            } catch (error) {
                this.logger.debug(`Pre-calentamiento: ${error.message}`);
            }
        }
    }

    /**
     * Obtener estadísticas de rendimiento específicas para Linux
     */
    getLinuxPerformanceStats() {
        if (!this.isLinux) return {};

        const memUsage = process.memoryUsage();
        const uptime = process.uptime();
        
        return {
            platform: 'linux',
            memoryUsage: {
                rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
                external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
            },
            uptime: Math.round(uptime / 60) + ' minutos',
            lastCleanup: this.lastCleanup,
            cleanupInterval: this.cleanupInterval,
            optimizedForLinux: true
        };
    }
}

// Crear instancia singleton
const singularWhatsappSessionManager = new WhatsappSessionManager();

module.exports = singularWhatsappSessionManager; 