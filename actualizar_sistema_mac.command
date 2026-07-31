#!/bin/bash
cd "$(dirname "$0")"
echo "==================================================="
echo "  DESCARGANDO ACTUALIZACIONES NUEVAS DE SEGUCar"
echo "==================================================="
echo ""

echo "[1/3] Bajando cambios de GitHub..."
git pull
echo ""

echo "[2/3] Parando servidor anterior si estaba corriendo..."
pkill -f "node server.js" 2>/dev/null || true
sleep 2
echo ""

echo "[3/3] Iniciando servidor actualizado..."
nohup node server.js > /tmp/segucar_server.log 2>&1 &
sleep 3

echo ""
echo "==================================================="
echo " Actualizacion completada. Servidor reiniciado."
echo " Abre el navegador en: http://localhost:3005"
echo "==================================================="
echo ""
