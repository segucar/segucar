@echo off
title Servidor SEGUCar - Oficina
echo ===================================================
echo   INICIANDO SERVIDOR SEGUCar (MODO OFICINA)
echo ===================================================
echo.
cd /d "%~dp0"

if not exist node_modules (
    echo INSTALANDO LIBRERIAS POR PRIMERA VEZ... ESTO TARDARA UNOS SEGUNDOS.
    echo.
    call npm install
    echo.
    echo LIBRERIAS INSTALADAS CORRECTAMENTE.
    echo.
)

node server.js
pause
