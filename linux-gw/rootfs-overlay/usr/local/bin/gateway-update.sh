#!/bin/sh
# Машина состояний in-place обновления шлюза (§7).
# CHECK → PREFLIGHT → BACKUP → CLEANUP → APPLY → HEALTH-GATE → COMMIT (|ROLLBACK).
#
# Принципы (§2): код vs состояние; на проде НЕ собираем (тянем образ по digest);
# откат локальный; dead-man-маркер; идемпотентность; целостность по digest.
#
# Использование:
#   gateway-update.sh check    — только проверить наличие новой версии (CHECK)
#   gateway-update.sh apply    — выполнить полный накат
#   gateway-update.sh rollback — ручной откат на :rollback + последний бэкап
#
# Образы: manifest пинит ghcr-digest каждого сервиса. Тянем digest и ретегаем в
# gateway-<svc>:latest (этот тег ждёт docker-compose) — compose НЕ переписываем.
# Прежний :latest → :rollback (страховка одного поколения).
set -u

REPO="AnDyQnn/OpenWRT_AWG"
CHANNEL_DEFAULT="upd-code"
GW_DIR=/opt/gateway
STAGING=/opt/gateway-staging
BK=/opt/gateway-backups
VERSION_FILE=/etc/awg-setup/.version           # текущая развёрнутая версия (состояние)
CFG=/etc/awg-setup/update-config.json
MARKER=/etc/awg-setup/.update-inprogress       # dead-man (см. gateway-update-guard)
LOCK=/run/awg-setup/update.lock
STATUS=/run/awg-setup/update-status.json        # читает webui (вкладка «Обновление»)
WLOG=/var/log/awg-watchdog.log
HEALTH_TIMEOUT=90
SERVICES="awg dnsmasq webui"                     # суффиксы образов gateway-<svc>

mkdir -p /run/awg-setup "$BK"
_log(){ printf '%s gateway-update: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

# Статус для UI: stage, state(idle|running|ok|error), message, версии.
_status(){ # $1=stage $2=state $3=message
    cat > "$STATUS" <<EOF
{"stage":"$1","state":"$2","message":"$(echo "$3" | sed 's/"/\\"/g')","from":"${CUR_VER:-?}","to":"${NEW_VER:-?}","ts":"$(date -Iseconds)"}
EOF
}

_cur_version(){ cat "$VERSION_FILE" 2>/dev/null || echo "0.0.0"; }
_channel(){ grep -oE '"channel"[ ]*:[ ]*"[^"]+"' "$CFG" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1; }

# semver-сравнение: echo 1 если $1 > $2, иначе 0. Формат X.Y.Z.
_ver_gt(){
    a1=$(echo "$1" | cut -d. -f1); a2=$(echo "$1" | cut -d. -f2); a3=$(echo "$1" | cut -d. -f3)
    b1=$(echo "$2" | cut -d. -f1); b2=$(echo "$2" | cut -d. -f2); b3=$(echo "$2" | cut -d. -f3)
    a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}; b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
    [ "$a1" -gt "$b1" ] 2>/dev/null && { echo 1; return; }
    [ "$a1" -lt "$b1" ] 2>/dev/null && { echo 0; return; }
    [ "$a2" -gt "$b2" ] 2>/dev/null && { echo 1; return; }
    [ "$a2" -lt "$b2" ] 2>/dev/null && { echo 0; return; }
    [ "$a3" -gt "$b3" ] 2>/dev/null && { echo 1; return; }
    echo 0
}

