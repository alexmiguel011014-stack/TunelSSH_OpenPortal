using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace OpenPortalLab
{
    // A implementação de verdade do IWindows: contas locais (NetApi32), sessões
    // (WTS), perfil (UserEnv), cota (fsutil + WMI) e permissões (icacls). Roda como
    // LocalSystem. Nada aqui recebe texto livre: o motor entrega nomes de conta já
    // validados (Names.IsValidAccount) e o volume vem da configuração do serviço.
    internal sealed class WindowsApi : IWindows
    {
        private const string RdpUsersSid = "S-1-5-32-555";
        private static readonly Regex VolumePattern = new Regex("^[A-Z]:$", RegexOptions.CultureInvariant);
        private static readonly Regex SidPattern = new Regex("^S-1-\\d+(-\\d+)+$", RegexOptions.CultureInvariant);

        private readonly string machine = Environment.MachineName;
        private readonly string volume;
        private readonly ILog log;

        public WindowsApi(string volume, ILog log)
        {
            if (!VolumePattern.IsMatch(volume ?? "")) throw new ArgumentException("volume inválido");
            this.volume = volume;
            this.log = log;
        }

        public string MachineName
        {
            get { return machine; }
        }

        // ---- Contas ---------------------------------------------------------

        public bool AccountExists(string account)
        {
            RequireAccount(account);
            IntPtr buffer;
            int code = Native.NetUserGetInfo(null, account, 1, out buffer);
            if (code == Native.NERR_Success)
            {
                Native.NetApiBufferFree(buffer);
                return true;
            }
            if (code == Native.NERR_UserNotFound) return false;
            throw new InvalidOperationException("NetUserGetInfo: " + Native.Describe(code));
        }

        public string CreateAccount(string account, string fullName, string password)
        {
            RequireAccount(account);
            var info = new Native.USER_INFO_1
            {
                usri1_name = account,
                usri1_password = password,
                usri1_priv = Native.USER_PRIV_USER,
                usri1_comment = "Aluno do laboratório (OpenPortal)",
                // Senha obrigatória (sem UF_PASSWD_NOTREQD), que o aluno não troca nem expira,
                // e a conta nasce DESATIVADA: só a reserva a habilita.
                usri1_flags = Native.UF_SCRIPT | Native.UF_NORMAL_ACCOUNT | Native.UF_PASSWD_CANT_CHANGE
                    | Native.UF_DONT_EXPIRE_PASSWD | Native.UF_ACCOUNTDISABLE,
            };
            int parmErr;
            int code = Native.NetUserAdd(null, 1, ref info, out parmErr);
            if (code != Native.NERR_Success) throw new InvalidOperationException("NetUserAdd: " + Native.Describe(code));

            try
            {
                var name = new Native.USER_INFO_1011 { usri1011_full_name = fullName };
                int full = Native.NetUserSetInfo1011(null, account, 1011, ref name, out parmErr);
                if (full != Native.NERR_Success) log.Warn("nome de exibição não gravado: " + Native.Describe(full));

                var member = new Native.LOCALGROUP_MEMBERS_INFO_3 { lgrmi3_domainandname = machine + "\\" + account };
                int added = Native.NetLocalGroupAddMembers(null, RemoteDesktopUsersGroup(), 3, ref member, 1);
                if (added != Native.NERR_Success && added != 1378)
                {
                    throw new InvalidOperationException("NetLocalGroupAddMembers: " + Native.Describe(added));
                }
                return GetSid(account);
            }
            catch
            {
                Native.NetUserDel(null, account);
                throw;
            }
        }

        // O nome do grupo "Remote Desktop Users" muda com o idioma do Windows: acha-se pelo SID.
        private static string RemoteDesktopUsersGroup()
        {
            var sid = new SecurityIdentifier(RdpUsersSid);
            string full = ((NTAccount)sid.Translate(typeof(NTAccount))).Value;
            int slash = full.IndexOf('\\');
            return slash >= 0 ? full.Substring(slash + 1) : full;
        }

        public void DeleteAccount(string account)
        {
            RequireAccount(account);
            int code = Native.NetUserDel(null, account);
            if (code != Native.NERR_Success && code != Native.NERR_UserNotFound)
            {
                throw new InvalidOperationException("NetUserDel: " + Native.Describe(code));
            }
        }

        public void SetPassword(string account, string password)
        {
            RequireAccount(account);
            var info = new Native.USER_INFO_1003 { usri1003_password = password };
            int parmErr;
            int code = Native.NetUserSetInfo1003(null, account, 1003, ref info, out parmErr);
            if (code != Native.NERR_Success) throw new InvalidOperationException("NetUserSetInfo(senha): " + Native.Describe(code));
        }

        private uint ReadFlags(string account)
        {
            IntPtr buffer;
            int code = Native.NetUserGetInfo(null, account, 1, out buffer);
            if (code != Native.NERR_Success) throw new InvalidOperationException("NetUserGetInfo: " + Native.Describe(code));
            try
            {
                return ((Native.USER_INFO_1)Marshal.PtrToStructure(buffer, typeof(Native.USER_INFO_1))).usri1_flags;
            }
            finally
            {
                Native.NetApiBufferFree(buffer);
            }
        }

        public bool IsEnabled(string account)
        {
            RequireAccount(account);
            if (!AccountExists(account)) return false;
            return (ReadFlags(account) & Native.UF_ACCOUNTDISABLE) == 0;
        }

        public void SetEnabled(string account, bool enabled)
        {
            RequireAccount(account);
            uint flags = ReadFlags(account);
            flags = enabled ? flags & ~Native.UF_ACCOUNTDISABLE : flags | Native.UF_ACCOUNTDISABLE;
            var info = new Native.USER_INFO_1008 { usri1008_flags = flags };
            int parmErr;
            int code = Native.NetUserSetInfo1008(null, account, 1008, ref info, out parmErr);
            if (code != Native.NERR_Success) throw new InvalidOperationException("NetUserSetInfo(flags): " + Native.Describe(code));
        }

        public string GetSid(string account)
        {
            RequireAccount(account);
            var name = new NTAccount(machine, account);
            return ((SecurityIdentifier)name.Translate(typeof(SecurityIdentifier))).Value;
        }

        private static void RequireAccount(string account)
        {
            if (!Names.IsValidAccount(account)) throw new ArgumentException("nome de conta inválido");
        }

        // ---- Sessões --------------------------------------------------------

        private static string StateName(int state)
        {
            switch (state)
            {
                case 0: return "active";
                case 1: return "connected";
                case 2: return "connectquery";
                case 3: return "shadow";
                case 4: return "disconnected";
                case 5: return "idle";
                default: return null; // Listen, Reset, Down, Init: não são sessões de usuário.
            }
        }

        private static string QueryString(int sessionId, int infoClass)
        {
            IntPtr buffer;
            int bytes;
            if (!Native.WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buffer, out bytes)) return "";
            try
            {
                return Marshal.PtrToStringUni(buffer) ?? "";
            }
            finally
            {
                Native.WTSFreeMemory(buffer);
            }
        }

        public List<SessionInfo> GetSessions(string account)
        {
            RequireAccount(account);
            var result = new List<SessionInfo>();
            IntPtr list;
            int count;
            if (!Native.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out list, out count))
            {
                throw new InvalidOperationException("WTSEnumerateSessions: erro " + Marshal.GetLastWin32Error());
            }
            try
            {
                int size = Marshal.SizeOf(typeof(Native.WTS_SESSION_INFO));
                for (int i = 0; i < count; i++)
                {
                    var info = (Native.WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(list, i * size), typeof(Native.WTS_SESSION_INFO));
                    string state = StateName(info.State);
                    if (state == null) continue;
                    string user = QueryString(info.SessionId, Native.WTSUserName);
                    if (!string.Equals(user, account, StringComparison.OrdinalIgnoreCase)) continue;
                    // Uma conta de domínio com o mesmo nome não é a conta local do aluno.
                    string domain = QueryString(info.SessionId, Native.WTSDomainName);
                    if (domain.Length > 0 && !string.Equals(domain, machine, StringComparison.OrdinalIgnoreCase)) continue;
                    result.Add(new SessionInfo { Id = info.SessionId, State = state, UserName = user });
                }
            }
            finally
            {
                Native.WTSFreeMemory(list);
            }
            return result;
        }

        public SessionDetails QuerySession(int sessionId)
        {
            string user = QueryString(sessionId, Native.WTSUserName);
            if (user.Length == 0) return null;
            string domain = QueryString(sessionId, Native.WTSDomainName);
            if (domain.Length > 0 && !string.Equals(domain, machine, StringComparison.OrdinalIgnoreCase)) return null;
            return new SessionDetails { Account = user.ToLowerInvariant(), ClientAddress = QueryClientAddress(sessionId) };
        }

        // WTS_CLIENT_ADDRESS: AddressFamily (4 bytes) e Address[20]; o IPv4 fica nos bytes 2 a 5 de
        // Address e o IPv6 nos bytes 2 a 17. Sessão de console não tem endereço.
        private static string QueryClientAddress(int sessionId)
        {
            IntPtr buffer;
            int bytes;
            if (!Native.WTSQuerySessionInformation(IntPtr.Zero, sessionId, Native.WTSClientAddress, out buffer, out bytes)) return null;
            try
            {
                if (bytes < 24) return null;
                int family = Marshal.ReadInt32(buffer, 0);
                int length = family == 2 ? 4 : family == 23 ? 16 : 0;
                if (length == 0) return null;
                var raw = new byte[length];
                Marshal.Copy(IntPtr.Add(buffer, 4 + 2), raw, 0, length);
                if (raw.All(b => b == 0)) return null;
                return new IPAddress(raw).ToString();
            }
            finally
            {
                Native.WTSFreeMemory(buffer);
            }
        }

        public void SendMessage(int sessionId, string title, string text)
        {
            int response;
            // Sem esperar a resposta (bWait false): foi o único jeito que a caixa apareceu
            // na sessão do aluno no G17-V1. Os tamanhos são em bytes (UTF-16).
            const int MB_OK_INFORMATION = 0x40;
            if (!Native.WTSSendMessage(IntPtr.Zero, sessionId, title, title.Length * 2, text, text.Length * 2,
                MB_OK_INFORMATION, 60, out response, false))
            {
                throw new InvalidOperationException("WTSSendMessage: erro " + Marshal.GetLastWin32Error());
            }
        }

        public bool Logoff(int sessionId)
        {
            return Native.WTSLogoffSession(IntPtr.Zero, sessionId, true);
        }

        // ---- Pasta pessoal --------------------------------------------------

        public string GetProfilePath(string account)
        {
            RequireAccount(account);
            string path = ProfilePath(account);
            if (!IsUnderUsers(path)) throw new InvalidOperationException("pasta do perfil fora de C:\\Users");
            return path;
        }

        private string ProfilePath(string account)
        {
            string sid = GetSid(account);
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid))
            {
                object path = key == null ? null : key.GetValue("ProfileImagePath");
                if (path != null) return Environment.ExpandEnvironmentVariables(path.ToString());
            }
            return Path.Combine(Environment.GetEnvironmentVariable("SystemDrive") + "\\", "Users", account);
        }

        public void EnsureProfile(string account)
        {
            RequireAccount(account);
            string sid = GetSid(account);
            var path = new StringBuilder(260);
            int hr = Native.CreateProfile(sid, account, path, (uint)path.Capacity);
            if (hr != 0 && hr != Native.ERROR_ALREADY_EXISTS_HRESULT)
            {
                throw new InvalidOperationException("CreateProfile: 0x" + hr.ToString("X8"));
            }
        }

        public void DeleteProfile(string account)
        {
            RequireAccount(account);
            string sid = GetSid(account);
            string path = ProfilePath(account);
            if (!Native.DeleteProfile(sid, null, null))
            {
                log.Warn("DeleteProfile falhou (erro " + Marshal.GetLastWin32Error() + "); apagando a pasta por conta própria");
            }
            if (Directory.Exists(path) && IsUnderUsers(path)) SafeDeleteTree(path, null);
        }

        private static bool IsUnderUsers(string path)
        {
            string users = Path.Combine(Environment.GetEnvironmentVariable("SystemDrive") + "\\", "Users");
            string full = Path.GetFullPath(path);
            return full.StartsWith(users + "\\", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(full, Path.Combine(users, "Public"), StringComparison.OrdinalIgnoreCase);
        }

        // O dono do app lê a pasta do aluno (para o gerente ver os arquivos). O aluno é
        // dono do que cria e poderia tirar essa leitura: por isso é reaplicada a cada sessão.
        public void GrantOwnerRead(string account, string ownerSid)
        {
            RequireAccount(account);
            if (!SidPattern.IsMatch(ownerSid ?? "")) throw new ArgumentException("SID do dono inválido");
            string path = ProfilePath(account);
            if (!Directory.Exists(path) || !IsUnderUsers(path)) throw new InvalidOperationException("pasta do perfil não encontrada");
            ProcResult result = Exec(Path.Combine(Environment.SystemDirectory, "icacls.exe"),
                "\"" + path + "\" /grant \"*" + ownerSid + ":(OI)(CI)RX\" /T /C /Q", 10 * 60 * 1000);
            if (result.ExitCode != 0) throw new InvalidOperationException("icacls saiu com " + result.ExitCode);
        }

        public int CleanPublic(string account)
        {
            RequireAccount(account);
            string publicDir = Environment.GetEnvironmentVariable("PUBLIC");
            if (string.IsNullOrEmpty(publicDir) || !Directory.Exists(publicDir)) return 0;
            var student = new SecurityIdentifier(GetSid(account));
            return CleanOwned(publicDir, student, false);
        }

        // Apaga o que é do aluno dentro de `dir`, sem nunca atravessar um ponto de
        // reparse (junção ou link simbólico): o aluno pode criar um apontando para
        // a pasta de outro, e o serviço roda como SYSTEM.
        private int CleanOwned(string dir, SecurityIdentifier owner, bool deleteDirIfEmpty)
        {
            int removed = 0;
            foreach (string path in Directory.GetFileSystemEntries(dir))
            {
                try
                {
                    FileAttributes attributes = File.GetAttributes(path);
                    bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                    bool isLink = (attributes & FileAttributes.ReparsePoint) != 0;
                    bool mine = OwnerOf(path, isDirectory) == owner;

                    if (isLink)
                    {
                        if (mine)
                        {
                            if (isDirectory) Directory.Delete(path, false);
                            else File.Delete(path);
                            removed++;
                        }
                    }
                    else if (isDirectory)
                    {
                        removed += CleanOwned(path, owner, mine);
                    }
                    else if (mine)
                    {
                        File.SetAttributes(path, FileAttributes.Normal);
                        File.Delete(path);
                        removed++;
                    }
                }
                catch (Exception ex)
                {
                    log.Warn("não apaguei " + path + ": " + ex.Message);
                }
            }
            if (deleteDirIfEmpty && !Directory.EnumerateFileSystemEntries(dir).Any())
            {
                Directory.Delete(dir, false);
                removed++;
            }
            return removed;
        }

        private static SecurityIdentifier OwnerOf(string path, bool isDirectory)
        {
            FileSystemSecurity security = isDirectory ? (FileSystemSecurity)new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner)
                : new FileInfo(path).GetAccessControl(AccessControlSections.Owner);
            return security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        }

        // Apaga uma árvore sem seguir pontos de reparse. `owner` null apaga tudo.
        private void SafeDeleteTree(string dir, SecurityIdentifier owner)
        {
            foreach (string path in Directory.GetFileSystemEntries(dir))
            {
                FileAttributes attributes = File.GetAttributes(path);
                bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                bool isLink = (attributes & FileAttributes.ReparsePoint) != 0;
                if (isDirectory && !isLink)
                {
                    SafeDeleteTree(path, owner);
                }
                else
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    if (isDirectory) Directory.Delete(path, false);
                    else File.Delete(path);
                }
            }
            Directory.Delete(dir, false);
        }

        // ---- Cota de disco --------------------------------------------------

        private string Fsutil
        {
            get { return Path.Combine(Environment.SystemDirectory, "fsutil.exe"); }
        }

        public QuotaState GetQuotaState()
        {
            try
            {
                string path = "'" + volume + "\\\\'";
                using (var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_QuotaSetting WHERE VolumePath=" + path))
                {
                    foreach (ManagementBaseObject item in searcher.Get())
                    {
                        object state = item["State"];
                        return new QuotaState { State = Quota.StateName(state == null ? -1 : Convert.ToInt32(state)) };
                    }
                }
            }
            catch (Exception ex)
            {
                log.Warn("estado da cota não lido: " + ex.Message);
            }
            // Plano B: o volume diz se há cota ligada, sem separar contar de recusar.
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT QuotasEnabled FROM Win32_Volume WHERE DriveLetter='" + volume + "'"))
                {
                    foreach (ManagementBaseObject item in searcher.Get())
                    {
                        object enabled = item["QuotasEnabled"];
                        if (enabled != null) return new QuotaState { State = Convert.ToBoolean(enabled) ? "on" : "off" };
                    }
                }
            }
            catch (Exception ex)
            {
                log.Warn("cota do volume não lida: " + ex.Message);
            }
            return new QuotaState { State = "unknown" };
        }

        public void EnableQuota()
        {
            Require(Exec(Fsutil, Quota.TrackArgs(volume), 30000), "fsutil quota track");
            Require(Exec(Fsutil, Quota.EnforceArgs(volume), 30000), "fsutil quota enforce");
        }

        public void SetQuota(string account, long warnBytes, long limitBytes)
        {
            RequireAccount(account);
            Require(Exec(Fsutil, Quota.ModifyArgs(volume, machine, account, warnBytes, limitBytes), 30000), "fsutil quota modify");
        }

        // Sem limite: o Windows não tem comando para apagar a entrada de um usuário. Com a
        // pasta e a conta apagadas, a entrada fica sem arquivos e sem efeito.
        public void RemoveQuota(string account)
        {
            RequireAccount(account);
            Exec(Fsutil, Quota.ClearArgs(volume, machine, account), 30000);
        }

        public Dictionary<string, long> GetQuotaUsage()
        {
            var usage = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            using (var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_DiskQuota"))
            {
                foreach (ManagementBaseObject item in searcher.Get())
                {
                    string account = Quota.AccountFromWmiReference(Convert.ToString(item["User"]), machine);
                    object used = item["DiskSpaceUsed"];
                    if (account != null && used != null) usage[account] = Convert.ToInt64(used);
                }
            }
            return usage;
        }

        public DiskInfo GetDiskInfo()
        {
            var drive = new DriveInfo(volume);
            const double Gb = 1024.0 * 1024 * 1024;
            return new DiskInfo { TotalGb = drive.TotalSize / Gb, FreeGb = drive.AvailableFreeSpace / Gb };
        }

        // ---- Processos ------------------------------------------------------

        private sealed class ProcResult
        {
            public int ExitCode;
            public string Output;
        }

        private ProcResult Exec(string file, string arguments, int timeoutMs)
        {
            var start = new ProcessStartInfo(file, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (Process process = Process.Start(start))
            {
                var output = new StringBuilder();
                process.OutputDataReceived += (s, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                process.ErrorDataReceived += (s, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    throw new TimeoutException(Path.GetFileName(file) + " não terminou em " + timeoutMs / 1000 + "s");
                }
                process.WaitForExit();
                return new ProcResult { ExitCode = process.ExitCode, Output = output.ToString() };
            }
        }

        private void Require(ProcResult result, string what)
        {
            if (result.ExitCode != 0)
            {
                log.Warn(what + " saiu com " + result.ExitCode + ": " + result.Output.Trim());
                throw new InvalidOperationException(what + " falhou (" + result.ExitCode + ")");
            }
        }
    }
}
