import { accountBanner } from '../../shared/lib/accounts';
import { useAuth } from './AuthContext';

// O aviso fixo no alto da janela (GOALS 20): professor aguardando aprovação, ou o app usando o
// último perfil salvo porque o servidor de contas não responde.
export default function AccountBanner() {
  const { account } = useAuth();
  const banner = accountBanner(account);
  if (!banner) return null;
  const tone =
    banner.tone === 'warning'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : 'border-line bg-surface text-text-secondary';
  return (
    <div role="status" className={`shrink-0 border-b px-4 py-2 text-xs ${tone}`}>
      {banner.text}
    </div>
  );
}
