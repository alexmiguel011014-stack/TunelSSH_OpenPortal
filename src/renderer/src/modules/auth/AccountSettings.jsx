import { UserRound } from 'lucide-react';
import { roleLabel } from '../../shared/lib/accounts';
import { useAuth } from './AuthContext';

// O cartão "Conta" de Configurações (GOALS 20): quem está usando o app e o jeito de sair (ou de
// entrar, para quem escolheu "Usar sem conta"). Num build sem contas explica por que não há login.
export default function AccountSettings() {
  const { account, signOut } = useAuth();
  const guest = account.kind === 'guest';
  const legacy = account.kind === 'legacy';

  return (
    <section
      aria-label="Conta"
      className="mb-6 p-4 bg-surface rounded-xl border border-line-subtle flex items-center gap-3"
    >
      <UserRound size={20} className="text-text-faint shrink-0" />
      <div className="min-w-0 flex-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Conta</h3>
        {legacy ? (
          <>
            <p className="text-sm text-text-secondary">
              Contas indisponíveis nesta versão do aplicativo.
            </p>
            <p className="text-[11px] text-text-faint">
              Este build não foi gerado com o endereço do Supabase (docs/SUPABASE.md); o app abre
              sem login, como antes.
            </p>
          </>
        ) : guest ? (
          <p className="text-sm text-text-secondary">Sem conta: só este PC.</p>
        ) : (
          <>
            <p className="text-sm text-text-primary truncate">{account.profile.fullName}</p>
            <p className="text-[11px] text-text-faint truncate">
              {account.profile.email} · {roleLabel(account)}
            </p>
          </>
        )}
      </div>
      {!legacy && (
        <button
          type="button"
          onClick={signOut}
          className="px-3 py-1.5 rounded-lg text-xs border border-line text-text-secondary hover:border-text-faint transition-colors whitespace-nowrap"
        >
          {guest ? 'Entrar' : 'Sair da conta'}
        </button>
      )}
    </section>
  );
}
