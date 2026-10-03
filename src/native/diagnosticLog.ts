import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";

/** Call between serialized appends. Keep four complete archives and current. */
export function rotateDiagnosticLog(
  file: string,
  nextBytes: number,
  maxBytes = 2 * 1024 * 1024,
  archives = 4,
) {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (!size || size + nextBytes <= maxBytes) return;
  if (existsSync(`${file}.${archives}`)) unlinkSync(`${file}.${archives}`);
  for (let i = archives - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`))
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}
