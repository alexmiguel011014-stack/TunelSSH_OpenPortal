using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;

namespace OpenPortalLab
{
    // O serviço do Windows (LocalSystem). Só é registrado quando o dono liga o modo
    // laboratório (com UAC) e nunca escuta na rede: fala só pelo pipe local.
    internal sealed class LabService : ServiceBase
    {
        public const string Name = "OpenPortalLab";

        private Engine engine;
        private PipeServer pipe;
        private Timer timer;
        private ILog log = new NullLog();
        private int ticking;

        public LabService()
        {
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
        }

        public static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "OpenPortal", "lab"); }
        }

        // A pasta de dados só abre a SYSTEM e a administradores: o aluno não lê nem
        // altera o estado, o registro nem a configuração.
        private static void EnsureDataDir()
        {
            Directory.CreateDirectory(DataDir);
            var info = new DirectoryInfo(DataDir);
            DirectorySecurity security = info.GetAccessControl();
            security.SetAccessRuleProtection(true, false);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
            {
                security.RemoveAccessRule(rule);
            }
            var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            info.SetAccessControl(security);
        }

        // service.json: { "ownerSid": "S-1-5-21-...", "volume": "C:" }
        public static void ReadConfig(out string ownerSid, out string volume)
        {
            ownerSid = "";
            volume = Environment.GetEnvironmentVariable("SystemDrive") ?? "C:";
            string path = Path.Combine(DataDir, "service.json");
            if (!File.Exists(path)) return;
            var config = Json.ParseObject(File.ReadAllText(path));
            string sid = Json.Str(config, "ownerSid");
            if (sid != null && System.Text.RegularExpressions.Regex.IsMatch(sid, "^S-1-\\d+(-\\d+)+$")) ownerSid = sid;
            string vol = Json.Str(config, "volume");
            if (vol != null && System.Text.RegularExpressions.Regex.IsMatch(vol, "^[A-Z]:$")) volume = vol;
        }

        public void Boot()
        {
            EnsureDataDir();
            log = new FileLog(Path.Combine(DataDir, "service.log"));
            string ownerSid, volume;
            ReadConfig(out ownerSid, out volume);
            log.Info("iniciando (volume " + volume + (ownerSid.Length == 0 ? ", SEM dono configurado: só o SYSTEM fala com o pipe" : "") + ")");

            var windows = new WindowsApi(volume, log);
            var store = new FileStateStore(Path.Combine(DataDir, "state.json"));
            engine = new Engine(windows, store, new SystemClock(), new SecureRandom(), log, new EngineOptions { OwnerSid = ownerSid });
            engine.Start();
            pipe = new PipeServer(engine, ownerSid, log);
            pipe.Start();
            timer = new Timer(_ => Tick(), null, 1000, 1000);
        }

        private void Tick()
        {
            // Um tique por vez: se um encerramento demora, os próximos esperam.
            if (Interlocked.Exchange(ref ticking, 1) == 1) return;
            try
            {
                engine.Tick();
            }
            catch (Exception ex)
            {
                log.Warn("tique falhou: " + ex.Message);
            }
            finally
            {
                Interlocked.Exchange(ref ticking, 0);
            }
        }

        public void Shutdown()
        {
            if (timer != null) timer.Dispose();
            timer = null;
            if (pipe != null) pipe.Stop();
            log.Info("parado");
        }

        protected override void OnStart(string[] args)
        {
            Boot();
        }

        protected override void OnStop()
        {
            Shutdown();
        }

        protected override void OnShutdown()
        {
            Shutdown();
        }
    }
}
