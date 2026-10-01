using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenPortalLab
{
    // Chamadas nativas usadas pelo WindowsApi: NetApi32 (contas), WTS (sessões) e
    // UserEnv (perfil). Declarações de produção do Windows, sem texto livre.
    internal static class Native
    {
        public const int NERR_Success = 0;
        public const int NERR_UserNotFound = 2221;
        public const int ERROR_ACCESS_DENIED = 5;
        public const int ERROR_ALREADY_EXISTS_HRESULT = unchecked((int)0x800700B7);

        public const uint USER_PRIV_USER = 1;
        public const uint UF_SCRIPT = 0x0001;
        public const uint UF_ACCOUNTDISABLE = 0x0002;
        public const uint UF_PASSWD_CANT_CHANGE = 0x0040;
        public const uint UF_NORMAL_ACCOUNT = 0x0200;
        public const uint UF_DONT_EXPIRE_PASSWD = 0x10000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct USER_INFO_1
        {
            public string usri1_name;
            public string usri1_password;
            public uint usri1_password_age;
            public uint usri1_priv;
            public string usri1_home_dir;
            public string usri1_comment;
            public uint usri1_flags;
            public string usri1_script_path;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct USER_INFO_1003
        {
            public string usri1003_password;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct USER_INFO_1008
        {
            public uint usri1008_flags;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct USER_INFO_1011
        {
            public string usri1011_full_name;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct LOCALGROUP_MEMBERS_INFO_3
        {
            public string lgrmi3_domainandname;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int NetUserAdd(string servername, int level, ref USER_INFO_1 buf, out int parmErr);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int NetUserDel(string servername, string username);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int NetUserGetInfo(string servername, string username, int level, out IntPtr bufptr);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "NetUserSetInfo")]
        public static extern int NetUserSetInfo1003(string servername, string username, int level, ref USER_INFO_1003 buf, out int parmErr);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "NetUserSetInfo")]
        public static extern int NetUserSetInfo1008(string servername, string username, int level, ref USER_INFO_1008 buf, out int parmErr);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "NetUserSetInfo")]
        public static extern int NetUserSetInfo1011(string servername, string username, int level, ref USER_INFO_1011 buf, out int parmErr);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        public static extern int NetLocalGroupAddMembers(string servername, string groupname, int level, ref LOCALGROUP_MEMBERS_INFO_3 buf, int totalentries);

        [DllImport("netapi32.dll")]
        public static extern int NetApiBufferFree(IntPtr buffer);

        // ---- WTS ----

        public const int WTSUserName = 5;
        public const int WTSDomainName = 7;

        [StructLayout(LayoutKind.Sequential)]
        public struct WTS_SESSION_INFO
        {
            public int SessionId;
            public IntPtr pWinStationName;
            public int State;
        }

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int pCount);

        // Unicode de propósito: sem isso o .NET chama a versão ANSI e a string vem truncada.
        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);

        [DllImport("wtsapi32.dll")]
        public static extern void WTSFreeMemory(IntPtr memory);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSLogoffSession(IntPtr hServer, int sessionId, bool wait);

        [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool WTSSendMessage(
            IntPtr hServer, int sessionId, string title, int titleLength, string message, int messageLength,
            int style, int timeout, out int response, bool wait);

        // ---- Perfil ----

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        public static extern int CreateProfile(string userSid, string userName, StringBuilder profilePath, uint profilePathLength);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool DeleteProfile(string sidString, string profilePath, string computerName);

        public static string Describe(int code)
        {
            switch (code)
            {
                case 5: return "acesso negado (5)";
                case 2224: return "o usuário já existe (2224)";
                case 2221: return "usuário não encontrado (2221)";
                case 2245: return "senha fora da política do Windows (2245)";
                case 1379: return "o grupo já existe (1379)";
                case 1378: return "já é membro do grupo (1378)";
                default: return "código " + code;
            }
        }
    }
}
