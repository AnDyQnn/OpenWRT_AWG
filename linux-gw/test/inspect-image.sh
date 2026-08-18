#!/bin/sh
# Инспекция готового образа gateway.img.gz внутри привилегированного контейнера.
# Запуск: docker run --rm --privileged -v <output>:/out gateway-linux:latest sh /opt/gateway-inspect.sh
cd /out || { echo "нет /out"; exit 1; }

echo "Архив:        $(ls -lh gateway.img.gz | awk '{print $5}')"
gzip -t gateway.img.gz && echo "gzip:         OK" || echo "gzip:         БИТЫЙ"
gunzip -k -c gateway.img.gz > _test.img
echo "Распаковано:  $(du -h _test.img | cut -f1)"
echo ""
echo "--- Таблица разделов ---"
parted -s _test.img print 2>/dev/null

# Монтируем по byte-offset напрямую (partition-ноды в Docker ненадёжны)
EFI_START=$(parted -s -m _test.img unit B print 2>/dev/null | awk -F: '/^2:/{gsub("B","",$2);print $2}')
ROOT_START=$(parted -s -m _test.img unit B print 2>/dev/null | awk -F: '/^3:/{gsub("B","",$2);print $2}')
echo "offset EFI=$EFI_START  ROOT=$ROOT_START"

mkdir -p /m
echo ""
echo "--- EFI раздел (p2) ---"
mount -o loop,offset="$EFI_START" _test.img /m 2>/dev/null
find /m -iname '*.efi' 2>/dev/null | sed 's|/m|  |'
umount /m 2>/dev/null

echo ""
echo "--- ROOT раздел (p3) ---"
mount -o loop,offset="$ROOT_START" _test.img /m 2>/dev/null
echo "  ядро:        $(ls /m/boot/vmlinuz-* 2>/dev/null | xargs -n1 basename 2>/dev/null)"
echo "  initrd:      $(ls /m/boot/initrd.img-* 2>/dev/null | xargs -n1 basename 2>/dev/null)"
echo "  grub.cfg:    $([ -f /m/boot/grub/grub.cfg ] && echo ЕСТЬ || echo НЕТ)"
echo "  compose:     $([ -f /m/opt/gateway/docker-compose.yml ] && echo ЕСТЬ || echo НЕТ)"
echo "  wan-detect:  $([ -f /m/usr/local/bin/wan-detect.sh ] && echo ЕСТЬ || echo НЕТ)"
echo "  installer:   $([ -f /m/usr/local/bin/gateway-installer.sh ] && echo ЕСТЬ || echo НЕТ)"
echo "  status:      $([ -f /m/usr/local/bin/gateway-status ] && echo ЕСТЬ || echo НЕТ)"
echo "  dockerd:     $([ -f /m/usr/bin/dockerd ] && echo ЕСТЬ || echo НЕТ)"
echo "  fstab UUID:  $(grep -c UUID /m/etc/fstab 2>/dev/null)"
echo "  включённые сервисы:"
ls /m/etc/systemd/system/multi-user.target.wants/ 2>/dev/null | grep -E 'gateway|docker|wan|ssh' | sed 's/^/    + /'
echo ""
echo "--- grub.cfg: строка root= ---"
grep -E 'linux|root=' /m/boot/grub/grub.cfg 2>/dev/null | grep -v '^#' | head -3 | sed 's/^[[:space:]]*/  /'
echo "  ссылки на /dev/loop: $(grep -c '/dev/loop' /m/boot/grub/grub.cfg 2>/dev/null) (должно быть 0)"
umount /m 2>/dev/null
rm -f _test.img
echo ""
echo "=== готовый образ ==="
ls -lh gateway.img.gz
