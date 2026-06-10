# Build Windows artifacts via electron-builder with CN mirrors + signing off.
$ErrorActionPreference = "Continue"
Set-Location "D:\张泽南\03-嵌入式\02-opencode\01-plugin\super-work-host"

$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

Write-Output "=== build:all ==="
npm run build:all
Write-Output "=== build:all exit: $LASTEXITCODE ==="

Write-Output "=== electron-builder --win --x64 ==="
npx electron-builder --win --x64
Write-Output "=== electron-builder exit: $LASTEXITCODE ==="

Write-Output "=== dist contents ==="
Get-ChildItem "D:\张泽南\03-嵌入式\02-opencode\01-plugin\super-work-host\dist" -ErrorAction SilentlyContinue |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
