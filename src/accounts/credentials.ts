/**
 * Regras de username, e-mail e senha. Ver mmo-docs [INFRA-07].
 *
 * Username: a UNICIDADE e o login não diferenciam maiúsculas/minúsculas ({@link normalizeKey}),
 * mas o nome EXIBIDO no jogo é exatamente o que o jogador digitou no cadastro.
 *
 * ATENÇÃO: o cliente repete estas regras para avisar na hora (mmo-client/scripts/network/protocol.gd,
 * constantes USERNAME_*, PASSWORD_*). Quem decide é sempre o servidor.
 */

/** Tamanho do username, em caracteres. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 16;
/** Username: letras sem acento, números e `_`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** Tamanho da senha. 72 é o limite prático de vários algoritmos de hash; evita senhas gigantes. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

/** Tamanho máximo do e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;
/** Validação simples de e-mail (algo@algo.algo, sem espaços). Não confirmamos se o e-mail existe. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `true` se o username segue as regras. */
export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}

/** `true` se o e-mail tem formato válido. */
export function isValidEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

/** `true` se a senha tem tamanho válido (contado em caracteres). */
export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

/**
 * Chave de comparação: sem espaços nas pontas e em minúsculas. Usada para unicidade e login
 * (`Gabriel` e `gabriel` são o mesmo username; `A@B.com` e `a@b.com`, o mesmo e-mail).
 * NÃO é o que aparece no jogo: o nome exibido é o original.
 */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
