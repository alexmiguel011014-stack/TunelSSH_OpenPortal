using System.Collections.Generic;

namespace OpenPortalLab
{
    public sealed class SessionInfo
    {
        public int Id;
        // "active", "connected", "disconnected" ou outro estado do WTS em minúsculas.
        public string State;
        public string UserName;
    }

    // Quem é e de onde vem uma sessão: a conta (minúscula, sem domínio) e o endereço IP do cliente
    // RDP (nulo no console local).
    public sealed class SessionDetails
    {
        public string Account;
        public string ClientAddress;
    }

    public sealed class DiskInfo
    {
        public double TotalGb;
        public double FreeGb;
    }

    public sealed class QuotaState
    {
        // "off", "track" (só conta) ou "enforce" (recusa gravar acima do limite).
        public string State;
    }

    // Tudo que o serviço pede ao Windows. A implementação real (WindowsApi.cs) usa
    // NetApi32, WTS, fsutil e o sistema de arquivos; o teste usa um Windows falso
    // em memória (Tests/FakeWindows.cs). Nenhum método recebe texto livre do
    // professor: contas e caminhos são montados pelo próprio serviço.
    public interface IWindows
    {
        string MachineName { get; }

        // Contas.
        bool AccountExists(string account);
        // Cria usuário comum, no grupo "Remote Desktop Users" (por SID), DESATIVADO,
        // com senha obrigatória. Devolve o SID.
        string CreateAccount(string account, string fullName, string password);
        void DeleteAccount(string account);
        void SetPassword(string account, string password);
        void SetEnabled(string account, bool enabled);
        bool IsEnabled(string account);
        string GetSid(string account);

        // Sessões.
        List<SessionInfo> GetSessions(string account);
        // Dados de uma sessão pelo número, ou nulo se ela não existe (ou ainda não tem usuário).
        SessionDetails QuerySession(int sessionId);
        void SendMessage(int sessionId, string title, string text);
        bool Logoff(int sessionId);

        // Pasta pessoal (perfil do Windows) e privacidade.
        void EnsureProfile(string account);
        void DeleteProfile(string account);
        void GrantOwnerRead(string account, string ownerSid);
        // A pasta do perfil (C:\Users\<conta>, ou o nome que o Windows escolheu), para o
        // gerente abrir somente leitura.
        string GetProfilePath(string account);
        // Apaga o que a conta deixou em C:\Users\Public. Devolve quantos itens.
        int CleanPublic(string account);

        // Cota de disco (NTFS, por usuário, no volume dos perfis).
        QuotaState GetQuotaState();
        void EnableQuota();
        void SetQuota(string account, long warnBytes, long limitBytes);
        void RemoveQuota(string account);
        // Bytes usados por conta (apenas contas com entrada de cota).
        Dictionary<string, long> GetQuotaUsage();

        DiskInfo GetDiskInfo();
    }
}
