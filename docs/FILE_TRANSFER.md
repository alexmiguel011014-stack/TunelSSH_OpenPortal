# Transferência de Arquivos — OpenPortal Remote

> **Finalidade:** documentar por completo o módulo de transferência e gerenciamento de arquivos do OpenPortal Remote (upload/download entre o PC local e o PC remoto via túnel): a UI de dois painéis, o protocolo binário multiplataforma, o streaming com backpressure, o walk recursivo de pastas (hierarquia pai-filho) e as operações suportadas.

Última atualização: 2026-08-06

---

## 1. Visão Geral (Arquitetura)

A transferência de arquivos **não usa SFTP/SCP**. O app usa um **protocolo binário próprio** transmitido por um proxy `WebSocket → TCP`:

```
[Renderer (React)]  ──IPC──►  [Main: file-transfer.js]  ──ws://127.0.0.1:18901──►  [file-proxy.js]  ──TCP──►  [file-server.js:5001]  (PC remoto)
```

- **`file-server.js`** — roda no **PC remoto** (agente). Servidor TCP na porta **5001** com raiz no diretório do usuário (`app.getPath('home')`, ou `os.homedir()` no modo autônomo). Interpreta os comandos e acessa o disco.
- **`file-proxy.js`** — ponte bidirecional `WebSocket (18901) ↔ TCP`, com backpressure nas duas direções. Valida que o host de destino seja da faixa privada/Tailscale.
- **`file-transfer.js`** — no **PC local**. Cliente WebSocket que dialoga com o proxy, implementa o mesmo protocolo binário e expõe métodos (`getInfo`, `listFiles`, `statFile`, `downloadFile`, `uploadFile`, `uploadFileFromPath`, `deleteFile`, `createDirectory`).
- **`vpath.js`** — módulo de caminhos compartilhado (virtual ↔ nativo). Ver seção 2.
- **`ipc-handlers.js`** — ponte entre o renderer e a camada de transferência. Toda a aritmética de caminho **local** acontece aqui, com o módulo `path` do Node.
- **`FileTransfer.jsx` + `FilePanel.jsx`** — interface de dois painéis (Local / Remoto) com barra de ações central.

VNC usa a mesma arquitetura de proxy, porém em outra porta (18900) e protocolo próprio.

---

## 2. Caminhos multiplataforma (`vpath.js`)

O ponto mais importante do módulo: **as duas pontas podem rodar em sistemas operacionais diferentes** (Windows ↔ Linux ↔ macOS). Por isso existem dois tipos de caminho, que nunca se misturam:

| Tipo | Formato | Onde vive |
|------|---------|-----------|
| **Virtual** | POSIX, sempre absoluto na raiz do agente: `/`, `/Documentos/nota.txt` | Protocolo (fio), painel remoto, todos os comandos `ft:*` |
| **Nativo** | Do SO em questão: `C:\Users\a\Documents`, `/home/a/Documents` | Disco local, disco do agente |

- O **agente** converte virtual → nativo com `vpath.toNative(raiz, caminho)`, que valida cada componente e recusa qualquer coisa que escape da raiz (`..`, caminho absoluto, `:` no Windows).
- O **renderer** nunca escreve separador de diretório. Para o painel remoto usa `lib/paths.js` (só `/`); para o painel local recebe do main o caminho absoluto de cada item (`entry.p`), o pai (`parent`), as migalhas (`crumbs`) e usa `fs:joinPath` quando precisa juntar.

