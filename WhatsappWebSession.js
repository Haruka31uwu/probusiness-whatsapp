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
        
        // VARIABLES PARA CONTROL DE REINTENTOS
        this.retryCount = 0;
        this.maxRetries = 3;
        this.lastRetryTime = null;
        
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
                    // Seguridad básica para Linux
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    
                    // Configuración de proceso
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    `--user-data-dir=${tempDir}`,
                    
                    // Optimizaciones esenciales
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-logging',
                    '--disable-default-apps',
                    '--disable-sync',
                    
                    // Automatización
                    '--enable-automation',
                    '--disable-blink-features=AutomationControlled',
                    '--remote-debugging-port=0',
                    
                    // Memoria y rendimiento
                    '--max_old_space_size=256',
                    '--aggressive-cache-discard',
                    '--memory-pressure-off',
                    '--disk-cache-size=0',
                    
                    // Específico para WhatsApp (si es necesario)
                    '--host-resolver-rules="MAP *.whatsapp.net 157.240.0.53"'
                ] : [
                    // Configuración básica para Windows/Mac
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    `--user-data-dir=${tempDir}`,
                    '--disable-extensions',
                    '--disable-web-security',
                    '--enable-automation',
                    '--disable-blink-features=AutomationControlled',
                    '--remote-debugging-port=0',
                    '--max_old_space_size=256'
                ],
                
                headless: true,
                timeout: 60000,
                protocolTimeout: 75000,
                defaultViewport: { width: 1280, height: 720 },
                ignoreHTTPSErrors: true,
                slowMo: 0,
                devtools: false,
                
                // Configuración específica para Linux
                ...(isLinux ? {
                    pipe: true,
                    dumpio: false,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                } : {})
            }
            
            // CONFIGURACIÓN CRÍTICA PARA ACELERAR AUTHENTICATED -> READY
            authTimeoutMs: 0,
            qrMaxRetries: isLinux ? 5 : 3,
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            
            // CONFIGURACIÓN ESPECÍFICA PARA ACELERAR CARGA POST-AUTH
            ...(isLinux ? {
                // DESHABILITAR webVersionCache PARA EVITAR ERRORES DE RED
                // webVersionCache: {
                //     type: 'remote',
                //     remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                // },
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
            
            // CONFIGURACIÓN ESPECÍFICA PARA PREVENIR ERRORES DE PROTOCOLO EN LINUX
            if (process.platform === 'linux') {
                this.logger.info(`[${this.sessionId}] 🐧 Aplicando configuraciones de estabilidad para Linux...`);
                
                // Configurar timeouts más conservadores para Linux
                if (this.client.pupPage) {
                    try {
                        await this.client.pupPage.setDefaultTimeout(30000); // 30s timeout
                        await this.client.pupPage.setDefaultNavigationTimeout(45000); // 45s navigation
                    } catch (e) {
                        this.logger.debug(`[${this.sessionId}] Configuración de timeouts ignorada: ${e.message}`);
                    }
                }
            }
            
            await this.client.initialize();
            return this;
        } catch (error) {
            const errorMessage = error.message || error.toString();
            
            // INTENTAR RECUPERACIÓN AUTOMÁTICA PARA ERRORES DE PROTOCOLO
            const recoverySuccessful = await this.handleProtocolError(error);
            if (recoverySuccessful) {
                return this; // Recuperación exitosa
            }
            
            // MANEJO ESPECÍFICO PARA ERRORES DE PROTOCOLO EN LINUX
            if (errorMessage.includes('Network.setUserAgentOverride') || 
                errorMessage.includes('Session closed') ||
                errorMessage.includes('Most likely the page has been closed') ||
                errorMessage.includes('Protocol error')) {
                
                this.logger.warn(`[${this.sessionId}] ⚠️ Error de protocolo detectado: ${errorMessage}`);
                
                // Verificar si es un problema de estabilidad en Linux
                if (process.platform === 'linux') {
                    this.logger.info(`[${this.sessionId}] 🔄 Reintentando con configuración más estable...`);
                    
                    // Limpiar recursos y reintentar
                    try {
                        if (this.client) {
                            await this.client.destroy();
                        }
                    } catch (destroyError) {
                        this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${destroyError.message}`);
                    }
                    
                    // Pequeña pausa antes de reintentar
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Recrear cliente con configuración más estable
                    this.initializeClient();
                    
                    // Reintentar inicialización
                    try {
                        await this.client.initialize();
                        this.logger.info(`[${this.sessionId}] ✅ Reintento exitoso después de error de protocolo`);
                        return this;
                    } catch (retryError) {
                        this.logger.error(`[${this.sessionId}] ❌ Error en reintento: ${retryError.message}`);
                        this.status = 'failed';
                        throw retryError;
                    }
                }
            }
            
            // MANEJO ESPECÍFICO PARA ERRORES DE RED
            if (errorMessage.includes('ECONNRESET') || 
                errorMessage.includes('ENOTFOUND') ||
                errorMessage.includes('EAI_AGAIN') ||
                errorMessage.includes('getaddrinfo') ||
                errorMessage.includes('FetchError')) {
                
                this.logger.warn(`[${this.sessionId}] 🌐 Error de red detectado: ${errorMessage}`);
                
                if (process.platform === 'linux') {
                    this.logger.info(`[${this.sessionId}] 🔄 Reintentando después de error de red...`);
                    
                    // Pausa más larga para errores de red
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Limpiar y reintentar
                    try {
                        if (this.client) {
                            await this.client.destroy();
                        }
                    } catch (destroyError) {
                        this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${destroyError.message}`);
                    }
                    
                    this.initializeClient();
                    
                    try {
                        await this.client.initialize();
                        this.logger.info(`[${this.sessionId}] ✅ Reintento exitoso después de error de red`);
                        return this;
                    } catch (retryError) {
                        this.logger.error(`[${this.sessionId}] ❌ Error en reintento de red: ${retryError.message}`);
                        this.status = 'failed';
                        throw retryError;
                    }
                }
            }
            
            this.logger.error(`[${this.sessionId}] ❌ Error inicializando: ${errorMessage}`);
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

    async handleProtocolError(error) {
        const errorMessage = error.message || error.toString();
        
        // VERIFICAR LÍMITE DE REINTENTOS
        if (this.retryCount >= this.maxRetries) {
            this.logger.error(`[${this.sessionId}] 🚫 Límite de reintentos alcanzado (${this.maxRetries}). Deteniendo recuperación automática.`);
            this.status = 'failed';
            return false;
        }
        
        // DETECTAR ERRORES DE PROTOCOLO Y RED ESPECÍFICOS
        const isProtocolError = errorMessage.includes('Network.setUserAgentOverride') ||
                               errorMessage.includes('Session closed') ||
                               errorMessage.includes('Protocol error') ||
                               errorMessage.includes('Target closed') ||
                               errorMessage.includes('Connection closed') ||
                               errorMessage.includes('Target.setAutoAttach');
        
        // DETECTAR ERRORES DE RED
        const isNetworkError = errorMessage.includes('ECONNRESET') ||
                              errorMessage.includes('ENOTFOUND') ||
                              errorMessage.includes('EAI_AGAIN') ||
                              errorMessage.includes('getaddrinfo') ||
                              errorMessage.includes('FetchError') ||
                              errorMessage.includes('net::ERR_NAME_NOT_RESOLVED') ||
                              errorMessage.includes('net::ERR_CONNECTION_RESET') ||
                              errorMessage.includes('net::ERR_CONNECTION_TIMED_OUT');
        
        if (!isProtocolError && !isNetworkError) {
            return false; // No es un error de protocolo ni de red
        }
        
        // INCREMENTAR CONTADOR DE REINTENTOS
        this.retryCount++;
        this.lastRetryTime = Date.now();
        
        if (isNetworkError) {
            this.logger.warn(`[${this.sessionId}] 🌐 Error de red detectado (intento ${this.retryCount}/${this.maxRetries}): ${errorMessage}`);
        } else {
            this.logger.warn(`[${this.sessionId}] 🔧 Error de protocolo detectado (intento ${this.retryCount}/${this.maxRetries}): ${errorMessage}`);
        }
        
        // ESTRATEGIAS DE RECUPERACIÓN PARA LINUX
        if (process.platform === 'linux') {
            try {
                // Estrategia 1: Limpiar recursos y reintentar
                this.logger.info(`[${this.sessionId}] 🔄 Aplicando estrategia de recuperación para Linux...`);
                
                // Limpiar procesos huérfanos más agresivamente
                const { exec } = require('child_process');
                exec(`pkill -9 -f "chromium.*${this.sessionId}"`, (err) => {
                    if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chromium terminados (force)`);
                });
                
                // Limpiar también procesos de Chrome
                exec(`pkill -9 -f "chrome.*${this.sessionId}"`, (err) => {
                    if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chrome terminados (force)`);
                });
                
                // Pausa progresiva (más tiempo en cada reintento)
                const basePauseTime = isNetworkError ? 5000 : 3000;
                const progressivePause = basePauseTime + (this.retryCount * 2000);
                this.logger.info(`[${this.sessionId}] ⏳ Pausando ${progressivePause/1000}s para estabilizar (intento ${this.retryCount})...`);
                await new Promise(resolve => setTimeout(resolve, progressivePause));
                
                // Limpieza más agresiva de directorios temporales
                const tempDir = `/tmp/chrome-profile-${this.sessionId}`;
                if (fs.existsSync(tempDir)) {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                        this.logger.debug(`[${this.sessionId}] Directorio temporal eliminado`);
                    } catch (err) {
                        this.logger.debug(`[${this.sessionId}] Error eliminando directorio temporal: ${err.message}`);
                    }
                }
                
                // Recrear cliente con configuración más estable
                if (this.client) {
                    try {
                        await this.client.destroy();
                    } catch (destroyError) {
                        this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${destroyError.message}`);
                    }
                }
                
                this.initializeClient();
                
                // Reintentar inicialización con timeout más corto
                const initTimeout = 30000 + (this.retryCount * 10000); // Timeout progresivo
                const initPromise = this.client.initialize();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Initialization timeout')), initTimeout)
                );
                
                await Promise.race([initPromise, timeoutPromise]);
                this.logger.info(`[${this.sessionId}] ✅ Recuperación exitosa después de ${isNetworkError ? 'error de red' : 'error de protocolo'} (intento ${this.retryCount})`);
                return true;
                
            } catch (recoveryError) {
                this.logger.error(`[${this.sessionId}] ❌ Error en recuperación (intento ${this.retryCount}): ${recoveryError.message}`);
                
                // Si es el último intento, intentar estrategia de fallback
                if (this.retryCount >= this.maxRetries) {
                    this.logger.warn(`[${this.sessionId}] 🚨 Intentando estrategia de fallback...`);
                    return await this.fallbackStrategy();
                }
                
                return false;
            }
        }
        
        return false;
    }

    async fallbackStrategy() {
        this.logger.warn(`[${this.sessionId}] 🚨 Ejecutando estrategia de fallback...`);
        
        try {
            // ESTRATEGIA DE FALLBACK: Configuración mínima sin optimizaciones
            this.logger.info(`[${this.sessionId}] 🔧 Recreando cliente con configuración mínima...`);
            
            // Limpiar completamente
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (e) {}
            }
            
            // Limpiar todos los procesos relacionados
            const { exec } = require('child_process');
            exec(`pkill -9 -f "chromium.*${this.sessionId}"`, () => {});
            exec(`pkill -9 -f "chrome.*${this.sessionId}"`, () => {});
            
            // Pausa larga
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Recrear con configuración mínima
            this.initializeClientMinimal();
            
            // Intentar inicialización con timeout muy largo
            await Promise.race([
                this.client.initialize(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback timeout')), 120000))
            ]);
            
            this.logger.info(`[${this.sessionId}] ✅ Estrategia de fallback exitosa`);
            return true;
            
        } catch (fallbackError) {
            this.logger.error(`[${this.sessionId}] ❌ Estrategia de fallback falló: ${fallbackError.message}`);
            this.status = 'failed';
            return false;
        }
    }

    initializeClientMinimal() {
        const isLinux = process.platform === 'linux';
        const tempDir = isLinux ? `/tmp/chrome-profile-${this.sessionId}-minimal` : `./temp-chrome-${this.sessionId}-minimal`;
        
        // CONFIGURACIÓN MÍNIMA PARA FALLBACK
        const clientOptions = {
            authStrategy: new LocalAuth({
                clientId: this.sessionId,
                dataPath: path.resolve(__dirname, `.wwebjs_auth`)
            }),
            puppeteer: {
                args: [
                    // SOLO LO ABSOLUTAMENTE ESENCIAL
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-sync',
                    '--disable-default-apps',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-domain-reliability',
                    '--disable-client-side-phishing-detection',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    '--memory-pressure-off',
                    '--max_old_space_size=256',
                    '--aggressive-cache-discard',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--force-device-scale-factor=1',
                    '--disable-web-security',
                    '--disable-logging',
                    '--enable-automation',
                    '--disable-blink-features=AutomationControlled',
                    '--remote-debugging-port=0',
                    `--user-data-dir=${tempDir}`,
                    ...(isLinux ? [
                        '--disable-namespace-sandbox',
                        '--disable-gpu-sandbox',
                        '--disk-cache-size=0',
                        '--media-cache-size=0',
                        '--no-default-browser-check',
                        '--disable-translate',
                        '--password-store=basic',
                        '--use-mock-keychain',
                        '--disable-component-update',
                        '--metrics-recording-only',
                        '--force-color-profile=srgb'
                    ] : [])
                ],
                headless: true,
                timeout: 90000,
                protocolTimeout: 120000,
                defaultViewport: { width: 1280, height: 720 },
                ignoreHTTPSErrors: true,
                ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
                slowMo: 0,
                devtools: false,
                ...(isLinux ? {
                    pipe: true,
                    dumpio: false,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                } : {})
            },
            authTimeoutMs: 0,
            qrMaxRetries: 3,
            restartOnAuthFail: true,
            takeoverOnConflict: true
        };

        this.client = new Client(clientOptions);
        this.setupEventListeners();
    }

    async restart() {
        this.logger.info(`[${this.sessionId}] 🔄 Reiniciando sesión...`);
        
        try {
            // Usar el método de destrucción completa
            await this.destroySession();
            
            // Resetear contador de reintentos para el reinicio
            this.retryCount = 0;
            this.maxRetries = 3;
            this.lastRetryTime = null;
            
            // Recrear cliente
            this.initializeClient();
            
            // Reinicializar
            return await this.initialize();
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error reiniciando sesión: ${error.message}`);
            throw error;
        }
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
            
            // ELIMINAR CARPETA DE AUTENTICACIÓN ESPECÍFICA DE LA SESIÓN
            const authSessionDir = path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}`);
            if (fs.existsSync(authSessionDir)) {
                try {
                    fs.rmSync(authSessionDir, { recursive: true, force: true });
                    this.logger.info(`[${this.sessionId}] ✅ Carpeta de autenticación eliminada: ${authSessionDir}`);
                } catch (err) {
                    this.logger.error(`[${this.sessionId}] ❌ Error eliminando carpeta de autenticación: ${err.message}`);
                }
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
            
            // Eliminar también directorio temporal de fallback si existe
            const tempDirMinimal = `/tmp/chrome-profile-${this.sessionId}-minimal`;
            if (fs.existsSync(tempDirMinimal)) {
                try {
                    fs.rmSync(tempDirMinimal, { recursive: true, force: true });
                    this.logger.debug(`[${this.sessionId}] Directorio temporal minimal eliminado`);
                } catch (err) {
                    this.logger.debug(`[${this.sessionId}] Error eliminando directorio minimal: ${err.message}`);
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

    async destroySession() {
        this.logger.info(`[${this.sessionId}] 🗑️ Destruyendo sesión completamente...`);
        
        try {
            // 1. Destruir cliente
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (err) {
                    this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${err.message}`);
                }
            }
            
            // 2. Matar todos los procesos relacionados
            const { exec } = require('child_process');
            if (process.platform === 'win32') {
                exec(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${this.sessionId}*"`, () => {});
            } else {
                exec(`pkill -9 -f "chromium.*${this.sessionId}"`, () => {});
                exec(`pkill -9 -f "chrome.*${this.sessionId}"`, () => {});
            }
            
            // 3. ELIMINAR CARPETA DE AUTENTICACIÓN COMPLETA
            const authSessionDir = path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}`);
            if (fs.existsSync(authSessionDir)) {
                try {
                    fs.rmSync(authSessionDir, { recursive: true, force: true });
                    this.logger.info(`[${this.sessionId}] ✅ Carpeta de autenticación eliminada: ${authSessionDir}`);
                } catch (err) {
                    this.logger.error(`[${this.sessionId}] ❌ Error eliminando carpeta de autenticación: ${err.message}`);
                }
            }
            
            // 4. Eliminar directorios temporales
            const tempDirs = [
                `/tmp/chrome-profile-${this.sessionId}`,
                `/tmp/chrome-profile-${this.sessionId}-minimal`,
                `./temp-chrome-${this.sessionId}`,
                `./temp-chrome-${this.sessionId}-minimal`
            ];
            
            tempDirs.forEach(dir => {
                if (fs.existsSync(dir)) {
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                        this.logger.debug(`[${this.sessionId}] Directorio eliminado: ${dir}`);
                    } catch (err) {
                        this.logger.debug(`[${this.sessionId}] Error eliminando ${dir}: ${err.message}`);
                    }
                }
            });
            
            // 5. Limpiar archivos de bloqueo específicos
            const lockFiles = [
                path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}/.lock`),
                path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}/.session`),
                path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}/.auth_info_baileys`)
            ];
            
            lockFiles.forEach(file => {
                if (fs.existsSync(file)) {
                    try {
                        fs.unlinkSync(file);
                        this.logger.debug(`[${this.sessionId}] Archivo de bloqueo eliminado: ${file}`);
                    } catch (err) {
                        this.logger.debug(`[${this.sessionId}] Error eliminando archivo de bloqueo: ${err.message}`);
                    }
                }
            });
            
            // 6. Resetear variables de estado
            this.status = 'destroyed';
            this.isReady = false;
            this.qrData = null;
            this.authenticatedAt = null;
            this.readyAt = null;
            this.authToReadyDuration = null;
            this.retryCount = 0;
            this.lastRetryTime = null;
            this.phoneNumber = null;
            this.lastActivity = Date.now();
            
            // 7. Forzar garbage collection
            if (global.gc) {
                global.gc();
            }
            
            this.logger.info(`[${this.sessionId}] ✅ Sesión destruida completamente`);
            return true;
            
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error destruyendo sesión: ${error.message}`);
            return false;
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
                Math.round((Date.now() - this.authenticatedAt) / 1000) : null,
            // INFORMACIÓN DE REINTENTOS
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            lastRetryTime: this.lastRetryTime,
            retryStatus: this.retryCount > 0 ? 
                `${this.retryCount}/${this.maxRetries} reintentos` : 'Sin reintentos'
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