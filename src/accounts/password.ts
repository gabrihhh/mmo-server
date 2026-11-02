import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Hash de senha com scrypt (embutido no Node, sem dependência). Ver mmo-docs [INFRA-07].
 *
 * Formato salvo: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`. Os parâmetros vão junto para
 * podermos aumentar o custo no futuro sem invalidar as senhas antigas.
 */

/** Custo do scrypt (padrão recomendado pelo Node: ~50 ms por hash, 16 MB de memória). */
const COST_N = 16384;
const BLOCK_SIZE_R = 8;
const PARALLELIZATION_P = 1;
/** Bytes do salt e do hash. */
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** scrypt em forma de Promise. */
function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Gera o hash de uma senha (salt aleatório a cada chamada). */
export async function hashPassword(password: string): Promise<string> {
  const salt: Buffer = randomBytes(SALT_BYTES);
  const key: Buffer = await deriveKey(password, salt, COST_N, BLOCK_SIZE_R, PARALLELIZATION_P);
  return ["scrypt", COST_N, BLOCK_SIZE_R, PARALLELIZATION_P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** `true` se `password` confere com `stored` (comparação em tempo constante). Formato inválido = `false`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts: string[] = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n: number = Number(parts[1]);
  const r: number = Number(parts[2]);
  const p: number = Number(parts[3]);
  const salt: Buffer = Buffer.from(parts[4] ?? "", "base64");
  const expected: Buffer = Buffer.from(parts[5] ?? "", "base64");
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length !== KEY_BYTES) return false;
  const actual: Buffer = await deriveKey(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}
