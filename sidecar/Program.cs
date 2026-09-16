using System;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OpenPortalRdpSidecar
{
    // GOALS 2 (RDP nativo): sidecar que hospeda a janela nativa (mais tarde,
    // o controle ActiveX MSTSCLib via MsRdpEx) reparented dentro do HWND do
    // BrowserWindow do Electron. Recebe comandos do processo principal via
    // named pipe (nunca por argv, pra senha nunca aparecer em
    // Get-Process/Task Manager) — ver GOALS.md, seção "GOALS 2".
    //
    // Contrato de argv (nada sensível aqui): <pipeName> <parentHwnd> <x> <y> <w> <h>
    // Contrato do pipe: uma linha JSON por comando, UTF-8, terminada em \n:
    //   {"cmd":"resize","x":10,"y":10,"w":800,"h":600}
    //   {"cmd":"connect","host":"100.x.x.x","port":3389,"username":"u","password":"p"}
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
                    using (var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1))
                    {
                        server.WaitForConnection();
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
                        // Stub por enquanto — MsRdpEx/MSTSCLib ainda não
                        // plugado (ver GOALS.md). Nunca loga a senha.
                        string host = cmd.ContainsKey("host") ? Convert.ToString(cmd["host"]) : "?";
                        string username = cmd.ContainsKey("username") ? Convert.ToString(cmd["username"]) : "?";
                        form.ShowConnectingStub(host, username);
                        break;

                    case "disconnect":
                        Application.Exit();
                        break;
                }
            });
        }
    }

    class SidecarForm : Form
    {
        readonly Label _label;

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
        }

        public void ShowConnectingStub(string host, string username)
        {
            _label.Text = string.Format("(stub) Conectaria a {0} como {1}\nMsRdpEx/MSTSCLib ainda não integrado", host, username);
        }
    }
}
