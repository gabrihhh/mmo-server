import assert from "assert";

import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import {
  PasswordReset,
  RESET_CODE_DIGITS,
  RESET_CODE_TTL_MS,
  RESET_MAX_ATTEMPTS,
  RESET_RESEND_MS,
  generateResetCode,
} from "../src/accounts/passwordReset.js";
import { GameServer } from "../src/GameServer.js";
import type { Mailer } from "../src/mail/mailer.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
import { TestClient } from "./helpers.js";

/** Guarda os e-mails em vez de mandar. */
class CaptureMailer implements Mailer {
  readonly label = "teste";
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
  }
  /** Código do último e-mail. */
  lastCode(): string {
    const match: RegExpMatchArray | null = (this.sent.at(-1)?.text ?? "").match(/: (\d{6})\n/);
    assert.ok(match?.[1], "e-mail sem código");
    return match[1];
  }
}

const OLD = "senha-antiga-1";
const NEW = "senha-nova-123";

/** Recuperar senha por código no e-mail ([INFRA-13]). */
describe("recuperar senha", () => {
  let now = 1_000_000;
  const clock = (): number => now;

  async function setup(): Promise<{ store: InMemoryAccountStore; mail: CaptureMailer; reset: PasswordReset }> {
    const store = new InMemoryAccountStore();
    assert.ok((await store.register("Maria", "Maria@Teste.com", OLD)).ok);
    const mail = new CaptureMailer();
    return { store, mail, reset: new PasswordReset(store, mail, clock) };
  }

  it("código de 6 dígitos, com zeros à esquerda", () => {
    for (let i = 0; i < 200; i++) assert.match(generateResetCode(), new RegExp(`^\\d{${RESET_CODE_DIGITS}}$`));
  });

  it("pede pelo username ou e-mail, troca a senha, derruba as sessões e o código não vale de novo", async () => {
    const { store, mail, reset } = await setup();
    const session = await store.login("maria", OLD);
    assert.ok(session);
    assert.strictEqual(await reset.request("MARIA@teste.com"), "sent");
    assert.strictEqual(mail.sent[0]?.to, "maria@teste.com");
    const code: string = mail.lastCode();
    assert.ok(!(mail.sent[0]?.text ?? "").includes(OLD), "o e-mail não leva a senha");
    const done = await reset.confirm("Maria", code, NEW);
    assert.ok(done.ok);
    assert.strictEqual(await store.login("maria", OLD), null, "senha antiga não entra");
    assert.ok(await store.login("maria", NEW), "senha nova entra");
    assert.strictEqual(await store.resume(session.sessionToken), null, "sessões antigas encerradas");
    assert.deepStrictEqual(await reset.confirm("Maria", code, "outra-senha-9"), { ok: false }, "código usado não vale de novo");
  });

  it("conta inexistente: não manda nada (quem chama responde igual)", async () => {
    const { mail, reset } = await setup();
    assert.strictEqual(await reset.request("ninguem@x.com"), "unknown");
    assert.strictEqual(mail.sent.length, 0);
    assert.deepStrictEqual(await reset.confirm("ninguem@x.com", "123456", NEW), { ok: false });
  });

  it("reenvio só depois de 1 minuto; código vence em 15 minutos", async () => {
    const { mail, reset } = await setup();
    assert.strictEqual(await reset.request("maria"), "sent");
    now += RESET_RESEND_MS - 1;
    assert.strictEqual(await reset.request("maria"), "throttled");
    assert.strictEqual(mail.sent.length, 1);
    now += 1;
    assert.strictEqual(await reset.request("maria"), "sent");
    const code: string = mail.lastCode();
    now += RESET_CODE_TTL_MS + 1;
    assert.deepStrictEqual(await reset.confirm("maria", code, NEW), { ok: false }, "vencido");
  });

  it(`${RESET_MAX_ATTEMPTS} códigos errados queimam o código (nem o certo vale depois)`, async () => {
    const { mail, reset } = await setup();
    await reset.request("maria");
    const code: string = mail.lastCode();
    const wrong: string = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) assert.deepStrictEqual(await reset.confirm("maria", wrong, NEW), { ok: false });
    assert.deepStrictEqual(await reset.confirm("maria", code, NEW), { ok: false });
  });

  describe("pelo servidor (protocolo)", () => {
    let server: GameServer;
    let port: number;
    let mail: CaptureMailer;
    const clients: TestClient[] = [];
    const connect = async (): Promise<TestClient> => {
      const c: TestClient = await TestClient.connect(port);
      clients.push(c);
      return c;
    };

    beforeEach(async () => {
      mail = new CaptureMailer();
      server = new GameServer({ accounts: new InMemoryAccountStore(), heartbeatIntervalMs: 100, log: false, mailer: mail });
      port = await server.listen(0);
    });
    afterEach(async () => {
      for (const c of clients.splice(0)) c.socket.terminate();
      await server.close();
    });

    it("pede, recebe o código, troca, quem estava jogando cai e entra com a senha nova", async () => {
      const playing: TestClient = await connect();
      playing.send("register", { version: PROTOCOL_VERSION, username: "Joana", email: "joana@x.com", password: OLD });
      await playing.next("auth_ok");

      const c: TestClient = await connect();
      c.send("password_reset_request", { version: PROTOCOL_VERSION, login: "nao_existe" });
      await c.next("password_reset_sent");
      assert.strictEqual(mail.sent.length, 0, "conta inexistente: mesma resposta, sem e-mail");
      c.send("password_reset_request", { version: PROTOCOL_VERSION, login: "joana@x.com" });
      await c.next("password_reset_sent");

      c.send("password_reset_confirm", { version: PROTOCOL_VERSION, login: "joana@x.com", code: mail.lastCode(), password: "curta" });
      assert.strictEqual((await c.next("error")).data["code"], "invalid_password");
      c.send("password_reset_confirm", { version: PROTOCOL_VERSION, login: "joana@x.com", code: "nao-e", password: NEW });
      assert.strictEqual((await c.next("error")).data["code"], "invalid_reset_code");
      c.send("password_reset_confirm", { version: PROTOCOL_VERSION, login: "joana@x.com", code: mail.lastCode(), password: NEW });
      await c.next("password_reset_done");
      assert.strictEqual(await playing.waitClose(), CloseCode.Replaced, "quem estava logado sai");

      c.send("login", { version: PROTOCOL_VERSION, login: "Joana", password: NEW });
      await c.next("auth_ok");
    });
  });
});
