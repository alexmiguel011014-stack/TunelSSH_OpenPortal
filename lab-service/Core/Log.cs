using System;
using System.IO;
using System.Text;

namespace OpenPortalLab
{
    public interface ILog
    {
        void Info(string message);
        void Warn(string message);
    }

    // Registro em %ProgramData%\OpenPortal\lab\service.log (a pasta só abre para
    // SYSTEM e administradores). Nunca recebe senha: quem chama não a passa.
    public sealed class FileLog : ILog
    {
        private const long MaxBytes = 5 * 1024 * 1024;
        private readonly string path;
        private readonly object gate = new object();

        public FileLog(string path)
        {
            this.path = path;
        }

        public void Info(string message)
        {
            Write("INFO ", message);
        }

        public void Warn(string message)
        {
            Write("WARN ", message);
        }

        private void Write(string level, string message)
        {
            try
            {
                lock (gate)
                {
                    var info = new FileInfo(path);
                    if (info.Exists && info.Length > MaxBytes)
                    {
                        string old = path + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(path, old);
                    }
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + level + Clean(message) + Environment.NewLine;
                    File.AppendAllText(path, line, Encoding.UTF8);
                }
            }
            catch
            {
                // O registro nunca derruba o serviço.
            }
        }

        private static string Clean(string message)
        {
            return (message ?? "").Replace("\r", " ").Replace("\n", " ");
        }
    }

    public sealed class NullLog : ILog
    {
        public void Info(string message) { }
        public void Warn(string message) { }
    }
}
