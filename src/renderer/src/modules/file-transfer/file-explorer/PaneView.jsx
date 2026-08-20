import { useRef, useMemo, useState } from 'react';
import { ToolbarButton, CommandButton, Breadcrumb, NavSidebar } from './Toolbar';
import { EntryList } from './EntryList';
import { sortAndFilter } from './utils';

export function RemotePlaceholder({ activeMachine }) {
  return (
    <div className="flex flex-col h-full min-w-0 bg-white items-center justify-center gap-3 p-6">
      <div className="text-[15px] font-medium text-[#1b1b1b] text-center">
        {activeMachine ? `Preparando acesso a ${activeMachine.name}…` : 'Nenhum PC conectado'}
      </div>
      <div className="text-[12px] text-[#605e5c] text-center max-w-xs">
        {activeMachine
          ? 'A sessão de arquivos acompanha a conexão atual.'
          : 'Conecte-se a um PC pela barra lateral ou na tela inicial — os arquivos ficam disponíveis automaticamente.'}
      </div>
    </div>
  );
}

export function PaneView({ label, pane, connectionBadge, onDisconnect, leftmost, dnd }) {
  const lastIndexRef = useRef(-1);
  const [paneDragOver, setPaneDragOver] = useState(false);

  const visibleEntries = useMemo(
    () =>
      sortAndFilter(pane.entries, {
        query: pane.query,
        sortBy: pane.sortBy,
        sortDir: pane.sortDir,
      }),
    [pane.entries, pane.query, pane.sortBy, pane.sortDir],
  );

  const onSelect = (entry, index, e) => {
    pane.setSelected((prev) => {
      if (e.shiftKey && lastIndexRef.current >= 0) {
        const [from, to] = [lastIndexRef.current, index].sort((a, b) => a - b);
        return new Set(visibleEntries.slice(from, to + 1).map((x) => x.name));
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(entry.name)) next.delete(entry.name);
        else next.add(entry.name);
        return next;
      }
      return new Set([entry.name]);
    });
    if (!e.shiftKey) lastIndexRef.current = index;
  };

  const onOpen = (entry) => {
    if (entry.dir) pane.load(entry.path);
  };

  const handleNewFolder = async () => {
    // mkdir(..., {recursive:true}) no backend não falha se a pasta já
    // existir — por isso a checagem de colisão é feita aqui contra os
    // nomes já listados, e não tentando criar e reagindo ao erro.
    const existingNames = new Set(pane.entries.map((e) => e.name));
    const base = 'Nova pasta';
    let name = base;
    for (let i = 2; existingNames.has(name); i++) name = `${base} (${i})`;

    try {
      await pane.adapter.mkdir(pane.adapter.join(pane.path, name));
    } catch (err) {
      window.alert(`Falha ao criar pasta: ${err.message}`);
      return;
    }
    await pane.refresh();
    pane.setSelected(new Set([name]));
    pane.setRenamingName(name);
  };

  const handleDelete = async () => {
    if (pane.selected.size === 0) return;
    if (
      !window.confirm(
        `Excluir ${pane.selected.size} item(ns) selecionado(s)? Essa ação não pode ser desfeita.`,
      )
    )
      return;
    for (const name of pane.selected) {
      const entry = pane.entries.find((e) => e.name === name);
      if (!entry) continue;
      try {
        await pane.adapter.remove(entry.path);
      } catch (err) {
        window.alert(`Falha ao excluir "${name}": ${err.message}`);
      }
    }
    await pane.refresh();
  };

  const handleRenameStart = () => {
    if (pane.selected.size !== 1) return;
    pane.setRenamingName([...pane.selected][0]);
  };

  const handleRenameCommit = async (entry, newName) => {
    pane.setRenamingName(null);
    try {
      await pane.adapter.rename(entry.path, pane.adapter.join(pane.path, newName));
      await pane.refresh();
    } catch (err) {
      window.alert(`Falha ao renomear: ${err.message}`);
    }
  };

  const selectedCount = pane.selected.size;

  return (
    <div className="flex flex-col h-full min-w-0 bg-white">
      {/* Cabeçalho da janela — paddingLeft extra no painel da esquerda pra não
          ficar embaixo do hambúrguer fixo (barra lateral recolhida). */}
      <div
        className="flex items-center justify-between h-8 px-3 bg-[#f3f3f3] border-b border-[#e5e5e5] text-[12px] font-medium text-[#1b1b1b]"
        style={leftmost ? { paddingLeft: '44px' } : undefined}
      >
        <span className="truncate">{label}</span>
        {connectionBadge && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex items-center gap-1 text-[11px] text-[#107c10]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#107c10]" /> Conectado
            </span>
            <button onClick={onDisconnect} className="text-[11px] text-[#a80000] hover:underline">
              Desconectar
            </button>
          </div>
        )}
      </div>

      {/* Barra de navegação */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#e5e5e5]">
        <ToolbarButton onClick={pane.goBack} disabled={!pane.canBack} title="Voltar">
          ←
        </ToolbarButton>
        <ToolbarButton onClick={pane.goForward} disabled={!pane.canForward} title="Avançar">
          →
        </ToolbarButton>
        <ToolbarButton onClick={pane.refresh} title="Atualizar">
          ↻
        </ToolbarButton>
        <ToolbarButton onClick={pane.goHome} title="Início">
          🏠
        </ToolbarButton>
        <Breadcrumb path={pane.path} adapter={pane.adapter} onNavigate={pane.load} />
        <input
          value={pane.query}
          onChange={(e) => pane.setQuery(e.target.value)}
          placeholder="Pesquisar"
          className="w-36 h-7 px-2 text-[13px] border border-[#e0e0e0] rounded bg-white text-[#1b1b1b] outline-none focus:border-[#0067c0]"
        />
      </div>

      {/* Barra de comandos */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-[#e5e5e5]">
        <CommandButton onClick={handleNewFolder} title="Nova pasta">
          📁 Novo
        </CommandButton>
        <span className="w-px h-4 bg-[#e0e0e0] mx-1" />
        <CommandButton disabled title="Recortar (em breve)">
          ✂️ Recortar
        </CommandButton>
        <CommandButton disabled title="Copiar (em breve)">
          📋 Copiar
        </CommandButton>
        <CommandButton disabled title="Colar (em breve)">
          📥 Colar
        </CommandButton>
        <span className="w-px h-4 bg-[#e0e0e0] mx-1" />
        <CommandButton onClick={handleRenameStart} disabled={selectedCount !== 1} title="Renomear">
          ✏️ Renomear
        </CommandButton>
        <CommandButton onClick={handleDelete} disabled={selectedCount === 0} title="Excluir">
          🗑️ Excluir
        </CommandButton>
        <div className="flex-1" />
        <ToolbarButton
          onClick={() => pane.setView(pane.view === 'list' ? 'icons' : 'list')}
          title={pane.view === 'list' ? 'Ícones grandes' : 'Lista'}
        >
          {pane.view === 'list' ? '▦' : '☰'}
        </ToolbarButton>
      </div>

      <div className="flex flex-1 min-h-0">
        <NavSidebar pane={pane} onNavigate={pane.load} />
        <div
          className={`flex-1 min-w-0 flex flex-col relative ${paneDragOver ? 'after:absolute after:inset-0 after:pointer-events-none after:ring-2 after:ring-inset after:ring-[#0067c0] after:bg-[#0067c0]/5' : ''}`}
          onDragOver={(e) => {
            if (!dnd) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = dnd.effectFor(e);
            setPaneDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setPaneDragOver(false);
          }}
          onDrop={(e) => {
            if (!dnd) return;
            e.preventDefault();
            setPaneDragOver(false);
            dnd.onDropOnCurrentDir(e);
          }}
        >
          {pane.loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-[13px] text-[#605e5c] z-20">
              Carregando…
            </div>
          )}
          {pane.error ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="text-center max-w-xs">
                <div className="text-[13px] text-[#a80000] mb-2">{pane.error}</div>
                <button
                  onClick={pane.refresh}
                  className="text-[12px] px-2 py-1 rounded border border-[#e0e0e0] hover:bg-[#f0f0f0]"
                >
                  Tentar novamente
                </button>
              </div>
            </div>
          ) : (
            <EntryList
              pane={pane}
              visibleEntries={visibleEntries}
              onOpen={onOpen}
              onSelect={onSelect}
              onRenameCommit={handleRenameCommit}
              dnd={dnd}
            />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between h-6 px-3 bg-[#f3f3f3] border-t border-[#e5e5e5] text-[11px] text-[#605e5c]">
        <span>{visibleEntries.length} iten(s)</span>
        {selectedCount > 0 && <span>{selectedCount} selecionado(s)</span>}
      </div>
    </div>
  );
}
