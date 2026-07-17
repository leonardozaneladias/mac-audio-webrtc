/* Mac Audio — transmissor (Mac) */
const { $, toast, Prefs, gate, loadIce, getIce, authQuery, buildBoostChain, attachVU,
        fmtDur, setSenderBitrate, tuneOpus, registerSW } = MA;

registerSW();

let ws = null;
const peers = new Map();               // id -> RTCPeerConnection
let audioCtx = null, boost = null, sendGain = null, outDest = null, micSource = null;
let localStream = null, sentTrack = null;
let transmitting = false, manualStop = false, paused = false, backoff = 1000;
let inGainPct = Prefs.get('in', 100), turbo = Prefs.get('inturbo', false);
let quality = Prefs.get('quality', 'voice');
let recorder = null, recChunks = [], recStartAt = 0;

gate(init);

function init() {
  $('inGain').max = turbo ? 500 : 150;
  $('inGain').value = inGainPct; $('inpct').textContent = inGainPct;
  setTurboUI(); setQualityUI();
  $('start').onclick = start;
  $('stop').onclick = stop;
  $('pause').onclick = togglePause;
  $('record').onclick = toggleRecording;
  $('turbo').onclick = toggleTurbo;
  $('inGain').oninput = (e) => { inGainPct = +e.target.value; $('inpct').textContent = inGainPct; Prefs.set('in', inGainPct); applyGain(); };
  $('qVoice').onclick = () => setQuality('voice');
  $('qMusic').onclick = () => setQuality('music');
  $('copyLink').onclick = () => {
    navigator.clipboard.writeText(location.origin + '/listen').then(() => toast('Link copiado!')).catch(() => toast(location.origin + '/listen'));
  };
  window.addEventListener('keydown', (e) => {
    if (!transmitting) return;
    const tag = (e.target.tagName || '').toUpperCase();
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' || e.code === 'Space' || e.key.toLowerCase() === 'p') { e.preventDefault(); togglePause(); }
    else if (e.key.toLowerCase() === 'r') { e.preventDefault(); toggleRecording(); }
  });
}

function setState(t, cls) { $('state').textContent = t; $('dot').className = 'dot' + (cls ? ' ' + cls : ''); }

// ---------- Grafo de áudio: mic → boost → sendGain → outDest (faixa enviada) ----------
function ensureGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  boost = buildBoostChain(audioCtx);
  sendGain = audioCtx.createGain(); sendGain.gain.value = 1;
  outDest = audioCtx.createMediaStreamDestination();
  boost.output.connect(sendGain); sendGain.connect(outDest);
  attachVU(audioCtx, sendGain, (lv) => { $('vu').style.width = (lv * 100).toFixed(0) + '%'; });
  audioCtx._recDest = audioCtx.createMediaStreamDestination(); sendGain.connect(audioCtx._recDest);
  boost.setBoost(turbo); applyGain();
  sentTrack = outDest.stream.getAudioTracks()[0];
}
function applyGain() { if (boost) boost.setGain(inGainPct / 100); }
function connectMic(stream) {
  if (micSource) { try { micSource.disconnect(); } catch {} }
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(boost.input);
}

// ---------- Início / parada ----------
async function start() {
  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }); }
  catch (err) { toast('Sem acesso ao microfone: ' + err.message); return; }
  manualStop = false; transmitting = true; paused = false;
  ensureGraph(); connectMic(localStream); audioCtx.resume();
  $('start').classList.add('hidden');
  ['statusRow', 'vuWrap', 'ctrlRow', 'micCard', 'qualCard', 'shareCard', 'listenersCard', 'recCard'].forEach((id) => $(id).classList.remove('hidden'));
  setState('Transmitindo', 'on');
  const cur = localStream.getAudioTracks()[0].getSettings().deviceId;
  await listMics(cur);
  navigator.mediaDevices.ondevicechange = () => listMics($('mic').value).catch(() => {});
  $('mic').onchange = (e) => switchMic(e.target.value);
  await loadIce();
  connectWS();
  setInterval(pollPeers, 1000);
}

function stop() {
  manualStop = true; transmitting = false;
  try { ws && ws.close(); } catch {} ws = null;
  for (const pc of peers.values()) { try { pc.close(); } catch {} }
  peers.clear();
  if (recorder && recorder.state === 'recording') stopRecording();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
  localStream = null;
  $('vu').style.width = '0%';
  ['statusRow', 'vuWrap', 'ctrlRow', 'micCard', 'qualCard', 'shareCard', 'listenersCard', 'recCard'].forEach((id) => $(id).classList.add('hidden'));
  $('start').classList.remove('hidden');
  setState('Parado');
}

