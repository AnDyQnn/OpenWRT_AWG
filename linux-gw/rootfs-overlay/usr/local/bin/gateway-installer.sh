#!/bin/bash
# Boot installer. Shows a prompt and BLOCKS boot until answered:
#   Y -> install the system to an internal disk, then reboot
#   N -> keep running LIVE from this USB stick (portable mode), boot continues
# After a successful install the target carries /etc/awg-setup/.installed, so
# the installed system never shows this prompt again (only the live USB does).
# English text only (console font may lack Cyrillic at this stage).

# Already an installed system? -> never prompt, just continue.
[ -f /etc/awg-setup/.installed ] && exit 0

# stdin/stdout уже = /dev/console (сервис: StandardInput=tty-force,
# TTYPath=/dev/console). Поэтому используем обычные read/echo — без ручного
# открытия /dev/console (оно подвисало).

# ANSI-C quoting ($'...') — реальные escape-байты, чтобы обычный echo не печатал \033 буквально
BOLD=$'\033[1m'; RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; CYN=$'\033[0;36m'; NC=$'\033[0m'

# Boot device (the USB we run from)
BOOT_PART=$(findmnt -n -o SOURCE / 2>/dev/null)
BOOT_DEV=$(lsblk -no pkname "$BOOT_PART" 2>/dev/null | head -1)
[ -n "$BOOT_DEV" ] && BOOT_DEV="/dev/$BOOT_DEV"

# Candidate internal disks (>=4GB, not the boot device)
declare -a TGT NAMES
for dev in /dev/sd? /dev/nvme?n? /dev/mmcblk?; do
    [ -b "$dev" ] || continue
    [ "$dev" = "$BOOT_DEV" ] && continue
    SZ=$(cat "/sys/class/block/${dev##*/}/size" 2>/dev/null || echo 0)
    GB=$(( SZ * 512 / 1073741824 ))
    [ "$GB" -lt 4 ] && continue
    MODEL=$(cat "/sys/class/block/${dev##*/}/device/model" 2>/dev/null | xargs 2>/dev/null || echo Disk)
    TGT+=("$dev"); NAMES+=("$dev  [${GB} GB]  $MODEL")
done

clear
printf "${CYN}${BOLD}"
echo "  ============================================================"
echo "   Gateway Linux  -  Boot menu"
echo "  ============================================================${NC}"
echo ""
echo -e "  ${BOLD}Y${NC} = INSTALL this system onto an internal disk (recommended)"
echo -e "  ${BOLD}N${NC} = run LIVE from this USB now (portable, nothing is written)"
echo ""

if [ ${#TGT[@]} -eq 0 ]; then
    echo -e "  ${YEL}No internal disk detected for installation.${NC}"
    echo "  Only LIVE mode is available."
    echo ""
    printf "  Press Enter to continue (LIVE)... "
    read -r _
    exit 0
fi

echo "  Internal disks available for installation:"
for i in "${!TGT[@]}"; do echo "    [$((i+1))]  ${NAMES[$i]}"; done
echo ""
printf "  Install to disk? ${BOLD}[Y/n]${NC} (N = live from USB): "
read -r ANS
# Default Enter = Yes (install). Explicit n/N = live.
case "$ANS" in
    [Nn]*) echo ""; echo -e "  ${GRN}Starting LIVE from USB...${NC}"; sleep 1; exit 0 ;;
esac

# Pick target
if [ ${#TGT[@]} -eq 1 ]; then
    TARGET="${TGT[0]}"
else
    printf "  Pick disk number [1-%s]: " "${#TGT[@]}"
    read -r N
    [[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] && [ "$N" -le ${#TGT[@]} ] \
        || { echo "  Invalid choice. Starting LIVE."; sleep 1; exit 0; }
    TARGET="${TGT[$((N-1))]}"
fi

# ── SSH port ──────────────────────────────────────────────────────────────────
# Port is NOT hardcoded in the project: it would be published in the public repo,
# so every installation would run SSH on a known port. A random one is generated
# per installation; here the owner may pick their own.
SUGGESTED=$(/usr/local/bin/gateway-ssh-port.sh ensure 2>/dev/null || echo 22)
echo ""
echo -e "  ${BOLD}SSH port${NC} (WAN closed by firewall; LAN and VPN only)"
printf "  Press Enter to keep %s, or type your own [1-65535]: " "$SUGGESTED"
read -r SSHP
if [ -n "$SSHP" ]; then
    if [[ "$SSHP" =~ ^[0-9]+$ ]] && [ "$SSHP" -ge 1 ] && [ "$SSHP" -le 65535 ]; then
        /usr/local/bin/gateway-ssh-port.sh set "$SSHP" >/dev/null 2>&1 && SUGGESTED="$SSHP"
    else
        echo -e "  ${YEL}Not a valid port, keeping $SUGGESTED.${NC}"
    fi
fi
echo -e "  SSH will listen on ${BOLD}${SUGGESTED}${NC} (changeable later in the panel)"

echo ""
echo -e "  ${RED}${BOLD}WARNING: ALL DATA on $TARGET will be ERASED!${NC}"
printf "  Type 'yes' to confirm install to %s: " "$TARGET"
read -r C
[ "$C" = "yes" ] || { echo "  Cancelled. Starting LIVE."; sleep 1; exit 0; }

echo ""
echo -e "  ${CYN}Installing to $TARGET ... do NOT power off.${NC}"
echo ""
dd if="$BOOT_DEV" of="$TARGET" bs=4M conv=fsync status=progress
sync

# Mark the TARGET as installed so it won't prompt when booted from disk.
TPART="${TARGET}3"; [ -b "$TPART" ] || TPART="${TARGET}p3"
if [ -b "$TPART" ]; then
    MP=$(mktemp -d)
    if mount "$TPART" "$MP" 2>/dev/null; then
        mkdir -p "$MP/etc/awg-setup"
        echo installed > "$MP/etc/awg-setup/.installed"
        sync; umount "$MP"
    fi
    rmdir "$MP" 2>/dev/null
fi

echo ""
echo -e "  ${GRN}${BOLD}Installation finished!${NC}"
echo "  Remove the USB stick, then press Enter to reboot..."
read -r _
reboot
