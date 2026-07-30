@echo off
title Servidor SEGUCar - Oficina
echo ===================================================
echo   INICIANDO SERVIDOR SEGUCar (MODO OFICINA)
echo ===================================================
echo.
cd /d "%~dp0"
node server.js
pause
