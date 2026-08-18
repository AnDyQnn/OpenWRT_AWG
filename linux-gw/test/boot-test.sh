#!/bin/bash
# Boot-тест образа через QEMU. Проверяет, что система грузится дальше initramfs.
# Запуск в privileged debian-контейнере с примонтированным output.
set -e

echo "=== Установка QEMU ==="
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq qemu-system-x86 parted >/dev/null 2>&1
echo "QEMU: $(qemu-system-x86_64 --version | head -1)"

cd /out
echo "=== Распаковка образа ==="
gunzip -k -c gateway.img.gz > boot-test.img
echo "Размер: $(du -h boot-test.img | cut -f1)"

# Добавляем console=ttyS0 в grub.cfg чтобы видеть лог через serial
ROOT_OFF=$(parted -s -m boot-test.img unit B print 2>/dev/null | awk -F: '$1==3{gsub("B","",$2);print $2}')
LOOP=$(losetup -f --show -o "$ROOT_OFF" boot-test.img)
mkdir -p /m; mount "$LOOP" /m
sed -i 's|rootwait ro|rootwait ro console=tty0 console=ttyS0,115200|' /m/boot/grub/grub.cfg
echo "=== grub.cfg linux строка ==="
grep 'linux ' /m/boot/grub/grub.cfg | head -1
umount /m; losetup -d "$LOOP"

# KVM если доступен
ACCEL="tcg"
[ -e /dev/kvm ] && ACCEL="kvm"
echo "=== Загрузка QEMU (accel=$ACCEL, до 240с) ==="
echo "---------------- BOOT LOG ----------------"
timeout 240 qemu-system-x86_64 \
    -accel "$ACCEL" -m 1536 -smp 2 \
    -drive file=boot-test.img,format=raw,if=ide \
    -nographic -no-reboot -net none 2>&1 \
    | stdbuf -oL grep -iE 'ALERT|does not exist|Gave up|mount|systemd|Welcome|gateway|login:|Reached target|Kernel panic|wan-detect|Started|Failed|initramfs|EXT4-fs|Debian GNU' \
    | head -80 || true

echo "---------------- END LOG ----------------"
rm -f boot-test.img
echo "=== boot-тест завершён ==="
