using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
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
    // Contrato de argv (nada sensível aqui): <pipeName> <parentHwnd> <x> <y> <w> <h>
    // Contrato do pipe: uma linha JSON por comando, UTF-8, terminada em \n:
    //   {"cmd":"resize","x":10,"y":10,"w":800,"h":600}
    //   {"cmd":"connect","host":"100.x.x.x","port":3389,"username":"u","password":"p"}
    //   {"cmd":"visibility","visible":true}
    //   {"cmd":"disconnect"}
    static class Program
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll")]
        static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        const int GWL_STYLE = -16;
        const int WS_CHILD = 0x40000000;
        const int WS_POPUP = unchecked((int)0x80000000);
        const int WS_CAPTION = 0x00C00000;
        const int WS_MINIMIZE = 0x20000000;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;
        const int SW_HIDE = 0;
        const int SW_SHOWNORMAL = 1;

        static IntPtr s_parentHwnd = IntPtr.Zero;

        static void Reparent(SidecarForm form, int x, int y, int w, int h)
        {
            int style = GetWindowLong(form.Handle, GWL_STYLE);
            // -32000,-32000 (retângulo de "minimizado" do Windows) aparece se
            // WS_MINIMIZE ficar setado quando reposicionamos — limpar aqui
            // evita o bug já visto e documentado no GOALS.md.
            style = (style & ~WS_POPUP & ~WS_CAPTION & ~WS_MINIMIZE) | WS_CHILD;
            SetWindowLong(form.Handle, GWL_STYLE, style);
            SetParent(form.Handle, s_parentHwnd);
            ShowWindow(form.Handle, SW_SHOWNORMAL);
            // form.Location não serve mais uma vez WS_CHILD: WinForms ainda
            // pensa em coordenadas de tela, mas o Windows já espera
            // coordenadas relativas ao pai — SetWindowPos direto é o que
            // funciona sem ambiguidade.
            SetWindowPos(form.Handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        [STAThread]
        static void Main(string[] args)
        {
            string pipeName = args.Length >= 1 ? args[0] : null;
            if (args.Length >= 2 && long.TryParse(args[1], out long h0)) s_parentHwnd = new IntPtr(h0);
            int x = 100, y = 100, w = 640, h = 480;
            if (args.Length >= 6)
            {
                int.TryParse(args[2], out x);
                int.TryParse(args[3], out y);
                int.TryParse(args[4], out w);
                int.TryParse(args[5], out h);
            }

            Application.EnableVisualStyles();

            var form = new SidecarForm
            {
                StartPosition = FormStartPosition.Manual,
                FormBorderStyle = FormBorderStyle.None,
                Location = new Point(x, y),
                Size = new Size(w, h),
            };
            form.Show();

            if (s_parentHwnd != IntPtr.Zero) Reparent(form, x, y, w, h);

            if (!string.IsNullOrEmpty(pipeName))
            {
                var listenerThread = new Thread(() => RunPipeServer(pipeName, form));
                listenerThread.IsBackground = true;
                listenerThread.Start();
            }

            Application.Run(form);
        }

        // Roda numa thread separada da UI — cada comando recebido é
        // despachado de volta pra thread da UI via form.Invoke antes de
        // tocar em qualquer Win32/WinForms (regra de ouro do WinForms:
        // só a thread que criou o handle pode mexer nele).
        static void RunPipeServer(string pipeName, SidecarForm form)
        {
            var serializer = new JavaScriptSerializer();
            while (!form.IsDisposed)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1))
                    {
                        server.WaitForConnection();
                        var writer = new StreamWriter(server, new UTF8Encoding(false))
                        {
                            AutoFlush = true,
                        };
                        form.SetStatusReporter(state => writer.WriteLine(serializer.Serialize(new
                        {
                            type = "status",
                            state,
                        })));
                        using (var reader = new StreamReader(server))
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                object parsed;
                                try
                                {
                                    parsed = serializer.DeserializeObject(line);
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
                        form.SetStatusReporter(null);
                        writer.Dispose();
                    }
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch
                {
                    // Cliente caiu no meio, pipe fechou de forma inesperada,
                    // etc. — volta a escutar em vez de derrubar a sidecar
                    // inteira por uma falha transitória de conexão local.
                }
            }
        }

        static void DispatchCommand(SidecarForm form, System.Collections.Generic.Dictionary<string, object> cmd)
        {
            if (!cmd.ContainsKey("cmd")) return;
            string type = Convert.ToString(cmd["cmd"]);

            if (form.IsDisposed) return;
            form.Invoke((MethodInvoker)delegate
            {
                switch (type)
                {
                    case "resize":
                        int rx = Convert.ToInt32(cmd["x"]);
                        int ry = Convert.ToInt32(cmd["y"]);
                        int rw = Convert.ToInt32(cmd["w"]);
                        int rh = Convert.ToInt32(cmd["h"]);
                        SetWindowPos(form.Handle, IntPtr.Zero, rx, ry, rw, rh, SWP_NOZORDER | SWP_NOACTIVATE);
                        break;

                    case "connect":
                        // Nunca loga a senha — só chega por aqui vinda do
                        // pipe, nunca por argv (ver contrato no topo do arquivo).
                        string host = cmd.ContainsKey("host") ? Convert.ToString(cmd["host"]) : "";
                        string username = cmd.ContainsKey("username") ? Convert.ToString(cmd["username"]) : "";
                        string password = cmd.ContainsKey("password") ? Convert.ToString(cmd["password"]) : "";
                        int port = cmd.ContainsKey("port") ? Convert.ToInt32(cmd["port"]) : 3389;
                        form.ConnectRdp(host, port, username, password);
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
                        Application.Exit();
                        break;
                }
            });
        }
    }

    class SidecarForm : Form
    {
        readonly Label _label;
        AxMsRdpClient11NotSafeForScripting _rdp;
        Action<string> _reportStatus;

        public SidecarForm()
        {
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
                    ReportStatus("connecting");
                };
                _rdp.OnConnected += (s, e) =>
                {
                    SetStatus(null);
                    ReportStatus("connected");
                };
                _rdp.OnDisconnected += (s, e) =>
                {
                    SetStatus(string.Format("Desconectado (motivo {0})", e.discReason));
                    ReportStatus("disconnected");
                };
                _rdp.OnFatalError += (s, e) =>
                {
                    SetStatus(string.Format("Erro fatal (código {0})", e.errorCode));
                    ReportStatus("error");
                };
                _rdp.OnLogonError += (s, e) =>
                {
                    SetStatus(string.Format("Erro de login (código {0})", e.lError));
                    ReportStatus("error");
                };
            }
            catch (Exception ex)
            {
                _rdp = null;
                _label.Text = "Controle RDP (MSTSCLib) indisponível nesta máquina: " + ex.Message;
            }
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

        public void SetStatusReporter(Action<string> reporter)
        {
            _reportStatus = reporter;
        }

        void ReportStatus(string state)
        {
            try
            {
                _reportStatus?.Invoke(state);
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
                ReportStatus("error");
                return;
            }
            SetStatus("Conectando a " + host + "...");
            ReportStatus("connecting");
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

            try
            {
                _rdp.Connect();
            }
            catch (Exception ex)
            {
                SetStatus("Falha ao iniciar RDP: " + ex.Message);
                ReportStatus("error");
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
    }
}
