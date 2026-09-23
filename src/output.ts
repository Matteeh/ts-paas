export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out(text: string): void {
    process.stdout.write(text);
  },
  err(text: string): void {
    process.stderr.write(text);
  },
};

export function writeOutput<T>(
  io: Io,
  value: T,
  options: { json: boolean },
  format: (value: T) => string,
): void {
  if (options.json) {
    io.out(`${JSON.stringify(value)}\n`);
  } else {
    io.out(`${format(value)}\n`);
  }
}
