using System;
using System.Security.Principal;
using System.Threading;

namespace OpenPortalLab
{
    internal sealed class StderrLog : ILog
    {
        public void Info(string message) { }

        public void Warn(string message)
        {
            Console.Error.WriteLine("WARN " + message);
        }
    }

    // Sobe o pipe REAL (PipeServer: ACL, SID do chamador, linhas, assíncrono) sobre um
    // motor com Windows falso, num pipe de nome próprio: dá para o teste do app falar
    // com ele de verdade, e conferir que outra conta não entra, sem criar nenhuma
    // conta do Windows. `--pipe-test <nome> <SID do dono | self>`.
    internal static class PipeHarness
    {
        public static int Run(string pipeName, string ownerArgument)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(pipeName, "^[A-Za-z0-9._-]{1,64}$") || pipeName == PipeServer.PipeName)
            {
                Console.Error.WriteLine("Nome de pipe de teste inválido (e nunca o pipe do serviço).");
                return 2;
            }
            string ownerSid = ownerArgument == "self" ? WindowsIdentity.GetCurrent().User.Value : ownerArgument;
            var windows = new FakeWindows();
            var options = new EngineOptions
            {
                OwnerSid = ownerSid,
                InlineCleanup = true,
                EndWarnDelayMs = 0,
                LogoffRetryDelayMs = 0,
            };
            var log = new StderrLog();
            var engine = new Engine(windows, new MemoryStateStore(), new SystemClock(), new SecureRandom(), log, options);
            engine.Start();
            var server = new PipeServer(engine, ownerSid, log, pipeName);
            server.Start();
            Console.WriteLine("READY");
            Console.Out.Flush();
            // Roda até o teste fechar a entrada padrão (ou 60 s, por segurança).
            var done = new ManualResetEventSlim(false);
            new Thread(() =>
            {
                try { Console.In.ReadToEnd(); } catch { }
                done.Set();
            }) { IsBackground = true }.Start();
            done.Wait(60 * 1000);
            server.Stop();
            return 0;
        }
    }
}
