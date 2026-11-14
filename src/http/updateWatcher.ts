import { watch, type FSWatcher, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Vigia os manifestos do atualizador (`<pasta>/<plataforma>/manifest.json`, mmo-docs [INFRA-08]) e avisa quando uma
 * plataforma ganha versão nova do pacote do jogo — é o que derruba quem está jogando na versão velha e o manda
 * atualizar sozinho (`update_required`, ver `src/GameServer.ts`).
 *
 * Como detecta: `fs.watch` recursivo na pasta (rápido) **e** uma varredura leve a cada {@link UpdateWatcherOptions.pollIntervalMs}
 * (garantia: `fs.watch` pode faltar, perder eventos ou a pasta nem existir ainda). Cada varredura só faz `readdir` +
 * `stat` e relê o manifesto quando a assinatura do arquivo muda (inode, tamanho, data). O `publish_update.sh` troca o
 * manifesto de uma vez (`mv` de um temporário): o inode muda, então a troca é sempre vista inteira, nunca meio escrita.
 * Manifesto ilegível (JSON inválido, sem `version` inteira ≥ 0) é ignorado e relido na próxima varredura.
 *
 * ATENÇÃO: o formato do manifesto é gerado por mmo-client/tools/publish_update.sh e lido também por
 * mmo-client/scripts/boot/updater.gd e scripts/boot/live_updater.gd.
 */

/** Opções do {@link UpdateWatcher}. */
export interface UpdateWatcherOptions {
  /** Pasta com uma subpasta por plataforma (a mesma servida em `/updates/`). */
  readonly dir: string;
  /** Intervalo da varredura de garantia, em ms. Padrão: {@link DEFAULT_UPDATE_POLL_MS}. */
  readonly pollIntervalMs?: number;
  /**
   * Chamado quando o manifesto de `platform` passa a ter uma versão MAIOR que a conhecida (ou aparece pela primeira
   * vez depois do início). Não é chamado na primeira leitura, ao iniciar.
   */
  readonly onVersion: (platform: string, version: number) => void;
}

/** Intervalo padrão da varredura de garantia (ms): barato (dois `stat`) e o aviso chega em poucos segundos. */
export const DEFAULT_UPDATE_POLL_MS = 2000;

/** Espera depois de um evento do `fs.watch` antes de varrer (ms): junta a rajada de eventos de uma publicação. */
const WATCH_DEBOUNCE_MS = 100;

/** Nome de plataforma aceito (o mesmo de `src/http/updates.ts`): só letras minúsculas. */
const PLATFORM_NAME = /^[a-z]+$/;

/** Arquivo do manifesto dentro da pasta de cada plataforma. */
const MANIFEST_FILE = "manifest.json";

/** `true` se `value` for um objeto simples (não null, não array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Versão do pacote no texto de um manifesto; `null` se não for JSON com `version` inteira ≥ 0. */
export function parseManifestVersion(text: string): number | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const version: unknown = decoded["version"];
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null;
}

/** Vigia de manifestos. Ver o comentário do arquivo. */
export class UpdateWatcher {
  /** Versão publicada de cada plataforma (só as que têm manifesto válido). */
  private readonly versions: Map<string, number> = new Map();
  /** Assinatura (inode:tamanho:data) do último manifesto lido de cada plataforma: igual = não relê. */
  private readonly signatures: Map<string, string> = new Map();
  private readonly dir: string;
  private readonly pollIntervalMs: number;
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** Varredura em andamento (nunca duas ao mesmo tempo) e se outra foi pedida durante ela. */
  private scanning: Promise<void> | null = null;
  private rescan: boolean = false;
  private started: boolean = false;

  constructor(private readonly options: UpdateWatcherOptions) {
    this.dir = resolve(options.dir);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_UPDATE_POLL_MS;
  }

  /** Lê as versões atuais (sem avisar ninguém) e liga o `fs.watch` e a varredura periódica. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.scanOnce(false);
    this.started = true;
    this.ensureFsWatch();
    this.pollTimer = setInterval(() => {
      this.ensureFsWatch();
      void this.scan();
    }, this.pollIntervalMs);
  }

  /** Desliga tudo (servidor fechando). */
  stop(): void {
    this.started = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  /** Versão publicada para `platform`, ou `undefined` se ela não tem manifesto (válido). */
  latestVersion(platform: string): number | undefined {
    return this.versions.get(platform);
  }

  /**
   * Varre agora (avisando versões novas). Se já houver uma varredura em andamento, espera ela e faz mais uma, para
   * não perder a mudança que aconteceu no meio. Exposto para os testes.
   */
  async scan(): Promise<void> {
    if (this.scanning !== null) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async (): Promise<void> => {
      do {
        this.rescan = false;
        await this.scanOnce(true);
      } while (this.rescan && this.started);
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  /** Uma varredura: cada subpasta de plataforma; relê o manifesto que mudou. */
  private async scanOnce(notify: boolean): Promise<void> {
    let platforms: string[];
    try {
      platforms = (await readdir(this.dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && PLATFORM_NAME.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      platforms = []; // pasta ainda não existe: nada publicado
    }
    for (const platform of platforms) await this.check(platform, notify);
    // Plataforma cuja pasta sumiu: deixa de ter versão publicada.
    for (const platform of [...this.versions.keys()]) {
      if (!platforms.includes(platform)) this.forget(platform);
    }
  }

  /** Confere o manifesto de uma plataforma e avisa se a versão subiu. */
  private async check(platform: string, notify: boolean): Promise<void> {
    const path: string = join(this.dir, platform, MANIFEST_FILE);
    let info: Stats;
    try {
      info = await stat(path);
    } catch {
      this.forget(platform);
      return;
    }
    const signature: string = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (this.signatures.get(platform) === signature) return;
    let version: number | null;
    try {
      version = parseManifestVersion(await readFile(path, "utf8"));
    } catch {
      version = null;
    }
    if (version === null) return; // ilegível agora: tenta de novo na próxima varredura
    this.signatures.set(platform, signature);
    const previous: number | undefined = this.versions.get(platform);
    this.versions.set(platform, version);
    if (notify && (previous === undefined || version > previous)) this.options.onVersion(platform, version);
  }

  private forget(platform: string): void {
    this.versions.delete(platform);
    this.signatures.delete(platform);
  }

  /** Liga o `fs.watch` recursivo se a pasta existe e ele ainda não está ligado (falhou → fica só a varredura). */
  private ensureFsWatch(): void {
    if (this.fsWatcher !== null || !this.started) return;
    try {
      const watcher: FSWatcher = watch(this.dir, { recursive: true, persistent: false }, () => this.scheduleScan());
      watcher.on("error", () => {
        watcher.close();
        if (this.fsWatcher === watcher) this.fsWatcher = null;
      });
      this.fsWatcher = watcher;
    } catch {
      this.fsWatcher = null; // pasta inexistente ou sistema sem suporte: a varredura periódica cobre
    }
  }

  private scheduleScan(): void {
    if (this.debounceTimer !== null || !this.started) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.scan();
    }, WATCH_DEBOUNCE_MS);
  }
}
