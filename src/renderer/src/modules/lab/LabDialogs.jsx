import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  DEFAULT_QUOTA_GB,
  DEFAULT_START_WITHIN_MIN,
  DEFAULT_VALIDITY_MIN,
  EXTEND_CHOICES,
  MAX_QUOTA_GB,
  VALIDITY_CHOICES,
  buildCredentialMessage,
  formatMinutes,
  loadNotice,
  minutesToMs,
  saveNotice,
  validateReservationForm,
  validateStudentForm,
} from '../../shared/lib/lab';
import {
  DangerButton,
  ErrorLine,
  Field,
  GhostButton,
  Modal,
  PrimaryButton,
  inputClass,
  useDialogAction,
} from './LabDialog';

function ChoiceButton({ active, onClick, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-50 ${
        active
          ? 'border-accent text-accent bg-accent/10'
          : 'border-line text-text-muted hover:border-text-faint'
      }`}
    >
      {children}
    </button>
  );
}

// Reservar o PC para um aluno, ou "Trocar aluno" (encerra quem está e reserva para o
// próximo). O professor escolhe a duração da sessão e o prazo para o aluno entrar.
export function ReserveDialog({ student, handOverFrom, onSubmit, onClose }) {
  const [choice, setChoice] = useState(DEFAULT_VALIDITY_MIN); // minutos, ou 'custom'
  const [custom, setCustom] = useState('90');
  const [startWithin, setStartWithin] = useState(String(DEFAULT_START_WITHIN_MIN));
  const { working, error, setError, run } = useDialogAction();

  const submit = () => {
    const validityMin = choice === 'custom' ? custom : choice;
    const form = validateReservationForm({ validityMin, startWithinMin: startWithin });
    if (!form.ok) {
      setError(form.error);
      return;
    }
    run(() => onSubmit(form));
  };

  return (
    <Modal
      title={
        handOverFrom ? `Trocar aluno: ${student.label}` : `Reservar o PC para ${student.label}`
      }
      onClose={onClose}
      busy={working}
    >
      {handOverFrom && (
        <p className="text-xs text-text-secondary mb-3">
          A sessão de {handOverFrom.label} será encerrada agora: o aluno recebe um aviso e é
          desconectado. Depois o PC fica reservado para {student.label}, com uma senha nova.
        </p>
      )}
      <Field label="Duração da sessão">
        <div className="flex flex-wrap gap-2">
          {VALIDITY_CHOICES.map((minutes) => (
            <ChoiceButton
              key={minutes}
              active={choice === minutes}
              disabled={working}
              onClick={() => setChoice(minutes)}
            >
              {formatMinutes(minutes)}
            </ChoiceButton>
          ))}
          <ChoiceButton
            active={choice === 'custom'}
            disabled={working}
            onClick={() => setChoice('custom')}
          >
            Outro valor
          </ChoiceButton>
        </div>
        {choice === 'custom' && (
          <div className="flex items-center gap-2 mt-2">
            <input
              type="number"
              min="5"
              max="720"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              disabled={working}
              aria-label="Duração em minutos"
              className={`${inputClass} w-28`}
            />
            <span className="text-xs text-text-faint">minutos (5 a 720)</span>
          </div>
        )}
      </Field>
      <Field
        label="Prazo para o aluno entrar (minutos)"
        hint="A sessão só começa a contar quando o aluno entrar. Se ninguém entrar a tempo, a reserva termina."
      >
        <input
          type="number"
          min="1"
          max="1440"
          value={startWithin}
          onChange={(e) => setStartWithin(e.target.value)}
          disabled={working}
          className={`${inputClass} w-28`}
        />
      </Field>
      <ErrorLine text={error} />
      {working && (
        <p className="text-xs text-text-faint mb-3" role="status">
          {handOverFrom
            ? `Encerrando a sessão de ${handOverFrom.label}... isso pode levar cerca de um minuto.`
            : 'Reservando...'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <GhostButton onClick={onClose} disabled={working}>
          Cancelar
        </GhostButton>
        <PrimaryButton onClick={submit} disabled={working}>
          {handOverFrom ? 'Trocar aluno' : 'Reservar'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// Copia texto para a área de transferência (com plano B para o ambiente sem a API).
async function copyText(text, fallbackElement) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallbackElement) return false;
    fallbackElement.select();
    return document.execCommand('copy');
  }
}

// A senha do aluno aparece aqui uma única vez: fica só na memória desta janela e some
// quando ela fecha. O aviso do professor ao aluno é editável e fica salvo neste PC (é só
// o texto, nunca a senha).
export function CredentialsDialog({ credentials, pc, validityMin, onClose }) {
  const [notice, setNotice] = useState(() => loadNotice(window.localStorage));
  const [copied, setCopied] = useState(false);
  const [areaRef, setAreaRef] = useState(null);

  const message = useMemo(
    () =>
      buildCredentialMessage({
        pcName: pc.name,
        host: pc.host,
        userName: credentials.userName,
        password: credentials.password,
        startBy: credentials.startBy,
        endsAt: credentials.endsAt,
        sessionMinutes: validityMin,
        notice,
      }),
    [pc, credentials, validityMin, notice],
  );

  const handleCopy = async () => {
    const done = await copyText(message, areaRef);
    setCopied(done);
  };

  return (
    <Modal title="Acesso do aluno" onClose={onClose} locked wide>
      <p className="text-xs text-text-secondary mb-3">
        A senha aparece só agora e não fica guardada em lugar nenhum. Copie e entregue ao aluno
        antes de fechar esta janela.
      </p>
      <textarea
        ref={setAreaRef}
        readOnly
        value={message}
        rows={9}
        aria-label="Mensagem de acesso"
        onFocus={(e) => e.target.select()}
        className={`${inputClass} font-mono text-xs leading-relaxed resize-none mb-3`}
      />
      <Field label="Aviso ao aluno (editável)">
        <textarea
          value={notice}
          onChange={(e) => {
            setNotice(e.target.value);
            saveNotice(window.localStorage, e.target.value);
            setCopied(false);
          }}
          rows={2}
          className={`${inputClass} text-xs resize-none`}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <GhostButton onClick={handleCopy}>
          <span className="inline-flex items-center gap-1.5">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copiado' : 'Copiar mensagem'}
          </span>
        </GhostButton>
        <PrimaryButton onClick={onClose}>Fechar</PrimaryButton>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger = false, onConfirm, onClose }) {
  const { working, error, run } = useDialogAction();
  const Confirm = danger ? DangerButton : PrimaryButton;
  return (
    <Modal title={title} onClose={onClose} busy={working}>
      <p className="text-sm text-text-secondary mb-4">{text}</p>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <GhostButton onClick={onClose} disabled={working}>
          Cancelar
        </GhostButton>
        <Confirm onClick={() => run(onConfirm)} disabled={working}>
          {working ? 'Aguarde...' : confirmLabel}
        </Confirm>
      </div>
    </Modal>
  );
}

export function QuotaDialog({ student, onSubmit, onClose }) {
  const [quota, setQuota] = useState(String(student.quotaGb || DEFAULT_QUOTA_GB));
  const { working, error, setError, run } = useDialogAction();

  const submit = () => {
    const form = validateStudentForm({ label: student.label, quotaGb: quota });
    if (!form.ok) {
      setError(form.error);
      return;
    }
    run(() => onSubmit(form.quotaGb));
  };

  return (
    <Modal title={`Cota de ${student.label}`} onClose={onClose} busy={working}>
      <Field
        label="Limite de disco (GB)"
        hint="Quando o aluno chega no limite, o Windows recusa gravar mais arquivos."
      >
        <input
          type="number"
          min="1"
          max={MAX_QUOTA_GB}
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={working}
          className={`${inputClass} w-32`}
        />
      </Field>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <GhostButton onClick={onClose} disabled={working}>
          Cancelar
        </GhostButton>
        <PrimaryButton onClick={submit} disabled={working}>
          {working ? 'Salvando...' : 'Salvar cota'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

export function ExtendDialog({ reservation, onSubmit, onClose }) {
  const [custom, setCustom] = useState('');
  const { working, error, setError, run } = useDialogAction();

  const extendBy = (minutes) => run(() => onSubmit(minutesToMs(minutes)));
  const submitCustom = () => {
    const minutes = Number(custom);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
      setError('Informe de 1 a 720 minutos');
      return;
    }
    extendBy(minutes);
  };

  return (
    <Modal title={`Estender a sessão de ${reservation.label}`} onClose={onClose} busy={working}>
      <Field label="Estender por">
        <div className="flex flex-wrap gap-2">
          {EXTEND_CHOICES.map((minutes) => (
            <ChoiceButton key={minutes} disabled={working} onClick={() => extendBy(minutes)}>
              +{formatMinutes(minutes)}
            </ChoiceButton>
          ))}
        </div>
      </Field>
      <Field label="Outro valor (minutos)">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="720"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={working}
            className={`${inputClass} w-28`}
          />
          <GhostButton onClick={submitCustom} disabled={working || !custom}>
            Estender
          </GhostButton>
        </div>
      </Field>
      <ErrorLine text={error} />
      <div className="flex justify-end">
        <GhostButton onClick={onClose} disabled={working}>
          Fechar
        </GhostButton>
      </div>
    </Modal>
  );
}
