# Optional Windows setup. Recording itself never downloads software.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$clipInstall = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.clipqa\bin'
$clipTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('clipqa-ffmpeg-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $clipTemp | Out-Null
try {
    $clipArchive = Join-Path $clipTemp 'ffmpeg.zip'
    $clipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $clipUrl -OutFile $clipArchive -TimeoutSec 120
    $clipExpected = ((Invoke-WebRequest -UseBasicParsing -Uri ($clipUrl + '.sha256') -TimeoutSec 30).Content.Trim() -split '\s+')[0]
    $clipHasher = [Security.Cryptography.SHA256]::Create()
    $clipStream = [IO.File]::OpenRead($clipArchive)
    try { $clipActual = [BitConverter]::ToString($clipHasher.ComputeHash($clipStream)).Replace('-', '') }
    finally { $clipStream.Dispose(); $clipHasher.Dispose() }
    if ($clipExpected -notmatch '^[0-9a-fA-F]{64}$' -or $clipActual -ne $clipExpected) {
        throw 'FFmpeg checksum mismatch. No binaries installed; retry in case the release changed during download.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($clipArchive, (Join-Path $clipTemp 'extracted'))
    $clipExe = Get-ChildItem -LiteralPath (Join-Path $clipTemp 'extracted') -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $clipExe) { throw 'FFmpeg executable missing from archive.' }
    $ErrorActionPreference = 'Continue'
    $clipHelp = & $clipExe.FullName -hide_banner -h filter=gfxcapture 2>&1 | Out-String
    $clipExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($clipExit -ne 0) { throw 'Downloaded FFmpeg could not run.' }
    if ($clipHelp -notmatch 'capture_cursor' -or $clipHelp -notmatch 'hwnd') { throw 'Downloaded build lacks the required gfxcapture filter.' }
    New-Item -ItemType Directory -Path $clipInstall -Force | Out-Null
    Copy-Item -LiteralPath $clipExe.FullName -Destination (Join-Path $clipInstall 'ffmpeg.exe') -Force
    Copy-Item -LiteralPath (Join-Path $clipExe.DirectoryName 'ffprobe.exe') -Destination (Join-Path $clipInstall 'ffprobe.exe') -Force
    Get-ChildItem -LiteralPath $clipExe.Directory.Parent.FullName -File | Where-Object { $_.Name -match 'LICENSE|README' } | Copy-Item -Destination $clipInstall -Force
    Write-Output "Installed verified WGC-capable FFmpeg in $clipInstall. Restart your MCP client to use it. FFmpeg is separately licensed by its distributor."
} finally {
    $clipResolved = [IO.Path]::GetFullPath($clipTemp)
    $clipRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($clipResolved.StartsWith($clipRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($clipResolved).StartsWith('clipqa-ffmpeg-')) {
        Remove-Item -LiteralPath $clipResolved -Recurse -Force
    }
}
