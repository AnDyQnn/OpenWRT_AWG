/* Gateway Hub — визуальные эффекты: лого (щит + 3D-куб-граф), фон (сеть+код+
   оборудование), анимированная ЭКГ-фавиконка. Общий для панели и логина. */
(function () {
  const TAU = Math.PI * 2, PURPLE = ["#a371f7", "#d2a8ff"], GREEN = "#3fb950", HEAD = "#9ff7a8";
  const METAL = {
    green: ['#ecfff2', '#43c46e', '#0e3a22', '150,255,190'],
    purple: ['#ece9ff', '#7d6bd6', '#241a52', '185,165,255'],
    gray: ['#f6f8fa', '#9aa3ad', '#2a2f36', '215,222,230']
  };
  function metalNode(ctx, x, y, r, col, alpha) {
    const [hi, mid, dk, rimc] = METAL[col] || METAL.green;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.beginPath(); ctx.ellipse(x, y + r * 0.92, r * 0.72, r * 0.26, 0, 0, TAU); ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.44, r * 0.04, x, y, r * 1.08);
    g.addColorStop(0, hi); g.addColorStop(.4, mid); g.addColorStop(.82, dk); g.addColorStop(1, '#05080a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    const rim = ctx.createRadialGradient(x + r * 0.25, y + r * 0.5, 0, x + r * 0.25, y + r * 0.5, r * 0.85);
    rim.addColorStop(0, `rgba(${rimc},.45)`); rim.addColorStop(.7, 'rgba(0,0,0,0)');
    ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    const sp = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x - r * 0.35, y - r * 0.4, r * 0.42);
    sp.addColorStop(0, 'rgba(255,255,255,1)'); sp.addColorStop(.4, 'rgba(255,255,255,.5)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sp; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.42, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath(); ctx.arc(x - r * 0.32, y - r * 0.37, r * 0.1, 0, TAU); ctx.fill();
    ctx.restore();
  }
  // ── ЩИТ + 3D-куб-граф (утверждённый дизайн) ──
  function shield(ctx, cx, cy, S, t) {
    const top = cy - S * 0.5, midY = cy + S * 0.1, bot = cy + S * 0.52, w = S * 0.78;
    function path() {
      ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx + w / 2, top + S * 0.13); ctx.lineTo(cx + w / 2, midY);
      ctx.quadraticCurveTo(cx + w / 2, bot - S * 0.1, cx, bot); ctx.quadraticCurveTo(cx - w / 2, bot - S * 0.1, cx - w / 2, midY);
      ctx.lineTo(cx - w / 2, top + S * 0.13); ctx.closePath();
    }
    const br = 0.5 + 0.5 * Math.sin(t * 0.0024);
    ctx.save();
    ctx.shadowColor = 'rgba(110,86,207,.75)'; ctx.shadowBlur = S * 0.2; ctx.shadowOffsetY = S * 0.05;
    path();
    const g = ctx.createLinearGradient(cx - w * 0.45, top, cx + w * 0.45, bot);
    g.addColorStop(0, '#cbabff'); g.addColorStop(.5, '#7857d6'); g.addColorStop(1, '#33265f');
    ctx.fillStyle = g; ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.save(); path(); ctx.clip();
    const gloss = ctx.createLinearGradient(0, top, 0, cy + S * 0.05);
    gloss.addColorStop(0, 'rgba(255,255,255,.34)'); gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss; ctx.fillRect(cx - w, top, w * 2, S * 0.62);
    const cg = ctx.createRadialGradient(cx, cy + S * 0.02, 0, cx, cy + S * 0.02, S * 0.46);
    cg.addColorStop(0, `rgba(120,240,150,${(0.20 + br * 0.28).toFixed(2)})`);
    cg.addColorStop(.55, `rgba(120,240,150,${(0.05 + br * 0.06).toFixed(2)})`);
    cg.addColorStop(1, 'rgba(120,240,150,0)');
    ctx.fillStyle = cg; ctx.fillRect(cx - w, top, w * 2, bot - top);
    // «хаотичный» 3D-куб-граф + серый узел в центре
    const Rs = S * 0.37, ay = t * 0.0006, ax = 0.42 + Math.sin(t * 0.0003) * 0.12;
    const CV0 = []; for (let x = -1; x <= 1; x += 2) for (let y = -1; y <= 1; y += 2) for (let z = -1; z <= 1; z += 2) CV0.push([x, y, z]);
    const JIT = [[0.18, -0.22, 0.12], [-0.26, 0.12, 0.3], [0.22, 0.26, -0.16], [-0.12, -0.3, -0.22], [0.3, 0.16, 0.22], [-0.22, -0.16, -0.26], [0.12, 0.32, 0.16], [-0.3, 0.22, -0.12]];
    const CV = CV0.map((v, i) => [v[0] + JIT[i][0], v[1] + JIT[i][1], v[2] + JIT[i][2]]);
    const CE = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { let d = 0; for (let k = 0; k < 3; k++) if (CV0[i][k] !== CV0[j][k]) d++; if (d === 1) CE.push([i, j, (i * 7 + j) * 0.13]); }
    const proj = CV.map(p => {
      let [x, y, z] = p;
      const x1 = x * Math.cos(ay) + z * Math.sin(ay), z1 = -x * Math.sin(ay) + z * Math.cos(ay);
      const y1 = y * Math.cos(ax) - z1 * Math.sin(ax), z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
      const persp = 1 / (2.5 - z2 * 0.45);
      return { x: cx + x1 * Rs * persp, y: cy + y1 * Rs * persp, z: z2, persp };
    });
    const ctr = { x: cx, y: cy, z: 0 };
    const items = [];
    CE.forEach(([i, j, ph]) => items.push({ z: (proj[i].z + proj[j].z) / 2, k: 'e', a: proj[i], b: proj[j], ph }));
    proj.forEach(n => items.push({ z: n.z * 0.5, k: 'ce', n }));
    proj.forEach(n => items.push({ z: n.z, k: 'v', n }));
    items.push({ z: 0, k: 'c' });
    items.sort((p, q) => p.z - q.z);
    items.forEach(it => {
      if (it.k === 'e') {
        const dp = Math.max(0, Math.min(1, (it.z + 1.4) / 2.8));
        ctx.strokeStyle = `rgba(150,255,190,${(0.3 + 0.42 * dp).toFixed(2)})`; ctx.lineWidth = S * (0.012 + 0.01 * dp);
        ctx.beginPath(); ctx.moveTo(it.a.x, it.a.y); ctx.lineTo(it.b.x, it.b.y); ctx.stroke();
        if (it.z > 0) {
          const cyc = ((t * 0.00034 + it.ph * 1.7) % 1 + 1) % 1;
          if (cyc < 0.26) {
            const pp = cyc / 0.26;
            for (let tr = 0; tr < 3; tr++) { const q = pp - tr * 0.08; if (q < 0) continue; ctx.globalAlpha = (1 - tr / 3) * 0.85; ctx.shadowColor = '#9ff7a8'; ctx.shadowBlur = tr === 0 ? S * 0.09 : 0; ctx.beginPath(); ctx.arc(it.a.x + (it.b.x - it.a.x) * q, it.a.y + (it.b.y - it.a.y) * q, S * (0.02 - tr * 0.004), 0, TAU); ctx.fillStyle = '#eaffef'; ctx.fill(); }
            ctx.globalAlpha = 1; ctx.shadowBlur = 0;
          }
        }
      } else if (it.k === 'ce') {
        const dp = Math.max(0, Math.min(1, (it.n.z + 1.4) / 2.8));
        ctx.strokeStyle = `rgba(185,205,215,${(0.16 + 0.22 * dp).toFixed(2)})`; ctx.lineWidth = S * 0.009;
        ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y); ctx.lineTo(it.n.x, it.n.y); ctx.stroke();
      } else if (it.k === 'v') { metalNode(ctx, it.n.x, it.n.y, S * 0.062 * it.n.persp, 'green', 0.6 + 0.4 * ((it.n.z + 1) / 2)); }
      else { metalNode(ctx, cx, cy, S * 0.085, 'gray', 1); }
    });
    const sw = (t * 0.0004) % 1.7;
    if (sw < 1) {
      const sxp = cx - w + sw * (w * 2.6) - w * 0.4;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.42); ctx.translate(-cx, -cy);
      const sh = ctx.createLinearGradient(sxp - S * 0.16, 0, sxp + S * 0.16, 0);
      sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(.5, 'rgba(255,255,255,.32)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh; ctx.fillRect(sxp - S * 0.16, top - S, S * 0.32, (bot - top) + S * 2);
      ctx.restore();
    }
    ctx.restore();
    path(); ctx.strokeStyle = 'rgba(238,232,255,.6)'; ctx.lineWidth = S * 0.045; ctx.stroke();
    ctx.save(); ctx.translate(cx, cy); ctx.scale(0.88, 0.88); ctx.translate(-cx, -cy);
    path(); ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = S * 0.018; ctx.stroke(); ctx.restore();
    ctx.restore();
  }
  function faviconG(ctx, cx, cy, R, lw) {
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R); g.addColorStop(0, PURPLE[1]); g.addColorStop(1, PURPLE[0]);
    ctx.strokeStyle = g; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, R, -0.34, TAU * 0.78); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(-0.34) * R, cy + Math.sin(-0.34) * R); ctx.lineTo(cx + R * 0.15, cy); ctx.stroke();
  }
  function ecgVal(u) { let v = 0; v -= Math.exp(-Math.pow((u - 0.45) / 0.02, 2)) * 0.4; v += Math.exp(-Math.pow((u - 0.5) / 0.025, 2)) * 1; v -= Math.exp(-Math.pow((u - 0.57) / 0.022, 2)) * 0.3; v += Math.exp(-Math.pow((u - 0.77) / 0.06, 2)) * 0.24; return v; }
  // Полный логотип: щит + G + «ateway Hub» + пульс-подчёркивание. fontPx масштабирует.
  function logo(lg, LW, LH, p, t, fontPx) {
    fontPx = fontPx || 33;
    const S = fontPx * 2.48, R = fontPx * 0.45, lwG = fontPx * 0.18;
    lg.clearRect(0, 0, LW, LH);
    lg.font = `800 ${fontPx}px system-ui,Segoe UI,sans-serif`; lg.textBaseline = 'middle';
    const txt = 'ateway Hub', textW = lg.measureText(txt).width;
    const shieldW = S, gW = R * 2, gap1 = fontPx * 0.3, gap2 = fontPx * 0.12, cyShield = LH * 0.46;
    const contentW = shieldW + gap1 + gW + gap2 + textW;
    const sx = Math.max(4, (LW - contentW) / 2);
    shield(lg, sx + shieldW / 2, cyShield, S, t);
    const gcx = sx + shieldW + gap1 + gW / 2; faviconG(lg, gcx, cyShield - 2, R, lwG);
    const tx = sx + shieldW + gap1 + gW + gap2;
    const grad = lg.createLinearGradient(tx, 0, tx + textW, 0); grad.addColorStop(0, '#efe3ff'); grad.addColorStop(.5, '#eef3f8'); grad.addColorStop(1, '#a6d3ff');
    lg.fillStyle = grad; lg.fillText(txt, tx, cyShield - 2);
    const x0 = gcx - gW / 2, x1 = tx + textW, W = x1 - x0, hx = x0 + (p % 1) * W, gap = fontPx * 0.72, beatW = W / 2.2, amp = fontPx * 0.24, baseY = cyShield + fontPx * 0.76;
    const val = x => ecgVal((((x - x0) % beatW) + beatW) % beatW / beatW);
    lg.lineWidth = fontPx * 0.073; lg.lineCap = 'round'; lg.lineJoin = 'round'; let prev = null;
    for (let x = x0; x <= x1; x += 1.0) {
      const ahead = ((x - hx) % W + W) % W, behind = ((hx - x) % W + W) % W;
      if (ahead > 0 && ahead < gap) { prev = null; continue; }
      const yy = baseY - val(x) * amp, k = Math.max(0.08, 1 - behind / (W * 0.95));
      if (prev) { lg.beginPath(); lg.moveTo(prev[0], prev[1]); lg.lineTo(x, yy); lg.strokeStyle = `rgba(63,185,80,${(k * 0.95).toFixed(3)})`; lg.shadowColor = GREEN; lg.shadowBlur = k > 0.7 ? 7 : 0; lg.stroke(); }
      prev = [x, yy];
    }
    lg.shadowBlur = 0; lg.shadowColor = HEAD; lg.shadowBlur = 9; lg.beginPath(); lg.arc(hx, baseY - val(hx) * amp, fontPx * 0.085, 0, TAU); lg.fillStyle = HEAD; lg.fill(); lg.shadowBlur = 0;
  }

  // ── ФОН: сеть + код-дождь + падающее оборудование (приглушённо) ──
  function background(canvas, density) {
    const bx = canvas.getContext('2d'); let W2, H2;
    let D = { low: { nodes: 34, rain: 0.5, eq: 10 }, mid: { nodes: 50, rain: 0.75, eq: 15 }, hi: { nodes: 70, rain: 1.1, eq: 22 } }[density || 'mid'];
    if (innerWidth < 700) D = { nodes: Math.round(D.nodes * 0.5), rain: D.rain * 0.5, eq: Math.round(D.eq * 0.55) };  // легче на телефоне
    let nodes = [], cols = [], eq = [];
    const chars = '01<>{}[]/\\=+-#01ABEF$';
    function iNodes() { nodes = []; for (let i = 0; i < D.nodes; i++) nodes.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - .5) * 0.0004, vy: (Math.random() - .5) * 0.0004 }); }
    function iCols() { cols = []; const n = Math.floor(W2 / 16 * D.rain); for (let i = 0; i < n; i++) cols.push({ x: Math.random() * W2, y: Math.random() * H2, sp: 0.4 + Math.random() }); }
    function iEq() { eq = []; for (let i = 0; i < D.eq; i++) eq.push({ x: Math.random() * W2, y: Math.random() * H2, v: 0.12 + Math.random() * 0.32, sz: 11 + Math.random() * 11, t: Math.floor(Math.random() * 9), rot: Math.random() * 0.5 - 0.25 }); }
    function resize() { W2 = canvas.width = innerWidth; H2 = canvas.height = innerHeight; iNodes(); iCols(); iEq(); }
    function eqIcon(t, sz) {
      bx.lineWidth = 1.3; bx.strokeStyle = 'rgba(88,166,255,1)'; const gr = 'rgba(63,185,80,1)';
      if (t === 0) { bx.strokeRect(-sz * .4, -sz * .6, sz * .8, sz * 1.2); for (let i = -1; i <= 1; i++) { bx.beginPath(); bx.moveTo(-sz * .28, i * sz * .3); bx.lineTo(sz * .28, i * sz * .3); bx.stroke(); } bx.fillStyle = gr; bx.fillRect(sz * .16, -sz * .52, sz * .1, sz * .1); }
      else if (t === 1) { bx.strokeRect(-sz * .5, -sz * .18, sz, sz * .45); bx.beginPath(); bx.moveTo(-sz * .25, -sz * .18); bx.lineTo(-sz * .34, -sz * .6); bx.moveTo(sz * .25, -sz * .18); bx.lineTo(sz * .34, -sz * .6); bx.stroke(); }
      else if (t === 2) { bx.strokeRect(-sz * .5, -sz * .45, sz, sz * .72); bx.beginPath(); bx.moveTo(0, sz * .27); bx.lineTo(0, sz * .45); bx.moveTo(-sz * .25, sz * .55); bx.lineTo(sz * .25, sz * .55); bx.stroke(); }
      else if (t === 3) { bx.strokeRect(-sz * .55, -sz * .22, sz * 1.1, sz * .42); for (let i = 0; i < 5; i++) bx.strokeRect(-sz * .46 + i * sz * .2, sz * .02, sz * .12, sz * .12); }
      else if (t === 4) { bx.strokeRect(-sz * .34, -sz * .34, sz * .68, sz * .68); for (let i = -1; i <= 1; i++) { bx.beginPath(); bx.moveTo(-sz * .5, i * sz * .2); bx.lineTo(-sz * .34, i * sz * .2); bx.moveTo(sz * .34, i * sz * .2); bx.lineTo(sz * .5, i * sz * .2); bx.stroke(); } bx.strokeRect(-sz * .12, -sz * .12, sz * .24, sz * .24); }
      else if (t === 5) { bx.strokeRect(-sz * .5, -sz * .38, sz, sz * .6); bx.beginPath(); bx.moveTo(-sz * .62, sz * .32); bx.lineTo(sz * .62, sz * .32); bx.lineTo(sz * .5, sz * .22); bx.lineTo(-sz * .5, sz * .22); bx.closePath(); bx.stroke(); }
      else if (t === 6) { bx.strokeRect(-sz * .45, -sz * .5, sz * .9, sz); for (let i = -1; i <= 1; i++) { bx.beginPath(); bx.arc(0, i * sz * .3, sz * .05, 0, TAU); bx.stroke(); } }
      else if (t === 7) { bx.beginPath(); bx.arc(-sz * .15, 0, sz * .32, Math.PI * .5, Math.PI * 1.5); bx.arc(sz * .2, -sz * .18, sz * .26, Math.PI, Math.PI * .5, true); bx.lineTo(sz * .2, sz * .18); bx.closePath(); bx.stroke(); }
      else { for (let i = 1; i <= 3; i++) { bx.beginPath(); bx.arc(0, sz * .3, sz * .18 * i, Math.PI * 1.15, Math.PI * 1.85); bx.stroke(); } bx.fillStyle = bx.strokeStyle; bx.beginPath(); bx.arc(0, sz * .3, sz * .06, 0, TAU); bx.fill(); }
    }
    function frame() {
      bx.clearRect(0, 0, W2, H2);
      nodes.forEach(n => { n.x += n.vx; n.y += n.vy; if (n.x < 0 || n.x > 1) n.vx *= -1; if (n.y < 0 || n.y > 1) n.vy *= -1; });
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const a = nodes[i], b = nodes[j], dx = (a.x - b.x) * W2, dy = (a.y - b.y) * H2, d = Math.hypot(dx, dy); if (d < 150) { bx.strokeStyle = `rgba(88,166,255,${(0.11 * (1 - d / 150)).toFixed(3)})`; bx.lineWidth = 1; bx.beginPath(); bx.moveTo(a.x * W2, a.y * H2); bx.lineTo(b.x * W2, b.y * H2); bx.stroke(); } }
      nodes.forEach(n => { bx.fillStyle = 'rgba(88,166,255,.42)'; bx.beginPath(); bx.arc(n.x * W2, n.y * H2, 1.6, 0, TAU); bx.fill(); });
      bx.font = '13px monospace';
      cols.forEach((c, i) => { c.y += c.sp; if (c.y > H2 + 14) { c.y = -14; c.x = Math.random() * W2; } bx.fillStyle = 'rgba(63,185,80,.17)'; bx.fillText(chars[(Math.floor(c.y / 16) + i) % chars.length], c.x, c.y); });
      eq.forEach(e => { e.y += e.v; e.rot += 0.002; if (e.y > H2 + e.sz) { e.y = -e.sz; e.x = Math.random() * W2; } bx.save(); bx.globalAlpha = 0.16; bx.translate(e.x, e.y); bx.rotate(e.rot); eqIcon(e.t, e.sz); bx.restore(); });
      requestAnimationFrame(frame);
    }
    resize(); addEventListener('resize', resize); requestAnimationFrame(frame);
  }

  // ── Анимированная ЭКГ-фавиконка (1.5 удара), движок на rAF ──
  function favShieldEcg(ctx, s, p) {
    ctx.clearRect(0, 0, s, s); const cx = s / 2, cy = s / 2, R = s * 0.3;
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R); g.addColorStop(0, PURPLE[1]); g.addColorStop(1, PURPLE[0]);
    ctx.strokeStyle = g; ctx.lineWidth = s * 0.11; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, R, -0.30, TAU * 0.78); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(-0.30) * R, cy + Math.sin(-0.30) * R); ctx.lineTo(cx + R * 0.12, cy); ctx.stroke();
    const x0 = s * 0.06, x1 = s * 0.94, W = x1 - x0, hx = x0 + (p % 1) * W, gap = s * 0.12, beatW = W / 1.5, amp = s * 0.34;
    const ev = u => { let v = 0; v += Math.exp(-Math.pow((u - 0.28) / 0.05, 2)) * 0.16; v -= Math.exp(-Math.pow((u - 0.45) / 0.013, 2)) * 0.5; v += Math.exp(-Math.pow((u - 0.50) / 0.018, 2)) * 1.15; v -= Math.exp(-Math.pow((u - 0.55) / 0.016, 2)) * 0.4; v += Math.exp(-Math.pow((u - 0.74) / 0.06, 2)) * 0.28; return v; };
    const val = x => ev((((x - x0) % beatW) + beatW) % beatW / beatW);
    ctx.lineWidth = s * 0.06; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; let prev = null;
    for (let x = x0; x <= x1; x += 1.0) {
      const ahead = ((x - hx) % W + W) % W, behind = ((hx - x) % W + W) % W;
      if (ahead > 0 && ahead < gap) { prev = null; continue; }
      const yy = cy - val(x) * amp, k = Math.max(0.12, 1 - behind / (W * 0.95));
      if (prev) { ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(x, yy); ctx.strokeStyle = `rgba(63,185,80,${k.toFixed(3)})`; ctx.shadowColor = GREEN; ctx.shadowBlur = k > 0.7 ? s * 0.1 : 0; ctx.stroke(); }
      prev = [x, yy];
    }
    ctx.shadowBlur = 0; ctx.shadowColor = HEAD; ctx.shadowBlur = s * 0.22;
    ctx.beginPath(); ctx.arc(hx, cy - val(hx) * amp, s * 0.055, 0, TAU); ctx.fillStyle = HEAD; ctx.fill(); ctx.shadowBlur = 0;
  }
  function favicon() {
    let link = document.querySelector("link[rel='icon']"); if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    const N = 60, DUR = 3000, cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const c = cv.getContext('2d');
    const frames = []; for (let i = 0; i < N; i++) { favShieldEcg(c, 64, i / N); frames.push(cv.toDataURL('image/png')); }
    let start = performance.now(), last = -1;
    (function tick(ts) { const idx = Math.floor(((ts - start) % DUR) / DUR * N) % N; if (idx !== last) { last = idx; link.href = frames[idx]; } requestAnimationFrame(tick); })(start);
  }

  // Запуск анимированного лого на canvas-элементе (масштаб шрифта по высоте)
  function runLogo(canvas, fontPx) {
    const lg = canvas.getContext('2d'); const dpr = 2;
    const LW = canvas.width / dpr, LH = canvas.height / dpr; lg.scale(dpr, dpr);
    (function tick(ts) { logo(lg, LW, LH, (ts % 3200) / 3200, ts, fontPx); requestAnimationFrame(tick); })(0);
  }
  // Только щит, вписанный в canvas (для шапки панели)
  function runShield(canvas) {
    const ctx = canvas.getContext('2d'); const dpr = 2;
    const W = canvas.width / dpr, H = canvas.height / dpr; ctx.scale(dpr, dpr);
    const S = Math.min(W, H) * 0.78;
    (function tick(ts) { ctx.clearRect(0, 0, W, H); shield(ctx, W / 2, H / 2, S, ts); requestAnimationFrame(tick); })(0);
  }

  // ── Набор моно-SVG line-иконок (единый стиль, цвет = currentColor) ──────────
  const ICONS = {
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-1.7"/>',
    split: '<path d="M16 3h5v5"/><path d="M21 3 13 11"/><path d="M16 21h5v-5"/><path d="M21 21l-6-6"/><path d="M3 4l5 5"/>',
    import: '<path d="M12 3v11"/><path d="M7 9l5 5 5-5"/><path d="M5 21h14"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><rect x="8" y="13" width="8" height="6"/>',
    book: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H12v16H5.5A2.5 2.5 0 0 0 3 21.5z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H12v16h6.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/>',
    warn: '<path d="M12 4l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6.5 8-6.5S20 17 20 21"/>',
    star: '<path fill="currentColor" stroke="none" d="M12 3l2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.9 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
    inbox: '<path d="M3 13h5l1 3h6l1-3h5"/><path d="M5 5h14l2 8v5H3v-5z"/>',
    send: '<path d="M21 3L3 11l7 2 2 7z"/><path d="M21 3L11 13"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    github: '<path fill="currentColor" stroke="none" d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.6.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 22 12.2C22 6.6 17.5 2 12 2z"/>',
    code: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l2 2-2 2M11 14h4"/>',
    bug: '<ellipse cx="12" cy="13" rx="5" ry="6"/><path d="M12 7V5M8.5 9 6.5 7M15.5 9l2-2M7 13H4M20 13h-3M8 17l-2 2M16 17l2 2"/>',
    check: '<path d="M4 12.5l5 5 11-11"/>',
    cross: '<path d="M6 6l12 12M18 6L6 18"/>',
    upload: '<path d="M12 21V10"/><path d="M7 15l5-5 5 5"/><path d="M5 3h14"/>',
    gauge: '<path d="M4 19a8 8 0 1 1 16 0"/><path d="M12 19l4-5"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
    power: '<path d="M12 3v9"/><path d="M7.5 6.6a7 7 0 1 0 9 0"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 7V3M15 7V3"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.4-5.9"/><path d="M20.5 3v5h-5"/>',
    download: '<path d="M12 3v11"/><path d="M7 9l5 5 5-5"/><path d="M5 21h14"/>',
    undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'
  };
  const ICON_COL = {
    lock: '#3fb950', shield: '#3fb950', save: '#3fb950', phone: '#3fb950',
    unlock: '#e3b341', star: '#e3b341', warn: '#f0a35e', bug: '#f85149',
    split: '#a371f7', import: '#bc8cff', box: '#bc8cff', book: '#a371f7',
    monitor: '#58a6ff', code: '#58a6ff', mail: '#58a6ff', inbox: '#58a6ff',
    user: '#58a6ff', send: '#3aa0ff', github: '#c9d1d9', menu: '#8b949e',
    check: '#3fb950', cross: '#f85149', upload: '#bc8cff',
    gauge: '#58a6ff', list: '#7ee0a0', gear: '#9aa3ad',
    power: '#3fb950', plug: '#e3b341', refresh: '#58a6ff'
  };
  // Группа анимации на иконку (idle в фоне + своя при наведении). См. .gi-* в CSS.
  const ICON_ANIM = {
    gear: 'spin', refresh: 'spin',
    import: 'bob', upload: 'bob', send: 'bob', mail: 'bob', inbox: 'bob', save: 'bob',
    lock: 'pulse', unlock: 'pulse', shield: 'pulse', power: 'pulse', check: 'pulse', star: 'pulse', plug: 'pulse',
    warn: 'beat', bug: 'beat', cross: 'beat',
    split: 'sway', gauge: 'sway', monitor: 'sway', code: 'sway', list: 'sway', book: 'sway',
    box: 'sway', user: 'sway', github: 'sway', phone: 'sway', menu: 'sway'
  };
  function ic(name, cls) {
    const p = ICONS[name]; if (!p) return '';
    const col = ICON_COL[name] || 'currentColor';
    const gi = ICON_ANIM[name] ? ' gi-' + ICON_ANIM[name] : '';
    return '<svg class="ico' + gi + (cls ? ' ' + cls : '') + '" style="color:' + col + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  // Заменяет <span data-ic="name"> на соответствующий svg (для статичного html)
  function icons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
      if (el.dataset.icDone) return; el.dataset.icDone = '1';
      el.insertAdjacentHTML('afterbegin', ic(el.dataset.ic));
    });
  }

  window.GWFX = { shield, logo, background, favicon, runLogo, runShield, ic, icons };
})();
