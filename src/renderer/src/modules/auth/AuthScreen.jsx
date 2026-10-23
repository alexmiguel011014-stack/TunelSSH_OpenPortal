import { useEffect, useState } from 'react';
import { GhostButton, PrimaryButton } from '../lab/LabDialog';
import {
  formatCodeInput,
  resendSecondsLeft,
  validateNewPasswordForm,
  validateEmail,
  validateSignIn,
  validateSignUp,
} from '../../shared/lib/accounts';
import { Notice, PasswordField, RoleChooser, TextField, useSubmit } from './fields';

// A tela de entrada (GOALS 20): Entrar, Criar conta, o código enviado por e-mail, "Esqueci minha
// senha" e a senha nova. O estado do código vem do processo principal (`auth.status ===
// 'awaiting-code'`), então a tela certa volta mesmo se a janela for recarregada; as outras três
// são só desta tela.

const api = () => window.electronAPI;

function Heading({ title, children }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      {children && <p className="text-xs text-text-faint mt-1">{children}</p>}
    </div>
  );
}

function LinkButton({ children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className="text-xs text-accent hover:underline bg-transparent border-none p-0 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SignInForm({ initialEmail, notice, onEmail, goSignUp, goReset }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const { busy, error, submit } = useSubmit();

  const handleSubmit = async (event) => {
    event.preventDefault();
    const checked = validateSignIn({ email, password });
    setErrors(checked.errors);
    if (!checked.ok) return;
    onEmail(checked.values.email);
    const result = await submit(() => api().authSignIn(checked.values));
    if (!result?.ok) setPassword('');
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Heading title="Entrar">Use o e-mail e a senha da sua conta do OpenPortal.</Heading>
      <Notice tone="warning">{notice}</Notice>
      <Notice tone="error">{error}</Notice>
      <TextField
        id="signin-email"
        label="E-mail"
        type="email"
        value={email}
        onChange={setEmail}
        error={errors.email}
        autoComplete="username"
        autoFocus={!initialEmail}
        disabled={busy}
      />
      <PasswordField
        id="signin-password"
        label="Senha"
        value={password}
        onChange={setPassword}
        error={errors.password}
        autoComplete="current-password"
        autoFocus={Boolean(initialEmail)}
        disabled={busy}
      />
      <div className="flex items-center justify-between mb-4">
        <LinkButton onClick={goReset} disabled={busy}>
          Esqueci minha senha
        </LinkButton>
      </div>
      <PrimaryButton type="submit" disabled={busy} style={{ width: '100%' }}>
        {busy ? 'Entrando...' : 'Entrar'}
      </PrimaryButton>
      <p className="text-xs text-text-faint text-center mt-4">
        Ainda não tem conta? <LinkButton onClick={goSignUp}>Criar conta</LinkButton>
      </p>
    </form>
  );
}

function SignUpForm({ initialEmail, onEmail, goSignIn }) {
  const [form, setForm] = useState({
    fullName: '',
    email: initialEmail,
    password: '',
    confirm: '',
    role: 'aluno',
  });
  const [errors, setErrors] = useState({});
  const { busy, error, submit } = useSubmit();
  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    const checked = validateSignUp(form);
    setErrors(checked.errors);
    if (!checked.ok) return;
    onEmail(checked.values.email);
    await submit(() =>
      api().authSignUp({
        fullName: checked.values.fullName,
        email: checked.values.email,
        password: checked.values.password,
        role: checked.values.role,
      }),
    );
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Heading title="Criar conta">
        Enviaremos um código de 6 números para o seu e-mail confirmar a conta.
      </Heading>
      <Notice tone="error">{error}</Notice>
      <TextField
        id="signup-name"
        label="Nome completo"
        value={form.fullName}
        onChange={set('fullName')}
        error={errors.fullName}
        autoComplete="name"
        autoFocus
        maxLength={80}
        disabled={busy}
      />
      <TextField
        id="signup-email"
        label="E-mail"
        type="email"
        value={form.email}
        onChange={set('email')}
        error={errors.email}
        autoComplete="email"
        disabled={busy}
      />
      <PasswordField
        id="signup-password"
        label="Senha"
        value={form.password}
        onChange={set('password')}
        error={errors.password}
        hint="Pelo menos 8 caracteres, com letras e números."
        autoComplete="new-password"
        disabled={busy}
      />
      <PasswordField
        id="signup-confirm"
        label="Confirmar senha"
        value={form.confirm}
        onChange={set('confirm')}
        error={errors.confirm}
        autoComplete="new-password"
        disabled={busy}
      />
      <RoleChooser value={form.role} onChange={set('role')} error={errors.role} />
      <PrimaryButton type="submit" disabled={busy} style={{ width: '100%' }}>
        {busy ? 'Criando...' : 'Criar conta'}
      </PrimaryButton>
      <p className="text-xs text-text-faint text-center mt-4">
        Já tem conta? <LinkButton onClick={goSignIn}>Entrar</LinkButton>
      </p>
    </form>
  );
}

