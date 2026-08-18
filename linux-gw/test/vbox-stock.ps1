# Creates a STOCK VirtualBox VM to test both installer scenarios via the GUI:
#   - boot disk = the gateway image (acts like the USB stick)
#   - second blank disk = install target
# The VM is created but NOT started, so you launch it yourself and watch the
# boot menu (Y = install to the blank disk, N = run live).

$VBM  = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw\output"
$VM   = "gateway"
$IMG  = Join-Path $base "gateway.img"
$GZ   = Join-Path $base "gateway.img.gz"
$VDI  = Join-Path $base "gateway-usb.vdi"      # the "USB" / live image
$TGT  = Join-Path $base "gateway-target.vdi"   # blank install target

# Cleanup previous
& $VBM controlvm $VM poweroff 2>$null
Start-Sleep -Seconds 1
& $VBM unregistervm $VM --delete 2>$null
foreach ($f in @($VDI,$TGT,$IMG)) { if (Test-Path $f) { Remove-Item -LiteralPath $f -Force } }

# Decompress image (no console tweaks -> prompt shows on the VM window)
Write-Host "Decompressing image..."
$outUnix = $base -replace '\\','/' -replace '^([A-Za-z]):','/$1'
docker run --rm -v "${outUnix}:/o" debian sh -c "gunzip -kc /o/gateway.img.gz > /o/gateway.img"

Write-Host "Converting to VDI (USB/live disk)..."
& $VBM convertfromraw $IMG $VDI --format VDI
& $VBM modifymedium disk $VDI --resize 20480

Write-Host "Creating blank target disk (20 GB)..."
& $VBM createmedium disk --filename $TGT --size 20480 --format VDI

Write-Host "Creating VM '$VM'..."
& $VBM createvm --name $VM --ostype Debian_64 --register | Out-Null
& $VBM modifyvm $VM --memory 2048 --cpus 2 --firmware efi --vram 16 | Out-Null
& $VBM storagectl $VM --name SATA --add sata --controller IntelAhci | Out-Null
& $VBM storageattach $VM --storagectl SATA --port 0 --device 0 --type hdd --medium $VDI | Out-Null
& $VBM storageattach $VM --storagectl SATA --port 1 --device 0 --type hdd --medium $TGT | Out-Null
& $VBM modifyvm $VM --nic1 nat | Out-Null
& $VBM modifyvm $VM --natpf1 "web,tcp,127.0.0.1,8443,,443" | Out-Null
& $VBM modifyvm $VM --natpf1 "ssh,tcp,127.0.0.1,2222,,22" | Out-Null

Write-Host ""
Write-Host "=== VM 'gateway' is ready (NOT started). ===" -ForegroundColor Green
Write-Host "Open VirtualBox, select 'gateway', press Start, and you'll see the boot menu:"
Write-Host "  N -> runs LIVE from the image disk (test the panel)"
Write-Host "  Y -> installs onto the blank 2nd disk, then reboots"
Write-Host ""
Write-Host "After a Y-install: power off, in VM Settings remove the 1st disk"
Write-Host "(port 0), start again -> it boots the INSTALLED system from disk 2."
Write-Host ""
Write-Host "Panel: https://127.0.0.1:8443  (admin/admin)   SSH: root@127.0.0.1 -p 2222 (openwrt)"
