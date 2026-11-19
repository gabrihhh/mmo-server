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
# Prepara uma máquina Windows 10/11 para rodar o servidor do jogo (rodar uma vez; pode repetir sem medo).
# Ver mmo-docs [IA-03], [INFRA-03] e [PAD-05].
#
# Uso: clique duplo em comandos\setup-windows.bat (pede admin), ou no terminal: comandos\setup-windows.bat
#   1. Git (winget Git.Git) — traz também o Git Bash, usado pelos scripts .sh do cliente
#   2. Node 22 (nvm, se houver; senão winget OpenJS.NodeJS.22)
#   3. dependências do projeto (npm install)
#   4. MongoDB 8.0 nativo como serviço do Windows (winget MongoDB.Server).
#      Sem Docker de propósito: muitas máquinas não têm virtualização ligada (WSL2/Docker não rodam).
#   5. liga o MongoDB e confere que responde
# Depois: comandos\start-server\windows.bat
$ErrorActionPreference = 'Stop'
## Pasta deste arquivo (o trecho cmd passa o caminho em MMO_SELF).
$here = Split-Path -Parent $env:MMO_SELF
Set-Location (Join-Path $here '..')

$MongoVersion = '8.0.23'

function Write-Step([string]$text) { Write-Host ''; Write-Host "=== $text ===" }

## Relê o PATH do Windows (programas recém-instalados aparecem sem reabrir o terminal).
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

## Instala um pacote do winget pelo id exato (com versão opcional).
function Install-WingetPackage([string]$id, [string]$version = '') {
    $wingetArgs = @('install', '--id', $id, '--exact', '--accept-source-agreements', '--accept-package-agreements')
    if ($version) { $wingetArgs += @('--version', $version) }
    winget @wingetArgs
    if ($LASTEXITCODE -ne 0) { throw "winget não conseguiu instalar $id (código $LASTEXITCODE)." }
    Update-SessionPath
}

## Versão principal do Node no PATH (0 se não houver Node).
function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    return [int](node -p "process.versions.node.split('.')[0]")
}

## True se algo responde na porta do MongoDB.
function Test-MongoUp {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', 27017)
        return ($task.Wait(500) -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

## Roda outro comandos\...\windows.bat sem pausar no fim; devolve o código de saída.
function Invoke-Comando([string]$bat) {
    $env:MMO_NO_PAUSE = '1'
    & cmd.exe /c "`"$bat`"" | Out-Host
    $code = $LASTEXITCODE
    Remove-Item Env:MMO_NO_PAUSE
    return $code
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host 'winget não encontrado. Instale o "App Installer" pela Microsoft Store e rode de novo.'
    exit 1
}

# --- 1. Git ---
Write-Step '1/5 Git'
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host (git --version) } else { Install-WingetPackage 'Git.Git' }

# --- 2. Node 22 ---
Write-Step '2/5 Node 22'
if ((Get-NodeMajor) -lt 22) {
    if (Get-Command nvm -ErrorAction SilentlyContinue) {
        nvm install 22
        nvm use 22
        Update-SessionPath
    } else {
        Install-WingetPackage 'OpenJS.NodeJS.22'
    }
}
if ((Get-NodeMajor) -lt 22) {
    Write-Host 'O Node 22 foi instalado mas não aparece aqui. Feche esta janela e rode o setup outra vez.'
    exit 1
}
## npm de verdade (exe/cmd, primeiro no PATH). Não usar npm.cmd fixo: com o nvm v2 o npm.exe do shim é que respeita o .nvmrc.
$npm = (Get-Command npm -CommandType Application | Select-Object -First 1).Source
Write-Host "Node $(node -v), npm $(& $npm -v)"

# --- 3. Dependências ---
Write-Step '3/5 Dependências (npm install)'
& $npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 4. MongoDB ---
Write-Step "4/5 MongoDB $MongoVersion"
if (Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue) {
    Write-Host 'Serviço MongoDB já instalado.'
} elseif (Test-MongoUp) {
    Write-Host 'Já existe um MongoDB respondendo em 127.0.0.1:27017 (Docker ou outro). Mantendo ele.'
} else {
    Install-WingetPackage 'MongoDB.Server' $MongoVersion
}

# --- 5. Liga e confere ---
Write-Step '5/5 Ligando o MongoDB'
$dbCode = Invoke-Comando (Join-Path $here 'start-database\windows.bat')
if ($dbCode -ne 0) { exit $dbCode }

Write-Host ''
Write-Host 'Pronto! Para iniciar o servidor: clique duplo em comandos\start-server\windows.bat'
