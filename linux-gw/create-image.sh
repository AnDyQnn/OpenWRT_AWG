#!/bin/bash
# Создаёт загрузочный образ диска из текущей файловой системы.
# Запускается в --privileged Docker контейнере.
set -e

OUTPUT="${1:-/output}"
mkdir -p "$OUTPUT"

echo "=== Gateway Linux Image Builder ==="

# Чистим повисшие loop-устройства от прошлых прогонов
losetup -D 2>/dev/null || true

# Что копируем (без виртуальных ФС и артефактов)
EXCLUDES="--exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run \
--exclude=/tmp --exclude=/mnt --exclude=/output --exclude=/input \
--exclude=/var/lib/docker --exclude=/var/cache/apt"

# Реальный размер rootfs (du, не df — df меряет весь диск хоста)
USED_MB=$(du -sxm $EXCLUDES / 2>/dev/null | awk '{print $1}')
[ -z "$USED_MB" ] && USED_MB=2500
# +3 ГБ свободного места: распаковка контейнеров (~400 МБ) + writable-слои +
# логи + запас. Образ сжимается (пустое место = нули), .gz почти не растёт.
DISK_MB=$(( USED_MB + 3000 ))
echo "Rootfs: ${USED_MB} MB → Disk: ${DISK_MB} MB (свободно ~3 ГБ)"

IMG="$OUTPUT/gateway.img"
rm -f "$IMG" "$IMG.gz"

# Создаём образ диска
dd if=/dev/zero of="$IMG" bs=1M count="$DISK_MB" status=none

# Таблица разделов GPT (гибрид UEFI + Legacy BIOS):
#   p1: bios_grub  1 МБ  — область для GRUB на старых BIOS
#   p2: ESP        100 МБ fat32 — EFI System Partition
#   p3: root       остаток ext4
parted -s "$IMG" mklabel gpt
parted -s "$IMG" mkpart bios_grub 1MiB   2MiB
parted -s "$IMG" set 1 bios_grub on
parted -s "$IMG" mkpart ESP  fat32 2MiB  102MiB
parted -s "$IMG" set 2 esp on
parted -s "$IMG" mkpart root ext4  102MiB 100%

# Loop на ВЕСЬ диск (нужен для BIOS grub-install)
LOOP=$(losetup -f --show "$IMG")
echo "Loop (диск): $LOOP"

# Отдельные loop-устройства на разделы по byte-offset.
# partscan/partx в Docker Desktop ненадёжны — offset-loop работает всегда.
get_part() {
    parted -s -m "$IMG" unit B print 2>/dev/null \
        | awk -F: -v n="$1" '$1==n{gsub("B","",$2);gsub("B","",$4);print $2" "$4}'
}
EFI_OFF=$(get_part 2 | awk '{print $1}');  EFI_SIZE=$(get_part 2 | awk '{print $2}')
ROOT_OFF=$(get_part 3 | awk '{print $1}'); ROOT_SIZE=$(get_part 3 | awk '{print $2}')
echo "EFI:  offset=$EFI_OFF size=$EFI_SIZE"
echo "ROOT: offset=$ROOT_OFF size=$ROOT_SIZE"

EFI_LOOP=$(losetup -f --show  -o "$EFI_OFF"  --sizelimit "$EFI_SIZE"  "$IMG")
ROOT_LOOP=$(losetup -f --show -o "$ROOT_OFF" --sizelimit "$ROOT_SIZE" "$IMG")
echo "EFI loop: $EFI_LOOP   ROOT loop: $ROOT_LOOP"

# Форматирование
mkfs.vfat -F 32 -n EFI    "$EFI_LOOP"
mkfs.ext4 -F -L rootfs    "$ROOT_LOOP"

# Монтирование
mount "$ROOT_LOOP" /mnt
mkdir -p /mnt/boot/efi
mount "$EFI_LOOP" /mnt/boot/efi

# Копирование rootfs (без виртуальных ФС и артефактов)
echo "Copying rootfs..."
rsync -aAX $EXCLUDES / /mnt/

# Предсобранные образы контейнеров (если переданы через /input/images.tar)
if [ -f /input/images.tar ]; then
    echo "Вшиваю предсобранные образы контейнеров (images.tar)..."
    mkdir -p /mnt/opt/gateway
    cp /input/images.tar /mnt/opt/gateway/images.tar
    echo "  размер: $(du -h /mnt/opt/gateway/images.tar | cut -f1)"
else
    echo "WARN: /input/images.tar нет — первый старт будет собирать из исходников"
fi

mkdir -p /mnt/{proc,sys,dev,run,tmp}
chmod 1777 /mnt/tmp

# Убираем маркеры Docker-сборки, иначе systemd-detect-virt считает систему
# контейнером ("Detected virtualization docker") и ломает ConditionVirtualization
rm -f /mnt/.dockerenv /mnt/run/.containerenv 2>/dev/null || true

