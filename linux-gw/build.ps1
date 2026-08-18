# Build the Linux PC-gateway (Debian 12 + AmneziaWG + Docker).
# Container images are built HERE and baked into the .img, so the target
# hardware does NOT compile anything and first boot is fast.
# Result: linux-gw/output/gateway.img.gz

param([string]$TAG = "gateway-linux:latest")

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputDir = Join-Path $ScriptDir "output"
$GatewayDir = Join-Path $ScriptDir "gateway"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "=== Linux Gateway Builder ===" -ForegroundColor Cyan
Write-Host "Output: $OutputDir"
Write-Host ""

# --- Step 1: host image (Debian + Docker) ---
Write-Host "--- Step 1/4: host image (Debian + Docker)..." -ForegroundColor Yellow
docker build -f "$ScriptDir\Dockerfile" -t $TAG "$ScriptDir"
if ($LASTEXITCODE -ne 0) { Write-Host "host build failed" -ForegroundColor Red; exit 1 }

# --- Step 2: service images (AWG compiles here, ~15 min) ---
Write-Host ""
Write-Host "--- Step 2/4: service images (AWG compiles, ~15 min)..." -ForegroundColor Yellow
docker build -t "gateway-awg:latest" "$GatewayDir\awg"
if ($LASTEXITCODE -ne 0) { Write-Host "awg build failed" -ForegroundColor Red; exit 1 }
docker build -t "gateway-dnsmasq:latest" "$GatewayDir\dnsmasq"
if ($LASTEXITCODE -ne 0) { Write-Host "dnsmasq build failed" -ForegroundColor Red; exit 1 }
docker build -t "gateway-webui:latest" "$GatewayDir\webui"
if ($LASTEXITCODE -ne 0) { Write-Host "webui build failed" -ForegroundColor Red; exit 1 }

# --- Step 3: save images to tar for baking ---
Write-Host ""
Write-Host "--- Step 3/4: saving images.tar..." -ForegroundColor Yellow
$ImagesTar = Join-Path $OutputDir "images.tar"
docker save -o $ImagesTar "gateway-awg:latest" "gateway-dnsmasq:latest" "gateway-webui:latest"
if ($LASTEXITCODE -ne 0) { Write-Host "docker save failed" -ForegroundColor Red; exit 1 }
$tarMB = [math]::Round((Get-Item $ImagesTar).Length/1MB,0)
Write-Host "  images.tar: $tarMB MB"

# --- Step 4: create .img (bakes rootfs + images.tar) ---
Write-Host ""
Write-Host "--- Step 4/4: creating bootable .img..." -ForegroundColor Yellow
$OutputDirUnix = $OutputDir -replace '\\','/' -replace '^([A-Za-z]):','/$1'
$dockerArgs = @("run","--rm","--privileged","-v","${OutputDirUnix}:/output","-v","${OutputDirUnix}:/input",$TAG)
& docker $dockerArgs
if ($LASTEXITCODE -ne 0) { Write-Host "image creation failed" -ForegroundColor Red; exit 1 }

# remove intermediate tar (already inside the .img)
Remove-Item $ImagesTar -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Green
Get-ChildItem $OutputDir -Filter "*.img.gz" | ForEach-Object {
    Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1MB,0)) MB)"
}
Write-Host ""
Write-Host "Rufus  : write gateway.img.gz to USB (DD mode)"
Write-Host "Panel  : https://192.168.88.1  (admin/admin)"
Write-Host "SSH    : ssh -p 23232 root@192.168.88.1  (root)  - LAN/VPN only, closed on WAN"
Write-Host "First boot is fast - container images are pre-baked."
