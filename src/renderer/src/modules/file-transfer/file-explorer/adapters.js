import { joinNative, joinVirtual } from './utils';

// ---------------------------------------------------------------------------
// Adapters — mesma interface para o painel local (fs direto) e remoto (túnel)
// ---------------------------------------------------------------------------

export const localAdapter = {
  side: 'local',
  join: joinNative,
  async listRoots() {
    return window.electronAPI.fsListRoots();
  },
  async listDir(dirPath) {
    const r = await window.electronAPI.fsListDir(dirPath);
    return r.entries;
  },
  async parent(dirPath) {
    const r = await window.electronAPI.fsParent(dirPath);
    return r.parent;
  },
  async mkdir(dirPath) {
    const r = await window.electronAPI.fsMkdir(dirPath);
    if (!r.success) throw new Error(r.message || 'Falha ao criar pasta');
  },
  async remove(itemPath) {
    const r = await window.electronAPI.fsDelete(itemPath);
    if (!r.success) throw new Error(r.message || 'Falha ao excluir');
  },
  async rename(oldPath, newPath) {
    const r = await window.electronAPI.fsRename(oldPath, newPath);
    if (!r.success) throw new Error(r.message || 'Falha ao renomear');
  },
};

export function makeRemoteAdapter(sessionId) {
  return {
    side: 'remote',
    join: joinVirtual,
    async listRoots() {
      // Só existe uma raiz no agente ('/'), então basta o atalho de Início —
      // repetir em "Este computador" seria redundante.
      return { roots: [], quickAccess: [{ name: 'Início', path: '/' }] };
    },
    async listDir(virtualPath) {
      const r = await window.electronAPI.ftList(sessionId, virtualPath);
      return r.entries.map((e) => ({
        ...e,
        path: joinVirtual(virtualPath, e.name),
      }));
    },
    async parent(virtualPath) {
      if (!virtualPath || virtualPath === '/') return null;
      const parts = virtualPath.split('/').filter(Boolean);
      parts.pop();
      return parts.length ? `/${parts.join('/')}` : '/';
    },
    async mkdir(virtualPath) {
      await window.electronAPI.ftMkdir(sessionId, virtualPath);
    },
    async remove(virtualPath) {
      await window.electronAPI.ftDelete(sessionId, virtualPath);
    },
    async rename(oldPath, newPath) {
      await window.electronAPI.ftRename(sessionId, oldPath, newPath);
    },
  };
}
