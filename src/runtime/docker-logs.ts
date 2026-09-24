import type { LogEntry } from "./types.js";

const decoder = new TextDecoder();

function parseLine(stream: "stdout" | "stderr", line: string): LogEntry {
  const space = line.indexOf(" ");
  const timestamp = space === -1 ? line : line.slice(0, space);
  const text = space === -1 ? "" : line.slice(space + 1);
  return { stream, time: new Date(timestamp), text };
}

/** Append the text of one frame, emitting every complete line it finishes. */
function appendText(
  entries: LogEntry[],
  buffers: Record<"stdout" | "stderr", string>,
  stream: "stdout" | "stderr",
  text: string,
): void {
  const combined = buffers[stream] + text;
  const lines = combined.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length > 0) {
      entries.push(parseLine(stream, line));
    }
  }
  buffers[stream] = remainder;
}

function flush(
  entries: LogEntry[],
  buffers: Record<"stdout" | "stderr", string>,
): void {
  for (const stream of ["stdout", "stderr"] as const) {
    if (buffers[stream].length > 0) {
      entries.push(parseLine(stream, buffers[stream]));
      buffers[stream] = "";
    }
  }
}

/**
 * Split the engine's raw log stream into entries. Without a TTY the stream is
 * a sequence of 8-byte-header frames (byte 0 is the stream, bytes 4-7 the
 * big-endian payload length). With a TTY the whole buffer is stdout.
 * Entries are sorted by the engine's timestamp, stably.
 */
export function demuxDockerLogs(
  data: Uint8Array,
  options: { tty: boolean },
): LogEntry[] {
  const entries: LogEntry[] = [];
  const buffers: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };

  if (options.tty) {
    appendText(entries, buffers, "stdout", decoder.decode(data));
  } else {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset + 8 <= data.byteLength) {
      const streamByte = data[offset];
      const length = view.getUint32(offset + 4, false);
      if (offset + 8 + length > data.byteLength) {
        break;
      }
      const stream = streamByte === 2 ? "stderr" : "stdout";
      const payload = data.subarray(offset + 8, offset + 8 + length);
      appendText(entries, buffers, stream, decoder.decode(payload));
      offset += 8 + length;
    }
  }

  flush(entries, buffers);
  entries.sort((a, b) => a.time.getTime() - b.time.getTime());
  return entries;
}

/**
 * Apply `since` (entries at or after it, to the millisecond) and then `tail`
 * (the last N entries). Neither option returns every entry.
 */
export function filterLogs(
  entries: readonly LogEntry[],
  options: { tail?: number; since?: Date },
): LogEntry[] {
  let result = [...entries];
  if (options.since !== undefined) {
    const since = options.since.getTime();
    result = result.filter((entry) => entry.time.getTime() >= since);
  }
  if (options.tail !== undefined) {
    result = options.tail <= 0 ? [] : result.slice(-options.tail);
  }
  return result;
}
