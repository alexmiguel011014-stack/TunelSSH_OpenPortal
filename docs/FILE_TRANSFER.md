# Transferência de Arquivos — OpenPortal Remote

> **Finalidade:** documentar por completo o módulo de transferência e gerenciamento de arquivos do OpenPortal Remote (upload/download entre o PC local e o PC remoto via túnel), incluindo os dialogs nativos do Windows, o protocolo binário por trás, o streaming com backpressure, o walk recursivo de pastas (hierarquia pai-filho) e as operações suportadas.

Última atualização: 2026-08-05
Último commit de referência: `8513464`

---

## 1. Visão Geral (Arquitetura)

A transferência de arquivos **não usa SFTP/SCP**. O app usa um **protocolo binário próprio** transmitido por um proxy `WebSocket → TCP`:

```
[Renderer (React)]  ──IPC──►  [Main: file-transfer.js]  ──ws://127.0.0.1:18901──►  [file-proxy.js]  ──TCP──►  [file-server.js:5001]  (PC remoto)
```

- **`file-server.js`** — roda no **PC remoto** (agente). Servidor TCP na porta **5001** com raiz no diretório do usuário. Interpreta os comandos e acessa o disco.
- **`file-proxy.js`** — ponte bidirecional `WebSocket (18901) ↔ TCP`. Valida que o host de destino seja da faixa privada/Tailscale.
- **`file-transfer.js`** — no **PC local**. Cliente WebSocket que dialoga com o proxy, implementa o mesmo protocolo binário e expõe métodos (`listFiles`, `downloadFile`, `uploadFile`, `uploadFileFromPath`, `deleteFile`, `createDirectory`).
- **`ipc-handlers.js`** — ponte entre o renderer (React) e a camada de transferência. Expõe `ft:list`, `ft:upload`, `ft:uploadFolder`, `ft:download`, `ft:downloadFolder`, `ft:delete`, `ft:mkdir`, `dialog:open`, `dialog:save`.
- **`FileTransfer.jsx`** — interface de duas colunas (Local / Remoto) + botões "Enviar →" e "← Receber" e modal de destino (`UploadDialog`).

VNC usa a mesma arquitetura de proxy, porém em outra porta (18900) e protocolo próprio.

---

## 2. Protocolo binário (framer)

Frames com header fixo de **8 bytes**:

| Campo | Offset | Tamanho | Descrição |
|-------|--------|---------|-----------|
| type | 0 | 4 bytes (BE) | Tipo do frame |
| length | 4 | 4 bytes (BE) | Comprimento do payload |

Tipos:

| type | Constante | Payload |
|------|-----------|---------|
| 0 | `MSG_JSON` | JSON (ex.: `list`, `get_res`, `put_done`) |
| 1 | `MSG_BINARY` | Chunk de dados binário (arquivo) |
| 2 | `MSG_BINARY_END` | Marca o fim da transmissão de um arquivo |

### Comandos

| Comando | Descrição |
|---------|-----------|
| `list` | Lista um diretório remoto (`list_res` com `e[]`). |
| `get` | Baixa um arquivo. Envia `get_res` (tamanho total `z`, offset `o`, nome `n`) e depois chunks `BINARY` + `BINARY_END`. |
| `put` | Envia um arquivo. O servidor responde `put_res` (ack) e o cliente envia chunks `BINARY` + `BINARY_END`; conclui com `put_done`. |
| `delete` | Remove arquivo/diretório (`delete_res`). |
| `mkdir` | Cria diretório (recursivo) (`mkdir_res`). |

---

## 3. Fluxo de UPLOAD (Local → Remoto)

### Dialogs nativos (entrada)

O botão **“Enviar →”** não depende de seleção no painel local. Ele abre o seletor do Windows (`dialog.showOpenDialog`) com propriedades dinâmicas:

```js
properties: ['openFile', 'openDirectory', 'multiSelections', 'dontAddToRecent']
```

O usuário pode selecionar **vários arquivos e/ou pastas** de uma vez. Os caminhos escolhidos são passados diretamente ao pipeline (sem re-seleção manual).

### Destino (UploadDialog)

Após escolher os itens, um modal pergunta o **destino no PC remoto** (`UploadDialog`), que pode ser:
- um diretório de destino (multi-itens), ou
- o caminho final do arquivo (quando é um único arquivo).

### Upload de arquivo

1. `statLocal(caminho)` detecta se é arquivo ou pasta.
2. Arquivo → `ft:upload(remoteDest, { filePath })`.
3. No main, `uploadFileFromPath` lê o arquivo do disco via **`fs.createReadStream`** com `highWaterMark: 64KB` e envia por frames `BINARY`.

### Upload de arquivo (stream + backpressure)

- O stream é pausado quando `ws.bufferedAmount > 4MB` e retomado quando drena (**backpressure**), evitando picos de memória em arquivos grandes.
- O upload só começa a ler o disco **após** receber o `put_res` do servidor (ack), para não sobrecarregar duplicando em buffer.

### Upload de pasta (walk recursivo)

Pasta → `ftUploadFolder(localRoot, remoteParent)`:

1. `walkDir(localRoot)` percorre toda a árvore local recursivamente, montando `relPath` de cada entrada.
2. Para cada **diretório**: `createDirectory(remoteParent + relPath)` — cria a hierarquia **pai-filho** no remoto antes dos arquivos, preservando a estrutura local.
3. Para cada **arquivo**: `uploadFileFromPath(remoteParent + relPath, caminhoLocal)` em streaming, com progresso global.