# ── Самообновление апдейтера (§7b) ──────────────────────────────────────────
# Устраняет «лаг в одну версию». Апдейтер обновляет САМ СЕБЯ, но раньше делал это
# в СЕРЕДИНЕ наката — значит весь накат выполнялся СТАРЫМ кодом, а исправления
# самого апдейтера вступали в силу только со следующего раза. Критичный фикс
# (напр. самоперезаписи через cp) приходилось подкладывать на машину руками.
#
# Теперь: ДО того как что-либо изменить (до lock, бэкапа и маркера) тянем из
# канала ТОЛЬКО gateway-update.sh, сверяем с собой и, если отличается, атомарно
# ставим и перезапускаемся через exec. Дальше накат идёт уже под новым кодом.
#
# Почему это безопасно:
#   * происходит до любых разрушающих действий — полу-состояния не возникнет;
#   * кандидат проверяется `sh -n` перед установкой (битый файл не поставится);
#   * нет сети / канал недоступен — молча идём дальше на текущей версии;
#   * защита от зацикливания через GW_UPDATE_REEXEC;
#   * прежняя версия сохраняется рядом как .prev (на случай разбора полётов);
#   * ROLLBACK сюда НЕ заходит — путь восстановления обязан работать на том, что
#     уже лежит на диске, и не зависеть от сети.
_self_update(){
    [ "${GW_UPDATE_REEXEC:-0}" = "1" ] && return 0
    # GW_UPDATE_SELF — шов для тестов (в бою всегда путь по умолчанию)
    self="${GW_UPDATE_SELF:-/usr/local/bin/gateway-update.sh}"
    [ -f "$self" ] || return 0
    ch=$(_channel); [ -n "$ch" ] || ch="$CHANNEL_DEFAULT"
    cand=/run/awg-setup/gateway-update.sh.candidate
    url="https://raw.githubusercontent.com/$REPO/$ch/rootfs-overlay/usr/local/bin/gateway-update.sh"
    curl -fsSL --max-time 25 "$url" -o "$cand" 2>/dev/null || return 0
    [ -s "$cand" ] || { rm -f "$cand"; return 0; }
    if ! sh -n "$cand" 2>/dev/null; then
        _log "самообновление: кандидат не проходит sh -n — игнорирую"
        rm -f "$cand"; return 0
    fi
    if cmp -s "$cand" "$self"; then rm -f "$cand"; return 0; fi

    tmp="$self.new.$$"
    cp -a "$self" "$self.prev" 2>/dev/null
    cp -a "$cand" "$tmp" 2>/dev/null || { rm -f "$cand"; return 0; }
    chmod +x "$tmp" 2>/dev/null
    mv -f "$tmp" "$self" 2>/dev/null || { rm -f "$tmp" "$cand"; return 0; }
    rm -f "$cand"
    _log "самообновление: апдейтер обновлён из канала $ch, перезапускаюсь под новым кодом"
    GW_UPDATE_REEXEC=1; export GW_UPDATE_REEXEC
    exec "$self" "$@"
}

