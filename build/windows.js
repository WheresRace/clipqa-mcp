const WINDOWS_SCRIPT = [
    "Get-Process",
    "| Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }",
    "| ForEach-Object { [pscustomobject]@{ title=$_.MainWindowTitle; hwnd=[string]$_.MainWindowHandle; process=$_.ProcessName; pid=$_.Id } }",
    "| Sort-Object title",
    "| ConvertTo-Json -Compress",
].join(" ");
export async function listWindows(runner, platform = process.platform) {
    if (platform !== "win32") {
        throw new Error("Window discovery is currently Windows-only.");
    }
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
    if (!result.stdout.trim())
        return [];
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((window) => Boolean(window.title && window.hwnd));
}
//# sourceMappingURL=windows.js.map