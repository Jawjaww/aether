import type { ChildProcess } from "node:child_process";

export const extractCursorLineFromContent = (content: string): number | undefined => {
  const cursorMatch = /cursor position:? line (\d+)/i.exec(content)
    ?? /line (\d+), column/i.exec(content);

  return cursorMatch?.[1] ? Number.parseInt(cursorMatch[1], 10) : undefined;
};

export const extractFilePathFromContent = (content: string): string | undefined => {
  const filePathMatch = /<file_content[^>]*path=["']?([^"'\s>]+)["']?/i.exec(content)
    ?? /# ([^\n]+\.(ts|tsx|js|jsx|py|rs|go|md))/i.exec(content);

  return filePathMatch?.[1];
};

export const buildDashboardFilePath = (rawUrl: string): string => {
  const url = rawUrl.split("?")[0] || "/";

  if (url === "/") return "index.html";

  return url.startsWith("/") ? url.slice(1) : url;
};

export const terminateProcessGroup = (
  processRef: ChildProcess | null,
  signal: NodeJS.Signals,
): void => {
  if (!processRef?.pid) return;

  try {
    process.kill(-processRef.pid, signal);
  } catch {}
};

export const streamResponseBody = async (
  body: unknown,
  onFirstChunk: () => void,
  onChunk: (chunk: Uint8Array, text: string) => void,
): Promise<void> => {
  if (!body) return;

  const bodyAny = body as any;

  if (typeof bodyAny.getReader === "function") {
    const reader = bodyAny.getReader();
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (firstChunk) {
        onFirstChunk();
        firstChunk = false;
      }

      onChunk(value, new TextDecoder().decode(value));
    }

    return;
  }

  if (typeof bodyAny.on === "function") {
    await new Promise<void>((resolve, reject) => {
      let firstChunk = true;

      bodyAny.on("data", (chunk: Buffer) => {
        if (firstChunk) {
          onFirstChunk();
          firstChunk = false;
        }

        onChunk(chunk, chunk.toString("utf8"));
      });

      bodyAny.on("end", () => resolve());
      bodyAny.on("error", (err: Error) => reject(err));
    });
  }
};