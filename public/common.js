/* Mac Audio — helpers compartilhados (login, ICE, boost, wake lock, prefs, PWA) */
(function (global) {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'ma_token';

  // ---------- Toast ----------
  let toastEl = null, toastT = null;
  function toast(msg, ms = 2200) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ---------- Preferências (localStorage) ----------
  const Prefs = {
    get(k, d) { try { const v = localStorage.getItem('ma_pref_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ma_pref_' + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- Autenticação (senha + login) ----------
  let TOKEN = '';
  function authQuery() { return TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''; }

  async function validate(token) {
    try {
      const r = await fetch('/ice?token=' + encodeURIComponent(token), { cache: 'no-store' });
      return r.ok;
    } catch { return false; }
  }

  // Mostra tela de login dentro de #gate; chama cb() quando autenticado.
  async function gate(cb) {
    const urlTok = new URLSearchParams(location.search).get('token');
    const stored = localStorage.getItem(TOKEN_KEY);
    const tryTok = urlTok || stored || '';

    if (tryTok && await validate(tryTok)) {
      TOKEN = tryTok;
      localStorage.setItem(TOKEN_KEY, tryTok);
      if (urlTok) history.replaceState(null, '', location.pathname); // limpa ?token= da URL
      showApp(cb);
      return;
    }
    renderLogin(cb);
  }

  function showApp(cb) {
    const g = $('gate'); if (g) g.classList.add('hidden');
    const app = $('app'); if (app) app.classList.remove('hidden');
    cb(TOKEN);
  }

  function renderLogin(cb) {
    const g = $('gate');
    g.classList.remove('hidden');
    const app = $('app'); if (app) app.classList.add('hidden');
    g.innerHTML =
      '<div class="login">' +
      '<div class="logo">🔒</div>' +
      '<h1>Mac Audio</h1>' +
      '<p class="muted">Digite a senha de acesso</p>' +
      '<input id="pw" type="password" inputmode="text" autocomplete="current-password" placeholder="senha" />' +
      '<button class="btn" id="pwbtn" style="max-width:300px">Entrar</button>' +
      '<div class="err" id="pwerr"></div>' +
      '</div>';
    const input = $('pw'), btn = $('pwbtn'), err = $('pwerr');
    async function submit() {
      const val = (input.value || '').trim();
      if (!val) return;
      btn.disabled = true; err.textContent = ''; btn.textContent = 'Verificando…';
      if (await validate(val)) {
        TOKEN = val; localStorage.setItem(TOKEN_KEY, val); showApp(cb);
      } else {
        err.textContent = 'Senha incorreta'; btn.disabled = false; btn.textContent = 'Entrar';
        input.select();
      }
    }
    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    input.focus();
  }

  function logout() { localStorage.removeItem(TOKEN_KEY); location.reload(); }

  // ---------- ICE (STUN/TURN) ----------
  let ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  async function loadIce() {
    try {
      const r = await fetch('/ice' + authQuery(), { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j.iceServers) ICE = j; }
    } catch {}
    return ICE;
  }
  function getIce() { return ICE; }

  // ---------- Cadeia de boost: ganho + compressor + limitador ----------
  // input → preGain → compressor → limiter → output. setGain(x) 0..N; setBoost(on).
  function buildBoostChain(ctx) {
    const preGain = ctx.createGain(); preGain.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.1;
    preGain.connect(comp); comp.connect(limiter);
    function setBoost(on) {
      if (on) { comp.threshold.value = -30; comp.knee.value = 30; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25; }
      else { comp.threshold.value = 0; comp.knee.value = 0; comp.ratio.value = 1; comp.attack.value = 0.003; comp.release.value = 0.25; }
    }
    setBoost(false);
    return {
      input: preGain, output: limiter,
      setGain: (x) => { try { preGain.gain.setTargetAtTime(x, ctx.currentTime, 0.02); } catch { preGain.gain.value = x; } },
      setBoost,
    };
  }

  // ---------- VU meter (analyser → callback com nível 0..1) ----------
  function attachVU(ctx, node, onLevel) {
    const an = ctx.createAnalyser(); an.fftSize = 512;
    node.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let raf = 0;
    (function loop() {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
      raf = requestAnimationFrame(loop);
    })();
    return { analyser: an, stop: () => cancelAnimationFrame(raf) };
  }

  // ---------- Wake Lock (manter tela ligada) ----------
  let wl = null, wantWake = false;
  async function acquireWake() {
    wantWake = true;
    try { if ('wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWake() { wantWake = false; try { wl && wl.release(); } catch {} wl = null; }
  document.addEventListener('visibilitychange', () => {
    if (wantWake && !wl && document.visibilityState === 'visible') acquireWake();
  });

  // ---------- Utils ----------
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // Sobe o bitrate do Opus (qualidade) via setParameters
  async function setSenderBitrate(sender, bps) {
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = bps;
      await sender.setParameters(p);
    } catch {}
  }
  // SDP munge: força stereo/fec/bitrate no Opus
  function tuneOpus(sdp, { bitrate = 128000, stereo = true } = {}) {
    return sdp.replace(/a=fmtp:111 ([^\r\n]+)/, (m, params) => {
      const parts = params.split(';').filter(p => !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec|usedtx)=/.test(p.trim()));
      parts.push('stereo=' + (stereo ? 1 : 0), 'sprop-stereo=' + (stereo ? 1 : 0),
                 'maxaveragebitrate=' + bitrate, 'useinbandfec=1', 'usedtx=0');
      return 'a=fmtp:111 ' + parts.join(';');
    });
  }

  // ---------- PWA ----------
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
    }
  }

  global.MA = {
    $, toast, Prefs, gate, logout, authQuery, loadIce, getIce,
    buildBoostChain, attachVU, acquireWake, releaseWake, fmtDur,
    setSenderBitrate, tuneOpus, registerSW,
  };
})(window);
