import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, HardDrive, UserPlus } from 'lucide-react';
import {
  DEFAULT_QUOTA_GB,
  deleteConfirmText,
  describeActionError,
  describeCapacity,
  describeReservation,
  formatGb,
  lastSessionText,
  studentStateLabel,
  studentStateTone,
  usageTone,
  usedPercent,
  validateStudentForm,
} from '../../shared/lib/lab';
import { inputClass } from './LabDialog';
import {
  ConfirmDialog,
  CredentialsDialog,
  ExtendDialog,
  QuotaDialog,
  ReserveDialog,
} from './LabDialogs';

const TONE_CLASSES = {
  success: 'border-success/50 text-success bg-success/10',
  warning: 'border-warning/50 text-warning bg-warning/10',
  danger: 'border-danger/50 text-danger bg-danger/10',
  accent: 'border-accent/50 text-accent bg-accent/10',
  faint: 'border-line text-text-faint bg-inset',
};
const BAR_CLASSES = { accent: 'bg-accent', warning: 'bg-warning', danger: 'bg-danger' };
const ACTIONABLE = new Set(['free', 'reserved', 'in-use']);
const REFRESH_MS = 10 * 1000;

function RowButton({ children, tone = 'neutral', ...props }) {
  const colors =
    tone === 'danger'
      ? 'border-danger/40 text-danger hover:bg-danger/10'
      : tone === 'primary'
        ? 'border-accent/60 text-accent hover:bg-accent/10'
        : 'border-line text-text-secondary hover:border-text-faint';
  return (
    <button
      {...props}
      className={`px-2.5 py-1 rounded-md text-[11px] border bg-transparent transition-colors whitespace-nowrap disabled:opacity-40 ${colors}`}
    >
      {children}
    </button>
  );
}

function Notice({ feedback }) {
  if (!feedback) return null;
  const isError = feedback.kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`rounded-lg border px-3 py-2 text-xs ${
        isError
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-line bg-inset text-text-secondary'
      }`}
    >
      {feedback.text}
    </div>
  );
}

