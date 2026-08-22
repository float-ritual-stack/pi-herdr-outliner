import { createConnection } from "node:net";
import type { OutlinerRequest, OutlinerResponse } from "./types";

export type RequestInput = OutlinerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export class OutlinerClient {
  constructor(readonly socketPath: string) {}

  request<T>(input: RequestInput, timeoutMs = 3000): Promise<T> {
    const request = { ...input, id: crypto.randomUUID() } as OutlinerRequest;
    const responseReceived = Promise.withResolvers<T>();
    const socket = createConnection(this.socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      responseReceived.reject(new Error(`Outliner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const fail = (error: Error): void => {
      clearTimeout(timeout);
      responseReceived.reject(error);
    };
    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as OutlinerResponse;
        if (!response.ok) responseReceived.reject(new Error(response.error));
        else responseReceived.resolve(response.result as T);
      } catch (error) {
        responseReceived.reject(error);
      }
    });
    return responseReceived.promise;
  }
}
