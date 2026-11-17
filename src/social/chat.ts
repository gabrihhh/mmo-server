/**
 * Chat ([SOC-09]): regras puras (sem rede), para testar fácil. Quem entrega as mensagens é o `GameServer`.
 * Nada é guardado no banco: o chat vive na sessão.
 */

/** Canais do chat. ATENÇÃO: = CHANNELS em mmo-client/scripts/ui/chat_panel.gd. */
export const CHAT_CHANNELS = ["zone", "group", "guild", "private", "global"] as const;
/** Um canal do chat. */
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/** Tamanho máximo da mensagem (caracteres, depois de limpar). */
export const CHAT_MAX_LENGTH = 200;
/** Anti-spam: no máximo esta quantidade de mensagens (todos os canais menos o Global)… */
export const SPAM_MAX_MESSAGES = 5;
/** …nesta janela (ms). */
export const SPAM_WINDOW_MS = 10_000;
/** Passou do limite: fica este tempo (ms) sem poder falar. */
export const SPAM_MUTE_MS = 30_000;
/** A mesma mensagem esta quantidade de vezes seguidas dentro de {@link REPEAT_WINDOW_MS} é recusada. */
export const REPEAT_LIMIT = 3;
/** Janela (ms) da mensagem repetida. */
export const REPEAT_WINDOW_MS = 30_000;
/** Global: uma mensagem a cada este tempo (ms) por jogador (decisão do dono, 2026-11-17). */
export const GLOBAL_COOLDOWN_MS = 10 * 60_000;

/** `true` se [value] é um canal válido. */
export function isChatChannel(value: unknown): value is ChatChannel {
  return typeof value === "string" && (CHAT_CHANNELS as readonly string[]).includes(value);
}

/**
 * Limpa o texto: quebras de linha e tabulações viram espaço, espaços repetidos viram um, sem espaço nas pontas.
 * `null` se ficou vazio ou passou de {@link CHAT_MAX_LENGTH}.
 */
export function cleanChatText(raw: string): string | null {
  const text: string = raw.replace(/[\s\u0000-\u001f]+/g, " ").trim();
  if (text.length === 0 || [...text].length > CHAT_MAX_LENGTH) return null;
  return text;
}

/** Motivo de recusa de uma mensagem. */
export type ChatRefusal = "spam" | "repeat" | "cooldown";

/** Resultado do limitador: pode mandar, ou o motivo e quantos segundos faltam. */
export type ChatCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ChatRefusal; readonly seconds: number };

/** Estado do anti-spam de um jogador. */
interface SpamState {
  /** Horas (ms) das últimas mensagens (fora o Global), dentro da janela. */
  sent: number[];
  /** Até quando (ms) está sem poder falar. */
  mutedUntil: number;
  /** Último texto (minúsculo) e quantas vezes seguidas ele veio, e quando foi a primeira dessas. */
  lastText: string;
  repeats: number;
  repeatSince: number;
  /** Hora (ms) da última mensagem no Global. */
  lastGlobal: number;
}

/** Anti-spam e relógio do Global de todos os jogadores (por id). */
export class ChatLimiter {
  private readonly states: Map<string, SpamState> = new Map();

  /** Confere se [playerId] pode mandar [text] no [channel] agora ([nowMs]); se pode, já conta a mensagem. */
  check(playerId: string, channel: ChatChannel, text: string, nowMs: number): ChatCheck {
    const state: SpamState = this.states.get(playerId) ?? { sent: [], mutedUntil: 0, lastText: "", repeats: 0, repeatSince: 0, lastGlobal: -Infinity };
    this.states.set(playerId, state);
    if (nowMs < state.mutedUntil) return { ok: false, reason: "spam", seconds: Math.ceil((state.mutedUntil - nowMs) / 1000) };
    if (channel === "global" && nowMs - state.lastGlobal < GLOBAL_COOLDOWN_MS) {
      return { ok: false, reason: "cooldown", seconds: Math.ceil((state.lastGlobal + GLOBAL_COOLDOWN_MS - nowMs) / 1000) };
    }
    const key: string = text.toLowerCase();
    const repeats: number = key === state.lastText && nowMs - state.repeatSince <= REPEAT_WINDOW_MS ? state.repeats + 1 : 1;
    if (repeats >= REPEAT_LIMIT) return { ok: false, reason: "repeat", seconds: Math.ceil((state.repeatSince + REPEAT_WINDOW_MS - nowMs) / 1000) };
    if (channel !== "global") {
      state.sent = state.sent.filter((at) => nowMs - at < SPAM_WINDOW_MS);
      if (state.sent.length >= SPAM_MAX_MESSAGES) {
        state.mutedUntil = nowMs + SPAM_MUTE_MS;
        state.sent = [];
        return { ok: false, reason: "spam", seconds: Math.ceil(SPAM_MUTE_MS / 1000) };
      }
      state.sent.push(nowMs);
    } else {
      state.lastGlobal = nowMs;
    }
    if (repeats === 1) state.repeatSince = nowMs;
    state.lastText = key;
    state.repeats = repeats;
    return { ok: true };
  }

  /** Esquece o jogador (saiu do jogo). O relógio do Global não zera ao relogar: fica guardado até o servidor reiniciar. */
  forgetSpam(playerId: string): void {
    const state: SpamState | undefined = this.states.get(playerId);
    if (state === undefined) return;
    if (state.lastGlobal === -Infinity) this.states.delete(playerId);
    else this.states.set(playerId, { sent: [], mutedUntil: state.mutedUntil, lastText: "", repeats: 0, repeatSince: 0, lastGlobal: state.lastGlobal });
  }
}