// ---------- Pausar ----------
function applyPause() {
  if (sendGain) sendGain.gain.value = paused ? 0 : 1;
  $('pause').textContent = paused ? '▶︎ Retomar' : '⏸️ Pausar';
  setState(paused ? 'Pausado' : 'Transmitindo', paused ? 'paused' : 'on');
}
function togglePause() { paused = !paused; applyPause(); }

// ---------- Turbo (ganho de entrada) ----------
function setTurboUI() { $('turbo').classList.toggle('on', turbo); $('turbo').textContent = turbo ? '🚀 Turbo ON' : '🚀 Turbo'; $('turboWarn').classList.toggle('hidden', !turbo); }
function toggleTurbo() {
  turbo = !turbo; Prefs.set('inturbo', turbo);
  $('inGain').max = turbo ? 500 : 150;
  if (!turbo && inGainPct > 150) { inGainPct = 150; $('inGain').value = 150; $('inpct').textContent = 150; Prefs.set('in', 150); }
  if (boost) boost.setBoost(turbo);
  setTurboUI(); applyGain();
}

// ---------- Qualidade ----------
function setQualityUI() {
  $('qVoice').classList.toggle('on', quality === 'voice');
  $('qMusic').classList.toggle('on', quality === 'music');
}
function setQuality(q) {
  quality = q; Prefs.set('quality', q); setQualityUI();
  const bps = q === 'music' ? 160000 : 64000;
  for (const pc of peers.values()) {
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
    if (s) setSenderBitrate(s, bps);
  }
  toast(q === 'music' ? 'Música (HQ) — reconecte os ouvintes p/ estéreo total' : 'Modo voz');
}

