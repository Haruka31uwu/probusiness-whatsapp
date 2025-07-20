// Script de prueba simple para el sistema de multi-sesiones
const whatsappSessionManager = require('./WhatsappSessionManager');
const { v4: uuidv4 } = require('uuid');

console.log('🧪 Iniciando prueba del sistema de multi-sesiones...\n');

// Crear 2 sesiones para probar conflictos
const sessionId1 = uuidv4();
const sessionId2 = uuidv4();

console.log(`📱 Creando sesión 1: ${sessionId1.substring(0, 8)}...`);
console.log(`📱 Creando sesión 2: ${sessionId2.substring(0, 8)}...`);

// Callbacks para QR
const onQR = (sessionId, qrData) => {
    console.log(`✅ [${sessionId.substring(0, 8)}] QR generado - ${qrData.length} bytes`);
};

// Callbacks para ready
const onReady = (sessionId, instance) => {
    console.log(`🚀 [${sessionId.substring(0, 8)}] Sesión lista - ${instance.phoneNumber || 'Sin número'}`);
};

try {
    // Crear sesiones simultáneamente (esto antes causaba problemas)
    console.log('\n🔄 Creando sesiones SIMULTÁNEAMENTE...');
    
    const session1 = whatsappSessionManager.createWAClient(sessionId1, onQR, onReady);
    const session2 = whatsappSessionManager.createWAClient(sessionId2, onQR, onReady);
    
    console.log('✅ Ambas sesiones creadas sin conflictos!');
    
    // Mostrar estadísticas cada 5 segundos
    setInterval(() => {
        const stats = whatsappSessionManager.getStats();
        const sessions = whatsappSessionManager.getAllSessions();
        
        console.log('\n📊 ESTADÍSTICAS:');
        console.log(`   Total: ${stats.totalSessions}`);
        console.log(`   Listas: ${stats.readySessions}`);
        console.log(`   Con QR: ${stats.sessionsWithQR}`);
        console.log(`   Cargando: ${stats.loadingSessions}`);
        
        console.log('\n📋 SESIONES:');
        sessions.forEach(session => {
            console.log(`   [${session.sessionId.substring(0, 8)}] ${session.status} - QR: ${session.qrAvailable ? '✅' : '❌'}`);
        });
        console.log('---');
        
    }, 5000);
    
    // Limpiar después de 2 minutos
    setTimeout(async () => {
        console.log('\n🧹 Limpiando sesiones de prueba...');
        await whatsappSessionManager.cleanup();
        console.log('✅ Limpieza completada');
        process.exit(0);
    }, 120000);
    
} catch (error) {
    console.error('❌ Error en la prueba:', error.message);
    process.exit(1);
}

// Manejar Ctrl+C
process.on('SIGINT', async () => {
    console.log('\n🛑 Cancelando prueba...');
    await whatsappSessionManager.cleanup();
    process.exit(0);
}); 