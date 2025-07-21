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
        
        // Estado de la sesión
        this.client = null;
        this.status = 'initializing';
        this.isReady = false;
        this.phoneNumber = null;
        this.lastActivity = Date.now();
        
        // QR y autenticación
        this.qrData = null;
        this.qrGeneratedAt = null;
        this.isAuthenticating = false;
        this.loadingPercent = 0;
        this.loadingMessage = null;
        
        // Métricas de performance
        this.authenticatedAt = null;
        this.readyAt = null;
        this.authToReadyDuration = null;
        
        // Control de reintentos
        this.retryCount = 0;
        this.maxRetries = 3;
        this.lastRetryTime = null;
        
        this.initializeClient();
    }

    // ========================================
    // CONFIGURACIÓN Y INICIALIZACIÓN
    // ========================================

    initializeClient() {
        const isLinux = process.platform === 'linux';
        const tempDir = this.getTempDir();
        
        this.cleanupPreviousSession(tempDir);
        
        const clientOptions = {
            authStrategy: new LocalAuth({
                clientId: this.sessionId,
                dataPath: path.resolve(__dirname, `.wwebjs_auth`)
            }),
            puppeteer: this.getPuppeteerConfig(isLinux, tempDir),
            authTimeoutMs: 0,
            qrMaxRetries: isLinux ? 5 : 3,
            restartOnAuthFail: true,
            takeoverOnConflict: true
        };

        this.client = new Client(clientOptions);
        this.setupEventListeners();
    }

    getPuppeteerConfig(isLinux, tempDir) {
        const chromeExecutable = this.findChromeExecutable();
        const shouldUseSystemChrome = chromeExecutable && isLinux;

        this.logger.info(`[${this.sessionId}] ${shouldUseSystemChrome ? `Usando Chrome del sistema: ${chromeExecutable}` : 'Usando Chromium de Puppeteer'}`);

        return {
            ...(shouldUseSystemChrome ? { executablePath: chromeExecutable } : {}),
            args: this.getChromeArgs(isLinux, tempDir),
            headless: true,
            timeout: isLinux ? 60000 : 60000,
            protocolTimeout: isLinux ? 75000 : 75000,
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
        };
    }

    getChromeArgs(isLinux, tempDir) {
        const baseArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            `--user-data-dir=${tempDir}`,
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
            '--remote-debugging-port=0'
        ];

        if (isLinux) {
            baseArgs.push(
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
                '--force-color-profile=srgb',
                '--disable-field-trial-config',
                '--disable-search-engine-choice-screen',
                '--disable-sync-preferences',
                '--host-resolver-rules="MAP *.whatsapp.net 157.240.0.53"',
                '--enable-tcp-fast-open',
                '--enable-simple-cache-backend',
                '--process-per-site'
            );
        }

        return baseArgs;
    }

    getTempDir() {
        const isLinux = process.platform === 'linux';
        return isLinux ? `/tmp/chrome-profile-${this.sessionId}` : `./temp-chrome-${this.sessionId}`;
    }

    findChromeExecutable() {
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            return process.env.PUPPETEER_EXECUTABLE_PATH;
        }

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

    // ========================================
    // EVENTOS Y MANEJO DE ESTADOS
    // ========================================

    setupEventListeners() {
        this.client.on('error', this.handleError.bind(this));
        this.client.on('qr', this.handleQR.bind(this));
        this.client.on('loading_screen', this.handleLoading.bind(this));
        this.client.on('authenticated', this.handleAuthenticated.bind(this));
        this.client.on('ready', this.handleReady.bind(this));
        this.client.on('auth_failure', this.handleAuthFailure.bind(this));
        this.client.on('disconnected', this.handleDisconnected.bind(this));
    }

    handleError(error) {
        const errorMessage = error.message || error.toString();
        
        if (this.isNonCriticalError(errorMessage)) {
            this.logger.warn(`[${this.sessionId}] ⚠️ Error no crítico (IGNORADO): ${errorMessage}`);
            return;
        }
        
        this.logger.error(`[${this.sessionId}] ❌ Error crítico: ${errorMessage}`);
        this.status = 'failed';
        this.lastActivity = Date.now();
    }

    isNonCriticalError(errorMessage) {
        const nonCriticalErrors = [
            'EAI_AGAIN', 'ENOTFOUND', 'getaddrinfo', 'FetchError', 'Protocol error',
            'Target closed', 'Session closed', 'Connection closed', 'raw.githubusercontent.com'
        ];
        
        return nonCriticalErrors.some(error => errorMessage.includes(error));
    }

    async handleQR(qr) {
        this.logger.info(`[${this.sessionId}] 📱 QR Code recibido`);
        
        if (this.shouldIgnoreQR()) {
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
    }

    shouldIgnoreQR() {
        if (this.status === 'loading' || this.status === 'authenticated') {
            this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - Estado actual: ${this.status}`);
            return true;
        }
        
        if (this.qrData && this.qrGeneratedAt) {
            const timeSinceLastQR = Date.now() - this.qrGeneratedAt;
            if (timeSinceLastQR < 30000) {
                this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - QR reciente hace ${Math.floor(timeSinceLastQR/1000)}s`);
                return true;
            }
        }
        
        if (this.isAuthenticating) {
            this.logger.warn(`[${this.sessionId}] 🚫 QR ignorado - Proceso de autenticación en curso`);
            return true;
        }
        
        return false;
    }

    handleLoading(percent, message) {
        this.logger.info(`[${this.sessionId}] 📱 Cargando WhatsApp Web: ${percent}% - ${message}`);
        
        this.status = 'loading';
        this.loadingPercent = percent;
        this.loadingMessage = message;
        this.lastActivity = Date.now();
        this.isAuthenticating = true;
        
        if (percent >= 99) {
            this.logger.info(`[${this.sessionId}] ⏳ WhatsApp al 99% - Esperando autenticación...`);
        }
    }

    async handleAuthenticated() {
        this.logger.info(`[${this.sessionId}] ✅ Autenticado correctamente`);
        
        this.status = 'authenticated';
        this.qrData = null;
        this.lastActivity = Date.now();
        this.isAuthenticating = false;
        this.authenticatedAt = Date.now();
        
        await this.applyPostAuthOptimizations();
        this.scheduleReadyCheck();
    }

    async applyPostAuthOptimizations() {
        try {
            if (this.client.pupPage) {
                await this.client.pupPage.evaluate(() => {
                    if (window.require && window.require.ensure) {
                        try { window.require.ensure([], () => {}); } catch (e) {}
                    }
                    if (window.Store && window.Store.Chat) {
                        try { window.Store.Chat.getActive(); } catch (e) {}
                    }
                    if (window.requestIdleCallback) {
                        window.requestIdleCallback(() => {
                            if (document.querySelector('[data-testid="chat-list"]')) {
                                console.log('WhatsApp UI components loaded');
                            }
                        });
                    }
                    return true;
                }).catch(err => {
                    console.debug('Optimización post-auth ignorada:', err.message);
                });
            }
            
            if (process.platform === 'linux') {
                await this.applyLinuxOptimizations();
            }
            
            this.logger.info(`[${this.sessionId}] 🚀 Optimizaciones post-autenticación aplicadas`);
        } catch (error) {
            this.logger.warn(`[${this.sessionId}] Error en optimización post-auth: ${error.message}`);
        }
    }

    async applyLinuxOptimizations() {
        this.logger.info(`[${this.sessionId}] 🐧 Aplicando optimizaciones específicas para Linux headless...`);
        
        if (global.gc) {
            global.gc();
        }
        
        if (this.client.pupPage) {
            await this.client.pupPage.evaluate(() => {
                const style = document.createElement('style');
                style.textContent = `
                    * { animation: none !important; transition: none !important; }
                    ._3YS_f { animation: none !important; }
                    [data-testid="chat-list"] { animation: none !important; }
                `;
                document.head.appendChild(style);
                
                if (window.Store && window.Store.Conn) {
                    try { window.Store.Conn.connected = true; } catch (e) {}
                }
                
                return 'linux_optimizations_applied';
            }).catch(() => {});
        }
    }

    scheduleReadyCheck() {
        setTimeout(() => {
            if (this.status === 'authenticated' && !this.isReady) {
                const elapsed = Math.round((Date.now() - this.authenticatedAt) / 1000);
                this.logger.warn(`[${this.sessionId}] ⚠️ Han pasado ${elapsed}s desde authenticated, aún esperando ready...`);
                
                this.checkInternalReadyState();
            }
        }, 15000);
    }

    async checkInternalReadyState() {
        try {
            if (this.client.pupPage) {
                const result = await this.client.pupPage.evaluate(() => {
                    if (window.Store && window.Store.Conn && window.Store.Conn.connected) {
                        console.log('WhatsApp internamente reporta conectado');
                        return 'ready_detected';
                    }
                    return 'still_loading';
                });
                
                if (result === 'ready_detected') {
                    this.logger.info(`[${this.sessionId}] 💡 WhatsApp reporta listo internamente`);
                }
            }
        } catch (e) {}
    }

    handleReady() {
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
        
        if (this.client.info && this.client.info.wid) {
            this.phoneNumber = this.client.info.wid.user;
            this.logger.info(`[${this.sessionId}] 📞 Número conectado: ${this.phoneNumber}`);
        }
        
        this.logPerformanceMetrics();
        
        if (this.readyInstanceCallback) {
            this.readyInstanceCallback(this.sessionId, this);
        }
    }

    logPerformanceMetrics() {
        if (this.authToReadyDuration) {
            if (this.authToReadyDuration > 30) {
                this.logger.warn(`[${this.sessionId}] 🐌 Tiempo auth→ready lento: ${this.authToReadyDuration}s`);
            } else if (this.authToReadyDuration < 10) {
                this.logger.info(`[${this.sessionId}] ⚡ Tiempo auth→ready rápido: ${this.authToReadyDuration}s`);
            }
        }
    }

    handleAuthFailure(msg) {
        this.logger.error(`[${this.sessionId}] ❌ Error de autenticación: ${msg}`);
        this.status = 'auth_failed';
        this.lastActivity = Date.now();
        this.isAuthenticating = false;
    }

    handleDisconnected(reason) {
        this.logger.warn(`[${this.sessionId}] 🔌 Desconectado: ${reason}`);
        
        if (this.isCriticalDisconnection(reason)) {
            this.logger.warn(`[${this.sessionId}] Desconexión crítica: ${reason}`);
            this.status = 'disconnected';
            this.lastActivity = Date.now();
            
            setTimeout(() => {
                this.forceCleanup();
            }, 5000);
        } else {
            this.logger.info(`[${this.sessionId}] Intentando reconexión automática...`);
            this.status = 'reconnecting';
            this.lastActivity = Date.now();
        }
    }

    isCriticalDisconnection(reason) {
        return reason === 'NAVIGATION' || reason.includes('CONFLICT') || reason === 'LOGOUT';
    }

    // ========================================
    // INICIALIZACIÓN Y RECUPERACIÓN
    // ========================================

    async initialize() {
        try {
            this.logger.info(`[${this.sessionId}] 🚀 Inicializando sesión...`);
            
            if (process.platform === 'linux') {
                await this.applyLinuxStabilityConfig();
            }
            
            await this.client.initialize();
            return this;
        } catch (error) {
            return await this.handleInitializationError(error);
        }
    }

    async applyLinuxStabilityConfig() {
        this.logger.info(`[${this.sessionId}] 🐧 Aplicando configuraciones de estabilidad para Linux...`);
        
        if (this.client.pupPage) {
            try {
                await this.client.pupPage.setDefaultTimeout(30000);
                await this.client.pupPage.setDefaultNavigationTimeout(45000);
            } catch (e) {
                this.logger.debug(`[${this.sessionId}] Configuración de timeouts ignorada: ${e.message}`);
            }
        }
    }

    async handleInitializationError(error) {
        const errorMessage = error.message || error.toString();
        
        const recoverySuccessful = await this.handleProtocolError(error);
        if (recoverySuccessful) {
            return this;
        }
        
        if (this.isNetworkError(errorMessage)) {
            return await this.handleNetworkError(errorMessage);
        }
        
        this.logger.error(`[${this.sessionId}] ❌ Error inicializando: ${errorMessage}`);
        this.status = 'failed';
        throw error;
    }

    isNetworkError(errorMessage) {
        const networkErrors = ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'getaddrinfo', 'FetchError'];
        return networkErrors.some(error => errorMessage.includes(error));
    }

    async handleNetworkError(errorMessage) {
        this.logger.warn(`[${this.sessionId}] 🌐 Error de red detectado: ${errorMessage}`);
        
        if (process.platform === 'linux') {
            return await this.retryWithNetworkRecovery();
        }
        
        this.status = 'failed';
        throw new Error(errorMessage);
    }

    async retryWithNetworkRecovery() {
        this.logger.info(`[${this.sessionId}] 🔄 Reintentando después de error de red...`);
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
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

    async handleProtocolError(error) {
        const errorMessage = error.message || error.toString();
        
        if (this.retryCount >= this.maxRetries) {
            this.logger.error(`[${this.sessionId}] 🚫 Límite de reintentos alcanzado (${this.maxRetries}). Deteniendo recuperación automática.`);
            this.status = 'failed';
            return false;
        }
        
        const isProtocolError = this.isProtocolError(errorMessage);
        const isNetworkError = this.isNetworkError(errorMessage);
        
        if (!isProtocolError && !isNetworkError) {
            return false;
        }
        
        this.retryCount++;
        this.lastRetryTime = Date.now();
        
        if (isNetworkError) {
            this.logger.warn(`[${this.sessionId}] 🌐 Error de red detectado (intento ${this.retryCount}/${this.maxRetries}): ${errorMessage}`);
        } else {
            this.logger.warn(`[${this.sessionId}] 🔧 Error de protocolo detectado (intento ${this.retryCount}/${this.maxRetries}): ${errorMessage}`);
        }
        
        if (process.platform === 'linux') {
            return await this.performLinuxRecovery(isNetworkError);
        }
        
        return false;
    }

    isProtocolError(errorMessage) {
        const protocolErrors = [
            'Network.setUserAgentOverride', 'Session closed', 'Protocol error',
            'Target closed', 'Connection closed', 'Target.setAutoAttach'
        ];
        return protocolErrors.some(error => errorMessage.includes(error));
    }

    async performLinuxRecovery(isNetworkError) {
        try {
            this.logger.info(`[${this.sessionId}] 🔄 Aplicando estrategia de recuperación para Linux...`);
            
            await this.killRelatedProcesses();
            await this.cleanupTempDirectories();
            
            const basePauseTime = isNetworkError ? 5000 : 3000;
            const progressivePause = basePauseTime + (this.retryCount * 2000);
            this.logger.info(`[${this.sessionId}] ⏳ Pausando ${progressivePause/1000}s para estabilizar (intento ${this.retryCount})...`);
            await new Promise(resolve => setTimeout(resolve, progressivePause));
            
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (destroyError) {
                    this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${destroyError.message}`);
                }
            }
            
            this.initializeClient();
            
            const initTimeout = 30000 + (this.retryCount * 10000);
            const initPromise = this.client.initialize();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Initialization timeout')), initTimeout)
            );
            
            await Promise.race([initPromise, timeoutPromise]);
            this.logger.info(`[${this.sessionId}] ✅ Recuperación exitosa después de ${isNetworkError ? 'error de red' : 'error de protocolo'} (intento ${this.retryCount})`);
            return true;
            
        } catch (recoveryError) {
            this.logger.error(`[${this.sessionId}] ❌ Error en recuperación (intento ${this.retryCount}): ${recoveryError.message}`);
            
            if (this.retryCount >= this.maxRetries) {
                this.logger.warn(`[${this.sessionId}] 🚨 Intentando estrategia de fallback...`);
                return await this.fallbackStrategy();
            }
            
            return false;
        }
    }

    async killRelatedProcesses() {
        const { exec } = require('child_process');
        exec(`pkill -9 -f "chromium.*${this.sessionId}"`, (err) => {
            if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chromium terminados (force)`);
        });
        exec(`pkill -9 -f "chrome.*${this.sessionId}"`, (err) => {
            if (!err) this.logger.debug(`[${this.sessionId}] Procesos Chrome terminados (force)`);
        });
    }

    async cleanupTempDirectories() {
        const tempDir = `/tmp/chrome-profile-${this.sessionId}`;
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                this.logger.debug(`[${this.sessionId}] Directorio temporal eliminado`);
            } catch (err) {
                this.logger.debug(`[${this.sessionId}] Error eliminando directorio temporal: ${err.message}`);
            }
        }
    }

    async fallbackStrategy() {
        this.logger.warn(`[${this.sessionId}] 🚨 Ejecutando estrategia de fallback...`);
        
        try {
            this.logger.info(`[${this.sessionId}] 🔧 Recreando cliente con configuración mínima...`);
            
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (e) {}
            }
            
            await this.killRelatedProcesses();
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            this.initializeClientMinimal();
            
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
        
        const clientOptions = {
            authStrategy: new LocalAuth({
                clientId: this.sessionId,
                dataPath: path.resolve(__dirname, `.wwebjs_auth`)
            }),
            puppeteer: {
                args: [
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

    // ========================================
    // LIMPIEZA Y DESTRUCCIÓN
    // ========================================

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
            
            await this.killRelatedProcesses();
            await this.cleanupAuthDirectory();
            await this.cleanupAllTempDirectories();
            
            if (global.gc) {
                global.gc();
            }
            
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error en limpieza forzada: ${error.message}`);
        }
    }

    async cleanupAuthDirectory() {
        const authSessionDir = path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}`);
        if (fs.existsSync(authSessionDir)) {
            try {
                fs.rmSync(authSessionDir, { recursive: true, force: true });
                this.logger.info(`[${this.sessionId}] ✅ Carpeta de autenticación eliminada: ${authSessionDir}`);
            } catch (err) {
                this.logger.error(`[${this.sessionId}] ❌ Error eliminando carpeta de autenticación: ${err.message}`);
            }
        }
    }

    async cleanupAllTempDirectories() {
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
    }

    async destroySession() {
        this.logger.info(`[${this.sessionId}] 🗑️ Destruyendo sesión completamente...`);
        
        try {
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (err) {
                    this.logger.debug(`[${this.sessionId}] Error destruyendo cliente: ${err.message}`);
                }
            }
            
            await this.killRelatedProcesses();
            await this.cleanupAuthDirectory();
            await this.cleanupAllTempDirectories();
            await this.cleanupLockFiles();
            this.resetSessionState();
            
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

    async cleanupLockFiles() {
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
    }

    resetSessionState() {
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
    }

    // ========================================
    // MÉTODOS PÚBLICOS
    // ========================================

    async regenerateQR() {
        if (!this.client) {
            throw new Error('Cliente no disponible');
        }
        
        this.logger.info(`[${this.sessionId}] 🔄 Regenerando QR...`);
        this.qrData = null;
        this.qrGeneratedAt = null;
        
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
            await this.destroySession();
            
            this.retryCount = 0;
            this.maxRetries = 3;
            this.lastRetryTime = null;
            
            this.initializeClient();
            return await this.initialize();
        } catch (error) {
            this.logger.error(`[${this.sessionId}] ❌ Error reiniciando sesión: ${error.message}`);
            throw error;
        }
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
            authenticatedAt: this.authenticatedAt,
            readyAt: this.readyAt,
            authToReadyDuration: this.authToReadyDuration,
            waitingForReady: this.status === 'authenticated' && !this.isReady,
            currentWaitTime: this.authenticatedAt && !this.isReady ? 
                Math.round((Date.now() - this.authenticatedAt) / 1000) : null,
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            lastRetryTime: this.lastRetryTime,
            retryStatus: this.retryCount > 0 ? 
                `${this.retryCount}/${this.maxRetries} reintentos` : 'Sin reintentos'
        };
    }
}

module.exports = { WhatsappWebSession }; 
