using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenPortalLab
{
    public sealed class Result
    {
        public bool Ok;
        public string Error;
        public string Message;
        public Dictionary<string, object> Data = new Dictionary<string, object>();

        public static Result Success(Dictionary<string, object> data = null)
        {
            return new Result { Ok = true, Data = data ?? new Dictionary<string, object>() };
        }

        public static Result Fail(string error, string message, Dictionary<string, object> data = null)
        {
            return new Result { Ok = false, Error = error, Message = message, Data = data ?? new Dictionary<string, object>() };
        }
    }

    public sealed class EngineOptions
    {
        // O SID da conta que roda o app (a única, além do SYSTEM, que fala com o pipe).
        public string OwnerSid = "";
        public int WarnBeforeMs = 5 * 60 * 1000;
        public int EndWarnDelayMs = 10 * 1000;
        public int LeftGraceMs = 15 * 1000;
        public int LogoffAttempts = 3;
        public int LogoffRetryDelayMs = 2000;
        public int MaxStudents = 100;
        public int UsageCacheMs = 30 * 1000;
        public long MaxAheadMs = 24L * 60 * 60 * 1000;
        // Quantos dias o diário guarda (GOALS 19).
        public int JournalRetentionDays = Journal.DefaultRetentionDays;
        // Verdadeiro nos testes: a reaplicação do acesso do dono roda na hora, não em segundo plano.
        public bool InlineCleanup = false;
    }

    // O coração do serviço: alunos, a reserva única, os prazos e o fim forçado.
    // A regra "nunca dois ao mesmo tempo" vale aqui: no máximo UMA conta de aluno
    // fica habilitada, e só a da reserva em andamento.
    public sealed class Engine
    {
        private const long GbBytes = 1024L * 1024 * 1024;

        private readonly IWindows win;
        private readonly IStateStore store;
        private readonly IClock clock;
        private readonly IRandom random;
        private readonly ILog log;
        private readonly EngineOptions opt;
        private readonly object gate = new object();
        private readonly LabState state;
        private readonly Journal journal;
        // Sessões de aluno vistas por número: o logoff chega quando a sessão já não existe, e a conta e o
        // endereço de origem só podem ser lidos enquanto ela existia.
        private readonly Dictionary<int, SeenSession> seenSessions = new Dictionary<int, SeenSession>();
        private readonly object sessionGate = new object();
        private long nextPruneAt;
        private bool endRunning;
        private long nextEndRetryAt;
        // A reserva cujo aluno foi visto com sessão DURANTE esta execução do serviço: só quem foi
        // visto sair conta como "saiu". Depois de um reinício do PC a sessão some sem ninguém ter
        // saído, e o aluno pode entrar de novo até o prazo.
        private string seenReservation;
        private Result lastStatus;
        private Dictionary<string, long> usageCache = new Dictionary<string, long>();
        private long usageCacheAt = -1;

        private sealed class SeenSession
        {
            public SessionDetails Details;
            public bool Connected;
            public long LogonAt;
        }

        public Engine(IWindows win, IStateStore store, IClock clock, IRandom random, ILog log, EngineOptions options, Journal journal = null)
        {
            this.journal = journal;
            this.win = win;
            this.store = store;
            this.clock = clock;
            this.random = random;
            this.log = log;
            this.opt = options;
            this.state = store.Load();
        }

        public EngineOptions Options
        {
            get { return opt; }
        }

        // Ao subir: garante que só a conta da reserva está habilitada e termina um
        // encerramento que a queda do serviço deixou pela metade.
        public void Start()
        {
            string pendingEnd = null;
            string pendingReason = null;
            PruneJournal();
            lock (gate)
            {
                Reconcile();
                if (state.Reservation != null && state.Reservation.State == ReservationStates.Ending)
                {
                    pendingEnd = state.Reservation.Id;
                    pendingReason = state.Reservation.EndReason ?? "service-restart";
                }
            }
            if (pendingEnd != null)
            {
                log.Info("encerrando a reserva que ficou pela metade");
                RunEnd(pendingEnd, pendingReason, false);
            }
        }

        private void Reconcile()
        {
            foreach (Student s in state.Students)
            {
                bool shouldBeEnabled = state.Reservation != null
                    && state.Reservation.Account == s.Account
                    && state.Reservation.State != ReservationStates.Ending;
                try
                {
                    if (!shouldBeEnabled && win.IsEnabled(s.Account))
                    {
                        log.Warn("conta " + s.Account + " estava habilitada sem reserva: desabilitada");
                        win.SetEnabled(s.Account, false);
                    }
                }
                catch (Exception ex)
                {
                    log.Warn("não consegui conferir a conta " + s.Account + ": " + ex.Message);
                }
            }
        }

        private void Save()
        {
            store.Save(state);
        }

        private Student Find(string account)
        {
            return state.Students.FirstOrDefault(s => s.Account == account);
        }


        private static Dictionary<string, object> Data(params object[] pairs)
        {
            var data = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2) data[(string)pairs[i]] = pairs[i + 1];
            return data;
        }

        // ---- Alunos ---------------------------------------------------------

        public Result StudentCreate(string label, long quotaGb)
        {
            string clean = Names.CleanLabel(label);
            if (clean == null) return Result.Fail("bad-request", "Nome do aluno inválido (1 a 40 caracteres)");
            if (quotaGb < 1 || quotaGb > 2000) return Result.Fail("bad-request", "Cota fora do intervalo (1 a 2000 GB)");

            lock (gate)
            {
                if (state.Students.Count >= opt.MaxStudents)
                {
                    return Result.Fail("full", "Este PC já tem " + opt.MaxStudents + " alunos");
                }
                string account = Names.Derive(clean, name => Find(name) != null || win.AccountExists(name));
                if (account == null) return Result.Fail("internal", "Não achei um nome de conta livre");

                bool created = false;
                try
                {
                    win.CreateAccount(account, clean, Passwords.Generate(random));
                    created = true;
                    win.EnsureProfile(account);
                    win.SetQuota(account, Quota.WarnBytes((int)quotaGb), Quota.GbToBytes((int)quotaGb));
                    GrantOwner(account);
                }
                catch (Exception ex)
                {
                    log.Warn("falha ao criar o aluno " + account + ": " + ex.Message);
                    if (created)
                    {
                        try { win.DeleteProfile(account); } catch { }
                        try { win.DeleteAccount(account); } catch { }
                    }
                    return Result.Fail("internal", "Não foi possível criar a conta do aluno");
                }

                var student = new Student { Account = account, Label = clean, QuotaGb = (int)quotaGb, CreatedAt = clock.NowMs };
                state.Students.Add(student);
                Save();
                log.Info("aluno criado: " + account);
                Note("student-added", account, clean, null, null, null, quotaGb + " GB");
                return Result.Success(StudentView(student, null));
            }
        }

        public Result StudentSetQuota(string account, long quotaGb)
        {
            if (quotaGb < 1 || quotaGb > 2000) return Result.Fail("bad-request", "Cota fora do intervalo (1 a 2000 GB)");
            lock (gate)
            {
                Student s = Find(account);
                if (s == null) return Result.Fail("not-found", "Aluno não encontrado");
                try
                {
                    win.SetQuota(account, Quota.WarnBytes((int)quotaGb), Quota.GbToBytes((int)quotaGb));
                }
                catch (Exception ex)
                {
                    log.Warn("falha ao mudar a cota de " + account + ": " + ex.Message);
                    return Result.Fail("internal", "Não foi possível mudar a cota");
                }
                s.QuotaGb = (int)quotaGb;
                Save();
                Note("quota-changed", account, s.Label, null, null, null, quotaGb + " GB");
                return Result.Success(StudentView(s, null));
            }
        }

        public Result StudentDelete(string account)
        {
            lock (gate)
            {
                Student s = Find(account);
                if (s == null) return Result.Fail("not-found", "Aluno não encontrado");
                if (state.Reservation != null && state.Reservation.Account == account)
                {
                    return Result.Fail("busy", "Esse aluno está com o PC reservado; encerre a reserva antes", Data("account", account));
                }
                try
                {
                    foreach (SessionInfo session in win.GetSessions(account)) win.Logoff(session.Id);
                    try { win.RemoveQuota(account); } catch (Exception ex) { log.Warn("entrada de cota de " + account + " não removida: " + ex.Message); }
                    win.DeleteProfile(account);
                    win.DeleteAccount(account);
                }
                catch (Exception ex)
                {
                    log.Warn("falha ao apagar o aluno " + account + ": " + ex.Message);
                    return Result.Fail("internal", "Não foi possível apagar o aluno");
                }
                state.Students.Remove(s);
                Save();
                usageCacheAt = -1;
                log.Info("aluno apagado: " + account);
                Note("student-deleted", account, s.Label, null, null, null, null);
                return Result.Success(Data("account", account));
            }
        }

        public Result EnsureFolderAccess(string account)
        {
            lock (gate)
            {
                if (Find(account) == null) return Result.Fail("not-found", "Aluno não encontrado");
                try
                {
                    win.GrantOwnerRead(account, opt.OwnerSid);
                    return Result.Success(Data("account", account, "path", win.GetProfilePath(account)));
                }
                catch (Exception ex)
                {
                    log.Warn("falha ao liberar a pasta de " + account + ": " + ex.Message);
                    return Result.Fail("internal", "Não foi possível liberar a pasta");
                }
            }
        }

        private void GrantOwner(string account)
        {
            if (!string.IsNullOrEmpty(opt.OwnerSid)) win.GrantOwnerRead(account, opt.OwnerSid);
        }

        // ---- Reserva --------------------------------------------------------

        public Result Reserve(string account, long startWithinMs, long sessionMs)
        {
            if (startWithinMs < 60 * 1000 || startWithinMs > 24L * 3600 * 1000) return Result.Fail("bad-request", "Prazo para entrar fora do intervalo");
            if (sessionMs < 5L * 60 * 1000 || sessionMs > 12L * 3600 * 1000) return Result.Fail("bad-request", "Duração fora do intervalo");

            lock (gate)
            {
                Student student = Find(account);
                if (student == null) return Result.Fail("not-found", "Aluno não encontrado");

                if (state.Reservation != null)
                {
                    Student current = Find(state.Reservation.Account);
                    return Result.Fail("busy", "O PC já está reservado", Data(
                        "account", state.Reservation.Account,
                        "label", current == null ? state.Reservation.Account : current.Label,
                        "state", state.Reservation.State,
                        "endsAt", state.Reservation.EndsAt));
                }

                string password = Passwords.Generate(random);
                var reservation = new Reservation
                {
                    Id = Guid.NewGuid().ToString("N").Substring(0, 16),
                    Account = account,
                    State = ReservationStates.Reserved,
                    CreatedAt = clock.NowMs,
                    StartBy = clock.NowMs + startWithinMs,
                    SessionMs = sessionMs,
                    EndsAt = clock.NowMs + startWithinMs + sessionMs,
                };
                try
                {
                    // Nunca dois: qualquer outra conta de aluno que esteja habilitada é desabilitada.
                    foreach (Student other in state.Students)
                    {
                        if (other.Account != account && win.IsEnabled(other.Account)) win.SetEnabled(other.Account, false);
                    }
                    win.SetPassword(account, password);
                    win.SetEnabled(account, true);
                    state.Reservation = reservation;
                    Save();
                }
                catch (Exception ex)
                {
                    log.Warn("falha ao reservar para " + account + ": " + ex.Message);
                    state.Reservation = null;
                    try { win.SetEnabled(account, false); } catch { }
                    return Result.Fail("internal", "Não foi possível reservar o PC");
                }

                log.Info("reserva " + reservation.Id + " para " + account);
                Note("reservation-start", account, student.Label, reservation.Id, null, null,
                    "entrar em até " + (startWithinMs / 60000) + " min; sessão de " + (sessionMs / 60000) + " min");
                return Result.Success(Data(
                    "reservationId", reservation.Id,
                    "account", account,
                    "userName", win.MachineName + "\\" + account,
                    "password", password,
                    "startBy", reservation.StartBy,
                    "endsAt", reservation.EndsAt));
            }
        }

        public Result Extend(string reservationId, long addMs)
        {
            if (addMs < 60 * 1000 || addMs > 12L * 3600 * 1000) return Result.Fail("bad-request", "Extensão fora do intervalo");
            lock (gate)
            {
                Reservation r = state.Reservation;
                if (r == null || r.Id != reservationId) return Result.Fail("not-found", "Reserva não encontrada");
                if (r.State == ReservationStates.Ending) return Result.Fail("busy", "A reserva está sendo encerrada");
                long next = r.EndsAt + addMs;
                if (next - clock.NowMs > opt.MaxAheadMs) return Result.Fail("bad-request", "A sessão não pode passar de 24 horas à frente");
                r.EndsAt = next;
                // Uma extensão devolve o aviso de 5 minutos.
                if (next - clock.NowMs > opt.WarnBeforeMs) r.Warned = false;
                Save();
                return Result.Success(Data("reservationId", r.Id, "endsAt", r.EndsAt));
            }
        }

        // Encerra agora (o professor, ou a troca de aluno): aviso, logoff de todas
        // as sessões da conta e só então a conta fica desabilitada. Devolve depois
        // de conferir que não sobrou sessão; se sobrou, a reserva continua
        // "encerrando" e quem chamou vê o erro (não reserva por cima).
        public Result End(string reservationId, string reason)
        {
            if (reason != "manager-ended" && reason != "manager-handover") return Result.Fail("bad-request", "Motivo inválido");
            return RunEnd(reservationId, reason, true);
        }

        private Result RunEnd(string reservationId, string reason, bool warn)
        {
            string account;
            lock (gate)
            {
                Reservation r = state.Reservation;
                if (r == null || r.Id != reservationId) return Result.Fail("not-found", "Reserva não encontrada");
                if (endRunning) return Result.Fail("busy", "O encerramento já está em andamento");
                endRunning = true;
                if (r.State != ReservationStates.Ending)
                {
                    r.State = ReservationStates.Ending;
                    r.EndReason = reason;
                    Save();
                }
                account = r.Account;
            }

            try
            {
                List<SessionInfo> sessions = win.GetSessions(account);
                if (warn)
                {
                    foreach (SessionInfo s in sessions)
                    {
                        if (IsInteractive(s)) TrySend(s, "Sua sessão no laboratório será encerrada em instantes. Salve seu trabalho.");
                    }
                    if (sessions.Count > 0) clock.Sleep(opt.EndWarnDelayMs);
                }

                // Desabilitar não derruba a sessão aberta (visto no G17-V1), mas
                // impede uma nova entrada enquanto as sessões são encerradas.
                win.SetEnabled(account, false);
                for (int attempt = 0; attempt < opt.LogoffAttempts; attempt++)
                {
                    sessions = win.GetSessions(account);
                    if (sessions.Count == 0) break;
                    foreach (SessionInfo s in sessions) win.Logoff(s.Id);
                    clock.Sleep(opt.LogoffRetryDelayMs);
                }
                sessions = win.GetSessions(account);
                if (sessions.Count > 0)
                {
                    log.Warn("a conta " + account + " ainda tem " + sessions.Count + " sessão(ões) depois do logoff");
                    lock (gate) { nextEndRetryAt = clock.NowMs + 10 * 1000; }
                    return Result.Fail("logoff-failed", "Não consegui encerrar a sessão do aluno", Data("account", account));
                }

                try { win.CleanPublic(account); } catch (Exception ex) { log.Warn("limpeza da pasta Public falhou: " + ex.Message); }

                lock (gate)
                {
                    Student s = Find(account);
                    if (s != null) s.LastSessionEnd = clock.NowMs;
                    string endedReason = state.Reservation != null ? state.Reservation.EndReason : reason;
                    string endedId = state.Reservation != null ? state.Reservation.Id : reservationId;
                    state.Reservation = null;
                    Save();
                    usageCacheAt = -1;
                    log.Info("reserva encerrada (" + (endedReason ?? reason) + "): " + account);
                    Note("reservation-end", account, s != null ? s.Label : null, endedId, null, endedReason ?? reason, null);
                }

                if (opt.InlineCleanup) ReapplyOwnerAccess(account);
                else System.Threading.ThreadPool.QueueUserWorkItem(_ => ReapplyOwnerAccess(account));

                return Result.Success(Data("ended", true, "reason", reason));
            }
            catch (Exception ex)
            {
                log.Warn("falha ao encerrar a reserva de " + account + ": " + ex.Message);
                return Result.Fail("internal", "Não foi possível encerrar a sessão");
            }
            finally
            {
                lock (gate) { endRunning = false; }
            }
        }

        // O aluno é dono dos próprios arquivos e pode ter tirado a leitura do dono do
        // app: ela volta ao fim de cada sessão.
        private void ReapplyOwnerAccess(string account)
        {
            try
            {
                GrantOwner(account);
            }
            catch (Exception ex)
            {
                log.Warn("acesso do dono à pasta de " + account + " não reaplicado: " + ex.Message);
            }
        }

        private static bool IsInteractive(SessionInfo s)
        {
            return s.State == "active" || s.State == "connected";
        }

        private void TrySend(SessionInfo s, string text)
        {
            try
            {
                win.SendMessage(s.Id, "OpenPortal", text);
            }
            catch (Exception ex)
            {
                log.Warn("aviso não enviado à sessão " + s.Id + ": " + ex.Message);
            }
        }

        // ---- Relógio --------------------------------------------------------

        // ---- Diário (GOALS 19) ---------------------------------------------

        // Grava um fato no diário. Uma falha do diário nunca derruba a operação que o gerou.
        private void Note(string type, string account, string label, string reservationId, string sourceIp, string endReason, string detail)
        {
            if (journal == null) return;
            try
            {
                journal.Append(type, account, label, reservationId, sourceIp, endReason, detail);
            }
            catch (Exception ex)
            {
                log.Warn("diário: não gravei " + type + ": " + ex.Message);
            }
        }

        private void PruneJournal()
        {
            if (journal == null) return;
            try
            {
                journal.Prune(opt.JournalRetentionDays);
            }
            catch (Exception ex)
            {
                log.Warn("diário: retenção falhou: " + ex.Message);
            }
            nextPruneAt = clock.NowMs + 24L * 3600 * 1000;
        }

        // O app registra no diário um fato que só ele conhece (veja o comando `note`). Os tipos
        // aceitos são fixos; o texto livre é só o login do gerente, sem caracteres de controle.
        public Result Record(string type, string detail)
        {
            if (journal == null) return Result.Fail("unsupported", "O diário não está ativo");
            if (type != "manager-enrolled" && type != "manager-removed") return Result.Fail("bad-request", "Tipo de registro inválido");
            var clean = new System.Text.StringBuilder();
            foreach (char c in detail ?? "") clean.Append(char.IsControl(c) ? ' ' : c);
            string text = clean.ToString().Trim();
            if (text.Length == 0) return Result.Fail("bad-request", "Texto do registro vazio");
            try
            {
                JournalEvent e = journal.Append(type, null, null, null, null, null, text);
                return Result.Success(Data("seq", e.Seq));
            }
            catch (Exception ex)
            {
                log.Warn("diário: não gravei " + type + ": " + ex.Message);
                return Result.Fail("internal", "Não foi possível gravar no diário");
            }
        }

        // Consulta do app (e do gerente, pelo `lab-events`).
        public Result Events(long sinceSeq, int limit)
        {
            if (journal == null) return Result.Fail("unsupported", "O diário não está ativo");
            try
            {
                return Result.Success(journal.Read(sinceSeq, limit));
            }
            catch (Exception ex)
            {
                log.Warn("diário: leitura falhou: " + ex.Message);
                return Result.Fail("internal", "Não foi possível ler o diário");
            }
        }

        // O Windows avisou que uma sessão mudou (entrar, sair, desconectar, reconectar). Só as contas dos
        // alunos entram no diário; o número da sessão leva ao nome da conta e ao endereço de origem
        // enquanto a sessão existe, e a lembrança guardada serve para a saída. kind: logon | logoff |
        // connect | disconnect. Nunca lança.
        public void OnSessionEvent(int sessionId, string kind)
        {
            try
            {
                if (kind != "logon" && kind != "logoff" && kind != "connect" && kind != "disconnect") return;
                SessionDetails details = null;
                bool report = true;
                string detail = kind;
                lock (sessionGate)
                {
                    SeenSession seen;
                    seenSessions.TryGetValue(sessionId, out seen);
                    long now = clock.NowMs;
                    if (kind == "logon" || kind == "connect")
                    {
                        // RemoteConnect logo depois de SessionLogon na mesma sessão é o mesmo fato.
                        if (kind == "connect" && seen != null && seen.Connected) return;
                        details = win.QuerySession(sessionId);
                        if (details == null || string.IsNullOrEmpty(details.Account)) return;
                        seenSessions[sessionId] = new SeenSession { Details = details, Connected = true, LogonAt = now };
                        if (kind == "connect") detail = "reconnect";
                    }
                    else
                    {
                        if (seen != null) details = seen.Details;
                        if (details == null)
                        {
                            try { details = win.QuerySession(sessionId); } catch { }
                        }
                        if (kind == "logoff") seenSessions.Remove(sessionId);
                        else if (seen != null) seen.Connected = false;
                        if (details == null) report = false;
                    }
                }
                if (!report || details == null) return;

                Student student;
                string reservationId = null;
                lock (gate)
                {
                    student = Find(details.Account);
                    if (student != null && state.Reservation != null && state.Reservation.Account == student.Account) reservationId = state.Reservation.Id;
                }
                if (student == null) return;
                string type = (kind == "logon" || kind == "connect") ? "session-logon" : "session-logoff";
                Note(type, student.Account, student.Label, reservationId, details.ClientAddress, null, detail);
            }
            catch (Exception ex)
            {
                log.Warn("evento de sessão ignorado: " + ex.Message);
            }
        }

        // Chamado a cada segundo pelo serviço (e pelo teste, com o relógio falso).
        public void Tick()
        {
            if (journal != null && clock.NowMs >= nextPruneAt) PruneJournal();
            string endId = null;
            string endReason = null;
            lock (gate)
            {
                Reservation r = state.Reservation;
                if (r == null) return;
                long now = clock.NowMs;

                if (r.State == ReservationStates.Ending)
                {
                    if (!endRunning && now >= nextEndRetryAt)
                    {
                        endId = r.Id;
                        endReason = r.EndReason ?? "service-restart";
                    }
                }
                else
                {
                    List<SessionInfo> sessions;
                    try
                    {
                        sessions = win.GetSessions(r.Account);
                    }
                    catch (Exception ex)
                    {
                        log.Warn("não consegui ler as sessões: " + ex.Message);
                        return;
                    }

                    if (r.State == ReservationStates.Reserved)
                    {
                        if (sessions.Count > 0)
                        {
                            r.State = ReservationStates.InUse;
                            r.FirstLogonAt = now;
                            r.LastSeenAt = now;
                            seenReservation = r.Id;
                            r.EndsAt = now + r.SessionMs;
                            r.Warned = false;
                            Save();
                            log.Info("primeira entrada de " + r.Account);
                        }
                        else if (now >= r.StartBy)
                        {
                            endId = r.Id;
                            endReason = "unused-expired";
                        }
                    }
                    else
                    {
                        if (sessions.Count > 0)
                        {
                            r.LastSeenAt = now;
                            seenReservation = r.Id;
                        }
                        if (now >= r.EndsAt)
                        {
                            endId = r.Id;
                            endReason = "deadline";
                        }
                        else if (seenReservation == r.Id && sessions.Count == 0 && now - r.LastSeenAt >= opt.LeftGraceMs)
                        {
                            endId = r.Id;
                            endReason = "student-left";
                        }
                        else if (!r.Warned && now >= r.EndsAt - opt.WarnBeforeMs)
                        {
                            r.Warned = true;
                            Save();
                            int minutes = (int)Math.Max(1, (r.EndsAt - now + 59999) / 60000);
                            foreach (SessionInfo s in sessions)
                            {
                                if (IsInteractive(s)) TrySend(s, "Sua sessão no laboratório termina em " + minutes + " minuto(s). Salve seu trabalho.");
                            }
                        }
                    }
                }
            }

            if (endId != null) RunEnd(endId, endReason, false);
        }

        // ---- Consultas ------------------------------------------------------

        private Dictionary<string, long> Usage()
        {
            long now = clock.NowMs;
            if (usageCacheAt < 0 || now - usageCacheAt >= opt.UsageCacheMs)
            {
                try
                {
                    usageCache = win.GetQuotaUsage();
                }
                catch (Exception ex)
                {
                    log.Warn("uso de cota não lido: " + ex.Message);
                    usageCache = new Dictionary<string, long>();
                }
                usageCacheAt = now;
            }
            return usageCache;
        }

        private string StudentState(Student s)
        {
            Reservation r = state.Reservation;
            return r != null && r.Account == s.Account ? r.State : "free";
        }

        private Dictionary<string, object> StudentView(Student s, Dictionary<string, long> usage)
        {
            long used;
            var view = new Dictionary<string, object>
            {
                { "account", s.Account },
                { "label", s.Label },
                { "quotaGb", s.QuotaGb },
                { "state", StudentState(s) },
                { "lastSessionEnd", s.LastSessionEnd },
            };
            if (usage != null) view["usedBytes"] = usage.TryGetValue(s.Account, out used) ? used : 0L;
            return view;
        }

        // A consulta periódica do gerente não pode ficar presa atrás de uma operação
        // longa (criar aluno, encerrar sessão): passado meio segundo, devolve a última
        // resposta, marcada como antiga.
        public Result Status()
        {
            if (!System.Threading.Monitor.TryEnter(gate, 500))
            {
                Result stale = lastStatus;
                if (stale == null) return Result.Fail("busy", "O serviço está ocupado");
                var copy = new Dictionary<string, object>(stale.Data);
                copy["stale"] = true;
                return Result.Success(copy);
            }
            try
            {
                Result fresh = BuildStatus();
                lastStatus = fresh;
                return fresh;
            }
            finally
            {
                System.Threading.Monitor.Exit(gate);
            }
        }

        private Result BuildStatus()
        {
            {
                Dictionary<string, long> usage = Usage();
                var students = new List<object>();
                long usedByStudents = 0;
                foreach (Student s in state.Students)
                {
                    students.Add(StudentView(s, usage));
                    long used;
                    if (usage.TryGetValue(s.Account, out used)) usedByStudents += used;
                }

                var data = new Dictionary<string, object>
                {
                    { "state", state.Reservation == null ? "free" : state.Reservation.State },
                    { "students", students },
                    { "studentCount", state.Students.Count },
                };
                if (journal != null) data["lastSeq"] = journal.LastSeq;
                Reservation r = state.Reservation;
                if (r != null)
                {
                    Student s = Find(r.Account);
                    data["reservation"] = new Dictionary<string, object>
                    {
                        { "id", r.Id },
                        { "account", r.Account },
                        { "label", s == null ? r.Account : s.Label },
                        { "state", r.State },
                        { "startBy", r.StartBy },
                        { "endsAt", r.EndsAt },
                        { "createdAt", r.CreatedAt },
                        { "firstLogonAt", r.FirstLogonAt },
                    };
                }
                try
                {
                    data["quota"] = win.GetQuotaState().State;
                    DiskInfo disk = win.GetDiskInfo();
                    data["disk"] = new Dictionary<string, object>
                    {
                        { "totalGb", Math.Round(disk.TotalGb, 1) },
                        { "freeGb", Math.Round(disk.FreeGb, 1) },
                        { "usedByStudentsGb", Math.Round(usedByStudents / (double)GbBytes, 1) },
                    };
                }
                catch (Exception ex)
                {
                    log.Warn("estado do disco/cota não lido: " + ex.Message);
                }
                return Result.Success(data);
            }
        }

        // Total, livre e ocupado pelos alunos no volume dos perfis, mais a
        // recomendação de quantos alunos cabem (veja Capacity).
        public Result DiskInfoResult(double? reserveGb, double? quotaGb)
        {
            lock (gate)
            {
                try
                {
                    DiskInfo disk = win.GetDiskInfo();
                    Dictionary<string, long> usage = Usage();
                    long usedByStudents = 0;
                    double assigned = 0;
                    foreach (Student s in state.Students)
                    {
                        assigned += s.QuotaGb;
                        long used;
                        if (usage.TryGetValue(s.Account, out used)) usedByStudents += used;
                    }
                    Dictionary<string, object> capacity = Capacity.Compute(disk.TotalGb, disk.FreeGb, quotaGb ?? 25, assigned, reserveGb);
                    capacity["usedByStudentsGb"] = Math.Round(usedByStudents / (double)GbBytes, 1);
                    capacity["studentCount"] = state.Students.Count;
                    return Result.Success(capacity);
                }
                catch (Exception ex)
                {
                    log.Warn("disco não lido: " + ex.Message);
                    return Result.Fail("internal", "Não foi possível ler o disco");
                }
            }
        }

        // Para os testes.
        public LabState SnapshotForTests()
        {
            lock (gate) { return state; }
        }
    }
}
