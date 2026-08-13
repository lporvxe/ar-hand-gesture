# Minimal static HTTP server for the AR Hands Filter project.
# No external dependencies: works with Windows PowerShell 5.1+.

param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-FreePort {
    for ($p = 8000; $p -le 8999; $p++) {
        $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        try {
            $tcp.Start()
            $tcp.Stop()
            return $p
        } catch {
            try { $tcp.Stop() } catch {}
        }
    }
    return $null
}

function Get-MimeType($ext) {
    switch ($ext.ToLower()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.css'  { return 'text/css; charset=utf-8' }
        '.js'   { return 'application/javascript; charset=utf-8' }
        '.mjs'  { return 'application/javascript; charset=utf-8' }
        '.json' { return 'application/json; charset=utf-8' }
        '.task' { return 'application/octet-stream' }
        '.txt'  { return 'text/plain; charset=utf-8' }
        '.md'   { return 'text/markdown; charset=utf-8' }
        '.svg'  { return 'image/svg+xml; charset=utf-8' }
        '.wasm' { return 'application/wasm' }
        '.bin'  { return 'application/octet-stream' }
        '.data' { return 'application/octet-stream' }
        '.tflite' { return 'application/octet-stream' }
        '.png'  { return 'image/png' }
        '.jpg'  { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.gif'  { return 'image/gif' }
        '.webp' { return 'image/webp' }
        '.ico'  { return 'image/x-icon' }
        '.woff' { return 'font/woff' }
        '.woff2' { return 'font/woff2' }
        default { return 'application/octet-stream' }
    }
}

function Send-HttpResponse($client, $statusLine, $contentType, $bytes) {
    try {
        $stream = $client.GetStream()
        $head = "HTTP/1.1 $statusLine`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`nAccess-Control-Allow-Origin: *`r`n`r`n"
        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        if ($bytes.Length -gt 0) {
            $stream.Write($bytes, 0, $bytes.Length)
        }
        $stream.Flush()
    } catch {
        # client closed the connection; nothing to do
    } finally {
        try { $client.Close() } catch {}
    }
}

function Handle-Client($client) {
    try {
        $stream = $client.GetStream()
        $stream.ReadTimeout = 5000
        $buffer = New-Object byte[] 8192
        $sb = New-Object System.Text.StringBuilder
        $headerEnd = -1
        while ($true) {
            $n = $stream.Read($buffer, 0, $buffer.Length)
            if ($n -le 0) { break }
            [void]$sb.Append([System.Text.Encoding]::ASCII.GetString($buffer, 0, $n))
            $headerEnd = $sb.ToString().IndexOf("`r`n`r`n")
            if ($headerEnd -ge 0) { break }
            if ($sb.Length -gt 65536) { break }
        }
        if ($headerEnd -lt 0) {
            Send-HttpResponse $client '400 Bad Request' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Bad Request'))
            return
        }

        $requestText = $sb.ToString()
        $firstLine = ($requestText -split "`r`n")[0]
        $parts = $firstLine -split ' '
        if ($parts.Count -lt 2) {
            Send-HttpResponse $client '400 Bad Request' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Bad Request'))
            return
        }

        $rawPath = $parts[1]
        $path = [System.Uri]::UnescapeDataString($rawPath)
        $qIndex = $path.IndexOf('?')
        if ($qIndex -ge 0) { $path = $path.Substring(0, $qIndex) }
        if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }

        $rel = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
        $rootFull = [System.IO.Path]::GetFullPath($root)
        if (-not $full.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar)) {
            Send-HttpResponse $client '403 Forbidden' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
            return
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Send-HttpResponse $client '404 Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404 Not Found'))
            return
        }

        $contentType = Get-MimeType ([System.IO.Path]::GetExtension($full))
        if ($contentType -like '*charset=utf-8*') {
            $text = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        } else {
            $bytes = [System.IO.File]::ReadAllBytes($full)
        }
        Send-HttpResponse $client '200 OK' $contentType $bytes
    } catch {
        try { $client.Close() } catch {}
    }
}

$port = Get-FreePort
if ($null -eq $port) {
    Write-Host 'Error: no free port found in 8000-8999.' -ForegroundColor Red
    exit 1
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
$listener.Start()
$url = "http://localhost:$port/index.html"

Write-Host ''
Write-Host "AR project is running at: $url" -ForegroundColor Cyan
Write-Host 'Press Ctrl+C or close this window to stop the server.' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) {
    $chromeCandidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    try {
        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList $url
        } else {
            Start-Process $url
        }
    } catch {
        Write-Host 'Could not open the browser automatically. Please open this URL manually:' -ForegroundColor Yellow
        Write-Host $url -ForegroundColor Cyan
    }
}

try {
    while ($true) {
        if ($listener.Pending()) {
            $client = $listener.AcceptTcpClient()
            Handle-Client $client
        } else {
            try {
                if ([Console]::KeyAvailable) {
                    [Console]::ReadKey($true) | Out-Null
                    break
                }
            } catch {
                # no interactive console; keep serving
            }
            Start-Sleep -Milliseconds 30
        }
    }
} finally {
    try { $listener.Stop() } catch {}
}
