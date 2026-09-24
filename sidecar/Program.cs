using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using AxMSTSCLib;
using MSTSCLib;

namespace OpenPortalRdpSidecar
{
    // GOALS 2 (RDP nativo): sidecar que hospeda o controle ActiveX MSTSCLib
    // (via os assemblies de interop pré-compilados do pacote NuGet
    // Devolutions.MsRdpEx, modo "Legacy" — mesmas Interop.MSTSCLib.dll/
    // AxInterop.MSTSCLib.dll que `aximp`/`tlbimp` gerariam à mão) reparented
    // dentro do HWND do BrowserWindow do Electron. Recebe comandos do
    // processo principal via named pipe (nunca por argv, pra senha nunca
    // aparecer em Get-Process/Task Manager) — ver GOALS.md, seção "GOALS 2".
    //
    // Contrato de argv (nada sensível aqui):
    //   <pipeName> <parentHwnd> <x> <y> <w> <h> <hostMode> <lifecycleId> <ownerPid>
    //   [<ipcTransport>] — só no modo ipc-test, para a comparação do G7-R4
    // Contrato do pipe: uma linha JSON por comando, UTF-8, terminada em \n:
    //   {"cmd":"resize","x":10,"y":10,"w":800,"h":600}
    //   {"cmd":"connect","host":"100.x.x.x","port":3389,"username":"u","password":"p"}
    //   {"cmd":"visibility","visible":true}
    //   {"cmd":"disconnect"}
    static class Program
    {
        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetThreadDpiAwarenessContext();

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll")]
        static extern void SetLastError(uint dwErrCode);

        [DllImport("user32.dll")]
        internal static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        static extern bool IsWindow(IntPtr hWnd);

        // G7-R4: marcadores de início/fim das operações do pipe no stderr,
        // ligados só quando o modo ipc-test recebe um transporte explícito.
        static bool s_traceIpc;
        static uint s_uiThreadId;

        internal static void IpcTrace(string text)
        {
            if (!s_traceIpc) return;
            uint thread = GetCurrentThreadId();
            try
            {
                Console.Error.WriteLine(
                    "[ipc] thread=" + (thread == s_uiThreadId ? "ui" : "worker") + " " + text
                );
            }
            catch
            {
            }
        }

        internal const int GWL_STYLE = -16;
        const int WS_CHILD = 0x40000000;
        const int WS_POPUP = unchecked((int)0x80000000);
        const int WS_CAPTION = 0x00C00000;
        const int WS_MINIMIZE = 0x20000000;
        internal const uint SWP_NOZORDER = 0x0004;
        internal const uint SWP_NOACTIVATE = 0x0010;
        const int SW_HIDE = 0;
        const int SW_SHOWNORMAL = 1;

        static void Reparent(SidecarForm form, IntPtr parentHwnd, int x, int y, int w, int h)
        {
            int style = GetWindowLong(form.Handle, GWL_STYLE);
            // -32000,-32000 (retângulo de "minimizado" do Windows) aparece se
            // WS_MINIMIZE ficar setado quando reposicionamos — limpar aqui
            // evita o bug já visto e documentado no GOALS.md.
            style = (style & ~WS_POPUP & ~WS_CAPTION & ~WS_MINIMIZE) | WS_CHILD;
            SetWindowLong(form.Handle, GWL_STYLE, style);
            SetLastError(0);
            SetParent(form.Handle, parentHwnd);
            int setParentError = Marshal.GetLastWin32Error();
            ShowWindow(form.Handle, SW_SHOWNORMAL);
            // form.Location não serve mais uma vez WS_CHILD: WinForms ainda
            // pensa em coordenadas de tela, mas o Windows já espera
            // coordenadas relativas ao pai — SetWindowPos direto é o que
            // funciona sem ambiguidade.
            bool positioned = SetWindowPos(
                form.Handle,
                IntPtr.Zero,
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE
            );
            form.RecordEmbeddingResult(setParentError, positioned);
        }

