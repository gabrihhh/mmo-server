import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Arquivos do atualizador do jogo: `GET /updates/<plataforma>/<arquivo>`. Ver mmo-docs [INFRA-08].
 *
 * A pasta (padrão `./updates`, ou a variável UPDATES_DIR) tem uma subpasta por plataforma
 * (`android`, `desktop`), porque o pacote muda com o formato de textura. Cada uma contém:
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

/** Nome de plataforma: só letras minúsculas (ex.: `android`, `desktop`). */
const SAFE_PLATFORM = /^[a-z]+$/;

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
 * Responde um pedido `GET /updates/<plataforma>/<arquivo>` servindo `<dir>/<plataforma>/<arquivo>`.
 * `relativePath` é o que vem depois de `/updates/`.
 * 404 para caminho inválido, extensão não permitida ou arquivo inexistente.
 *
 * O manifesto vai com `Cache-Control: no-cache` (sempre conferir a versão); os `.pck` têm o número
 * da versão no nome e nunca mudam, então podem ficar em cache.
 */
export async function serveUpdateFile(relativePath: string, dir: string, res: ServerResponse): Promise<void> {
  const parts: string[] = relativePath.split("/");
  const platform: string = parts[0] ?? "";
  const fileName: string = parts[1] ?? "";
  const contentType: string | undefined = CONTENT_TYPES[extensionOf(fileName)];
  if (parts.length !== 2 || !SAFE_PLATFORM.test(platform) || !SAFE_FILE_NAME.test(fileName) || contentType === undefined) {
    res.writeHead(404).end();
    return;
  }

  const path: string = join(resolve(dir), platform, fileName);
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
