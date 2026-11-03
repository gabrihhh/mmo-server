/**
 * Contrato de rede cliente ↔ servidor.
 *
 * Transporte: WebSocket, um objeto JSON por mensagem de texto, sempre no formato
 * `{ "type": string, "data": object }`. Posições em metros, rotações em radianos.
 *
 * Fluxo: conectar → autenticar (`register`, `login` ou `resume`) → `auth_ok` → `join` → `welcome` →
 * `input`/`snapshot` (mmo-docs [INFRA-09]).
 *
 * ATENÇÃO: qualquer mudança aqui precisa ser espelhada no cliente
 * (mmo-client/scripts/network/protocol.gd e network.gd) e documentada em mmo-docs [INFRA-04].
 * Mudança incompatível → incremente {@link PROTOCOL_VERSION}.
 */

/** Versão do protocolo. O cliente envia a dele ao autenticar; se for diferente, a conexão é recusada. */
export const PROTOCOL_VERSION = 7;

/** Tipos de mensagem cliente → servidor. */
export const ClientMessageType = {
  /** Cria conta (username, e-mail, senha). Payload: {@link RegisterData}. */
  Register: "register",
  /** Entra com username OU e-mail + senha. Payload: {@link LoginData}. */
  Login: "login",
  /** Entra com o token de sessão salvo no aparelho. Payload: {@link ResumeData}. */
  Resume: "resume",
  /** Encerra a sessão deste aparelho (o token deixa de valer) e fecha a conexão. Payload: `{}`. */
  Logout: "logout",
  /** Pede para entrar numa zona (exige estar autenticado). Payload: {@link JoinData}. */
  Join: "join",
  /**
   * Intenção de movimento de UM tick (não a posição: o servidor é a autoridade e simula).
   * Payload: {@link InputData}. Ver mmo-docs [INFRA-09].
   */
  Input: "input",
  /** Veste um item da mochila (o do slot volta para a mochila). Payload: {@link EquipData}. */
  Equip: "equip",
  /** Tira o item de um slot para a mochila. Payload: {@link UnequipData}. */
  Unequip: "unequip",
  /** Fixa (ou limpa, com `null`) o alvo do ataque simples; o servidor ataca sozinho quando em alcance. Payload: {@link AttackData}. */
  Attack: "attack",
  /** Lança uma habilidade (carta) vestida. Payload: {@link CastData}. Ver mmo-docs [JOGO-06]. */
  Cast: "cast",
} as const;

/** Tipos de mensagem servidor → cliente. */
export const ServerMessageType = {
  /** Autenticação aceita: quem é o jogador e o token de sessão a guardar. */
  AuthOk: "auth_ok",
  /** Entrada na zona aceita: tick, parâmetros da simulação e todos os jogadores (inclusive o próprio). */
  Welcome: "welcome",
  /** Outro jogador entrou na zona. */
  PlayerJoined: "player_joined",
  /** Um jogador saiu da zona. */
  PlayerLeft: "player_left",
  /** Estado da zona a cada tick de simulação, com o último input processado de quem recebe. */
  Snapshot: "snapshot",
  /** Inventário completo (vestido + mochila) com o que cada item faz. Vem após o `auth_ok` e a cada troca. */
  Inventory: "inventory",
  /** Pedido recusado ou mensagem inválida. Ver {@link ErrorCode}. */
  Error: "error",
} as const;

