/* Mac Audio — ouvinte (iPhone) */
const { $, toast, Prefs, gate, loadIce, getIce, authQuery, buildBoostChain, attachVU,
        acquireWake, releaseWake, fmtDur, registerSW } = MA;

registerSW();

let ws = null, pc = null;
let audioCtx = null, boost = null, srcNode = null, recDest = null, vu = null;
let listening = false, manualStop = false, backoff = 1000;
let statsTimer = null, timerTimer = null, startedAt = 0;
let prevLost = 0, prevRecv = 0, haveBaseline = false;
let volPct = Prefs.get('vol', 100), turbo = Prefs.get('turbo', false), muted = false;
let recorder = null, recChunks = [], recStartAt = 0;

gate(init);

function init() {
  // restaura preferências na UI
  $('vol').max = turbo ? 500 : 150;
  $('vol').value = volPct; $('pct').textContent = volPct;
  setTurboUI();

  $('start').onclick = start;
  $('stop').onclick = stop;
  $('vol').oninput = (e) => {
    volPct = +e.target.value; $('pct').textContent = volPct; Prefs.set('vol', volPct);
    if (volPct > 0 && muted) { muted = false; $('mute').textContent = '🔇 Mudo'; }
    applyGain();
  };
  $('turbo').onclick = toggleTurbo;
  $('mute').onclick = () => {
    muted = !muted; $('mute').textContent = muted ? '🔊 Som' : '🔇 Mudo'; applyGain();
  };
  $('record').onclick = toggleRecording;
}

