export function shellInvocation(command, {
  platform = process.platform,
  configuredShell = process.env.NOTION_SHELL,
} = {}) {
  if (platform === "win32") {
    return {
      executable: configuredShell || "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }
  return {
    executable: configuredShell || "/bin/bash",
    args: ["-lc", command],
  };
}
