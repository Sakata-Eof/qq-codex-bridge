using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

internal static class WindowsLauncher
{
    private static readonly object LogLock = new object();
    private static string logPath;

    [STAThread]
    private static int Main(string[] args)
    {
        string bridgeRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        logPath = Path.Combine(bridgeRoot, "runtime", "launcher.log");
        try
        {
            string script;
            string switches = "";
            if (args.Length == 1 && args[0] == "watchdog")
            {
                script = "Watchdog.ps1";
            }
            else if (args.Length >= 1 && args[0] == "start")
            {
                script = "Start.ps1";
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < args.Length; i++)
                {
                    if ((!args[i].Equals("-History", StringComparison.OrdinalIgnoreCase) &&
                         !args[i].Equals("-NoBrowser", StringComparison.OrdinalIgnoreCase)) || !seen.Add(args[i]))
                        throw new ArgumentException("Unsupported launcher argument.");
                    switches += " " + args[i];
                }
            }
            else
            {
                throw new ArgumentException("Use watchdog or start [-History] [-NoBrowser].");
            }

            var info = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                                        @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                            Path.Combine(bridgeRoot, script) + "\"" + switches,
                WorkingDirectory = bridgeRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var child = new Process { StartInfo = info })
            {
                child.OutputDataReceived += (sender, e) => WriteLog(e.Data);
                child.ErrorDataReceived += (sender, e) => WriteLog(e.Data);
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                // Stay alive so Task Scheduler can track and restart the watchdog.
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            WriteLog(error.ToString());
            return 1;
        }
    }

    private static void WriteLog(string line)
    {
        if (line == null) return;
        lock (LogLock)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("o") + " " + line + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
