@echo off
title Apaaman server
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Apaaman for the first time...
  call npm install
)
call npm start
pause
