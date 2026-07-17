# Mac Audio → iPhone (WebRTC + HTTPS)

Captura o microfone do Mac e escuta ao vivo no iPhone (latência < ~0,3s),
sem instalar app — só o Safari. O áudio vai direto Mac→iPhone (peer-to-peer);
o servidor Node só faz a "ponte" inicial.

O processo sobe **dois servidores** ao mesmo tempo:
- **HTTP** (`localhost:3000`) para o **Mac** — localhost já é contexto seguro,
  então o microfone funciona sem aviso de certificado.
- **HTTPS** (`<IP>:3443`) para o **iPhone** — o Safari exige HTTPS para tocar o
  áudio; usamos um certificado local autoassinado gerado automaticamente.

## Requisitos
- Node.js 18+ instalado no Mac (`node -v`)
- Mac e iPhone na **mesma rede Wi-Fi**

## Como usar
```bash
npm install
npm start
```

O terminal mostra os endereços. Então:

1. **No Mac** abra `http://localhost:3000/broadcast` (Chrome ou Safari) e clique
   em **Começar a transmitir** → autorize o microfone. Deixe a aba aberta.
   Use o seletor **Microfone** para escolher a entrada — dá para trocar ao vivo,
   sem derrubar quem já está ouvindo. Um painel **Qualidade por ouvinte** mostra
   RTT, perda e jitter de cada iPhone conectado, com selo de qualidade.
   O botão **Pausar transmissão** silencia os ouvintes sem derrubar a conexão
   (retomar é instantâneo). O botão **Gravar** salva o áudio da fonte em arquivo
   (player + download aparecem em "Gravações").
   Atalhos: **espaço**/**P** (pausar), **R** (gravar).
2. **No iPhone** abra `https://<IP-DO-MAC>:3443/listen` no Safari. Na 1ª vez o
   Safari avisa que o certificado não é confiável → toque em **"Mostrar
   detalhes" → "visitar este site"**. Depois toque em **Escutar**. Use o
   controle de **Volume** (0–200%, dá para amplificar) e o botão **Silenciar**.
   Um painel mostra **latência (RTT), perda de pacotes e jitter** em tempo real,
   com um selo de qualidade (Excelente / Boa / Instável / Ruim).

## (Opcional) Zero avisos no iPhone com mkcert

Por padrão o certificado é autoassinado — o iPhone pede para você confiar uma
vez. Se quiser **nunca mais ver o aviso**, use o `mkcert` (certificado confiável):

```bash
brew install mkcert nss   # se ainda não tiver
npm run mkcert            # gera o certificado e prepara a CA raiz
```

O script gera `certs/mkcert-*.pem` (o servidor passa a usá-lo sozinho) e copia a
CA raiz para `certs/rootCA.pem`. Para o iPhone confiar:

1. Envie `certs/rootCA.pem` ao iPhone (AirDrop ou e-mail) e abra o arquivo.
2. Ajustes → Geral → VPN e Gerenciamento de Dispositivo → instale o perfil "mkcert…".
3. Ajustes → Geral → Sobre → Configurações de Confiança de Certificado → ligue
   a chave do certificado mkcert.

Depois disso, `https://<IP>:3443/listen` abre **sem nenhum aviso**. Trocou de
rede e o IP mudou? Rode `npm run mkcert` de novo.

## Observações
- **Permissão do microfone**: a primeira vez o macOS pede acesso ao mic para o
  navegador (Ajustes → Privacidade → Microfone).
- **Qual certificado está em uso**: o servidor mostra na inicialização
  (`🔒 Certificado: mkcert (confiável)` ou `autoassinado`).
- **Certificado**: é gerado em `certs/` na primeira execução, já cobrindo o IP
  atual da rede. Se você trocar de rede e o IP mudar, ele é regenerado sozinho.
- **STUN**: já configurado; na mesma rede local nem é necessário, mas ajuda se a
  rede tiver isolamento de clientes.
- **Portas**: dá pra mudar com `HTTP_PORT` e `HTTPS_PORT` (ex.:
  `HTTPS_PORT=8443 npm start`).
- Latência típica na LAN: 100–300 ms.

## Arquivos
- `server.js` — sinalização + servidores HTTP e HTTPS (Express + WebSocket)
- `certs.js` — escolhe o certificado (mkcert se existir, senão autoassinado)
- `mkcert-setup.js` — `npm run mkcert`: gera certificado confiável + CA raiz
- `public/broadcast.html` — página do Mac que captura o microfone
- `public/listen.html` — página do iPhone que reproduz
