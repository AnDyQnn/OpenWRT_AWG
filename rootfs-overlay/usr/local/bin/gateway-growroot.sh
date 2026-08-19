#!/bin/bash
# Расширяет корневой раздел и ФС на весь диск.
# Запускается при каждой загрузке ПЕРЕД docker (идемпотентно — если уже
# на максимуме, growpart ничего не делает). Нужно чтобы на большом диске
# (SSD цели) использовалось всё место, а не 4.5 ГБ из образа.
LOG() { echo "$(date '+%Y-%m-%d %H:%M:%S') growroot: $*" | tee -a /var/log/awg-watchdog.log; }

ROOT_SRC=$(findmnt -n -o SOURCE / 2>/dev/null)   # напр. /dev/sda3
[ -z "$ROOT_SRC" ] && { LOG "не определил корневое устройство"; exit 0; }

# Диск и номер раздела: /dev/sda3 -> sda + 3 ; /dev/nvme0n1p3 -> nvme0n1 + 3
PART_NUM=$(echo "$ROOT_SRC" | grep -oE '[0-9]+$')
DISK=$(lsblk -no pkname "$ROOT_SRC" 2>/dev/null | head -1)
[ -z "$DISK" ] || [ -z "$PART_NUM" ] && { LOG "не разобрал $ROOT_SRC"; exit 0; }

LOG "Расширяю $ROOT_SRC (диск /dev/$DISK, раздел $PART_NUM)..."
OUT=$(growpart "/dev/$DISK" "$PART_NUM" 2>&1) && LOG "growpart: $OUT" || LOG "growpart: $OUT"
resize2fs "$ROOT_SRC" 2>&1 | tail -1 | sed 's/^/  resize2fs: /' | tee -a /var/log/awg-watchdog.log
LOG "Свободно на /: $(df -h / | awk 'NR==2{print $4}')"
exit 0