function setState(t, cls) {
  $('state').textContent = t;
  const d = $('dot'); d.className = 'dot' + (cls ? ' ' + cls : '');
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    boost = buildBoostChain(audioCtx);
    boost.output.connect(audioCtx.destination);
    recDest = audioCtx.createMediaStreamDestination();
    boost.output.connect(recDest);
    vu = attachVU(audioCtx, boost.output, (lv) => { $('vu').style.width = (lv * 100).toFixed(0) + '%'; });
    boost.setBoost(turbo);
    applyGain();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function applyGain() { if (boost) boost.setGain(muted ? 0 : volPct / 100); }

function setTurboUI() {
  $('turbo').classList.toggle('on', turbo);
  $('turbo').textContent = turbo ? '🚀 Turbo ON' : '🚀 Turbo';
  $('turboWarn').classList.toggle('hidden', !turbo);
}
function toggleTurbo() {
  turbo = !turbo; Prefs.set('turbo', turbo);
  $('vol').max = turbo ? 500 : 150;
  if (!turbo && volPct > 150) { volPct = 150; $('vol').value = 150; $('pct').textContent = 150; Prefs.set('vol', 150); }
  if (boost) boost.setBoost(turbo);
  setTurboUI(); applyGain();
}

// ---------- Ciclo escutar / parar ----------
async function start() {
  manualStop = false; listening = true;
  ensureAudio();
  $('keepalive').play().catch(() => {});
  $('start').classList.add('hidden'); $('stop').classList.remove('hidden');
  $('volCard').classList.remove('hidden'); $('recCard').classList.remove('hidden');
  acquireWake();
  await loadIce();
  startTimer();
  connect();
}

function stop() {
  manualStop = true; listening = false;
  try { ws && ws.close(); } catch {} ws = null;
  closePc();
  stopStats(); stopTimer(); releaseWake();
  if (recorder && recorder.state === 'recording') stopRecording();
  $('vu').style.width = '0%';
  $('stop').classList.add('hidden'); $('start').classList.remove('hidden');
  $('connCard').classList.add('hidden');
  setState('Parado');
}

function closePc() {
  if (srcNode) { try { srcNode.disconnect(); } catch {} srcNode = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
}

// ---------- Sinalização + reconexão ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${authQuery()}`);
  ws.onopen = () => { backoff = 1000; setState('Conectando…', 'warn'); ws.send(JSON.stringify({ type: 'listener' })); };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'offer') await onOffer(msg.sdp);
    else if (msg.type === 'candidate' && pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
    else if (msg.type === 'no-broadcaster') setState('O Mac não está transmitindo ainda…', 'warn');
    else if (msg.type === 'broadcaster-left') { setState('Transmissor saiu — aguardando…', 'warn'); closePc(); }
  };
  ws.onclose = () => {
    if (manualStop || !listening) return;
    setState('Reconectando…', 'warn'); stopStats();
    setTimeout(connect, backoff); backoff = Math.min(backoff * 1.6, 8000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

async function onOffer(sdp) {
  closePc();
  pc = new RTCPeerConnection(getIce());
  pc.onicecandidate = (ev) => { if (ev.candidate && ws) ws.send(JSON.stringify({ type: 'candidate', candidate: ev.candidate })); };
  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    $('keepalive').srcObject = stream; $('keepalive').play().catch(() => {});
    ensureAudio();
    if (srcNode) { try { srcNode.disconnect(); } catch {} }
    srcNode = audioCtx.createMediaStreamSource(stream);
    srcNode.connect(boost.input);
    applyGain();
    setState('Ao vivo', 'on');
    startStats();
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'failed') { try { pc.restartIce(); } catch {} setState('Recuperando conexão…', 'warn'); }
    else if (st === 'disconnected') setState('Instável…', 'warn');
  };
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
}

// ---------- Timer ----------
function startTimer() { startedAt = Date.now(); timerTimer = setInterval(() => { $('timer').textContent = fmtDur(Date.now() - startedAt); }, 1000); }
function stopTimer() { clearInterval(timerTimer); timerTimer = null; $('timer').textContent = ''; }

// ---------- Qualidade da conexão ----------
function classify(rttMs, lossPct, jitMs) {
  if (rttMs == null) return ['Medindo…', '#8e8e93'];
  if (rttMs < 80 && lossPct < 1 && jitMs < 15) return ['Excelente', '#30d158'];
  if (rttMs < 150 && lossPct < 3 && jitMs < 30) return ['Boa', '#34c759'];
  if (rttMs < 300 && lossPct < 8 && jitMs < 60) return ['Instável', '#ff9f0a'];
  return ['Ruim', '#ff375f'];
}
async function pollStats() {
  if (!pc) return;
  let rtt = null, jitter = null, lost = null, recv = null, best = -1;
  const stats = await pc.getStats().catch(() => null); if (!stats) return;
  stats.forEach((r) => {
    if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
      if (typeof r.jitter === 'number') jitter = r.jitter;
      if (typeof r.packetsLost === 'number') lost = r.packetsLost;
      if (typeof r.packetsReceived === 'number') recv = r.packetsReceived;
    }
    if (r.type === 'candidate-pair' && r.state === 'succeeded') {
      const b = r.bytesReceived || 0;
      if (b >= best && typeof r.currentRoundTripTime === 'number') { best = b; rtt = r.currentRoundTripTime; }
    }
  });
  let lossPct = 0;
  if (lost != null && recv != null) {
    const dL = Math.max(0, lost - prevLost), dR = Math.max(0, recv - prevRecv);
    prevLost = lost; prevRecv = recv;
    if (haveBaseline && dL + dR > 0) lossPct = (dL / (dL + dR)) * 100;
    haveBaseline = true;
  }
  const rttMs = rtt != null ? Math.round(rtt * 1000) : null;
  const jitMs = jitter != null ? Math.round(jitter * 1000) : null;
  $('mRtt').textContent = rttMs != null ? rttMs + ' ms' : '—';
  $('mLoss').textContent = lost != null ? lossPct.toFixed(1) + '%' : '—';
  $('mJit').textContent = jitMs != null ? jitMs + ' ms' : '—';
  const [label, color] = classify(rttMs, lossPct, jitMs == null ? 0 : jitMs);
  $('qbadge').textContent = label; $('qbadge').style.background = color;
}
function startStats() { $('connCard').classList.remove('hidden'); prevLost = 0; prevRecv = 0; haveBaseline = false; clearInterval(statsTimer); statsTimer = setInterval(pollStats, 1000); }
function stopStats() { clearInterval(statsTimer); statsTimer = null; }

// ---------- Gravar o que ouço ----------
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) for (const t of opts) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
function toggleRecording() { if (recorder && recorder.state === 'recording') stopRecording(); else startRecording(); }
function startRecording() {
  if (!recDest) { toast('Comece a escutar primeiro'); return; }
  const mime = pickMime();
  try { recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { toast('Gravação não suportada'); return; }
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => finalizeRecording(recorder.mimeType || mime);
  recorder.start(); recStartAt = Date.now();
  $('record').classList.add('red'); $('record').innerHTML = '<span class="rec-dot"></span> Parar gravação';
}
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null; $('record').classList.remove('red'); $('record').textContent = '⏺️ Gravar';
}
function finalizeRecording(mime) {
  const type = (mime || '').split(';')[0] || 'audio/webm';
  const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : 'webm';
  const blob = new Blob(recChunks, { type }); const url = URL.createObjectURL(blob);
  const dur = fmtDur(Date.now() - recStartAt); const size = (blob.size / 1048576).toFixed(2);
  const stamp = new Date().toLocaleString('pt-BR').replace(/[/:]/g, '-').replace(', ', '_');
  const item = document.createElement('div'); item.className = 'recitem';
  item.innerHTML = `<div class="meta"><span>🎵 ${dur} · ${size} MB</span><a href="${url}" download="escuta-${stamp}.${ext}">⬇︎ Baixar</a></div><audio controls src="${url}"></audio>`;
  $('recList').prepend(item);
}
