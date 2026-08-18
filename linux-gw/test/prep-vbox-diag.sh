#!/bin/sh
# Диагностический преп: распаковывает образ, ОТКЛЮЧАЕТ установщик (boot идёт
# сразу в docker compose), ставит известный пароль root:root, оставляет serial-лог.
# Результат: /out/gateway-vbox.img
set -e
cd /out || exit 1

echo "Распаковка..."
gunzip -k -c gateway.img.gz > gateway-vbox.img

ROOT_OFF=$(parted -s -m gateway-vbox.img unit B print 2>/dev/null | awk -F: '$1==3{gsub("B","",$2);print $2}')
LOOP=$(losetup -f --show -o "$ROOT_OFF" gateway-vbox.img)
mkdir -p /m
mount "$LOOP" /m

echo "Отключаю установщик (mask gateway-installer.service)..."
ln -sf /dev/null /m/etc/systemd/system/gateway-installer.service

echo "Serial-лог + видимость загрузки..."
sed -i 's| quiet loglevel=3||' /m/boot/grub/grub.cfg
sed -i 's|rootwait ro|rootwait ro console=tty0 console=ttyS0,115200|' /m/boot/grub/grub.cfg

echo "Фиксирую пароль root:root..."
HASH=$(openssl passwd -6 root)
# заменяем 2-е поле строки root в /etc/shadow
awk -F: -v h="$HASH" 'BEGIN{OFS=":"} $1=="root"{$2=h} {print}' /m/etc/shadow > /m/etc/shadow.new
mv /m/etc/shadow.new /m/etc/shadow
chmod 640 /m/etc/shadow

umount /m
losetup -d "$LOOP"
echo "Готово: /out/gateway-vbox.img ($(du -h gateway-vbox.img | cut -f1))"
