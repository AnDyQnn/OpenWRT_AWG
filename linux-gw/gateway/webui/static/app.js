// ── Навигация ──
document.querySelectorAll('.topbar nav a[data-tab]').forEach(a => {
    a.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.topbar nav a').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        document.getElementById('tab-' + a.dataset.tab).classList.add('active');
        document.querySelector('.topbar nav').classList.remove('show');
        if (a.dataset.tab === 'docs' && !_docsLoaded) { _docsLoaded = true; loadDoc('README.md'); }
        if (a.dataset.tab === 'logs') loadNetlog();
    });
});
document.getElementById('nav-toggle').addEventListener('click', () => {
    document.querySelector('.topbar nav').classList.toggle('show');
});

// ── Часы ──
setInterval(() => {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString('ru-RU');
}, 1000);

// ── Хелперы ──
const $ = id => document.getElementById(id);
const fmtBytes = b => {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB','TB']; let i = 0; b = +b;
    while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + u[i];
};
async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) { window.location.href = '/login'; return null; }
    return r.json();
}

// ── Уведомления (тосты) вместо браузерных alert ──
// opts.onClick — делает тост кликабельным (клик закрывает его и вызывает колбэк).
// opts.hint    — вторая строка помельче, для подсказки «нажмите, чтобы…».
function toast(msg, type = 'info', ms = 3800, opts = null) {
    const w = document.getElementById('toast-wrap'); if (!w) return;
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    if (opts && opts.hint) {
        const h = document.createElement('span');
        h.className = 'nag-hint'; h.textContent = opts.hint;
        t.appendChild(h);
    }
    if (opts && typeof opts.onClick === 'function') {
        t.classList.add('nag');
        t.addEventListener('click', () => { t.remove(); opts.onClick(); });
    }
    w.appendChild(t);
    setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 400); }, ms);
}
// ── Модалка подтверждения вместо браузерного confirm ──
function uiConfirm(msg, okLabel = 'Удалить') {
    return new Promise(resolve => {
        const back = document.getElementById('modal-back');
        document.getElementById('modal-msg').textContent = msg;
        const ok = document.getElementById('modal-ok'), cancel = document.getElementById('modal-cancel');
        ok.textContent = okLabel;
        back.style.display = 'flex';
        const done = v => { back.style.display = 'none'; ok.onclick = cancel.onclick = back.onclick = null; resolve(v); };
        ok.onclick = () => done(true);
        cancel.onclick = () => done(false);
        back.onclick = e => { if (e.target === back) done(false); };
    });
}

// модальный ввод (для сброса пароля/удаления учёток с подтверждением)
function uiPrompt(title, msg, type = 'text', okLabel = 'OK') {
    return new Promise(resolve => {
        const back = document.getElementById('modal-back');
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-msg').textContent = msg;
        const inp = document.getElementById('modal-input');
        inp.type = type; inp.value = ''; inp.style.display = 'block';
        const ok = document.getElementById('modal-ok'), cancel = document.getElementById('modal-cancel');
        ok.textContent = okLabel; ok.classList.remove('danger'); ok.classList.add('success');
        back.style.display = 'flex'; setTimeout(() => inp.focus(), 50);
        const done = v => {
            back.style.display = 'none'; inp.style.display = 'none';
            ok.classList.remove('success'); ok.classList.add('danger');
            ok.onclick = cancel.onclick = back.onclick = inp.onkeydown = null;
            document.getElementById('modal-title').textContent = 'Подтверждение';
            resolve(v);
        };
        ok.onclick = () => done(inp.value);
        cancel.onclick = () => done(null);
        back.onclick = e => { if (e.target === back) done(null); };
        inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } };
    });
}

// уровень загрузки полосы по проценту (цвет/градиент задаёт CSS-класс)
function _barLevel(id, pct) {
    const el = $(id); if (!el) return;
    el.style.width = (pct || 0) + '%';
    el.classList.remove('warn', 'bad');
    if (pct > 85) el.classList.add('bad'); else if (pct > 60) el.classList.add('warn');
}

// ── Система ──
async function loadSystem() {
    const d = await api('/api/system'); if (!d) return;
    $('sys-host').textContent = d.hostname;
    $('sys-uptime').textContent = d.uptime;
    $('sys-cpu').textContent = d.cpu_pct + '%';
    $('sys-load').textContent = d.load;
    _barLevel('mem-bar', d.ram_pct);
    $('mem-text').textContent = `${d.ram_used_mb} / ${d.ram_total_mb} МБ (${d.ram_pct}%)`;
    _barLevel('disk-bar', d.disk_pct);
    $('disk-text').textContent = `${d.disk_used_gb} / ${d.disk_total_gb} ГБ (${d.disk_pct}%)`;
    // KPI дашборда — железо
    $('kpi-cpu').textContent = d.cpu_pct + '%';
    $('kpi-mem').textContent = d.ram_pct + '%';
    _push('cpu', d.cpu_pct); _push('mem', d.ram_pct);
    _spark('spark-cpu', _hist.cpu, '#58a6ff', 100);
    _spark('spark-mem', _hist.mem, '#a371f7', 100);
    // температура (на железе есть, в VM часто нет)
    if (d.cpu_temp != null) {
        $('kpi-temp').textContent = d.cpu_temp + '°C';
        _push('temp', d.cpu_temp); _spark('spark-temp', _hist.temp, '#e3b341');
    } else {
        $('kpi-temp').textContent = 'н/д';
    }
    // дисковый I/O — скорость чтения/записи по приросту счётчиков
    const nowd = Date.now();
    if (_prevDisk && (d.disk_read_bytes || d.disk_write_bytes)) {
        const dt = (nowd - _prevDisk.t) / 1000;
        if (dt > 0.5) {
            const rd = Math.max(0, (d.disk_read_bytes - _prevDisk.r) / dt);
            const wr = Math.max(0, (d.disk_write_bytes - _prevDisk.w) / dt);
            $('kpi-disk').textContent = `↓ ${fmtRate(rd)} ↑ ${fmtRate(wr)}`;
            _push('disk', rd + wr); _spark('spark-disk', _hist.disk, '#3fb950');
        }
    }
    _prevDisk = { r: d.disk_read_bytes, w: d.disk_write_bytes, t: nowd };
}

// ── Сеть ──
// Живая скорость = прирост байт между опросами / время. Реальные цифры, не link-speed.
let _prevNet = {};
const fmtRate = bps => fmtBytes(bps) + '/s';
async function loadNetwork() {
    const d = await api('/api/network'); if (!d) return;
    $('ov-wan').textContent = d.wan || '—';
    const tbody = $('netif-body'); tbody.innerHTML = '';
    const now = Date.now();
    const cur = {};
    let wanRate = '', wanTotal = null, vpnRate = '', vpnTotal = null, lanRx = 0, lanTx = 0, lanSeen = false;
    d.interfaces.forEach(i => {
        let role = '—', cls = '';
        if (i.is_wan) { role = 'WAN'; cls = 'role-wan'; }
        else if (i.is_lan) { role = i.is_lan_member ? 'LAN-порт' : 'LAN'; cls = 'role-lan'; }
        else if (i.is_vpn) { role = 'VPN'; cls = 'role-vpn'; }

        cur[i.name] = { rx: i.rx_bytes, tx: i.tx_bytes, t: now };
        let rate = '<span class="small">измеряю…</span>';
        const p = _prevNet[i.name];
        if (p) {
            const dt = (now - p.t) / 1000;
            if (dt > 0.5) {
                const dr = Math.max(0, (i.rx_bytes - p.rx) / dt);
                const dx = Math.max(0, (i.tx_bytes - p.tx) / dt);
                rate = `<span style="color:var(--good)">↓ ${fmtRate(dr)}</span> <span style="color:var(--accent)">↑ ${fmtRate(dx)}</span>`;
                if (i.is_wan) { wanRate = `↓ ${fmtRate(dr)} ↑ ${fmtRate(dx)}`; wanTotal = dr + dx; }
                if (i.is_vpn) { vpnRate = `↓ ${fmtRate(dr)} ↑ ${fmtRate(dx)}`; vpnTotal = dr + dx; }
                if (i.is_lan_member) { lanRx += dr; lanTx += dx; lanSeen = true; }
            }
        }
        const tr = document.createElement('tr');
        tr.innerHTML = `<td data-label="Интерфейс">${_esc(i.name)}</td><td class="${cls}" data-label="Роль">${role}</td><td data-label="IP">${_esc(i.ip)||'—'}</td>
            <td data-label="Статус">${i.up?'<span style="color:var(--good)">up</span>':'<span style="color:var(--muted)">down</span>'}</td>
            <td data-label="Скорость (сейчас)">${rate}</td>
            <td data-label="↓ RX всего">${fmtBytes(i.rx_bytes)}</td><td data-label="↑ TX всего">${fmtBytes(i.tx_bytes)}</td>`;
        tbody.appendChild(tr);
        if (i.is_wan) $('ov-wan-ip').textContent = i.ip || '—';
        if (i.is_lan) $('ov-lan-ip').textContent = i.ip || '—';
    });
    _prevNet = cur;
    if (wanTotal !== null) {
        $('kpi-net').textContent = wanRate || '—';
        _push('net', wanTotal); _spark('spark-net', _hist.net, '#3fb950');
    }
    if (vpnTotal !== null) {
        $('kpi-vpn').textContent = vpnRate || '—';
        _push('vpn', vpnTotal); _spark('spark-vpn', _hist.vpn, '#a371f7');
    } else { $('kpi-vpn').textContent = 'выкл'; }
    if (lanSeen) {
        $('kpi-lan').textContent = `↓ ${fmtRate(lanRx)} ↑ ${fmtRate(lanTx)}`;
        _push('lan', lanRx + lanTx); _spark('spark-lan', _hist.lan, '#58a6ff');
    } else { $('kpi-lan').textContent = '—'; }
}

// ── Распределение скорости (QoS) ──
// Поля формы заполняем только при первой загрузке и после замера/сохранения —
// иначе 5-секундный refresh затирал бы то, что пользователь сейчас вводит.
let _qosFilled = false, _qosPoll = null;
function _qosFill(c) {
    $('qos-vd').value = c.vpn_down || ''; $('qos-vu').value = c.vpn_up || '';
    $('qos-wd').value = c.wan_down || ''; $('qos-wu').value = c.wan_up || '';
    $('qos-en').checked = !!c.enabled; _qosFilled = true;
}
async function loadQos(force = false) {
    if (!$('qos-card')) return;
    const d = await api('/api/qos');
    if (!d || d.error) { $('qos-card').style.display = 'none'; return; }
    $('qos-card').style.display = '';
    const c = d.config || {}, s = d.status || {}, m = d.measure || {};
    if (!_qosFilled || force) _qosFill(c);
    let dot = 'off', txt = 'выключено';
    if (c.enabled && s.active) { dot = 'on'; txt = 'включено'; }
    else if (c.enabled) { dot = 'warn'; txt = 'включено, применяется…'; }
    if (s.note && c.enabled) txt += ' · ' + s.note;
    $('qos-dot').className = 'dot ' + dot; $('qos-state').textContent = txt;
    const el = $('qos-measure');
    const mb = v => (v ? v + ' Мбит/с' : '—');
    if (m.state === 'running') {
        el.innerHTML = `<span style="color:var(--warn)">Идёт замер: ${_esc(m.step || '')}…</span>`;
        if (!_qosPoll) _qosPoll = setInterval(() => loadQos(), 2000);
    } else {
        if (_qosPoll) { clearInterval(_qosPoll); _qosPoll = null; _qosFill(c); }
        if (m.state === 'done')
            el.innerHTML = `Последний замер (${_esc(m.at || '')}): через VPN ↓ ${mb(m.vpn_down)} ↑ ${mb(m.vpn_up)} · напрямую ↓ ${mb(m.wan_down)} ↑ ${mb(m.wan_up)}`;
        else if (m.state === 'error')
            el.innerHTML = `<span style="color:var(--bad)">Замер не удался: ${_esc(m.step || '')}</span>`;
        else el.textContent = '';
    }
}
async function qosMeasure(enable) {
    const msg = enable
        ? 'Измерить скорость канала и включить распределение? Около минуты канал будет занят замером.'
        : 'Измерить скорость канала? Около минуты канал будет занят замером. Настройки не изменятся.';
    if (!await uiConfirm(msg, 'Измерить')) return;
    const r = await fetch('/api/qos/measure', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enable }) });
    const d = await r.json();
    if (d.ok) { toast('Замер запущен…', 'warn', 4000); loadQos(); }
    else toast(d.error || 'ошибка', 'bad');
}
async function qosSave() {
    const n = id => Math.max(0, parseInt($(id).value || '0', 10) || 0);
    const body = { enabled: $('qos-en').checked, vpn_down: n('qos-vd'), vpn_up: n('qos-vu'),
                   wan_down: n('qos-wd'), wan_up: n('qos-wu') };
    const r = await fetch('/api/qos', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { toast(body.enabled ? 'Распределение скорости включено' : 'Распределение скорости выключено', 'ok'); _qosFill(d.config); setTimeout(loadQos, 1500); }
    else toast(d.error || 'ошибка', 'bad');
}

// ── VPN ──
async function loadVpn() {
    const d = await api('/api/vpn'); if (!d) return;
    const modeText = {vpn:'VPN активен', fallback:'Прямой (failover)', manual_off:'Выключен вручную', no_config:'Нет конфига'}[d.mode] || d.mode;
    $('ov-vpn-mode').textContent = modeText;
    $('vpn-mode').textContent = modeText;
    $('ov-vpn-endpoint').textContent = d.endpoint || '—';
    $('vpn-endpoint').textContent = d.endpoint || '—';
    $('ov-vpn-ip').textContent = d.tunnel_ip || '—';
    $('vpn-ip').textContent = d.tunnel_ip || '—';
    $('vpn-transfer').textContent = d.transfer || '—';
    const hs = d.handshake_age >= 0 ? d.handshake_age + ' сек назад' : '—';
    $('ov-vpn-hs').textContent = hs;
    $('vpn-hs').textContent = d.handshake || hs;
    $('vpn-connected').textContent = d.connected ? 'Да' : 'Нет';
    let dotClass = 'off';
    if (d.connected) dotClass = 'ok';
    else if (d.mode === 'fallback') dotClass = 'warn';
    else if (d.up) dotClass = 'warn';
    else if (d.configured) dotClass = 'bad';
    $('vpn-dot').className = 'dot ' + dotClass;
    $('vpn-dot2').className = 'dot ' + dotClass;
}

async function vpnAction(action) {
    await api('/api/vpn/' + action, {method:'POST'});
    setTimeout(loadVpn, 1500);
}
async function vpnMode(mode) {
    await api('/api/vpn/mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode})});
    setTimeout(loadVpn, 1500);
}

// ── Загрузка конфига: файл / текст ──
const drop = $('drop'), fileInput = $('conf-file');
['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) uploadConf(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', e => { if (e.target.files[0]) uploadConf(e.target.files[0]); });

function switchConfTab(which) {
    document.querySelectorAll('.tab-mini').forEach(b => b.classList.toggle('active', b.dataset.ct === which));
    document.querySelectorAll('.ct-pane').forEach(p => p.classList.remove('active'));
    $('ct-' + which).classList.add('active');
}

function _confResult(d) {
    if (d.ok) {
        $('conf-result').innerHTML = `<span style="color:var(--good)">✓ Применён</span> · IP: ${_esc(d.addr)} · Endpoint: ${_esc(d.endpoint)}` +
            (d.is_awg ? ` · <span style="color:var(--accent)">AmneziaWG</span>` : '');
        const ae = d.auto_extract || {};
        if (ae.added || ae.merged)
            toast(`Конфиг применён. Обход из ключа: +${ae.added||0} новых, схлопнуто ${ae.merged||0}`, 'ok', 5500);
        else
            toast('Конфиг применён', 'ok');
        setTimeout(() => { loadVpn(); loadAccess(); }, 2000);
    } else {
        $('conf-result').innerHTML = '';
        toast(d.detail || d.error || 'Ошибка применения конфига', 'bad', 5500);
    }
}

async function uploadConf(file) {
    const fd = new FormData(); fd.append('file', file);
    $('conf-result').textContent = 'Загрузка...';
    try {
        const r = await fetch('/api/vpn/config', {method:'POST', body:fd});
        _confResult(await r.json());
    } catch (e) { $('conf-result').innerHTML = '<span style="color:var(--bad)">Ошибка загрузки</span>'; }
}

async function applyConfText() {
    const cfg = $('conf-textarea').value.trim();
    if (!cfg) { $('conf-result').innerHTML = '<span style="color:var(--bad)">Поле пустое</span>'; return; }
    $('conf-result').textContent = 'Применяем...';
    try {
        const r = await fetch('/api/vpn/config-text', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({config: cfg})
        });
        _confResult(await r.json());
    } catch (e) { $('conf-result').innerHTML = '<span style="color:var(--bad)">Ошибка применения</span>'; }
}

async function loadCurrentConf() {
    const d = await api('/api/vpn/config-text');
    if (d) $('conf-textarea').value = d.config || '';
}

// ── Безопасность: смена пароля ──
let _meRole = 'user';
let _defWarned = false;
async function loadWhoami() {
    const d = await api('/api/security/whoami');
    if (!d) return;
    $('cur-user').textContent = d.username;
    _meRole = d.role || 'user';
    if (d.default_creds && !_defWarned) {
        _defWarned = true;
        toast('⚠ Используется пароль по умолчанию (admin). Смените его: Система → Безопасность → Учётные записи.', 'bad', 12000);
    }
    const ac = $('accounts-card');
    if (ac) { ac.style.display = _meRole === 'admin' ? 'block' : 'none'; if (_meRole === 'admin') loadUsers(); }
    const bc = $('backups-card');
    if (bc) { bc.style.display = _meRole === 'admin' ? 'block' : 'none'; if (_meRole === 'admin') loadBackups(); }
    const pc = $('power-card');
    if (pc) pc.style.display = _meRole === 'admin' ? 'block' : 'none';
    const ul = $('sys-update-link');
    if (ul) { ul.style.display = _meRole === 'admin' ? '' : 'none'; if (_meRole === 'admin') loadUpdate(); }
    const sshc = $('ssh-card');
    if (sshc) { sshc.style.display = _meRole === 'admin' ? 'block' : 'none'; if (_meRole === 'admin') loadSshPort(); }
    const consc = $('console-card');
    if (consc) { consc.style.display = _meRole === 'admin' ? 'block' : 'none'; if (_meRole === 'admin') loadSshKeys(); }
    const adm = _meRole === 'admin';
    ['sec-section', 'sec-kpi-row'].forEach(id => { const e = $(id); if (e) e.style.display = adm ? '' : 'none'; });
    if (adm) loadSecurityStats();
    // Роли: модератор видит только Дашборд / Журнал / Документация (метрики, журнал,
    // контакты). Управление (Сеть/VPN/Доступ/Консоль/Система) ему недоступно.
    const _modAllowed = ['overview', 'logs', 'docs'];
    document.querySelectorAll('.topbar nav a[data-tab]').forEach(a => {
        a.style.display = (adm || _modAllowed.includes(a.dataset.tab)) ? '' : 'none';
    });
    if (!adm) {
        const cur = document.querySelector('.topbar nav a.active');
        if (cur && !_modAllowed.includes(cur.dataset.tab)) {
            const ov = document.querySelector('.topbar nav a[data-tab="overview"]'); if (ov) ov.click();
        }
    }
}

// ── Безопасность: 4 плитки + баны на дашборде (только админ) ──
async function loadSecurityStats() {
    if (_meRole !== 'admin') return;
    const d = await api('/api/security/stats');
    if (!d || d.error) return;
    const map = { ok: ['var(--good)', 'Штатно', 'green'], warn: ['var(--warn)', 'Подозрение', 'amber'], alarm: ['var(--bad)', 'Атака', 'red'] };
    const [col, txt, acc] = map[d.level] || map.ok;
    const lvl = $('sec-level'); if (lvl) { lvl.textContent = txt; lvl.style.color = col; }
    const tile = $('sec-tile-state'); if (tile) tile.setAttribute('data-accent', acc);
    if ($('sec-banned')) $('sec-banned').textContent = d.banned_now;
    if ($('sec-drops')) $('sec-drops').textContent = d.wan_drops;
    if ($('sec-fails')) $('sec-fails').textContent = d.failed_logins;
    const bl = $('sec-banned-list');
    if (bl) {
        bl.style.display = '';
        if (d.banned_ips && d.banned_ips.length) {
            bl.innerHTML = `<div class="sec-line bad"><b>${GWFX.ic('bug')} Заблокированные адреса:</b>
                <span class="ban-chips">${d.banned_ips.map(ip => `<span class="ban-chip">${_esc(ip)}
                    <button class="mini" title="Разблокировать" onclick="secUnban('${_esc(ip)}')">${GWFX.ic('check')}</button></span>`).join('')}</span>
                <button class="mini" style="margin-left:.3rem" onclick="secUnbanAll()">Разблокировать все</button></div>
                <div class="small" style="opacity:.7;margin-top:.35rem">Внешние (публичные) адреса, с которых выполнялся подбор пароля. Подключения из локальной сети и по VPN блокировка <b>не затрагивает</b> — блокируются только внешние адреса.</div>`;
        } else if (d.level === 'alarm') {
            bl.innerHTML = `<div class="sec-line bad">${GWFX.ic('bug')} Идёт ${_esc(d.note || 'подбор пароля')} — ${(d.note || '').includes('своей сети') ? 'свои адреса (офис, VPN) автоматически не блокируются: проверьте, чьё это устройство или VPN-клиент' : 'адрес будет заблокирован автоматически'}. <a href="#" onclick="secEvents('logins');return false">Подробнее</a></div>`;
        } else if (d.level === 'warn') {
            bl.innerHTML = `<div class="sec-line warn">${GWFX.ic('warn')} ${_esc(d.note || 'Неудачные входы')}. <a href="#" onclick="secEvents('logins');return false">Подробнее</a></div>`;
        } else {
            bl.innerHTML = `<div class="sec-line ok">${GWFX.ic('check')} Атак не зафиксировано — всё спокойно.</div>`;
        }
    }
    if ($('sec-kpi-row')) GWFX.icons($('sec-kpi-row'));
    if ($('sec-banned-list')) GWFX.icons($('sec-banned-list'));
}
// Журнал безопасности: что стоит за цифрами плиток
async function secEvents(tab) {
    const box = $('sec-events'); if (!box) return;
    box.style.display = '';
    ['wan', 'logins'].forEach(t => { const b = $('sec-ev-tab-' + t); if (b) b.classList.toggle('success', t === tab); });
    const body = $('sec-ev-body'); body.innerHTML = 'Загружаю…';
    const d = await api('/api/security/events');
    if (!d || d.error) { body.textContent = (d && d.error) || 'ошибка'; return; }
    const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    if (tab === 'wan') {
        $('sec-ev-title').textContent = 'Отбито с интернета — за 7 дней';
        let h = `<p>Это попытки снаружи достучаться до <b>самого шлюза</b> (панель, SSH и т.п.). Фаервол их отбросил —
            до шлюза они не дошли. На интернет устройств в офисе это не влияет.</p>`;
        if (d.wan_noise_7d) h += `<p style="opacity:.75">Служебный шум сети провайдера (multicast/broadcast — роутер провайдера
            периодически опрашивает сеть) — ${d.wan_noise_7d} записей; это не атаки, в счётчик не входит.</p>`;
        if (!d.wan.length) h += `<div class="sec-line ok">${GWFX.ic('check')} Попыток снаружи не было.</div>`;
        else {
            if (d.wan_top.length) h += `<p><b>Чаще всего:</b> ${d.wan_top.map(t => `${_esc(t.src)} — ${t.count} раз (${_esc(t.kind)})`).join('; ')}</p>`;
            h += `<table><thead><tr><th>Время</th><th>Откуда</th><th>Кто это</th><th>Куда стучались</th></tr></thead><tbody>` +
                d.wan.map(e => row([_esc(e.ts), _esc(e.src), _esc(e.kind), _esc([e.proto, e.what].filter(Boolean).join(' · '))])).join('') +
                `</tbody></table><p style="opacity:.7">Журнал ограничен 5 записями в минуту — при массовом сканировании показаны не все пакеты.</p>`;
        }
        body.innerHTML = h;
    } else {
        $('sec-ev-title').textContent = 'Неудачные входы';
        let h = `<p>Неверный логин или пароль в панель или по SSH. Входы <b>из офиса и через VPN</b> — это свои (опечатка в пароле).
            Подозрительны только входы <b>из интернета</b>: после 5 неудач подряд такой адрес блокируется автоматически.</p>`;
        if (!d.logins.length) h += `<div class="sec-line ok">${GWFX.ic('check')} Неудачных входов не было.</div>`;
        else h += `<table><thead><tr><th>Время</th><th>Куда</th><th>Логин</th><th>Адрес</th><th>Откуда</th></tr></thead><tbody>` +
            d.logins.map(e => row([_esc(e.ts), _esc(e.where), _esc(e.user || '—'), _esc(e.ip),
                e.kind === 'из интернета' ? `<b style="color:var(--bad)">${_esc(e.kind)}</b>` : _esc(e.kind)])).join('') + `</tbody></table>`;
        body.innerHTML = h;
    }
    GWFX.icons(box);
}
async function secUnban(ip) {
    const ok = await uiConfirm(`Разблокировать адрес ${ip}? После этого он снова сможет подключаться к шлюзу.`, 'Разблокировать');
    if (!ok) return;
    const r = await fetch('/api/security/unban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
    const d = await r.json();
    if (d.ok) { toast('Разблокирован: ' + ip, 'ok'); loadSecurityStats(); } else toast(d.error || 'ошибка', 'bad');
}
async function secUnbanAll() {
    const ok = await uiConfirm('Снять ВСЕ блокировки? Забаненные адреса снова смогут подключаться к шлюзу.', 'Разблокировать все');
    if (!ok) return;
    const r = await fetch('/api/security/unban-all', { method: 'POST' });
    const d = await r.json();
    if (d.ok) { toast('Все блокировки сняты', 'ok'); loadSecurityStats(); } else toast(d.error || 'ошибка', 'bad');
}

// ── SSH-порт (только админ, смена с подтверждением паролем) ──
let _sshPort = 22;   // реальный порт установки; в коде не хардкодим
async function loadSshPort() {
    const d = await api('/api/security/ssh-port');
    if (!d) return;
    _sshPort = d.port || 22;
    if ($('ssh-port-cur'))    $('ssh-port-cur').textContent = _sshPort;
    if ($('ssh-port-inline')) $('ssh-port-inline').textContent = _sshPort;
}
async function sshPortChange() {
    const p = parseInt(($('ssh-port-new').value || '').trim(), 10);
    if (!p || p < 1 || p > 65535) { toast('Введите порт 1..65535', 'bad'); return; }
    const pass = await uiPrompt('Смена SSH-порта',
        `Сменить порт SSH на ${p}? Подтвердите паролем администратора.`, 'password', 'Сменить');
    if (pass === null) return;
    const r = await fetch('/api/security/ssh-port', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: p, password: pass }) });
    const d = await r.json();
    const res = $('ssh-port-result');
    if (d.ok) { if (res) res.textContent = `Порт изменён на ${d.port}`; toast('SSH-порт изменён на ' + d.port, 'ok', 5000); $('ssh-port-new').value = ''; loadSshPort(); }
    else { if (res) res.textContent = d.error || 'ошибка'; toast(d.error || 'ошибка', 'bad', 5000); }
}