function ResetRequestForm({ initialEmail, onEmail, goSignIn }) {
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState('');
  const { busy, error, submit } = useSubmit();

  const handleSubmit = async (event) => {
    event.preventDefault();
    const problem = validateEmail(email);
    setEmailError(problem);
    if (problem) return;
    onEmail(email.trim());
    await submit(() => api().authResetRequest({ email: email.trim() }));
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Heading title="Esqueci minha senha">
        Se houver uma conta com esse e-mail, enviamos um código de 6 números para criar uma senha
        nova.
      </Heading>
      <Notice tone="error">{error}</Notice>
      <TextField
        id="reset-email"
        label="E-mail"
        type="email"
        value={email}
        onChange={setEmail}
        error={emailError}
        autoComplete="email"
        autoFocus
        disabled={busy}
      />
      <PrimaryButton type="submit" disabled={busy} style={{ width: '100%' }}>
        {busy ? 'Enviando...' : 'Enviar código'}
      </PrimaryButton>
      <p className="text-xs text-text-faint text-center mt-4">
        <LinkButton onClick={goSignIn}>Voltar para Entrar</LinkButton>
      </p>
    </form>
  );
}

// "Reenviar código" com a contagem de 60 s (o servidor só deixa pedir um por minuto).
function ResendCode({ auth }) {
  const [sentAt, setSentAt] = useState(() => (auth.needsResend ? 0 : Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [info, setInfo] = useState('');
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = resendSecondsLeft(sentAt, now);
  const resend = async () => {
    setInfo('');
    const result = await submit(() => api().authResendCode({ email: auth.email }));
    if (result?.ok) {
      setSentAt(Date.now());
      setNow(Date.now());
      setInfo('Enviamos outro código. O anterior deixou de valer.');
    }
  };

  return (
    <div className="mt-3 text-center">
      <Notice tone="error">{error}</Notice>
      <Notice>{info}</Notice>
      <LinkButton onClick={resend} disabled={busy || left > 0}>
        {left > 0 ? `Reenviar código (${left} s)` : 'Reenviar código'}
      </LinkButton>
    </div>
  );
}

function CancelLink({ children }) {
  return (
    <p className="text-xs text-text-faint text-center mt-4">
      <LinkButton onClick={() => api().authSignOut()}>{children}</LinkButton>
    </p>
  );
}

function CodeForm({ auth }) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const { busy, error, submit } = useSubmit();

  const handleSubmit = async (event) => {
    event.preventDefault();
    const problem = formatCodeInput(code).length === 6 ? '' : 'O código tem 6 números.';
    setCodeError(problem);
    if (problem) return;
    const result = await submit(() => api().authVerifyCode({ email: auth.email, code }));
    if (!result?.ok) setCode('');
  };

  return (
    <div>
      <form onSubmit={handleSubmit} noValidate>
        <Heading title="Confirme seu e-mail">
          {auth.needsResend
            ? 'Seu e-mail ainda não foi confirmado. Digite o código que enviamos ou peça outro abaixo.'
            : `Enviamos um código de 6 números para ${auth.email}. Pode levar um minuto; olhe também a caixa de spam.`}
        </Heading>
        <Notice tone="error">{error}</Notice>
        <TextField
          id="code"
          label="Código"
          value={code}
          onChange={(value) => setCode(formatCodeInput(value))}
          error={codeError}
          hint="O código vale por 10 minutos."
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          mono
          disabled={busy}
          style={{ letterSpacing: '0.4em', fontSize: '1.25rem', textAlign: 'center' }}
        />
        <PrimaryButton type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Conferindo...' : 'Confirmar'}
        </PrimaryButton>
      </form>
      <ResendCode auth={auth} />
      <p className="text-[11px] text-text-faint text-center mt-3">
        Não chegou nada? Se você já tem conta, volte e use Entrar ou Esqueci minha senha.
      </p>
      <CancelLink>Voltar</CancelLink>
    </div>
  );
}

function NewPasswordForm({ auth }) {
  const [form, setForm] = useState({ code: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const { busy, error, submit } = useSubmit();
  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    const checked = validateNewPasswordForm(form);
    setErrors(checked.errors);
    if (!checked.ok) return;
    await submit(() =>
      api().authResetConfirm({
        email: auth.email,
        code: checked.values.code,
        password: checked.values.password,
      }),
    );
  };

  return (
    <div>
      <form onSubmit={handleSubmit} noValidate>
        <Heading title="Criar uma senha nova">
          Digite o código de 6 números enviado para {auth.email} e escolha a senha nova.
        </Heading>
        <Notice tone="error">{error}</Notice>
        <TextField
          id="reset-code"
          label="Código"
          value={form.code}
          onChange={(value) => set('code')(formatCodeInput(value))}
          error={errors.code}
          hint="O código vale por 10 minutos."
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          mono
          disabled={busy}
        />
        <PasswordField
          id="reset-password"
          label="Senha nova"
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint="Pelo menos 8 caracteres, com letras e números."
          autoComplete="new-password"
          disabled={busy}
        />
        <PasswordField
          id="reset-confirm"
          label="Confirmar senha nova"
          value={form.confirm}
          onChange={set('confirm')}
          error={errors.confirm}
          autoComplete="new-password"
          disabled={busy}
        />
        <PrimaryButton type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Salvando...' : 'Salvar senha nova'}
        </PrimaryButton>
      </form>
      <ResendCode auth={auth} />
      <CancelLink>Cancelar</CancelLink>
    </div>
  );
}

export default function AuthScreen({ auth }) {
  const [view, setView] = useState('signin'); // signin | signup | reset
  // O e-mail digitado acompanha a pessoa entre Entrar, Criar conta e Esqueci minha senha.
  const [email, setEmail] = useState('');

  let body;
  if (auth.status === 'awaiting-code') {
    body = auth.purpose === 'recovery' ? <NewPasswordForm auth={auth} /> : <CodeForm auth={auth} />;
  } else if (view === 'signup') {
    body = (
      <SignUpForm initialEmail={email} onEmail={setEmail} goSignIn={() => setView('signin')} />
    );
  } else if (view === 'reset') {
    body = (
      <ResetRequestForm
        initialEmail={email}
        onEmail={setEmail}
        goSignIn={() => setView('signin')}
      />
    );
  } else {
    body = (
      <SignInForm
        initialEmail={email}
        notice={auth.notice}
        onEmail={setEmail}
        goSignUp={() => setView('signup')}
        goReset={() => setView('reset')}
      />
    );
  }

  return (
    <div className="h-screen w-screen overflow-auto bg-canvas text-text-primary">
      <div className="min-h-full flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <header className="text-center mb-6">
            <h1 className="text-2xl font-light">OpenPortal</h1>
            <p className="text-sm text-text-faint mt-1">Remote Desktop Gateway</p>
          </header>
          <main className="bg-surface border border-line-subtle rounded-xl p-6 shadow-lg">
            {body}
          </main>
          {auth.status !== 'awaiting-code' && (
            <div className="mt-4 text-center">
              <GhostButton type="button" onClick={() => api().authUseWithoutAccount()}>
                Usar sem conta (só este PC)
              </GhostButton>
              <p className="text-[11px] text-text-faint mt-2">
                Mostra só o acesso a este PC. Para conectar a outros PCs é preciso entrar como
                professor.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
