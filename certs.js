// Gera (e reaproveita) um certificado TLS autoassinado cobrindo localhost e
// todos os IPs IPv4 da rede local, para o iPhone acessar via HTTPS.
// Se os IPs da máquina mudarem, o certificado é regenerado automaticamente.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const selfsigned = require('selfsigned');

// Nome .local do Mac (mDNS/Bonjour). É estável mesmo quando o IP muda, e o
// iPhone resolve nativamente — por isso é o endereço mais confiável.
function localHostname() {
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    if (name) return `${name}.local`;
  } catch { /* fallback abaixo */ }
  const h = os.hostname();
  return h.endsWith('.local') ? h : `${h}.local`;
}

const DIR = path.join(__dirname, 'certs');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const META = path.join(DIR, 'meta.json');

// Certificado confiável gerado pelo mkcert (opcional). Se existir, tem prioridade.
const MKCERT = path.join(DIR, 'mkcert-cert.pem');
const MKKEY = path.join(DIR, 'mkcert-key.pem');

function lanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function generate(ips) {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: localHostname() },   // nome .local (estável)
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  // Extensões exigidas pelo iOS/Safari para aceitar (ou sequer conectar) num
  // certificado autoassinado: validade curta (<= 825 dias), Key Usage e
  // Extended Key Usage com serverAuth. Sem isso, o Safari dá "não foi possível
  // estabelecer uma conexão segura".
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'MacAudio' }],
    {
      days: 397,                      // dentro do limite de 825 dias do iOS
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CERT, pems.cert);
  fs.writeFileSync(KEY, pems.private);
  fs.writeFileSync(META, JSON.stringify({ ips }));
  return { cert: pems.cert, key: pems.private, source: 'selfsigned' };
}

// Retorna { key, cert, source }, gerando só quando necessário.
// Prioridade: certificado do mkcert (confiável) > autoassinado (fallback).
function getCredentials() {
  if (fs.existsSync(MKCERT) && fs.existsSync(MKKEY)) {
    return {
      cert: fs.readFileSync(MKCERT),
      key: fs.readFileSync(MKKEY),
      source: 'mkcert',
    };
  }

  const ips = lanIPs();
  if (fs.existsSync(CERT) && fs.existsSync(KEY) && fs.existsSync(META)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
      const same = Array.isArray(meta.ips) &&
        meta.ips.length === ips.length &&
        meta.ips.every((ip) => ips.includes(ip));
      if (same) {
        return { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY), source: 'selfsigned' };
      }
    } catch { /* regenera abaixo */ }
  }
  return generate(ips);
}

module.exports = { getCredentials, lanIPs, localHostname };
