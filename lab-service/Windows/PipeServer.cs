using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OpenPortalLab
{
    // O pipe local \\.\pipe\OpenPortalLab, assíncrono (a lição do GOALS 7: nada de
    // pipe duplex síncrono). Aberto só a SYSTEM e ao dono do app, fechado à rede, e
    // cada pedido é conferido de novo contra o SID de quem chamou. Uma conexão, um
    // pedido (uma linha), uma resposta (uma linha).
    internal sealed class PipeServer
    {
        public const string PipeName = "OpenPortalLab";
        private const int ReadTimeoutMs = 5000;

        private readonly Engine engine;
        private readonly string ownerSid;
        private readonly ILog log;
        private readonly string pipeName;
        private CancellationTokenSource cancel;
        private Task loop;

        // `pipeName` só muda no teste do pipe (--pipe-test); o serviço usa o padrão.
        public PipeServer(Engine engine, string ownerSid, ILog log, string pipeName = PipeName)
        {
            this.engine = engine;
            this.ownerSid = ownerSid;
            this.log = log;
            this.pipeName = pipeName;
        }

        public void Start()
        {
            cancel = new CancellationTokenSource();
            // A primeira instância nasce já, antes de Start() voltar: quem sobe o serviço (ou o
            // teste) pode confiar que o pipe existe.
            NamedPipeServerStream first = Create();
            loop = Task.Run(() => AcceptLoop(first, cancel.Token));
        }

        public void Stop()
        {
            if (cancel == null) return;
            cancel.Cancel();
            try { if (loop != null) loop.Wait(3000); } catch { }
        }

        private NamedPipeServerStream Create()
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            if (!string.IsNullOrEmpty(ownerSid))
            {
                // Synchronize: o cliente abre o pipe com GENERIC_READ|GENERIC_WRITE, que inclui SYNCHRONIZE.
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(ownerSid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
            }
            // Quem cria o pipe precisa poder abrir novas instâncias dele (FILE_CREATE_PIPE_INSTANCE):
            // o SYSTEM já tem controle total; no teste do pipe é a conta que rodou o teste. Sem
            // leitura nem escrita: isto não dá acesso ao conteúdo.
            SecurityIdentifier creator = WindowsIdentity.GetCurrent().User;
            if (creator != null)
            {
                security.AddAccessRule(new PipeAccessRule(creator, PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
            }
            // Acesso pela rede (SMB) negado de forma explícita: o pipe é só da máquina.
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            return new NamedPipeServerStream(pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 65536, security);
        }

        private async Task AcceptLoop(NamedPipeServerStream first, CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = first ?? Create();
                    first = null;
                    await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
                    NamedPipeServerStream accepted = pipe;
                    pipe = null;
                    var ignored = Task.Run(() => Serve(accepted));
                }
                catch (OperationCanceledException)
                {
                    if (pipe != null) pipe.Dispose();
                    break;
                }
                catch (Exception ex)
                {
                    log.Warn("pipe: " + ex.Message);
                    if (pipe != null) pipe.Dispose();
                    try { await Task.Delay(500, token).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                }
            }
        }

        private async Task Serve(NamedPipeServerStream pipe)
        {
            using (pipe)
            {
                try
                {
                    string line = await ReadLine(pipe).ConfigureAwait(false);

                    // O SID de quem chamou só pode ser lido depois do primeiro dado recebido.
                    string caller = null;
                    pipe.RunAsClient(() => { caller = WindowsIdentity.GetCurrent().User.Value; });
                    if (!PipeAuth.IsAllowed(caller, ownerSid))
                    {
                        log.Warn("pedido recusado: chamador " + caller + " não é o dono");
                        await Write(pipe, Protocol.Respond(null, Result.Fail("unauthorized", "Sem permissão para falar com o serviço"))).ConfigureAwait(false);
                        return;
                    }

                    string response = await Task.Run(() => Protocol.Handle(engine, line)).ConfigureAwait(false);
                    await Write(pipe, response).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    log.Warn("pedido do pipe falhou: " + ex.Message);
                }
            }
        }

        // Lê até o fim da linha; passou de 4 KiB sem quebra de linha, devolve o que
        // tem (o protocolo recusa por tamanho).
        private static async Task<string> ReadLine(NamedPipeServerStream pipe)
        {
            var collected = new MemoryStream();
            var buffer = new byte[1024];
            using (var timeout = new CancellationTokenSource(ReadTimeoutMs))
            {
                while (collected.Length <= Protocol.MaxRequestBytes)
                {
                    int read = await pipe.ReadAsync(buffer, 0, buffer.Length, timeout.Token).ConfigureAwait(false);
                    if (read == 0) break;
                    collected.Write(buffer, 0, read);
                    if (Array.IndexOf(buffer, (byte)'\n', 0, read) >= 0) break;
                }
            }
            string text = Encoding.UTF8.GetString(collected.ToArray());
            int newline = text.IndexOf('\n');
            return (newline >= 0 ? text.Substring(0, newline) : text).TrimEnd('\r');
        }

        private static async Task Write(NamedPipeServerStream pipe, string response)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(response + "\n");
            await pipe.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
            await pipe.FlushAsync().ConfigureAwait(false);
            try { pipe.WaitForPipeDrain(); } catch { }
        }
    }
}