// ── Консольные креды: пароль root + SSH-ключи (только админ) ──
async function rootPassChange() {
    const np = ($('root-pass-new').value || '');
    if (np.length < 6) { toast('Пароль root минимум 6 символов', 'bad'); return; }
    const pass = await uiPrompt('Смена пароля root (SSH)',
        'Сменить пароль для входа по SSH (логин root)? Подтвердите паролем администратора панели.', 'password', 'Сменить');
    if (pass === null) return;
    const r = await fetch('/api/security/console-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_password: pass, new_password: np }) });
    const d = await r.json(); const res = $('root-pass-result');
    if (d.ok) { if (res) res.textContent = 'Пароль root изменён'; toast('Пароль root изменён', 'ok'); $('root-pass-new').value = ''; }
    else { if (res) res.textContent = d.error || 'ошибка'; toast(d.error || 'ошибка', 'bad', 5000); }
}
let _sshKeys = [];
async function loadSshKeys() {
    const d = await api('/api/security/ssh-keys');
    _sshKeys = (d && d.keys) || [];
    const el = $('ssh-keys-list'); if (!el) return;
    if (!_sshKeys.length) { el.innerHTML = '<div class="small" style="opacity:.7">Ключей нет — вход по паролю.</div>'; return; }
    el.innerHTML = _sshKeys.map((k, i) => `<div class="acc-item"><div class="acc-item-head">
        <b>${GWFX.ic('lock')} ${_esc(k.label || k.type)}</b> <span class="small">${_esc(k.type)} · ${_esc(k.fp)}</span>
        <span class="acc-actions"><button class="mini danger" onclick="sshKeyDel(${i})">${GWFX.ic('cross')} удалить</button></span></div></div>`).join('');
    GWFX.icons(el);
}
async function sshKeyAdd() {
    const key = ($('ssh-key-new').value || '').trim();
    if (!key) { toast('Вставьте публичный ключ', 'bad'); return; }
    const r = await fetch('/api/security/ssh-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const d = await r.json(); const res = $('ssh-key-result');
    if (d.ok) { if (res) res.textContent = 'Ключ добавлен'; toast('SSH-ключ добавлен', 'ok'); $('ssh-key-new').value = ''; loadSshKeys(); }
    else { if (res) res.textContent = d.error || 'ошибка'; toast(d.error || 'ошибка', 'bad', 5000); }
}
async function sshKeyDel(i) {
    const k = _sshKeys[i]; if (!k) return;
    const ok = await uiConfirm('Удалить SSH-ключ «' + (k.label || k.type) + '»? Вход по этому ключу перестанет работать.', 'Удалить');
    if (!ok) return;
    const r = await fetch('/api/security/ssh-keys/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k.raw }) });
    const d = await r.json();
    if (d.ok) { toast('Ключ удалён', 'ok'); loadSshKeys(); } else toast(d.error || 'ошибка', 'bad');
}
async function sshKeyGen() {
    const ok = await uiConfirm('Сгенерировать новый SSH-ключ на сервере? Публичная часть добавится для входа, а приватный (секретный) файл скачается тебе — на сервере он НЕ хранится, второй раз показать не сможем.', 'Сгенерировать');
    if (!ok) return;
    const r = await fetch('/api/security/ssh-keygen', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) { toast(d.error || 'ошибка', 'bad', 5000); return; }
    const blob = new Blob([d.private + '\n'], { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'gateway_id_ed25519'; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast('Ключ создан, приватный файл скачан. Сохрани его — повторно не покажем!', 'ok', 9000);
    const res = $('ssh-key-result');
    if (res) res.textContent = `Готово: приватный ключ скачан (gateway_id_ed25519). Заходи: ssh -i gateway_id_ed25519 -p ${_sshPort} root@192.168.88.1`;
    loadSshKeys();
}

// ── Питание/обслуживание шлюза (только админ) ──
async function sysRestartServices() {
    const ok = await uiConfirm('Перезапустить сервисы шлюза (VPN / DHCP / панель)? Кратковременный разрыв связи.', 'Перезапустить');
    if (!ok) return;
    const r = await fetch('/api/system/restart-services', { method:'POST' }); const d = await r.json();
    if (d.ok) toast('Сервисы перезапускаются…', 'ok', 5000); else toast(d.error || 'ошибка', 'bad');
}
async function sysReboot() {
    const ok = await uiConfirm('Перезагрузить шлюз? Связь через туннель пропадёт на ~1–2 минуты и восстановится сама.', 'Перезагрузить');
    if (!ok) return;
    const r = await fetch('/api/system/reboot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ confirm: true }) });
    const d = await r.json();
    if (d.ok) toast('Шлюз перезагружается… вернётся через ~1–2 мин', 'warn', 8000); else toast(d.error || 'ошибка', 'bad');
}
async function sysPoweroff() {
    const w = await uiPrompt('Выключить шлюз',
        'ВНИМАНИЕ: после выключения включить шлюз можно будет ТОЛЬКО ФИЗИЧЕСКИ (удалённо — нельзя). Для подтверждения введите слово: выключить',
        'text', 'Выключить');
    if (w === null) return;
    const r = await fetch('/api/system/poweroff', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ confirm: true, confirm_text: w }) });
    const d = await r.json();
    if (d.ok) toast('Шлюз выключается…', 'warn', 8000); else toast(d.error || 'ошибка', 'bad', 5000);
}

// ── Обновление шлюза (только админ) ──
let _updPollTimer = null;
const _UPD_STAGES = { check:'проверка', preflight:'проверки', backup:'бэкап', cleanup:'очистка',
    apply:'установка', health:'самодиагностика', commit:'готово', rollback:'откат' };

function _updRender(d) {
    if (!d) return;
    $('upd-current').textContent = d.current || '—';
    const st = d.status || {};
    const cfg = d.config || {};
    // режим/расписание
    if ($('upd-mode')) { $('upd-mode').value = cfg.mode || 'manual'; updateModeUi(); }
    if ($('upd-time') && cfg.scheduled_time) $('upd-time').value = cfg.scheduled_time;
    if ($('upd-level')) $('upd-level').value = cfg.auto_level || 'all';
    if ($('upd-keep')) $('upd-keep').value = cfg.keep_backups || 3;
    // доступность/прогресс
    const avail = $('upd-available'), btn = $('upd-apply-btn'), chg = $('upd-changelog'), prog = $('upd-progress');
    const running = ['running'].includes(st.state) || d.update_inprogress;
    if (st.state === 'available') {
        avail.textContent = st.to || '—';
        btn.style.display = '';
        if (st.changelog) { chg.style.display = 'block'; chg.innerHTML = '<b>Что нового:</b> ' + _esc(st.changelog); }
    } else if (st.to && st.to !== '?' && st.to !== d.current) {
        avail.textContent = st.to;
    } else {
        avail.textContent = (st.state === 'ok' || st.stage === 'commit') ? 'актуально' : '—';
        btn.style.display = 'none';
    }
    prog.innerHTML = _updProgressHtml(st, running);
    _updLast = { st, running };
    // если идёт накат — продолжаем опрашивать
    if (running) _updStartPoll(); else _updStopPoll();
}
function _updStartPoll() {
    if (_updPollTimer) return;
    _updPollTimer = setInterval(loadUpdate, 2000);
}
function _updStopPoll() { if (_updPollTimer) { clearInterval(_updPollTimer); _updPollTimer = null; } }
async function loadUpdate() {
    let d = null;
    try { d = await api('/api/update/status'); } catch (e) { d = null; }
    if (!d && _updLast && _updLast.running) {
        // во время наката панель сама перезапускается — не теряем статус, ждём
        const note = $('upd-prog-note');
        if (note) note.textContent = 'Панель перезапускается — статус обновится через несколько секунд…';
        return;
    }
    _updRender(d);
}
let _updLast = null;
// Статусбар обновления: полоса с процентом (его пишет gateway-update.sh), цепочка
// этапов с галочками, прошедшее время. Откат/ошибка — красным.
const _UPD_STEPS = [['preflight', 'Проверки'], ['backup', 'Бэкап'], ['cleanup', 'Очистка'], ['apply', 'Загрузка и установка'],
    ['health', 'Самопроверка'], ['commit', 'Готово']];
function _updProgressHtml(st, running) {
    if (!st || !st.message) return '';
    const isApplyFlow = ['preflight', 'backup', 'cleanup', 'apply', 'health', 'commit', 'rollback'].includes(st.stage);
    const recent = st.ts && (Date.now() - new Date(st.ts).getTime() < 15 * 60e3);
    if (!isApplyFlow || (!running && !recent)) {
        const cls = st.state === 'error' ? 'bad' : (st.state === 'ok' ? 'ok' : 'warn');
        return `<span class="badge ${cls}">${_esc(_UPD_STAGES[st.stage] || st.stage || '')}</span> ${_esc(st.message)}`;
    }
    const bad = st.stage === 'rollback' || st.state === 'error';
    const done = st.stage === 'commit' && st.state === 'ok';
    const idx = _UPD_STEPS.findIndex(x => x[0] === st.stage);
    const pct = done ? 100 : (typeof st.pct === 'number' ? st.pct : Math.max(3, Math.round((idx < 0 ? 0 : idx) / (_UPD_STEPS.length - 1) * 100)));
    let el = '';
    if (st.started) {
        const sec = Math.max(0, Math.round(((done || bad ? new Date(st.ts) : new Date()) - new Date(st.started)) / 1000));
        el = sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${sec % 60} с`;
    }
    const steps = _UPD_STEPS.map(([k, t], i) => {
        const cls = done ? 'done' : bad ? (i < idx ? 'done' : '') : i < idx ? 'done' : i === idx ? 'cur' : '';
        return `<span class="upd-step ${cls}">${cls === 'done' ? '✓ ' : ''}${t}</span>`;
    }).join('<span class="upd-sep">›</span>');
    const head = done ? `Обновлено: ${_esc(st.from || '')} → ${_esc(st.to || '')}` : bad ? 'Откат' : `Обновление ${_esc(st.from || '')} → ${_esc(st.to || '')}`;
    return `<div class="upd-prog ${bad ? 'bad' : done ? 'ok' : 'run'}">
        <div class="upd-prog-top"><b>${head}</b><span>${pct}%${el ? ' · ' + el : ''}</span></div>
        <div class="upd-bar"><i style="width:${pct}%"></i></div>
        <div class="upd-prog-msg">${_esc(st.message)}</div>
        <div class="upd-steps">${steps}</div>
        <div class="small" id="upd-prog-note"></div></div>`;
}
function updateModeUi() {
    const m = $('upd-mode') ? $('upd-mode').value : 'manual';
    const auto = (m === 'nightly' || m === 'scheduled');
    if ($('upd-time')) $('upd-time').style.display = (m === 'scheduled') ? '' : 'none';
    // «все версии / только патчи» — для любого АВТО-режима (ночью и по расписанию)
    if ($('upd-level')) $('upd-level').style.display = auto ? '' : 'none';
    if ($('upd-level-lbl')) $('upd-level-lbl').style.display = auto ? '' : 'none';
}
async function updateCheck() {
    toast('Проверяю обновления…', 'warn', 3000);
    await fetch('/api/update/check', { method:'POST' });
    setTimeout(loadUpdate, 2500); setTimeout(loadUpdate, 6000);
}
async function updateApply() {
    const ok = await uiConfirm('Запустить обновление шлюза? Будет создан бэкап, при сбое — авто-откат. Связь через туннель может ненадолго прерваться.', 'Обновить');
    if (!ok) return;
    const r = await fetch('/api/update/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ confirm: true }) });
    const d = await r.json();
    if (d.ok) { toast('Обновление запущено…', 'warn', 6000); _updStartPoll(); setTimeout(loadUpdate, 2000); }
    else toast(d.error || 'ошибка', 'bad');
}
async function updateRollback() {
    const ok = await uiConfirm('Откатиться на предыдущую версию? Восстановятся код и состояние «как было» до последнего обновления.', 'Откатиться');
    if (!ok) return;
    const r = await fetch('/api/update/rollback', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ confirm: true }) });
    const d = await r.json();
    const res = $('upd-rollback-result');
    if (d.ok) { if (res) res.textContent = 'Откат запущен…'; toast('Откат запущен…', 'warn', 6000); _updStartPoll(); }
    else { if (res) res.textContent = d.error || 'ошибка'; toast(d.error || 'ошибка', 'bad'); }
}
async function updateConfigSave() {
    const body = {
        mode: $('upd-mode').value,
        scheduled_time: $('upd-time').value || '04:30',
        auto_level: $('upd-level').value || 'all',
        keep_backups: parseInt($('upd-keep').value || '3', 10),
    };
    const r = await fetch('/api/update/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    const res = $('upd-cfg-result');
    if (d.ok) { if (res) res.textContent = 'Сохранено'; toast('Режим обновлений сохранён', 'ok'); }
    else { if (res) res.textContent = d.error || 'ошибка'; toast(d.error || 'ошибка', 'bad'); }
}

// ── Учётные записи (только админ) ──
async function loadUsers() {
    const d = await api('/api/security/users');
    const el = $('users-list'); if (!el) return;
    if (!d || !d.users) { el.innerHTML = '<div class="small">нет доступа</div>'; return; }
    el.innerHTML = d.users.map(u => {
        const isMe = u.username === d.me;
        const roleTag = u.role === 'admin'
            ? '<span class="role-tag admin">админ</span>'
            : '<span class="role-tag">модератор</span>';
        const actions = isMe ? '<span class="small">это вы</span>' :
            `<button class="mini" onclick="userReset('${_esc(u.username)}')">${GWFX.ic('refresh')} пароль</button>
             <button class="mini danger" onclick="userDelete('${_esc(u.username)}')">${GWFX.ic('cross')}</button>`;
        return `<div class="acc-item"><div class="acc-item-head">
            <b><span data-ic="user"></span> ${_esc(u.username)}</b> ${roleTag}
            <span class="acc-actions">${actions}</span></div></div>`;
    }).join('');
    GWFX.icons(el);
}
async function userCreate() {
    const res = $('nu-result');
    const body = { admin_password: $('nu-admin').value, username: $('nu-name').value,
                   password: $('nu-pass').value, role: $('nu-role').value };
    if (!body.username || !body.password || !body.admin_password) { res.innerHTML = '<span style="color:var(--bad)">✗ заполни логин, пароль и свой админ-пароль</span>'; return; }
    const r = await fetch('/api/security/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { res.innerHTML = '<span style="color:var(--good)">✓ учётка создана</span>'; $('nu-name').value=''; $('nu-pass').value=''; $('nu-admin').value=''; loadUsers(); toast('Учётная запись создана','ok'); }
    else res.innerHTML = `<span style="color:var(--bad)">✗ ${d.error||'ошибка'}</span>`;
}
async function userDelete(name) {
    const pass = await uiPrompt(`Удалить учётку «${name}»`, 'Введите ваш пароль администратора для подтверждения:', 'password');
    if (pass === null) return;
    const r = await fetch('/api/security/users/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ admin_password: pass, username: name }) });
    const d = await r.json();
    if (d.ok) { toast('Учётка удалена','ok'); loadUsers(); } else toast(d.error||'ошибка', 'bad', 4000);
}
async function userReset(name) {
    const np = await uiPrompt(`Сброс пароля «${name}»`, 'Новый пароль для пользователя (мин. 4 символа):', 'text');
    if (np === null) return;
    const ap = await uiPrompt('Подтверждение', 'Введите ваш пароль администратора:', 'password');
    if (ap === null) return;
    const r = await fetch('/api/security/reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ admin_password: ap, username: name, new_password: np }) });
    const d = await r.json();
    if (d.ok) toast(`Пароль «${name}» сброшен`,'ok'); else toast(d.error||'ошибка', 'bad', 4000);
}

// ── Резервные копии ──
const _BK_REASON = { cron:'авто', manual:'вручную', update:'пред-обновление', upload:'загружен', 'pre-restore':'страховка' };
async function loadBackups() {
    const d = await api('/api/backup/list');
    const el = $('backups-list'); if (!el) return;
    if (!d || !d.backups || !d.backups.length) { el.innerHTML = '<div class="small">бэкапов пока нет</div>'; return; }
    el.innerHTML = d.backups.map(b => {
        const date = b.created ? new Date(b.created).toLocaleString('ru-RU') : _esc(b.name);
        const kb = Math.max(1, Math.round((b.size || 0) / 1024));
        const reason = _BK_REASON[b.reason] || _esc(b.reason);
        return `<div class="acc-item"><div class="acc-item-head">
            <b><span data-ic="save"></span> ${date}</b>
            <span class="small">${reason} · ${_esc(b.version)} · ${kb} КБ</span>
            <span class="acc-actions">
              <button class="mini" title="Скачать" onclick="backupDownload('${_esc(b.name)}')">${GWFX.ic('import')}</button>
              <button class="mini" onclick="backupRestore('${_esc(b.name)}')">${GWFX.ic('refresh')} восстановить</button>
              <button class="mini danger" title="Удалить" onclick="backupDelete('${_esc(b.name)}')">${GWFX.ic('cross')}</button>
            </span></div></div>`;
    }).join('');
    GWFX.icons(el);
}
async function backupCreate() {
    const res = $('backup-result'); res.textContent = 'Создаю бэкап…';
    try {
        const r = await fetch('/api/backup/create', { method:'POST' }); const d = await r.json();
        if (d.ok) { res.innerHTML = '<span style="color:var(--good)">✓ бэкап создан</span>'; toast('Бэкап создан','ok'); loadBackups(); }
        else res.innerHTML = `<span style="color:var(--bad)">✗ ${d.error||'ошибка'}</span>`;
    } catch (e) { res.innerHTML = '<span style="color:var(--bad)">✗ ошибка запроса</span>'; }
}
function backupDownload(name) { window.location = '/api/backup/download?name=' + encodeURIComponent(name); }
async function backupRestore(name) {
    const ok = await uiConfirm(`Восстановить состояние из бэкапа «${name}»? Текущее состояние будет перезаписано (страховка создастся автоматически), сервисы перезапустятся.`, 'Восстановить');
    if (!ok) return;
    toast('Восстанавливаю состояние…', 'info', 6000);
    const r = await fetch('/api/backup/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (d.ok) { toast('Состояние восстановлено', 'ok', 5000); setTimeout(() => { loadBackups(); refresh(); }, 3000); }
    else toast(d.error || 'ошибка', 'bad', 5000);
}
async function backupDelete(name) {
    const ok = await uiConfirm(`Удалить бэкап «${name}»?`); if (!ok) return;
    const r = await fetch('/api/backup/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (d.ok) { toast('Бэкап удалён', 'ok'); loadBackups(); } else toast(d.error || 'ошибка', 'bad');
}
(function () {
    const f = document.getElementById('backup-upload-file');
    if (!f) return;
    f.addEventListener('change', async e => {
        const file = e.target.files[0]; if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        toast('Загружаю бэкап…', 'info');
        try {
            const r = await fetch('/api/backup/upload', { method:'POST', body: fd }); const d = await r.json();
            if (d.ok) { toast('Бэкап загружен', 'ok'); loadBackups(); } else toast(d.error || 'ошибка', 'bad', 4000);
        } catch (err) { toast('Ошибка загрузки', 'bad'); }
        e.target.value = '';
    });
})();

async function changeCreds(e) {
    e.preventDefault();
    const res = $('creds-result');
    res.textContent = 'Сохранение...';
    try {
        const r = await fetch('/api/security/change-password', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                current_password: $('cur-pass').value,
                new_username: $('new-user').value,
                new_password: $('new-pass').value,
            })
        });
        const d = await r.json();
        if (d.ok) {
            res.innerHTML = '<span style="color:var(--good)">✓ Сохранено. Новый логин активен.</span>';
            $('creds-form').reset();
            loadWhoami();
        } else {
            res.innerHTML = `<span style="color:var(--bad)">✗ ${d.error || 'Ошибка'}</span>`;
        }
    } catch (e) { res.innerHTML = '<span style="color:var(--bad)">Ошибка запроса</span>'; }
}

// ── Справка: переключение блоков ──
document.querySelectorAll('.help-link').forEach(a => {
    a.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.help-link').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.help-block').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        $('help-' + a.dataset.help).classList.add('active');
    });
});

// ── Устройства (со скоростью по каждому клиенту) ──
let _prevDev = {};
async function loadDevices() {
    const d = await api('/api/devices'); if (!d) return;
    _lastDevices = d.devices || [];
    $('ov-devices').textContent = d.count;
    $('kpi-dev').textContent = d.count;
    _push('dev', d.count); _spark('spark-dev', _hist.dev, '#e3b341');
    const tbody = $('dev-body'); tbody.innerHTML = '';
    $('dev-empty').style.display = d.count ? 'none' : 'block';
    const now = Date.now(); const cur = {};
    d.devices.forEach(dev => {
        cur[dev.ip] = { rx: dev.rx_bytes||0, tx: dev.tx_bytes||0, t: now };
        let rate = '<span class="small">измеряю…</span>';
        const p = _prevDev[dev.ip];
        if (p) {
            const dt = (now - p.t) / 1000;
            if (dt > 0.5) {
                const dr = Math.max(0, ((dev.rx_bytes||0) - p.rx) / dt);
                const dx = Math.max(0, ((dev.tx_bytes||0) - p.tx) / dt);
                rate = `<span style="color:var(--good)">↓ ${fmtRate(dr)}</span> <span style="color:var(--accent)">↑ ${fmtRate(dx)}</span>`;
            }
        }
        const tr = document.createElement('tr');
        const exp = new Date(dev.expire * 1000).toLocaleString('ru-RU');
        tr.innerHTML = `<td data-label="IP">${_esc(dev.ip)}</td><td data-label="MAC">${_esc(dev.mac)}</td><td data-label="Имя">${_esc(dev.name)||'—'}</td><td data-label="Скорость (сейчас)">${rate}</td><td data-label="Аренда до">${_esc(exp)}</td>`;
        tbody.appendChild(tr);
    });
    _prevDev = cur;
}

// ── Срок аренды DHCP ──
const _LEASE_U = { m: 'мин', h: 'ч', d: 'дн', mo: 'мес' };
async function loadLease() {
    const d = await api('/api/dhcp/lease'); if (!d || !$('lease-val')) return;
    $('lease-val').value = d.value; $('lease-unit').value = d.unit;
    $('lease-cur').textContent = `сейчас: ${d.value} ${_LEASE_U[d.unit] || d.unit}${d.default ? ' (по умолчанию)' : ''}`;
}
async function leaseSave() {
    const value = parseInt($('lease-val').value || '0', 10), unit = $('lease-unit').value;
    if (!(value > 0)) { toast('Введите срок', 'warn'); return; }
    if (!await uiConfirm(`Установить срок аренды ${value} ${_LEASE_U[unit]}? DHCP-сервер перезапустится (2–3 с, на работу устройств не влияет).`, 'Сохранить')) return;
    const r = await fetch('/api/dhcp/lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, unit }) });
    const d = await r.json();
    if (d.ok) { toast('Срок аренды сохранён', 'ok'); loadLease(); } else toast(d.error || 'ошибка', 'bad');
}

// ── Интернетометр: Яндекс / 2ip / Cloudflare × напрямую / через VPN ──
const _ST_PROV = { yandex: 'Яндекс', '2ip': '2ip', cloudflare: 'Cloudflare' };
const _ST_PATH = { direct: 'Напрямую (провайдер)', vpn: 'Через VPN' };
let _stTimer = null, _stData = null;
async function loadSpeedtest() {
    const d = await api('/api/speedtest'); if (!d) return;
    _stData = d;
    if ($('st-wan')) $('st-wan').textContent = d.wan ? `(${d.wan})` : '';
    const vpnChk = $('st-p-vpn');
    if (vpnChk) { vpnChk.disabled = !d.vpn_up; if (!d.vpn_up) vpnChk.checked = false; vpnChk.parentElement.title = d.vpn_up ? '' : 'VPN сейчас выключен'; }
    const st = d.status || {}, running = st.state === 'running';
    $('st-run').disabled = running;
    $('st-state').innerHTML = running ? '<span class="dot warn"></span> идёт замер…' : st.finished ? `последний замер: ${_esc(st.finished.replace('T', ' ').slice(0, 16))}` : '';
    const pr = $('st-progress');
    if (running) {
        const total = (st.paths || []).length * (st.providers || []).length || 1, done = (st.results || []).length;
        pr.style.display = '';
        pr.innerHTML = `<div class="st-prog"><div class="st-prog-bar" style="width:${Math.round(done / total * 100)}%"></div></div>
            <div class="small">Сейчас: <b>${_esc(st.step || '…')}</b> · готово ${done} из ${total}</div>`;
    } else pr.style.display = 'none';
    _stRenderResults(st);
    _stRenderHistory(d.history || []);
    clearTimeout(_stTimer);
    if (running) _stTimer = setTimeout(loadSpeedtest, 2000);
}
function _stBar(v, max, cls) {
    const w = max > 0 && v > 0 ? Math.max(2, v / max * 100) : 0;
    return `<div class="st-bar"><i class="${cls}" style="width:${w.toFixed(1)}%"></i></div>`;
}
function _stRenderResults(st) {
    const box = $('st-results'); if (!box) return;
    const res = st.results || [];
    if (!res.length) { box.innerHTML = st.state === 'running' ? '' : '<div class="small st-empty">Замеров ещё не было — нажмите «Запустить замер».</div>'; return; }
    const ok = res.filter(r => !r.error);
    const max = Math.max(1, ...ok.map(r => Math.max(r.down || 0, r.up || 0)));
    const paths = [...new Set(res.map(r => r.path))];
    let h = '<div class="st-grid">';
    paths.forEach(p => {
        const rows = res.filter(r => r.path === p);
        const good = rows.filter(r => !r.error);
        const best = good.length ? Math.max(...good.map(r => r.down || 0)) : 0;
        h += `<div class="st-path"><div class="st-ph"><b>${_esc(_ST_PATH[p] || p)}</b>
            ${good.length ? `<span class="st-best">до <b>${best}</b> Мбит/с</span>` : ''}</div>`;
        rows.forEach(r => {
            if (r.error) {
                h += `<div class="st-row st-err"><div class="st-prov">${_esc(_ST_PROV[r.provider] || r.provider)}</div>
                    <div class="small" style="color:var(--bad)">${_esc(r.error)}</div></div>`;
                return;
            }
            h += `<div class="st-row"><div class="st-prov">${_esc(_ST_PROV[r.provider] || r.provider)}
                    <span class="small" title="${_esc(r.server || '')}">${_esc((r.server || '').slice(0, 40))}</span></div>
                <div class="st-m"><span class="st-l">↓ загрузка</span><b>${r.down ?? '—'}</b><span class="st-u">Мбит/с</span>${_stBar(r.down, max, 'dn')}</div>
                <div class="st-m"><span class="st-l">↑ отдача</span><b>${r.up ?? '—'}</b><span class="st-u">Мбит/с</span>${_stBar(r.up, max, 'upl')}</div>
                <div class="st-m st-ping"><span class="st-l">пинг</span><b>${r.ping_ms ?? '—'}</b><span class="st-u">мс${r.jitter_ms != null ? ` ±${r.jitter_ms}` : ''}</span></div>
            </div>`;
        });
        h += '</div>';
    });
    h += '</div>';
    box.innerHTML = h;
}
function _stRenderHistory(hist) {
    const box = $('st-history'); if (!box) return;
    if (!hist.length) { box.innerHTML = ''; return; }
    const rows = [];
    hist.slice(0, 15).forEach(x => (x.results || []).forEach(r => rows.push({ ts: x.ts, ...r })));
    box.innerHTML = `<details class="st-hist"><summary>История замеров (${hist.length})</summary>
        <div class="nl-tbl"><table><thead><tr><th>Время</th><th>Канал</th><th>Сервис</th><th>↓ Мбит/с</th><th>↑ Мбит/с</th><th>Пинг, мс</th></tr></thead><tbody>` +
        rows.map(r => `<tr><td class="nl-num">${_esc(r.ts.replace('T', ' ').slice(0, 16))}</td><td>${_esc(_ST_PATH[r.path] || r.path)}</td>
            <td>${_esc(_ST_PROV[r.provider] || r.provider)}</td>
            ${r.error ? `<td colspan="3" class="small" style="color:var(--bad)">${_esc(r.error)}</td>` :
            `<td class="nl-num"><b>${r.down ?? '—'}</b></td><td class="nl-num">${r.up ?? '—'}</td><td class="nl-num">${r.ping_ms ?? '—'}</td>`}</tr>`).join('') +
        `</tbody></table></div></details>`;
}
async function stRun() {
    const paths = ['direct', 'vpn'].filter(p => $('st-p-' + p).checked && !$('st-p-' + p).disabled);
    const providers = ['yandex', '2ip', 'cloudflare'].filter(p => $('st-s-' + p).checked);
    if (!paths.length || !providers.length) { toast('Выберите канал и хотя бы один сервис', 'warn'); return; }
    const secs = paths.length * providers.length * 20;
    if (!await uiConfirm(`Запустить замер? Займёт около ${Math.ceil(secs / 60)} мин; всё это время интернет в офисе будет заметно занят.`, 'Запустить')) return;
    const r = await fetch('/api/speedtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, providers }) });
    const d = await r.json();
    if (d.ok) { toast('Замер запущен', 'ok'); setTimeout(loadSpeedtest, 800); }
    else toast(d.error || 'ошибка', 'bad');
}

// ── Журнал сети: отвалы линка по каждому порту ──
// SVG рисуется в реальных пикселях контейнера (без растягивания viewBox):
// узкие отвалы и подписи остаются чёткими; при ресайзе — перерисовка.
let _nlDays = 1, _nlData = null, _nlFilter = '', _nlRows = 30;
const _NL_ROLE = { WAN: 'к провайдеру', LAN: 'в офис', VPN: 'туннель', PORT: 'другой порт', '': 'порт' };
const _NL_STATE = { up: 'линк есть', slow: 'пониженная скорость', down: 'линка нет', idle: 'туннель не работал (VPN выключен)', off: 'шлюз выключен или нет данных' };
const _NL_C = { up: '#238636', slow: '#d29922', down: '#f85149', idle: '#30363d', grid: '#21262d', axis: '#8b949e' };
const _NL_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function _nlDur(s) {
    s = Math.max(0, Math.round(s || 0));
    if (s < 60) return s + ' с';
    if (s < 3600) return Math.floor(s / 60) + ' мин' + (s % 60 ? ' ' + (s % 60) + ' с' : '');
    if (s < 86400) return Math.floor(s / 3600) + ' ч' + (s % 3600 >= 60 ? ' ' + Math.floor(s % 3600 / 60) + ' мин' : '');
    return Math.floor(s / 86400) + ' д' + (s % 86400 >= 3600 ? ' ' + Math.floor(s % 86400 / 3600) + ' ч' : '');
}
function _nlAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' мин назад';
    if (s < 86400) return Math.round(s / 3600) + ' ч назад';
    return Math.round(s / 86400) + ' дн назад';
}
const _nlT = iso => new Date(iso.replace(' ', 'T')).getTime();
const _p2 = n => String(n).padStart(2, '0');
function _nlFmt(ms, sec) {
    const d = new Date(ms);
    return `${_p2(d.getDate())}.${_p2(d.getMonth() + 1)} ${_p2(d.getHours())}:${_p2(d.getMinutes())}` + (sec ? ':' + _p2(d.getSeconds()) : '');
}
const _nlDate = ms => { const d = new Date(ms); return `${_p2(d.getDate())}.${_p2(d.getMonth() + 1)}`; };
const _nlHM = ms => { const d = new Date(ms); return `${_p2(d.getHours())}:${_p2(d.getMinutes())}`; };
const _nlIsDrop = e => e.kind === 'drop' || e.kind === 'drop_open';

// корзины графика отвалов: столбиков всегда ~24–90 — без «волосков» и «кирпичей»
function _nlBuckets(spanMs, t0, t1) {
    const H = 3600e3, D = 24 * H, days = spanMs / D;
    const step = days <= 1.5 ? H : days <= 8 ? 4 * H : days <= 100 ? D : 7 * D;
    const name = step === H ? 'час' : step === 4 * H ? '4 часа' : step === D ? 'день' : 'неделю';
    let start;
    if (step === H) start = Math.floor(t0 / H) * H;
    else { const d = new Date(t0); d.setHours(0, 0, 0, 0); start = d.getTime(); }
    const n = Math.max(1, Math.ceil((t1 - start) / step));
    return { step, name, start, n };
}

let _nlSeq = 0, _nlRange = null;   // _nlRange = {start, end} — календарные даты
async function loadNetlog(days) {
    if (days) { _nlDays = days; _nlRows = 30; _nlRange = null; _nlCalLabel(); }
    const seq = ++_nlSeq, want = _nlDays, rng = _nlRange;
    document.querySelectorAll('[data-nld]').forEach(b => b.classList.toggle('on', !_nlRange && +b.dataset.nld === _nlDays));
    if ($('nl-range-go')) $('nl-range-go').classList.toggle('on', !!_nlRange);
    const body = $('nl-body'); if (!body) return;
    if (!_nlData || days) body.innerHTML = '<div class="small">Загружаю…</div>';
    const d = await api(rng ? `/api/netlog?start=${rng.start}&end=${rng.end}` : '/api/netlog?days=' + want);
    if (seq !== _nlSeq) return;      // пока ждали, выбрали другой период
    if (!d || d.error) { body.textContent = (d && d.error) || 'Не удалось получить журнал'; return; }
    _nlData = d; _nlRender();
}

const _nlHidden = new Set();
// цвет серии закреплён за ролью порта (не за порядком) — фильтр не перекрашивает линии
// цвет: гамма — по роли, оттенок — по номеру интерфейса внутри роли (по имени,
// стабильно): два LAN-порта — два разных фиолетовых, awg0/awg1 — два бирюзовых
const _NL_PAL = { WAN: ['#58a6ff', '#a5d6ff', '#1f6feb'], LAN: ['#bc8cff', '#e2c5ff', '#8957e5'],
    VPN: ['#3fb9a7', '#7ee2d3', '#1a8f80'], PORT: ['#e3b341', '#f2cc60', '#bb8009', '#ff9bce', '#f0883e'] };
const _nlRoleTxt = r => r === 'PORT' || !r ? 'порт' : r;
function _nlColor(f) {
    const pal = _NL_PAL[f.role] || _NL_PAL.PORT;
    const src = (_nlData && ((_nlData.metrics && _nlData.metrics.ifaces) || _nlData.ifaces)) || [];
    const same = [...new Set(src.filter(x => (x.role || 'PORT') === (f.role || 'PORT')).map(x => x.name))].sort();
    const i = Math.max(0, same.indexOf(f.name));
    return pal[i % pal.length];
}
function _nlToggle(key) { _nlVis[key] = !_nlSerOn({ key, dir: key.split(':')[1], m: { role: _nlRoleOf(key) } }); _nlRender(); }
const _nlVis = {};
function _nlRoleOf(key) { const m = _nlData && _nlData.metrics && _nlData.metrics.ifaces.find(x => x.name === key.split(':')[0]); return m ? m.role : ''; }
// по умолчанию: ↓ всех портов и ↑ WAN — остальное включается кликом по легенде
function _nlSerOn(q) { return q.key in _nlVis ? _nlVis[q.key] : (q.dir === 'dn' || q.m.role === 'WAN'); }
function _nlBucketName(m) { if (!m) return '…'; const b = m.bucket_s; return b < 3600 ? (b / 60) + ' мин' : b < 86400 ? (b / 3600) + ' ч' : 'сутки'; }
// монотонная кубическая интерполяция: гладко и без «нырков» ниже нуля
function _nlSmooth(p) {
    const n = p.length;
    if (!n) return '';
    if (n < 3) return 'M' + p.map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' L');
    const dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
        const a = t[i] / m[i], b = t[i + 1] / m[i], q = a * a + b * b;
        if (q > 9) { const k = 3 / Math.sqrt(q); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        d += ` C${(p[i][0] + h).toFixed(1)},${(p[i][1] + t[i] * h).toFixed(1)} ${(p[i + 1][0] - h).toFixed(1)},${(p[i + 1][1] - t[i + 1] * h).toFixed(1)} ${p[i + 1][0].toFixed(1)},${p[i + 1][1].toFixed(1)}`;
    }
    return d;
}

// список «плохих» периодов с точными датами — аккуратной таблицей под полосой порта
function _nlPeriods(f, t0) {
    const pick = (st, minS) => f.segments.filter(g => g.state === st && (_nlT(g.to) - _nlT(g.from)) / 1000 >= minS && _nlT(g.to) > t0);
    const vpn = f.role === 'VPN';
    const all = pick('slow', 30).map(g => ({ g, cls: 'warn', what: `на ${g.speed} Мбит/с` }))
        .concat(pick('down', 60).map(g => ({ g, cls: 'bad', what: vpn ? 'туннеля нет' : 'нет линка' })))
        .sort((a, b) => (a.g.from < b.g.from ? 1 : -1));
    if (!all.length) return '';
    const row = ({ g, cls, what }) => {
        const a = _nlT(g.from), b = _nlT(g.to);
        return `<div class="nl-pr"><span class="nl-pk ${cls}"><i></i>${what}</span><span>${_nlFmt(a)}</span><span class="nl-par">→</span>
            <span>${_nlFmt(b)}</span><b>${_nlDur((b - a) / 1000)}</b></div>`;
    };
    const head = all.slice(0, 3).map(row).join('');
    const rest = all.slice(3);
    return `<div class="nl-pers">${head}${rest.length ? `<details><summary>ещё ${rest.length}</summary>${rest.map(row).join('')}</details>` : ''}</div>`;
}

// ── свой календарь (нативный input[type=date] не стилизуется под тему) ──
// Первый клик — начало, второй — конец; один день — два клика по нему или «Показать».
const _NL_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
let _nlCal = null, _nlJournalFrom = null;
const _isoD = d => `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
function _nlCalLabel() {
    const l = $('nl-cal-lbl'); if (!l) return;
    if (!_nlRange) { l.textContent = 'Выбрать даты'; return; }
    const f = x => x.slice(8, 10) + '.' + x.slice(5, 7);
    l.textContent = _nlRange.start === _nlRange.end ? f(_nlRange.start) + '.' + _nlRange.start.slice(0, 4) : `${f(_nlRange.start)} — ${f(_nlRange.end)}`;
}
function nlCalToggle(ev) {
    if (ev) ev.stopPropagation();
    const box = $('nl-cal');
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    const base = _nlRange ? new Date(_nlRange.end + 'T12:00:00') : new Date();
    _nlCal = { y: base.getFullYear(), m: base.getMonth(), a: _nlRange ? _nlRange.start : null, b: _nlRange ? _nlRange.end : null };
    box.style.display = '';
    _nlCalRender();
}
document.addEventListener('click', () => { const b = $('nl-cal'); if (b) b.style.display = 'none'; });
function _nlCalRender() {
    const c = _nlCal, box = $('nl-cal'); if (!c || !box) return;
    const first = new Date(c.y, c.m, 1), shift = (first.getDay() + 6) % 7;      // неделя с понедельника
    const today = _isoD(new Date());
    const lo = c.a && c.b ? (c.a < c.b ? c.a : c.b) : c.a, hi = c.a && c.b ? (c.a < c.b ? c.b : c.a) : c.a;
    let cells = '';
    for (let k = 0; k < 42; k++) {
        const d = new Date(c.y, c.m, 1 - shift + k), iso = _isoD(d);
        const out = d.getMonth() !== c.m;
        const dis = iso > today || (_nlJournalFrom && iso < _nlJournalFrom);
        const inR = lo && hi && iso >= lo && iso <= hi;
        const cls = [out ? 'out' : '', dis ? 'dis' : '', inR ? 'in' : '', iso === lo || iso === hi ? 'edge' : '', iso === today ? 'today' : ''].join(' ');
        cells += `<button class="nl-cd ${cls}" ${dis ? 'disabled' : ''} onclick="_nlCalPick('${iso}')">${d.getDate()}</button>`;
    }
    const can = !!c.a;
    const sel = !c.a ? 'Выберите день или начало промежутка' : !c.b ? `С ${c.a.slice(8)}.${c.a.slice(5, 7)} — выберите конец (или «Показать» для одного дня)` :
        `${lo.slice(8)}.${lo.slice(5, 7)} — ${hi.slice(8)}.${hi.slice(5, 7)}`;
    box.innerHTML = `<div class="nl-cal-head"><button class="nl-cal-nav" onclick="_nlCalMove(-1)">‹</button>
            <b>${_NL_MONTHS[c.m]} ${c.y}</b><button class="nl-cal-nav" onclick="_nlCalMove(1)">›</button></div>
        <div class="nl-cal-grid">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(x => `<span class="nl-cw">${x}</span>`).join('')}${cells}</div>
        <div class="nl-cal-sel small">${sel}</div>
        <div class="nl-cal-foot">
            <button class="mini" onclick="_nlCalQuick(0)">Сегодня</button>
            <button class="mini" onclick="_nlCalQuick(-1)">Вчера</button>
            <button class="mini" onclick="_nlCalReset()">Сбросить</button>
            <button class="mini success" ${can ? '' : 'disabled'} onclick="_nlCalApply()">Показать</button></div>`;
}
function _nlCalMove(n) { const c = _nlCal; c.m += n; if (c.m < 0) { c.m = 11; c.y--; } if (c.m > 11) { c.m = 0; c.y++; } _nlCalRender(); }
function _nlCalPick(iso) {
    const c = _nlCal;
    if (!c.a || c.b) { c.a = iso; c.b = null; }
    else { c.b = iso; }
    _nlCalRender();
    if (c.a && c.b) setTimeout(_nlCalApply, 120);     // промежуток выбран — сразу показываем
}
function _nlCalQuick(off) { const d = new Date(); d.setDate(d.getDate() + off); const iso = _isoD(d); _nlCal.a = iso; _nlCal.b = iso; _nlCalApply(); }
function _nlCalReset() { $('nl-cal').style.display = 'none'; _nlRange = null; _nlCalLabel(); loadNetlog(_nlDays || 1); }
function _nlCalApply() {
    const c = _nlCal; if (!c || !c.a) return;
    const b = c.b || c.a;
    _nlRange = c.a <= b ? { start: c.a, end: b } : { start: b, end: c.a };
    _nlRows = 30;
    $('nl-cal').style.display = 'none';
    _nlCalLabel();
    loadNetlog();
}
function nlDay(shift) {          // стрелки «предыдущий/следующий день»
    const base = (_nlRange && _nlRange.start) || _isoD(new Date());
    const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + shift);
    const iso = _isoD(d);
    if (iso > _isoD(new Date())) return;
    _nlRange = { start: iso, end: iso }; _nlRows = 30; _nlCalLabel(); loadNetlog();
}

const _nlOpen = new Set();
function _nlPortToggle(n) { _nlOpen.has(n) ? _nlOpen.delete(n) : _nlOpen.add(n); _nlRender(); }
const _nlBytes = b => b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' ТБ' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' ГБ' : b >= 1e6 ? (b / 1e6).toFixed(0) + ' МБ' : (b / 1e3).toFixed(0) + ' КБ';
function _nlPortDetail(f, d, per) {
    const hw = f.hw || {}, met = d.metrics, m = met && met.ifaces.find(x => x.name === f.name);
    const lan = f.role === 'LAN';
    const t = (lab, val, sub, cls) => `<div class="nl-dt ${cls || ''}"><span>${lab}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    let speed = '';
    if (m && m.t.length) {
        const sum = a => a.reduce((x, y) => x + (y || 0), 0), n = m.t.length, bs = met.bucket_s;
        const vol = a => _nlBytes(sum(a) * 1e6 / 8 * bs);
        speed = t(`Средняя ↓ ${lan ? 'в офис' : 'загрузка'}`, (sum(m.dn) / n).toFixed(1) + ' Мбит/с', `пик ${Math.max(...m.dn_pk).toFixed(1)}`) +
            t(`Средняя ↑ ${lan ? 'из офиса' : 'отдача'}`, (sum(m.up) / n).toFixed(1) + ' Мбит/с', `пик ${Math.max(...m.up_pk).toFixed(1)}`) +
            t('Передано ↓ / ↑', `${vol(m.dn)} / ${vol(m.up)}`, per);
    } else speed = t('Скорость', '—', 'история скорости ещё копится');
    const days = hw.uptime_s ? _nlDur(hw.uptime_s) : '';
    const err = (hw.rx_errors || 0) + (hw.tx_errors || 0), crc = hw.rx_crc_errors || 0, drop = (hw.rx_dropped || 0) + (hw.tx_dropped || 0);
    const cc = hw.carrier_changes;
    const link = f.role === 'VPN' ? '' :
        t('Смены линка', cc != null ? cc : '—', `с загрузки (${days}); норма — 1–2`, cc > 4 ? 'warn' : '') +
        t('Ошибки CRC / приёма', `${crc} / ${hw.rx_errors ?? '—'}`, crc ? 'растут — кабель/разъём' : 'нет — сигнал чистый', crc ? 'bad' : 'ok');
    const ev = f.events.filter(e => e.kind !== 'boot' && e.kind !== 'shutdown').slice(0, 8);
    const kinds = { drop: 'отвал', drop_open: 'пропал, не вернулся', slow_boot: 'поднялся на пониженной', idle: 'VPN выключен' };
    return `<div class="nl-detail">
        <div class="nl-dhw"><b>${_esc(f.name)}</b> · ${_esc(_NL_ROLE[f.role] || '')}${hw.driver ? ` · драйвер <code>${_esc(hw.driver)}</code>` : ''}${hw.mac && hw.mac !== '00:00:00:00:00:00' ? ` · MAC <code>${_esc(hw.mac)}</code>` : ''}${hw.mtu ? ` · MTU ${_esc(hw.mtu)}` : ''}${hw.duplex && hw.duplex !== 'unknown' ? ` · ${hw.duplex === 'full' ? 'полный дуплекс' : 'полудуплекс'}` : ''}
            ${f.full_speed ? ` · норма линка ${f.full_speed} Мбит/с` : ''}</div>
        <div class="nl-dts">${speed}
            ${t('Отвалов', f.drops, f.drops ? `до 5 с: ${f.drops_short}` : per, f.drops ? 'bad' : 'ok')}
            ${t(f.role === 'VPN' ? 'Туннеля не было' : 'Без линка', f.down_s ? _nlDur(f.down_s) : '0 с', per)}
            ${f.role === 'VPN' ? '' : t('На пониженной скорости', f.slow_s ? _nlDur(f.slow_s) : 'нет', f.slow_s ? `${f.slow_events} раз` : per, f.slow_s ? 'warn' : 'ok')}
            ${link}
            ${t('Потеряно пакетов', drop, `ошибок передачи: ${hw.tx_errors ?? '—'}`, drop > 1000 ? 'warn' : '')}
            ${t('Всего с загрузки ↓ / ↑', `${_nlBytes(lan ? hw.tx_bytes : hw.rx_bytes)} / ${_nlBytes(lan ? hw.rx_bytes : hw.tx_bytes)}`, days)}</div>
        <div class="nl-det-chart" data-n="${_esc(f.name)}"></div>
        ${ev.length ? `<div class="nl-dev"><div class="small c-mut">Последние события порта</div>${ev.map(e => `<div class="nl-pr">
            <span class="nl-pk ${e.kind === 'idle' ? '' : e.speed && f.full_speed && e.speed < f.full_speed ? 'warn' : 'bad'}"><i></i>${_esc(kinds[e.kind] || e.kind)}</span>
            <span>${_esc(e.ts.slice(8, 10) + '.' + e.ts.slice(5, 7) + ' ' + e.ts.slice(11, 19))}</span><span class="nl-par"></span>
            <span>${e.dur != null ? _esc(_nlDur(e.dur)) : ''}</span><b>${e.speed ? e.speed + ' Мбит/с' : ''}</b></div>`).join('')}</div>` : ''}
    </div>`;
}

function _nlRender() {
    const d = _nlData, body = $('nl-body'); if (!d || !body) return;
    let t0 = _nlT(d.since);
    const t1 = _nlT(d.now);
    // журнал моложе периода (шлюз поставлен недавно) — не рисуем полгода «нет данных»
    let dataFrom = t1;
    d.ifaces.forEach(f => { const g = f.segments.find(g => g.state !== 'off'); if (g) dataFrom = Math.min(dataFrom, _nlT(g.from)); });
    const cropped = dataFrom > t0 + (t1 - t0) * 0.03 && dataFrom < t1;
    if (cropped && !d.range) _nlJournalFrom = _isoD(new Date(dataFrom));
    if (cropped) t0 = dataFrom;
    const span = Math.max(1, t1 - t0);
    const B = _nlBuckets(span, t0, t1);
    const per = d.range
        ? (_nlDate(t0) === _nlDate(t1 - 1) ? `за ${_nlDate(t0)}` : `за ${_nlDate(t0)}–${_nlDate(t1 - 1)}`)
        : ({ 1: 'за сутки', 7: 'за неделю', 30: 'за месяц', 90: 'за 3 месяца', 365: 'за год' }[_nlDays] || `за ${_nlDays} дн`);


    // ── сводка ──
    const wan = d.ifaces.find(f => f.role === 'WAN') || d.ifaces[0];
    const allDrops = [];
    d.ifaces.forEach(f => f.events.forEach(e => { if (_nlIsDrop(e)) allDrops.push({ ...e, f }); }));
    allDrops.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const last = allDrops.find(e => e.f.role !== 'VPN') || allDrops[0];
    const tile = (cls, label, val, sub) => `<div class="nl-kpi ${cls}"><span>${label}</span><b>${val}</b><small>${sub || '&nbsp;'}</small></div>`;
    let h = '<div class="nl-kpis">';
    if (wan) {
        const wst = !wan.up ? 'bad' : (wan.full_speed && wan.speed && wan.speed < wan.full_speed ? 'warn' : 'ok');
        h += tile(wst, `Интернет-порт ${_esc(wan.name)}`, wan.up ? (wan.speed ? wan.speed + ' Мбит/с' : 'линк есть') : 'нет линка',
            wst === 'ok' ? 'сейчас всё в порядке' : wst === 'warn' ? 'сейчас на пониженной скорости!' : 'кабель не подключён?');
        h += tile(wan.drops ? (wan.drops > 5 ? 'bad' : 'warn') : 'ok', `Отвалы WAN ${per}`, wan.drops,
            wan.drops ? `${wan.drops_short} из них короче 5 с` : 'ни одного');
        h += tile(wan.slow_s ? 'warn' : 'ok', 'На пониженной скорости', wan.slow_s ? _nlDur(wan.slow_s) : 'нет',
            wan.slow_s ? `${wan.slow_events} раз «застревал» после отвала` : `всё время ${wan.full_speed || ''} Мбит/с`);
        h += tile(wan.down_s > 600 ? 'warn' : '', 'Без линка (нет интернета)', wan.down_s ? _nlDur(wan.down_s) : '0 с', `суммарно ${per}`);
    }
    const blv = d.metrics && d.metrics.baseline;
    if (blv && blv.dn) h += tile('', 'Обычный макс. WAN ↓', blv.dn + ' Мбит/с', `по пикам за ${blv.days} дн`);
    h += tile('', 'Последний отвал', last ? _nlAgo(_nlT(last.ts)) : '—',
        last ? `${_esc(last.f.name)} · ${_nlFmt(_nlT(last.ts))}${last.dur != null ? ' · ' + _nlDur(last.dur) : ''}` : `${per} не было`);
    h += '</div>';
    if (cropped) h += `<div class="small nl-note nl-crop">Журнал ведётся с ${_nlDate(dataFrom)}.${new Date(dataFrom).getFullYear()} — раньше данных нет, графики начинаются с этой даты.</div>`;

    // ── общий график: скорость по портам + дорожки «линк WAN» и «события» сверху ──
    const met = d.metrics && d.metrics.ifaces && d.metrics.ifaces.length ? d.metrics : null;
    const serDefs = [];
    if (met) met.ifaces.forEach(m => ['dn', 'up'].forEach(dir => serDefs.push({ key: `${m.name}:${dir}`, m, dir })));
    const bl = d.metrics && d.metrics.baseline;
    h += `<div class="nl-main-wrap">
        <div class="nl-main-head"><div class="nl-btitle">Скорость интернета по портам, Мбит/с <span class="small">(средняя за ${_nlBucketName(met)})</span></div>
        <div class="nl-series">${serDefs.map(q => `<button class="nl-sc${_nlSerOn(q) ? ' on' : ''}" onclick="_nlToggle('${_esc(q.key)}')" title="Показать/скрыть">
            <i style="background:${_nlColor(q.m)}${q.dir === 'up' ? ';opacity:.55' : ''}"></i>${_esc(q.m.name)} <span>${_esc(_nlRoleTxt(q.m.role))} ${q.dir === 'dn' ? '↓' : '↑'}</span></button>`).join('')}
        <span class="nl-sc-band"><i class="a-slow"></i>WAN на пониженной скорости</span>
        <span class="nl-sc-band"><i class="a-drop"></i>отвалы</span>
        <span class="nl-sc-band"><i class="a-vpn"></i>VPN пропадал</span>
        <span class="nl-sc-band"><i class="a-off"></i>шлюз выключен</span>
        ${(d.speedtests || []).length ? '<span class="nl-sc-band st"><i></i>замер интернетометра</span>' : ''}</div></div>
        <div class="nl-main"></div></div>`;

    // ── порты: сводная таблица (всё временное — на общем графике выше) ──
    h += `<div class="nl-ports-hint"><span class="nl-hint-ic">${GWFX.ic('chart')}</span> Нажмите на порт — откроется <b>подробная инфографика</b>: график только этого порта,
        ошибки кабеля (CRC, смены линка), скорость и трафик за период, последние события.</div>
        <div class="nl-ports"><table><thead><tr><th>Порт</th><th>Сейчас</th><th>Отвалов</th><th>Без линка</th>
        <th>На пониженной скорости</th><th>Проблемные периоды</th><th></th></tr></thead><tbody>` +
        d.ifaces.map(f => {
            const st = f.up ? (f.full_speed && f.speed && f.speed < f.full_speed ? 'warn' : 'ok') : 'bad';
            const now = f.role === 'VPN' ? (f.up ? 'поднят' : 'не поднят') : f.up ? (f.speed ? `${f.speed} Мбит/с` : 'линк есть') : 'нет линка';
            const open = _nlOpen.has(f.name);
            return `<tr class="nl-prow${open ? ' open' : ''}" onclick="_nlPortToggle('${_esc(f.name)}')" title="Подробно по порту">
                <td><span class="nl-chev">${GWFX.ic(open ? 'chevd' : 'chevr')}</span><span class="dot ${st}"></span> <b>${_esc(f.name)}</b> <span class="nl-role nl-role-${(f.role || 'x').toLowerCase()}">${_esc(_nlRoleTxt(f.role))}</span>
                    <div class="small">${_esc(_NL_ROLE[f.role] || '')}</div></td>
                <td class="nl-num ${st === 'ok' ? '' : 'c-' + st}">${_esc(now)}</td>
                <td class="nl-num ${f.drops ? 'c-bad' : 'c-ok'}"><b>${f.drops}</b>${f.drops ? `<div class="small">до 5 с: ${f.drops_short}</div>` : ''}</td>
                <td class="nl-num">${f.down_s ? _nlDur(f.down_s) : '—'}</td>
                <td class="nl-num ${f.slow_s ? 'c-warn' : ''}">${f.slow_s ? `<b>${_nlDur(f.slow_s)}</b><div class="small">${f.slow_events} раз</div>` : '—'}</td>
                <td>${_nlPeriods(f, t0) || '<span class="small c-ok">нет</span>'}</td>
                <td class="nl-more-cell"><span class="nl-more-btn${open ? ' on' : ''}">${open ? `Свернуть ${GWFX.ic('chevu')}` : `${GWFX.ic('chart')} Подробнее ${GWFX.ic('chevd')}`}</span></td></tr>` +
                (open ? `<tr class="nl-det"><td colspan="7">${_nlPortDetail(f, d, per)}</td></tr>` : '');
        }).join('') + `</tbody></table></div>`;

    // ── когда случаются (по часам суток) ──
    const hod = new Array(24).fill(0);
    allDrops.filter(e => e.f.role !== 'VPN').forEach(e => { hod[new Date(_nlT(e.ts)).getHours()]++; });
    const hodTotal = hod.reduce((a, b) => a + b, 0);
    if (hodTotal >= 3) {
        const work = hod.slice(9, 19).reduce((a, b) => a + b, 0);
        h += `<div class="nl-block"><div class="nl-btitle">В какое время суток случаются отвалы — WAN и LAN, ${per}</div>
            <div class="nl-hod"></div>
            <div class="small nl-note">${Math.round(work / hodTotal * 100)}% отвалов — с 9:00 до 19:00.
            ${work / hodTotal > 0.7 ? 'Днём отваливается, ночью тихо — похоже на физическое воздействие: кабель задевают или двигают, роутер греется под нагрузкой.' : ''}</div></div>`;
    }

    // ── таблица ──
    const kinds = { drop: 'отвал линка', drop_open: 'линк пропал и пока не вернулся', slow_boot: 'после загрузки поднялся на пониженной скорости',
        boot: 'загрузка шлюза', idle: 'VPN не работал (выключен)' };
    let rows = [];
    d.ifaces.forEach(f => f.events.forEach(e => { if (e.kind !== 'boot' && e.kind !== 'shutdown') rows.push({ ...e, f }); }));
    const seen = new Set();
    d.ifaces.forEach(f => f.events.forEach(e => { if (e.kind === 'boot' && !seen.has(e.ts)) { seen.add(e.ts); rows.push({ ...e, f: null }); } }));
    rows = rows.filter(r => !_nlFilter || !r.f || r.f.name === _nlFilter).sort((a, b) => (b.ts < a.ts ? -1 : 1));
    const total = rows.length; rows = rows.slice(0, _nlRows);
    const opts = ['<option value="">все порты</option>'].concat(d.ifaces.map(f =>
        `<option value="${_esc(f.name)}"${_nlFilter === f.name ? ' selected' : ''}>${_esc(f.name)} (${_esc(_nlRoleTxt(f.role))})</option>`)).join('');
    h += `<div class="nl-block"><div class="nl-tbl-head"><div class="nl-btitle">События</div>
        <select onchange="_nlFilter=this.value;_nlRows=30;_nlRender()">${opts}</select>
        <span class="small">загрузок шлюза ${per}: ${d.boots}</span></div>`;
    if (!total) h += `<div class="sec-line ok">${GWFX.ic('check')} ${per[0].toUpperCase() + per.slice(1)} событий не было.</div>`;
    else h += `<div class="nl-tbl"><table><thead><tr><th>Время</th><th>Порт</th><th>Событие</th><th>Длительность</th><th>Скорость после</th></tr></thead><tbody>` +
        rows.map(r => {
            const slow = r.f && r.f.full_speed && r.speed && r.speed < r.f.full_speed;
            const bad = _nlIsDrop(r);
            const ev = r.f && r.f.role === 'VPN' && bad ? (r.dur <= 3 ? 'туннель перезапущен' : 'туннель пропадал') : (kinds[r.kind] || r.kind);
            return `<tr class="${r.kind === 'boot' || r.kind === 'idle' ? 'nl-row-muted' : ''}">
                <td class="nl-num">${_esc(r.ts.slice(8, 10) + '.' + r.ts.slice(5, 7) + '.' + r.ts.slice(0, 4))} <b>${_esc(r.ts.slice(11))}</b></td>
                <td class="nl-num">${r.f ? `${_esc(r.f.name)} <span class="nl-role nl-role-${(r.f.role || 'x').toLowerCase()}">${_esc(_nlRoleTxt(r.f.role))}</span>` : '—'}</td>
                <td>${bad ? '<i class="nl-dot"></i>' : ''}${_esc(ev)}</td>
                <td class="nl-num">${r.dur != null ? _esc(_nlDur(r.dur)) : ''}</td>
                <td class="nl-num">${r.speed ? (slow ? `<span class="nl-pill warn">${r.speed} Мбит/с</span>` : `${r.speed} Мбит/с`) : ''}</td></tr>`;
        }).join('') + `</tbody></table></div>` +
        (total > _nlRows ? `<button class="mini nl-more" onclick="_nlRows+=100;_nlRender()">Показать ещё (${total - _nlRows})</button>` : '');
    h += '</div>';
    body.innerHTML = h;
    GWFX.icons(body);

    // ── графики по реальной ширине ──
    const tip = $('nl-tip'), card = $('netlog-card');
    const show = (ev, html) => {
        tip.innerHTML = html; tip.style.display = '';
        const r = card.getBoundingClientRect();
        let x = ev.clientX - r.left + 14; const y = ev.clientY - r.top + 16;
        if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 14;
        tip.style.left = Math.max(4, x) + 'px'; tip.style.top = y + 'px';
    };
    const hide = () => { tip.style.display = 'none'; };

    // «круглые» метки времени (полночь, 00/04/08 ч, 1-е число) — общие для полосы и столбиков
    const L = 28;   // слева — место под шкалу Y столбиков; полоса сдвинута так же, чтобы оси совпадали
    const Hh = 3600e3, Dd = 24 * Hh;
    const ticks = W => {
        const maxN = Math.max(2, Math.floor((W - L) / 78));
        const steps = [Hh, 2 * Hh, 3 * Hh, 4 * Hh, 6 * Hh, 12 * Hh, Dd, 2 * Dd, 7 * Dd, 14 * Dd, 30 * Dd, 61 * Dd, 91 * Dd];
        const st = steps.find(x => span / x <= maxN) || steps[steps.length - 1];
        const out = [];
        if (st >= 30 * Dd) {
            const months = Math.round(st / (30 * Dd));
            const q = new Date(t0); q.setDate(1); q.setHours(0, 0, 0, 0); q.setMonth(q.getMonth() + 1);
            while (q.getTime() <= t1 && out.length < 40) { out.push([q.getTime(), st]); q.setMonth(q.getMonth() + months); }
        } else {
            const m = new Date(t0); m.setHours(0, 0, 0, 0);
            let t = m.getTime();
            const inc = st < Dd ? st : Dd;
            while (t < t0) t += inc;
            for (; t <= t1 && out.length < 80; t += st) out.push([t, st]);
        }
        return out;
    };
    const tickLabel = (t, st) => {
        const dd = new Date(t);
        if (st < Dd) return dd.getHours() === 0 ? _nlDate(t) : _nlHM(t);
        if (st >= 30 * Dd) return _NL_MON[dd.getMonth()];
        return _nlDate(t);
    };
    const axisSvg = (W, X, yTop, yBot, yTxt, minX = 0) => ticks(W).map(([t, st]) => {
        const x = Math.round(X(t)) + 0.5;
        if (x < minX) return '';
        const bold = st < Dd && new Date(t).getHours() === 0;
        return `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="${bold ? '#30363d' : _NL_C.grid}"/>` +
            `<text x="${x}" y="${yTxt}" fill="${bold ? '#c9d1d9' : _NL_C.axis}" font-size="10.5" text-anchor="middle">${tickLabel(t, st)}</text>`;
    }).join('');

    // график значений: line=true — линия с заливкой и точками (как график трафика в SIEM),
    // иначе столбики. Над точками/столбиками — цифры (без наложения), при наведении —
    // перекрестие и подсказка. xs(k, W) → [x0, x1] корзины k; axis(W, PH) → сетка/подписи X.
    const barChart = (el, vals, xs, axis, tipAt, H = 76, line = false) => {
        const W = Math.max(200, el.clientWidth), TOP = 14, PH = H - 18;
        const mx = Math.max(1, ...vals), nice = mx <= 4 ? mx : Math.ceil(mx / 2) * 2;
        const Y = v => PH - v / nice * (PH - TOP);
        const uid = 'g' + Math.random().toString(36).slice(2, 8);
        let s = `<svg width="${W}" height="${H}" class="nl-svg"><defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${_NL_C.down}" stop-opacity=".35"/><stop offset="1" stop-color="${_NL_C.down}" stop-opacity="0"/></linearGradient></defs>` + axis(W, PH);
        [0, nice / 2, nice].forEach(v => {
            if (v !== Math.round(v)) return;
            const y = Math.round(Y(v)) + 0.5;
            s += `<line x1="${L}" y1="${y}" x2="${W - 4}" y2="${y}" stroke="${v ? _NL_C.grid : '#30363d'}"/>`;
            s += `<text x="${L - 6}" y="${y + 3.5}" fill="${_NL_C.axis}" font-size="10" text-anchor="end">${v}</text>`;
        });
        const pos = vals.map((v, k) => { let [a, b] = xs(k, W); return [Math.max(L, a), Math.min(W - 4, b)]; });
        const cx = k => (pos[k][0] + pos[k][1]) / 2;
        if (line) {
            const pts = vals.map((v, k) => `${cx(k).toFixed(1)},${Y(v).toFixed(1)}`);
            s += `<path d="M${cx(0).toFixed(1)},${PH} L${pts.join(' L')} L${cx(vals.length - 1).toFixed(1)},${PH} Z" fill="url(#${uid})"/>`;
            s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${_NL_C.down}" stroke-width="2" stroke-linejoin="round"/>`;
            vals.forEach((v, k) => { if (v) s += `<circle cx="${cx(k).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${_NL_C.down}" stroke="#161b22" stroke-width="1.5"/>`; });
        } else {
            vals.forEach((v, k) => {
                if (!v) return;
                const [x0, x1] = pos[k], bw = x1 - x0, gap = bw > 6 ? 2 : bw > 3 ? 1 : 0.4, w = Math.max(1, bw - gap), x = x0 + gap / 2;
                const r = Math.min(3, w / 2), y = Math.min(PH - 2, Y(v));
                s += `<path d="M${x.toFixed(1)},${PH} V${(y + r).toFixed(1)} q0,-${r} ${r},-${r} H${(x + w - r).toFixed(1)} q${r},0 ${r},${r} V${PH} Z" fill="${_NL_C.down}" opacity=".9"/>`;
            });
        }
        // цифры: сначала самые большие значения, соседние ближе 18 px не подписываем
        const placed = [];
        vals.map((v, k) => [v, k]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0]).forEach(([v, k]) => {
            const x = cx(k), w = String(v).length * 6 + 6;
            if (placed.some(px => Math.abs(px - x) < Math.max(18, w))) return;
            placed.push(x);
            s += `<text x="${x.toFixed(1)}" y="${(Y(v) - 6).toFixed(1)}" fill="#e6edf3" font-size="10.5" font-weight="600" text-anchor="middle" pointer-events="none">${v}</text>`;
        });
        s += `<line class="nl-xh" x1="0" y1="${TOP - 6}" x2="0" y2="${PH}" stroke="#8b949e" stroke-dasharray="3 3" visibility="hidden"/>`;
        s += `<circle class="nl-xp" r="4.5" fill="${_NL_C.down}" stroke="#e6edf3" stroke-width="1.5" visibility="hidden"/>`;
        el.innerHTML = s + '</svg>';
        const svg = el.firstChild, xh = svg.querySelector('.nl-xh'), xp = svg.querySelector('.nl-xp');
        const off = () => { xh.setAttribute('visibility', 'hidden'); xp.setAttribute('visibility', 'hidden'); hide(); };
        svg.addEventListener('mousemove', ev => {
            const px = ev.clientX - svg.getBoundingClientRect().left;
            if (px < L || px > W - 4) return off();
            // ближайшая корзина к курсору
            let k = 0, dmin = 1e9;
            pos.forEach((p, q) => { const dd = Math.abs(cx(q) - px); if (dd < dmin) { dmin = dd; k = q; } });
            const x = cx(k).toFixed(1);
            xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
            xp.setAttribute('cx', x); xp.setAttribute('cy', Y(vals[k]).toFixed(1)); xp.setAttribute('visibility', line ? 'visible' : 'hidden');
            show(ev, tipAt(k, vals[k]));
        });
        svg.addEventListener('mouseleave', off);
    };

    // only = имя порта → график ТОЛЬКО этого порта и его событий (детализация)
    const drawSpeed = (mainEl, only) => {
    if (mainEl) {
        const U = only ? 'd' + only.replace(/[^a-z0-9]/gi, '') : 'm';
        const onlyF = only ? d.ifaces.find(f => f.name === only) : null;
        const sts = (d.speedtests || []).filter(x => !onlyF || (onlyF.role === 'WAN' && x.path === 'direct') || (onlyF.role === 'VPN' && x.path === 'vpn'));
        // детальный график живёт в ячейке таблицы: ширину берём от самой таблицы портов,
        // иначе SVG растягивает ячейку и таблица уезжает в горизонтальный скролл
        const host = only && mainEl.closest('.nl-ports');
        const LM = 34, W = Math.max(280, host ? host.clientWidth - 46 : mainEl.clientWidth), PW = W - LM - 6;
        const ROW = 15, NROWS = 3, BTOP = 4 + ROW * NROWS, TOP = BTOP + 10, H = only ? 230 : 300, PH = H - 24;
        const X = t => LM + (t - t0) / span * PW;
        const wanF = d.ifaces.find(f => f.role === 'WAN');
        const vis = serDefs.filter(q => only ? q.m.name === only : _nlSerOn(q));
        const pts = q => q.m.t.map((t, k) => [t * 1000, q.m[q.dir][k], q.m[q.dir + '_pk'][k]]).filter(p => p[0] >= t0 - met.bucket_s * 1000);
        // Автомасштаб по трафику: верх шкалы — по 98-му перцентилю, а не по одному
        // максимуму (редкий всплеск не сплющивает график); всплески выше — упираются
        // в верх со стрелкой и настоящей цифрой. Дробные шаги — чтобы и 0.05 Мбит/с было видно.
        const allV = [];
        vis.forEach(q => pts(q).forEach(p => { if (p[1] > 0) allV.push(p[1]); }));
        allV.sort((a, b) => a - b);
        const vmax = allV.length ? allV[allV.length - 1] : 0;
        const p98 = allV.length ? allV[Math.floor(0.98 * (allV.length - 1))] : 0;
        let mx = vmax <= p98 * 1.35 ? vmax : p98;          // нет выбросов — весь диапазон
        // замер интернетометра — в шкалу, только если он не улетает далеко выше трафика
        sts.forEach(x => { if (x.down && x.down <= Math.max(mx, 0.05) * 1.6) mx = Math.max(mx, x.down); });
        mx = Math.max(mx, 0.05);
        const stepY = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(x => mx * 1.12 / x <= 4) || 2000;
        const topV = Math.ceil(mx * 1.12 / stepY) * stepY;
        const Y = v => PH - Math.min(v, topV) / topV * (PH - TOP);
        const fmtV = v => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v >= 1 ? (+v.toFixed(1)).toString() : (+v.toFixed(2)).toString();

        // ── внештатные события — полупрозрачные полосы ПОВЕРХ графика с подписью сверху ──
        const ann = [];
        const roleName = f => f.role || f.name;
        const slowF = onlyF || wanF;
        if (slowF) slowF.segments.filter(g => g.state === 'slow').forEach(g =>
            ann.push({ a: _nlT(g.from), b: _nlT(g.to), k: 'slow', label: `${_nlRoleTxt(slowF.role)} ${g.speed || ''} Мбит/с`, tip: `${slowF.name} на ${g.speed} Мбит/с вместо ${slowF.full_speed}` }));
        // отвалы: близкие склеиваем в одну полосу (иначе при «моргании» — частокол)
        const near = span * 14 / PW;                 // ближе 14 px — одна полоса
        d.ifaces.filter(f => !only || f.name === only).forEach(f => {
            const ev = f.events.filter(e => _nlIsDrop(e) && !(f.role === 'VPN' && (e.dur || 0) <= 3))
                .map(e => ({ a: _nlT(e.ts), b: _nlT(e.ts) + (e.dur || 0) * 1000 })).sort((x, y) => x.a - y.a);
            let cur = null;
            const flush = () => { if (!cur) return;
                const who = roleName(f) + (f.role ? '' : '');
                ann.push({ a: cur.a, b: cur.b, k: f.role === 'VPN' ? 'vpn' : 'drop',
                    label: cur.n > 1 ? `${f.role === 'VPN' ? 'VPN' : 'отвалы ' + who} ×${cur.n}` : (f.role === 'VPN' ? 'VPN пропал' : `отвал ${who}`),
                    tip: `${f.name}: ${cur.n > 1 ? cur.n + ' отвалов' : 'отвал'}, всего без линка ${_nlDur(cur.down)}` }); cur = null; };
            ev.forEach(e => {
                if (cur && e.a - cur.b <= near) { cur.b = Math.max(cur.b, e.b); cur.n++; cur.down += (e.b - e.a) / 1000; }
                else { flush(); cur = { a: e.a, b: e.b, n: 1, down: (e.b - e.a) / 1000 }; }
            });
            flush();
        });
        (d.off || []).filter(o => _nlT(o.to) - _nlT(o.from) >= 3600e3 && _nlT(o.to) > t0).forEach(o =>
            ann.push({ a: _nlT(o.from), b: _nlT(o.to), k: 'off', label: 'шлюз выключен', tip: 'шлюз был выключен' }));
        // однотипные полосы одного порта ближе 14 px — одна полоса (иначе «WAN 10» стопкой)
        ann.forEach(o => { const m = /×(\d+)/.exec(o.label); o.n = m ? +m[1] : 1; o.grp = o.k + '|' + o.label.replace(/ ×\d+$/, '').replace(/^отвал /, 'отвалы '); });
        ann.sort((x, y) => x.grp < y.grp ? -1 : x.grp > y.grp ? 1 : x.a - y.a);
        const merged = [];
        ann.forEach(o => {
            const l = merged[merged.length - 1];
            if (l && l.grp === o.grp && o.a - l.b <= near) { l.b = Math.max(l.b, o.b); l.n += o.n; l.tip = o.tip; }
            else merged.push({ ...o });
        });
        merged.forEach(o => {
            if (o.k === 'drop' && o.n > 1) o.label = o.grp.split('|')[1] + ' ×' + o.n;
            if (o.k === 'vpn' && o.n > 1) o.label = 'VPN ×' + o.n;
            if (o.n > 1 && o.k !== 'slow') o.tip = o.tip.replace(/^([^:]+):.*$/, `$1: ${o.n} отвалов`);
        });
        ann.length = 0; merged.sort((x, y) => x.a - y.a).forEach(o => ann.push(o));
        // важность подписи: пониженная скорость и крупные пачки отвалов — первыми
        ann.forEach(o => { const m = /×(\d+)/.exec(o.label); o.pr = { slow: 1000, drop: 100, vpn: 10, off: 1 }[o.k] + (m ? +m[1] : 1); });
        const AC = { slow: _NL_C.slow, drop: _NL_C.down, vpn: '#3fb9a7', off: '#8b949e' };
        const AO = { slow: .13, drop: .16, vpn: .10, off: .0 };

        let sv = `<svg width="${W}" height="${H}" class="nl-svg"><defs>
            <pattern id="${U}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#8b949e" stroke-width="2" opacity=".35"/></pattern>
            <clipPath id="${U}c"><rect x="${LM}" y="0" width="${PW}" height="${H}"/></clipPath>
            ${vis.map((q, n) => `<linearGradient id="${U}g${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${_nlColor(q.m)}" stop-opacity="${q.dir === 'dn' ? .26 : .07}"/>
                <stop offset="1" stop-color="${_nlColor(q.m)}" stop-opacity="0"/></linearGradient>`).join('')}</defs>`;
        // сетка и оси
        for (let k = 0; k * stepY <= topV + 1e-9; k++) {
            const v = +(k * stepY).toFixed(3), y = Math.round(Y(v)) + 0.5;
            sv += `<line x1="${LM}" y1="${y}" x2="${LM + PW}" y2="${y}" stroke="${v ? _NL_C.grid : '#30363d'}"/>
                <text x="${LM - 6}" y="${y + 3.5}" fill="${_NL_C.axis}" font-size="10.5" text-anchor="end">${fmtV(v)}</text>`;
        }
        sv += axisSvg(W, X, BTOP, PH, PH + 17, LM + 14);
        // серии скорости
        sv += '<g clip-path="url(#${U}c)">';
        const gap = met ? met.bucket_s * 1000 * 2.5 : 0;
        vis.forEach((q, n) => {
            const P = pts(q), runs = []; let cur = [];
            P.forEach((p, k) => { if (k && p[0] - P[k - 1][0] > gap) { runs.push(cur); cur = []; } cur.push([X(p[0] + met.bucket_s * 500), Y(p[1])]); });
            if (cur.length) runs.push(cur);
            runs.forEach(r => {
                if (r.length === 1) { sv += `<circle cx="${r[0][0].toFixed(1)}" cy="${r[0][1].toFixed(1)}" r="3" fill="${_nlColor(q.m)}"/>`; return; }
                const line = _nlSmooth(r);
                if (q.dir === 'dn') sv += `<path d="${line} L${r[r.length - 1][0].toFixed(1)},${PH} L${r[0][0].toFixed(1)},${PH} Z" fill="url(#${U}g${n})"/>`;
                sv += `<path d="${line}" fill="none" stroke="${_nlColor(q.m)}" stroke-width="${q.dir === 'dn' ? 2 : 1.4}" ${q.dir === 'up' ? 'stroke-dasharray="4 3" stroke-opacity=".8"' : ''} stroke-linejoin="round"/>`;
            });
        });
        // полосы событий поверх графика
        ann.sort((x, y) => x.a - y.a);
        ann.forEach(o => {
            const a = X(Math.max(o.a, t0)), b = X(Math.min(o.b, t1)); if (b < LM) return;
            const w = Math.max(3, b - a), x = b - a < 3 ? (a + b) / 2 - 1.5 : a;
            o.x = x; o.w = w;
            sv += o.k === 'off'
                ? `<rect x="${x.toFixed(1)}" y="${BTOP}" width="${w.toFixed(1)}" height="${PH - BTOP}" fill="url(#${U}h)"/>`
                : `<rect x="${x.toFixed(1)}" y="${BTOP}" width="${w.toFixed(1)}" height="${PH - BTOP}" fill="${AC[o.k]}" opacity="${AO[o.k]}"/>`;
            sv += `<rect x="${x.toFixed(1)}" y="${BTOP}" width="${w.toFixed(1)}" height="2" fill="${AC[o.k]}"/>`;
        });
        // замеры интернетометра — ромбы на уровне измеренной скорости
        sts.forEach(x => {
            const tx = X(_nlT(x.ts)), y = Y(x.down || 0); if (tx < LM || !x.down) return;
            sv += `<path d="M${tx.toFixed(1)},${(y - 6).toFixed(1)} l6,6 l-6,6 l-6,-6 Z" fill="#f0f6fc" stroke="#0d1117" stroke-width="1.2"/>`;
            if (x.down > topV) sv += `<text x="${(tx + 9).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="#f0f6fc" font-size="10" font-weight="600">▲ ${fmtV(x.down)}</text>`;
        });
        sv += '</g>';
        // подписи событий сверху: раскладываем по рядам, чтобы не наезжали
        const rows = Array.from({ length: NROWS }, () => []);
        let nlab = 0;
        ann.slice().sort((x, y) => y.pr - x.pr).forEach(o => {
            if (o.x == null || nlab >= 7) return;
            const tw = o.label.length * 6.1 + 12;
            let lx = Math.min(Math.max(o.x + o.w / 2 - tw / 2, LM), LM + PW - tw);
            const r = rows.findIndex(row => row.every(([s0, s1]) => lx > s1 + 4 || lx + tw < s0 - 4));
            if (r < 0) return;
            rows[r].push([lx, lx + tw]); nlab++;
            const y = 4 + (NROWS - 1 - r) * ROW;
            sv += `<g pointer-events="none"><line x1="${(o.x + o.w / 2).toFixed(1)}" y1="${y + 12}" x2="${(o.x + o.w / 2).toFixed(1)}" y2="${BTOP}" stroke="${AC[o.k]}" stroke-opacity=".6"/>
                <rect x="${lx.toFixed(1)}" y="${y}" width="${tw.toFixed(1)}" height="13" rx="3" fill="#161b22" stroke="${AC[o.k]}" stroke-opacity=".75"/>
                <text x="${(lx + tw / 2).toFixed(1)}" y="${y + 9.8}" fill="${AC[o.k]}" font-size="10" font-weight="600" text-anchor="middle">${_esc(o.label)}</text></g>`;
        });
        // цифры на пиках ↓
        const lab = [];
        vis.filter(q => q.dir === 'dn').forEach(q => { const P = pts(q); P.forEach((p, k) => {
            if (p[1] > topV * 0.04 && p[1] >= (P[k - 1] || [0, 0])[1] && p[1] >= (P[k + 1] || [0, 0])[1]) lab.push({ v: p[1], x: X(p[0] + met.bucket_s * 500), c: _nlColor(q.m) });
        }); });
        const placed = [];
        lab.sort((a, b) => b.v - a.v).forEach(o => {
            if (placed.length >= 8) return;
            const txt = (o.v > topV ? '▲ ' : '') + fmtV(o.v), w = txt.length * 6.5 + 10, ty = o.v > topV ? TOP + 12 : Y(o.v) - 9;
            if (ty < TOP + 4 || o.x < LM + w / 2 || o.x > LM + PW - w / 2 || placed.some(p => Math.abs(p.x - o.x) < (w + p.w) / 2 + 4 && Math.abs(p.y - ty) < 16)) return;
            placed.push({ x: o.x, y: ty, w });
            sv += `<g pointer-events="none"><rect x="${(o.x - w / 2).toFixed(1)}" y="${(ty - 10).toFixed(1)}" width="${w}" height="14" rx="3" fill="#0d1117" stroke="${o.c}" stroke-opacity=".7"/>
                <text x="${o.x.toFixed(1)}" y="${(ty + 0.5).toFixed(1)}" fill="#e6edf3" font-size="10.5" font-weight="600" text-anchor="middle">${txt}</text></g>`;
        });
        const covFrom = met && met.data_from ? met.data_from * 1000 : null;
        if (met && covFrom && (t1 - covFrom) < span * 0.15 && _nlDays > 1) {
            const short = _nlDur((t1 - covFrom) / 1000);
            sv += `<rect x="${LM + PW / 2 - 260}" y="${(TOP + PH) / 2 - 26}" width="520" height="44" rx="8" fill="#161b22" stroke="#30363d"/>
                <text x="${LM + PW / 2}" y="${(TOP + PH) / 2 - 8}" fill="#c9d1d9" font-size="12" text-anchor="middle">Скорость пишется с ${_nlFmt(covFrom)} — пока ${short} истории, на этом масштабе её не видно.</text>
                <text x="${LM + PW / 2}" y="${(TOP + PH) / 2 + 9}" fill="${_NL_C.axis}" font-size="11" text-anchor="middle">Выберите «Сутки». Отвалы и пониженная скорость — полосами за весь период.</text>`;
        }
        if (!met) sv += `<text x="${LM + PW / 2}" y="${(TOP + PH) / 2}" fill="${_NL_C.axis}" font-size="12" text-anchor="middle">История скорости копится с момента обновления — первые точки появятся через пару минут.</text>
            <text x="${LM + PW / 2}" y="${(TOP + PH) / 2 + 18}" fill="${_NL_C.axis}" font-size="11" text-anchor="middle" opacity=".8">Выделенные события (отвалы, пониженная скорость, выключения) — уже за весь период, из журнала шлюза.</text>`;
        sv += `<line class="nl-xh" x1="0" y1="${BTOP}" x2="0" y2="${PH}" stroke="#8b949e" stroke-dasharray="3 3" visibility="hidden"/>`;
        vis.forEach((q, n) => { sv += `<circle class="nl-xp" data-n="${n}" r="4" fill="${_nlColor(q.m)}" stroke="#e6edf3" stroke-width="1.5" visibility="hidden"/>`; });
        mainEl.innerHTML = sv + '</svg>';
        const svg = mainEl.firstChild, xh = svg.querySelector('.nl-xh'), xps = svg.querySelectorAll('.nl-xp');
        const off = () => { xh.setAttribute('visibility', 'hidden'); xps.forEach(c => c.setAttribute('visibility', 'hidden')); hide(); };
        svg.addEventListener('mousemove', ev => {
            const px = ev.clientX - svg.getBoundingClientRect().left;
            if (px < LM || px > LM + PW) return off();
            const t = t0 + (px - LM) / PW * span, tol = 4 / PW * span;
            xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
            let html = `<b>${_nlFmt(t)}</b>`;
            if (met) {
                const bs = met.bucket_s * 1000;
                vis.forEach((q, n) => {
                    const p = pts(q).find(p => p[0] <= t && t < p[0] + bs), c = xps[n];
                    if (!p) { c.setAttribute('visibility', 'hidden'); return; }
                    c.setAttribute('cx', X(p[0] + bs / 2).toFixed(1)); c.setAttribute('cy', Y(p[1]).toFixed(1)); c.setAttribute('visibility', 'visible');
                    html += `<div class="nl-tr"><i style="background:${_nlColor(q.m)}"></i>${_esc(q.m.name)} <span>${q.dir === 'dn' ? '↓' : '↑'} ср. / пик</span><b>${p[1]} / ${p[2]}</b></div>`;
                });
            }
            ann.filter(o => o.a - tol <= t && t <= o.b + tol).forEach(o => {
                html += `<div class="nl-tr"><i style="background:${AC[o.k]}"></i><span style="color:${AC[o.k]}">${_esc(o.tip)}</span></div>
                    <div class="nl-tr c-mut" style="margin-top:0;font-size:.74rem">${_nlFmt(o.a, true)} — ${_nlFmt(o.b, true)} · ${_nlDur((o.b - o.a) / 1000)}</div>`;
            });
            sts.forEach(x => { if (Math.abs(_nlT(x.ts) - t) <= tol * 2) html += `<div class="nl-tr"><i style="background:#f0f6fc"></i>замер ${_esc(_ST_PROV[x.provider] || x.provider)} (${x.path === 'vpn' ? 'VPN' : 'напрямую'})<b>↓${x.down} ↑${x.up}</b></div>`; });
            show(ev, html);
        });
        svg.addEventListener('mouseleave', off);
    }
    };
    drawSpeed(body.querySelector('.nl-main'));
    body.querySelectorAll('.nl-det-chart').forEach(el => drawSpeed(el, el.dataset.n));
    const hodEl = body.querySelector('.nl-hod');
    if (hodEl) {
        const PW = Math.max(200, hodEl.clientWidth) - L - 4, Xh = k => L + k / 24 * PW;
        const every = PW < 360 ? 6 : 3;
        barChart(hodEl, hod, k => [Xh(k), Xh(k + 1)],
            (W, PH) => Array.from({ length: 24 / every }, (_, q) => q * every).map(k =>
                `<text x="${Xh(k)}" y="${PH + 14}" fill="${_NL_C.axis}" font-size="10.5" text-anchor="${k ? 'middle' : 'start'}">${_p2(k)}:00</text>`).join(''),
            (k, v) => `<b>${_p2(k)}:00 — ${_p2(k + 1)}:00</b><br>отвалов ${per}: <b>${v}</b>`, 96);
    }
}
let _nlRsz;
window.addEventListener('resize', () => { clearTimeout(_nlRsz); _nlRsz = setTimeout(() => { const t = $('tab-logs'); if (t && t.classList.contains('active')) _nlRender(); }, 200); });
setInterval(() => { const t = $('tab-logs'); if (t && t.classList.contains('active')) loadNetlog(); }, 60000);

// ── Логи ──
async function loadLogs() {
    const d = await api('/api/logs?n=120'); if (!d) return;
    const box = $('log-box'); box.innerHTML = '';
    if (!d.lines.length) { box.innerHTML = '<div class="small">Журнал пуст</div>'; return; }
    d.lines.forEach(l => {
        const div = document.createElement('div');
        div.className = 'log-line ' + l.level;
        div.innerHTML = `<span class="lts">${_esc(l.ts)}</span><span class="lmsg">${_esc(l.msg)}</span>`;
        box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
}

// ══ Доступ к ресурсам (кастомный МЭ) + раздельное туннелирование ══
let _accData = {block:[],direct:[],groups:[],hosts:[]};
let _lastDevices = [];
const _esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function _renderAccessList(elId, items, kind) {
    const el = $(elId); if (!el) return;
    if (!items || !items.length) { el.innerHTML = '<div class="small">пусто</div>'; return; }
    el.innerHTML = items.map(d =>
        `<div class="access-row"><span>${_esc(d)}</span><button class="mini danger" onclick="accessRemove('${kind}','${_esc(d)}')">✕</button></div>`
    ).join('');
}

async function loadAccess() {
    // подтягиваем свежий список устройств (для резервов и подбора MAC)
    const dev = await api('/api/devices'); if (dev) _lastDevices = dev.devices || [];
    const d = await api('/api/access'); if (!d) return;
    _accData = d;
    const vrc = $('vpn-route-count'); if (vrc) vrc.textContent = d.vpn_route_count;
    _renderSplit(d.split || []);
    _renderRoutedBox(d.holes || []);
    _renderGroups(d.groups);
    _renderHosts();
}

function _hostName(mac){ const h=(_accData.hosts||[]).find(x=>x.mac===mac); return h&&h.name?h.name:''; }

// ── Сворачивание карточек (группы/ресурсы) ──
let _openCards = new Set();   // id карточек, которые сейчас раскрыты
function accToggle(el){
    const c=el.closest('.acc-item'); if(!c) return;
    const id=c.dataset.id;
    c.classList.toggle('collapsed');
    if(c.classList.contains('collapsed')) _openCards.delete(id); else _openCards.add(id);
}

// ══ Раздельное туннелирование: ссылки -> авто-адреса, мимо VPN ══
const _isCidrOrIp = v => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test((v||'').trim());

function _renderSplit(list) {
    const el=$('split-list'); if(!el) return;
    if(!list.length){ el.innerHTML='<div class="small">пусто — впиши ссылку выше, адреса соберутся сами</div>'; return; }
    el.innerHTML = list.map(r=>{
        const cidrs=r.cidrs||[], doms=r.domains||[];
        const dchips=doms.map(d=>`<span class="chip dom">${_esc(d)}<button onclick="splitDel('${r.id}','domain','${_esc(d)}')">✕</button></span>`).join('');
        const cchips=cidrs.map(c=>`<span class="chip">${_esc(c)}<button onclick="splitDel('${r.id}','cidr','${_esc(c)}')">✕</button></span>`).join('');
        return `<div class="acc-item grp-card ${_openCards.has(r.id)?'':'collapsed'}" data-id="${r.id}">
          <div class="acc-item-head acc-toggle" onclick="accToggle(this)">
            <span class="caret">▶</span> <b>${_esc(r.name)}</b> <span class="small">· ${cidrs.length} адр.</span>
            <span class="acc-actions"><button class="mini danger" onclick="event.stopPropagation();splitDelete('${r.id}')">✕</button></span>
          </div>
          <div class="acc-body">
            <input class="access-input" id="sn-${r.id}" value="${_esc(r.name)}" placeholder="имя">
            <input class="access-input" id="sd-${r.id}" value="${_esc(r.desc||'')}" placeholder="описание (необязательно)">
            <div class="small" style="margin-top:.3rem">Ссылки: ${dchips||'<span class="muted">—</span>'}</div>
            <div class="small" style="margin-top:.3rem">Собранные адреса (идут мимо VPN):</div>
            <div class="grp-chips">${cchips||'<span class="muted">адресов нет — нажми «↻ адреса»</span>'}</div>
            <div class="btns">
              <input class="access-input" id="sadd-${r.id}" placeholder="+ ещё ссылка" onkeydown="if(event.key==='Enter'){event.preventDefault();splitAdd('${r.id}');}">
              <button onclick="splitAdd('${r.id}')">+ ссылка</button>
              <button class="mini" onclick="splitRefresh('${r.id}')">${GWFX.ic('refresh')} адреса</button>
              <button class="success mini" onclick="splitMeta('${r.id}')">${GWFX.ic('save')} сохранить имя</button>
            </div>
            <div class="small" id="sr-${r.id}"></div>
          </div>
        </div>`;
    }).join('');
}
async function splitCreate(){
    const v=$('split-new').value.trim(), res=$('split-result'); if(!v) return;
    res.innerHTML='<span class="small">собираю адреса…</span>';
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'create', name:v})});
    if(d&&d.ok){ $('split-new').value=''; res.innerHTML='<span style="color:var(--good)">✓ адреса собраны, идут напрямую</span>'; loadAccess(); setTimeout(()=>res.textContent='',2500); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function splitAdd(id){
    const inp=$('sadd-'+id), v=inp.value.trim(), res=$('sr-'+id); if(!v) return;
    _openCards.add(id);   // не сворачивать карточку после добавления
    res.innerHTML='<span class="small">собираю…</span>';
    const body=_isCidrOrIp(v)?{action:'add_cidr',id,cidr:v}:{action:'add_domain',id,domain:v};
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(d&&d.ok){ inp.value=''; loadAccess(); } else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function splitRefresh(id){
    const res=$('sr-'+id); res.innerHTML='<span class="small">перерезолвлю адреса…</span>';
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refresh',id})});
    if(d&&d.ok) loadAccess(); else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function splitDel(id,kind,val){
    const body=kind==='cidr'?{action:'del_cidr',id,cidr:val}:{action:'del_domain',id,domain:val};
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(d&&d.ok) loadAccess();
}
async function splitMeta(id){
    const name=$('sn-'+id).value.trim(), desc=$('sd-'+id).value.trim(), res=$('sr-'+id);
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'update',id,name,desc})});
    if(d&&d.ok){ res.innerHTML='<span style="color:var(--good)">✓ сохранено</span>'; loadAccess(); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function splitDelete(id){
    if(!await uiConfirm('Удалить ресурс раздельного туннелирования?')) return;
    const d=await api('/api/split',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',id})});
    if(d&&d.ok) loadAccess();
}
function splitExport(){ window.location.href='/api/split/export'; }
async function splitFromKey(){
    const res=$('split-fromkey-result'); res.innerHTML='<span class="small">собираю дырки из ключа…</span>';
    const d=await api('/api/vpn/extract-holes',{method:'POST'});
    if(d&&d.ok){
        res.innerHTML=`<span style="color:var(--good)">✓ дырок ${d.holes}: +${d.added} новых, схлопнуто ${d.merged}, убрано лишних ${d.removed_redundant}</span>`;
        toast(`Обход из ключа: +${d.added} новых, схлопнуто ${d.merged}`, 'ok');
        loadAccess();
    } else { res.innerHTML=''; toast((d&&d.error)||'ошибка', 'bad'); }
}
const _splitFile=$('split-import-file');
if(_splitFile) _splitFile.addEventListener('change', async e=>{
    const f=e.target.files[0]; if(!f) return; const res=$('split-import-result'); res.textContent='импортирую…';
    try{
        const obj=JSON.parse(await f.text());
        const resources=obj.resources||obj;
        const d=await api('/api/split/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resources})});
        if(d&&d.ok){ res.innerHTML=`<span style="color:var(--good)">✓ добавлено: ${d.added}</span>`; loadAccess(); }
        else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
    }catch(err){ res.innerHTML='<span style="color:var(--bad)">✗ неверный JSON</span>'; }
    e.target.value='';
});

// Дырки ключа (что шло напрямую) — показываем, собираются в split автоматически
function _renderRoutedBox(holes){
    const box=$('routed-box'); if(!box) return;
    if(!holes.length){ box.style.display='none'; return; }
    box.style.display='block';
    $('routed-count').textContent = holes.length;
    $('routed-list').innerHTML = holes.map(h=>`<div class="access-row"><span>${_esc(h)}</span></div>`).join('');
}

// ── Группы: создание + редактирование + сайты + блок-политика ──
async function grpCreate() {
    const name=$('grp-new-name').value.trim(), desc=$('grp-new-desc').value.trim(), res=$('grp-create-result');
    const d = await api('/api/access/group',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'create', name, desc, scope:'all'})});
    if (d&&d.ok){ $('grp-new-name').value=''; $('grp-new-desc').value='';
        res.innerHTML='<span style="color:var(--good)">✓ группа создана — добавь в неё сайты ниже</span>'; loadAccess();
        setTimeout(()=>res.textContent='',3000); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function grpMetaSave(id) {
    const name=$('gn-'+id).value.trim(), desc=$('gd-'+id).value.trim(), scope=$('gs-'+id).value;
    const macs=Array.from($('gm-'+id).querySelectorAll('input:checked')).map(i=>i.value);
    const res=$('gr-'+id); res.textContent='сохраняю…';
    const d = await api('/api/access/group',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'update', id, name, desc, scope, macs})});
    if (d&&d.ok){ res.innerHTML='<span style="color:var(--good)">✓ сохранено</span>'; loadAccess(); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function grpAddDomain(id) {
    const inp=$('gadd-'+id), v=inp.value.trim(), res=$('gr-'+id); if(!v) return;
    _openCards.add(id);   // не сворачивать группу после добавления сайта
    res.textContent='резолвлю…';
    const d=await api('/api/access/group',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'add_domain', id, domain:v})});
    if(d&&d.ok){ inp.value=''; loadAccess(); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function grpDelDomain(id, domain) {
    const d=await api('/api/access/group',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'del_domain', id, domain})});
    if(d&&d.ok) loadAccess();
}
async function grpDelete(id) {
    if(!await uiConfirm('Удалить группу?')) return;
    const d=await api('/api/access/group',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'delete', id})});
    if(d&&d.ok) loadAccess();
}
function grpScopeToggle(id){
    const s=$('gs-'+id).value;
    $('gm-'+id).style.display=(s==='only'||s==='except')?'flex':'none';
}
function _macOptions(selected){
    const seen={}, list=[];
    _lastDevices.forEach(dev=>{ if(!seen[dev.mac]){seen[dev.mac]=1; list.push({mac:dev.mac,label:_hostName(dev.mac)||dev.name||dev.ip||dev.mac});}});
    (_accData.hosts||[]).forEach(h=>{ if(!seen[h.mac]){seen[h.mac]=1; list.push({mac:h.mac,label:h.name||h.mac});}});
    if(!list.length) return '<div class="small">нет устройств в сети</div>';
    return list.map(x=>`<label class="mac-chip"><input type="checkbox" value="${x.mac}" ${selected.includes(x.mac)?'checked':''}> ${_esc(x.label)} <span class="small">${x.mac}</span></label>`).join('');
}
const _scopeLabel={off:'не блокируется', all:'блок всем', only:'блок только выбранным', except:'блок всем кроме выбранных'};
function _renderGroups(groups) {
    const el=$('groups-list'); if(!el) return;
    if(!groups||!groups.length){ el.innerHTML='<div class="small">групп пока нет — создай первую выше</div>'; return; }
    el.innerHTML = groups.map(g=>{
        const scope=g.scope||'all', macs=g.macs||[];
        const chips=(g.domains||[]).length
            ? g.domains.map(d=>`<span class="chip">${_esc(d)}<button onclick="grpDelDomain('${g.id}','${_esc(d)}')">✕</button></span>`).join('')
            : '<span class="small">сайтов пока нет — добавь ниже</span>';
        const badgeCls = scope==='off' ? 'muted' : 'bad';
        return `<div class="acc-item grp-card ${_openCards.has(g.id)?'':'collapsed'}" data-id="${g.id}">
          <div class="acc-item-head acc-toggle" onclick="accToggle(this)">
            <span class="caret">▶</span> <b>${_esc(g.name)||'<span class="muted">без названия</span>'}</b>
            <span class="small">· ${(g.domains||[]).length} сайтов · <span class="${badgeCls}">${_scopeLabel[scope]||scope}</span></span>
            <span class="acc-actions"><button class="mini danger" onclick="event.stopPropagation();grpDelete('${g.id}')">✕</button></span>
          </div>
          <div class="acc-body">
            <input class="access-input grp-name-in" id="gn-${g.id}" value="${_esc(g.name)}" placeholder="название группы (необязательно)">
            <input class="access-input" id="gd-${g.id}" value="${_esc(g.desc||'')}" placeholder="описание (необязательно)">
            <div class="small" style="margin-top:.3rem">Сайты:</div>
            <div class="grp-chips">${chips}</div>
            <div class="btns">
              <input class="access-input" id="gadd-${g.id}" placeholder="добавить сайт — напр. youtube.com" onkeydown="if(event.key==='Enter'){event.preventDefault();grpAddDomain('${g.id}');}">
              <button onclick="grpAddDomain('${g.id}')">+ сайт</button>
            </div>
            <div class="grp-policy">
              <span class="small">Блокировать:</span>
              <select class="access-input" id="gs-${g.id}" onchange="grpScopeToggle('${g.id}')">
                <option value="off" ${scope==='off'?'selected':''}>не блокировать</option>
                <option value="all" ${scope==='all'?'selected':''}>всем</option>
                <option value="only" ${scope==='only'?'selected':''}>только выбранным</option>
                <option value="except" ${scope==='except'?'selected':''}>всем кроме выбранных</option>
              </select>
            </div>
            <div class="mac-picker" id="gm-${g.id}" style="display:${(scope==='only'||scope==='except')?'flex':'none'}">${_macOptions(macs)}</div>
            <div class="btns"><button class="success" onclick="grpMetaSave('${g.id}')">${GWFX.ic('save')} Сохранить группу</button></div>
            <div class="small" id="gr-${g.id}"></div>
          </div>
        </div>`;
    }).join('');
}

