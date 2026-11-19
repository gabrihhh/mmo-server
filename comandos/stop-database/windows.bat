<# :
@echo off
rem ============================================================================================
rem  Arquivo duplo: este trecho e o cmd (clique duplo funciona). Ele pede admin quando precisa
rem  e roda o resto deste mesmo arquivo no PowerShell. A explicacao do comando vem logo depois deste trecho.
rem ============================================================================================
setlocal
set "MMO_ADMIN=1"
if not "%MMO_ADMIN%"=="1" goto run
net session >nul 2>&1
if not errorlevel 1 goto run
echo Pedindo permissao de administrador...
if "%~1"=="" goto elevate_noargs
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
exit /b
:elevate_noargs
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b
:run
chcp 65001 >nul
set "MMO_SELF=%~f0"
set "MMO_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:MMO_SELF, [Text.Encoding]::UTF8))"
set "MMO_CODE=%errorlevel%"
if "%MMO_NO_PAUSE%"=="1" exit /b %MMO_CODE%
if "%MMO_ADMIN%"=="1" pause & exit /b %MMO_CODE%
if not "%MMO_CODE%"=="0" pause
exit /b %MMO_CODE%
#>
# Desliga o MongoDB local. Ver mmo-docs [INFRA-03] e [PAD-05].
# Uso: clique duplo em comandos\stop-database\windows.bat (pede admin), ou no terminal: comandos\stop-database\windows.bat
#   - Serviço Windows "MongoDB": para o serviço.
#   - Docker: para o container mmo-mongo (dados continuam no volume mongo-data).
# Nada é apagado. Com o banco desligado o servidor do jogo não funciona.
$ErrorActionPreference = 'Stop'
## Pasta deste arquivo (o trecho cmd passa o caminho em MMO_SELF).
$here = Split-Path -Parent $env:MMO_SELF
Set-Location (Join-Path $here '..\..')

$service = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
$container = ''
if (Get-Command docker -ErrorAction SilentlyContinue) { $container = (docker ps -q --filter 'name=^mmo-mongo$' 2>$null) }

if ($service -and $service.Status -eq 'Running') {
    Write-Host 'Desligando o MongoDB (serviço do Windows)...'
    Stop-Service MongoDB
    Write-Host 'MongoDB desligado.'
} elseif ($container) {
    Write-Host 'Desligando o MongoDB (Docker)...'
    docker compose stop mongo | Out-Null
    Write-Host 'MongoDB desligado (dados guardados no volume mongo-data).'
} else {
    Write-Host 'O MongoDB já está desligado.'
}
