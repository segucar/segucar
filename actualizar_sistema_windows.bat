@echo off
title Actualizar SEGUCar - Oficina
echo ===================================================
echo   DESCARGANDO ACTUALIZACIONES NUEVAS DE SEGUCar
echo ===================================================
echo.
cd /d "%~dp0"
git pull
echo.
echo ¡Actualización completada! Podes cerrar esta ventana.
pause
