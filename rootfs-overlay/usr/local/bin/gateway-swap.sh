#!/bin/bash
# Создаёт swap-файл при первом старте (страховка от OOM на пиках нагрузки).
# Размер = 2x RAM, в пределах 2..8 ГБ. Идемпотентно (создаёт один раз).
LOG() { echo "$(date '+%Y-%m-%d %H:%M:%S') gateway-swap: $*" | tee -a /var/log/awg-watchdog.log; }

SWAPFILE=/swapfile

# Уже активен?
if swapon --show 2>/dev/null | grep -q "$SWAPFILE"; then
    LOG "swap уже активен: $(swapon --show=NAME,SIZE --noheadings 2>/dev/null | tr '\n' ' ')"
    exit 0
fi

# Размер: 2x RAM, 2..8 ГБ
RAM_MB=$(awk '/MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
SWAP_MB=$(( RAM_MB * 2 ))
[ "$SWAP_MB" -lt 2048 ] && SWAP_MB=2048
[ "$SWAP_MB" -gt 8192 ] && SWAP_MB=8192

# Хватит ли места на диске? (оставляем минимум 2 ГБ свободными)
FREE_MB=$(df -m / | awk 'NR==2{print $4}')
if [ "$FREE_MB" -lt $(( SWAP_MB + 2048 )) ]; then
    SWAP_MB=$(( FREE_MB - 2048 ))
    [ "$SWAP_MB" -lt 512 ] && { LOG "мало места ($FREE_MB МБ) — swap пропущен"; exit 0; }
    LOG "урезаю swap до ${SWAP_MB} МБ (свободно ${FREE_MB} МБ)"
fi

LOG "Создаю swap ${SWAP_MB} МБ (RAM ${RAM_MB} МБ)..."
rm -f "$SWAPFILE" 2>/dev/null
if ! fallocate -l "${SWAP_MB}M" "$SWAPFILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_MB" status=none
fi
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE" >/dev/null 2>&1
swapon "$SWAPFILE" && LOG "swap включён: ${SWAP_MB} МБ" || { LOG "ERR swapon"; exit 0; }

# Постоянство: добавляем в fstab + настраиваем swappiness (для шлюза низкий)
grep -q "^$SWAPFILE" /etc/fstab 2>/dev/null || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
grep -q "vm.swappiness" /etc/sysctl.conf 2>/dev/null || echo "vm.swappiness=10" >> /etc/sysctl.conf
sysctl -q vm.swappiness=10 2>/dev/null || true
LOG "Память: $(free -h | awk '/Mem:/{print "RAM "$2}; /Swap:/{print "Swap "$2}' | tr '\n' ' ')"
exit 0
