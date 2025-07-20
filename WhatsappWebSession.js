const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class WhatsappWebSession {
    constructor(sessionId, qrGenerationCallback, readyInstanceCallback, logger) {
        this.sessionId = sessionId;
        this.qrGenerationCallback = qrGenerationCallback;
        this.readyInstanceCallback = readyInstanceCallback;
        this.logger = logger || console;
        
        this.client = null;
        this.status = 'initializing';
        this.qrData = null;
        this.isReady = false;
        this.phoneNumber = null;
        this.lastActivity = Date.now();
        this.loadingPercent = 0;
        this.isAuthenticating = false;
        
        // VARIABLES PARA MONITOREO DE PERFORMANCE AUTH -> READY
        this.authenticatedAt = null;
        this.readyAt = null;
        this.authToReadyDuration = null;
        
        this.initializeClient();
    }

    initializeClient() {
        const isLinux = process.platform === 'linux';
        const tempDir = isLinux ? `/tmp/chrome-profile-${this.sessionId}` : `./temp-chrome-${this.sessionId}`;
        
        // Limpieza mínima
        this.cleanupPreviousSession(tempDir);
        
        // CONFIGURACIÓN OPTIMIZADA PARA ACELERAR AUTHENTICATED -> READY
        const chromeExecutable = this.findChromeExecutable();
        const shouldUseSystemChrome = chromeExecutable && isLinux;

        this.logger.info(`[${this.sessionId}] ${shouldUseSystemChrome ? `Usando Chrome del sistema: ${chromeExecutable}` : 'Usando Chromium de Puppeteer'}`);

        const clientOptions = {
            authStrategy: new LocalAuth({
                clientId: this.sessionId,
                dataPath: path.resolve(__dirname, `.wwebjs_auth`)
            }),
            puppeteer: {
                ...(shouldUseSystemChrome ? { executablePath: chromeExecutable } : {}),
                args: isLinux ? [
                    // CONFIGURACIÓN MÍNIMA PARA LINUX HEADLESS - SOLO LO ESENCIAL
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    `--user-data-dir=${tempDir}`,
                    
                    // OPTIMIZACIONES CRÍTICAS PARA VELOCIDAD
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-ipc-flooding-protection',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-background-networking',
                    '--disable-features=TranslateUI',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-sync',
                    '--disable-default-apps',
                    '--disable-domain-reliability',
                    '--disable-client-side-phishing-detection',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    
                    // MEMORIA OPTIMIZADA PARA HEADLESS
                    '--memory-pressure-off',
                    '--max_old_space_size=256',
                    '--aggressive-cache-discard',
                    
                    // RENDERING MÍNIMO
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--force-device-scale-factor=1',
                    '--disable-web-security',
                    '--disable-logging',
                    
                    // AUTOMATIZACIÓN
                    '--enable-automation',
                    '--disable-blink-features=AutomationControlled',
                    '--remote-debugging-port=0',
                    
                    // LINUX HEADLESS ESPECÍFICO
                    '--disable-namespace-sandbox',
                    '--disable-gpu-sandbox',
                    '--disk-cache-size=0',
                    '--media-cache-size=0',
                    '--disable-print-preview',
                    '--no-default-browser-check',
                    '--disable-translate',
                    '--password-store=basic',
                    '--use-mock-keychain',
                    '--disable-component-update',
                    '--metrics-recording-only',
                    '--force-color-profile=srgb'
                ] : [
                    // CONFIGURACIÓN PARA WINDOWS/MAC (mantener original)
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    `--user-data-dir=${tempDir}`,
                    '--disable-extensions',
                    '--no-default-browser-check',
                    '--disable-web-security',
                    '--enable-automation',
                    '--disable-blink-features=AutomationControlled',
                    '--remote-debugging-port=0',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--max_old_space_size=256',
                    '--disable-background-networking',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-domain-reliability',
                    '--disable-client-side-phishing-detection',
                    '--disable-prompt-on-repost',
                    '--disable-sync-preferences',
                    '--aggressive-cache-discard',
                    '--force-device-scale-factor=1'
                ],
                headless: true,
                // TIMEOUTS OPTIMIZADOS PARA LINUX HEADLESS
                timeout: isLinux ? 60000 : 60000,
                protocolTimeout: isLinux ? 75000 : 75000,
                defaultViewport: { width: 1280, height: 720 },
                ignoreHTTPSErrors: true,
                ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
                slowMo: 0,
                devtools: false,
                
                // CONFIGURACIÓN ESPECÍFICA PARA LINUX HEADLESS
                ...(isLinux ? {
                    pipe: true, // Usar pipe en lugar de WebSocket (más rápido en headless)
                    dumpio: false,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                } : {})
            },
            
            // CONFIGURACIÓN CRÍTICA PARA ACELERAR AUTHENTICATED -> READY
            authTimeoutMs: 0,
            qrMaxRetries: isLinux ? 5 : 3,
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            
            // CONFIGURACIÓN ESPECÍFICA PARA ACELERAR CARGA POST-AUTH
            ...(isLinux ? {
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                },
                bypassCSP: true,
                proxyAuthentication: undefined
            } : {})
        };

        this.client = new Client(clientOptions);
        this.setupEventListeners();
    }

    findChromeExecutable() {
        // Si está configurado explícitamente, usarlo
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            return process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        const fs = require('fs');
        const paths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/chromium-browser-stable',
            '/opt/google/chrome/chrome',
            '/usr/bin/google-chrome-unstable',
            '/usr/bin/chromium-dev'
        ];
        
        for (const path of paths) {
            if (fs.existsSync(path)) {
                this.logger.debug(`[${this.sessionId}] Usando ejecutable: ${path}`);
                return path;
            }
        }
        
        this.logger.warn(`[${this.sessionId}] No se encontró ejecutable de Chrome/Chromium, usando por defecto`);
        return undefined;
    }

    cleanupPreviousSession(tempDir) {
        try {
            if (fs.existsSync(tempDir)) {
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
            this.logger.warn(`[${this.sessionId}] Limpieza rápida: ${err.message}`);
        }
        
        // Crear directorios
        [
            path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}`),
            tempDir
        ].forEach(dir => {
            try {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
                }
            } catch (err) {
                this.logger.warn(`[${this.sessionId}] Error creando directorio ${dir}: ${err.message}`);
            }
        });
    }

    setupEventListeners() {
        // Error handling
        this.client.on('error', (error) => {
            const errorMessage = error.message || error.toString();
            
            if (errorMessage.includes('EAI_AGAIN') || 
                errorMessage.includes('ENOTFOUND') ||
                errorMessage.includes('getaddrinfo') ||
                errorMessage.includes('FetchError') ||
                errorMessage.includes('Protocol error') ||
                errorMessage.includes('Target closed') ||
                errorMessage.includes('Session closed') ||
                errorMessage.includes('Connection closed')) {
                
                this.logger.warn(`[${this.sessionId}] ⚠️ Error no crítico (IGNORADO): ${errorMessage}`);
                return;
            }
            
            this.logger.error(`[${this.sessionId}] ❌ Error crítico: ${errorMessage}`);
            this.status = 'failed';
            this.lastActivity = Date.now();
        });

        // QR Code generation
        this.client.on('qr', async (qr) => {
            this.logger.info(`[${this.sessionId}] 📱 QR Code recibido`);
            
            // Prevenir QRs múltiples
            if (this.status === 'loading' || this.status === 'authenticated') {
                this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - Estado actual: ${this.status}`);
                return;
            }
            
            if (this.qrData && this.qrGeneratedAt) {
                const timeSinceLastQR = Date.now() - this.qrGeneratedAt;
                if (timeSinceLastQR < 30000) {
                    this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - QR reciente hace ${Math.floor(timeSinceLastQR/1000)}s`);
                    return;
                }
            }
            
            if (this.isAuthenticating) {
                this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - Proceso de autenticación en curso`);
                return;
            }

            try {
                this.qrData = await QRCode.toDataURL(qr, {
                    width: 256,
                    margin: 1,
                    color: { dark: '#000000', light: '#FFFFFF' },
                    errorCorrectionLevel: 'M'
                });
                
                this.qrGeneratedAt = Date.now();
                this.status = 'waiting_qr';
                this.lastActivity = Date.now();
                
                this.logger.info(`[${this.sessionId}] ✅ QR generado exitosamente`);
                
                if (this.qrGenerationCallback) {
                    this.qrGenerationCallback(this.sessionId, this.qrData, qr);
                }
                
            } catch (error) {
                this.logger.error(`[${this.sessionId}] ❌ Error generando QR: ${error.message}`);
            }
        });

        // Loading screen
        this.client.on('loading_screen', (percent, message) => {
            this.logger.info(`[${this.sessionId}] 📱 Cargando WhatsApp Web: ${percent}% - ${message}`);
            
            this.status = 'loading';
            this.loadingPercent = percent;
            this.loadingMessage = message;
            this.lastActivity = Date.now();
            this.isAuthenticating = true;
            
            if (percent >= 99) {
                this.logger.info(`[${this.sessionId}] ⏳ WhatsApp al 99% - Esperando autenticación...`);
            }
        });

        // Authentication success
        this.client.on('authenticated', async () => {
            this.logger.info(`[${this.sessionId}] ✅ Autenticado correctamente`);
            
            this.status = 'authenticated';
            this.qrData = null;
            this.lastActivity = Date.now();
            this.isAuthenticating = false;
            this.authenticatedAt = Date.now(); // REGISTRAR TIMESTAMP AUTH
            
            // OPTIMIZACIÓN CRÍTICA: Acelerar carga post-autenticación
            try {
                // Forzar evaluación de scripts para acelerar carga
                if (this.client.pupPage) {
                    await this.client.pupPage.evaluate(() => {
                        // Forzar carga de módulos críticos de WhatsApp
                        if (window.require && window.require.ensure) {
                            try {
                                window.require.ensure([], () => {});
                            } catch (e) {}
                        }
                        
                        // Acelerar inicialización de chat store
                        if (window.Store && window.Store.Chat) {
                            try {
                                window.Store.Chat.getActive();
                            } catch (e) {}
                        }
                        
                        // Forzar renderizado inicial
                        if (window.requestIdleCallback) {
                            window.requestIdleCallback(() => {
                                if (document.querySelector('[data-testid="chat-list"]')) {
                                    console.log('WhatsApp UI components loaded');
                                }
                            });
                        }
                        
                        return true;
                    }).catch(err => {
                        // Ignorar errores de optimización
                        console.debug('Optimización post-auth ignorada:', err.message);
                    });
                }
                
                // OPTIMIZACIÓN ESPECÍFICA PARA LINUX HEADLESS
                if (process.platform === 'linux') {
                    this.logger.info(`[${this.sessionId}] 🐧 Aplicando optimizaciones específicas para Linux headless...`);
                    
                    // Forzar garbage collection en Linux
                    if (global.gc) {
                        global.gc();
                    }
                    
                    // Optimización adicional para Linux headless
                    if (this.client.pupPage) {
                        await this.client.pupPage.evaluate(() => {
                            // Deshabilitar animaciones y efectos visuales innecesarios
                            const style = document.createElement('style');
                            style.textContent = `
                                * { animation: none !important; transition: none !important; }
                                ._3YS_f { animation: none !important; }
                                [data-testid="chat-list"] { animation: none !important; }
                            `;
                            document.head.appendChild(style);
                            
                            // Forzar carga inmediata de componentes críticos
                            if (window.Store && window.Store.Conn) {
                                try {
                                    window.Store.Conn.connected = true;
                                } catch (e) {}
                            }
                            
                            return 'linux_optimizations_applied';
                        }).catch(() => {});
                    }
                }
                
                this.logger.info(`[${this.sessionId}] 🚀 Optimizaciones post-autenticación aplicadas`);
            } catch (error) {
                this.logger.warn(`[${this.sessionId}] Error en optimización post-auth: ${error.message}`);
            }
            
            // MONITOREO DE DEMORA: Alertar si tarda mucho en llegar a ready
            setTimeout(() => {
                if (this.status === 'authenticated' && !this.isReady) {
                    const elapsed = Math.round((Date.now() - this.authenticatedAt) / 1000);
                    this.logger.warn(`[${this.sessionId}] ⚠️ Han pasado ${elapsed}s desde authenticated, aún esperando ready...`);
                    
                    // Intentar forzar actualización del estado
                    try {
                        if (this.client.pupPage) {
                            this.client.pupPage.evaluate(() => {
                                // Verificar si WhatsApp ya está listo internamente
                                if (window.Store && window.Store.Conn && window.Store.Conn.connected) {
                                    console.log('WhatsApp internamente reporta conectado');
                                    return 'ready_detected';
                                }
                                return 'still_loading';
                            }).then(result => {
                                if (result === 'ready_detected') {
                                    this.logger.info(`[${this.sessionId}] 💡 WhatsApp reporta listo internamente`);
                                }
                            }).catch(() => {});
                        }
                    } catch (e) {}
                }
            }, 15000); // Alertar después de 15 segundos
        });

        // Ready
        this.client.on('ready', () => {
            this.readyAt = Date.now();
            this.authToReadyDuration = this.authenticatedAt ? 
                Math.round((this.readyAt - this.authenticatedAt) / 1000) : null;
            
            this.logger.info(`[${this.sessionId}] 🚀 Sesión lista y conectada` + 
                (this.authToReadyDuration ? ` (authenticated → ready: ${this.authToReadyDuration}s)` : ''));
            
            this.status = 'authenticated';
            this.isReady = true;
            this.qrData = null;
            this.lastActivity = Date.now();
            this.isAuthenticating = false;
            
            // Obtener información del teléfono
            if (this.client.info && this.client.info.wid) {
                this.phoneNumber = this.client.info.wid.user;
                this.logger.info(`[${this.sessionId}] 📞 Número conectado: ${this.phoneNumber}`);
            }
            
            // MÉTRICAS DE PERFORMANCE
            if (this.authToReadyDuration) {
                if (this.authToReadyDuration > 30) {
                    this.logger.warn(`[${this.sessionId}] 🐌 Tiempo auth→ready lento: ${this.authToReadyDuration}s`);
                } else if (this.authToReadyDuration < 10) {
                    this.logger.info(`[${this.sessionId}] ⚡ Tiempo auth→ready rápido: ${this.authToReadyDuration}s`);
                }
            }
            
            if (this.readyInstanceCallback) {
                this.readyInstanceCallback(this.sessionId, this);
            }
        });

        // Authentication failure
        this.client.on('auth_failure', (msg) => {
            this.logger.error(`[${this.sessionId}] ❌ Error de autenticación: ${msg}`);
            
            this.status = 'auth_failed';
            this.lastActivity = Date.now();
            this.isAuthenticating = false;
        });

        // Disconnection
        this.client.on('disconnected', (reason) => {
            this.logger.warn(`[${this.sessionId}] 🔌 Desconectado: ${reason}`);
            
            if (reason === 'NAVIGATION' || reason.includes('CONFLICT') || reason === 'LOGOUT') {
                this.logger.warn(`[${this.sessionId}] Desconexión crítica: ${reason}`);
                this.status = 'disconnected';
                this.lastActivity = Date.now();
                
                // Limpieza automática después de desconexión crítica
                setTimeout(() => {
                    this.forceCleanup();
                }, 5000);
            } else {
                this.logger.info(`[${this.sessionId}] Intentando reconexión automática...`);
                this.status = 'reconnecting';
                this.lastActivity = Date.now();
            }
        });
    }

    async initialize() {
        try {
            this.logger.info(`[${this.sessionId}] 🚀 Inicializando sesión...`);
            await this.client.initialize();
            return this;
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error inicializando: ${error.message}`);
            this.status = 'failed';
            throw error;
        }
    }

    async regenerateQR() {
        if (!this.client) {
            throw new Error('Cliente no disponible');
        }
        
        this.logger.info(`[${this.sessionId}] 🔄 Regenerando QR...`);
        this.qrData = null;
        this.qrGeneratedAt = null;
        
        // El cliente automáticamente emitirá un nuevo QR
        return { success: true, message: 'QR regeneration initiated' };
    }

    async forceReadyCheck() {
        if (!this.client || !this.client.pupPage) {
            throw new Error('Cliente o página no disponible');
        }
        
        if (this.status !== 'authenticated' || this.isReady) {
            return { success: false, message: 'No necesita verificación ready' };
        }
        
        this.logger.info(`[${this.sessionId}] 🔍 Forzando verificación de estado ready...`);
        
        try {
            const readyState = await this.client.pupPage.evaluate(() => {
                const checks = {
                    storeLoaded: !!(window.Store && window.Store.Chat),
                    connectedState: !!(window.Store && window.Store.Conn && window.Store.Conn.connected),
                    chatListVisible: !!document.querySelector('[data-testid="chat-list"]'),
                    appReady: !!(window.Store && window.Store.App && window.Store.App.ready),
                    whatsappReady: window.location.href.includes('web.whatsapp.com') && 
                                  !window.location.href.includes('loading')
                };
                
                return {
                    checks,
                    overallReady: checks.storeLoaded && checks.connectedState && checks.chatListVisible,
                    currentUrl: window.location.href,
                    timestamp: Date.now()
                };
            });
            
            this.logger.info(`[${this.sessionId}] 📊 Estado interno WhatsApp:`, {
                ready: readyState.overallReady,
                checks: readyState.checks
            });
            
            if (readyState.overallReady && !this.isReady) {
                this.logger.warn(`[${this.sessionId}] 🔧 WhatsApp está listo internamente pero no se disparó evento ready`);
                
                // Forzar disparo del evento ready si todo está listo
                this.readyAt = Date.now();
                this.authToReadyDuration = this.authenticatedAt ? 
                    Math.round((this.readyAt - this.authenticatedAt) / 1000) : null;
                
                this.status = 'authenticated';
                this.isReady = true;
                this.lastActivity = Date.now();
                
                this.logger.info(`[${this.sessionId}] ✅ Estado ready forzado exitosamente (${this.authToReadyDuration}s)`);
                
                if (this.readyInstanceCallback) {
                    this.readyInstanceCallback(this.sessionId, this);
                }
                
                return { 
                    success: true, 
                    message: 'Ready state forced successfully',
                    duration: this.authToReadyDuration
                };
            }
            
            return { 
                success: false, 
                message: 'WhatsApp not fully ready yet',
                readyState
            };
            
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error verificando estado ready: ${error.message}`);
            throw error;
        }
    }

    async restart() {
        this.logger.info(`[${this.sessionId}] 🔄 Reiniciando sesión...`);
        
        try {
            if (this.client) {
                await this.client.destroy();
            }
        } catch (error) {
            this.logger.warn(`[${this.sessionId}] Error destruyendo cliente: ${error.message}`);
        }
        
        await this.forceCleanup();
        this.initializeClient();
        return await this.initialize();
    }

    async forceCleanup() {
        try {
            this.logger.info(`[${this.sessionId}] 🧹 Ejecutando limpieza forzada...`);
            
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (err) {
                    this.logger.warn(`[${this.sessionId}] Error destruyendo cliente: ${err.message}`);
                }
            }
            
            // Matar procesos Chrome específicos de esta sesión
            if (process.platform === 'win32') {
                exec(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${this.sessionId}*"`, (err) => {
                    if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chrome terminados (Windows)`);
                });
            } else {
                exec(`pkill -f "chromium.*${this.sessionId}"`, (err) => {
                    if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chromium terminados`);
                });
            }
            
            // Eliminar directorios temporales
            const tempDir = `/tmp/chrome-profile-${this.sessionId}`;
            if (fs.existsSync(tempDir)) {
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    this.logger.debug(`[${this.sessionId}] Directorio temporal eliminado`);
                } catch (err) {
                    this.logger.error(`[${this.sessionId}] Error eliminando directorio temporal: ${err.message}`);
                }
            }
            
            // Forzar garbage collection
            if (global.gc) {
                global.gc();
            }
            
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error en limpieza forzada: ${error.message}`);
        }
    }

    getStatus() {
        return {
            sessionId: this.sessionId,
            status: this.status,
            qrAvailable: !!this.qrData,
            qrData: this.qrData,
            isReady: this.isReady,
            phoneNumber: this.phoneNumber,
            lastActivity: this.lastActivity,
            loadingPercent: this.loadingPercent,
            loadingMessage: this.loadingMessage,
            isAuthenticating: this.isAuthenticating,
            // MÉTRICAS DE PERFORMANCE AUTH → READY
            authenticatedAt: this.authenticatedAt,
            readyAt: this.readyAt,
            authToReadyDuration: this.authToReadyDuration,
            waitingForReady: this.status === 'authenticated' && !this.isReady,
            currentWaitTime: this.authenticatedAt && !this.isReady ? 
                Math.round((Date.now() - this.authenticatedAt) / 1000) : null
        };
    }

    async sendMessage(phoneNumber, message) {
        if (!this.isReady) {
            throw new Error('Session not ready');
        }
        
        try {
            const chatId = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@c.us`;
            const result = await this.client.sendMessage(chatId, message);
            this.lastActivity = Date.now();
            return result;
        } catch (error) {
            this.logger.error(`[${this.sessionId}] Error enviando mensaje: ${error.message}`);
            throw error;
        }
    }
}

module.exports = { WhatsappWebSession }; 