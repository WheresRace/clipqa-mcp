import type { CommandRunner } from "./process-runner.js";
import type { WindowInfo } from "./types.js";

const WINDOWS_SCRIPT = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ClipWindow { public string title; public string hwnd; public string process; public int pid; public bool minimized; }
public static class ClipWindows {
 delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 public static List<ClipWindow> All() {
  var result = new List<ClipWindow>();
  EnumWindows((h,p) => {
   if (!IsWindowVisible(h)) return true;
   var text = new StringBuilder(2048); GetWindowText(h, text, text.Capacity);
   if (text.Length == 0) return true;
   uint pid; GetWindowThreadProcessId(h, out pid);
   string process = ""; try { process = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
   result.Add(new ClipWindow { title=text.ToString(), hwnd=h.ToInt64().ToString(), process=process, pid=(int)pid, minimized=IsIconic(h) });
   return true;
  }, IntPtr.Zero);
  return result;
 }
}
'@
@([ClipWindows]::All()) | Sort-Object title | ConvertTo-Json -Compress
`;

export async function listWindows(
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<WindowInfo[]> {
  if (platform === "linux") {
    const result = await runner.run("wmctrl", ["-lp"]);
    if (result.code) throw new Error("Install wmctrl for X11 window discovery, or use xwininfo and provide windowId directly.");
    return result.stdout.split(/\r?\n/).flatMap(line => {
      const m = /^(0x[\da-f]+)\s+-?\d+\s+(\d+)\s+\S+\s+(.+)$/i.exec(line);
      return m ? [{ hwnd: m[1]!, title: m[3]!, pid: Number(m[2]), process: "X11", windowId: m[1]! }] : [];
    });
  }
  if (platform !== "win32") throw new Error("Use list_sources to select a macOS display. Window-only discovery is available on Windows and X11.");

  const result = await runner.run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_SCRIPT,
  ]);
  if (result.code !== 0) {
    throw new Error(`Unable to list windows: ${result.stderr.trim()}`);
  }
  if (!result.stdout.trim()) return [];

  const parsed: WindowInfo | WindowInfo[] = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (window) => Boolean(window.title && window.hwnd),
  );
}
