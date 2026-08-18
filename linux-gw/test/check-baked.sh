#!/bin/sh
# Проверяет вшитое: images.tar, daemon.json, load-скрипт, compose.
cd /out || exit 1
gunzip -k -c gateway.img.gz > _t.img
ROOT_OFF=$(parted -s -m _t.img unit B print 2>/dev/null | awk -F: '$1==3{gsub("B","",$2);print $2}')
mkdir -p /m
mount -o loop,offset="$ROOT_OFF" _t.img /m 2>/dev/null

echo "images.tar:             $([ -f /m/opt/gateway/images.tar ] && du -h /m/opt/gateway/images.tar | cut -f1 || echo НЕТ)"
echo "daemon.json:            $([ -f /m/etc/docker/daemon.json ] && echo ЕСТЬ || echo НЕТ)"
echo "  содержимое daemon.json:"
cat /m/etc/docker/daemon.json 2>/dev/null | sed 's/^/    /'
echo "gateway-load-images.sh: $([ -f /m/usr/local/bin/gateway-load-images.sh ] && echo ЕСТЬ || echo НЕТ)"
echo "load-images executable:  $([ -x /m/usr/local/bin/gateway-load-images.sh ] && echo ДА || echo НЕТ)"
echo "compose image: строки:"
grep 'image:' /m/opt/gateway/docker-compose.yml 2>/dev/null | sed 's/^/  /'

umount /m 2>/dev/null
rm -f _t.img
