// Servidor de sinalização (signaling) WebRTC.
// Ele NÃO transporta o áudio — só faz a ponte entre o Mac (transmissor) e o
// iPhone (ouvinte). O áudio vai direto entre eles (peer-to-peer); quando o NAT
// não deixa (ex.: iPhone no 4G), o WebRTC usa o servidor TURN como relê.
//
// DOIS MODOS:
//   • Local (padrão): sobe HTTP (localhost, p/ o Mac) + HTTPS autoassinado
//     (p/ o iPhone na mesma rede). É o uso caseiro de sempre.
//   • Proxy (PROXY=1): sobe só HTTP interno; quem faz o SSL é o CloudPanel/Nginx
//     na frente. Habilita token de acesso e credenciais TURN. É o modo homelab.

// Carrega variáveis do arquivo .env, se existir (não quebra se dotenv faltar).
try { require('dotenv').config(); } catch {}

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getCredentials, lanIPs, localHostname } = require('./certs');

// ---- Configuração via variáveis de ambiente -------------------------------
const PROXY = /^(1|true|yes)$/i.test(process.env.PROXY || '');
const PORT = Number(process.env.PORT || process.env.HTTP_PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';        // vazio = sem auth (uso local)
const STUN_URL = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_REALM = process.env.TURN_REALM || TURN_HOST;
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_TLS_PORT = Number(process.env.TURN_TLS_PORT || 5349);
const TURN_TTL = Number(process.env.TURN_TTL || 3600);       // validade das credenciais TURN (s)
const APP_URL = process.env.APP_URL || '';                   // só p/ mensagem de log

const app = express();
if (PROXY) app.set('trust proxy', true);

// ---- Autenticação simples por token ---------------------------------------
function tokenFrom(reqUrl) {
  try { return new URL(reqUrl, 'http://x').searchParams.get('token') || ''; }
  catch { return ''; }
}
function tokenOk(token) {
  if (!ACCESS_TOKEN) return true;                            // sem token configurado = liberado (local)
  // comparação em tempo constante
  const a = Buffer.from(String(token));
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Anti-força-bruta (senha ficou curta): limite por IP -------------------
const fails = new Map();               // ip -> { n, until }
const MAX_FAILS = 12, BLOCK_MS = 60000, WINDOW_MS = 60000;
function clientIp(req) {
  return (req.headers && (req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim())) ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isBlocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function recordFail(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (now - (f.ts || 0) > WINDOW_MS) f.n = 0;
  f.n++; f.ts = now;
  if (f.n >= MAX_FAILS) { f.until = now + BLOCK_MS; f.n = 0; }
  fails.set(ip, f);
}
function clearFail(ip) { fails.delete(ip); }
// Retorna 'ok' | 'bad' | 'blocked'
function authCheck(token, ip) {
  if (isBlocked(ip)) return 'blocked';
  if (tokenOk(token)) { clearFail(ip); return 'ok'; }
  recordFail(ip); return 'bad';
}

// ---- Credenciais TURN temporárias (padrão TURN REST / coturn use-auth-secret)
function turnCredentials() {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = String(expiry);
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential };
}

function iceServers() {
  const list = [{ urls: STUN_URL }];
  if (TURN_HOST && TURN_SECRET) {
    const { username, credential } = turnCredentials();
    list.push({
      urls: [
        `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
        `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
        `turns:${TURN_HOST}:${TURN_TLS_PORT}?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return list;
}

// Entrega a configuração ICE (STUN + TURN) para os clientes.
// Também é o endpoint que a tela de login usa para validar a senha.
app.get('/ice', (req, res) => {
  const r = authCheck(req.query.token, clientIp(req));
  if (r === 'blocked') return res.status(429).json({ error: 'muitas tentativas, tente em 1 min' });
  if (r === 'bad') return res.status(401).json({ error: 'token inválido' });
  res.json({ iceServers: iceServers() });
});

// Baixar a CA raiz do mkcert (só útil no modo local, para confiar no iPhone)
app.get('/rootCA.pem', (req, res) => {
  const p = path.join(__dirname, 'certs', 'rootCA.pem');
  if (!fs.existsSync(p)) return res.status(404).send('rootCA.pem não encontrado. Rode: npm run mkcert');
  res.type('application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="mkcert-rootCA.pem"');
  res.sendFile(p);
});

// no-cache: o navegador revalida (via ETag) a cada carga, então pega a versão
// nova assim que muda — evita ficar preso em HTML/JS/CSS antigo entre deploys.
app.use(express.static('public', {
  extensions: ['html'],
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---- Estado compartilhado da ponte ----------------------------------------
let broadcaster = null;            // o Mac que captura o microfone
const listeners = new Map();       // id -> ws (cada ouvinte)
let nextId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function handleConnection(ws, req) {
  // Rejeita quem não apresentar a senha correta (ou estiver bloqueado)
  const r = authCheck(tokenFrom(req && req.url), clientIp(req));
  if (r !== 'ok') {
    try { ws.close(r === 'blocked' ? 4029 : 4001, r); } catch {}
    return;
  }

  ws.role = null;
  ws.id = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'broadcaster':
        broadcaster = ws;
        ws.role = 'broadcaster';
        console.log('🎙️  Transmissor conectado');
        for (const id of listeners.keys()) send(broadcaster, { type: 'new-listener', id });
        break;

      case 'listener':
        ws.role = 'listener';
        ws.id = String(nextId++);
        listeners.set(ws.id, ws);
        console.log(`🎧 Ouvinte conectado: ${ws.id}`);
        if (broadcaster) send(broadcaster, { type: 'new-listener', id: ws.id });
        else send(ws, { type: 'no-broadcaster' });
        break;

      case 'offer':
        send(listeners.get(msg.id), { type: 'offer', id: msg.id, sdp: msg.sdp });
        break;

      case 'answer':
        send(broadcaster, { type: 'answer', id: ws.id, sdp: msg.sdp });
        break;

      case 'candidate':
        if (ws.role === 'broadcaster') {
          send(listeners.get(msg.id), { type: 'candidate', id: msg.id, candidate: msg.candidate });
        } else if (ws.role === 'listener') {
          send(broadcaster, { type: 'candidate', id: ws.id, candidate: msg.candidate });
        }
        break;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'broadcaster') {
      broadcaster = null;
      console.log('🎙️  Transmissor desconectado');
      for (const l of listeners.values()) send(l, { type: 'broadcaster-left' });
    } else if (ws.role === 'listener' && ws.id) {
      listeners.delete(ws.id);
      console.log(`🎧 Ouvinte saiu: ${ws.id}`);
      send(broadcaster, { type: 'listener-left', id: ws.id });
    }
  });
}

// Heartbeat: ping periódico mantém o WebSocket vivo através do Cloudflare Tunnel
// (que fecha conexões ociosas) e derruba sockets mortos.
function startHeartbeat(wss) {
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, 30000);
}

// ===========================================================================
// MODO PROXY (homelab / CloudPanel): só HTTP interno; SSL fica no Nginx
// ===========================================================================
if (PROXY) {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on('connection', handleConnection);
  startHeartbeat(wss);
  server.listen(PORT, () => {
    console.log('\n=============================================');
    console.log('  Mac Audio (modo PROXY / homelab)  ✅ no ar');
    console.log('=============================================\n');
    console.log(`Node ouvindo em http://127.0.0.1:${PORT}  (o CloudPanel/Nginx faz o SSL na frente)`);
    console.log(`Auth: ${ACCESS_TOKEN ? 'token exigido ✅' : '⚠️  SEM token (defina ACCESS_TOKEN!)'}`);
    console.log(`TURN: ${TURN_HOST && TURN_SECRET ? TURN_HOST + ' ✅' : '⚠️  não configurado (só STUN)'}`);
    if (APP_URL) {
      const q = ACCESS_TOKEN ? `?token=${ACCESS_TOKEN}` : '';
      console.log(`\nMac  (transmitir): ${APP_URL}/broadcast${q}`);
      console.log(`iPhone (escutar):  ${APP_URL}/listen${q}`);
    }
    console.log('');
  });

// ===========================================================================
// MODO LOCAL (padrão): HTTP + HTTPS autoassinado, para uso na mesma rede
// ===========================================================================
} else {
  const httpServer = http.createServer(app);
  const wssHttp = new WebSocketServer({ server: httpServer });
  wssHttp.on('connection', handleConnection);
  startHeartbeat(wssHttp);

  const { key, cert, source } = getCredentials();
  const httpsServer = https.createServer({ key, cert }, app);
  const wssHttps = new WebSocketServer({ server: httpsServer });
  wssHttps.on('connection', handleConnection);
  startHeartbeat(wssHttps);

  httpServer.listen(PORT, () => {
    httpsServer.listen(HTTPS_PORT, () => {
      const ips = lanIPs();
      console.log('\n=============================================');
      console.log('  Mac Audio → iPhone (WebRTC + HTTPS)  ✅ no ar');
      console.log('=============================================\n');
      console.log('1) No SEU MAC (Chrome ou Safari), abra:');
      console.log(`     http://localhost:${PORT}/broadcast`);
      console.log('   (localhost não pede certificado)\n');
      console.log('2) No IPHONE (mesma rede Wi-Fi), abra no Safari via HTTPS:');
      console.log('   ⭐ RECOMENDADO (não muda quando o IP muda):');
      console.log(`     https://${localHostname()}:${HTTPS_PORT}/listen`);
      if (ips.length) {
        console.log('   Ou por IP (se o .local não funcionar):');
        ips.forEach((ip) => console.log(`     https://${ip}:${HTTPS_PORT}/listen`));
      }
      if (source === 'mkcert') {
        console.log('\n   🔒 Certificado: mkcert (confiável). Se você já instalou a CA');
        console.log('   raiz no iPhone, o Safari abre sem nenhum aviso.');
      } else {
        console.log('\n   🔒 Certificado: autoassinado. Na 1ª vez o Safari avisa —');
        console.log('   toque em "Mostrar detalhes" → "visitar este site" para liberar.');
        console.log('   (Para zero avisos: rode  npm run mkcert)');
      }
      console.log('\nDica: deixe a aba /broadcast aberta no Mac enquanto escuta.\n');
    });
  });
}
