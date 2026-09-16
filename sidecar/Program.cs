using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OpenPortalRdpSidecar
{
    // Milestone 1 do GOALS 2 (RDP nativo): prova que uma janela WinForms
    // nesta sidecar consegue ser reparented (Win32 SetParent) dentro do HWND
    // do BrowserWindow do Electron e acompanhar a posição/tamanho passados —
    // antes de investir em MsRdpEx/MSTSCLib de verdade. Ver GOALS.md, seção
    // "GOALS 2", item "Sidecar scaffold".
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

        [STAThread]
        static void Main(string[] args)
        {
            IntPtr parentHwnd = IntPtr.Zero;
            int x = 100, y = 100, w = 640, h = 480;

            if (args.Length >= 1 && long.TryParse(args[0], out long h0)) parentHwnd = new IntPtr(h0);
            if (args.Length >= 5)
            {
                int.TryParse(args[1], out x);
                int.TryParse(args[2], out y);
                int.TryParse(args[3], out w);
                int.TryParse(args[4], out h);
            }

            Application.EnableVisualStyles();

            var form = new PoCForm
            {
                StartPosition = FormStartPosition.Manual,
                FormBorderStyle = FormBorderStyle.None,
                Location = new Point(x, y),
                Size = new Size(w, h),
            };
            form.Show();

            if (parentHwnd != IntPtr.Zero)
            {
                int style = GetWindowLong(form.Handle, GWL_STYLE);
                // Também limpa WS_MINIMIZE explicitamente: o -32000,-32000
                // visto antes é o retângulo padrão do Windows pra janela
                // iconificada — se esse bit ficar setado, SetWindowPos com
                // coordenadas normais é ignorado até a janela ser restaurada.
                style = (style & ~WS_POPUP & ~WS_CAPTION & ~WS_MINIMIZE) | WS_CHILD;
                SetWindowLong(form.Handle, GWL_STYLE, style);
                SetParent(form.Handle, parentHwnd);
                // Restaura ANTES de posicionar — SetWindowPos numa janela
                // ainda marcada como minimizada não move o retângulo real.
                ShowWindow(form.Handle, SW_SHOWNORMAL);
                // Não usar form.Location aqui: o WinForms ainda trata a Form
                // como top-level (coordenadas de TELA), mas agora que é
                // WS_CHILD de verdade o Windows espera coordenadas relativas
                // ao PAI — usar SetWindowPos direto evita essa mistura.
                SetWindowPos(form.Handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            }

            Application.Run(form);
        }
    }

    class PoCForm : Form
    {
        public PoCForm()
        {
            BackColor = Color.FromArgb(20, 30, 60);
            var label = new Label
            {
                Text = "OpenPortal RDP Sidecar — PoC de embutimento nativo",
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
            };
            Controls.Add(label);
        }
    }
}
