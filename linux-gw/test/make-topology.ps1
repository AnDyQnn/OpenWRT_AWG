# Топология: [NAT=провайдер] -> [gw-fw: WAN+LAN] -> [lan-net] -> [gw-client]
$VBM = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw"
$out  = "$base\output"

function Kill-VM($n){ & $VBM controlvm $n poweroff 2>$null; Start-Sleep 1; & $VBM unregistervm $n --delete 2>$null }

Kill-VM "gw-fw"
Kill-VM "gw-client"

# --- Шлюз ---
$vdi = "$out\gateway-fw.vdi"
if (Test-Path $vdi) { Remove-Item $vdi -Force }
Write-Host "Конвертирую образ в VDI..."
& $VBM convertfromraw "$out\gateway-vbox.img" $vdi --format VDI 2>&1 | Select-Object -Last 1

& $VBM createvm --name gw-fw --ostype Debian_64 --register | Out-Null
& $VBM modifyvm gw-fw --memory 2048 --cpus 2 --firmware efi --graphicscontroller vmsvga
& $VBM storagectl gw-fw --name SATA --add sata --controller IntelAhci
& $VBM storageattach gw-fw --storagectl SATA --port 0 --device 0 --type hdd --medium $vdi
# NIC1 = NAT (провайдер: DHCP+интернет) + проброс SSH
& $VBM modifyvm gw-fw --nic1 nat --nictype1 82540EM
& $VBM modifyvm gw-fw --natpf1 "ssh,tcp,127.0.0.1,2222,,22"
& $VBM modifyvm gw-fw --natpf1 "https,tcp,127.0.0.1,8443,,443"
& $VBM modifyvm gw-fw --natpf1 "http,tcp,127.0.0.1,8080,,80"
# NIC2 = внутренняя сеть LAN (к клиенту).
# promiscuous allow-all ОБЯЗАТЕЛЕН: br-lan имеет свой MAC, отличный от MAC NIC,
# иначе виртуальный свитч VBox режет юникаст к мосту (на железе проблемы нет).
& $VBM modifyvm gw-fw --nic2 intnet --intnet2 "lan-net" --nictype2 82540EM --nicpromisc2 allow-all
# Serial в файл
& $VBM modifyvm gw-fw --uart1 0x3F8 4 --uartmode1 file "$out\gw-fw-serial.log"

if (Test-Path "$out\gw-fw-serial.log") { Remove-Item "$out\gw-fw-serial.log" -Force }
& $VBM startvm gw-fw --type headless 2>&1 | Select-Object -Last 1
Write-Host "gw-fw запущена. WAN=NAT(провайдер), LAN=lan-net. SSH: 127.0.0.1:2222 (root:root)"
