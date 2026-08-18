#!/bin/sh
# Готовит образ для VirtualBox: распаковывает + добавляет console=ttyS0
# (чтобы ловить лог загрузки через serial). Результат: /out/gateway-vbox.img
set -e
cd /out || exit 1

echo "Распаковка..."
gunzip -k -c gateway.img.gz > gateway-vbox.img

ROOT_OFF=$(parted -s -m gateway-vbox.img unit B print 2>/dev/null | awk -F: '$1==3{gsub("B","",$2);print $2}')
LOOP=$(losetup -f --show -o "$ROOT_OFF" gateway-vbox.img)
mkdir -p /m
mount "$LOOP" /m

echo "Добавляю console=ttyS0 + убираю quiet (для видимости в serial-тесте)..."
sed -i 's| quiet loglevel=3||' /m/boot/grub/grub.cfg
sed -i 's|rootwait ro|rootwait ro console=tty0 console=ttyS0,115200|' /m/boot/grub/grub.cfg
grep 'linux ' /m/boot/grub/grub.cfg | head -1 | sed 's/^/  /'

umount /m
losetup -d "$LOOP"
echo "Готово: /out/gateway-vbox.img ($(du -h gateway-vbox.img | cut -f1))"
