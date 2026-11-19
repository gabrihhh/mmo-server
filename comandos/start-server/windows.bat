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
# Sobe tudo que o servidor do jogo precisa e inicia o servidor. Ver mmo-docs [INFRA-05] e [PAD-05].
#
# Uso: clique duplo em comandos\start-server\windows.bat (pede admin, por causa do serviço do MongoDB),
#      ou no terminal: comandos\start-server\windows.bat
#   1. Node 22 (troca com o nvm, se houver)
#   2. npm install (só se faltar node_modules)
#   3. MongoDB local (comandos\start-database\windows.bat) e espera ele responder
#   4. avisa se não há pacote do jogo publicado (o celular não teria o que baixar)
#   5. mostra o endereço na rede local e roda `npm start` (recarrega sozinho ao mudar o código)
# Ctrl+C para parar o servidor (o MongoDB continua rodando; desligar: comandos\stop-database\windows.bat).
# Primeira vez na máquina: comandos\setup-windows.bat
$ErrorActionPreference = 'Stop'
## Pasta deste arquivo (o trecho cmd passa o caminho em MMO_SELF).
$here = Split-Path -Parent $env:MMO_SELF
Set-Location (Join-Path $here '..\..')

## Roda outro comandos\...\windows.bat sem pausar no fim; devolve o código de saída.
function Invoke-Comando([string]$bat) {
    $env:MMO_NO_PAUSE = '1'
    & cmd.exe /c "`"$bat`"" | Out-Host
    $code = $LASTEXITCODE
    Remove-Item Env:MMO_NO_PAUSE
    return $code
}
## Versão principal do Node no PATH (0 se não houver Node).
function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    return [int](node -p "process.versions.node.split('.')[0]")
}

# --- 1. Node 22 ---
if ((Get-NodeMajor) -lt 22 -and (Get-Command nvm -ErrorAction SilentlyContinue)) {
    nvm use 22 | Out-Null
}
if ((Get-NodeMajor) -lt 22) {
    Write-Host 'Precisa do Node 22. Rode: comandos\setup-windows.bat'
    exit 1
}
## npm de verdade (exe/cmd, primeiro no PATH). Não usar npm.cmd fixo: com o nvm v2 o npm.exe do shim é que respeita o .nvmrc.
$npm = (Get-Command npm -CommandType Application | Select-Object -First 1).Source

# --- 2. Dependências ---
if (-not (Test-Path 'node_modules')) {
    Write-Host 'Instalando dependências (npm install)...'
    & $npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# --- 3. MongoDB ---
$dbCode = Invoke-Comando (Join-Path $here '..\start-database\windows.bat')
if ($dbCode -ne 0) { exit $dbCode }

# --- 4. Pacote do jogo para o celular ---
$manifest = 'updates\android\manifest.json'
if (-not (Test-Path $manifest)) {
    Write-Host "AVISO: nenhum pacote Android publicado. O APK vai mostrar 'Sem conexão'/erro ao atualizar."
    Write-Host '       Publique com: ..\mmo-client\tools\publish_update.sh android'
} else {
    $version = (Get-Content $manifest -Raw | ConvertFrom-Json).version
    Write-Host "Pacote Android publicado: versão $version"
}

# --- 5. Endereço e servidor ---
$port = if ($env:PORT) { $env:PORT } else { '2567' }
$lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host 'Servidor do jogo:'
Write-Host "  neste PC:      ws://localhost:$port"
foreach ($ip in $lanIps) {
    Write-Host "  rede local:    ws://${ip}:$port"
}
Write-Host '  (o APK usa o IP configurado em mmo-client/project.godot: server_url.android)'
Write-Host ''
& $npm start
exit $LASTEXITCODE
