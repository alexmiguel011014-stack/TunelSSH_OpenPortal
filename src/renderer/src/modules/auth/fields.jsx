import { useCallback, useEffect, useRef, useState } from 'react';
import { inputClass } from '../lab/LabDialog';
import { isCapsLockOn } from '../../shared/lib/accounts';

// Peças dos formulários de conta: campo com rótulo, erro e dica ligados por id (leitor de tela),
// senha com "Mostrar", escolha de papel e a mensagem de erro/aviso.

export function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  error,
  hint,
  trailing,
  mono = false,
  ...inputProps
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="block text-[11px] text-text-faint mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} ${mono ? 'font-mono' : ''} ${trailing ? 'pr-20' : ''} ${
            error ? 'border-danger' : ''
          }`}
          {...inputProps}
        />
        {trailing}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[11px] text-danger mt-1">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[11px] text-text-faint mt-1">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField({ id, label, value, onChange, error, hint, autoComplete, ...rest }) {
  const [shown, setShown] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  return (
    <TextField
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      type={shown ? 'text' : 'password'}
      error={error}
      hint={capsLock ? 'Caps Lock está ligado.' : hint}
      autoComplete={autoComplete}
      spellCheck={false}
      autoCapitalize="none"
      onKeyUp={(event) => setCapsLock(isCapsLockOn(event))}
      onBlur={() => setCapsLock(false)}
      trailing={
        <button
          type="button"
          onClick={() => setShown((current) => !current)}
          aria-pressed={shown}
          aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-1 rounded text-[11px] text-text-muted hover:text-text-primary bg-transparent border-none"
        >
          {shown ? 'Ocultar' : 'Mostrar'}
        </button>
      }
      {...rest}
    />
  );
}

const ROLES = [
  { value: 'aluno', title: 'Aluno', text: 'Recebe o acesso aos PCs do laboratório' },
  { value: 'professor', title: 'Professor', text: 'Gerencia os PCs e os alunos' },
];

export function RoleChooser({ value, onChange, error }) {
  return (
    <fieldset className="mb-3">
      <legend className="text-[11px] text-text-faint mb-1">Eu sou</legend>
      <div className="grid grid-cols-2 gap-2">
        {ROLES.map((role) => {
          const checked = value === role.value;
          return (
            <label
              key={role.value}
              className={`cursor-pointer rounded-lg border px-3 py-2 transition-colors focus-within:ring-2 focus-within:ring-accent ${
                checked
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-line text-text-secondary hover:border-text-faint'
              }`}
            >
              <input
                type="radio"
                name="role"
                value={role.value}
                checked={checked}
                onChange={() => onChange(role.value)}
                className="sr-only"
              />
              <span className="block text-sm font-medium">{role.title}</span>
              <span className="block text-[11px] text-text-faint mt-0.5">{role.text}</span>
            </label>
          );
        })}
      </div>
      {value === 'professor' && (
        <p className="text-[11px] text-text-muted mt-2">
          Professores precisam da aprovação de outro professor. Até lá você usa o app como aluno.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-danger mt-1">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function Notice({ tone = 'info', children }) {
  if (!children) return null;
  const classes =
    tone === 'error'
      ? 'border-danger/40 bg-danger/10 text-danger'
      : tone === 'warning'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-line bg-inset text-text-secondary';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-3 rounded-lg border px-3 py-2 text-xs ${classes}`}
    >
      {children}
    </div>
  );
}

// Roda um pedido ao processo principal: bloqueia o botão enquanto espera e guarda a mensagem de
// erro para mostrar no formulário. Devolve o resultado para quem chamou decidir o resto.
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(async (action) => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (mounted.current && !result?.ok) {
        setError(result?.message || 'Não foi possível concluir. Tente de novo.');
      }
      return result;
    } catch (err) {
      if (mounted.current) setError(err.message);
      return { ok: false, message: err.message };
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { busy, error, submit, setError };
}
