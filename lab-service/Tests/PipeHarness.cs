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

    // Relógio do pipe de teste: a hora de verdade mais um adiantamento que o teste controla
    // (`advance`), para provar prazos sem esperar.
    internal sealed class HarnessClock : IClock
    {
        private long offset;

        public long NowMs
        {
            get { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Interlocked.Read(ref offset); }
        }

        public void Sleep(int ms)
        {
            if (ms > 0) Interlocked.Add(ref offset, ms);
        }

        public void Advance(long ms)
        {
            Interlocked.Add(ref offset, ms);
        }
    }

    // Sobe o pipe REAL (PipeServer: ACL, SID do chamador, linhas, assíncrono) sobre um
    // motor com Windows falso, num pipe de nome próprio: dá para o teste do app falar
    // com ele de verdade, e conferir que outra conta não entra, sem criar nenhuma
    // conta do Windows. `--pipe-test <nome> <SID do dono | self>`.
    internal static class PipeHarness
    {
        public static int Run(string pipeName, string ownerArgument, string lifetimeSeconds = null)
        {
            // Vida máxima do pipe de teste (segurança contra um teste que esquece de fechar a entrada).
            int lifetimeMs = 60 * 1000;
            if (lifetimeSeconds != null)
            {
                int seconds;
                if (!int.TryParse(lifetimeSeconds, out seconds) || seconds < 1 || seconds > 24 * 3600)
                {
                    Console.Error.WriteLine("Segundos de vida inválidos (1 a 86400).");
                    return 2;
                }
                lifetimeMs = seconds * 1000;
            }
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
            var clock = new HarnessClock();
            var journal = new Journal(new MemoryJournalStorage(), clock, log);
            var engine = new Engine(windows, new MemoryStateStore(), clock, new SecureRandom(), log, options, journal);
            engine.Start();
            var server = new PipeServer(engine, ownerSid, log, pipeName);
            server.Start();
            Console.WriteLine("READY");
            Console.Out.Flush();
            // Roda até o teste fechar a entrada padrão (ou até o fim da vida máxima, por segurança).
            var done = new ManualResetEventSlim(false);
            new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null) Command(line.Trim(), windows, engine, clock);
                }
                catch { }
                done.Set();
            }) { IsBackground = true }.Start();
            done.Wait(lifetimeMs);
            server.Stop();
            return 0;
        }

        // Comandos de teste pela entrada padrão (uma linha cada), para simular o que o Windows faria:
        //   signin <conta> [ip]   uma sessão do aluno entra (imprime "SESSION <id>")
        //   disconnect <id> | reconnect <id> | logoff <id>
        //   tick                  um tique do relógio do motor
        //   advance <ms>          adianta o relógio
        // Cada resposta é uma linha "OK ..." ou "ERR ...".
        private static void Command(string line, FakeWindows windows, Engine engine, HarnessClock clock)
        {
            try
            {
                string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) return;
                lock (windows)
                {
                    switch (parts[0])
                    {
                        case "signin":
                        {
                            SessionInfo session = windows.SignIn(parts[1], "active", parts.Length > 2 ? parts[2] : null);
                            engine.OnSessionEvent(session.Id, "logon");
                            Console.WriteLine("SESSION " + session.Id);
                            break;
                        }
                        case "disconnect":
                            engine.OnSessionEvent(int.Parse(parts[1]), "disconnect");
                            Console.WriteLine("OK");
                            break;
                        case "reconnect":
                            engine.OnSessionEvent(int.Parse(parts[1]), "connect");
                            Console.WriteLine("OK");
                            break;
                        case "logoff":
                        {
                            int id = int.Parse(parts[1]);
                            windows.Sessions.RemoveAll(s => s.Id == id);
                            engine.OnSessionEvent(id, "logoff");
                            Console.WriteLine("OK");
                            break;
                        }
                        case "tick":
                            engine.Tick();
                            Console.WriteLine("OK");
                            break;
                        case "advance":
                            clock.Advance(long.Parse(parts[1]));
                            Console.WriteLine("OK");
                            break;
                        default:
                            Console.WriteLine("ERR comando desconhecido");
                            break;
                    }
                }
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERR " + ex.Message);
                Console.Out.Flush();
            }
        }
    }
}
