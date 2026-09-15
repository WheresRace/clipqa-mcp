Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ClipQaTestWindow : Form {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int h2, uint flags);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
  Timer timer = new Timer();
  int tick = 0;
  public ClipQaTestWindow() {
    Text = "ClipQA automated capture fixture";
    ClientSize = new Size(320, 180);
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(10, 10);
    DoubleBuffered = true;
    timer.Interval = 100;
    timer.Tick += (s,e) => { tick++; Invalidate(); };
    timer.Start();
  }
  protected override void OnShown(EventArgs e) {
    base.OnShown(e);
    SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x0013);
    Console.WriteLine("READY:" + Handle.ToInt64() + ":" + GetForegroundWindow().ToInt64());
    Console.Out.Flush();
  }
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.Clear(Color.FromArgb(35, 40, 50));
    e.Graphics.FillRectangle(Brushes.CornflowerBlue, (tick * 8) % 260, 50, 50, 50);
    e.Graphics.DrawString("ClipQA test fixture " + tick, SystemFonts.DefaultFont, Brushes.White, 12, 130);
  }
}
'@
[System.Windows.Forms.Application]::Run((New-Object ClipQaTestWindow))