        [STAThread]
        static void Main(string[] args)
        {
            string pipeName = args.Length >= 1 ? args[0] : null;
            IntPtr parentHwnd = IntPtr.Zero;
            if (args.Length >= 2 && long.TryParse(args[1], out long h0)) parentHwnd = new IntPtr(h0);
            int x = 100, y = 100, w = 640, h = 480;
            if (args.Length >= 6)
            {
                int.TryParse(args[2], out x);
                int.TryParse(args[3], out y);
                int.TryParse(args[4], out w);
                int.TryParse(args[5], out h);
            }
            string requestedHostMode = args.Length >= 7 ? args[6] : null;
            string hostMode = requestedHostMode == "native-window" || requestedHostMode == "ipc-test"
                ? requestedHostMode
                : "embedded";
            string lifecycleId = args.Length >= 8 && !string.IsNullOrWhiteSpace(args[7])
                ? args[7]
                : "legacy";
            int ownerPid = 0;
            if (args.Length >= 9) int.TryParse(args[8], out ownerPid);
            // G7-R4: só o modo ipc-test aceita outro transporte, para a
            // comparação medida; conexões reais usam sempre o duplex assíncrono.
            string ipcTransport = "async-duplex";
            if (hostMode == "ipc-test" && args.Length >= 10)
            {
                ipcTransport = args[9];
                s_traceIpc = true;
            }
            s_uiThreadId = GetCurrentThreadId();

            Application.EnableVisualStyles();

            var form = new SidecarForm(hostMode, lifecycleId, parentHwnd, hostMode != "ipc-test")
            {
                StartPosition = hostMode == "embedded"
                    ? FormStartPosition.Manual
                    : FormStartPosition.CenterScreen,
                FormBorderStyle = hostMode == "embedded"
                    ? FormBorderStyle.None
                    : FormBorderStyle.Sizable,
                Text = hostMode == "embedded" ? "OpenPortal RDP" : "OpenPortal RDP — modo compatível",
                Size = new Size(w, h),
                MinimumSize = hostMode == "embedded" ? Size.Empty : new Size(480, 320),
            };
            if (hostMode == "embedded") form.Location = new Point(x, y);

            // O pipe só passa a aceitar comandos depois de Shown + primeira
            // volta do loop visual + handle explícito do ActiveX. Isso elimina
            // a corrida em que Connect() chegava antes de o host COM estar pronto.
            form.Shown += (sender, eventArgs) => form.BeginInvoke((MethodInvoker)delegate
            {
                form.PrepareControl();
                if (hostMode == "embedded" && parentHwnd != IntPtr.Zero)
                {
                    Reparent(form, parentHwnd, x, y, w, h);
                }
                if (!string.IsNullOrEmpty(pipeName))
                {
                    var listenerThread = new Thread(() => RunPipeServer(pipeName, form, ipcTransport));
                    listenerThread.IsBackground = true;
                    listenerThread.Start();
                }
            });

            if (ownerPid > 0)
            {
                var ownerThread = new Thread(() => MonitorOwner(form, ownerPid, parentHwnd, hostMode));
                ownerThread.IsBackground = true;
                ownerThread.Start();
            }

            Application.Run(form);
        }

        static void MonitorOwner(SidecarForm form, int ownerPid, IntPtr parentHwnd, string hostMode)
        {
            while (!form.IsDisposed)
            {
                bool ownerAlive;
                try
                {
                    using (var owner = Process.GetProcessById(ownerPid))
                    {
                        ownerAlive = !owner.HasExited;
                    }
                }
                catch
                {
                    ownerAlive = false;
                }

                bool parentAlive = hostMode != "embedded" || parentHwnd == IntPtr.Zero || IsWindow(parentHwnd);
                if (!ownerAlive || !parentAlive)
                {
                    ExitForm(form);
                    return;
                }
                Thread.Sleep(1000);
            }
        }

