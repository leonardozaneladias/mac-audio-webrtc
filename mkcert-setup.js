#!/usr/bin/env node
// Gera um certificado *confiável* usando mkcert (zero avisos no iPhone).
//
// O que este script faz:
//   1. Confere se o mkcert está instalado.
//   2. Instala a CA raiz do mkcert no Mac (mkcert -install) — pode pedir senha.
//   3. Gera o certificado para localhost + IPs da rede em certs/mkcert-*.pem.
//   4. Copia a CA raiz (rootCA.pem) para certs/ para você enviar ao iPhone.
//
// Depois é só instalar/confiar nessa CA raiz no iPhone (instruções no final).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { lanIPs, localHostname } = require('./certs');

const DIR = path.join(__dirname, 'certs');
const CERT = path.join(DIR, 'mkcert-cert.pem');
const KEY = path.join(DIR, 'mkcert-key.pem');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function has(cmd) {
  try { run('which', [cmd]); return true; } catch { return false; }
}

function main() {
  if (!has('mkcert')) {
    console.error('❌ mkcert não encontrado.\n');
    console.error('Instale com Homebrew e rode de novo:');
    console.error('     brew install mkcert nss');
    console.error('     npm run mkcert\n');
    process.exit(1);
  }

  fs.mkdirSync(DIR, { recursive: true });

  console.log('→ Instalando a CA raiz do mkcert no Mac (pode pedir a senha)…');
  try {
    run('mkcert', ['-install'], { stdio: 'inherit' });
  } catch {
    console.error('⚠️  Não consegui rodar "mkcert -install" automaticamente.');
    console.error('   Rode manualmente: mkcert -install');
  }

  const ips = lanIPs();
  const hosts = ['localhost', '127.0.0.1', localHostname(), ...ips];
  console.log(`→ Gerando certificado para: ${hosts.join(', ')}`);
  run('mkcert', ['-cert-file', CERT, '-key-file', KEY, ...hosts], { stdio: 'inherit' });

  // Localiza e copia a CA raiz para enviar ao iPhone
  let caRoot = '';
  try { caRoot = run('mkcert', ['-CAROOT']).trim(); } catch {}
  const rootSrc = caRoot && path.join(caRoot, 'rootCA.pem');
  const rootDst = path.join(DIR, 'rootCA.pem');
  if (rootSrc && fs.existsSync(rootSrc)) {
    fs.copyFileSync(rootSrc, rootDst);
  }

  console.log('\n✅ Certificado confiável pronto em certs/mkcert-*.pem');
  console.log('   O servidor vai usá-lo automaticamente no próximo "npm start".\n');

  console.log('════════ Para o iPhone parar de avisar ════════\n');
  console.log('Você precisa instalar e CONFIAR na CA raiz do mkcert no iPhone:');
  if (fs.existsSync(rootDst)) {
    console.log(`  1. Envie este arquivo ao iPhone (AirDrop ou e-mail):`);
    console.log(`        ${rootDst}`);
  } else {
    console.log(`  1. Pegue o rootCA.pem em:  ${rootSrc || '(rode: mkcert -CAROOT)'}`);
    console.log('     e envie ao iPhone (AirDrop ou e-mail).');
  }
  console.log('  2. No iPhone, abra o arquivo → Ajustes mostra "Perfil Baixado"');
  console.log('     → Ajustes → Geral → VPN e Gerenciamento de Dispositivo →');
  console.log('     toque no perfil "mkcert…" → Instalar.');
  console.log('  3. Ative a confiança total:');
  console.log('     Ajustes → Geral → Sobre → Configurações de Confiança de');
  console.log('     Certificado → ligue a chave do certificado mkcert.');
  console.log('\nFeito isso, abra https://<IP-DO-MAC>:3443/listen sem nenhum aviso. 🎧\n');
}

main();
