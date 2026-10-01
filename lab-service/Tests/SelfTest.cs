using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OpenPortalLab
{
    // Os testes do serviço, dentro do próprio executável: `OpenPortalLabService.exe
    // --selftest` roda tudo contra um Windows falso (nada é criado, alterado ou apagado
    // de verdade) e imprime um JSON com o resultado; sai com código 1 se algo falhar.
    // O Vitest (src/main/lab/__tests__/lab-service-binary.test.js) e o CI chamam isto.
    internal static class SelfTest
    {
        private const long Min = 60 * 1000;
        private const string OwnerSid = "S-1-5-21-9-9-9-1001";

        private sealed class Failure : Exception
        {
            public Failure(string message) : base(message) { }
        }

        private sealed class Rig
        {
            public FakeWindows Win = new FakeWindows();
            public MemoryStateStore Store = new MemoryStateStore();
            public FakeClock Clock = new FakeClock();
            public FakeRandom Random = new FakeRandom(7);
            public EngineOptions Options = new EngineOptions { OwnerSid = OwnerSid, InlineCleanup = true };
            public Engine Engine;

            public Rig()
            {
                Engine = new Engine(Win, Store, Clock, Random, new NullLog(), Options);
                Engine.Start();
            }

            // Simula o serviço caindo e subindo de novo sobre o mesmo estado e o mesmo Windows.
            public void Restart()
            {
                Engine = new Engine(Win, Store, Clock, Random, new NullLog(), Options);
                Engine.Start();
            }

            public string AddStudent(string label, int quotaGb = 25)
            {
                Result r = Engine.StudentCreate(label, quotaGb);
                Ok(r, "criar aluno " + label);
                return (string)r.Data["account"];
            }

            public Dictionary<string, object> Reserve(string account, long startMin = 30, long sessionMin = 60)
            {
                Result r = Engine.Reserve(account, startMin * Min, sessionMin * Min);
                Ok(r, "reservar " + account);
                return r.Data;
            }

            public int EnabledStudents()
            {
                return Engine.SnapshotForTests().Students.Count(s => Win.IsEnabled(s.Account));
            }

            public Reservation Reservation
            {
                get { return Engine.SnapshotForTests().Reservation; }
            }
        }

        private static void Check(bool condition, string what)
        {
            if (!condition) throw new Failure(what);
        }

        private static void Eq(object expected, object actual, string what)
        {
            if (!Equals(expected, actual)) throw new Failure(what + ": esperado <" + expected + ">, veio <" + actual + ">");
        }

        private static void Ok(Result r, string what)
        {
            if (!r.Ok) throw new Failure(what + " falhou: " + r.Error + " (" + r.Message + ")");
        }

        private static void Fails(Result r, string error, string what)
        {
            if (r.Ok) throw new Failure(what + " devia falhar com " + error);
            if (r.Error != error) throw new Failure(what + ": erro esperado " + error + ", veio " + r.Error);
        }

        private static List<KeyValuePair<string, Action>> Tests()
        {
            var t = new List<KeyValuePair<string, Action>>();
            Action<string, Action> add = (name, body) => t.Add(new KeyValuePair<string, Action>(name, body));

            // ---- Nomes, senhas, capacidade -----------------------------------
            add("names: slug drops accents, spaces and symbols", () =>
            {
                Eq("anasouza", Names.Slug("Ana Souza"), "Ana Souza");
                Eq("josedavila", Names.Slug("José d'Ávila"), "José d'Ávila");
                Eq("", Names.Slug("李雷"), "só ideogramas");
                Eq("joao3", Names.Slug("  João #3 "), "João #3");
            });
            add("names: derive falls back to 'aluno' and truncates to 12", () =>
            {
                Eq("aluno", Names.Derive("李雷", n => false), "vazio");
                Eq("abcdefghijkl", Names.Derive("abcdefghijklmnopqrstuvwxyz", n => false), "longo");
            });
            add("names: collisions get a numeric suffix that still fits in 12", () =>
            {
                var taken = new HashSet<string> { "ana", "ana2", "ana3" };
                Eq("ana4", Names.Derive("Ana", taken.Contains), "ana");
                var big = new HashSet<string> { "abcdefghijkl" };
                Eq("abcdefghijk2", Names.Derive("abcdefghijkl", big.Contains), "12 caracteres");
            });
            add("names: reserved names are never handed out", () =>
            {
                string admin = Names.Derive("Administrador", n => false);
                Check(admin != null && admin != "administrado" && admin != "administrador" && Names.IsValidAccount(admin), "administrador: " + admin);
                Eq("guest2", Names.Derive("Guest", n => false), "guest");
            });
            add("names: account validation rejects paths, case and length", () =>
            {
                foreach (string bad in new[] { "", "..", "a\\b", "a/b", "Ana", "a b", "abcdefghijklm", null, "ana;" })
                {
                    Check(!Names.IsValidAccount(bad), "devia recusar <" + bad + ">");
                }
                Check(Names.IsValidAccount("ana"), "ana");
                Check(Names.IsValidAccount("abcdefghijkl"), "12 caracteres");
            });
            add("names: label cleaning", () =>
            {
                Eq(null, Names.CleanLabel(""), "vazio");
                Eq(null, Names.CleanLabel("   "), "espaços");
                Eq(null, Names.CleanLabel(new string('a', 41)), "41 caracteres");
                Eq(null, Names.CleanLabel("Ana\nSouza"), "controle");
                Eq("Ana Souza", Names.CleanLabel("  Ana Souza "), "aparado");
                Check(Names.CleanLabel(new string('a', 40)) != null, "40 caracteres");
            });
            add("passwords: 16 chars, three classes, unambiguous, different every time", () =>
            {
                var seen = new HashSet<string>();
                IRandom[] sources = { new SecureRandom(), new FakeRandom(1) };
                foreach (IRandom source in sources)
                {
                    for (int i = 0; i < 300; i++)
                    {
                        string password = Passwords.Generate(source);
                        Check(Passwords.MeetsPolicy(password), "política: " + password.Length + " caracteres");
                        Check(password.IndexOfAny("0O1lI".ToCharArray()) < 0, "caractere ambíguo em " + password);
                        seen.Add(source.GetType().Name + password);
                    }
                }
                Check(seen.Count >= 598, "senhas repetidas demais: " + seen.Count);
            });
            add("capacity: recommendation table (5 on 250 GB, 28 on 1 TB)", () =>
            {
                var small = Capacity.Compute(250, 180, 25, 0, null);
                Eq(5, small["recommended"], "250 GB, 70 em uso");
                Eq(50.0, small["reserveGb"], "reserva de 20%");
                var large = Capacity.Compute(1000, 900, 25, 0, null);
                Eq(28, large["recommended"], "1 TB, 100 em uso");
                Eq(200.0, large["reserveGb"], "reserva de 20% de 1 TB");
                Eq(20.0, Capacity.Compute(60, 50, 25, 0, null)["reserveGb"], "reserva mínima de 20 GB");
                Eq(1, Capacity.Compute(60, 50, 25, 0, null)["recommended"], "disco pequeno");
                Eq(6, Capacity.Compute(250, 180, 25, 0, 30.0)["recommended"], "reserva editada");
                Eq(0, Capacity.Compute(250, 40, 25, 0, null)["recommended"], "disco quase cheio");
            });
            add("capacity: status ok, tight and over", () =>
            {
                Eq("ok", Capacity.Compute(250, 180, 25, 50, null)["status"], "50 GB para 130 livres");
                Eq("tight", Capacity.Compute(250, 180, 25, 125, null)["status"], "125 GB: não cabe mais um");
                Eq("over", Capacity.Compute(250, 180, 25, 131, null)["status"], "131 GB: passa do livre");
                Eq("over", Capacity.Compute(250, 30, 25, 0, null)["status"], "livre menor que a reserva");
            });

            add("quota: fsutil arguments are built only from validated values", () =>
            {
                Eq("quota track C:", Quota.TrackArgs("C:"), "track");
                Eq("quota enforce D:", Quota.EnforceArgs("D:"), "enforce");
                Eq(26843545600L, Quota.GbToBytes(25), "25 GB em bytes");
                Eq(24159191040L, Quota.WarnBytes(25), "aviso em 90%");
                Eq("quota modify C: 24159191040 26843545600 LABPC\\ana", Quota.ModifyArgs("C:", "LABPC", "ana", Quota.WarnBytes(25), Quota.GbToBytes(25)), "modify");
                Eq("quota modify C: -1 -1 LABPC\\ana", Quota.ClearArgs("C:", "LABPC", "ana"), "clear");
                Action[] refused =
                {
                    () => Quota.TrackArgs("C:\\Users"),
                    () => Quota.TrackArgs("c:"),
                    () => Quota.EnforceArgs(null),
                    () => Quota.ModifyArgs("C:", "LAB PC", "ana", 1, 2),
                    () => Quota.ModifyArgs("C:", "LABPC", "ana & calc", 1, 2),
                    () => Quota.ModifyArgs("C:", "LABPC", "Ana", 1, 2),
                    () => Quota.ModifyArgs("C:", "LABPC", "ana", 5, 2),
                    () => Quota.ModifyArgs("C:", "LABPC", "ana", 0, 0),
                    () => Quota.ClearArgs("C:", "LABPC", ".."),
                };
                foreach (Action bad in refused)
                {
                    bool threw = false;
                    try { bad(); } catch (ArgumentException) { threw = true; }
                    Check(threw, "devia recusar um argumento inválido");
                }
            });
            add("quota: reads the user of a quota entry from WMI and ignores other machines", () =>
            {
                Eq("ana", Quota.AccountFromWmiReference("\\\\LABPC\\root\\cimv2:Win32_Account.Domain=\"LABPC\",Name=\"ana\"", "LABPC"), "formato normal");
                Eq("ana", Quota.AccountFromWmiReference("Win32_Account.Name=\"ana\",Domain=\"labpc\"", "LABPC"), "ordem trocada e maiúsculas");
                Eq(null, Quota.AccountFromWmiReference("Win32_Account.Domain=\"ESCOLA\",Name=\"ana\"", "LABPC"), "conta de domínio");
                Eq(null, Quota.AccountFromWmiReference("lixo", "LABPC"), "texto qualquer");
                Eq(null, Quota.AccountFromWmiReference(null, "LABPC"), "nulo");
                Eq("enforce", Quota.StateName(2), "2");
                Eq("track", Quota.StateName(1), "1");
                Eq("off", Quota.StateName(0), "0");
                Eq("unknown", Quota.StateName(-1), "-1");
            });

            // ---- Protocolo ----------------------------------------------------
            add("protocol: bad JSON, oversize, unknown command", () =>
            {
                var rig = new Rig();
                Check(Protocol.Handle(rig.Engine, "{nope").Contains("bad-request"), "json inválido");
                Check(Protocol.Handle(rig.Engine, null).Contains("bad-request"), "nulo");
                string big = "{\"cmd\":\"status\",\"pad\":\"" + new string('x', Protocol.MaxRequestBytes) + "\"}";
                Check(Protocol.Handle(rig.Engine, big).Contains("bad-request"), "grande demais");
                Check(Protocol.Handle(rig.Engine, "{\"cmd\":\"format-c\"}").Contains("unsupported"), "comando desconhecido");
                Check(Protocol.Handle(rig.Engine, "{\"id\":\"7\",\"cmd\":\"status\"}").Contains("\"id\":\"7\""), "eco do id");
                Check(Protocol.Handle(rig.Engine, "{\"cmd\":\"events\"}").Contains("unsupported"), "events ainda não existe");
            });
            add("protocol: every field is validated before the engine is called", () =>
            {
                var rig = new Rig();
                string[] bad =
                {
                    "{\"cmd\":\"student-create\",\"label\":\"\",\"quotaGb\":25}",
                    "{\"cmd\":\"student-create\",\"label\":\"Ana\"}",
                    "{\"cmd\":\"student-create\",\"label\":\"Ana\",\"quotaGb\":\"25\"}",
                    "{\"cmd\":\"student-create\",\"label\":\"Ana\",\"quotaGb\":2.5}",
                    "{\"cmd\":\"student-create\",\"label\":\"Ana\",\"quotaGb\":0}",
                    "{\"cmd\":\"student-delete\",\"account\":\"..\\\\x\"}",
                    "{\"cmd\":\"student-delete\",\"account\":\"Ana\"}",
                    "{\"cmd\":\"reserve\",\"account\":\"ana\",\"startWithinMs\":1000,\"sessionMs\":3600000}",
                    "{\"cmd\":\"reserve\",\"account\":\"ana\",\"startWithinMs\":1800000}",
                    "{\"cmd\":\"extend\",\"reservationId\":\"x\",\"addMs\":60000}",
                    "{\"cmd\":\"end\",\"reservationId\":\"abcdefgh12\",\"reason\":\"deadline\"}",
                    "{\"cmd\":\"disk-info\",\"reserveGb\":-1}",
                    "{\"cmd\":\"disk-info\",\"quotaGb\":0}",
                };
                foreach (string line in bad)
                {
                    Check(Protocol.Handle(rig.Engine, line).Contains("\"ok\":false"), "devia recusar: " + line);
                }
                Eq(0, rig.Engine.SnapshotForTests().Students.Count, "nada foi criado");
                Eq(0, rig.Win.Accounts.Count, "o Windows não foi tocado");
            });
            add("protocol: the password appears only in the reserve answer", () =>
            {
                var rig = new Rig();
                string created = Protocol.Handle(rig.Engine, "{\"cmd\":\"student-create\",\"label\":\"Ana\",\"quotaGb\":25}");
                Check(created.Contains("\"account\":\"ana\""), "criou ana");
                string reserved = Protocol.Handle(rig.Engine, "{\"cmd\":\"reserve\",\"account\":\"ana\",\"startWithinMs\":1800000,\"sessionMs\":3600000}");
                Check(reserved.Contains("\"password\":\"" + rig.Win.Accounts["ana"].Password + "\""), "a senha vem na reserva");
                Check(reserved.Contains("\"userName\":\"LABPC\\\\ana\""), "usuário com o nome do PC");
                foreach (string other in new[]
                {
                    "{\"cmd\":\"status\"}", "{\"cmd\":\"disk-info\"}",
                    "{\"cmd\":\"student-set-quota\",\"account\":\"ana\",\"quotaGb\":30}",
                    "{\"cmd\":\"ensure-folder-access\",\"account\":\"ana\"}",
                })
                {
                    string answer = Protocol.Handle(rig.Engine, other);
                    Check(answer.Contains("\"ok\":true"), "devia dar certo: " + other);
                    Check(!answer.ToLowerInvariant().Contains("password"), "senha vazou em " + other);
                }
                Check(!rig.Store.Raw.ToLowerInvariant().Contains("password"), "a senha foi gravada no estado");
                Check(!rig.Store.Raw.Contains(rig.Win.Accounts["ana"].Password), "o valor da senha foi gravado no estado");
            });
            add("protocol: a response over 256 KiB becomes an internal error", () =>
            {
                var huge = Result.Success(new Dictionary<string, object> { { "x", new string('a', Protocol.MaxResponseBytes + 10) } });
                string text = Protocol.Respond("1", huge);
                Check(text.Contains("internal") && text.Length < 1000, "devia virar erro interno");
            });
            add("pipe auth: SYSTEM and the owner only", () =>
            {
                Check(PipeAuth.IsAllowed("S-1-5-18", OwnerSid), "SYSTEM");
                Check(PipeAuth.IsAllowed(OwnerSid, OwnerSid), "dono");
                Check(PipeAuth.IsAllowed(OwnerSid.ToLowerInvariant(), OwnerSid), "dono em minúsculas");
                Check(!PipeAuth.IsAllowed("S-1-5-21-9-9-9-1002", OwnerSid), "outra conta");
                Check(!PipeAuth.IsAllowed("S-1-5-32-544", OwnerSid), "grupo de administradores");
                Check(!PipeAuth.IsAllowed("", OwnerSid), "vazio");
                Check(!PipeAuth.IsAllowed(null, OwnerSid), "nulo");
                Check(!PipeAuth.IsAllowed("S-1-5-21-9-9-9-1001", ""), "sem dono configurado só o SYSTEM passa");
                Check(PipeAuth.IsAllowed("S-1-5-18", ""), "SYSTEM sem dono configurado");
            });

            // ---- Estado em disco ----------------------------------------------
            add("state: round trip, and corrupt entries are dropped", () =>
            {
                var rig = new Rig();
                string account = rig.AddStudent("Ana");
                rig.Reserve(account);
                LabState loaded = rig.Store.Load();
                Eq(1, loaded.Students.Count, "alunos");
                Eq(account, loaded.Reservation.Account, "reserva");
                var broken = Json.ParseObject("{\"students\":[{\"account\":\"Ana!\",\"label\":\"x\",\"quotaGb\":5},{\"account\":\"ok\",\"label\":\"Ok\",\"quotaGb\":5},7,null],\"reservation\":{\"id\":\"r1\",\"account\":\"semaluno\",\"state\":\"in-use\"}}");
                LabState cleaned = LabState.FromDict(broken);
                Eq(1, cleaned.Students.Count, "só o aluno válido fica");
                Check(cleaned.Reservation == null, "reserva de aluno inexistente é descartada");
                Check(LabState.FromDict(Json.ParseObject("[]")).Students.Count == 0, "estado que não é objeto");
            });
            add("state: the file store replaces the file whole and survives garbage", () =>
            {
                string dir = Path.Combine(Path.GetTempPath(), "oplab-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                try
                {
                    string path = Path.Combine(dir, "state.json");
                    var store = new FileStateStore(path);
                    Eq(0, store.Load().Students.Count, "arquivo ausente");
                    var state = new LabState();
                    state.Students.Add(new Student { Account = "ana", Label = "Ana", QuotaGb = 25 });
                    store.Save(state);
                    store.Save(state);
                    Check(!File.Exists(path + ".tmp"), "arquivo temporário sobrou");
                    Eq(1, new FileStateStore(path).Load().Students.Count, "leitura");
                    File.WriteAllText(path, "{{{ lixo");
                    Eq(0, new FileStateStore(path).Load().Students.Count, "arquivo corrompido");
                }
                finally
                {
                    Directory.Delete(dir, true);
                }
            });

            // ---- Alunos -------------------------------------------------------
            add("student-create: standard user, disabled, RDP group, quota, profile, owner access", () =>
            {
                var rig = new Rig();
                Result r = rig.Engine.StudentCreate("  Ana Souza ", 25);
                Ok(r, "criar");
                Eq("anasouza", r.Data["account"], "nome da conta");
                FakeAccount a = rig.Win.Accounts["anasouza"];
                Check(!a.Enabled, "a conta nasce desabilitada");
                Check(a.InRdpGroup && a.PasswordRequired, "grupo RDP e senha obrigatória");
                Check(a.HasProfile && a.OwnerGranted, "perfil criado e leitura do dono liberada");
                Eq(25L * 1024 * 1024 * 1024, a.QuotaLimit, "limite de cota");
                Eq(a.QuotaLimit / 10 * 9, a.QuotaWarn, "aviso em 90%");
                Eq("Ana Souza", rig.Engine.SnapshotForTests().Students[0].Label, "nome aparado");
                Eq("free", r.Data["state"], "estado");
            });
            add("student-create: a failure rolls everything back", () =>
            {
                var rig = new Rig();
                rig.Win.FailOn = "SetQuota";
                Fails(rig.Engine.StudentCreate("Ana", 25), "internal", "cota falha");
                Check(!rig.Win.Accounts.ContainsKey("ana"), "a conta não foi apagada");
                Eq(0, rig.Engine.SnapshotForTests().Students.Count, "o aluno não foi gravado");
                rig.Win.FailOn = "CreateAccount";
                Fails(rig.Engine.StudentCreate("Ana", 25), "internal", "criação falha");
                Eq(0, rig.Win.Accounts.Count, "nada ficou no Windows");
            });
            add("student-create: never reuses an existing Windows account or another student", () =>
            {
                var rig = new Rig();
                rig.Win.AddForeignAccount("ana");
                Eq("ana2", rig.AddStudent("Ana"), "conta que já existia");
                Eq("ana3", rig.AddStudent("Ana"), "aluno repetido");
                Check(rig.Win.Accounts["ana"].Enabled, "a conta alheia não foi tocada");
            });
            add("student-create: validation and the student limit", () =>
            {
                var rig = new Rig();
                Fails(rig.Engine.StudentCreate("", 25), "bad-request", "sem nome");
                Fails(rig.Engine.StudentCreate("Ana", 0), "bad-request", "cota 0");
                Fails(rig.Engine.StudentCreate("Ana", 2001), "bad-request", "cota 2001");
                Ok(rig.Engine.StudentCreate("Ana", 2000), "cota 2000");
                rig.Options.MaxStudents = 2;
                rig.AddStudent("Bia");
                Fails(rig.Engine.StudentCreate("Caio", 25), "full", "limite");
            });
            add("student-set-quota: changes the limit and keeps the 90% warning", () =>
            {
                var rig = new Rig();
                string account = rig.AddStudent("Ana");
                Ok(rig.Engine.StudentSetQuota(account, 40), "mudar");
                Eq(40L * 1024 * 1024 * 1024, rig.Win.Accounts[account].QuotaLimit, "limite");
                Eq(40, rig.Engine.SnapshotForTests().Students[0].QuotaGb, "gravado");
                Fails(rig.Engine.StudentSetQuota("naoexiste", 10), "not-found", "aluno inexistente");
                Fails(rig.Engine.StudentSetQuota(account, 0), "bad-request", "cota 0");
                rig.Win.FailOn = "SetQuota";
                Fails(rig.Engine.StudentSetQuota(account, 50), "internal", "falha");
                Eq(40, rig.Engine.SnapshotForTests().Students[0].QuotaGb, "a cota antiga continua");
            });
            add("student-delete: refused while reserved; otherwise logs off and removes everything", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string bia = rig.AddStudent("Bia");
                rig.Reserve(ana);
                Fails(rig.Engine.StudentDelete(ana), "busy", "aluno reservado");
                Check(rig.Win.Accounts.ContainsKey(ana), "a conta foi apagada mesmo assim");
                rig.Win.Accounts[bia].Enabled = true;
                rig.Win.Sessions.Add(new SessionInfo { Id = 99, State = "disconnected", UserName = bia });
                Ok(rig.Engine.StudentDelete(bia), "apagar");
                Check(!rig.Win.Accounts.ContainsKey(bia), "conta apagada");
                Check(rig.Win.Sessions.Count == 0, "sessão encerrada");
                Check(rig.Win.Calls.Contains("RemoveQuota " + bia) && rig.Win.Calls.Contains("DeleteProfile " + bia), "cota e perfil");
                Eq(1, rig.Engine.SnapshotForTests().Students.Count, "só a Ana sobrou");
                Fails(rig.Engine.StudentDelete(bia), "not-found", "apagar de novo");
            });

            // ---- Reserva ------------------------------------------------------
            add("reserve: enables only that account and disables any other student account", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string bia = rig.AddStudent("Bia");
                rig.Win.Accounts[bia].Enabled = true; // sobra de uma queda
                var data = rig.Reserve(ana);
                Check(rig.Win.Accounts[ana].Enabled && !rig.Win.Accounts[bia].Enabled, "só a Ana habilitada");
                Eq(1, rig.EnabledStudents(), "uma conta habilitada");
                Eq(rig.Win.Accounts[ana].Password, data["password"], "senha da resposta");
                Eq(rig.Clock.Now + 30 * Min, data["startBy"], "prazo para entrar");
                Eq(rig.Clock.Now + 90 * Min, data["endsAt"], "fim mais tardio");
                Check(rig.Win.Calls.IndexOf("Disable " + bia) < rig.Win.Calls.IndexOf("Enable " + ana), "desabilita as outras antes de habilitar");
            });
            add("reserve: a new password every time, and busy tells who and until when", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string bia = rig.AddStudent("Bia");
                var first = rig.Reserve(ana);
                Result busy = rig.Engine.Reserve(bia, 30 * Min, 60 * Min);
                Fails(busy, "busy", "segundo aluno");
                Eq(ana, busy.Data["account"], "quem está com o PC");
                Eq("Ana", busy.Data["label"], "nome de quem está com o PC");
                Eq(first["endsAt"], busy.Data["endsAt"], "até quando");
                Check(!rig.Win.Accounts[bia].Enabled, "a conta da Bia foi habilitada");
                Fails(rig.Engine.Reserve(ana, 30 * Min, 60 * Min), "busy", "o mesmo aluno de novo");
            });
            add("reserve: unknown student and out-of-range times", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                Fails(rig.Engine.Reserve("naoexiste", 30 * Min, 60 * Min), "not-found", "aluno inexistente");
                Fails(rig.Engine.Reserve(ana, 30 * 1000, 60 * Min), "bad-request", "prazo de 30 s");
                Fails(rig.Engine.Reserve(ana, 25 * 60 * Min, 60 * Min), "bad-request", "prazo de 25 h");
                Fails(rig.Engine.Reserve(ana, 30 * Min, 4 * Min), "bad-request", "sessão de 4 min");
                Fails(rig.Engine.Reserve(ana, 30 * Min, 13 * 60 * Min), "bad-request", "sessão de 13 h");
                Check(!rig.Win.Accounts[ana].Enabled && rig.Reservation == null, "nada foi reservado");
            });
            add("reserve: a failure leaves the account disabled and nothing reserved", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Win.FailOn = "Enable";
                Fails(rig.Engine.Reserve(ana, 30 * Min, 60 * Min), "internal", "habilitar falha");
                Check(!rig.Win.Accounts[ana].Enabled && rig.Reservation == null, "estado limpo");
                Ok(rig.Engine.Reserve(ana, 30 * Min, 60 * Min), "tentar de novo");
            });
            add("clock: the first sign-in starts the session clock", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                long reservedAt = rig.Clock.Now;
                rig.Clock.Advance(10 * Min);
                rig.Engine.Tick();
                Eq("reserved", rig.Reservation.State, "sem entrada ainda");
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                Eq("in-use", rig.Reservation.State, "entrou");
                Eq(reservedAt + 10 * Min, rig.Reservation.FirstLogonAt, "hora da entrada");
                Eq(reservedAt + 70 * Min, rig.Reservation.EndsAt, "fim = entrada + 60 min");
            });
            add("clock: at the deadline the session is logged off, the account disabled and no new sign-in works", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Win.Accounts[ana].OwnerGranted = false;
                rig.Win.Accounts[ana].PublicFiles.Add("deixei.txt");
                rig.Clock.Advance(59 * Min);
                rig.Engine.Tick();
                Eq("in-use", rig.Reservation.State, "ainda dentro do prazo");
                rig.Clock.Advance(2 * Min);
                rig.Engine.Tick();
                Check(rig.Reservation == null, "a reserva devia ter acabado");
                Eq(0, rig.Win.Sessions.Count, "sessões");
                Check(!rig.Win.Accounts[ana].Enabled, "conta desabilitada");
                bool refused = false;
                try { rig.Win.SignIn(ana); } catch (InvalidOperationException) { refused = true; }
                Check(refused, "a conta desabilitada deixou entrar");
                Eq(0, rig.Win.Accounts[ana].PublicFiles.Count, "limpou o que ficou em Public");
                Check(rig.Win.Accounts[ana].OwnerGranted, "reaplicou a leitura do dono");
                Check(rig.Engine.SnapshotForTests().Students[0].LastSessionEnd > 0, "última sessão registrada");
                Eq("free", rig.Engine.Status().Data["state"], "o PC ficou livre");
            });
            add("clock: one warning five minutes before the end, again after an extension", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                var data = rig.Reserve(ana, 30, 60);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Clock.Advance(54 * Min);
                rig.Engine.Tick();
                Eq(0, rig.Win.Messages.Count, "antes dos 5 minutos");
                rig.Clock.Advance(2 * Min);
                rig.Engine.Tick();
                rig.Engine.Tick();
                Eq(1, rig.Win.Messages.Count, "um aviso só");
                Check(rig.Win.Messages[0].Contains("minuto"), "texto do aviso");
                Ok(rig.Engine.Extend((string)data["reservationId"], 30 * Min), "estender");
                rig.Clock.Advance(30 * Min);
                rig.Engine.Tick();
                Eq(2, rig.Win.Messages.Count, "novo aviso depois da extensão");
                Check(rig.Reservation != null, "a sessão continua");
            });
            add("clock: an unused reservation expires and frees the PC", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                rig.Clock.Advance(29 * Min);
                rig.Engine.Tick();
                Check(rig.Reservation != null && rig.Win.Accounts[ana].Enabled, "ainda dentro do prazo");
                rig.Clock.Advance(2 * Min);
                rig.Engine.Tick();
                Check(rig.Reservation == null && !rig.Win.Accounts[ana].Enabled, "devia ter expirado");
            });
            add("clock: logging off frees the PC after a short grace; a disconnect does not", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                SessionInfo session = rig.Win.SignIn(ana);
                rig.Engine.Tick();
                session.State = "disconnected";
                rig.Clock.Advance(20 * 1000);
                rig.Engine.Tick();
                Check(rig.Reservation != null, "desconectar não encerra");
                rig.Win.Sessions.Clear();
                rig.Clock.Advance(10 * 1000);
                rig.Engine.Tick();
                Check(rig.Reservation != null, "dentro da tolerância");
                rig.Clock.Advance(10 * 1000);
                rig.Engine.Tick();
                Check(rig.Reservation == null && !rig.Win.Accounts[ana].Enabled, "o aluno saiu: o PC devia ficar livre");
            });
            add("clock: a disconnected session is still logged off at the deadline", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                rig.Win.SignIn(ana, "disconnected");
                rig.Engine.Tick();
                rig.Clock.Advance(61 * Min);
                rig.Engine.Tick();
                Check(rig.Win.Sessions.Count == 0 && rig.Reservation == null, "devia ter encerrado");
            });
            add("end: warns, waits, disables, logs off, and leaves no session", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                var data = rig.Reserve(ana);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                long before = rig.Clock.Now;
                rig.Win.Calls.Clear();
                Ok(rig.Engine.End((string)data["reservationId"], "manager-ended"), "encerrar");
                Check(rig.Clock.Now - before >= rig.Options.EndWarnDelayMs, "esperou depois do aviso");
                int message = rig.Win.Calls.FindIndex(c => c.StartsWith("SendMessage"));
                int disable = rig.Win.Calls.IndexOf("Disable " + ana);
                int logoff = rig.Win.Calls.FindIndex(c => c.StartsWith("Logoff"));
                Check(message >= 0 && message < disable && disable < logoff, "ordem: aviso, desabilitar, logoff");
                Eq(0, rig.Win.Sessions.Count, "sessões");
                Check(rig.Reservation == null && !rig.Win.Accounts[ana].Enabled, "livre e desabilitada");
            });
            add("end: an invalid id or reason changes nothing", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                var data = rig.Reserve(ana);
                Fails(rig.Engine.End("outraoutra1234", "manager-ended"), "not-found", "id errado");
                Fails(rig.Engine.End((string)data["reservationId"], "deadline"), "bad-request", "motivo de sistema");
                Check(rig.Reservation != null && rig.Win.Accounts[ana].Enabled, "a reserva foi mexida");
            });
            add("end: a session that will not log off keeps the reservation 'ending' and the clock retries", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string bia = rig.AddStudent("Bia");
                var data = rig.Reserve(ana);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Win.StubbornLogoffs = 100;
                Fails(rig.Engine.End((string)data["reservationId"], "manager-handover"), "logoff-failed", "logoff teimoso");
                Eq("ending", rig.Reservation.State, "estado");
                Check(!rig.Win.Accounts[ana].Enabled, "a conta já está desabilitada");
                Fails(rig.Engine.Reserve(bia, 30 * Min, 60 * Min), "busy", "não reserva por cima");
                rig.Win.StubbornLogoffs = 0;
                rig.Engine.Tick();
                Check(rig.Reservation != null, "espera o intervalo entre tentativas");
                rig.Clock.Advance(11 * 1000);
                rig.Engine.Tick();
                Check(rig.Reservation == null && rig.Win.Sessions.Count == 0, "a tentativa seguinte devia encerrar");
                Ok(rig.Engine.Reserve(bia, 30 * Min, 60 * Min), "agora pode reservar");
            });
            add("hand-over: end then reserve gives the next student a new password and never two at once", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string joao = rig.AddStudent("João");
                var first = rig.Reserve(ana);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                Ok(rig.Engine.End((string)first["reservationId"], "manager-handover"), "encerrar a Ana");
                Eq(0, rig.EnabledStudents(), "ninguém habilitado entre as duas");
                var second = rig.Reserve(joao);
                Eq(1, rig.EnabledStudents(), "só o João");
                Check(rig.Win.Accounts[joao].Enabled && !rig.Win.Accounts[ana].Enabled, "contas");
                Check(!Equals(first["password"], second["password"]), "senha repetida");
                bool refused = false;
                try { rig.Win.SignIn(ana); } catch (InvalidOperationException) { refused = true; }
                Check(refused, "a Ana ainda entra");
                Eq("joao", second["account"], "conta derivada de João");
            });
            add("extend: bounded, and refused for an unknown or ending reservation", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                var data = rig.Reserve(ana);
                string id = (string)data["reservationId"];
                Fails(rig.Engine.Extend("naoexiste123", 10 * Min), "not-found", "id errado");
                Fails(rig.Engine.Extend(id, 10 * 1000), "bad-request", "10 s");
                Fails(rig.Engine.Extend(id, 24 * 60 * Min), "bad-request", "passa de 24 h à frente");
                Result extended = rig.Engine.Extend(id, 15 * Min);
                Ok(extended, "estender 15 min");
                Eq((long)data["endsAt"] + 15 * Min, extended.Data["endsAt"], "novo fim");
            });

            // ---- Reinício ------------------------------------------------------
            add("restart: the deadline is still honoured after the service restarts", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Clock.Advance(30 * Min);
                rig.Restart();
                Eq("in-use", rig.Reservation.State, "o estado voltou do disco");
                rig.Clock.Advance(31 * Min);
                rig.Engine.Tick();
                Check(rig.Reservation == null && rig.Win.Sessions.Count == 0 && !rig.Win.Accounts[ana].Enabled, "o prazo vencido devia ser aplicado");
            });
            add("restart: a stray enabled student account is disabled", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                string bia = rig.AddStudent("Bia");
                rig.Reserve(ana);
                rig.Win.Accounts[bia].Enabled = true;
                rig.Restart();
                Check(rig.Win.Accounts[ana].Enabled && !rig.Win.Accounts[bia].Enabled, "só a reserva fica habilitada");
                var empty = new Rig();
                string caio = empty.AddStudent("Caio");
                empty.Win.Accounts[caio].Enabled = true;
                empty.Restart();
                Check(!empty.Win.Accounts[caio].Enabled, "sem reserva nenhuma conta fica habilitada");
            });
            add("restart: an end interrupted halfway is finished", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                var data = rig.Reserve(ana);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Win.StubbornLogoffs = 100;
                Fails(rig.Engine.End((string)data["reservationId"], "manager-ended"), "logoff-failed", "teimoso");
                rig.Win.StubbornLogoffs = 0;
                rig.Restart();
                Check(rig.Reservation == null && rig.Win.Sessions.Count == 0, "o reinício devia terminar o encerramento");
            });

            add("restart: after a reboot the student can sign back in until the deadline", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Reserve(ana, 30, 60);
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Win.Sessions.Clear(); // o PC reiniciou: a sessão sumiu, ninguém saiu
                rig.Restart();
                rig.Clock.Advance(5 * Min);
                rig.Engine.Tick();
                Check(rig.Reservation != null && rig.Win.Accounts[ana].Enabled, "a reserva devia continuar depois do reinício");
                rig.Win.SignIn(ana);
                rig.Engine.Tick();
                rig.Win.Sessions.Clear(); // agora sim, saiu com o serviço olhando
                rig.Clock.Advance(20 * 1000);
                rig.Engine.Tick();
                Check(rig.Reservation == null, "saiu depois de visto: o PC devia ficar livre");

                var late = new Rig();
                string bia = late.AddStudent("Bia");
                late.Reserve(bia, 30, 60);
                late.Win.SignIn(bia);
                late.Engine.Tick();
                late.Win.Sessions.Clear();
                late.Restart();
                late.Clock.Advance(61 * Min);
                late.Engine.Tick();
                Check(late.Reservation == null && !late.Win.Accounts[bia].Enabled, "sem voltar, o prazo ainda encerra");
            });

            // ---- Invariante, pasta, consultas ----------------------------------
            add("invariant: at most one student account is ever enabled, across a long scenario", () =>
            {
                var rig = new Rig();
                var accounts = new List<string> { rig.AddStudent("Ana"), rig.AddStudent("Bia"), rig.AddStudent("Caio") };
                var passwords = new HashSet<string>();
                for (int round = 0; round < 30; round++)
                {
                    string who = accounts[round % 3];
                    var data = rig.Reserve(who, 30, 60);
                    Check(passwords.Add((string)data["password"]), "senha repetida na rodada " + round);
                    Check(rig.EnabledStudents() <= 1, "duas contas habilitadas após reservar");
                    foreach (string other in accounts.Where(a => a != who))
                    {
                        Fails(rig.Engine.Reserve(other, 30 * Min, 60 * Min), "busy", "reserva dupla");
                    }
                    if (round % 3 != 0) rig.Win.SignIn(who);
                    rig.Engine.Tick();
                    if (round % 2 == 0) Ok(rig.Engine.End((string)data["reservationId"], "manager-ended"), "encerrar");
                    else { rig.Clock.Advance(100 * Min); rig.Engine.Tick(); }
                    Check(rig.EnabledStudents() == 0 && rig.Reservation == null, "o PC devia estar livre na rodada " + round);
                }
            });
            add("ensure-folder-access: grants the owner read access to a known student only", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.Win.Accounts[ana].OwnerGranted = false;
                Ok(rig.Engine.EnsureFolderAccess(ana), "liberar");
                Check(rig.Win.Accounts[ana].OwnerGranted, "concedeu");
                Fails(rig.Engine.EnsureFolderAccess("naoexiste"), "not-found", "aluno inexistente");
                rig.Win.FailOn = "GrantOwnerRead";
                Fails(rig.Engine.EnsureFolderAccess(ana), "internal", "falha");
            });
            add("status: shape, usage per student and disk", () =>
            {
                var rig = new Rig();
                string ana = rig.AddStudent("Ana");
                rig.AddStudent("Bia");
                rig.Win.Accounts[ana].QuotaUsed = 3L * 1024 * 1024 * 1024;
                Result free = rig.Engine.Status();
                Eq("free", free.Data["state"], "estado");
                Eq(2, free.Data["studentCount"], "alunos");
                Eq("enforce", free.Data["quota"], "cota");
                var disk = (Dictionary<string, object>)free.Data["disk"];
                Eq(250.0, disk["totalGb"], "disco");
                Eq(3.0, disk["usedByStudentsGb"], "ocupado pelos alunos");
                rig.Reserve(ana);
                Result busy = rig.Engine.Status();
                Eq("reserved", busy.Data["state"], "estado reservado");
                var reservation = (Dictionary<string, object>)busy.Data["reservation"];
                Eq("Ana", reservation["label"], "quem reservou");
                Check(!reservation.ContainsKey("password"), "senha no status");
                var students = (List<object>)busy.Data["students"];
                var first = (Dictionary<string, object>)students[0];
                Eq("reserved", first["state"], "estado do aluno");
                Eq(3L * 1024 * 1024 * 1024, first["usedBytes"], "bytes usados");
            });
            add("disk-info: capacity follows the assigned quotas", () =>
            {
                var rig = new Rig();
                Result empty = rig.Engine.DiskInfoResult(null, null);
                Eq(5, empty.Data["recommended"], "sem alunos");
                Eq("ok", empty.Data["status"], "sem alunos: ok");
                rig.AddStudent("Ana", 60);
                rig.AddStudent("Bia", 60);
                Result tight = rig.Engine.DiskInfoResult(null, null);
                Eq(120.0, tight.Data["assignedGb"], "soma das cotas");
                Eq("tight", tight.Data["status"], "120 de 130: não cabe mais um");
                rig.AddStudent("Caio", 60);
                Eq("over", rig.Engine.DiskInfoResult(null, null).Data["status"], "180 de 130");
                Eq("tight", rig.Engine.DiskInfoResult(0.0, 25.0).Data["status"], "sem reserva: 180 de 180 livres cabe, mas sem espaço para mais um");
            });
            add("status: stays answerable while a long operation holds the engine", () =>
            {
                var rig = new Rig();
                rig.AddStudent("Ana");
                Ok(rig.Engine.Status(), "primeira consulta enche o cache");
                rig.Win.BlockMs = 1500;
                Task slow = Task.Run(() => rig.Engine.StudentCreate("Bia", 25));
                Thread.Sleep(150);
                var watch = System.Diagnostics.Stopwatch.StartNew();
                Result during = rig.Engine.Status();
                watch.Stop();
                Check(watch.ElapsedMilliseconds < 1200, "a consulta esperou " + watch.ElapsedMilliseconds + " ms");
                Ok(during, "resposta durante a operação");
                Check(during.Data.ContainsKey("stale"), "devia vir marcada como antiga");
                slow.Wait();
                Check(!rig.Engine.Status().Data.ContainsKey("stale"), "depois volta a ser atual");
            });
            return t;
        }

        public static int Run()
        {
            var results = new List<object>();
            int failed = 0;
            foreach (KeyValuePair<string, Action> test in Tests())
            {
                string detail = "";
                bool ok = true;
                try
                {
                    test.Value();
                }
                catch (Exception ex)
                {
                    ok = false;
                    failed++;
                    detail = ex.GetType().Name + ": " + ex.Message;
                }
                results.Add(new Dictionary<string, object> { { "name", test.Key }, { "ok", ok }, { "detail", detail } });
            }
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(Json.Write(new Dictionary<string, object>
            {
                { "ok", failed == 0 },
                { "total", results.Count },
                { "failed", failed },
                { "results", results },
            }));
            return failed == 0 ? 0 : 1;
        }
    }
}
