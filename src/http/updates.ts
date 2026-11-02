import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Arquivos do atualizador do jogo: `GET /updates/<arquivo>`. Ver mmo-docs [INFRA-08].
 *
 * A pasta (padrão `./updates`, ou a variável UPDATES_DIR) contém:
 * - `manifest.json` — `{ version, url, sha256, size, minLauncherVersion }`, gerado pelo
 *   script de publicação do cliente (mmo-client/tools/publish_update.sh);
 * - `game-<versão>.pck` — o pacote do jogo.
 *
 * ATENÇÃO: o formato do manifesto é lido por mmo-client/scripts/boot/updater.gd.
 */

/** Prefixo da rota. */
export const UPDATES_ROUTE = "/updates/";

/** Pasta padrão, relativa ao diretório onde o servidor é iniciado (a raiz do mmo-server). */
export const DEFAULT_UPDATES_DIR = "updates";

/** Só nomes simples (sem `/`, sem `..` no início): impede ler arquivos fora da pasta. */
const SAFE_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Content-Type por extensão. Outras extensões não são servidas. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json; charset=utf-8",
  ".pck": "application/octet-stream",
};

/** Extensão do nome (com o ponto), ou "" se não houver. */
const extensionOf = (name: string): string => {
  const dot: number = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};

/**
 * Responde um pedido `GET /updates/<arquivo>` servindo o arquivo de `dir`.
 * 404 para nome inválido, extensão não permitida ou arquivo inexistente.
 *
 * O manifesto vai com `Cache-Control: no-cache` (sempre conferir a versão); os `.pck` têm o número
 * da versão no nome e nunca mudam, então podem ficar em cache.
 */
export async function serveUpdateFile(fileName: string, dir: string, res: ServerResponse): Promise<void> {
  const contentType: string | undefined = CONTENT_TYPES[extensionOf(fileName)];
  if (!SAFE_FILE_NAME.test(fileName) || contentType === undefined) {
    res.writeHead(404).end();
    return;
  }

  const path: string = join(resolve(dir), fileName);
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    "cache-control": fileName === "manifest.json" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}
