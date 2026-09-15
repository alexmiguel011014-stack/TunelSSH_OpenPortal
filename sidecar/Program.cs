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

        const int GWL_STYLE = -16;
        const int WS_CHILD = 0x40000000;
        const int WS_POPUP = unchecked((int)0x80000000);
        const int WS_CAPTION = 0x00C00000;

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
                style = (style & ~WS_POPUP & ~WS_CAPTION) | WS_CHILD;
                SetWindowLong(form.Handle, GWL_STYLE, style);
                SetParent(form.Handle, parentHwnd);
                form.Location = new Point(x, y);
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