Aí se o destino remoto ainda não existir, o servidor também faz `mkdir recursive` no `handlePut`.

---

## 4. Fluxo de DOWNLOAD (Remoto → Local)

### Diálogos nativos (saída)

Botão **“← Receber”** abre o seletor do Windows para escolher a **pasta de destino local**:

```js
properties: ['openDirectory', 'createDirectory']
```

**Comportamento:**
- Se houver itens **selecionados** no painel remoto → baixa **apenas** eles.
- Se **nada** estiver selecionado → baixa a **pasta remota atual inteira** (replicando a árvore).

### Download de arquivo

`ft:download(remoteFull, { savePath })`:
- `downloadFile` envia `{ t: 'get', o: startOffset }`; o servidor responde `get_res` (tamanho), abre o arquivo e envia chunks.
- O cliente grava **diretamente no disco** (`fs.open(..., 'w')`) conforme recebe, **sem reter o arquivo em memória**.
- Suporta **resume**: se `partPath` existir, retoma do byte `start = stat.size` do `.part` e ao final renomeia `.part → final`.

### Download de pasta (espelhamento)

`downloadFolder(remoteRoot, localRoot)`:
1. `listRemoteTree` caminha a árvore remota recursivamente (`directories[]` + `files[]`).
2. Cria **todos os diretórios relativos** (inclusive vazios) em `localRoot` antes dos arquivos — espelhando a estrutura.
3. Para cada arquivo: `downloadFile(file.remote, { filePath: localFile })` **stream direto para disco**.
4. Proteção contra traversal: `resolveDestInsideRoot` garante que nenhum destino escape de `localRoot`.

---

## 5. Streaming e Segurança de Memória (evolução)

| Antes | Depois |
|-------|--------|
| Upload carregava o arquivo com `fsp.readFile` (arquivo inteiro em RAM) | `fs.createReadStream` com `highWaterMark: 64KB` |
| Servidor acumulava todos os chunks em `state.chunks` e gravava no fim | Servidor abre o fd em `handlePut` e grava **cada chunk assim que chega** (`writeChain`) |
| Download em memória + `fsp.writeFile` do buffer | Gravação incremental direto no arquivo (`downloadFile` com `filePath`) |
| Sem controle de buffer do WebSocket | Pausa/retomada do stream por `bufferedAmount` |

Essa mudança elimina picos de RAM no PC local E no PC remoto durante arquivos grandes.

---

## 6. Resume de download (`.part` + offset)

- O download separa um arquivo temporário `+ '.part'`.
- Se o download for interrompido, o `partPath` preserva o bytes já baixados.
- Em um novo `ft:download` com `partPath`, `start = stat(partPath).size` e o servidor é `get` com offset `o`.
- Ao terminar, o app renomeia `.part` para o nome final.

---

## 7. Operações suportadas

| Ação | IPC | Método | UI |
|------|-----|--------|----|
| Listar local / remoto | `fs:listDir` / `ft:list` | `listFiles` | painéis |
| Upload arquivo | `ft:upload` | `uploadFileFromPath` / `uploadFile` | botão Enviar |
| Upload pasta (recursivo) | `ft:uploadFolder` | `walkDir` + `createDirectory` | botão Enviar |
| Download arquivo | `ft:download` | `downloadFile` + `.part` | botão Receber |
| Download pasta (recursivo) | `ft:downloadFolder` | `listRemoteTree` | botão Receber |
| Deletar (remoto) | `ft:delete` | `deleteFile` | (IPC/API) |
| Criar pasta | `ft:mkdir` | `createDirectory` | (IPC/API) |
| Explorar local | `fs:getDrives`, `fs:getSpecialDirs`, `fs:getHomeDir` | — | painel Local |

---

## 8. Pontos de extensão / limitações atuais

- [ ] **Rename / Move** — não há `ft:rename`/`ft:move`
- [ ] **Cópia** — não há `ft:copy`
- [ ] **Pausar / Cancelar** em trânsito — não implementado
- [ ] **Drag & drop** — painéis não aceitam drop
- [ ] **Preview de arquivo** — não implementado
- [ ] **Resume de pasta** — somente arquivo único usa `.part`
- [ ] **Novos diretórios ao remoto via UI** — `ft:mkdir` existe mas não há botão "Nova Pasta"

---

## 9. Arquivos relevantes

| Arquivo | Papel |
|---------|-------|
| `src/main/file-transfer.js` | Cliente do protocolo (connection, streaming, backpressure) |
| `src/main/file-server.js` | Servidor TCP do PC remoto (porta 5001) |
| `src/main/file-proxy.js` | Proxy WebSocket→TCP (porta 18901) |
| `src/main/ipc-handlers.js` | Handlers IPC de todas as operações + dialogs |
| `src/main/preload.js` | API exposta ao renderer (`showOpenDialog`, `showSaveDialog`, `ft*`) |
| `src/renderer/src/components/FileTransfer.jsx` | UI principal + fluxos de upload/download nativos |
| `src/renderer/src/components/UploadDialog.jsx` | Modal de escolha do destino remoto |
| `src/renderer/src/components/FileRow.jsx`, `BreadcrumbBar.jsx`, `FileToolbar.jsx` | Painéis + navegação |
| `src/renderer/src/lib/fileIcons.js` | Ícone/tipo por extensão |