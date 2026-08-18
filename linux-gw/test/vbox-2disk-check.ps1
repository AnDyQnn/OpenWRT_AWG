# Quick check: does a 2-disk VM boot to the installer (showing [Y/n])?
# Uses FILE serial (reliable) just for this verification.
$VBM  = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw\output"
$VM   = "gw2disk"
$VDI  = Join-Path $base "gw2disk.vdi"
$TGT  = Join-Path $base "gw2disk-tgt.vdi"
$IMG  = Join-Path $base "gateway-vbox.img"    # prep'd with console=ttyS0 (serial visible)
$SER  = Join-Path $base "serial2.log"

& $VBM controlvm $VM poweroff 2>$null
Start-Sleep -Seconds 2
& $VBM unregistervm $VM --delete 2>$null
foreach ($f in @($VDI,$TGT,$SER)) { if (Test-Path $f) { Remove-Item -LiteralPath $f -Force } }

& $VBM convertfromraw $IMG $VDI --format VDI
& $VBM modifymedium disk $VDI --resize 20480
& $VBM createmedium disk --filename $TGT --size 20480 --format VDI | Out-Null

& $VBM createvm --name $VM --ostype Debian_64 --register | Out-Null
& $VBM modifyvm $VM --memory 2048 --cpus 2 --firmware efi --vram 16 | Out-Null
& $VBM storagectl $VM --name SATA --add sata --controller IntelAhci | Out-Null
& $VBM storageattach $VM --storagectl SATA --port 0 --device 0 --type hdd --medium $VDI | Out-Null
& $VBM storageattach $VM --storagectl SATA --port 1 --device 0 --type hdd --medium $TGT | Out-Null
& $VBM modifyvm $VM --nic1 nat | Out-Null
& $VBM modifyvm $VM --uart1 0x3F8 4 --uartmode1 file $SER | Out-Null
& $VBM startvm $VM --type headless 2>&1 | Select-Object -Last 1
Write-Host "gw2disk started, serial -> $SER"