        internal static void ExitForm(SidecarForm form)
        {
            if (form.IsDisposed || !form.IsHandleCreated) return;
            try
            {
                form.BeginInvoke((MethodInvoker)delegate
                {
                    form.DisconnectRdp();
                    Application.Exit();
                });
            }
            catch (InvalidOperationException)
            {
            }
        }

        // Roda numa thread separada da UI — cada comando recebido é
        // enfileirado de volta na thread da UI via BeginInvoke antes de
        // tocar em qualquer Win32/WinForms (regra de ouro do WinForms:
        // só a thread que criou o handle pode mexer nele).
        static void RunPipeServer(string pipeName, SidecarForm form, string ipcTransport)
        {
            try
            {
                if (ipcTransport == "sync-duplex") RunSyncDuplexPipe(pipeName, form);
                else if (ipcTransport == "split") RunSplitPipes(pipeName, form);
                else RunAsyncDuplexPipe(pipeName, form);
            }
            catch (ObjectDisposedException)
            {
            }
            catch
            {
                // O nome do pipe é exclusivo desta geração; o processo
                // principal não reconecta. Encerrar evita uma sidecar órfã.
                ExitForm(form);
            }
        }

        static PipeSecurity OwnerOnlyPipeSecurity()
        {
            var pipeSecurity = new PipeSecurity();
            pipeSecurity.SetAccessRuleProtection(true, false);
            pipeSecurity.AddAccessRule(new PipeAccessRule(
                WindowsIdentity.GetCurrent().User,
                PipeAccessRights.FullControl,
                AccessControlType.Allow
            ));
            return pipeSecurity;
        }

