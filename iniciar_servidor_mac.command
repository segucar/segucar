#!/bin/bash
cd "$(dirname "$0")"
echo "==================================================="
echo "  INICIANDO SERVIDOR SEGUCar (MODO OFICINA)"
echo "==================================================="
echo ""

if [ ! -d "node_modules" ]; then
    echo "Instalando librerías por primera vez, por favor espere..."
    echo ""
    npm install
    echo ""
    echo "Librerías instaladas correctamente."
    echo ""
fi

node server.js