/** Códigos enviados em {@link ServerMessageType.Error}. */
export const ErrorCode = {
  /** JSON inválido, tipo desconhecido ou payload fora do formato. A conexão continua. */
  BadMessage: "bad_message",
  /** Versão do protocolo diferente da do servidor. A conexão é fechada. */
  VersionMismatch: "version_mismatch",
  /** Username fora das regras (3–16 caracteres: letras, números, `_`). A conexão continua. */
  InvalidUsername: "invalid_username",
  /** E-mail com formato inválido. A conexão continua. */
  InvalidEmail: "invalid_email",
  /** Senha fora das regras (8–72 caracteres). A conexão continua. */
  InvalidPassword: "invalid_password",
  /** Username já usado (sem diferenciar maiúsculas). A conexão continua. */
  UsernameTaken: "username_taken",
  /** E-mail já usado. A conexão continua. */
  EmailTaken: "email_taken",
  /** Login: usuário/e-mail ou senha errados (sem dizer qual). A conexão continua. */
  InvalidCredentials: "invalid_credentials",
  /** Token de sessão desconhecido ou encerrado: o cliente apaga o token e mostra o login. A conexão continua. */
  InvalidSession: "invalid_session",
  /** Tentativas de autenticação demais nesta conexão. A conexão é fechada. */
  TooManyAttempts: "too_many_attempts",
  /** Autenticar de novo numa conexão já autenticada. A conexão continua. */
  AlreadyAuthenticated: "already_authenticated",
  /** `join`/`input` antes de autenticar. A conexão continua. */
  NotAuthenticated: "not_authenticated",
  /** Zona inexistente. A conexão é fechada. */
  UnknownZone: "unknown_zone",
  /** Zona lotada. A conexão é fechada. */
  ZoneFull: "zone_full",
  /** `join` repetido na mesma conexão. A conexão continua. */
  AlreadyJoined: "already_joined",
  /** `equip` de item que não está na mochila. A conexão continua. */
  ItemNotFound: "item_not_found",
  /** Mochila cheia (não dá para tirar o item do slot). A conexão continua. */
  BagFull: "bag_full",
  /** `unequip` de slot vazio. A conexão continua. */
  SlotEmpty: "slot_empty",
  /** Alvo inexistente, morto, você mesmo, ou jogador numa zona sem PvP. A conexão continua. */
  InvalidTarget: "invalid_target",
  /** `cast` de habilidade que não está vestida. A conexão continua. */
  AbilityNotEquipped: "ability_not_equipped",
  /** Habilidade ainda recarregando. A conexão continua. */
  OnCooldown: "on_cooldown",
  /** Mana insuficiente. A conexão continua. */
  NotEnoughMana: "not_enough_mana",
  /** Alvo fora do alcance ao começar. A conexão continua. */
  OutOfRange: "out_of_range",
  /** Habilidade ainda não implementada no servidor (Investida/Disparada até o passo 3c). A conexão continua. */
  AbilityUnavailable: "ability_unavailable",
  /** Não pode agir agora (morto, ou já lançando outra habilidade). A conexão continua. */
  Busy: "busy",
  /** Falha interna (ex.: banco fora do ar). A conexão é fechada. */
  ServerError: "server_error",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Close codes do WebSocket usados pelo servidor. */
export const CloseCode = {
  /** Saída normal (inclui logout). */
  Normal: 1000,
  /** Recusado (veja a mensagem `error` enviada antes do fechamento). */
  Rejected: 4000,
  /** Conexão sem resposta ao ping (heartbeat). */
  Timeout: 4001,
  /** A mesma conta entrou por outra conexão (outro aparelho/janela); esta foi derrubada. */
  Replaced: 4002,
} as const;

/** Payload de `register`. Regras em `src/accounts/credentials.ts`. */
export interface RegisterData {
  /** {@link PROTOCOL_VERSION} do cliente. */
  readonly version: number;
  /** Como o jogador quer aparecer no jogo (é exibido exatamente assim). */
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** Payload de `login`. */
export interface LoginData {
  readonly version: number;
  /** Username ou e-mail (sem diferenciar maiúsculas). */
  readonly login: string;
  readonly password: string;
}

/** Payload de `resume`. */
export interface ResumeData {
  readonly version: number;
  /** Token recebido no último `auth_ok`. */
  readonly sessionToken: string;
}

/** Payload de `join`. */
export interface JoinData {
  /** Id da zona (ex.: `"zone_1"`). */
  readonly zone: string;
}

/** Maior número de sequência aceito (cabe com folga num int de 32 bits). */
export const MAX_INPUT_SEQ = 2_000_000_000;

/** Payload de `input`: direção desejada no mundo para um tick. */
export interface InputData {
  /** Número do input, crescente a partir de 1. O servidor devolve o último processado em `snapshot.ack`. */
  readonly seq: number;
  /** Direção no plano XZ do mundo; comprimento até 1 (maior é normalizado pelo servidor). */
  readonly x: number;
  readonly z: number;
}

/** Slots vestidos (mesma ordem da HUD). ATENÇÃO: igual a EQUIP_SLOTS em src/items/catalog.ts. */
export const EQUIP_SLOT_NAMES = ["hand", "head", "chest", "feet"] as const;
export type EquipSlotName = (typeof EQUIP_SLOT_NAMES)[number];

/** Payload de `equip`. */
export interface EquipData {
  /** `uid` do item na mochila. */
  readonly uid: string;
}

/** Payload de `unequip`. */
export interface UnequipData {
  readonly slot: EquipSlotName;
}

/** Payload de `cast`. O que vai depende do tipo de mira da habilidade ([JOGO-06]). */
export interface CastData {
  readonly abilityId: string;
  /** Mira "target": id do alvo. */
  readonly targetId: string | null;
  /**
   * Mira "direction": direção no plano XZ (não precisa estar normalizada).
   * Mira "area": ponto no chão (limitado ao alcance pelo servidor). Outras miras: ignorado.
   */
  readonly x: number | null;
  readonly z: number | null;
}

/** Payload de `attack`. */
export interface AttackData {
  /** Id do jogador ou boneco a atacar; `null` para parar de atacar. */
  readonly targetId: string | null;
}

/** Mensagem cliente → servidor já validada (formato; as regras de conta são checadas depois). */
export type ClientMessage =
  | { readonly type: typeof ClientMessageType.Register; readonly data: RegisterData }
  | { readonly type: typeof ClientMessageType.Login; readonly data: LoginData }
  | { readonly type: typeof ClientMessageType.Resume; readonly data: ResumeData }
  | { readonly type: typeof ClientMessageType.Logout; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.Join; readonly data: JoinData }
  | { readonly type: typeof ClientMessageType.Input; readonly data: InputData }
  | { readonly type: typeof ClientMessageType.Equip; readonly data: EquipData }
  | { readonly type: typeof ClientMessageType.Unequip; readonly data: UnequipData }
  | { readonly type: typeof ClientMessageType.Attack; readonly data: AttackData }
  | { readonly type: typeof ClientMessageType.Cast; readonly data: CastData };

/** Estado público de um jogador, como vai no `snapshot` (a cada tick, sem o nome para economizar). */
export interface PlayerSnapshot {
  /** Id do jogador (playerId). */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
  /** Vida atual e máxima (arredondada a 0,1). */
  readonly hp: number;
  readonly maxHp: number;
  /** Morto (esperando renascer). */
  readonly dead: boolean;
  /** Escudo ativo (dano que ainda absorve; 0 = sem escudo). */
  readonly shield: number;
}

/** Boneco de treino / monstro: mesmos campos do jogador + nome. Vai em `welcome.npcs` e `snapshot.npcs`. */
export interface NpcSnapshot extends PlayerSnapshot {
  readonly name: string;
}

/** Evento de combate do tick (para números de dano e efeitos). Vai em `snapshot.events` para todos da zona. */
export type CombatEvent =
  | {
      readonly type: "damage";
      readonly source: string;
      readonly target: string;
      /** Dano na vida. */
      readonly amount: number;
      /** Dano absorvido pelo escudo (0 sem escudo). */
      readonly absorbed: number;
      readonly ability: string;
    }
  | {
      readonly type: "cast_start";
      readonly source: string;
      readonly ability: string;
      /** Alvo (mira "target" e ataque simples); "" nas outras miras. */
      readonly target: string;
      readonly duration: number;
      /** Ponto mirado (área) ou um ponto na direção (linha); para efeitos visuais. Ausente nas outras miras. */
      readonly x?: number;
      readonly z?: number;
    }
  | { readonly type: "heal"; readonly source: string; readonly target: string; readonly amount: number; readonly ability: string }
  | { readonly type: "impact"; readonly source: string; readonly ability: string; readonly x: number; readonly z: number; readonly radius: number }
  | { readonly type: "miss"; readonly source: string; readonly target: string; readonly ability: string }
  | { readonly type: "death"; readonly id: string; readonly killer: string }
  | { readonly type: "respawn"; readonly id: string };

/** Só de quem recebe o snapshot (os outros não sabem). */
export interface OwnStatus {
  readonly mana: number;
  readonly maxMana: number;
  /** Segundos até renascer (0 = vivo). */
  readonly respawnIn: number;
  /** Alvo fixo do ataque simples (`null` = nenhum). */
  readonly target: string | null;
  /** Lançamento em andamento (`null` = nenhum): habilidade, alvo e segundos que faltam. */
  readonly casting: { readonly ability: string; readonly target: string; readonly remaining: number } | null;
}

/** Jogador completo, como vai no `welcome` e no `player_joined`: posição + nome exibido. */
export interface PlayerInfo extends PlayerSnapshot {
  /** Username exatamente como foi cadastrado. */
  readonly name: string;
}

/** Parâmetros da simulação enviados no `welcome`. */
export interface SimParams {
  /** Ticks por segundo. */
  readonly tickRate: number;
  /** Velocidade de caminhada, m/s. */
  readonly moveSpeed: number;
  /** Metade do lado da zona, em metros. */
  readonly zoneHalfSize: number;
}

/** Habilidade como o cliente vê: nome e mira (efeitos ficam no servidor). Metros. */
export interface AbilityView {
  readonly id: string;
  readonly title: string;
  /** "target" | "direction" | "area" | "area_self" | "self". */
  readonly aim: string;
  readonly range: number;
  readonly radius: number;
  /** Tempo de recarga em segundos (o cliente mostra o "relógio" na carta; o servidor é quem recusa antes da hora). */
  readonly cooldown: number;
  /** Tempo de lançamento em segundos (o personagem fica virado para o alvo/direção durante ele). */
  readonly castTime: number;
}

/** Item como o cliente vê. */
export interface ItemView {
  readonly uid: string;
  readonly itemId: string;
  readonly name: string;
  readonly slot: EquipSlotName;
  /** Ataque simples (só armas). */
  readonly basicAttack: AbilityView | null;
  readonly abilities: readonly AbilityView[];
}

/** Payload de `inventory`. */
export interface InventoryView {
  readonly equipped: Readonly<Record<EquipSlotName, ItemView | null>>;
  readonly bag: readonly ItemView[];
  readonly bagCapacity: number;
  /** Ataque simples quando não há arma na mão. */
  readonly unarmedAttack: AbilityView;
}

/** Payload de `snapshot`. */
export interface SnapshotData {
  /** Número do tick do servidor que gerou este estado. */
  readonly tick: number;
  /** Último `input.seq` de QUEM RECEBE que já foi aplicado (0 = nenhum). Base da reconciliação. */
  readonly ack: number;
  /** Todos os jogadores da zona (inclusive quem recebe). */
  readonly players: readonly PlayerSnapshot[];
  /** Bonecos/monstros da zona. */
  readonly npcs: readonly NpcSnapshot[];
  /** O que aconteceu neste tick (dano, mortes, renascimentos). */
  readonly events: readonly CombatEvent[];
  /** Dados só de quem recebe. */
  readonly me: OwnStatus;
}

/** Mensagem servidor → cliente. */
export type ServerMessage =
  | {
      readonly type: typeof ServerMessageType.AuthOk;
      readonly data: {
        /** Id do jogador desta conexão. */
        readonly playerId: string;
        /** Username exibido. */
        readonly username: string;
        /** Token a guardar no aparelho e mandar no próximo `resume`. */
        readonly sessionToken: string;
      };
    }
  | {
      readonly type: typeof ServerMessageType.Welcome;
      readonly data: {
        readonly playerId: string;
        readonly zone: string;
        /** Tick atual do servidor (o cliente sincroniza o relógio da interpolação por ele). */
        readonly tick: number;
        /** Parâmetros da simulação compartilhada (o cliente usa os do servidor, não os dele). */
        readonly sim: SimParams;
        /** Jogadores podem ser atacados nesta zona. */
        readonly pvp: boolean;
        readonly players: readonly PlayerInfo[];
        /** Bonecos/monstros da zona. */
        readonly npcs: readonly NpcSnapshot[];
      };
    }
  | { readonly type: typeof ServerMessageType.PlayerJoined; readonly data: { readonly player: PlayerInfo } }
  | { readonly type: typeof ServerMessageType.PlayerLeft; readonly data: { readonly id: string } }
  | { readonly type: typeof ServerMessageType.Snapshot; readonly data: SnapshotData }
  | { readonly type: typeof ServerMessageType.Inventory; readonly data: InventoryView }
  | { readonly type: typeof ServerMessageType.Error; readonly data: { readonly code: ErrorCode; readonly message: string } };

/** Serializa uma mensagem para enviar pelo WebSocket. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** `true` se `value` for um objeto simples (não null, não array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `true` se `value` for um número finito (rejeita NaN, Infinity e não-números). */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** `true` se `value` for string com até `max` caracteres. */
const isStringUpTo = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** Versão do protocolo válida (inteiro). */
const isVersion = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value);

/**
 * Tamanho máximo aceito nos campos de texto de autenticação. É só um limite de formato (proteção);
 * as regras de verdade (ex.: senha até 72) ficam em `credentials.ts` e geram erros específicos.
 */
const MAX_AUTH_FIELD = 256;

/** Valida o formato de `register`. */
export function parseRegisterData(data: unknown): RegisterData | null {
  if (!isRecord(data)) return null;
  const { version, username, email, password } = data;
  if (!isVersion(version)) return null;
  if (!isStringUpTo(username, MAX_AUTH_FIELD) || !isStringUpTo(email, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, username, email, password };
}

/** Valida o formato de `login`. */
export function parseLoginData(data: unknown): LoginData | null {
  if (!isRecord(data)) return null;
  const { version, login, password } = data;
  if (!isVersion(version) || !isStringUpTo(login, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, login, password };
}

/** Valida o formato de `resume`. */
export function parseResumeData(data: unknown): ResumeData | null {
  if (!isRecord(data)) return null;
  const { version, sessionToken } = data;
  if (!isVersion(version) || !isStringUpTo(sessionToken, 128) || sessionToken.length === 0) return null;
  return { version, sessionToken };
}

/** Valida o payload de `join`. */
export function parseJoinData(data: unknown): JoinData | null {
  if (!isRecord(data)) return null;
  const { zone } = data;
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return null;
  return { zone };
}

/** Valida o payload de `input`. A direção pode ter qualquer comprimento: a simulação normaliza. */
export function parseInputData(data: unknown): InputData | null {
  if (!isRecord(data)) return null;
  const { seq, x, z } = data;
  if (!isFiniteNumber(seq) || !Number.isInteger(seq) || seq < 1 || seq > MAX_INPUT_SEQ) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(z)) return null;
  return { seq, x, z };
}

/** Valida o payload de `equip`. */
export function parseEquipData(data: unknown): EquipData | null {
  if (!isRecord(data)) return null;
  const { uid } = data;
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 64) return null;
  return { uid };
}

/** `true` se `value` é um nome de slot vestido. */
const isSlotName = (value: unknown): value is EquipSlotName =>
  typeof value === "string" && EQUIP_SLOT_NAMES.some((slot) => slot === value);

/** Valida o payload de `unequip`. */
export function parseUnequipData(data: unknown): UnequipData | null {
  if (!isRecord(data)) return null;
  const { slot } = data;
  return isSlotName(slot) ? { slot } : null;
}

/** Número finito ou ausente/null (→ null). `undefined` no retorno = inválido. */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

/** Valida o payload de `cast`. */
export function parseCastData(data: unknown): CastData | null {
  if (!isRecord(data)) return null;
  const { abilityId, targetId } = data;
  if (typeof abilityId !== "string" || abilityId.length === 0 || abilityId.length > 64) return null;
  let target: string | null = null;
  if (targetId !== undefined && targetId !== null) {
    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 64) return null;
    target = targetId;
  }
  const x: number | null | undefined = optionalNumber(data["x"]);
  const z: number | null | undefined = optionalNumber(data["z"]);
  if (x === undefined || z === undefined) return null;
  return { abilityId, targetId: target, x, z };
}

