import { useEffect, useState } from 'react';
import { ErrorLine, Field, GhostButton, Modal, inputClass, useDialogAction } from './LabDialog';

// Vincula um aluno do PC (a conta do Windows) à conta do aplicativo dele (GOALS 21): o professor
// procura pelo nome ou e-mail e escolhe. Depois disso, cada vez que o PC for reservado para esse
// aluno, o acesso aparece sozinho em "Meu acesso" no aplicativo dele.
export default function LinkAccountDialog({ student, onLink, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState('');
  const { working, error, run } = useDialogAction(onClose);

  // Procura meio segundo depois de a pessoa parar de digitar; busca vazia lista os primeiros alunos.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await window.electronAPI.searchStudentAccounts(query);
        if (cancelled) return;
        if (result?.ok) {
          setResults(result.students);
          setSearchError('');
        } else {
          setSearchError(result?.message || 'Não consegui procurar agora.');
        }
      } catch (err) {
        if (!cancelled) setSearchError(err.message);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <Modal title={`Vincular a conta de ${student.label}`} onClose={onClose} busy={working} wide>
      <p className="text-xs text-text-secondary mb-3">
        Escolha a conta do aplicativo que é de {student.label}. Quando o PC for reservado para ele,
        o acesso aparece em &quot;Meu acesso&quot; no aplicativo dele.
      </p>
      <Field label="Procurar por nome ou e-mail">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          maxLength={60}
          disabled={working}
          className={inputClass}
        />
      </Field>
      <ErrorLine text={searchError || error} />
      <div
        className="mb-4 max-h-64 overflow-auto rounded-lg border border-line-subtle bg-inset"
        role="group"
        aria-label="Alunos com conta"
      >
        {results === null ? (
          <div role="status" className="px-3 py-2 text-xs text-text-faint">
            Procurando...
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-faint">
            Nenhum aluno com conta encontrado. Quem ainda não tem conta cria uma na tela de entrada
            do aplicativo.
          </div>
        ) : (
          <ul>
            {results.map((person) => (
              <li
                key={person.id}
                className="flex items-center gap-3 px-3 py-2 border-b border-line-subtle last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{person.fullName}</div>
                  <div className="text-[11px] text-text-faint truncate">{person.email}</div>
                </div>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => run(() => onLink(person))}
                  className="px-3 py-1 rounded-md text-xs border border-accent/60 text-accent hover:bg-accent/10 bg-transparent transition-colors disabled:opacity-50"
                >
                  Vincular
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end">
        <GhostButton onClick={onClose} disabled={working}>
          Agora não
        </GhostButton>
      </div>
    </Modal>
  );
}