# ── Требования к хосту (§7a) ────────────────────────────────────────────────
# Синкает то, что раньше умела только сборка .img: apt-пакеты, включение юнитов,
# файлы-предпосылки. Источник — /opt/gateway/host-requirements.list, тот же файл
# читает Dockerfile, поэтому списки не расходятся.
#
# Почему это нужно: in-place накат синкает лишь код, конфиги и образы. Из-за этого
# на машинах, обновлённых по каналу, отсутствовал fail2ban — jail.local приезжал,
# а демона не было, и `systemctl restart fail2ban` молча ничего не находил.
_sync_host_requirements(){
    REQ="$GW_DIR/host-requirements.list"
    [ -f "$REQ" ] || { _log "требования: $REQ отсутствует — пропуск"; return 0; }

    # 1) файлы-предпосылки. ДО пакетов: демон может стартовать сразу из postinst,
    #    а жиле fail2ban [gateway-panel] нужен существующий лог, иначе не поднимется.
    sed -n 's/^file[[:space:]][[:space:]]*//p' "$REQ" | while read -r fpath fmode; do
        [ -n "$fpath" ] || continue
        [ -e "$fpath" ] || : > "$fpath"
        [ -n "$fmode" ] && chmod "$fmode" "$fpath" 2>/dev/null
    done

    # 2) пакеты — ТОЛЬКО отсутствующие. `apt-get upgrade` не зовём никогда: накат
    #    шлюза не должен превращаться в обновление всей ОС.
    missing=""
    for p in $(sed -n 's/^pkg[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$REQ") \
             $(sed -n 's/^pkg-docker[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$REQ"); do
        dpkg-query -W -f='${Status}' "$p" 2>/dev/null \
            | grep -q '^install ok installed$' || missing="$missing $p"
    done
    if [ -n "$missing" ]; then
        _log "требования: не хватает пакетов:$missing"
        DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
        if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing >/dev/null 2>&1; then
            _log "требования: доустановлено:$missing"
        else
            # Накат НЕ откатываем: пакеты аддитивны, код и образы уже рабочие, а
            # недоступное зеркало не повод терять исправную версию. Недостача
            # видна в панели — gateway-selfcheck.sh отдаёт её как WARN.
            _log "требования: ВНИМАНИЕ — не установились:$missing (накат продолжен)"
        fi
    else
        _log "требования: все пакеты на месте"
    fi

    # 3) юниты: включаем весь объявленный набор, таймеры ещё и запускаем — иначе
    #    добавленный апдейтом таймер заработал бы только после ребута.
    for u in $(sed -n 's/^\(unit\|timer\)[[:space:]][[:space:]]*\([^[:space:]]*\).*/\2/p' "$REQ"); do
        systemctl enable "$u" >/dev/null 2>&1
    done
    for t in $(sed -n 's/^timer[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$REQ"); do
        systemctl start "$t" >/dev/null 2>&1
    done
    _log "требования: юниты включены, таймеры запущены"
}

# Достаём поле из manifest. Предпочитаем python3 (надёжно), иначе grep.
_mf(){ # $1=manifest-file $2=jq-подобный путь: version | images.<svc>
    f="$1"; key="$2"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$f" "$key" <<'PY' 2>/dev/null
import json,sys
d=json.load(open(sys.argv[1])); key=sys.argv[2]; cur=d
for p in key.split('.'):
    cur=cur.get(p) if isinstance(cur,dict) else None
print(cur if cur is not None else "")
PY
    else
        case "$key" in
            images.*) svc=${key#images.}; grep -oE "\"$svc\"[ ]*:[ ]*\"[^\"]+\"" "$f" | sed 's/.*"\([^"]*\)"$/\1/' | head -1 ;;
            *) grep -oE "\"$key\"[ ]*:[ ]*\"[^\"]+\"" "$f" | sed 's/.*"\([^"]*\)"$/\1/' | head -1 ;;
        esac
    fi
}

MANIFEST=/run/awg-setup/manifest.json
_fetch_manifest(){
    ch=$(_channel); [ -n "$ch" ] || ch="$CHANNEL_DEFAULT"
    url="https://raw.githubusercontent.com/$REPO/$ch/manifest.json"
    curl -fsSL --max-time 20 "$url" -o "$MANIFEST" 2>/dev/null
}

# ─────────────────────────── CHECK ───────────────────────────
do_check(){
    CUR_VER=$(_cur_version)
    if ! _fetch_manifest; then
        _log "CHECK: манифест недоступен (нет сети/канала)"
        _status check error "Канал обновлений недоступен"
        return 2
    fi
    NEW_VER=$(_mf "$MANIFEST" version)
    [ -n "$NEW_VER" ] || { _status check error "Манифест без version"; return 2; }
    if [ "$(_ver_gt "$NEW_VER" "$CUR_VER")" = "1" ]; then
        cl=$(_mf "$MANIFEST" changelog)
        _log "CHECK: доступно $NEW_VER (текущая $CUR_VER)"
        cat > "$STATUS" <<EOF
{"stage":"check","state":"available","message":"Доступно обновление $NEW_VER","from":"$CUR_VER","to":"$NEW_VER","changelog":"$(echo "$cl" | sed 's/"/\\"/g')","ts":"$(date -Iseconds)"}
EOF
        return 0
    fi
    _log "CHECK: актуально ($CUR_VER)"
    _status check ok "Установлена актуальная версия $CUR_VER"
    return 1
}

# ─────────────────────────── ROLLBACK ───────────────────────────
do_rollback(){ # $1=на каком этапе упали (для сообщения), $2=каталог бэкапа этого наката
    stage="${1:-manual}"; backup_dir="${2:-}"
    _log "ROLLBACK: старт (повод: ошибка на $stage)"
    _status rollback running "Откат после ошибки на этапе $stage"
    # 1) образы: :rollback → :latest
    for s in $SERVICES; do
        if docker image inspect "gateway-$s:rollback" >/dev/null 2>&1; then
            docker tag "gateway-$s:rollback" "gateway-$s:latest" 2>/dev/null
        fi
    done
    # 2) код: вернуть /opt/gateway из бэкапа этого наката (если снимали дерево)
    if [ -n "$backup_dir" ] && [ -f "$backup_dir/gateway-tree.tar.gz" ]; then
        rm -rf "$GW_DIR.tmp" 2>/dev/null
        ( cd / && tar xzf "$backup_dir/gateway-tree.tar.gz" ) 2>/dev/null && _log "ROLLBACK: /opt/gateway восстановлен"
    fi
    # 3) состояние §6 — побайтово из бэкапа этого же наката
    if [ -n "$backup_dir" ] && [ -f "$backup_dir/state.tar.gz" ]; then
        gateway-restore.sh "$backup_dir" >/dev/null 2>&1 || true
    fi
    # 4) ПЕРЕСОЗДАЁМ контейнеры из откатанного :latest. ВАЖНО: gateway-restore.sh
    #    делает `docker restart`, который НЕ перечитывает тег (образы остались бы
    #    новыми). `compose up -d` пересоздаёт контейнер при смене image ID тега —
    #    только так откат реально возвращает прежние образы.
    ( cd "$GW_DIR" && docker compose up -d ) >/dev/null 2>&1 || true
    sleep 6
    # 5) вернуть метку версии к версии из бэкапа — иначе после отката .version
    #    останется новой и CHECK не предложит обновление снова. Берём из meta.json.
    if [ -n "$backup_dir" ] && [ -f "$backup_dir/meta.json" ]; then
        rb_ver=$(grep -oE '"version"[ ]*:[ ]*"[^"]+"' "$backup_dir/meta.json" | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
        # пишем только настоящий semver X.Y.Z (не служебные метки вроде «safety»)
        if echo "$rb_ver" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "$rb_ver" > "$VERSION_FILE"; CUR_VER="$rb_ver"
        fi
    fi
    # 6) снять маркер
    rm -f "$MARKER" 2>/dev/null
    # 7) проверить, что прод вернулся
    if gateway-selfcheck.sh >/dev/null 2>&1; then
        _log "ROLLBACK: завершён, прод восстановлен (был на $stage), версия $CUR_VER"
        _status rollback ok "Обновление не удалось (этап $stage). Откат выполнен, версия $CUR_VER"
    else
        _log "ROLLBACK: ВНИМАНИЕ — selfcheck после отката не зелёный!"
        _status rollback error "Откат выполнен, но самодиагностика не зелёная — проверьте шлюз"
    fi
    return 0
}

# ─────────────────────────── APPLY (полный накат) ───────────────────────────
do_apply(){
    CUR_VER=$(_cur_version)
    # lock от параллельного запуска
    if ! ( set -o noclobber; echo $$ > "$LOCK" ) 2>/dev/null; then
        _log "APPLY: уже идёт обновление (lock) — выход"; _status preflight error "Обновление уже выполняется"; return 1
    fi
    trap 'rm -f "$LOCK"' EXIT

    # CHECK
    _status check running "Проверка наличия обновления"
    if ! _fetch_manifest; then _status check error "Канал недоступен"; rm -f "$LOCK"; return 2; fi
    NEW_VER=$(_mf "$MANIFEST" version)
    if [ -z "$NEW_VER" ] || [ "$(_ver_gt "$NEW_VER" "$CUR_VER")" != "1" ]; then
        _log "APPLY: нет новой версии ($CUR_VER)"; _status check ok "Актуально ($CUR_VER)"; rm -f "$LOCK"; return 1
    fi
    MIN_FROM=$(_mf "$MANIFEST" min_from_version)
    if [ -n "$MIN_FROM" ] && [ "$(_ver_gt "$MIN_FROM" "$CUR_VER")" = "1" ]; then
        _log "APPLY: текущая $CUR_VER ниже min_from_version $MIN_FROM — прямой апгрейд невозможен"
        _status preflight error "Нужна промежуточная версия (min_from $MIN_FROM)"; rm -f "$LOCK"; return 1
    fi
    _log "APPLY: $CUR_VER → $NEW_VER"

    # PREFLIGHT
    _status preflight running "Проверки перед накатом"
    if ! docker info >/dev/null 2>&1; then _status preflight error "Docker недоступен"; rm -f "$LOCK"; return 1; fi
    free_mb=$(df -Pm /opt 2>/dev/null | awk 'NR==2{print $4}')
    if [ -n "$free_mb" ] && [ "$free_mb" -lt 500 ] 2>/dev/null; then
        _status preflight error "Мало места на /opt (${free_mb}MB < 500MB)"; rm -f "$LOCK"; return 1
    fi
    # digest-ы образов из манифеста
    for s in $SERVICES; do
        d=$(_mf "$MANIFEST" "images.gateway-$s")
        [ -n "$d" ] || { _log "APPLY: в манифесте нет digest для gateway-$s"; _status preflight error "Манифест неполный (нет $s)"; rm -f "$LOCK"; return 1; }
        eval "DIGEST_$s=\$d"
    done

    # BACKUP (порядок критичен: сначала НОВАЯ страховка, старую чистим на CLEANUP)
    _status backup running "Резервное копирование перед накатом"
    BDIR=$(gateway-backup.sh update "$CUR_VER" 2>/dev/null | tail -1)
    if [ -z "$BDIR" ] || [ ! -d "$BDIR" ]; then
        _log "APPLY: бэкап не удался — накат НЕ начинаем"; _status backup error "Бэкап не удался, накат отменён"; rm -f "$LOCK"; return 1
    fi
    # снимок текущего дерева /opt/gateway (для отката кода)
    ( cd / && tar czf "$BDIR/gateway-tree.tar.gz" opt/gateway ) 2>/dev/null || true
    # запоминаем ID образа N-2 (бывший :rollback) для последующей зачистки
    OLD_GEN=""
    for s in $SERVICES; do
        id=$(docker image inspect -f '{{.Id}}' "gateway-$s:rollback" 2>/dev/null)
        [ -n "$id" ] && OLD_GEN="$OLD_GEN $id"
    done
    # текущие РАБОЧИЕ образы → :rollback (перебивает старый тег, N-1 становится страховкой)
    for s in $SERVICES; do
        docker tag "gateway-$s:latest" "gateway-$s:rollback" 2>/dev/null
    done
    # dead-man маркер
    printf '{"from":"%s","to":"%s","ts":"%s","backup":"%s"}\n' "$CUR_VER" "$NEW_VER" "$(date -Iseconds)" "$BDIR" > "$MARKER"
    _log "APPLY: бэкап $BDIR, :rollback помечен, маркер выставлен"

    # CLEANUP (теперь безопасно: новая страховка готова, чистим осиротевший N-2)
    _status cleanup running "Очистка прошлого поколения"
    GW_KEEP_BACKUPS="$(grep -oE '"keep_backups"[ ]*:[ ]*[0-9]+' "$CFG" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
    export GW_KEEP_BACKUPS="${GW_KEEP_BACKUPS:-3}"
    gateway-prune.sh $OLD_GEN >/dev/null 2>&1 || _log "APPLY: prune вернул ошибку (не критично)"

    # APPLY: код из ветки-канала + образы по digest
    _status apply running "Загрузка кода и образов $NEW_VER"
    ch=$(_channel); [ -n "$ch" ] || ch="$CHANNEL_DEFAULT"
    rm -rf "$STAGING" 2>/dev/null; mkdir -p "$STAGING"
    # тянем тарбол ветки-канала (git не требуется)
    if ! curl -fsSL --max-time 60 "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ch" \
            | tar xz -C "$STAGING" --strip-components=1 2>/dev/null; then
        _log "APPLY: не скачался код ветки $ch — откат"; do_rollback "APPLY:fetch-code" "$BDIR"; rm -f "$LOCK"; return 1
    fi
    # тянем образы по digest и ретегаем в :latest, который ждёт compose
    for s in $SERVICES; do
        eval "dg=\$DIGEST_$s"
        if ! docker pull "$dg" >/dev/null 2>&1; then
            _log "APPLY: docker pull $dg не удался — откат"; do_rollback "APPLY:pull-$s" "$BDIR"; rm -f "$LOCK"; return 1
        fi
        docker tag "$dg" "gateway-$s:latest" 2>/dev/null
    done
    # синхронизируем дерево кода (compose/конфиги/скрипты сервисов) поверх /opt/gateway
    if [ -d "$STAGING/gateway" ]; then
        cp -a "$STAGING/gateway/." "$GW_DIR/" 2>/dev/null
    fi
    # host-скрипты из rootfs-overlay — по одному, через временный файл и mv.
    #
    # ВАЖНО: НЕ `cp` поверх. Этот скрипт обновляет САМ СЕБЯ, а `cp` открывает цель
    # с O_TRUNC и пишет в ТОТ ЖЕ инод. sh (dash) читает скрипт порциями по ходу
    # выполнения — то есть работающий процесс дочитал бы уже искорёженный хвост и
    # рухнул на середине наката. `mv` — это rename(2): инод подменяется атомарно,
    # старый остаётся живым, пока его держит открытым работающий процесс, и тот
    # спокойно дочитывает свою прежнюю копию до конца.
    if [ -d "$STAGING/rootfs-overlay/usr/local/bin" ]; then
        for src in "$STAGING/rootfs-overlay/usr/local/bin/"*; do
            [ -f "$src" ] || continue
            dst="/usr/local/bin/$(basename "$src")"
            tmp="$dst.new.$$"
            cp -a "$src" "$tmp" 2>/dev/null || continue
            chmod +x "$tmp" 2>/dev/null
            mv -f "$tmp" "$dst" 2>/dev/null || rm -f "$tmp" 2>/dev/null
        done
    fi
    # systemd-юниты из rootfs-overlay — копируем; включение делает
    # _sync_host_requirements по объявленному списку (тому же, что у Dockerfile).
    if [ -d "$STAGING/rootfs-overlay/etc/systemd/system" ]; then
        cp -a "$STAGING/rootfs-overlay/etc/systemd/system/." /etc/systemd/system/ 2>/dev/null
        chmod 644 /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null
        systemctl daemon-reload 2>/dev/null
    fi
    # Требования к хосту: пакеты + юниты + файлы-предпосылки. Идёт ПОСЛЕ синка
    # /opt/gateway (файл требований приезжает оттуда) и ДО конфигов fail2ban ниже,
    # чтобы демон уже существовал к моменту, когда ему подкладывают jail.local.
    _status apply running "Проверка требований к хосту (пакеты, юниты)"
    _sync_host_requirements
    # host-конфиги безопасности из rootfs-overlay (sshd-порт, fail2ban) + переприменение
    # фаервола. Без этого security-фичи (нестандартный SSH-порт, fail2ban, закрытие WAN)
    # не активируются на уже РАЗВЁРНУТОМ шлюзе без ребута — только на свежем .img.
    if [ -d "$STAGING/rootfs-overlay/etc/ssh/sshd_config.d" ]; then
        cp -a "$STAGING/rootfs-overlay/etc/ssh/sshd_config.d/." /etc/ssh/sshd_config.d/ 2>/dev/null
        sshd -t 2>/dev/null && systemctl reload ssh 2>/dev/null || systemctl restart ssh 2>/dev/null
    fi
    if [ -d "$STAGING/rootfs-overlay/etc/fail2ban" ]; then
        cp -a "$STAGING/rootfs-overlay/etc/fail2ban/." /etc/fail2ban/ 2>/dev/null
        systemctl restart fail2ban >/dev/null 2>&1 || true
    fi
    [ -x /usr/local/bin/gw-firewall.sh ] && /usr/local/bin/gw-firewall.sh >/dev/null 2>&1 || true

    ( cd "$GW_DIR" && docker compose up -d ) >/dev/null 2>&1
    sleep 8

    # HEALTH-GATE (таймбокс)
    _status health running "Самодиагностика после наката"
    ok=0
    i=0
    while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
        if gateway-selfcheck.sh >/run/awg-setup/selfcheck.out 2>&1; then ok=1; break; fi
        i=$((i+10)); sleep 10
    done
    if [ "$ok" != "1" ]; then
        reason=$(grep -E '^FAIL:' /run/awg-setup/selfcheck.out 2>/dev/null | tail -1 | sed 's/^FAIL: //')
        _log "APPLY: health-gate провален ($reason) — откат"
        do_rollback "HEALTH-GATE:${reason:-unknown}" "$BDIR"; rm -f "$LOCK"; return 1
    fi

    # COMMIT
    echo "$NEW_VER" > "$VERSION_FILE"
    rm -f "$MARKER" 2>/dev/null
    _log "COMMIT: обновлено до $NEW_VER (страховка :rollback=$CUR_VER сохранена)"
    cat > "$STATUS" <<EOF
{"stage":"commit","state":"ok","message":"Обновлено до $NEW_VER","from":"$CUR_VER","to":"$NEW_VER","ts":"$(date -Iseconds)"}
EOF
    rm -f "$LOCK"; trap - EXIT
    return 0
}

# Самый свежий РЕАЛЬНЫЙ восстановительный бэкап (update/manual/cron), НЕ
# pre-restore-страховку (её создаёт gateway-restore.sh при каждом восстановлении —
# иначе откат целился бы в неё, а версия там фиктивная «safety»).
_last_restore_point(){
    for d in $(ls -1dt "$BK"/*/ 2>/dev/null); do
        r=$(grep -oE '"reason"[ ]*:[ ]*"[^"]+"' "$d/meta.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
        case "$r" in restore-safety|pre-restore) continue ;; esac
        [ -f "$d/state.tar.gz" ] && { echo "${d%/}"; return; }
    done
}

case "${1:-check}" in
    check)    do_check ;;
    # Перед накатом подтягиваем свежую версию САМОГО апдейтера и перезапускаемся
    # под ней (§7b) — иначе накат шёл бы старым кодом, а фиксы апдейтера
    # применялись бы только со следующего раза. Если exec произошёл, управление
    # сюда уже не вернётся. ROLLBACK намеренно идёт мимо: путь восстановления не
    # должен зависеть от сети и обязан работать на том, что лежит на диске.
    apply)    _self_update "$@"; do_apply ;;
    rollback) CUR_VER=$(_cur_version); do_rollback "manual" "$(_last_restore_point)" ;;
    *) echo "usage: gateway-update.sh {check|apply|rollback}"; exit 2 ;;
esac