/** Valida o payload de `attack`. */
export function parseAttackData(data: unknown): AttackData | null {
  if (!isRecord(data)) return null;
  const { targetId } = data;
  if (targetId === null || targetId === undefined) return { targetId: null };
  if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 64) return null;
  return { targetId };
}

/**
 * Decodifica e valida uma mensagem de texto vinda da rede (não confiável).
 * @returns a mensagem tipada, ou `null` se o JSON, o tipo ou o payload forem inválidos.
 */
export function parseClientMessage(text: string): ClientMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const raw: unknown = decoded["data"];

  switch (decoded["type"]) {
    case ClientMessageType.Register: {
      const data = parseRegisterData(raw);
      return data === null ? null : { type: ClientMessageType.Register, data };
    }
    case ClientMessageType.Login: {
      const data = parseLoginData(raw);
      return data === null ? null : { type: ClientMessageType.Login, data };
    }
    case ClientMessageType.Resume: {
      const data = parseResumeData(raw);
      return data === null ? null : { type: ClientMessageType.Resume, data };
    }
    case ClientMessageType.Logout:
      return { type: ClientMessageType.Logout, data: {} };
    case ClientMessageType.Join: {
      const data = parseJoinData(raw);
      return data === null ? null : { type: ClientMessageType.Join, data };
    }
    case ClientMessageType.Input: {
      const data = parseInputData(raw);
      return data === null ? null : { type: ClientMessageType.Input, data };
    }
    case ClientMessageType.Equip: {
      const data = parseEquipData(raw);
      return data === null ? null : { type: ClientMessageType.Equip, data };
    }
    case ClientMessageType.Unequip: {
      const data = parseUnequipData(raw);
      return data === null ? null : { type: ClientMessageType.Unequip, data };
    }
    case ClientMessageType.Attack: {
      const data = parseAttackData(raw);
      return data === null ? null : { type: ClientMessageType.Attack, data };
    }
    case ClientMessageType.Cast: {
      const data = parseCastData(raw);
      return data === null ? null : { type: ClientMessageType.Cast, data };
    }
    default:
      return null;
  }
}