        // Transporte em uso (GOALS 7): um pipe duplex aberto com
        // PipeOptions.Asynchronous, leitura e escrita independentes, e status
        // publicados por uma fila consumida fora da thread da UI.
        static void RunAsyncDuplexPipe(string pipeName, SidecarForm form)
        {
            using (var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                0,
                0,
                OwnerOnlyPipeSecurity()
            ))
            {
                server.WaitForConnection();
                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(server, Encoding.UTF8, true, 1024, true))
                using (var channel = new StatusChannel(writer, form, true))
                {
                    try
                    {
                        ReadCommands(reader, form, true);
                    }
                    finally
                    {
                        if (!channel.Complete()) server.Dispose();
                    }
                    ExitForm(form);
                }
            }
        }

        // G7-R4 (a), só no modo ipc-test: o transporte anterior ao GOALS 7 —
        // pipe duplex síncrono, com o status escrito pela thread que o gera
        // (a da UI). Existe só para medir o defeito ao lado das alternativas.
        static void RunSyncDuplexPipe(string pipeName, SidecarForm form)
        {
            using (var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.None,
                0,
                0,
                OwnerOnlyPipeSecurity()
            ))
            {
                server.WaitForConnection();
                var serializer = new JavaScriptSerializer();
                var writeLock = new object();
                using (var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(server, Encoding.UTF8, true, 1024, true))
                {
                    form.SetStatusReporter(message =>
                    {
                        lock (writeLock)
                        {
                            try
                            {
                                IpcTrace("status-write-begin " + message.eventName);
                                writer.WriteLine(serializer.Serialize(message));
                                writer.Flush();
                                IpcTrace("status-write-end " + message.eventName);
                            }
                            catch
                            {
                                IpcTrace("status-write-failed " + message.eventName);
                            }
                        }
                    });
                    try
                    {
                        ReadCommands(reader, form, false);
                    }
                    finally
                    {
                        form.SetStatusReporter(null);
                    }
                    ExitForm(form);
                }
            }
        }

        // G7-R4 (c), só no modo ipc-test: dois pipes independentes, comandos em
        // "<nome>-cmd" e status em "<nome>-status", cada um usado num sentido
        // e na sua thread. É a alternativa medida contra o duplex assíncrono.
        // Os dois handles são InOut: o cliente `net` do Node sempre lê do pipe
        // e fecha na hora um pipe só de entrada (PipeDirection.In).
        static void RunSplitPipes(string pipeName, SidecarForm form)
        {
            using (var commandPipe = new NamedPipeServerStream(
                pipeName + "-cmd",
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.None,
                0,
                0,
                OwnerOnlyPipeSecurity()
            ))
            using (var statusPipe = new NamedPipeServerStream(
                pipeName + "-status",
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.None,
                0,
                0,
                OwnerOnlyPipeSecurity()
            ))
            {
                statusPipe.WaitForConnection();
                commandPipe.WaitForConnection();
                using (var writer = new StreamWriter(statusPipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(commandPipe, Encoding.UTF8, true, 1024, true))
                using (var channel = new StatusChannel(writer, form, false))
                {
                    try
                    {
                        ReadCommands(reader, form, false);
                    }
                    finally
                    {
                        if (!channel.Complete()) statusPipe.Dispose();
                    }
                    ExitForm(form);
                }
            }
        }

        static void ReadCommands(StreamReader reader, SidecarForm form, bool asyncReads)
        {
            var commandSerializer = new JavaScriptSerializer();
            while (true)
            {
                IpcTrace("command-read-begin");
                string line = asyncReads
                    ? reader.ReadLineAsync().GetAwaiter().GetResult()
                    : reader.ReadLine();
                IpcTrace("command-read-end");
                if (line == null) return;
                object parsed;
                try
                {
                    parsed = commandSerializer.DeserializeObject(line);
                }
                catch
                {
                    continue;
                }
                var cmd = parsed as System.Collections.Generic.Dictionary<string, object>;
                if (cmd == null) continue;
                DispatchCommand(form, cmd);
            }
        }

        static void DispatchCommand(SidecarForm form, System.Collections.Generic.Dictionary<string, object> cmd)
        {
            if (!cmd.ContainsKey("cmd")) return;
            string type = Convert.ToString(cmd["cmd"]);

            string lifecycleId = cmd.ContainsKey("lifecycleId")
                ? Convert.ToString(cmd["lifecycleId"])
                : null;
            if (form.IsDisposed || !form.AcceptsLifecycle(lifecycleId)) return;
            form.BeginInvoke((MethodInvoker)delegate
            {
                if (form.IsDisposed || !form.AcceptsLifecycle(lifecycleId)) return;
                switch (type)
                {
                    case "resize":
                        int rx = Convert.ToInt32(cmd["x"]);
                        int ry = Convert.ToInt32(cmd["y"]);
                        int rw = Convert.ToInt32(cmd["w"]);
                        int rh = Convert.ToInt32(cmd["h"]);
                        form.ResizeHost(rx, ry, rw, rh);
                        break;

                    case "connect":
                        // Nunca loga a senha — só chega por aqui vinda do
                        // pipe, nunca por argv (ver contrato no topo do arquivo).
                        string host = cmd.ContainsKey("host") ? Convert.ToString(cmd["host"]) : "";
                        string username = cmd.ContainsKey("username") ? Convert.ToString(cmd["username"]) : "";
                        string password = cmd.ContainsKey("password") ? Convert.ToString(cmd["password"]) : "";
                        int port = cmd.ContainsKey("port") ? Convert.ToInt32(cmd["port"]) : 3389;
                        form.ReportCommandReceived();
                        form.ConnectRdp(host, port, username, password);
                        break;

                    case "probe":
                        if (!form.IsIpcTest) break;
                        int sequence = cmd.ContainsKey("sequence") ? Convert.ToInt32(cmd["sequence"]) : 0;
                        form.ReportProbe(sequence);
                        break;

                    case "probe-burst":
                        if (!form.IsIpcTest) break;
                        int count = cmd.ContainsKey("count") ? Convert.ToInt32(cmd["count"]) : 1;
                        for (int i = 1; i <= Math.Max(1, Math.Min(count, 5000)); i++)
                        {
                            form.ReportProbe(i);
                        }
                        break;

                    case "visibility":
                        // A janela não é filha do DOM — o React só consegue
                        // escondê-la/mostrá-la explicitamente por aqui (ver
                        // rdp-protocol.js, buildVisibilityCommand).
                        bool visible = cmd.ContainsKey("visible") && Convert.ToBoolean(cmd["visible"]);
                        ShowWindow(form.Handle, visible ? SW_SHOWNORMAL : SW_HIDE);
                        break;

                    case "disconnect":
                        // Encerra a sessão RDP antes de matar o processo —
                        // evita depender só do socket cair por trás quando o
                        // processo morre, o que pode deixar a sessão do lado
                        // do servidor "pendurada" até o timeout dele.
                        form.DisconnectRdp();
                        form.ReportDisconnectComplete();
                        break;
                }
            });
        }
    }

    // Fila limitada de status consumida por uma thread de fundo (GOALS 7): a
    // UI e os eventos do ActiveX só enfileiram, nunca escrevem no pipe. Fila
    // cheia ou escrita que falha encerram a sidecar uma única vez.
    sealed class StatusChannel : IDisposable
    {
        readonly BlockingCollection<StatusMessage> _statuses = new BlockingCollection<StatusMessage>(256);
        readonly SidecarForm _form;
        readonly Thread _writerThread;
        int _failed;

        public StatusChannel(StreamWriter writer, SidecarForm form, bool asyncWrites)
        {
            _form = form;
            _writerThread = new Thread(() =>
            {
                var serializer = new JavaScriptSerializer();
                try
                {
                    foreach (var message in _statuses.GetConsumingEnumerable())
                    {
                        string line = serializer.Serialize(message);
                        Program.IpcTrace("status-write-begin " + message.eventName);
                        if (asyncWrites)
                        {
                            writer.WriteLineAsync(line).GetAwaiter().GetResult();
                            writer.FlushAsync().GetAwaiter().GetResult();
                        }
                        else
                        {
                            writer.WriteLine(line);
                            writer.Flush();
                        }
                        Program.IpcTrace("status-write-end " + message.eventName);
                    }
                }
                catch
                {
                    Fail();
                }
            });
            _writerThread.IsBackground = true;
            _writerThread.Start();
            form.SetStatusReporter(message =>
            {
                if (!_statuses.TryAdd(message)) Fail();
            });
        }

        void Fail()
        {
            if (Interlocked.Exchange(ref _failed, 1) != 0) return;
            _form.SetStatusReporter(null);
            Program.ExitForm(_form);
        }

        // true se o escritor esvaziou a fila a tempo; false se ficou preso.
        public bool Complete()
        {
            _form.SetStatusReporter(null);
            _statuses.CompleteAdding();
            return _writerThread.Join(500);
        }

        public void Dispose()
        {
            _statuses.Dispose();
        }
    }

    class StatusMessage
    {
        public string type { get; set; }
        public string state { get; set; }
        public string stage { get; set; }
        public string eventName { get; set; }
        public string category { get; set; }
        public int? reasonCode { get; set; }
        public string lifecycleId { get; set; }
        public string hostMode { get; set; }
        public string timestamp { get; set; }
        public string controlVersion { get; set; }
        public short connected { get; set; }
        public long formHwnd { get; set; }
        public long controlHwnd { get; set; }
        public long parentHwnd { get; set; }
        public long requestedParentHwnd { get; set; }
        public int formStyle { get; set; }
        public uint threadId { get; set; }
        public long dpiContext { get; set; }
        public int? setParentError { get; set; }
        public bool? positioned { get; set; }
        public int? sequence { get; set; }
    }

    class SidecarForm : Form
    {
        readonly Label _label;
        readonly string _hostMode;
        readonly string _lifecycleId;
        readonly IntPtr _requestedParentHwnd;
        AxMsRdpClient11NotSafeForScripting _rdp;
        Action<StatusMessage> _reportStatus;
        StatusMessage _lastStatus;
        string _state = "starting";
        string _stage = "starting";
        string _lastEventName = "FormConstructed";
        string _category;
        int? _reasonCode;
        bool _controlReady;
        int? _setParentError;
        bool? _positioned;

        public SidecarForm(
            string hostMode,
            string lifecycleId,
            IntPtr requestedParentHwnd,
            bool initializeRdp
        )
        {
            _hostMode = hostMode;
            _lifecycleId = lifecycleId;
            _requestedParentHwnd = requestedParentHwnd;
            BackColor = Color.FromArgb(20, 30, 60);
            _label = new Label
            {
                Text = "OpenPortal RDP Sidecar — aguardando comando...",
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
            };
            Controls.Add(_label);

            if (!initializeRdp)
            {
                _controlReady = true;
                return;
            }

            // Criado uma vez, escondido até o primeiro "connect" — assim uma
            // falha de registro do controle COM (mstscax.dll não registrado)
            // vira uma mensagem no label em vez de derrubar a sidecar inteira.
            try
            {
                _rdp = new AxMsRdpClient11NotSafeForScripting();
                ((ISupportInitialize)_rdp).BeginInit();
                // Adicionado depois do label: no WinForms, controles
                // adicionados por último ficam por cima no z-order, então o
                // controle RDP cobre o label assim que fica visível.
                Controls.Add(_rdp);
                ((ISupportInitialize)_rdp).EndInit();
                _rdp.Dock = DockStyle.Fill;
                _rdp.Visible = false;
                _rdp.OnConnecting += (s, e) =>
                {
                    SetStatus("Conectando...");
                    ReportStatus("connecting", "connecting", "OnConnecting");
                };
                _rdp.OnConnected += (s, e) =>
                {
                    SetStatus("Autenticando...");
                    ReportStatus("connecting", "transport-connected", "OnConnected");
                };
                _rdp.OnLoginComplete += (s, e) =>
                {
                    SetStatus(null);
                    ReportStatus("connected", "authenticated", "OnLoginComplete");
                };
                _rdp.OnDisconnected += (s, e) =>
                {
                    SetStatus(string.Format("Desconectado (motivo {0})", e.discReason));
                    ReportStatus("disconnected", "terminal", "OnDisconnected", null, e.discReason);
                };
                _rdp.OnFatalError += (s, e) =>
                {
                    SetStatus(string.Format("Erro fatal (código {0})", e.errorCode));
                    ReportStatus("error", "terminal", "OnFatalError", "host-control", e.errorCode);
                };
                _rdp.OnLogonError += (s, e) =>
                {
                    SetStatus(string.Format("Erro de login (código {0})", e.lError));
                    ReportStatus("error", "terminal", "OnLogonError", "authentication", e.lError);
                };
                _rdp.OnAuthenticationWarningDisplayed += (s, e) =>
                {
                    SetStatus("O Windows requer confirmação de segurança na janela RDP.");
                    ReportStatus(
                        "warning",
                        "security-warning",
                        "OnAuthenticationWarningDisplayed",
                        "certificate-warning"
                    );
                };
                _rdp.OnAuthenticationWarningDismissed += (s, e) =>
                {
                    SetStatus("Autenticando...");
                    ReportStatus(
                        "connecting",
                        "authenticating",
                        "OnAuthenticationWarningDismissed"
                    );
                };
                _rdp.OnNetworkStatusChanged += (s, e) =>
                {
                    ReportStatus(_state, _stage, "OnNetworkStatusChanged", "network");
                };
                _rdp.OnWarning += (s, e) =>
                {
                    SetStatus("O controle RDP apresentou um aviso.");
                    ReportStatus("warning", "security-warning", "OnWarning", "host-control");
                };
            }
            catch (Exception ex)
            {
                _rdp = null;
                _label.Text = "Controle RDP (MSTSCLib) indisponível nesta máquina: " + ex.Message;
                _state = "error";
                _stage = "terminal";
                _lastEventName = "ControlUnavailable";
                _category = "host-control";
            }
        }

        public bool AcceptsLifecycle(string lifecycleId)
        {
            return !string.IsNullOrEmpty(lifecycleId) && lifecycleId == _lifecycleId;
        }

        public bool IsIpcTest { get { return _hostMode == "ipc-test"; } }

        public void PrepareControl()
        {
            if (_hostMode == "ipc-test")
            {
                ReportStatus("ready", "control-ready", "ControlReady");
                return;
            }
            if (_rdp == null)
            {
                ReportStatus("error", "terminal", "ControlUnavailable", "host-control");
                return;
            }

            try
            {
                _rdp.CreateControl();
                if (!_rdp.IsHandleCreated || _rdp.Handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException("ActiveX child handle was not created.");
                }
                var nonScriptable = (IMsRdpClientNonScriptable3)_rdp.GetOcx();
                var parentHandle = new _RemotableHandle
                {
                    fContext = 0,
                    u = new __MIDL_IWinTypes_0009
                    {
                        hInproc = unchecked((int)Handle.ToInt64()),
                    },
                };
                nonScriptable.set_UIParentWindowHandle(ref parentHandle);
                _controlReady = true;
                ReportStatus("ready", "control-ready", "ControlReady");
            }
            catch (Exception)
            {
                _controlReady = false;
                SetStatus("Controle RDP indisponível — falha ao inicializar o componente nativo.");
                ReportStatus("error", "terminal", "ControlInitializationFailed", "host-control");
            }
        }

        public void RecordEmbeddingResult(int setParentError, bool positioned)
        {
            _setParentError = setParentError;
            _positioned = positioned;
            ReportStatus(
                setParentError == 0 && positioned ? "ready" : "error",
                setParentError == 0 && positioned ? "control-ready" : "terminal",
                "EmbeddingResult",
                setParentError == 0 && positioned ? null : "host-control",
                setParentError == 0 ? (int?)null : setParentError
            );
        }

        public void ResizeHost(int x, int y, int w, int h)
        {
            if (_hostMode != "embedded") return;
            Program.SetWindowPos(
                Handle,
                IntPtr.Zero,
                x,
                y,
                w,
                h,
                Program.SWP_NOZORDER | Program.SWP_NOACTIVATE
            );
        }

        public void ReportProbe(int sequence)
        {
            ReportStatus("ready", "control-ready", "ProbeReceived", sequence: sequence);
        }

        public void ReportCommandReceived()
        {
            ReportStatus("connecting", "command-received", "CommandReceived");
        }

        public void ReportDisconnectComplete()
        {
            ReportStatus("disconnected", "terminal", "DisconnectComplete");
        }

        // null esconde o label (sessão renderizando normalmente); qualquer
        // texto reexibe o label por cima do controle (falha, desconectado).
        void SetStatus(string text)
        {
            if (text == null)
            {
                _label.Visible = false;
                return;
            }
            _label.Text = text;
            _label.Visible = true;
        }

        public void SetStatusReporter(Action<StatusMessage> reporter)
        {
            Interlocked.Exchange(ref _reportStatus, reporter);
            var lastStatus = Volatile.Read(ref _lastStatus);
            if (reporter != null && lastStatus != null) reporter(lastStatus);
        }

        short ConnectedValue()
        {
            try
            {
                return _rdp == null ? (short)0 : _rdp.Connected;
            }
            catch
            {
                return 0;
            }
        }

        string ControlVersionValue()
        {
            try
            {
                return _rdp == null ? null : _rdp.Version;
            }
            catch
            {
                return null;
            }
        }

        long DpiContextValue()
        {
            try
            {
                return Program.GetThreadDpiAwarenessContext().ToInt64();
            }
            catch
            {
                return 0;
            }
        }

        void ReportStatus(
            string state,
            string stage,
            string eventName,
            string category = null,
            int? reasonCode = null,
            int? sequence = null
        )
        {
            _state = state;
            _stage = stage;
            _lastEventName = eventName;
            _category = category;
            _reasonCode = reasonCode;
            try
            {
                var message = new StatusMessage
                {
                    type = "status",
                    state = state,
                    stage = stage,
                    eventName = eventName,
                    category = category,
                    reasonCode = reasonCode,
                    lifecycleId = _lifecycleId,
                    hostMode = _hostMode,
                    timestamp = DateTime.UtcNow.ToString("o"),
                    controlVersion = ControlVersionValue(),
                    connected = ConnectedValue(),
                    formHwnd = Handle.ToInt64(),
                    controlHwnd = _rdp != null && _rdp.IsHandleCreated ? _rdp.Handle.ToInt64() : 0,
                    parentHwnd = Program.GetParent(Handle).ToInt64(),
                    requestedParentHwnd = _requestedParentHwnd.ToInt64(),
                    formStyle = Program.GetWindowLong(Handle, Program.GWL_STYLE),
                    threadId = Program.GetCurrentThreadId(),
                    dpiContext = DpiContextValue(),
                    setParentError = _setParentError,
                    positioned = _positioned,
                    sequence = sequence,
                };
                Volatile.Write(ref _lastStatus, message);
                Volatile.Read(ref _reportStatus)?.Invoke(message);
            }
            catch
            {
                // O cliente pode ter fechado o pipe durante a transição de
                // estado; isso não deve derrubar a janela nativa.
            }
        }

        public void ConnectRdp(string host, int port, string username, string password)
        {
            if (_rdp == null)
            {
                SetStatus("Controle RDP indisponível — não é possível conectar.");
                ReportStatus("error", "terminal", "ControlUnavailable", "host-control");
                return;
            }
            if (!_controlReady)
            {
                SetStatus("Controle RDP ainda não está pronto.");
                ReportStatus("error", "terminal", "ConnectBeforeReady", "host-control");
                return;
            }
            SetStatus("Conectando a " + host + "...");
            try
            {
                _rdp.Visible = true;

                _rdp.Server = host;
                _rdp.UserName = username;
                _rdp.ColorDepth = 32;
                // SmartSizing (abaixo) escala o desenho pro tamanho do controle
                // sem renegociar a resolução remota a cada resize — então este
                // valor inicial só precisa ser "razoável", não perfeito.
                _rdp.DesktopWidth = Math.Max(200, ClientSize.Width);
                _rdp.DesktopHeight = Math.Max(200, ClientSize.Height);

                // AdvancedSettings2/7 batem com o NÚMERO da interface COM, não
                // com o número no nome da propriedade do wrapper Ax (a
                // propriedade "AdvancedSettings2" devolve o tipo-base
                // IMsRdpClientAdvancedSettings; "AdvancedSettings7" devolve
                // IMsRdpClientAdvancedSettings6) — cast explícito é necessário e
                // seguro, o objeto COM por trás suporta todas as versões.
                var adv2 = (IMsRdpClientAdvancedSettings2)_rdp.AdvancedSettings2;
                adv2.RDPPort = port;
                adv2.ClearTextPassword = password;
                adv2.SmartSizing = true;

                // EnableCredSspSupport = NLA continua ligado no servidor — é o
                // motivo pelo qual esta arquitetura (MSTSCLib nativo) foi
                // escolhida em vez das libs JS abandonadas (ver GOALS.md).
                var adv7 = (IMsRdpClientAdvancedSettings7)_rdp.AdvancedSettings7;
                adv7.EnableCredSspSupport = true;

                ReportStatus("connecting", "connect-invoking", "ConnectInvoking");
                _rdp.Connect();
                ReportStatus("connecting", "connect-returned", "ConnectReturned");
            }
            catch (Exception)
            {
                SetStatus("Falha ao iniciar RDP no controle nativo.");
                ReportStatus("error", "terminal", "ConnectException", "host-control");
            }
        }

        public void DisconnectRdp()
        {
            try
            {
                if (_rdp != null && _rdp.Connected != 0) _rdp.Disconnect();
            }
            catch
            {
                // Processo está prestes a sair de qualquer forma (chamado só
                // a partir do case "disconnect") — não vale a pena propagar
                // uma falha de desconexão nesse ponto.
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing && _stage != "terminal")
            {
                ReportStatus("disconnected", "terminal", "NativeWindowClosed");
            }
            base.OnFormClosing(e);
        }
    }
}
