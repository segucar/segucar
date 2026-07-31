@echo off
title Actualizar SEGUCar - Oficina
echo ===================================================
echo   DESCARGANDO ACTUALIZACIONES NUEVAS DE SEGUCar
echo ===================================================
echo.
cd /d "%~dp0"

echo [1/3] Bajando cambios de GitHub...
git pull
echo.

echo [2/3] Parando servidor anterior si estaba corriendo...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo.

echo [3/3] Iniciando servidor actualizado...
start "GestionSeguro Server" /MIN cmd /c "node server.js"
timeout /t 3 /nobreak >nul

echo.
echo ===================================================
echo  Actualizacion completada. Servidor reiniciado.
echo  Abre el navegador en: http://localhost:3005
echo ===================================================
echo.
pause
