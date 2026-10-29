import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CommandRunner } from "./process-runner.js";
import type { WindowInfo } from "./types.js";

const WINDOWS_SOURCE = `
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
`;

const LIST = "@([ClipWindows]::All()) | Sort-Object title | ConvertTo-Json -Compress";
const ENCODING = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false";
const WINDOWS_SCRIPT = `${ENCODING}
Add-Type -TypeDefinition @'
${WINDOWS_SOURCE}
'@
${LIST}`;

let helper: Promise<string | undefined> | undefined;

// Compiling the helper once saves the C# compile on every listing (about a third of the call).
function compiledHelper(runner: CommandRunner): Promise<string | undefined> {
  helper ??= (async () => {
    const hash = createHash("sha256").update(WINDOWS_SOURCE).digest("hex").slice(0, 12);
    const dll = path.join(os.tmpdir(), `clipqa-windows-${hash}.dll`);
    if (await fs.stat(dll).then(s => s.size > 0, () => false)) return dll;
    const source = path.join(os.tmpdir(), `clipqa-windows-${hash}-${process.pid}.cs`), temporary = path.join(os.tmpdir(), `clipqa-windows-${hash}-${process.pid}.dll`);
    try {
      await fs.writeFile(source, WINDOWS_SOURCE);
      const result = await runner.run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Add-Type -Path '${source}' -OutputAssembly '${temporary}' -OutputType Library`]);
      if (result.code !== 0) return undefined;
      await fs.rename(temporary, dll).catch(() => undefined);
      return await fs.stat(dll).then(() => dll, () => undefined);
    } catch { return undefined; }
    finally { await fs.rm(source, { force: true }).catch(() => undefined); await fs.rm(temporary, { force: true }).catch(() => undefined); }
  })();
  return helper;
}

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
    await compiledHelper(runner).then(dll => dll ? `${ENCODING}
Add-Type -Path '${dll}'
${LIST}` : WINDOWS_SCRIPT, () => WINDOWS_SCRIPT),
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
