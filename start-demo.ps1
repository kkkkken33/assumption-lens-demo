param([ValidateSet('codex', 'deepseek')][string]$Provider = 'codex', [switch]$ResetApiKey)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot

$demoPort = $null
$shareFile = Join-Path $env:TEMP "assumption-lens-$PID-share-url.txt"
$serverLog = Join-Path $env:TEMP "assumption-lens-$PID-server.log"
$serverErrorLog = Join-Path $env:TEMP "assumption-lens-$PID-server-error.log"
$tunnelLog = Join-Path $env:TEMP "assumption-lens-$PID-tunnel.log"
$tunnelErrorLog = Join-Path $env:TEMP "assumption-lens-$PID-tunnel-error.log"
$keyFile = Join-Path $PSScriptRoot '.deepseek-key.dpapi'
$serverProcess = $null

function Find-DemoPort {
    for ($candidate = 4173; $candidate -le 4193; $candidate++) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $candidate)
        try {
            $listener.Start()
            return $candidate
        } catch {
            continue
        } finally {
            $listener.Stop()
        }
    }
    throw '没有可用的本地端口（4173–4193）。请关闭旧的演示窗口后重试。'
}

function Find-AppxExecutable($packageName, $relativePath) {
    $packages = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue | Sort-Object Version -Descending
    foreach ($package in $packages) {
        $candidate = Join-Path $package.InstallLocation $relativePath
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Find-Node {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $common = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path -LiteralPath $common) { return $common }
    $bundled = Find-AppxExecutable '*CodexPrimaryRuntime*' 'dependencies\node\bin\node.exe'
    if ($bundled) { return $bundled }
    throw 'Node.js was not found. Install Node.js 18+ and try again.'
}

function Find-Codex {
    $command = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bundled = Find-AppxExecutable 'OpenAI.Codex' 'app\resources\codex.exe'
    if ($bundled) { return $bundled }
    throw 'Codex CLI was not found. Open the Codex desktop app and try again.'
}

function Get-DeepSeekKey {
    $secure = $null
    if (Test-Path -LiteralPath $keyFile) {
        try {
            $cipher = Get-Content -LiteralPath $keyFile -Raw -Encoding UTF8
            $secure = ConvertTo-SecureString -String $cipher -ErrorAction Stop
        } catch {
            Write-Host '本机保存的密钥无法解密，请重新输入。' -ForegroundColor Yellow
        }
    }
    if (-not $secure) {
        Write-Host '首次启动 API 版：请输入老师提供的 DeepSeek API Key（输入内容不会显示）。'
        $secure = Read-Host 'DeepSeek API Key' -AsSecureString
        if (-not $secure -or $secure.Length -lt 8) { throw 'API Key 为空或过短。' }
        $cipher = ConvertFrom-SecureString -SecureString $secure
        [System.IO.File]::WriteAllText($keyFile, $cipher, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '密钥已使用当前 Windows 用户加密保存，下次启动无需再次输入。'
    }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Find-Cloudflared {
    $local = Join-Path $PSScriptRoot 'tools\cloudflared.exe'
    if (Test-Path -LiteralPath $local) {
        if ((Get-Item -LiteralPath $local).Length -gt 1000000) { return $local }
        throw 'The local Cloudflare helper is incomplete.'
    }
    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'tools') -Force | Out-Null
    Write-Host 'Downloading Cloudflare tunnel helper from the official GitHub release (first launch only)...'
    $source = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    $download = "$local.download"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --silent --show-error --location --continue-at - --retry 3 --output $download $source
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare helper download failed.' }
    } else {
        Invoke-WebRequest -Uri $source -OutFile $download -UseBasicParsing -TimeoutSec 120
    }
    if (-not (Test-Path -LiteralPath $download) -or (Get-Item -LiteralPath $download).Length -lt 1000000) {
        throw 'Cloudflare helper download was incomplete.'
    }
    Move-Item -LiteralPath $download -Destination $local
    return $local
}

function Copy-Link($link) {
    for ($i = 0; $i -lt 3; $i++) {
        try { Set-Clipboard -Value $link -ErrorAction Stop; return $true }
        catch { Start-Sleep -Milliseconds 250 }
    }
    return $false
}

try {
    $nodeExe = Find-Node
    if ($Provider -eq 'codex') { $codexExe = Find-Codex }
    else {
        if ($ResetApiKey -and (Test-Path -LiteralPath $keyFile)) { Remove-Item -LiteralPath $keyFile -Force }
        $env:DEEPSEEK_API_KEY = Get-DeepSeekKey
    }
    $demoPort = Find-DemoPort
    $accessCode = ([guid]::NewGuid().ToString('N')).Substring(0, 12)
    $sessionId = [guid]::NewGuid().ToString('N')
    if (Test-Path -LiteralPath $shareFile) { Remove-Item -LiteralPath $shareFile -Force }
    $env:PORT = [string]$demoPort
    $env:HOST = '0.0.0.0'
    $env:DEMO_ACCESS_CODE = $accessCode
    $env:DEMO_SESSION_ID = $sessionId
    $env:DEMO_PROVIDER = $Provider
    if ($Provider -eq 'codex') { $env:CODEX_BIN = $codexExe }
    $env:LAUNCHER_PID = [string]$PID
    $env:SHARE_URL_FILE = $shareFile

    Write-Host 'Starting Assumption Lens...'
    $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog
    $health = $null
    $portConflict = $false
    for ($i = 0; $i -lt 30; $i++) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { throw "The demo server stopped. See $serverErrorLog" }
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$demoPort/api/health" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $candidate = $response.Content | ConvertFrom-Json
                if ($candidate.sessionId -ne $sessionId) {
                    $portConflict = $true
                    break
                }
                $health = $candidate
                break
            }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($portConflict) { throw "端口 $demoPort 被其他服务占用。请再次双击启动。" }
    if (-not $health) { throw "The demo server did not start. See $serverErrorLog" }

    $localUrl = "http://localhost:$demoPort/?code=$accessCode"
    Start-Process $localUrl
    Write-Host "Local page: $localUrl"
    if ($health.lanUrl) {
        $lanShare = "$($health.lanUrl)?code=$accessCode"
        $copied = Copy-Link $lanShare
        Write-Host "Local-network link: $lanShare" -ForegroundColor Cyan
        if ($copied) { Write-Host 'Link copied to clipboard.' }
    }

    try {
        $env:CLOUDFLARED_BIN = Find-Cloudflared
        $tunnelProcess = Start-Process -FilePath $nodeExe -ArgumentList 'tunnel-supervisor.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErrorLog
        Write-Host 'Creating a temporary public link...'
        $publicUrl = $null
        for ($i = 0; $i -lt 90; $i++) {
            if ($tunnelProcess.HasExited) { break }
            if (Test-Path -LiteralPath $shareFile) {
                $publicUrl = ([string](Get-Content -LiteralPath $shareFile -Raw -ErrorAction SilentlyContinue)).Trim()
                if ($publicUrl -match '^https://[a-zA-Z0-9-]+\.trycloudflare\.com$') { break }
            }
            Start-Sleep -Seconds 1
        }
        if ($publicUrl) {
            $publicShare = "$publicUrl/?code=$accessCode"
            $copied = Copy-Link $publicShare
            Write-Host ''
            Write-Host 'Public link (also shown on the page):' -ForegroundColor Green
            Write-Host $publicShare -ForegroundColor Cyan
            if ($copied) { Write-Host 'Link copied to clipboard.' }
        } else {
            Write-Host 'Public link unavailable. Local-network sharing still works.' -ForegroundColor Yellow
            Write-Host "Tunnel log: $tunnelErrorLog"
        }
    } catch {
        Write-Host "Public link unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host 'Local-network sharing still works.'
    }

    Write-Host ''
    Write-Host 'Keep this window open while others use the demo. Closing it stops access.'
    Read-Host 'Press Enter to stop the demo' | Out-Null
} catch {
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close' | Out-Null
    exit 1
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $shareFile) { Remove-Item -LiteralPath $shareFile -Force -ErrorAction SilentlyContinue }
}