# fstab
ROOT_UUID=$(blkid -s UUID -o value "$ROOT_LOOP")
EFI_UUID=$(blkid -s UUID -o value "$EFI_LOOP")
cat > /mnt/etc/fstab <<EOF
UUID=$ROOT_UUID /         ext4 errors=remount-ro 0 1
UUID=$EFI_UUID  /boot/efi vfat umask=0077        0 1
tmpfs           /tmp      tmpfs defaults          0 0
EOF

# Bind mounts для chroot
for d in dev proc sys; do mount --bind /$d /mnt/$d; done

# Установка GRUB (EFI — современные ПК с UEFI)
echo "Installing GRUB (EFI)..."
chroot /mnt grub-install \
    --target=x86_64-efi \
    --efi-directory=/boot/efi \
    --bootloader-id=gateway \
    --removable \
    --no-nvram

# Установка GRUB (BIOS — Legacy, в bios_grub раздел на GPT)
echo "Installing GRUB (BIOS legacy)..."
chroot /mnt grub-install \
    --target=i386-pc \
    --boot-directory=/boot \
    --modules="normal part_gpt ext2 linux biosdisk" \
    "$LOOP" || echo "WARN: BIOS GRUB install failed (EFI still works)"

# ── /etc/default/grub (для будущих ручных update-grub на железе) ──
cat > /mnt/etc/default/grub <<EOF
GRUB_DEFAULT=0
GRUB_TIMEOUT=3
GRUB_DISTRIBUTOR="Gateway Linux"
GRUB_CMDLINE_LINUX_DEFAULT=""
GRUB_CMDLINE_LINUX="root=UUID=$ROOT_UUID rootwait"
GRUB_DISABLE_LINUX_UUID=false
GRUB_DISABLE_OS_PROBER=true
GRUB_DISABLE_RECOVERY=true
EOF

# Не ждать resume-устройство (гибернация выключена)
echo "RESUME=none" > /mnt/etc/initramfs-tools/conf.d/resume

# Initramfs со ВСЕМИ драйверами (любое железо: SATA/NVMe/USB/RAID)
echo "MODULES=most" > /mnt/etc/initramfs-tools/conf.d/driver-policy

# Перегенерируем initramfs с MODULES=most (драйверы дисков для любого ПК)
echo "Rebuilding initramfs (all storage drivers)..."
chroot /mnt update-initramfs -u -k all 2>&1 | tail -3

# ── Статический grub.cfg (БЕЗ update-grub/grub-probe) ────────────
# grub-probe ломается на offset-loop (backing-файл вне chroot), поэтому
# пишем конфиг вручную — он надёжнее и всегда использует UUID корня.
KVER=$(ls /mnt/boot/vmlinuz-* 2>/dev/null | sed 's|.*/vmlinuz-||' | sort -V | tail -1)
echo "Kernel: $KVER"
mkdir -p /mnt/boot/grub
cat > /mnt/boot/grub/grub.cfg <<EOF
set timeout=3
set default=0

insmod part_gpt
insmod ext2
insmod fat
insmod gzio

search --no-floppy --fs-uuid --set=root $ROOT_UUID

menuentry "Gateway Linux" {
    linux  /boot/vmlinuz-$KVER root=UUID=$ROOT_UUID rootwait ro quiet loglevel=3
    initrd /boot/initrd.img-$KVER
}
menuentry "Gateway Linux (recovery)" {
    linux  /boot/vmlinuz-$KVER root=UUID=$ROOT_UUID rootwait ro single
    initrd /boot/initrd.img-$KVER
}
EOF

# Проверка
if grep -q "/dev/loop" /mnt/boot/grub/grub.cfg; then
    echo "WARN: в grub.cfg остались ссылки на loop!"
else
    echo "OK: grub.cfg → root=UUID=$ROOT_UUID, kernel $KVER"
fi

# Чистка
for d in dev proc sys; do umount /mnt/$d 2>/dev/null || true; done
umount /mnt/boot/efi 2>/dev/null || true
umount /mnt 2>/dev/null || true
losetup -d "$EFI_LOOP"  2>/dev/null || true
losetup -d "$ROOT_LOOP" 2>/dev/null || true
losetup -d "$LOOP"      2>/dev/null || true

# Сжатие
echo "Compressing..."
gzip -1 "$IMG"

echo ""
echo "=== Done! ==="
ls -lh "$OUTPUT"/gateway.img.gz
echo ""
echo "Use:  squashfs-efi → real PC (UEFI)"
echo "      gateway.img.gz → VirtualBox or legacy PC"
echo "Rufus: DD Image mode, GPT+UEFI"
echo "Web:  http://192.168.88.1/awg/"
