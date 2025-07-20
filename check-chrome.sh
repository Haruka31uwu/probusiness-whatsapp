#!/bin/bash

echo "🔍 Verificando opciones de Chrome/Chromium en tu sistema..."
echo ""

# Verificar distribución
if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "📋 Sistema: $NAME"
else
    echo "📋 Sistema: Desconocido"
fi

echo ""

# Función para verificar ejecutable
check_executable() {
    local path=$1
    local name=$2
    
    if [ -f "$path" ] && [ -x "$path" ]; then
        local version=$($path --version 2>/dev/null | head -n1 || echo "Versión desconocida")
        echo "✅ $name: $path"
        echo "   Versión: $version"
        return 0
    else
        echo "❌ $name: No encontrado en $path"
        return 1
    fi
}

echo "🔍 Buscando navegadores instalados:"
echo ""

# Lista de ejecutables a verificar
found_any=false

# Google Chrome Estable
if check_executable "/usr/bin/google-chrome-stable" "Google Chrome Estable"; then
    found_any=true
    RECOMMENDED_PATH="/usr/bin/google-chrome-stable"
    RECOMMENDED_NAME="Google Chrome Estable"
fi

echo ""

# Google Chrome
if check_executable "/usr/bin/google-chrome" "Google Chrome"; then
    found_any=true
    if [ -z "$RECOMMENDED_PATH" ]; then
        RECOMMENDED_PATH="/usr/bin/google-chrome"
        RECOMMENDED_NAME="Google Chrome"
    fi
fi

echo ""

# Chromium Browser
if check_executable "/usr/bin/chromium-browser" "Chromium Browser"; then
    found_any=true
    if [ -z "$RECOMMENDED_PATH" ]; then
        RECOMMENDED_PATH="/usr/bin/chromium-browser"
        RECOMMENDED_NAME="Chromium Browser"
    fi
fi

echo ""

# Chromium
if check_executable "/usr/bin/chromium" "Chromium"; then
    found_any=true
    if [ -z "$RECOMMENDED_PATH" ]; then
        RECOMMENDED_PATH="/usr/bin/chromium"
        RECOMMENDED_NAME="Chromium"
    fi
fi

echo ""

# Verificar Snap
if command -v snap &> /dev/null && snap list chromium &> /dev/null; then
    echo "✅ Chromium (Snap): /snap/bin/chromium"
    found_any=true
    if [ -z "$RECOMMENDED_PATH" ]; then
        RECOMMENDED_PATH="/snap/bin/chromium"
        RECOMMENDED_NAME="Chromium (Snap)"
    fi
else
    echo "❌ Chromium (Snap): No instalado"
fi

echo ""
echo "📊 RESUMEN:"
echo ""

if [ "$found_any" = true ]; then
    echo "🎉 ¡Perfecto! Tienes navegadores disponibles."
    echo ""
    echo "🚀 RECOMENDACIÓN:"
    echo "   Usar: $RECOMMENDED_NAME"
    echo "   Ruta: $RECOMMENDED_PATH"
    echo ""
    echo "📝 Para configurar tu aplicación, ejecuta:"
    echo "   export PUPPETEER_EXECUTABLE_PATH=\"$RECOMMENDED_PATH\""
    echo "   export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true"
    echo ""
    echo "💾 O agrega estas líneas a tu .env:"
    echo "   PUPPETEER_EXECUTABLE_PATH=$RECOMMENDED_PATH"
    echo "   PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true"
else
    echo "⚠️  No se encontraron navegadores instalados."
    echo ""
    echo "📦 OPCIONES DE INSTALACIÓN:"
    echo ""
    echo "1️⃣  Instalar Chromium (recomendado para servidores):"
    if command -v apt-get &> /dev/null; then
        echo "   sudo apt-get update && sudo apt-get install -y chromium-browser"
    elif command -v yum &> /dev/null; then
        echo "   sudo yum install -y chromium"
    elif command -v pacman &> /dev/null; then
        echo "   sudo pacman -S chromium"
    else
        echo "   (usar el gestor de paquetes de tu distribución)"
    fi
    echo ""
    echo "2️⃣  Instalar Google Chrome:"
    if command -v apt-get &> /dev/null; then
        echo "   wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -"
        echo "   sudo sh -c 'echo \"deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main\" >> /etc/apt/sources.list.d/google-chrome.list'"
        echo "   sudo apt-get update && sudo apt-get install -y google-chrome-stable"
    else
        echo "   Descargar desde: https://www.google.com/chrome/"
    fi
    echo ""
    echo "3️⃣  Dejar que Puppeteer descargue automáticamente:"
    echo "   unset PUPPETEER_SKIP_CHROMIUM_DOWNLOAD"
    echo "   npm install"
    echo "   (Descargará ~130MB automáticamente)"
fi

echo ""
echo "🔧 Verificar después de la instalación:"
echo "   bash $0"
echo ""

# Verificar dependencias adicionales
echo "🔍 Verificando dependencias del sistema..."
missing_deps=()

deps_to_check=(
    "xvfb"
    "fonts-liberation"
    "libgtk-3-0"
    "libnss3"
    "libxss1"
)

for dep in "${deps_to_check[@]}"; do
    if ! dpkg -l | grep -q "^ii.*$dep" 2>/dev/null && ! rpm -q "$dep" 2>/dev/null; then
        missing_deps+=("$dep")
    fi
done

if [ ${#missing_deps[@]} -gt 0 ]; then
    echo "⚠️  Dependencias faltantes: ${missing_deps[*]}"
    echo "💡 Instalar con: sudo apt-get install -y ${missing_deps[*]}"
else
    echo "✅ Todas las dependencias principales están instaladas"
fi

echo ""
echo "✨ Verificación completada!" 