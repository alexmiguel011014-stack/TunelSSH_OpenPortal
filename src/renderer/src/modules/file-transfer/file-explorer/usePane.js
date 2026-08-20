import { useState, useEffect, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Estado de um painel (local ou remoto)
// ---------------------------------------------------------------------------

export function usePane(adapter, initialPath) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [view, setView] = useState('list');
  const [query, setQuery] = useState('');
  const [roots, setRoots] = useState([]);
  const [quickAccess, setQuickAccess] = useState([]);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [renamingName, setRenamingName] = useState(null);

  const historyRef = useRef([]);
  const historyIdxRef = useRef(-1);
  const reqIdRef = useRef(0);

  const updateHistoryFlags = () => {
    setCanBack(historyIdxRef.current > 0);
    setCanForward(historyIdxRef.current < historyRef.current.length - 1);
  };

  const load = useCallback(
    async (targetPath, { pushHistory = true } = {}) => {
      if (!adapter || !targetPath) return;
      const myReq = ++reqIdRef.current;
      setLoading(true);
      setError('');
      try {
        const nextEntries = await adapter.listDir(targetPath);
        if (myReq !== reqIdRef.current) return;
        setEntries(nextEntries);
        setPath(targetPath);
        setSelected(new Set());
        if (pushHistory) {
          const trimmed = historyRef.current.slice(0, historyIdxRef.current + 1);
          trimmed.push(targetPath);
          historyRef.current = trimmed;
          historyIdxRef.current = trimmed.length - 1;
          updateHistoryFlags();
        }
      } catch (err) {
        if (myReq !== reqIdRef.current) return;
        setError(err.message || String(err));
        setEntries([]);
      } finally {
        if (myReq === reqIdRef.current) setLoading(false);
      }
    },
    [adapter],
  );

  useEffect(() => {
    if (!adapter) {
      setEntries([]);
      setPath(initialPath);
      setRoots([]);
      setQuickAccess([]);
      historyRef.current = [];
      historyIdxRef.current = -1;
      return;
    }
    let cancelled = false;
    historyRef.current = [];
    historyIdxRef.current = -1;
    (async () => {
      try {
        const r = await adapter.listRoots();
        if (cancelled) return;
        setRoots(r.roots || []);
        setQuickAccess(r.quickAccess || []);
        const start =
          initialPath ||
          (r.quickAccess && r.quickAccess[0] && r.quickAccess[0].path) ||
          (r.roots && r.roots[0] && r.roots[0].path);
        if (start) load(start, { pushHistory: true });
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const goBack = () => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    updateHistoryFlags();
    load(historyRef.current[historyIdxRef.current], { pushHistory: false });
  };

  const goForward = () => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    updateHistoryFlags();
    load(historyRef.current[historyIdxRef.current], { pushHistory: false });
  };

  const goUp = async () => {
    if (!adapter) return;
    const parent = await adapter.parent(path);
    if (parent) load(parent);
  };

  const goHome = () => {
    const home = (quickAccess[0] && quickAccess[0].path) || (roots[0] && roots[0].path);
    if (home) load(home);
  };

  const refresh = () => load(path, { pushHistory: false });

  return {
    adapter,
    path,
    entries,
    loading,
    error,
    selected,
    setSelected,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    view,
    setView,
    query,
    setQuery,
    roots,
    quickAccess,
    canBack,
    canForward,
    load,
    goBack,
    goForward,
    goUp,
    goHome,
    refresh,
    renamingName,
    setRenamingName,
  };
}