**Por que isso importa:** o formato antigo usava `\` no fio. Num agente Linux, `path.normalize('\Documentos\nota.txt')` devolve `"Documentos\nota.txt"` — **um único nome de arquivo**, não dois níveis de pasta. Ou seja, um agente Linux/macOS só conseguia listar a raiz; qualquer subpasta dava `ENOENT`.

**Compatibilidade de rollout (nos dois sentidos):**
- Cliente novo → agente Windows antigo: o agente antigo faz `isAbsolute('/Documentos')` → `true`, remove a barra inicial e resolve sob a raiz. Funciona.
- Cliente antigo → agente novo: `vpath.toVirtual` aceita `\` e normaliza. Funciona.

---

## 3. Protocolo binário (framer)

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
| `info` | **(v2)** Metadados do agente: `proto`, `platform`, `sep`, `host`, `root` nativo e `quick` (atalhos Desktop/Downloads/Documentos em caminho virtual). Agentes v1 não respondem — o cliente usa timeout curto (6s) e degrada. |
| `list` | Lista um diretório remoto (`list_res` com `e[]`, `p` virtual e `np` nativo). |
| `stat` | **(v2)** Metadados de um item (`d`, `z`, `m`). |
| `get` | Baixa um arquivo. Envia `get_res` (tamanho `z`, offset `o`, nome `n`) e depois chunks `BINARY` + `BINARY_END`. |
| `put` | Envia um arquivo. O servidor responde `put_res` (ack) e o cliente envia chunks `BINARY` + `BINARY_END`; conclui com `put_done`. |
| `delete` | Remove arquivo/diretório (`delete_res`). Recusa remover a raiz. |
| `mkdir` | Cria diretório (recursivo) (`mkdir_res`). |

Toda resposta ecoa o `i` da requisição — inclusive `error` de comando desconhecido, para o cliente resolver a pendência sem esperar timeout.

### Serialização por socket

`get` e `put` carregam frames binários **sem identificador de stream**, então dois em paralelo se intercalariam. O servidor mantém **duas filas por socket** (`_getQueue`, `_putQueue`): como as direções são opostas (get = servidor→cliente, put = cliente→servidor), um `get` e um `put` podem correr juntos, mas nunca dois do mesmo tipo. O `put` só libera a fila quando finaliza (`BINARY_END` ou queda do socket).

---

## 4. Conexão e sessão

`ft:connect` é **idempotente por destino**: um segundo pedido para o mesmo `host:porta` reaproveita a conexão viva (ou aguarda a que está em andamento) em vez de abrir outro socket. É isso que torna a **dupla montagem do React StrictMode** inofensiva — os dois `ftConnect` do mesmo efeito recebem a mesma `sessionId`, sem derrubar nada.

Cada conexão tem uma `sessionId` que acompanha **todo** evento `ft:status`. O renderer descarta eventos de sessões que não são a dele, então um aviso atrasado de uma conexão antiga (troca de máquina, remonte do StrictMode) não marca a UI como desconectada. Simetricamente, `ft:disconnect(sessionId)` só encerra se a sessão ativa for aquela.

`connectFileTransfer(host, port, { force: true })` ignora o cache — é o que o botão "Tentar novamente" usa.

---

## 5. Interface (dois painéis)

```
┌──────────────────────┬──────────┬──────────────────────┐
│ ESTE COMPUTADOR      │ Enviar → │ PC REMOTO   [conectado]│
│ [C:][D:] atalhos     │          │ atalhos              │
│ C: › Users › Desktop │ ←Receber │ Raiz › Documentos    │
│ ☑ nome  tam.  data   │          │ ☑ nome  tam.  data   │
└──────────────────────┴──────────┴──────────────────────┘
```

- **Raízes** (só no local): drives no Windows; `/` + volumes montados (`/Volumes`, `/media/<user>`, `/run/media/<user>`, `/mnt`) no Linux/macOS. A raiz destacada é a de prefixo mais longo.
- **Atalhos**: Início / Área de Trabalho / Downloads / Documentos. No local vêm de `app.getPath` (respeita pastas localizadas e redirecionadas); no remoto vêm do `info` do agente (que também lê o XDG user-dirs no Linux).
- **Migalhas clicáveis**, botão **↑ Acima**, filtro por texto, ordenação por nome/tamanho/data, visão lista ou ícones.
- **Seleção por nome** (não por índice): ordenar, filtrar ou atualizar a pasta não faz a seleção apontar para outro arquivo.
- **Barra de ações central**: `Enviar →` (seleção local → pasta remota aberta) e `← Receber` (seleção remota → pasta local aberta), mais os atalhos "escolher no sistema..." / "salvar em outra pasta..." que abrem os diálogos nativos.
- **Erro de conexão** aparece como faixa vermelha: *"Agente remoto inacessível em `100.x.x.x:5001`. Verifique se o OpenPortal está aberto no PC remoto e se o firewall liberou a porta 5001."* + detalhe técnico + botão "Tentar novamente".

---

## 6. Fluxo de UPLOAD (Local → Remoto)

1. Itens = seleção do painel local (ou escolha pelo diálogo nativo).
2. Destino = **pasta remota aberta**, fixada no início do lote (navegar durante a transferência não redireciona o restante).
3. Arquivo → `ft:upload(destino/nome, { filePath })` → `uploadFileFromPath` lê do disco via `fs.createReadStream` (`highWaterMark: 64KB`) e envia frames `BINARY`.
4. Pasta → `ft:uploadFolder(caminhoLocal, destino/nome)`:
   - `walkDir` percorre a árvore local devolvendo **segmentos** (array), nunca string com separador;
   - cria a hierarquia pai-filho no remoto (raiz primeiro, depois os níveis mais fundos, inclusive pastas vazias);
   - envia cada arquivo em streaming, com **progresso global por bytes**.
5. O stream é pausado quando `ws.bufferedAmount > 4MB` e retomado ao drenar. A leitura do disco só começa **após** o `put_res` (ack).

Resultado: `ok` (sem falhas), `partial` (algo passou, algo falhou) ou `err` (nada passou).

---

## 7. Fluxo de DOWNLOAD (Remoto → Local)

1. Itens = seleção do painel remoto. Destino = **pasta local aberta** (ou a escolhida no diálogo nativo).
2. Arquivo → `ft:download(origem, { saveDir, saveName, resume: true })`. A junção `saveDir + saveName` acontece **no main**, com `path.join`.
3. Pasta → `ft:downloadFolder(origem, destino, { folderName })`:
   - `listRemoteTree` caminha a árvore remota recursivamente devolvendo segmentos;
   - cria todos os diretórios relativos (inclusive vazios) antes dos arquivos;
   - grava cada arquivo direto no disco, sem reter em memória.
4. Proteção contra traversal: `resolveDestInsideRoot` valida cada segmento vindo do remoto e garante que nenhum destino escape da pasta escolhida.

Falhas ao listar uma subpasta não abortam a árvore: os irmãos continuam e o resultado vira `partial`.

---

## 8. Streaming e segurança de memória

| Camada | Controle |
|--------|----------|
| Cliente → upload | `createReadStream` 64KB; pausa acima de 4MB em `ws.bufferedAmount` |
| Proxy → WS→TCP | pausa o socket do WebSocket enquanto o TCP não drena |
| Proxy → TCP→WS | pausa a leitura do TCP acima de 4MB enfileirados no WS |
| Agente → download | `writeFrame` só resolve quando o kernel aceita os bytes (aguarda `drain`) |
| Agente → upload | abre o fd em `handlePut` e grava cada chunk assim que chega (`writeChain`); remove o parcial se o tamanho não bater |
| Cliente → download | grava incremental direto no arquivo (`downloadFile` com `filePath`) |

Nenhum arquivo é carregado inteiro em RAM em nenhum ponto da cadeia.

---

## 9. Resume de download (`.part` + offset)

- Com `resume: true`, o download grava em `<arquivo>.part`.
- Se interromper, o `.part` preserva os bytes já baixados.
- No próximo `ft:download`, `start = stat(.part).size` e o `get` vai com offset `o`.
- Ao terminar, o app renomeia `.part` → nome final.

---

## 10. Operações suportadas

| Ação | IPC | Método | UI |
|------|-----|--------|----|
| Listar local | `fs:listDir` | — | painel esquerdo |
| Listar remoto | `ft:list` | `listFiles` | painel direito |
| Metadados do agente | `ft:info` | `getInfo` | rodapé + atalhos remotos |
| Upload arquivo | `ft:upload` | `uploadFileFromPath` / `uploadFile` | botão Enviar |
| Upload pasta (recursivo) | `ft:uploadFolder` | `walkDir` + `createDirectory` | botão Enviar |
| Download arquivo | `ft:download` | `downloadFile` + `.part` | botão Receber |
| Download pasta (recursivo) | `ft:downloadFolder` | `listRemoteTree` | botão Receber |
| Deletar (remoto) | `ft:delete` | `deleteFile` | (IPC/API) |
| Criar pasta (remoto) | `ft:mkdir` | `createDirectory` | (IPC/API) |
| Raízes / atalhos / migalhas | `fs:getRoots`, `fs:getQuickAccess`, `fs:pathInfo`, `fs:joinPath` | — | painel esquerdo |

---

## 11. Pontos de extensão / limitações atuais

- [ ] **Rename / Move** — não há `ft:rename`/`ft:move`
- [ ] **Cópia** — não há `ft:copy`
- [ ] **Pausar / Cancelar** em trânsito — não implementado
- [ ] **Drag & drop** — painéis não aceitam drop
- [ ] **Preview de arquivo** — não implementado
- [ ] **Resume de upload** — só o download usa `.part` + offset
- [ ] **Resume de pasta** — somente arquivo único usa `.part`
- [ ] **Botões de Nova Pasta / Excluir na UI** — os IPC existem, faltam os controles

---

## 12. Arquivos relevantes

| Arquivo | Papel |
|---------|-------|
| `src/main/vpath.js` | Caminhos virtuais ↔ nativos, validação e migalhas |
| `src/main/file-transfer.js` | Cliente do protocolo (sessão, streaming, backpressure) |
| `src/main/file-server.js` | Servidor TCP do PC remoto (porta 5001) |
| `src/main/remote-file-server.js` | Agente autônomo (sem Electron) |
| `src/main/file-proxy.js` | Proxy WebSocket→TCP (porta 18901) com backpressure |
| `src/main/ipc-handlers.js` | Handlers IPC + caminhos locais + diálogos nativos |
| `src/main/preload.js` | API exposta ao renderer |
| `src/renderer/src/components/FileTransfer.jsx` | Container: conexão, sessão, transferências |
| `src/renderer/src/components/FilePanel.jsx` | Um lado do explorador (local ou remoto) |
| `src/renderer/src/components/BreadcrumbBar.jsx`, `FileToolbar.jsx`, `FileRow.jsx` | Navegação e linha da tabela |
| `src/renderer/src/lib/paths.js` | Caminhos virtuais + formatação (tamanho/data) no renderer |
| `src/renderer/src/lib/fileIcons.js` | Ícone/tipo por extensão |
