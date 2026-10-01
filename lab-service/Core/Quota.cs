using System;
using System.Text.RegularExpressions;

namespace OpenPortalLab
{
    // Cota de disco NTFS por aluno (GOALS 17, G17-I5): a montagem dos argumentos do
    // fsutil e a leitura das respostas do WMI, em funções puras. Nenhum argumento
    // vem de texto livre: volume, máquina e conta passam por uma regra aqui antes de
    // virarem linha de comando.
    public static class Quota
    {
        public const int DefaultGb = 25;
        private const long GbBytes = 1024L * 1024 * 1024;

        private static readonly Regex VolumePattern = new Regex("^[A-Z]:$", RegexOptions.CultureInvariant);
        private static readonly Regex MachinePattern = new Regex("^[A-Za-z0-9_-]{1,15}$", RegexOptions.CultureInvariant);

        public static long GbToBytes(int gb)
        {
            return gb * GbBytes;
        }

        // O aviso chega aos 90% do limite.
        public static long WarnBytes(int gb)
        {
            return GbToBytes(gb) / 10 * 9;
        }

        public static string TrackArgs(string volume)
        {
            RequireVolume(volume);
            return "quota track " + volume;
        }

        public static string EnforceArgs(string volume)
        {
            RequireVolume(volume);
            return "quota enforce " + volume;
        }

        // fsutil quota modify <volume> <aviso> <limite> <MAQUINA\conta>
        public static string ModifyArgs(string volume, string machine, string account, long warnBytes, long limitBytes)
        {
            RequireVolume(volume);
            if (machine == null || !MachinePattern.IsMatch(machine)) throw new ArgumentException("nome da máquina inválido");
            if (!Names.IsValidAccount(account)) throw new ArgumentException("nome de conta inválido");
            if (warnBytes < 0 || limitBytes < 1 || warnBytes > limitBytes) throw new ArgumentException("cota inválida");
            return "quota modify " + volume + " " + warnBytes + " " + limitBytes + " " + machine + "\\" + account;
        }

        // Tira o limite da entrada (a entrada em si não se apaga pela linha de comando).
        public static string ClearArgs(string volume, string machine, string account)
        {
            RequireVolume(volume);
            if (machine == null || !MachinePattern.IsMatch(machine)) throw new ArgumentException("nome da máquina inválido");
            if (!Names.IsValidAccount(account)) throw new ArgumentException("nome de conta inválido");
            return "quota modify " + volume + " -1 -1 " + machine + "\\" + account;
        }

        // A referência que o WMI dá para o usuário de uma cota (Win32_DiskQuota.User):
        //   \\MAQUINA\root\cimv2:Win32_Account.Domain="MAQUINA",Name="ana"
        // Devolve a conta, ou null se for de outra máquina/domínio ou não puder ser lida.
        public static string AccountFromWmiReference(string reference, string machine)
        {
            if (string.IsNullOrEmpty(reference)) return null;
            Match domain = Regex.Match(reference, "Domain=\"([^\"]*)\"");
            Match name = Regex.Match(reference, "Name=\"([^\"]*)\"");
            if (!domain.Success || !name.Success) return null;
            if (!string.Equals(domain.Groups[1].Value, machine, StringComparison.OrdinalIgnoreCase)) return null;
            return name.Groups[1].Value;
        }

        // Win32_QuotaSetting.State: 0 desligada, 1 só conta, 2 recusa gravar acima do limite.
        public static string StateName(int wmiState)
        {
            return wmiState == 2 ? "enforce" : wmiState == 1 ? "track" : wmiState == 0 ? "off" : "unknown";
        }

        private static void RequireVolume(string volume)
        {
            if (volume == null || !VolumePattern.IsMatch(volume)) throw new ArgumentException("volume inválido");
        }
    }
}
