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
# Liga o MongoDB local e espera ele responder em 127.0.0.1:27017. Ver mmo-docs [INFRA-03] e [PAD-05].
# Uso: clique duplo em comandos\start-database\windows.bat (pede admin), ou no terminal: comandos\start-database\windows.bat
#   - Serviço Windows "MongoDB" (instalado pelo comandos\setup-windows.bat): liga o serviço.
#   - Sem o serviço e com Docker: sobe o container mmo-mongo (docker-compose.yml).
# Ligar/desligar não apaga nada. Desligar: comandos\stop-database\windows.bat
$ErrorActionPreference = 'Stop'
## Pasta deste arquivo (o trecho cmd passa o caminho em MMO_SELF).
$here = Split-Path -Parent $env:MMO_SELF
Set-Location (Join-Path $here '..\..')

## True se algo responde na porta do MongoDB (sem precisar do mongosh).
function Test-MongoUp {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', 27017)
        return ($task.Wait(500) -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

if (Test-MongoUp) {
    Write-Host 'MongoDB já está ligado: mongodb://127.0.0.1:27017'
    exit 0
}

$service = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
if ($service) {
    Write-Host 'Ligando o MongoDB (serviço do Windows)...'
    Start-Service MongoDB
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host 'Ligando o MongoDB (Docker, container mmo-mongo)...'
    docker compose up -d mongo | Out-Null
} else {
    Write-Host 'Não achei o serviço MongoDB nem o Docker. Rode primeiro: comandos\setup-windows.bat'
    exit 1
}

for ($i = 0; $i -lt 30; $i++) {
    if (Test-MongoUp) {
        Write-Host 'MongoDB ligado: mongodb://127.0.0.1:27017'
        exit 0
    }
    Start-Sleep -Seconds 1
}
Write-Host 'O MongoDB não respondeu em 30 s. Veja o serviço "MongoDB" em services.msc (ou: docker logs mmo-mongo).'
exit 1
