export function externalOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("External web resources must use HTTP or HTTPS");
  }
  if (platform === "darwin") return ["open", parsed.href];
  if (platform === "win32") return ["cmd", "/c", "start", "", parsed.href];
  return ["xdg-open", parsed.href];
}

export function openExternalUrl(url: string): void {
  const child = Bun.spawn(externalOpenCommand(url), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
}