function CapacityBox({ capacity, quota }) {
  const box = describeCapacity(capacity, quota);
  return (
    <div className={`rounded-lg border px-3 py-2 ${TONE_CLASSES[box.tone]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <HardDrive size={13} className="shrink-0" />
        <span>{box.title}</span>
      </div>
      {box.lines.map((line) => (
        <div key={line} className="text-[11px] opacity-80 mt-0.5">
          {line}
        </div>
      ))}
    </div>
  );
}

function UsageBar({ student }) {
  const percent = usedPercent(student);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div
        className="h-1.5 w-24 rounded-full bg-line overflow-hidden shrink-0"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Espaço usado por ${student.label}`}
      >
        <div
          className={`h-full ${BAR_CLASSES[usageTone(percent)]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-[11px] text-text-faint whitespace-nowrap">
        {formatGb(student.usedGb)} de {student.quotaGb} GB
      </span>
    </div>
  );
}

// Alunos de um PC de laboratório (GOALS 18): a lista com o espaço usado, a reserva em
// andamento, a caixa de capacidade do disco e as ações do professor — reservar, trocar
// aluno, estender, encerrar, ver a pasta, mudar a cota e apagar.
export default function HostStudents({ entry, onFolder, addLog }) {
  const { hostId } = entry;
  const reachable = ACTIONABLE.has(entry.state);
  const serviceReady = entry.service?.running === true;

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({ label: '', quotaGb: String(DEFAULT_QUOTA_GB) });
  const [formError, setFormError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI.getLabStudents(hostId);
      if (result?.ok) {
        setData(result);
        setError('');
      } else {
        setError(describeActionError(result));
      }
    } catch (err) {
      setError(err.message);
    }
  }, [hostId]);

  // Atualiza ao abrir, a cada 10 s e quando o estado do PC muda (um aluno entrou ou saiu).
  useEffect(() => {
    if (!reachable || !serviceReady) return undefined;
    const first = setTimeout(load, 0);
    const refresh = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(refresh);
      clearInterval(clock);
    };
  }, [load, reachable, serviceReady, entry.state]);

  const log = (text, type) => addLog?.(`Laboratório: ${entry.name}: ${text}`, type);

  const act = async (label, action, doneText) => {
    setBusy(label);
    setFeedback(null);
    try {
      const result = await action();
      if (result?.ok) {
        if (doneText) setFeedback({ kind: 'info', text: doneText });
        log(doneText || label);
      } else {
        setFeedback({ kind: 'error', text: describeActionError(result) });
        log(`${label}: ${result?.message || 'falhou'}`, 'warn');
      }
      await load();
      return result;
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message });
      return { ok: false, message: err.message };
    } finally {
      setBusy('');
    }
  };

  const handleAdd = async () => {
    const parsed = validateStudentForm(form);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setFormError('');
    const result = await act(
      `adicionando ${parsed.label}`,
      () =>
        window.electronAPI.addLabStudent({
          hostId,
          label: parsed.label,
          quotaGb: parsed.quotaGb,
        }),
      `${parsed.label} adicionado`,
    );
    if (result?.ok) setForm({ label: '', quotaGb: String(DEFAULT_QUOTA_GB) });
  };

  const openFolder = async (student) => {
    setBusy(`Abrindo a pasta de ${student.label}... (pastas grandes podem levar alguns minutos)`);
    setFeedback(null);
    try {
      const result = await window.electronAPI.openLabFolder({ hostId, account: student.account });
      if (!result?.ok) {
        setFeedback({ kind: 'error', text: describeActionError(result) });
        return;
      }
      log(`pasta de ${student.label} aberta (somente leitura)`);
      onFolder({
        sessionId: result.sessionId,
        title: `Pasta de ${result.label} em ${result.pcName} (somente leitura)`,
        label: result.label,
        pcName: result.pcName,
      });
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message });
    } finally {
      setBusy('');
    }
  };

  if (!reachable) {
    return (
      <div className="text-xs text-text-faint py-2">
        Este PC não está respondendo agora; a lista de alunos volta quando ele responder.
      </div>
    );
  }
  if (!serviceReady) {
    return (
      <div className="text-xs text-text-secondary py-2">
        O modo laboratório ainda não está habilitado neste PC. Na tela inicial dele, abra
        Configurações → Modo laboratório e use &quot;Habilitar neste PC&quot;; aí os alunos aparecem
        aqui.
      </div>
    );
  }

  const reservation = data?.reservation || null;
  const students = data?.students || [];
  const editing = busy !== '';

  const closeDialog = () => setDialog(null);
  const reserveSubmit = (student) => async (reservationForm) => {
    const fields = {
      hostId,
      account: student.account,
      startWithinMs: reservationForm.startWithinMs,
      sessionMs: reservationForm.sessionMs,
    };
    const handOver = Boolean(reservation) && reservation.account !== student.account;
    const result = await (handOver
      ? window.electronAPI.handOverLabPc(fields)
      : window.electronAPI.reserveLabPc(fields));
    if (result?.ok) {
      log(handOver ? `PC passado para ${student.label}` : `PC reservado para ${student.label}`);
      // A senha vai só para esta janela; ela some quando a janela fecha.
      setDialog({
        type: 'credentials',
        credentials: result.credentials,
        pc: result.pc,
        validityMin: reservationForm.validityMin,
      });
      load();
    } else {
      log(`reservar ${student.label}: ${result?.message || 'falhou'}`, 'warn');
      if (result?.step === 'reserve') load();
    }
    return result;
  };

  return (
    <div className="space-y-3 text-text-primary">
      {error && !data && <Notice feedback={{ kind: 'error', text: error }} />}
      {error && data && (
        <div className="text-[11px] text-warning" role="status">
          Não consegui atualizar agora ({error}). Mostrando a última lista.
        </div>
      )}
      {!data && !error && <div className="text-xs text-text-faint">Consultando alunos...</div>}

      {data && (
        <>
          {reservation && (
            <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-0 text-xs">
                <span className="font-medium">PC com {reservation.label}</span>
                <div className="text-[11px] text-text-secondary">
                  {describeReservation(reservation, now)}
                </div>
              </div>
              <RowButton
                disabled={editing || reservation.state === 'ending'}
                onClick={() => setDialog({ type: 'extend', reservation })}
              >
                Estender
              </RowButton>
              <RowButton
                tone="danger"
                disabled={editing || reservation.state === 'ending'}
                onClick={() => setDialog({ type: 'end', reservation })}
              >
                Encerrar agora
              </RowButton>
            </div>
          )}

          <CapacityBox capacity={data.capacity} quota={data.quota} />

          {students.length === 0 ? (
            <div className="text-xs text-text-faint">
              Nenhum aluno neste PC. Adicione o primeiro abaixo.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {students.map((student) => {
                const isCurrent = reservation?.account === student.account;
                return (
                  <li
                    key={student.account}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-lg border border-line-subtle bg-surface"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="text-sm font-medium truncate">{student.label}</div>
                      <div className="text-[11px] text-text-faint truncate">
                        {student.account} · último uso:{' '}
                        {lastSessionText(student.lastSessionEnd, now)}
                      </div>
                    </div>
                    <UsageBar student={student} />
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${TONE_CLASSES[studentStateTone(student.state)]}`}
                    >
                      {studentStateLabel(student.state)}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isCurrent ? null : reservation ? (
                        <RowButton
                          tone="primary"
                          disabled={editing}
                          onClick={() =>
                            setDialog({ type: 'reserve', student, handOverFrom: reservation })
                          }
                        >
                          Trocar aluno
                        </RowButton>
                      ) : (
                        <RowButton
                          tone="primary"
                          disabled={editing}
                          onClick={() => setDialog({ type: 'reserve', student })}
                        >
                          Reservar
                        </RowButton>
                      )}
                      <RowButton disabled={editing} onClick={() => openFolder(student)}>
                        <span className="inline-flex items-center gap-1">
                          <FolderOpen size={12} /> Ver pasta
                        </span>
                      </RowButton>
                      <RowButton
                        disabled={editing}
                        onClick={() => setDialog({ type: 'quota', student })}
                      >
                        Cota
                      </RowButton>
                      <RowButton
                        tone="danger"
                        disabled={editing || isCurrent}
                        title={isCurrent ? 'Encerre a reserva antes de apagar' : 'Apagar aluno'}
                        onClick={() => setDialog({ type: 'delete', student })}
                      >
                        Apagar
                      </RowButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="rounded-lg border border-line-subtle bg-inset px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-2">
              <UserPlus size={13} /> Adicionar aluno
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex-1 basis-40 min-w-0">
                <span className="block text-[11px] text-text-faint mb-1">Nome do aluno</span>
                <input
                  type="text"
                  value={form.label}
                  maxLength={40}
                  onChange={(e) => {
                    setForm({ ...form, label: e.target.value });
                    setFormError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd();
                  }}
                  disabled={editing}
                  className={inputClass}
                />
              </label>
              <label>
                <span className="block text-[11px] text-text-faint mb-1">Cota (GB)</span>
                <input
                  type="number"
                  min="1"
                  max="2000"
                  value={form.quotaGb}
                  onChange={(e) => {
                    setForm({ ...form, quotaGb: e.target.value });
                    setFormError('');
                  }}
                  disabled={editing}
                  className={`${inputClass} w-24`}
                />
              </label>
              <button
                onClick={handleAdd}
                disabled={editing}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-accent-strong text-white transition-colors whitespace-nowrap disabled:opacity-50"
              >
                Adicionar aluno
              </button>
            </div>
            {formError && (
              <div role="alert" className="text-xs text-danger mt-2">
                {formError}
              </div>
            )}
          </div>
        </>
      )}

      {busy && (
        <div role="status" className="text-xs text-text-secondary">
          {busy}
        </div>
      )}
      <Notice feedback={feedback} />

      {dialog?.type === 'reserve' && (
        <ReserveDialog
          student={dialog.student}
          handOverFrom={dialog.handOverFrom}
          onSubmit={reserveSubmit(dialog.student)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'credentials' && (
        <CredentialsDialog
          credentials={dialog.credentials}
          pc={dialog.pc}
          validityMin={dialog.validityMin}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'extend' && (
        <ExtendDialog
          reservation={dialog.reservation}
          onSubmit={async (addMs) => {
            const result = await window.electronAPI.extendLabReservation({
              hostId,
              reservationId: dialog.reservation.id,
              addMs,
            });
            if (result?.ok) {
              log(`sessão de ${dialog.reservation.label} estendida`);
              setDialog(null);
              load();
            }
            return result;
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'end' && (
        <ConfirmDialog
          title="Encerrar agora"
          text={`A sessão de ${dialog.reservation.label} será encerrada agora: o aluno recebe um aviso e é desconectado. Os arquivos continuam na pasta pessoal.`}
          confirmLabel="Encerrar agora"
          danger
          onConfirm={async () => {
            const result = await window.electronAPI.endLabReservation({
              hostId,
              reservationId: dialog.reservation.id,
            });
            if (result?.ok) {
              log(`sessão de ${dialog.reservation.label} encerrada`);
              setDialog(null);
              load();
            }
            return result;
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'quota' && (
        <QuotaDialog
          student={dialog.student}
          onSubmit={async (quotaGb) => {
            const result = await window.electronAPI.setLabStudentQuota({
              hostId,
              account: dialog.student.account,
              quotaGb,
            });
            if (result?.ok) {
              log(`cota de ${dialog.student.label}: ${quotaGb} GB`);
              setDialog(null);
              load();
            }
            return result;
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Apagar aluno"
          text={`${deleteConfirmText(dialog.student)} A conta, a pasta pessoal e a cota serão removidas. Isso não pode ser desfeito.`}
          confirmLabel="Apagar"
          danger
          onConfirm={async () => {
            const result = await window.electronAPI.deleteLabStudent({
              hostId,
              account: dialog.student.account,
            });
            if (result?.ok) {
              log(`${dialog.student.label} apagado`);
              setDialog(null);
              load();
            }
            return result;
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