// ── Устройства: автосписок из сети, имя из DHCP, закрепление IP ──
function _renderHosts() {
    const el=$('hosts-list'); if(!el) return;
    const seen={}, rows=[];
    // dhcpName — имя, которое устройство само сообщило по DHCP (автоматом)
    const _eg = h => (['vpn','internet','local'].includes(h.egress) ? h.egress : (h.direct ? 'internet' : 'vpn'));
    _lastDevices.forEach(dev=>{ seen[dev.mac]=1; const h=(_accData.hosts||[]).find(x=>x.mac===dev.mac)||{};
        rows.push({mac:dev.mac,name:h.name||'',dhcp:dev.name||'',ip:h.ip||'',online:true,curip:dev.ip,egress:_eg(h),isolated:!!h.isolated});});
    (_accData.hosts||[]).forEach(h=>{ if(!seen[h.mac]) rows.push({mac:h.mac,name:h.name||'',dhcp:'',ip:h.ip||'',online:false,curip:'',egress:_eg(h),isolated:!!h.isolated});});
    if(!rows.length){ el.innerHTML='<div class="small">нет устройств</div>'; return; }
    el.innerHTML = rows.map(r=>{
        const shown = r.name || r.dhcp || r.curip || r.mac;
        const eo = (v,t) => `<option value="${v}"${r.egress===v?' selected':''}>${t}</option>`;
        return `<div class="acc-item host-pol-${r.egress}">
        <div class="acc-item-head"><b><span class="dot${r.online?' on':''}"></span> ${_esc(shown)}</b> <span class="small">${r.mac}${r.curip?(' · '+r.curip):''}${r.dhcp&&!r.name?(' · имя по DHCP: '+_esc(r.dhcp)):''}</span>
          <span class="acc-actions host-pol">
            <select class="access-input pol-sel" id="hp-${r.mac}" onchange="hostPolicy('${r.mac}')" title="Куда выпускать трафик устройства: через VPN-туннель, напрямую в интернет (мимо VPN) или только в локальную сеть без интернета">
              ${eo('vpn','🔒 через VPN')}${eo('internet','🌐 напрямую (мимо VPN)')}${eo('local','🏠 только локалка')}
            </select>
            <label class="seg-chk" title="Изолировать: устройство не сможет обращаться к другим устройствам локальной сети (шлюз, интернет/VPN по выбранному режиму — работают)"><input type="checkbox" id="hpi-${r.mac}" onchange="hostPolicy('${r.mac}')" ${r.isolated?'checked':''}> изолировать</label>
          </span></div>
        <div class="btns host-edit">
          <input class="access-input" id="hn-${r.mac}" placeholder="${r.dhcp?_esc(r.dhcp):'имя'}" value="${_esc(r.name)}">
          <input class="access-input" id="hi-${r.mac}" placeholder="закрепить IP 192.168.88.x" value="${_esc(r.ip)}">
          <button class="success mini" onclick="hostSave('${r.mac}')">${GWFX.ic('save')}</button>
          ${(r.name||r.ip)?`<button class="mini danger" onclick="hostDelete('${r.mac}')">✕</button>`:''}
        </div>
        <div class="small" id="hr-${r.mac}"></div>
      </div>`;
    }).join('');
    GWFX.icons(el);
}
async function hostPolicy(mac){
    const egress = ($('hp-'+mac)||{}).value || 'vpn';
    const isolated = !!(($('hpi-'+mac)||{}).checked);
    const d=await api('/api/access/host-policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mac,egress,isolated})});
    const names={vpn:'через VPN',internet:'напрямую (мимо VPN)',local:'только локальная сеть'};
    if(d&&d.ok){ toast('Устройство: '+names[egress]+(isolated?' + изоляция':''),'ok'); loadAccess(); }
    else toast((d&&d.error)||'ошибка','bad');
}
// совместимость (если где-то ещё вызывается)
async function hostDirect(mac, val){ const s=$('hp-'+mac); if(s){ s.value=val?'internet':'vpn'; } return hostPolicy(mac); }
async function hostSave(mac){
    const name=$('hn-'+mac).value.trim(), ip=$('hi-'+mac).value.trim(), res=$('hr-'+mac);
    res.textContent='…';
    const d=await api('/api/access/host',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'save',mac,name,ip})});
    if(d&&d.ok){ res.innerHTML='<span style="color:var(--good)">✓ сохранено (резерв применится при переподключении)</span>'; loadAccess(); }
    else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
}
async function hostDelete(mac){
    const d=await api('/api/access/host',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',mac})});
    if(d&&d.ok) loadAccess();
}

// ── Импорт / экспорт ──
function accessExport(){ window.location.href='/api/access/export'; }
function downloadConf(which){ window.location.href='/api/vpn/config-download?which='+encodeURIComponent(which); }
const _impFile = $('access-import-file');
if (_impFile) _impFile.addEventListener('change', async e=>{
    const f=e.target.files[0]; if(!f) return; const res=$('import-result');
    res.textContent='импортирую…';
    try {
        const obj = JSON.parse(await f.text());
        const d = await api('/api/access/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});
        if(d&&d.ok){ res.innerHTML='<span style="color:var(--good)">✓ импортировано</span>'; loadAccess(); }
        else res.innerHTML=`<span style="color:var(--bad)">✗ ${(d&&d.error)||'ошибка'}</span>`;
    } catch(err){ res.innerHTML='<span style="color:var(--bad)">✗ неверный JSON-файл</span>'; }
    e.target.value='';
});

// ── Документация (markdown-рендерер + загрузчик) ──
const _DOCS = [
    ['README.md', 'Содержание'],
    ['architecture.md', 'Архитектура'],
    ['build.md', 'Сборка образа'],
    ['install.md', 'Установка'],
    ['first-run.md', 'Первый запуск'],
    ['webui.md', 'Веб-панель'],
    ['vpn-split-tunneling.md', 'VPN и обход'],
    ['access-control.md', 'Контроль доступа'],
    ['segments.md', 'Управление устройствами'],
    ['security.md', 'Безопасность'],
    ['updates.md', 'Обновление шлюза'],
    ['backup.md', 'Резервные копии'],
    ['networking-failover.md', 'Сеть и failover'],
    ['network-diagnostics.md', 'Диагностика сети'],
    ['troubleshooting.md', 'Диагностика'],
];
let _docsLoaded = false;
// Красивые HTML-диаграммы вместо ASCII (блок ```gw-diagram <name>```)
function _docDiagram(name) {
    if (name === 'layers') return `
<div class="gwd gwd-layers">
  <div class="gwd-host">
    <div class="gwd-cap">ХОСТ · Debian 12 minimal<span class="gwd-dim"> — ядро · драйверы NIC · Docker · systemd</span></div>
    <div class="gwd-docker">
      <div class="gwd-cap">DOCKER · network_mode: host</div>
      <div class="gwd-row">
        <div class="gwd-svc s-awg"><b>gw-awg</b><span>AmneziaWG · VPN</span></div>
        <div class="gwd-svc s-dns"><b>gw-dnsmasq</b><span>DHCP + DNS</span></div>
        <div class="gwd-svc s-web"><b>gw-webui</b><span>FastAPI + nginx</span></div>
      </div>
    </div>
  </div>
</div>`;
    if (name === 'traffic') return `
<div class="gwd gwd-flow">
  <div class="gwd-chain">
    <div class="gwd-node"><b>Устройство</b><small>в LAN</small></div><div class="gwd-arr">→</div>
    <div class="gwd-node n-lan"><b>br-lan</b><small>192.168.88.1</small></div><div class="gwd-arr">→</div>
    <div class="gwd-node n-route"><b>Маршрут</b><small>на шлюзе</small></div>
  </div>
  <div class="gwd-branches">
    <div class="gwd-branch">
      <div class="gwd-tag good">по умолчанию · 0.0.0.0/0</div>
      <div class="gwd-node n-vpn"><b>awg0 · VPN</b><small>AmneziaWG</small></div><div class="gwd-arr">→</div>
      <div class="gwd-node n-net"><b>Интернет</b><small>зашифровано</small></div>
    </div>
    <div class="gwd-branch">
      <div class="gwd-tag">обход (split) · адреса ресурсов</div>
      <div class="gwd-node n-wan"><b>WAN · провайдер</b><small>напрямую</small></div><div class="gwd-arr">→</div>
      <div class="gwd-node n-net"><b>Интернет</b><small>напрямую</small></div>
    </div>
  </div>
</div>`;
    if (name === 'failover') return `
<div class="gwd gwd-flowv">
  <div class="gwd-node n-vpn"><b>VPN работает</b></div>
  <div class="gwd-down">↓</div>
  <div class="gwd-node n-route"><b>watchdog · каждые 5 мин</b><small>туннель живой?</small></div>
  <div class="gwd-fork">
    <div class="gwd-col">
      <div class="gwd-tag good">да · хэндшейк свежий</div>
      <div class="gwd-node n-ok"><b>Режим VPN</b><small>трафик в туннеле</small></div>
    </div>
    <div class="gwd-col">
      <div class="gwd-tag warn">нет</div>
      <div class="gwd-node n-route"><b>endpoint доступен?</b></div>
      <div class="gwd-fork">
        <div class="gwd-col"><div class="gwd-tag good">да</div><div class="gwd-node n-vpn"><b>awg-up</b><small>поднять заново</small></div></div>
        <div class="gwd-col"><div class="gwd-tag bad">нет</div><div class="gwd-node n-wan"><b>fallback</b><small>трафик напрямую</small></div></div>
      </div>
    </div>
  </div>
</div>`;
    return '';
}

// эмодзи в доке → цветные иконки / статус-точки (по стилю)
const _DOC_EMOJI = {
    '🟢': '<span class="dot ok"></span>', '🟡': '<span class="dot warn"></span>',
    '🔴': '<span class="dot bad"></span>', '⚪': '<span class="dot off"></span>',
    '⚠': 'warn', '✅': 'check', '✓': 'check', '❌': 'cross', '✗': 'cross',
    '📚': 'book', '💾': 'save', '🐞': 'bug', '✈': 'send', '✉': 'mail',
    '📥': 'import', '⬇': 'import', '⬆': 'upload'
};
const _DOC_EMOJI_RE = new RegExp('(' + Object.keys(_DOC_EMOJI).join('|') + ')', 'g');
function _mdInline(s) {
    // убрать сырые HTML-блок-теги из markdown (div align=center и т.п.)
    s = s.replace(/<\/?(?:div|center|p|span|img|picture|source|sub|sup|font|small|h[1-6]|table|thead|tbody|tr|td|th|details|summary|br)[^>]*>/gi, '');
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m,t,u)=>{
            const isMd = /\.md(#|$)/.test(u), ext = /^https?:/.test(u);
            return `<a href="${u}" class="${isMd?'doclink':''}" ${ext?'target="_blank" rel="noopener"':''}>${t}</a>`;
        });
    // эмодзи -> иконки/точки ПОСЛЕ экранирования (svg не экранируется повторно)
    return s.replace(_DOC_EMOJI_RE, ch => {
        const v = _DOC_EMOJI[ch]; if (!v) return '';
        return v.charAt(0) === '<' ? v : GWFX.ic(v);
    });
}
function mdToHtml(md) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const L = md.replace(/\r/g,'').split('\n'); let h='', i=0;
    while (i < L.length) {
        const l = L[i];
        if (/^```/.test(l)) {
            const lm = l.match(/^```\s*(\S+)?/), lang = (lm && lm[1]) || '';
            i++; let c=''; while(i<L.length && !/^```/.test(L[i])){ c+=L[i]+'\n'; i++; } i++;
            if (lang === 'gw-diagram') h += _docDiagram(c.trim());
            else h += `<pre class="md-pre"><code>${esc(c)}</code></pre>`;
            continue;
        }
        if (/^\|/.test(l) && i+1<L.length && /^\|[\s:|-]+\|$/.test(L[i+1])) {
            const rows=[]; while(i<L.length && /^\|/.test(L[i])){ rows.push(L[i]); i++; }
            const cells = r => r.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
            h+='<table class="md-table"><thead><tr>'+cells(rows[0]).map(c=>`<th>${_mdInline(c)}</th>`).join('')+'</tr></thead><tbody>';
            rows.slice(2).forEach(r=>{ h+='<tr>'+cells(r).map(c=>`<td>${_mdInline(c)}</td>`).join('')+'</tr>'; });
            h+='</tbody></table>'; continue;
        }
        let m = l.match(/^(#{1,4})\s+(.*)/);
        if (m) { const n=m[1].length; h+=`<h${n}>${_mdInline(m[2])}</h${n}>`; i++; continue; }
        if (/^---+\s*$/.test(l)) { h+='<hr>'; i++; continue; }
        if (/^>\s?/.test(l)) { let q=''; while(i<L.length && /^>\s?/.test(L[i])){ q+=L[i].replace(/^>\s?/,'')+' '; i++; } h+=`<blockquote>${_mdInline(q)}</blockquote>`; continue; }
        if (/^\s*[-*]\s+/.test(l)) { h+='<ul>'; while(i<L.length && /^\s*[-*]\s+/.test(L[i])){ h+=`<li>${_mdInline(L[i].replace(/^\s*[-*]\s+/,''))}</li>`; i++; } h+='</ul>'; continue; }
        if (/^\s*\d+\.\s+/.test(l)) { h+='<ol>'; while(i<L.length && /^\s*\d+\.\s+/.test(L[i])){ h+=`<li>${_mdInline(L[i].replace(/^\s*\d+\.\s+/,''))}</li>`; i++; } h+='</ol>'; continue; }
        if (/^\s*$/.test(l)) { i++; continue; }
        let p=l; i++;
        while (i<L.length && !/^\s*$/.test(L[i]) && !/^[#>|`]/.test(L[i]) && !/^---/.test(L[i]) && !/^\s*[-*]\s/.test(L[i]) && !/^\s*\d+\.\s/.test(L[i])) { p+=' '+L[i]; i++; }
        const pin = _mdInline(p); if (pin.trim()) h+=`<p>${pin}</p>`;
    }
    return h;
}
function _renderDocNav(active) {
    $('doc-nav').innerHTML = _DOCS.map(([f,t])=>`<a href="#" class="doc-link ${f===active?'active':''}" onclick="event.preventDefault();loadDoc('${f}')">${_esc(t)}</a>`).join('');
}
async function loadDoc(file) {
    _renderDocNav(file);
    const c = $('doc-content'); c.innerHTML = '<div class="small">Загрузка…</div>';
    try {
        const r = await fetch('/static/docs/' + file);
        c.innerHTML = mdToHtml(await r.text());
        c.querySelectorAll('a.doclink').forEach(a => a.addEventListener('click', e => {
            e.preventDefault();
            const h = (a.getAttribute('href')||'').split('#')[0].split('/').pop();
            if (h && h.endsWith('.md')) loadDoc(h);
        }));
        window.scrollTo(0, 0);
    } catch (e) { c.innerHTML = '<div class="small">Не удалось загрузить документ</div>'; }
}

