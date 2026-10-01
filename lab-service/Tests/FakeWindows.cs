using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenPortalLab
{
    // Windows de mentira, em memória, para os testes do motor: contas, sessões,
    // cota, pasta Public e um registro ordenado de tudo que foi pedido. Os campos
    // "Fail*" fazem o próximo uso falhar, para testar a volta atrás.
    public sealed class FakeClock : IClock
    {
        public long Now = 1000000000L;

        public long NowMs
        {
            get { return Now; }
        }

        public void Sleep(int ms)
        {
            Now += ms;
        }

        public void Advance(long ms)
        {
            Now += ms;
        }
    }

    // Aleatório determinístico (sequência fixa) para testar a geração de senha.
    public sealed class FakeRandom : IRandom
    {
        private long seed;

        public FakeRandom(long seed)
        {
            this.seed = seed;
        }

        public int Next(int max)
        {
            seed = (seed * 6364136223846793005L + 1442695040888963407L);
            return (int)((ulong)seed >> 33) % max;
        }
    }

    public sealed class FakeAccount
    {
        public string Name;
        public string Password;
        public bool Enabled;
        public string Sid;
        public bool HasProfile;
        public long QuotaWarn = -1;
        public long QuotaLimit = -1;
        public long QuotaUsed;
        public bool OwnerGranted;
        public bool InRdpGroup;
        public bool PasswordRequired;
        public List<string> PublicFiles = new List<string>();
    }

    public sealed class FakeWindows : IWindows
    {
        public readonly Dictionary<string, FakeAccount> Accounts = new Dictionary<string, FakeAccount>();
        public readonly List<SessionInfo> Sessions = new List<SessionInfo>();
        public readonly List<string> Calls = new List<string>();
        public readonly List<string> Messages = new List<string>();
        public string Quota = "enforce";
        public double TotalGb = 250;
        public double FreeGb = 180;
        public string FailOn;                      // nome da operação que deve falhar uma vez
        public int StubbornLogoffs;                // quantos logoffs a sessão ignora antes de sair
        public int BlockMs;                        // espera real dentro de CreateAccount (teste de bloqueio)
        public int PublicRemoved;
        private int nextSession = 3;

        public string MachineName
        {
            get { return "LABPC"; }
        }

        private void Record(string call)
        {
            Calls.Add(call);
            if (FailOn == call.Split(' ')[0])
            {
                FailOn = null;
                throw new InvalidOperationException("falha simulada em " + call);
            }
        }

        public int EnabledCount()
        {
            return Accounts.Values.Count(a => a.Enabled);
        }

        public bool AccountExists(string account)
        {
            return Accounts.ContainsKey(account);
        }

        // Para os testes: uma conta que já existia no Windows (não é de aluno).
        public void AddForeignAccount(string name)
        {
            Accounts[name] = new FakeAccount { Name = name, Enabled = true, Sid = "S-1-5-21-1-2-3-" + (1000 + Accounts.Count) };
        }

        public string CreateAccount(string account, string fullName, string password)
        {
            Record("CreateAccount " + account);
            if (BlockMs > 0) System.Threading.Thread.Sleep(BlockMs);
            var created = new FakeAccount
            {
                Name = account,
                Password = password,
                Enabled = false,
                Sid = "S-1-5-21-1-2-3-" + (1000 + Accounts.Count),
                InRdpGroup = true,
                PasswordRequired = true,
            };
            Accounts[account] = created;
            return created.Sid;
        }

        public void DeleteAccount(string account)
        {
            Record("DeleteAccount " + account);
            Accounts.Remove(account);
        }

        public void SetPassword(string account, string password)
        {
            Record("SetPassword " + account);
            Accounts[account].Password = password;
        }

        public void SetEnabled(string account, bool enabled)
        {
            Record((enabled ? "Enable " : "Disable ") + account);
            Accounts[account].Enabled = enabled;
        }

        public bool IsEnabled(string account)
        {
            return Accounts.ContainsKey(account) && Accounts[account].Enabled;
        }

        public string GetSid(string account)
        {
            return Accounts[account].Sid;
        }

        public List<SessionInfo> GetSessions(string account)
        {
            return Sessions.Where(s => s.UserName == account).ToList();
        }

        public SessionInfo SignIn(string account, string state = "active")
        {
            if (!Accounts[account].Enabled) throw new InvalidOperationException("conta desabilitada não entra");
            var session = new SessionInfo { Id = nextSession++, State = state, UserName = account };
            Sessions.Add(session);
            return session;
        }

        public void SendMessage(int sessionId, string title, string text)
        {
            Record("SendMessage " + sessionId);
            Messages.Add(text);
        }

        public bool Logoff(int sessionId)
        {
            Record("Logoff " + sessionId);
            if (StubbornLogoffs > 0)
            {
                StubbornLogoffs--;
                return false;
            }
            Sessions.RemoveAll(s => s.Id == sessionId);
            return true;
        }

        public void EnsureProfile(string account)
        {
            Record("EnsureProfile " + account);
            Accounts[account].HasProfile = true;
        }

        public void DeleteProfile(string account)
        {
            Record("DeleteProfile " + account);
            Accounts[account].HasProfile = false;
        }

        public void GrantOwnerRead(string account, string ownerSid)
        {
            Record("GrantOwnerRead " + account);
            Accounts[account].OwnerGranted = true;
        }

        public int CleanPublic(string account)
        {
            Record("CleanPublic " + account);
            int count = Accounts[account].PublicFiles.Count;
            Accounts[account].PublicFiles.Clear();
            PublicRemoved += count;
            return count;
        }

        public QuotaState GetQuotaState()
        {
            return new QuotaState { State = Quota };
        }

        public void EnableQuota()
        {
            Record("EnableQuota");
            Quota = "enforce";
        }

        public void SetQuota(string account, long warnBytes, long limitBytes)
        {
            Record("SetQuota " + account);
            Accounts[account].QuotaWarn = warnBytes;
            Accounts[account].QuotaLimit = limitBytes;
        }

        public void RemoveQuota(string account)
        {
            Record("RemoveQuota " + account);
            Accounts[account].QuotaLimit = -1;
        }

        public Dictionary<string, long> GetQuotaUsage()
        {
            var usage = new Dictionary<string, long>();
            foreach (FakeAccount a in Accounts.Values)
            {
                if (a.QuotaLimit >= 0) usage[a.Name] = a.QuotaUsed;
            }
            return usage;
        }

        public DiskInfo GetDiskInfo()
        {
            return new DiskInfo { TotalGb = TotalGb, FreeGb = FreeGb };
        }
    }
}
