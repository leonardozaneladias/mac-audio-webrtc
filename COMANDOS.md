# Comandos — Mac Audio → iPhone

Referência rápida de todos os comandos do projeto.

---

## 🚀 Iniciar a aplicação

```bash
npm start
```

Sobe os dois servidores (HTTP para o Mac, HTTPS para o iPhone) e mostra os
endereços no terminal. Para parar: `Ctrl + C`.

Alternativa equivalente (é o que o `npm start` executa por baixo):

```bash
node server.js
```

### Rodar em segundo plano (continua após fechar o terminal)

```bash
# inicia em background e joga os logs num arquivo
nohup node server.js > server.log 2>&1 &

# ver os logs ao vivo
tail -f server.log

# parar quando estiver em background
pkill -f "node server.js"
```

---

## 🌐 Endereços para abrir no navegador

| Onde | URL | Para quê |
|------|-----|----------|
| **Mac** | `http://localhost:3000/broadcast` | Capturar o microfone (transmitir) |
| **iPhone** | `https://<IP-DO-MAC>:3443/listen` | Escutar |
| Mac (teste) | `http://localhost:3000/listen` | Testar o ouvinte sem o iPhone |
| Qualquer | `.../` (raiz) | Página inicial com os links |

> O `<IP-DO-MAC>` aparece no terminal ao iniciar. Para descobrir manualmente:
> ```bash
> ipconfig getifaddr en0     # Wi-Fi (ou en1 dependendo do Mac)
> ```

---

## 📦 Instalação (primeira vez)

```bash
npm install
```

Instala as dependências (`express`, `ws`, `selfsigned`).

Requisito: Node.js 18+
```bash
node -v
```

---

## 🔒 Certificado confiável no iPhone (opcional, zero avisos)

```bash
# instalar o mkcert (uma vez)
brew install mkcert nss

# gerar o certificado confiável + preparar a CA raiz
npm run mkcert
```

Depois envie `certs/rootCA.pem` ao iPhone (AirDrop/e-mail) e confie nele em:
**Ajustes → Geral → VPN e Gerenciamento de Dispositivo** (instalar) e
**Ajustes → Geral → Sobre → Configurações de Confiança de Certificado** (ativar).

Rode `npm run mkcert` de novo se trocar de rede e o IP mudar.

---

## ⚙️ Mudar as portas (opcional)

```bash
HTTP_PORT=8080 HTTPS_PORT=8443 npm start
```

Padrão: HTTP na `3000`, HTTPS na `3443`.

---

## ⌨️ Atalhos de teclado (na página /broadcast do Mac)

| Tecla | Ação |
|-------|------|
| **Espaço** ou **P** | Pausar / retomar a transmissão |
| **R** | Iniciar / parar a gravação |

---

## 🛠️ Diagnóstico

```bash
# ver se o servidor está de pé
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3443/listen

# ver o que está usando a porta 3000
lsof -i :3000

# matar o servidor
pkill -f "node server.js"
```
