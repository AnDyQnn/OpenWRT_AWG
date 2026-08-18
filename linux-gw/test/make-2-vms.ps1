# Creates TWO ready-to-test VMs (GUI, you watch the boot menu and press Y or N):
#   gateway-N-test  -> press N to run LIVE from the image
#   gateway-Y-test  -> press Y to install onto the 2nd (blank) disk
# Both use BIOS firmware (VirtualBox EFI crashes with 2 disks) and a VGA
# console so the boot menu shows in the VM window. NOT started.

$VBM  = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw\output"
$IMG  = Join-Path $base "gateway-plain.img"

# Decompress the plain image (VGA console, no serial tweaks)
Write-Host "Decompressing image..."
$outUnix = $base -replace '\\','/' -replace '^([A-Za-z]):','/$1'
docker run --rm -v "${outUnix}:/o" debian sh -c "gunzip -kc /o/gateway.img.gz > /o/gateway-plain.img"

function New-TestVM($name, $webPort, $sshPort) {
    $vdi = Join-Path $base "$name.vdi"
    $tgt = Join-Path $base "$name-target.vdi"
    & $VBM controlvm $name poweroff 2>$null
    Start-Sleep -Milliseconds 500
    & $VBM unregistervm $name --delete 2>$null
    foreach ($f in @($vdi,$tgt)) { if (Test-Path $f) { Remove-Item -LiteralPath $f -Force } }

    & $VBM convertfromraw $IMG $vdi --format VDI
    & $VBM modifymedium disk $vdi --resize 20480
    & $VBM createmedium disk --filename $tgt --size 20480 --format VDI | Out-Null

    & $VBM createvm --name $name --ostype Debian_64 --register | Out-Null
    & $VBM modifyvm $name --memory 2048 --cpus 2 --firmware bios --vram 32 | Out-Null
    & $VBM storagectl $name --name SATA --add sata --controller IntelAhci | Out-Null
    & $VBM storageattach $name --storagectl SATA --port 0 --device 0 --type hdd --medium $vdi | Out-Null
    & $VBM storageattach $name --storagectl SATA --port 1 --device 0 --type hdd --medium $tgt | Out-Null
    & $VBM modifyvm $name --nic1 nat | Out-Null
    & $VBM modifyvm $name --natpf1 "web,tcp,127.0.0.1,$webPort,,443" | Out-Null
    & $VBM modifyvm $name --natpf1 "ssh,tcp,127.0.0.1,$sshPort,,22" | Out-Null
    Write-Host "  created: $name  (web https://127.0.0.1:$webPort , ssh -p $sshPort)"
}

New-TestVM "gateway-N-test" 8443 2222
New-TestVM "gateway-Y-test" 8444 2223

Write-Host ""
Write-Host "=== Both VMs are ready (NOT started). Open VirtualBox GUI. ===" -ForegroundColor Green
