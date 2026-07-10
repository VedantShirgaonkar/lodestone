import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface JsonlLine {
  value?: unknown;
  error?: string;
  lineNo: number;
}

export async function* readJsonlLines(
  path: string
): AsyncGenerator<JsonlLine> {
  const stream = createReadStream(path);
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line);
      yield { value, lineNo };
    } catch (err) {
      yield {
        error: err instanceof Error ? err.message : String(err),
        lineNo,
      };
    }
  }
}
