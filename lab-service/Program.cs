using System;
using System.Collections.Generic;
using System.Reflection;
using System.Security.Principal;
using System.ServiceProcess;

[assembly: AssemblyTitle("OpenPortal Lab Service")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace OpenPortalLab
{
    internal static class Program
    {
        // Sobe quando o SCM inicia o serviço. No terminal:
        //   --selftest  roda os testes do motor com um Windows falso (não altera nada)
        //   --probe     lê o estado real (sessões, disco, grupo RDP) sem alterar nada
        //   --version   imprime a versão
        //   --console   roda o serviço de verdade no terminal (precisa de administrador)
        private static int Main(string[] args)
        {
            string mode = args.Length > 0 ? args[0] : "";
            switch (mode)
            {
                case "--version":
                    Console.WriteLine(Assembly.GetExecutingAssembly().GetName().Version);
                    return 0;

                case "--selftest":
                    return SelfTest.Run();

                case "--probe":
                    return Probe();

                case "--pipe-test":
                    if (args.Length < 3)
                    {
                        Console.Error.WriteLine("Uso: --pipe-test <nome do pipe> <SID do dono | self> [segundos de vida, padrão 60]");
                        return 2;
                    }
                    return PipeHarness.Run(args[1], args[2], args.Length > 3 ? args[3] : null);

                case "--console":
                    return RunInConsole();

                default:
                    if (Environment.UserInteractive)
                    {
                        Console.Error.WriteLine("OpenPortalLabService: serviço do Windows do modo laboratório.");
                        Console.Error.WriteLine("Uso: --selftest | --probe | --version | --console");
                        return 2;
                    }
                    ServiceBase.Run(new LabService());
                    return 0;
            }
        }

        private static int RunInConsole()
        {
            if (!IsElevated())
            {
                Console.Error.WriteLine("--console precisa de um terminal de administrador.");
                return 3;
            }
            var service = new LabService();
            service.Boot();
            Console.WriteLine("Serviço rodando no terminal. Enter para parar.");
            Console.ReadLine();
            service.Shutdown();
            return 0;
        }

        private static bool IsElevated()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        // Só leituras: confere que as chamadas nativas e o WMI funcionam nesta máquina
        // (e mostra o que o serviço enxergaria), sem criar, alterar ou apagar nada.
        private static int Probe()
        {
            var report = new Dictionary<string, object>();
            var log = new NullLog();
            var windows = new WindowsApi(Environment.GetEnvironmentVariable("SystemDrive") ?? "C:", log);
            report["machine"] = windows.MachineName;
            report["elevated"] = IsElevated();
            Step(report, "ownAccountExists", () => windows.AccountExists(Environment.UserName.ToLowerInvariant()));
            Step(report, "ownAccountEnabled", () => windows.IsEnabled(Environment.UserName.ToLowerInvariant()));
            Step(report, "ownAccountSid", () => windows.GetSid(Environment.UserName.ToLowerInvariant()));
            Step(report, "ownSessions", () => windows.GetSessions(Environment.UserName.ToLowerInvariant()).Count);
            Step(report, "missingAccountExists", () => windows.AccountExists("opprobe0"));
            Step(report, "quotaState", () => windows.GetQuotaState().State);
            Step(report, "diskTotalGb", () => Math.Round(windows.GetDiskInfo().TotalGb, 1));
            Step(report, "diskFreeGb", () => Math.Round(windows.GetDiskInfo().FreeGb, 1));
            Step(report, "quotaEntries", () => windows.GetQuotaUsage().Count);
            Console.WriteLine(Json.Write(report));
            return 0;
        }

        private static void Step(Dictionary<string, object> report, string name, Func<object> read)
        {
            try
            {
                report[name] = read();
            }
            catch (Exception ex)
            {
                report[name] = "ERRO: " + ex.Message;
            }
        }
    }
}
