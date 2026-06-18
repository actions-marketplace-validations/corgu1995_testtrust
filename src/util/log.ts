export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface LoggerOptions {
  quiet?: boolean;
}

/** Stderr logger. ALL non-report output goes to stderr so stdout stays clean
 *  for the JSON/human report (the CLI's stdout/stderr separation contract). */
export function createLogger(options: LoggerOptions = {}): Logger {
  const quiet = options.quiet ?? false;
  return {
    info(message: string): void {
      if (!quiet) process.stderr.write(`${message}\n`);
    },
    warn(message: string): void {
      process.stderr.write(`${message}\n`);
    },
  };
}
