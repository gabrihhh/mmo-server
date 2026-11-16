import { createHash, randomInt } from "node:crypto";

import type { Mailer } from "../mail/mailer.js";
import type { AccountStore, PasswordResetRecord, ResetTarget } from "./AccountStore.js";

/**
 * Recuperar senha por código no e-mail (mmo-docs [INFRA-13]). Testado em `test/passwordReset.test.ts`.
 *
 * 1. `request(login)`: conta achada por username OU e-mail → código de {@link RESET_CODE_DIGITS} dígitos no e-mail da
 *    conta, válido por {@link RESET_CODE_TTL_MS}. Pedir de novo antes de {@link RESET_RESEND_MS} não manda outro.
 * 2. `confirm(login, código, senha nova)`: código certo e no prazo → troca a senha e **encerra todas as sessões**
 *    (aparelhos logados saem). {@link RESET_MAX_ATTEMPTS} erros queimam o código (pedir outro).
 *
 * Para fora a resposta nunca diz se a conta existe (o pedido sempre "foi enviado"; código errado, vencido ou de conta
 * inexistente é o mesmo erro). O banco guarda só o hash do código.
 */

/** Dígitos do código. */
export const RESET_CODE_DIGITS = 6;
/** Validade do código (ms). */
export const RESET_CODE_TTL_MS = 15 * 60 * 1000;
/** Intervalo mínimo entre dois e-mails para a mesma conta (ms). */
export const RESET_RESEND_MS = 60 * 1000;
/** Erros de código aceitos antes de queimá-lo. */
export const RESET_MAX_ATTEMPTS = 5;

/** Resultado de {@link PasswordReset.confirm}: trocou (de quem) ou código inválido. */
export type ResetConfirmResult = { readonly ok: true; readonly playerId: string } | { readonly ok: false };

/** Resultado de {@link PasswordReset.request} (`"failed"` = o e-mail não saiu; quem chama decide). */
export type ResetRequestResult = "sent" | "throttled" | "unknown" | "failed";

/** Código novo, só dígitos, com zeros à esquerda. */
export function generateResetCode(): string {
  return String(randomInt(0, 10 ** RESET_CODE_DIGITS)).padStart(RESET_CODE_DIGITS, "0");
}

/** Hash do código junto do id da conta (o mesmo código em contas diferentes não dá o mesmo hash). */
export function hashResetCode(playerId: string, code: string): string {
  return createHash("sha256").update(`${playerId}:${code}`).digest("hex");
}

/** Texto do e-mail com o código. */
export function resetEmail(username: string, code: string): { subject: string; text: string } {
  const minutes: number = RESET_CODE_TTL_MS / 60000;
  return {
    subject: `Código para trocar a senha: ${code}`,
    text:
      `Olá, ${username}!\n\n` +
      `Seu código para trocar a senha do jogo é: ${code}\n\n` +
      `Ele vale por ${minutes} minutos. Digite-o na tela "Esqueci a senha" junto com a senha nova.\n` +
      `Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.\n`,
  };
}

/** O fluxo de recuperar senha sobre um {@link AccountStore} e um {@link Mailer}. */
export class PasswordReset {
  constructor(
    private readonly accounts: AccountStore,
    private readonly mailer: Mailer,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Pede o código. `"sent"` = mandou; `"throttled"` = pediu há pouco (não manda outro); `"unknown"` = conta não existe.
   * Quem chama responde igual nos três casos.
   */
  async request(login: string): Promise<ResetRequestResult> {
    const target: ResetTarget | null = await this.accounts.findForReset(login);
    if (target === null) return "unknown";
    const now: number = this.now();
    if (target.reset !== null && now - target.reset.sentAt < RESET_RESEND_MS) return "throttled";
    const code: string = generateResetCode();
    const record: PasswordResetRecord = { codeHash: hashResetCode(target.playerId, code), expiresAt: now + RESET_CODE_TTL_MS, attempts: 0, sentAt: now };
    await this.accounts.saveReset(target.playerId, record);
    const mail = resetEmail(target.username, code);
    await this.mailer.send(target.email, mail.subject, mail.text);
    return "sent";
  }

  /** Confere o código e troca a senha (já validada pelas regras de `credentials.ts`). */
  async confirm(login: string, code: string, password: string): Promise<ResetConfirmResult> {
    const target: ResetTarget | null = await this.accounts.findForReset(login);
    const reset: PasswordResetRecord | null = target?.reset ?? null;
    if (target === null || reset === null) return { ok: false };
    if (this.now() > reset.expiresAt || reset.attempts >= RESET_MAX_ATTEMPTS) {
      await this.accounts.saveReset(target.playerId, null);
      return { ok: false };
    }
    if (hashResetCode(target.playerId, code.trim()) !== reset.codeHash) {
      const attempts: number = reset.attempts + 1;
      await this.accounts.saveReset(target.playerId, attempts >= RESET_MAX_ATTEMPTS ? null : { ...reset, attempts });
      return { ok: false };
    }
    await this.accounts.setPassword(target.playerId, password);
    return { ok: true, playerId: target.playerId };
  }
}
