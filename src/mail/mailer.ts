import nodemailer, { type Transporter } from "nodemailer";

/**
 * Envio de e-mail do servidor (hoje só o código de recuperar senha, mmo-docs [INFRA-13]).
 *
 * - **Sem SMTP configurado** (dev, ou enquanto o e-mail da Hostinger não existe): {@link LogMailer} escreve o e-mail no
 *   log do servidor (`[e-mail] para ...`) — dá para testar o fluxo inteiro lendo o código no `server.log`.
 * - **Com SMTP** (variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` no `.env`): {@link SmtpMailer}
 *   via nodemailer. Hostinger: `smtp.hostinger.com`, porta 465 (SSL), usuário = o endereço completo da caixa.
 */
export interface Mailer {
  /** Envia um e-mail de texto. Falha (rede, senha do SMTP) = exceção. */
  send(to: string, subject: string, text: string): Promise<void>;
  /** Como aparece no log de inicialização ("log" ou "smtp host:porta"). */
  readonly label: string;
}

/** Não envia: escreve no log (dev). */
export class LogMailer implements Mailer {
  readonly label = "log (sem SMTP: o código aparece no log do servidor)";

  async send(to: string, subject: string, text: string): Promise<void> {
    console.log(`[e-mail] para ${to} · ${subject} · ${text.replace(/\s+/g, " ")}`);
  }
}

/** Configuração do SMTP. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  /** Remetente (ex. `"Nome do jogo <no-reply@dominio>"`); padrão = o usuário. */
  readonly from: string;
}

/** Envia por SMTP (nodemailer). Porta 465 = SSL direto; outras = STARTTLS. */
export class SmtpMailer implements Mailer {
  readonly label: string;
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.label = `smtp ${config.host}:${config.port}`;
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, to, subject, text });
  }
}

/** Escolhe o mailer pelas variáveis de ambiente: SMTP completo → {@link SmtpMailer}; senão {@link LogMailer}. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  const host: string | undefined = env["SMTP_HOST"];
  const user: string | undefined = env["SMTP_USER"];
  const pass: string | undefined = env["SMTP_PASS"];
  if (!host || !user || !pass) return new LogMailer();
  const port: number = Number(env["SMTP_PORT"] ?? 465);
  return new SmtpMailer({ host, port: Number.isInteger(port) ? port : 465, user, pass, from: env["MAIL_FROM"] || user });
}
