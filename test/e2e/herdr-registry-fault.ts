import { createConnection, createServer, type Socket } from "node:net";
import { rename } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Private-fixture transport fault. Bytes for Herdr clients and CLI pass unchanged. */
export async function registryFaultProxy(socketPath: string, upstreamPath: string, ownedRoot: string) {
  if (!resolve(socketPath).startsWith(`${resolve(ownedRoot)}${sep}`) ||
      !resolve(upstreamPath).startsWith(`${resolve(ownedRoot)}${sep}`)) {
    throw new Error("Registry fault socket must belong to this private run");
  }
  const sockets = new Set<Socket>();
  const registryConnections = new Set<Socket>();
  let disabled = false;
  let dropped = 0;
  await rename(socketPath, upstreamPath);
  const server = createServer(downstream => {
    const upstream = createConnection(upstreamPath);
    let firstLine = "";
    let identified = false;
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
      socket.on("close", () => { sockets.delete(socket); registryConnections.delete(socket); });
    }
    downstream.on("data", chunk => {
      if (identified) return;
      firstLine += chunk.toString("utf8");
      const newline = firstLine.indexOf("\n");
      if (newline < 0 && firstLine.length < 16_384) return;
      identified = true;
      try {
        const request = JSON.parse(firstLine.slice(0, newline));
        if (typeof request.id === "string" && request.id.startsWith("pi-outliner:")) {
          registryConnections.add(downstream);
          registryConnections.add(upstream);
          if (disabled) { dropped++; downstream.destroy(); upstream.destroy(); }
        }
      } catch { /* Herdr's attached client uses its own binary protocol. */ }
      firstLine = "";
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rename(upstreamPath, socketPath);
    throw error;
  }
  return {
    setDisabled(value: boolean) {
      disabled = value;
      if (disabled) {
        dropped += registryConnections.size / 2;
        for (const socket of registryConnections) socket.destroy();
      }
      return {disabled, dropped};
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rename(upstreamPath, socketPath);
      return {disabled: false, dropped};
    },
  };
}
