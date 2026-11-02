import assert from "assert";

import { isValidEmail, isValidPassword, isValidUsername, normalizeKey } from "../src/accounts/credentials.js";
import { hashPassword, verifyPassword } from "../src/accounts/password.js";

describe("regras de conta", () => {
  it("username: 3–16 caracteres, letras/números/_", () => {
    for (const ok of ["Ana", "ana_01", "GaBrIeL_2026", "a".repeat(16)]) assert.ok(isValidUsername(ok), ok);
    for (const bad of ["ab", "a".repeat(17), "com espaço", "joão", "a-b", ""]) assert.ok(!isValidUsername(bad), bad);
  });

  it("e-mail e senha", () => {
    assert.ok(isValidEmail("a@b.com"));
    for (const bad of ["a@b", "ab.com", "a b@c.com", ""]) assert.ok(!isValidEmail(bad), bad);
    assert.ok(isValidPassword("12345678"));
    assert.ok(!isValidPassword("1234567"));
    assert.ok(!isValidPassword("x".repeat(73)));
  });

  it("chave de comparação ignora maiúsculas e espaços nas pontas", () => {
    assert.strictEqual(normalizeKey("  GaBrIeL "), "gabriel");
  });

  it("hash de senha: confere a certa, recusa a errada, salt diferente a cada vez", async () => {
    const a: string = await hashPassword("senha-forte");
    const b: string = await hashPassword("senha-forte");
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith("scrypt$"));
    assert.ok(!a.includes("senha-forte"));
    assert.strictEqual(await verifyPassword("senha-forte", a), true);
    assert.strictEqual(await verifyPassword("senha-errada", a), false);
    assert.strictEqual(await verifyPassword("x", "lixo"), false);
  });
});
