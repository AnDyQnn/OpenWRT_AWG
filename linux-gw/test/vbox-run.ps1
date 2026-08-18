# Full end-to-end test of gateway image in VirtualBox.
# Boots the image as a VM (EFI), NAT networking with port forwards,
# captures serial boot log, verifies the web panel responds.

$VBM = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw\output"
$VM = "gateway-test"
$IMG = Join-Path $base "gateway-vbox.img"
$VDI = Join-Path $base "gateway-test.vdi"
$SERIAL = Join-Path $base "serial.log"

# Cleanup previous VM/artifacts
& $VBM controlvm $VM poweroff 2>$null
Start-Sleep -Seconds 2
& $VBM unregistervm $VM --delete 2>$null
if (Test-Path $VDI) { Remove-Item -LiteralPath $VDI -Force }
if (Test-Path $SERIAL) { Remove-Item -LiteralPath $SERIAL -Force }

Write-Host "Convert raw -> VDI..."
& $VBM convertfromraw $IMG $VDI --format VDI
if ($LASTEXITCODE -ne 0) { Write-Host "convert failed"; exit 1 }

# Расширяем диск до 20 ГБ — чтобы проверить growroot (расширение раздела)
# и gateway-swap (создание swap-файла), как на реальной SSD.
Write-Host "Resize VDI -> 20 GB (test growroot + swap)..."
& $VBM modifymedium disk $VDI --resize 20480

Write-Host "Create VM..."
& $VBM createvm --name $VM --ostype Debian_64 --register | Out-Null
& $VBM modifyvm $VM --memory 2048 --cpus 2 --firmware efi --graphicscontroller vmsvga --vram 16 | Out-Null
& $VBM storagectl $VM --name SATA --add sata --controller IntelAhci | Out-Null
& $VBM storageattach $VM --storagectl SATA --port 0 --device 0 --type hdd --medium $VDI | Out-Null
& $VBM modifyvm $VM --nic1 nat | Out-Null
& $VBM modifyvm $VM --natpf1 "web,tcp,127.0.0.1,8443,,443" | Out-Null
& $VBM modifyvm $VM --natpf1 "ssh,tcp,127.0.0.1,2222,,22" | Out-Null
& $VBM modifyvm $VM --uart1 0x3F8 4 --uartmode1 file $SERIAL | Out-Null

Write-Host "Start VM (headless)..."
& $VBM startvm $VM --type headless
Write-Host "VM started. Serial log: $SERIAL"
Write-Host "Web panel will be at https://127.0.0.1:8443  (admin/admin)"
