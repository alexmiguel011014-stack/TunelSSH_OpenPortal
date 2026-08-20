import { useEffect, useRef } from 'react';
import { formatBytes, formatElapsed } from './utils';

// Divisor arrastavel entre os dois paineis - clientX vira % da largura do
// container pai, clampado para nenhum lado ficar menor que 20%.
export function Splitter({ containerRef, setWidthPct }) {
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (e) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setWidthPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, setWidthPct]);

  return (
    <div
      onMouseDown={() => {
        draggingRef.current = true;
      }}
      title="Arraste para redimensionar"
      className="w-1.5 shrink-0 cursor-col-resize bg-[#e5e5e5] hover:bg-[#0067c0] active:bg-[#0067c0] transition-colors"
    />
  );
}

export function TransferRail({
  onSend,
  onReceive,
  sendDisabled,
  receiveDisabled,
  sendCount,
  receiveCount,
}) {
  return (
    <div className="w-16 shrink-0 flex flex-col items-center justify-center gap-3 bg-[#f3f3f3] border-x border-[#e5e5e5]">
      <button
        onClick={onSend}
        disabled={sendDisabled}
        title="Enviar para o PC remoto"
        className="flex flex-col items-center gap-1 px-1.5 py-2 rounded hover:bg-[#e8e8e8] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <span className="text-[18px]">➜</span>
        <span className="text-[10px] text-[#1b1b1b] text-center leading-tight">
          Enviar{sendCount ? ` (${sendCount})` : ''}
        </span>
      </button>
      <button
        onClick={onReceive}
        disabled={receiveDisabled}
        title="Receber do PC remoto"
        className="flex flex-col items-center gap-1 px-1.5 py-2 rounded hover:bg-[#e8e8e8] disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <span className="text-[18px]">⟸</span>
        <span className="text-[10px] text-[#1b1b1b] text-center leading-tight">
          Receber{receiveCount ? ` (${receiveCount})` : ''}
        </span>
      </button>
    </div>
  );
}

export function StatusBar({ batch }) {
  if (!batch) return null;
  const pct =
    batch.batchTotal > 0
      ? Math.min(100, Math.round((batch.batchSent / batch.batchTotal) * 100))
      : batch.done
        ? 100
        : 0;
  const filePct =
    batch.fileSize > 0 ? Math.min(100, Math.round((batch.fileSent / batch.fileSize) * 100)) : 0;
  const phaseLabel = batch.phase === 'upload' ? 'Enviando' : 'Recebendo';

  return (
    <div className="border-t border-[#e5e5e5] bg-[#f9f9f9] px-4 py-2 text-[12px] text-[#1b1b1b]">
      <div className="flex items-center justify-between mb-1">
        <span className={`truncate ${batch.error && !batch.ok ? 'text-[#a80000]' : ''}`}>
          {batch.done
            ? batch.error && !batch.ok
              ? `${phaseLabel} falhou: ${batch.error}`
              : `${phaseLabel} concluído — ${batch.ok || 0} ok${batch.failed ? `, ${batch.failed} falha(s)` : ''}`
            : `${phaseLabel}: ${batch.fileName || ''} (${filePct}%)`}
        </span>
        <span className="shrink-0 text-[#605e5c]">
          {formatBytes(batch.speedBps)}/s · {formatElapsed(batch.elapsedMs)}
        </span>
      </div>
      <div className="h-1.5 rounded bg-[#e0e0e0] overflow-hidden">
        <div className="h-full bg-[#0067c0] transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between mt-0.5 text-[11px] text-[#605e5c]">
        <span>
          {formatBytes(batch.batchSent)} / {formatBytes(batch.batchTotal)}
        </span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}