// ---------- Microfones ----------
async function listMics(currentId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const sel = $('mic'); sel.innerHTML = '';
  mics.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Microfone ${i + 1}`; sel.appendChild(o); });
  if (currentId) sel.value = currentId;
}
async function switchMic(deviceId) {
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }); }
  catch (err) { toast('Falha ao trocar mic: ' + err.message); return; }
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = s; connectMic(s);            // faixa enviada (outDest) não muda → sem renegociação
  toast('Microfone trocado');
}

// ---------- Sinalização ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${authQuery()}`);
  ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify({ type: 'broadcaster' })); };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'new-listener') await makeOffer(msg.id);
    else if (msg.type === 'answer') { const pc = peers.get(msg.id); if (pc) await pc.setRemoteDescription(msg.sdp); }
    else if (msg.type === 'candidate') { const pc = peers.get(msg.id); if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {}); }
    else if (msg.type === 'listener-left') { const pc = peers.get(msg.id); if (pc) pc.close(); peers.delete(msg.id); updateCount(); }
  };
  ws.onclose = () => { if (manualStop || !transmitting) return; setTimeout(connectWS, backoff); backoff = Math.min(backoff * 1.6, 8000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

async function makeOffer(id) {
  const pc = new RTCPeerConnection(getIce());
  peers.set(id, pc);
  pc.addTrack(sentTrack, outDest.stream);
  pc.onicecandidate = (ev) => { if (ev.candidate && ws) ws.send(JSON.stringify({ type: 'candidate', id, candidate: ev.candidate })); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { updateCount(); } };
  const offer = await pc.createOffer();
  if (quality === 'music') offer.sdp = tuneOpus(offer.sdp, { bitrate: 160000, stereo: true });
  await pc.setLocalDescription(offer);
  const s = pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
  if (s) setSenderBitrate(s, quality === 'music' ? 160000 : 64000);
  ws.send(JSON.stringify({ type: 'offer', id, sdp: pc.localDescription }));
  updateCount();
}
function updateCount() { const n = peers.size; $('count').textContent = n === 0 ? 'Nenhum ouvinte' : n + ' ouvinte(s)'; }

// ---------- Qualidade por ouvinte ----------
function classify(rttMs, lossPct, jitMs) {
  if (rttMs == null) return ['Medindo…', '#8e8e93'];
  if (rttMs < 80 && lossPct < 1 && jitMs < 15) return ['Excelente', '#30d158'];
  if (rttMs < 150 && lossPct < 3 && jitMs < 30) return ['Boa', '#34c759'];
  if (rttMs < 300 && lossPct < 8 && jitMs < 60) return ['Instável', '#ff9f0a'];
  return ['Ruim', '#ff375f'];
}
async function peerStats(pc) {
  const stats = await pc.getStats().catch(() => null); if (!stats) return {};
  let rtt = null, jitter = null, lost = null, sent = null, rttPair = null, best = -1;
  stats.forEach((r) => {
    if (r.type === 'remote-inbound-rtp') { if (typeof r.roundTripTime === 'number') rtt = r.roundTripTime; if (typeof r.jitter === 'number') jitter = r.jitter; if (typeof r.packetsLost === 'number') lost = r.packetsLost; }
    if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) { if (typeof r.packetsSent === 'number') sent = r.packetsSent; }
    if (r.type === 'candidate-pair' && r.state === 'succeeded') { const b = r.bytesSent || 0; if (b >= best && typeof r.currentRoundTripTime === 'number') { best = b; rttPair = r.currentRoundTripTime; } }
  });
  if (rtt == null) rtt = rttPair;
  let lossPct = 0;
  if (lost != null && sent != null) { const dL = Math.max(0, lost - (pc._pl || 0)), dS = Math.max(0, sent - (pc._ps || 0)); if (pc._base && dL + dS > 0) lossPct = (dL / (dL + dS)) * 100; pc._pl = lost; pc._ps = sent; pc._base = true; }
  return { rttMs: rtt != null ? Math.round(rtt * 1000) : null, jitMs: jitter != null ? Math.round(jitter * 1000) : null, lossPct: lost != null ? lossPct : null };
}
async function pollPeers() {
  if (!transmitting) return;
  const rows = $('listenerRows');
  if (peers.size === 0) { rows.innerHTML = '<div class="muted">Nenhum ouvinte conectado</div>'; return; }
  const entries = []; for (const [id, pc] of peers) entries.push([id, await peerStats(pc)]);
  rows.innerHTML = entries.map(([id, m]) => {
    const [label, color] = classify(m.rttMs, m.lossPct == null ? 0 : m.lossPct, m.jitMs == null ? 0 : m.jitMs);
    const rtt = m.rttMs != null ? m.rttMs + ' ms' : '—', loss = m.lossPct != null ? m.lossPct.toFixed(1) + '%' : '—', jit = m.jitMs != null ? m.jitMs + ' ms' : '—';
    return `<div class="lrow"><span class="lbadge" style="background:${color}">${label}</span><span class="lname">Ouvinte ${id}</span><span class="lmetrics">RTT ${rtt} · perda ${loss} · jitter ${jit}</span></div>`;
  }).join('');
}

// ---------- Gravação ----------
function pickMime() { const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']; if (window.MediaRecorder && MediaRecorder.isTypeSupported) for (const t of opts) if (MediaRecorder.isTypeSupported(t)) return t; return ''; }
function toggleRecording() { if (recorder && recorder.state === 'recording') stopRecording(); else startRecording(); }
function startRecording() {
  if (!audioCtx || !audioCtx._recDest) { toast('Comece a transmitir primeiro'); return; }
  const mime = pickMime();
  try { recorder = new MediaRecorder(audioCtx._recDest.stream, mime ? { mimeType: mime } : undefined); } catch (e) { toast('Gravação não suportada'); return; }
  recChunks = []; recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => finalizeRecording(recorder.mimeType || mime); recorder.start(); recStartAt = Date.now();
  $('record').classList.add('red'); $('record').innerHTML = '<span class="rec-dot"></span> Parar gravação';
}
function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); recorder = null; $('record').classList.remove('red'); $('record').textContent = '⏺️ Gravar'; }
function finalizeRecording(mime) {
  const type = (mime || '').split(';')[0] || 'audio/webm'; const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : 'webm';
  const blob = new Blob(recChunks, { type }); const url = URL.createObjectURL(blob);
  const dur = fmtDur(Date.now() - recStartAt); const size = (blob.size / 1048576).toFixed(2);
  const stamp = new Date().toLocaleString('pt-BR').replace(/[/:]/g, '-').replace(', ', '_');
  const item = document.createElement('div'); item.className = 'recitem';
  item.innerHTML = `<div class="meta"><span>🎵 ${dur} · ${size} MB</span><a href="${url}" download="gravacao-${stamp}.${ext}">⬇︎ Baixar</a></div><audio controls src="${url}"></audio>`;
  $('recList').prepend(item);
}