// ── Дашборд: спарклайны (история считается на клиенте из обычных опросов) ──
const _hist = { cpu: [], mem: [], temp: [], disk: [], net: [], vpn: [], lan: [], dev: [] }, _HMAX = 60;
let _prevDisk = null;
function _push(k, v) { const a = _hist[k]; a.push(v); if (a.length > _HMAX) a.shift(); }
function _spark(id, data, color, maxv) {
    const c = document.getElementById(id); if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 280, h = c.clientHeight || 48;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    if (data.length < 2) {
        // нет данных (напр. температура без датчиков, или ещё не накопилось) —
        // рисуем тусклую пунктирную базовую линию, чтобы не выглядело «сломанным»
        g.strokeStyle = 'rgba(139,148,158,0.35)'; g.lineWidth = 1; g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(0, h - 4); g.lineTo(w, h - 4); g.stroke(); g.setLineDash([]);
        return;
    }
    const max = maxv || Math.max(1, Math.max.apply(null, data)) * 1.2;
    const stepX = w / (_HMAX - 1), x0 = w - (data.length - 1) * stepX;
    const y = v => h - 3 - (Math.min(v, max) / max) * (h - 7);
    g.beginPath(); g.moveTo(x0, h);
    data.forEach((v, i) => g.lineTo(x0 + i * stepX, y(v)));
    g.lineTo(x0 + (data.length - 1) * stepX, h); g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
    g.fillStyle = grad; g.fill();
    g.beginPath(); data.forEach((v, i) => { const xx = x0 + i * stepX, yy = y(v); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
    g.strokeStyle = color; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    const lx = x0 + (data.length - 1) * stepX, ly = y(data[data.length - 1]);
    g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 6; g.beginPath(); g.arc(lx, ly, 2.4, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
}

// ── Консоль: интерактивный терминал шлюза (xterm.js + WebSocket PTY) ──
let _term = null, _termFit = null, _termWS = null, _termLoggedIn = false;
function _termStatus(state, text) { const s = document.getElementById('term-status'); if (s) { s.className = 'term-status ' + state; s.textContent = text; } }
function _termFitNow() { try { _termFit && _termFit.fit(); } catch (e) {} }
function _termSendSize() { if (_term && _termWS && _termWS.readyState === 1) _termWS.send('r' + _term.cols + ',' + _term.rows); }
function termClear() { if (_term) _term.clear(); }
function _ensureTerm() {
    if (_term) return _term;
    if (!window.Terminal) return null;
    _term = new Terminal({
        fontSize: 13, fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
        cursorBlink: true, scrollback: 5000, allowProposedApi: true, allowTransparency: true,
        theme: {
            background: 'rgba(8,12,18,0)', foreground: '#cdd6e4', cursor: '#a371f7', cursorAccent: '#0b0f16',
            selectionBackground: 'rgba(88,120,230,0.32)',
            black: '#0b0f16', red: '#f85149', green: '#3fb950', yellow: '#e3b341',
            blue: '#58a6ff', magenta: '#a371f7', cyan: '#56d4dd', white: '#c9d1d9',
            brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#7ee0a0', brightYellow: '#f2cc60',
            brightBlue: '#79c0ff', brightMagenta: '#bc8cff', brightCyan: '#80e0e8', brightWhite: '#f0f6fc'
        }
    });
    try { _termFit = new FitAddon.FitAddon(); _term.loadAddon(_termFit); } catch (e) {}
    _term.open(document.getElementById('terminal'));
    _termFitNow();
    _term.onData(d => { if (_termWS && _termWS.readyState === 1) _termWS.send('i' + d); });
    addEventListener('resize', () => { _termFitNow(); _termSendSize(); });
    return _term;
}
// подставить команду из подсказки в консоль (без Enter — пользователь проверит и запустит)
function termCmd(cmd) {
    if (!_termWS || _termWS.readyState !== 1) {
        termConnect();
        toast('Сначала войди в консоль: нажми «Подключить» и введи логин/пароль', 'info', 4500);
        return;
    }
    if (!_termLoggedIn) {
        toast('Сначала залогинься в консоли (логин/пароль), потом используй быстрые команды', 'info', 4500);
        if (_term) _term.focus();
        return;
    }
    _termWS.send('i' + cmd);
    if (_term) _term.focus();
}
function termConnect() {
    const t = _ensureTerm();
    if (!t) { toast('Терминал не загрузился', 'bad'); return; }
    // переподключение: гасим старое соединение (без onclose-помех) и стартуем заново
    if (_termWS) {
        try { _termWS.onclose = _termWS.onerror = _termWS.onmessage = null; _termWS.close(); } catch (e) {}
        _termWS = null;
    }
    _termLoggedIn = false;
    t.reset();
    _termStatus('off', 'подключение…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    _termWS = new WebSocket(`${proto}://${location.host}/api/console/ws`);
    const card = document.querySelector('.term-card');
    _termWS.onopen = () => {
        _termStatus('on', 'подключено'); if (card) card.classList.add('connected');
        document.getElementById('term-connect-btn').textContent = 'Переподключить';
        setTimeout(() => { _termFitNow(); _termSendSize(); t.focus(); }, 60);
    };
    _termWS.onmessage = ev => {
        t.write(ev.data);
        const s = ev.data;
        // эвристика «залогинен»: вход просит login/Password → нет; появился shell-промпт ($/#) → да
        if (/login:\s*$/i.test(s) || /password:\s*$/i.test(s)) _termLoggedIn = false;
        else if (/[#$]\s$/.test(s)) _termLoggedIn = true;
    };
    _termWS.onclose = () => { _termStatus('off', 'отключено'); _termLoggedIn = false; if (card) card.classList.remove('connected'); };
    _termWS.onerror = () => _termStatus('err', 'ошибка соединения');
}
// при переходе на вкладку «Консоль» — подогнать размер
(function () {
    const a = document.querySelector('.topbar nav a[data-tab="console"]');
    if (a) a.addEventListener('click', () => setTimeout(() => { _termFitNow(); _termSendSize(); }, 90));
})();

// ── Еженедельный отчёт ──
async function loadReport() {
    const d = await api('/api/report'); const card = $('report-card'); if (!card) return;
    if (!d || !d.available) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    $('rep-uptime').textContent = (d.vpn_uptime_pct ?? '—') + '%';
    $('rep-failover').textContent = d.failover_total ?? '—';
    $('rep-recovery').textContent = d.recovery_total ?? '—';
    $('rep-restarts').textContent = d.service_restarts ?? '—';
    $('rep-devices').textContent = d.devices ?? '—';
    $('rep-generated').textContent = d.generated ? new Date(d.generated).toLocaleString('ru-RU') : '—';
}

// ── Цикл обновления ──
function refresh() { loadSystem(); loadNetwork(); loadVpn(); loadDevices(); }
refresh(); loadLogs(); loadWhoami(); loadAccess(); loadReport(); loadQos(); loadSpeedtest(); loadLease();
setInterval(() => { if (!_qosPoll) loadQos(); }, 15000);
setInterval(refresh, 5000);
setInterval(loadLogs, 15000);
setInterval(loadReport, 300000);
setInterval(loadSecurityStats, 6000);

// ── Напоминание о доступном обновлении ───────────────────────────────────────
// Задача: попасться на глаза, но не мешать. Поэтому обычный тост в углу — само
// всплывает, само уходит, и возвращается позже, пока обновление не поставят.
// Никаких модалок, баннеров и блокировок ввода.
//
// Молчим, когда напоминать незачем или это будет раздражать без пользы:
//   * обновления нет;
//   * накат уже идёт (там свой прогресс);
//   * пользователь и так смотрит на раздел «Обновление»;
//   * вкладка браузера в фоне (иначе к возвращению накопится очередь тостов);
//   * не админ — раздел ему не доступен, звать некуда (API вернёт 403).
const _NAG_CHECK_MS  = 5 * 60 * 1000;   // как часто спрашивать состояние
const _NAG_REPEAT_MS = 7 * 60 * 1000;   // не показывать чаще, чем раз в
const _NAG_SHOW_MS   = 9000;            // сколько висит на экране
let _nagLastShown = 0;

function _updSectionVisible() {
    const tab = document.querySelector('.topbar nav a[data-tab="system"]');
    const pan = document.getElementById('sys-update');
    return !!(tab && tab.classList.contains('active') &&
              pan && pan.classList.contains('active'));
}
function _openUpdateSection() {
    const tab = document.querySelector('.topbar nav a[data-tab="system"]');
    if (tab) tab.click();
    const sub = document.querySelector('.subnav-link[data-sys="update"]');
    if (sub) sub.click();
    loadUpdate();
}
async function nagUpdate() {
    if (document.hidden) return;
    if (_updSectionVisible()) return;
    if (Date.now() - _nagLastShown < _NAG_REPEAT_MS) return;

    let d = null;
    try { d = await api('/api/update/status'); } catch (e) { return; }
    if (!d || d.error) return;                      // не админ или бэкенд недоступен
    if (d.update_inprogress) return;                // накат идёт — есть свой прогресс
    const st = d.status || {};
    if (st.state !== 'available') return;           // нечего предлагать

    _nagLastShown = Date.now();
    toast(`Доступно обновление ${st.to || ''}`.trim(), 'warn', _NAG_SHOW_MS, {
        hint: 'Нажмите, чтобы открыть раздел обновления',
        onClick: _openUpdateSection,
    });
}
setTimeout(nagUpdate, 20000);           // первый раз — дав панели прогрузиться
setInterval(nagUpdate, _NAG_CHECK_MS);

// ── Кастомные подсказки для «?» (.seg-q): нативный title не всплывал; свой тултип
//    крепим к body (не режется overflow карточек) и стилизуем под панель. ──
(function initTips() {
    let tip = null;
    const ensure = () => {
        if (!tip) { tip = document.createElement('div'); tip.className = 'gw-tip'; document.body.appendChild(tip); }
        return tip;
    };
    const place = (el) => {
        // переносим native title в data-tip один раз (чтобы браузерная подсказка не дублировала)
        if (el.hasAttribute('title')) { el.setAttribute('data-tip', el.getAttribute('title')); el.removeAttribute('title'); }
        const txt = el.getAttribute('data-tip');
        if (!txt) return;
        const tp = ensure();
        tp.textContent = txt;
        tp.classList.add('show');
        const r = el.getBoundingClientRect();
        let left = r.left + r.width / 2 - tp.offsetWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tp.offsetWidth - 8));
        let top = r.bottom + 8;
        if (top + tp.offsetHeight > window.innerHeight - 8) top = r.top - tp.offsetHeight - 8;
        tp.style.left = left + 'px';
        tp.style.top = top + 'px';
    };
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest && e.target.closest('.seg-q');
        if (el) place(el);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest && e.target.closest('.seg-q');
        if (el && tip) tip.classList.remove('show');
    });
})();
