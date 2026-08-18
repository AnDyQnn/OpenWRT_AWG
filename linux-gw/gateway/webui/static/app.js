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
function toast(msg, type = 'info', ms = 3800) {
    const w = document.getElementById('toast-wrap'); if (!w) return;
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
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
        } else {
            bl.innerHTML = `<div class="sec-line ok">${GWFX.ic('check')} Атак не зафиксировано — всё спокойно.</div>`;
        }
    }
    if ($('sec-kpi-row')) GWFX.icons($('sec-kpi-row'));
    if ($('sec-banned-list')) GWFX.icons($('sec-banned-list'));
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
async function loadSshPort() {
    const d = await api('/api/security/ssh-port');
    if (d && $('ssh-port-cur')) $('ssh-port-cur').textContent = d.port || '—';
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
    if (res) res.textContent = 'Готово: приватный ключ скачан (gateway_id_ed25519). Заходи: ssh -i gateway_id_ed25519 -p 23232 root@192.168.88.1';
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
    if (st.message) {
        const stg = _UPD_STAGES[st.stage] || st.stage || '';
        const cls = st.state === 'error' ? 'bad' : (st.state === 'ok' ? 'ok' : 'warn');
        prog.innerHTML = `<span class="badge ${cls}">${_esc(stg)}</span> ${_esc(st.message)}`;
    } else prog.innerHTML = '';
    // если идёт накат — продолжаем опрашивать
    if (running) _updStartPoll(); else _updStopPoll();
}
function _updStartPoll() {
    if (_updPollTimer) return;
    _updPollTimer = setInterval(loadUpdate, 4000);
}
function _updStopPoll() { if (_updPollTimer) { clearInterval(_updPollTimer); _updPollTimer = null; } }
async function loadUpdate() {
    const d = await api('/api/update/status');
    _updRender(d);
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
refresh(); loadLogs(); loadWhoami(); loadAccess(); loadReport();
setInterval(refresh, 5000);
setInterval(loadLogs, 15000);
setInterval(loadReport, 300000);
setInterval(loadSecurityStats, 6000);

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
