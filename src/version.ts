import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Versao do pacote (package.json na raiz do projeto). */
export function getPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
