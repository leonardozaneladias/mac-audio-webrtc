# Hospedar no homelab (CloudPanel) — ouvir de qualquer lugar

Guia para rodar o Mac Audio no seu homelab com **domínio + SSL real** (zero
avisos de certificado) e **ouvir fora de casa** (4G/5G) via servidor TURN.

> Lembrete de arquitetura: o homelab roda só a **sinalização**. O microfone
> continua sendo capturado no **navegador do Mac** (`/broadcast`), e o áudio vai
> Mac→iPhone (peer-to-peer, ou via TURN quando o NAT bloqueia). O Mac precisa
> estar com a aba `/broadcast` aberta.

```
   Mac (casa)          Homelab / CloudPanel            iPhone (4G/5G)
  /broadcast ──WSS──▶  Node (proxy Nginx + SSL)  ◀──WSS── /listen
      │                coturn (TURN)  🔁                     │
      └────────── áudio WebRTC (direto ou via TURN) ─────────┘
```

---

## Visão geral (o que você vai configurar)
1. **DNS**: dois nomes apontando pro seu IP público — `audio.seudominio.com` (o
   site) e `turn.seudominio.com` (o TURN).
2. **CloudPanel**: site Node.js + SSL Let's Encrypt + WebSocket no Nginx.
3. **coturn**: o servidor TURN.
4. **Roteador**: encaminhar as portas.
5. **App**: variáveis de ambiente (`.env`).

---

## 1. DNS
Crie dois registros A apontando para o **IP público da sua casa**:
```
audio.seudominio.com  →  SEU_IP_PUBLICO
turn.seudominio.com   →  SEU_IP_PUBLICO
```
> IP dinâmico? Use DDNS (DuckDNS/No-IP) ou Cloudflare, apontando os dois nomes.

## 2. App no CloudPanel (site Node.js)
1. **Sites → Add Site → Node.js**, domínio `audio.seudominio.com`.
2. Suba o projeto para a pasta do site (git clone ou upload) e instale:
   ```bash
   npm install --omit=dev
   ```
3. Crie o arquivo **`.env`** (copie de `.env.example`) e preencha:
   ```bash
   cp .env.example .env
   # gere os segredos:
   openssl rand -hex 24   # use no ACCESS_TOKEN
   openssl rand -hex 24   # use no TURN_SECRET (o mesmo vai no turnserver.conf)
   ```
   Ajuste `TURN_HOST=turn.seudominio.com` e `APP_URL=https://audio.seudominio.com`.
4. **Comando de start** no CloudPanel: `node server.js` (o painel gerencia o
   processo). A app lê o `.env` automaticamente? → veja a nota no fim.
5. **SSL**: aba SSL/TLS → **Let's Encrypt** → emitir para `audio.seudominio.com`.
6. **WebSocket**: edite o Vhost e garanta as linhas de `Upgrade`/`Connection` —
   veja `deploy/nginx-websocket.conf`.

## 3. coturn (TURN)
Instale no homelab (Debian/Ubuntu):
```bash
sudo apt update && sudo apt install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```
Copie a config e ajuste os valores (domínio, segredo, IP público):
```bash
sudo cp deploy/turnserver.conf /etc/turnserver.conf
sudo nano /etc/turnserver.conf   # troque SEU_SEGREDO_TURN, turn.seudominio.com, SEU_IP_PUBLICO
```
Emita um certificado para o TURN (para `turns://` na porta 5349):
```bash
sudo certbot certonly --standalone -d turn.seudominio.com
```
Inicie:
```bash
sudo systemctl enable coturn && sudo systemctl restart coturn
sudo systemctl status coturn
```

### Alternativa em Docker (se preferir)
```bash
docker run -d --name coturn --network host \
  -v /etc/turnserver.conf:/etc/turnserver.conf:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  coturn/coturn -c /etc/turnserver.conf
```

## 4. Portas no roteador (encaminhar para o homelab)
| Porta | Protocolo | Para quê |
|------:|-----------|----------|
| 443   | TCP       | Site (CloudPanel/HTTPS) |
| 3478  | UDP e TCP | TURN |
| 5349  | TCP       | TURN sobre TLS (turns) |
| 49160–49200 | UDP | Faixa de relay do TURN (igual ao turnserver.conf) |

## 5. Testar
1. No **Mac**, abra: `https://audio.seudominio.com/broadcast?token=SEU_TOKEN`
   → começar a transmitir.
2. No **iPhone com Wi-Fi desligado (4G/5G)**:
   `https://audio.seudominio.com/listen?token=SEU_TOKEN` → Escutar.
3. Confira o painel de qualidade. Se aparecer conexão e áudio, o TURN está ok.

### Validar o TURN isoladamente
Use o **Trickle ICE** do WebRTC (webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
coloque `turn:turn.seudominio.com:3478`, username/credential de teste (ou gere
via `/ice?token=...`) e veja se aparece um candidato do tipo **relay**.

---

## Segurança (importante)
- **Nunca** exponha sem `ACCESS_TOKEN` — sem ele qualquer um acessa seu microfone.
- Trate o link com `?token=...` como uma senha. Se vazar, gere outro token.
- O `turnserver.conf` já bloqueia relay para redes privadas (evita abuso interno).
- Opcional: no CloudPanel dá pra somar **Basic Auth** no vhost como 2ª camada.

## Nota sobre o `.env`
Dependendo de como o CloudPanel inicia o processo, o `.env` pode não ser lido
automaticamente. Duas opções:
- Iniciar com as variáveis inline no comando, ou
- Adicionar no topo do `server.js`: `require('dotenv').config()` e instalar
  `npm i dotenv`. (Me avise que eu já deixo isso pronto.)
