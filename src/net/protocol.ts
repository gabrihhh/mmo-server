import { isAttributeId, type AttributeId } from "../items/attributes.js";
import { RANKING_CATEGORIES, RANKING_PERIODS, type RankingCategory, type RankingPeriod } from "../progression/ranking.js";

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

/**
 * Versão do protocolo. O cliente envia a dele ao autenticar; se for diferente, a conexão é recusada
 * (`version_mismatch`), a não ser que o pacote do cliente esteja desatualizado: aí vai `update_required` (v16).
 * v17: `group_positions` (posição dos membros do grupo longe, para o mapa; mmo-docs [SOC-03]).
 * v18: `tauntSeconds` no {@link AbilityView} (Desafio do cavaleiro provoca os monstros; mmo-docs [JOGO-14]).
 * v34: troca entre jogadores ([SOC-05]): `trade_request`/`trade_answer`/`trade_offer`/`trade_confirm`/`trade_cancel` →
 *   `trade_requested`/`trade_state`/`trade_done`/`trade_notice`; `tradeRequests` na Configuração social.
 * v35: `item_destroy { uid }` (botão Destruir da ficha do item; mmo-docs [JOGO-24]).
 * v36: Loja do Ferreiro ([JOGO-23]): `shop_open`/`shop_buy`/`shop_sell` → `shop`/`shop_result`; `sellPrice` no
 *   ItemView; erro `item_equipped`.
 * v33: busca no Procurar guilda: `guild_list { query }` (nome ou tag; acha também as cheias).
 * v32: procurar guilda e solicitações ([SOC-06]): `guild_list`/`guild_info`/`guild_request`/`guild_request_answer`/
 *   `guild_description`; descrição no `guild_create` e no {@link GuildView}; `requests` na guilda de líder/oficial.
 * v31: rankings ([SOC-07]): `ranking_request { category, period }` → `ranking` (top 100, sua posição, quando vira).
 * v30: guilda ([SOC-06]): `guild_create`/`guild_invite`/`guild_answer`/`guild_leave`/`guild_kick`/`guild_role` →
 *   `guild`/`guild_invited`/`guild_notice`; `player_guild` (tag de um jogador da zona mudou); `guildId`/`guildTag` no
 *   {@link PlayerInfo}; `guildInvites` na Configuração social.
 * v29: perfil ([SOC-08]): `profile` (público/só amigos/ninguém) na Configuração social; `attributes` traz `stats` (XP de
 *   monstros, jogadores mortos, mortes) ou, perfil fechado para quem pediu, só `hidden: true` ({@link HiddenAttributesView}).
 * v28: acampamentos ([JOGO-19]): `resetIn` (segundos até o acampamento voltar) no {@link ChestView} e no evento
 *   `chest`, que também vai quando o relógio começa/muda/para (mapa, [CLI-11]).
 * v27: recuperar senha ([INFRA-13]): `password_reset_request`/`password_reset_confirm` → `password_reset_sent`/
 *   `password_reset_done`, erro `invalid_reset_code`.
 * v26: PvP ([JOGO-22]): `levelsLost` no `death_report` (morte para jogador: −1 nível, moedas para quem matou).
 * v25: tela de morte ([JOGO-21]): `death_report` (perdas e a peça da roleta) e `respawn` (renascer pelo botão).
 * v24: fusão no ferreiro ([JOGO-20]): `fuse`/`fuse_result`, `xp`/`xpNext`/`fusionXp` no ItemView.
 * v23: baús dos acampamentos ([JOGO-19]): `chests` no welcome, evento `chest`, `chest_open`/`chest_take`/`chest_loot`.
 * v22: snapshot por diferença (só o que mudou, `gone`, `me` parcial), posição em cm, eventos só perto, limite da
 *   multidão ({@link SnapshotData}, mmo-docs [INFRA-11]).
 */
export const PROTOCOL_VERSION = 36;

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
  /**
   * Esqueci a senha ([INFRA-13]): manda um código para o e-mail da conta (username ou e-mail). Antes de autenticar.
   * Payload: {@link PasswordResetRequestData}. Resposta: sempre {@link ServerMessageType.PasswordResetSent}.
   */
  PasswordResetRequest: "password_reset_request",
  /**
   * Troca a senha com o código do e-mail. Payload: {@link PasswordResetConfirmData}. Resposta:
   * {@link ServerMessageType.PasswordResetDone} ou erro `invalid_reset_code` / `invalid_password`.
   */
  PasswordResetConfirm: "password_reset_confirm",
  /**
   * Sinal de vida do celular parado ([INFRA-12]): mensagem vazia a cada ~100 ms quando não manda passos, para o Wi-Fi do
   * Android não entrar em economia de energia (que entrega os snapshots em lotes e faz os outros andarem aos trancos).
   * O servidor só ignora. ATENÇÃO: enviado por mmo-client/scripts/network/network.gd (`_keep_radio_awake`).
   */
  KeepAlive: "ka",
  /**
   * Escolhe o corpo do personagem (uma vez só, na primeira entrada; vale para sempre). Payload: {@link ChooseBodyData}.
   * Ver mmo-docs [INFRA-07].
   */
  ChooseBody: "choose_body",
  /** Pede para entrar numa zona (exige estar autenticado e ter escolhido o corpo). Payload: {@link JoinData}. */
  Join: "join",
  /**
   * Intenção de movimento de UM tick (não a posição: o servidor é a autoridade e simula).
   * Payload: {@link InputData}. Ver mmo-docs [INFRA-09].
   */
  Input: "input",
  /** Veste um item da mochila (o do slot volta para a mochila). Payload: {@link EquipData}. */
  Equip: "equip",
  /** Tira o item de um slot para a mochila (no fim, ou na vaga onde foi solto). Payload: {@link UnequipData}. */
  Unequip: "unequip",
  /** Organiza a mochila: troca o item de uma vaga com o de outra ([CLI-10]). Payload: {@link BagMoveData}. */
  BagMove: "bag_move",
  /** Destrói um item para sempre (botão Destruir da ficha, [JOGO-24]). Payload: {@link ItemDestroyData}. */
  ItemDestroy: "item_destroy",
  /** Abre a aba Loja do Ferreiro ([JOGO-23]): pede a lista do que está à venda. Sem payload. Resposta: `shop`. */
  ShopOpen: "shop_open",
  /** Compra uma peça +0 na Loja do Ferreiro. Payload: {@link ShopBuyData}. Resposta: `shop_result` + `inventory`. */
  ShopBuy: "shop_buy",
  /** Vende um item da mochila na Loja do Ferreiro. Payload: {@link ShopSellData}. Resposta: `shop_result` + `inventory`. */
  ShopSell: "shop_sell",
  /**
   * Tenta melhorar um item no ferreiro (perto dele, com moedas, [JOGO-16]). Payload: {@link UpgradeData}.
   * Resposta: {@link ServerMessageType.UpgradeResult} (+ `inventory` se subiu de nível) ou erro.
   */
  Upgrade: "upgrade",
  /**
   * Abre o baú de um acampamento (perto dele e aberto, [JOGO-19]). Payload: {@link ChestRequestData}. Resposta:
   * {@link ServerMessageType.ChestLoot} com o que sobrou para você, ou erro.
   */
  ChestOpen: "chest_open",
  /**
   * Funde um item em outro igual no ferreiro (perto dele, [JOGO-20]). Payload: {@link FuseData}. Resposta:
   * {@link ServerMessageType.FuseResult} + `inventory`, ou erro.
   */
  Fuse: "fuse",
  /** Tela de morte → "Renascer" ([JOGO-21]): renasce no spawn agora (sem esperar o automático). Sem payload. */
  Respawn: "respawn",
  /**
   * Pega um item/moedas do baú. Payload: {@link ChestTakeData}. Resposta: `chest_loot` atualizado (+ `inventory` se foi
   * item; as moedas vêm no `me` do snapshot), ou erro (`bag_full` deixa o item no baú).
   */
  ChestTake: "chest_take",
  /** Fixa (ou limpa, com `null`) o alvo do ataque simples; o servidor ataca sozinho quando em alcance. Payload: {@link AttackData}. */
  Attack: "attack",
  /** Lança uma habilidade (carta) vestida. Payload: {@link CastData}. Ver mmo-docs [JOGO-06]. */
  Cast: "cast",
  /**
   * Pede os atributos de outro jogador da zona (Menu → Jogadores Próximos → Atributos, mmo-docs [SOC-02]).
   * Payload: {@link InspectData}. Resposta: {@link ServerMessageType.Attributes} ou erro `player_not_found`.
   */
  Inspect: "inspect",
  /**
   * Convida um jogador da zona para o seu grupo (mmo-docs [SOC-03]). Sem grupo, o grupo nasce quando ele aceitar
   * (você é o líder); com grupo, só o líder convida. Payload: {@link GroupTargetData}.
   */
  GroupInvite: "group_invite",
  /** Responde a um convite de grupo recebido ({@link ServerMessageType.GroupInvited}). Payload: {@link GroupAnswerData}. */
  GroupAnswer: "group_answer",
  /** Líder expulsa um membro do grupo. Payload: {@link GroupTargetData}. */
  GroupKick: "group_kick",
  /** Sai do grupo em que está. Payload: `{}`. */
  GroupLeave: "group_leave",
  /**
   * Pede amizade a um jogador online (ou fake de teste), mmo-docs [SOC-04]. Payload: {@link FriendTargetData}.
   * Resposta: o pedido chega ao outro ({@link ServerMessageType.FriendRequested}), ou recusa (`error`).
   */
  FriendRequest: "friend_request",
  /** Responde a um pedido de amizade recebido ({@link ServerMessageType.FriendRequested}). Payload: {@link FriendAnswerData}. */
  FriendAnswer: "friend_answer",
  /** Desfaz uma amizade (dos dois lados). Payload: {@link FriendTargetData}. */
  FriendRemove: "friend_remove",
  /** Muda a Configuração social (salva na conta, vale na hora). Payload: {@link SocialSettings}. */
  SocialSettings: "social_settings",
  /** Cria uma guilda e vira o líder (custa {@link GUILD_CREATE_COST} moedas, [SOC-06]). Payload: {@link GuildCreateData}. */
  GuildCreate: "guild_create",
  /** Convida um jogador online para a SUA guilda (líder/oficial). Payload: {@link GuildTargetData}. */
  GuildInvite: "guild_invite",
  /** Responde a um convite de guilda ({@link ServerMessageType.GuildInvited}). Payload: {@link GuildAnswerData}. */
  GuildAnswer: "guild_answer",
  /** Sai da guilda (por vontade própria: 1 h sem aceitar convite de guilda). Payload: `{}`. */
  GuildLeave: "guild_leave",
  /** Expulsa um membro (líder: qualquer um; oficial: só membro comum). Payload: {@link GuildTargetData}. */
  GuildKick: "guild_kick",
  /** Líder promove a oficial / rebaixa a membro. Payload: {@link GuildRoleData}. */
  GuildRole: "guild_role",
  /**
   * Lista as guildas (Procurar guilda, [SOC-06]). Payload: {@link GuildListRequestData} (`query` vazia = as que aceitam
   * gente; com texto = busca por nome/tag, cheias incluídas). Resposta: {@link ServerMessageType.GuildList}.
   */
  GuildList: "guild_list",
  /** Ficha de uma guilda (Procurar guilda). Payload: {@link GuildIdData}. Resposta: {@link ServerMessageType.GuildInfo}. */
  GuildInfo: "guild_info",
  /** Pede para entrar numa guilda (líder/oficial aceita depois). Payload: {@link GuildIdData}. */
  GuildRequest: "guild_request",
  /** Líder/oficial aceita ou recusa um pedido para entrar. Payload: {@link GuildRequestAnswerData}. */
  GuildRequestAnswer: "guild_request_answer",
  /** Líder troca a descrição da guilda. Payload: {@link GuildDescriptionData}. */
  GuildDescription: "guild_description",
  /** Pede uma tabela de ranking ([SOC-07]). Payload: {@link RankingRequestData}. Resposta: {@link ServerMessageType.Ranking}. */
  RankingRequest: "ranking_request",
  /**
   * Pede para trocar com um jogador a até {@link TRADE_RANGE} m ([SOC-05]). Payload: {@link TradeTargetData}. O outro
   * recebe {@link ServerMessageType.TradeRequested}; a resposta volta como `trade_state` (aceitou) ou `trade_notice`.
   */
  TradeRequest: "trade_request",
  /** Responde a um pedido de troca recebido. Payload: {@link TradeAnswerData}. */
  TradeAnswer: "trade_answer",
  /** Troca a SUA oferta inteira (itens da mochila + moedas); zera as confirmações dos dois. Payload: {@link TradeOfferData}. */
  TradeOffer: "trade_offer",
  /** Confirma a troca como está (só {@link TRADE_CONFIRM_DELAY_SECONDS} s depois da última mudança). Payload: `{}`. */
  TradeConfirm: "trade_confirm",
  /** Fecha a janela de troca (cancela para os dois). Payload: `{}`. */
  TradeCancel: "trade_cancel",
} as const;

/** Tipos de mensagem servidor → cliente. */
export const ServerMessageType = {
  /** Autenticação aceita: quem é o jogador e o token de sessão a guardar. */
  AuthOk: "auth_ok",
  /** "Se a conta existe, mandamos o código" (não diz se existe, [INFRA-13]). Payload: `{}`. */
  PasswordResetSent: "password_reset_sent",
  /** Senha trocada; todas as sessões da conta foram encerradas. O cliente entra com a senha nova. Payload: `{}`. */
  PasswordResetDone: "password_reset_done",
  /** Corpo escolhido e salvo (resposta ao `choose_body`); o cliente já pode mandar `join`. */
  BodyChosen: "body_chosen",
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
  /** Resultado de uma tentativa de melhoria no ferreiro ([JOGO-16]). Payload: {@link UpgradeResultData}. */
  UpgradeResult: "upgrade_result",
  /** O que sobrou para você num baú de acampamento ([JOGO-19]). Payload: {@link ChestLootData}. */
  ChestLoot: "chest_loot",
  /** Resultado de uma fusão no ferreiro ([JOGO-20]). Payload: {@link FuseResultData}. */
  FuseResult: "fuse_result",
  /** O que a Loja do Ferreiro vende ([JOGO-23]). Payload: {@link ShopData}. */
  Shop: "shop",
  /** Compra/venda feita na Loja do Ferreiro. Payload: {@link ShopResultData}. As moedas vêm no `me` do snapshot. */
  ShopResult: "shop_result",
  /** Você morreu ([JOGO-21]): o que perdeu e a peça da roleta. Payload: {@link DeathReportData}. Só para quem morreu. */
  DeathReport: "death_report",
  /** Atributos de um jogador (resposta ao `inspect`; o snapshot não leva isso). Payload: {@link AttributesData}. */
  Attributes: "attributes",
  /**
   * Estado do SEU grupo (mmo-docs [SOC-03]): vai a todos os membros a cada mudança (entrou, saiu, líder novo, alguém
   * subiu de nível); `group: null` = você não está (mais) em grupo. Payload: {@link GroupData}.
   */
  Group: "group",
  /** Alguém convidou você para o grupo dele (janela Aceitar/Recusar). Payload: {@link GroupInvitedData}. */
  GroupInvited: "group_invited",
  /** Aviso pequeno sobre o grupo ("X aceitou o convite", "X saiu do grupo"...). Payload: {@link GroupNoticeData}. */
  GroupNotice: "group_notice",
  /**
   * Onde estão os membros do SEU grupo que ficaram FORA da sua área de interesse (mmo-docs [SOC-03], [CLI-11]): para
   * o mapa do Menu mostrar o grupo mesmo longe. Só para quem está em grupo, a {@link GROUP_POSITIONS_HZ} Hz, e só
   * quando há membro longe (quem está perto já vem no `snapshot`). Payload: {@link GroupPositionsData} (v17).
   */
  GroupPositions: "group_positions",
  /**
   * Sua lista de amigos com online/offline (mmo-docs [SOC-04]): após o `auth_ok`, no `join` e a cada mudança (amigo
   * novo, removido, entrou ou saiu do servidor). Payload: {@link FriendsData}.
   */
  Friends: "friends",
  /** Alguém pediu sua amizade (janela Aceitar/Recusar). Payload: {@link FriendRequestedData}. */
  FriendRequested: "friend_requested",
  /** Aviso pequeno sobre amizade ("X aceitou o pedido de amizade"...). Payload: {@link FriendNoticeData}. */
  FriendNotice: "friend_notice",
  /** Configuração social salva (resposta ao `social_settings`). Payload: {@link SocialSettings}. */
  SocialSettings: "social_settings",
  /**
   * A SUA guilda (mmo-docs [SOC-06]): após o `auth_ok` e a cada mudança (entrou, saiu, cargo, membro online/offline,
   * subiu de nível); `guild: null` = sem guilda. Payload: {@link GuildData}.
   */
  Guild: "guild",
  /** Alguém convidou você para a guilda dele (janela Aceitar/Recusar). Payload: {@link GuildInvitedData}. */
  GuildInvited: "guild_invited",
  /** Aviso pequeno sobre a guilda ("X entrou na guilda"...). Payload: {@link GuildNoticeData}. */
  GuildNotice: "guild_notice",
  /**
   * A guilda de um jogador da zona mudou (entrou, saiu, criou): a todos da zona, para a tag no nome e a cor de
   * guildeiro. Payload: {@link PlayerGuildData}.
   */
  PlayerGuild: "player_guild",
  /** Guildas que aceitam gente, da mais cheia para a mais vazia (resposta ao `guild_list`). Payload: {@link GuildListData}. */
  GuildList: "guild_list",
  /** Ficha de uma guilda (resposta ao `guild_info`). Payload: {@link GuildInfoView}. */
  GuildInfo: "guild_info",
  /** Uma tabela de ranking (resposta ao `ranking_request`, [SOC-07]). Payload: {@link RankingData}. */
  Ranking: "ranking",
  /** Alguém quer trocar com você ([SOC-05]; janela Aceitar/Recusar). Payload: {@link TradeRequestedData}. */
  TradeRequested: "trade_requested",
  /**
   * Estado da SUA troca aberta (vai aos dois a cada mudança: ofertas, confirmações, contagem). Payload:
   * {@link TradeStateData}.
   */
  TradeState: "trade_state",
  /** A troca aconteceu (logo depois vêm `inventory` e as moedas novas no `me`). Payload: {@link TradeDoneData}. */
  TradeDone: "trade_done",
  /**
   * Aviso de troca (recusou, expirou, ocupado, cancelada, longe, levou dano, saiu): a janela de troca fecha, se aberta.
   * Payload: {@link TradeNoticeData}.
   */
  TradeNotice: "trade_notice",
  /**
   * Há um pacote do jogo mais novo para a plataforma do cliente (mmo-docs [INFRA-08]): vai no lugar do `auth_ok` (cliente
   * que entra com pacote velho) ou a quem já está jogando quando uma versão nova é publicada. Logo depois o servidor fecha
   * com {@link CloseCode.UpdateRequired}; o cliente baixa a versão nova sozinho e entra de novo. Payload:
   * {@link UpdateRequiredData}.
   *
   * ATENÇÃO: contrato ESTÁVEL entre versões do protocolo (é o que tira um cliente velho da versão velha): nunca mudar
   * o nome nem o formato. Lido em mmo-client/scripts/network/network.gd.
   */
  UpdateRequired: "update_required",
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
  /** Código de recuperar senha errado, vencido ou queimado (ou conta inexistente; não diz qual). A conexão continua. */
  InvalidResetCode: "invalid_reset_code",
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
  /** Vender item vestido na Loja do Ferreiro (tirar antes, [JOGO-23]). A conexão continua. */
  ItemEquipped: "item_equipped",
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
  /** `join` antes de escolher o corpo do personagem. A conexão continua. */
  BodyNotChosen: "body_not_chosen",
  /** `choose_body` numa conta que já escolheu (a escolha é para sempre). A conexão continua. */
  BodyAlreadyChosen: "body_already_chosen",
  /** `inspect` de quem não está (mais) na zona. A conexão continua. */
  PlayerNotFound: "player_not_found",
  /** Ferreiro ([JOGO-16]): moedas a menos que o preço da melhoria. A conexão continua. */
  NotEnoughGold: "not_enough_gold",
  /** Ferreiro: atributo que o conjunto do item não aceita. A conexão continua. */
  InvalidAttribute: "invalid_attribute",
  /** Ferreiro/baú: longe dele (ou morto). A conexão continua. */
  TooFar: "too_far",
  /** Baú ([JOGO-19]) que não existe nesta zona. A conexão continua. */
  ChestNotFound: "chest_not_found",
  /** Baú ainda fechado (o acampamento não foi todo morto) ou já fechou. A conexão continua. */
  ChestClosed: "chest_closed",
  /** Item/moedas que não estão (mais) no seu baú. A conexão continua. */
  LootNotFound: "loot_not_found",
  /** Fusão ([JOGO-20]) de dois itens diferentes (só o mesmo item funde). A conexão continua. */
  NotSameItem: "not_same_item",
  /** Fusão: o item a sacrificar está vestido (tire antes). A conexão continua. */
  MaterialEquipped: "material_equipped",
  /** Guilda ([SOC-06]): nome ou tag fora das regras. A conexão continua. */
  InvalidGuild: "invalid_guild",
  /** Guilda: já existe uma guilda com esse nome. A conexão continua. */
  GuildNameTaken: "guild_name_taken",
  /** Guilda: já existe uma guilda com essa tag. A conexão continua. */
  GuildTagTaken: "guild_tag_taken",
  /** Guilda: criar/aceitar convite estando numa guilda, ou convidar quem já tem guilda. A conexão continua. */
  AlreadyInGuild: "already_in_guild",
  /** Guilda: sair/expulsar/convidar sem ter guilda, ou mexer em quem não é da sua. A conexão continua. */
  NotInGuild: "not_in_guild",
  /** Guilda: o cargo não permite (membro convidando, oficial expulsando oficial/líder...). A conexão continua. */
  GuildNoPermission: "guild_no_permission",
  /** Guilda já tem o máximo de membros ({@link GUILD_MAX_MEMBERS}). A conexão continua. */
  GuildFull: "guild_full",
  /** Resposta a um convite de guilda que não existe mais. A conexão continua. */
  GuildInviteNotFound: "guild_invite_not_found",
  /** Saiu de uma guilda há menos de 1 h: ainda não pode entrar em outra. A conexão continua. */
  GuildCooldown: "guild_cooldown",
  /** Grupo ([SOC-03]): convidar/expulsar sem ser o líder. A conexão continua. */
  NotGroupLeader: "not_group_leader",
  /** Grupo já tem o máximo de membros ({@link GROUP_MAX_MEMBERS}). A conexão continua. */
  GroupFull: "group_full",
  /** Convite inválido: você mesmo ou alguém que já está no seu grupo. A conexão continua. */
  InvalidInvite: "invalid_invite",
  /** Resposta a um convite que não existe mais (expirou, quem convidou saiu ou deixou de ser líder). A conexão continua. */
  InviteNotFound: "invite_not_found",
  /** Aceitar um convite estando já num grupo. A conexão continua. */
  AlreadyInGroup: "already_in_group",
  /** Sair/expulsar sem estar num grupo, ou expulsar quem não é do seu grupo. A conexão continua. */
  NotInGroup: "not_in_group",
  /** Amizade ([SOC-04]): pedir a si mesmo ou a quem não aceita pedidos (NPC). A conexão continua. */
  InvalidFriendRequest: "invalid_friend_request",
  /** Pedido de amizade a quem já é seu amigo. A conexão continua. */
  AlreadyFriends: "already_friends",
  /** Pedido de amizade repetido: o anterior ainda espera resposta. A conexão continua. */
  FriendRequestPending: "friend_request_pending",
  /** Resposta a um pedido de amizade que não existe mais (expirou, quem pediu saiu). A conexão continua. */
  FriendRequestNotFound: "friend_request_not_found",
  /** Lista de amigos cheia ({@link MAX_FRIENDS}), a sua ou a do outro. A conexão continua. */
  FriendListFull: "friend_list_full",
  /** Remover quem não é seu amigo. A conexão continua. */
  NotFriends: "not_friends",
  /** Troca ([SOC-05]): pedido inválido (você mesmo, oferta com item que não está na mochila, moedas demais). A conexão continua. */
  InvalidTrade: "invalid_trade",
  /** Troca: os dois não estão a até {@link TRADE_RANGE} m. A conexão continua. */
  TradeTooFar: "trade_too_far",
  /** Troca: você já está numa troca. A conexão continua. */
  TradeBusy: "trade_busy",
  /** Resposta a um pedido de troca que não existe mais. A conexão continua. */
  TradeRequestNotFound: "trade_request_not_found",
  /** Oferta/confirmação/cancelamento sem troca aberta. A conexão continua. */
  NotInTrade: "not_in_trade",
  /** Confirmar antes dos {@link TRADE_CONFIRM_DELAY_SECONDS} s ou com uma mochila sem espaço. A conexão continua. */
  TradeNotReady: "trade_not_ready",
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
  /** Pacote do jogo desatualizado (veja o `update_required` enviado antes): o cliente atualiza e volta sozinho. */
  UpdateRequired: 4003,
} as const;

/**
 * Pacote do jogo que o cliente está rodando (mmo-docs [INFRA-08]), enviado na autenticação (v16).
 * ATENÇÃO: contrato ESTÁVEL entre versões do protocolo (o servidor novo precisa ler o de um cliente velho para mandar
 * ele atualizar): nunca mudar o formato. Montado em mmo-client/scripts/network/network.gd (`_client_build`).
 */
export interface ClientBuild {
  /** Plataforma do pacote (`android`, `desktop`): a mesma pasta de `updates/` e do `publish_update.sh`. */
  readonly platform: string;
  /**
   * Versão do pacote `.pck` em uso (a do manifesto quando foi baixado). `0` = dev (rodando o projeto do código-fonte,
   * sem pacote): nunca é mandado atualizar.
   */
  readonly pack: number;
}

/** Payload de `update_required`. */
export interface UpdateRequiredData {
  /** Versão do pacote publicada agora para a plataforma do cliente. */
  readonly version: number;
}

/** Payload de `register`. Regras em `src/accounts/credentials.ts`. */
export interface RegisterData {
  /** {@link PROTOCOL_VERSION} do cliente. */
  readonly version: number;
  /** Pacote do jogo do cliente (v16). Sem o campo = tratado como dev (nunca mandado atualizar). */
  readonly client?: ClientBuild;
  /** Como o jogador quer aparecer no jogo (é exibido exatamente assim). */
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** Payload de `login`. */
export interface LoginData {
  readonly version: number;
  /** Ver {@link RegisterData.client}. */
  readonly client?: ClientBuild;
  /** Username ou e-mail (sem diferenciar maiúsculas). */
  readonly login: string;
  readonly password: string;
}

/** Payload de `password_reset_request` ([INFRA-13]). */
export interface PasswordResetRequestData {
  readonly version: number;
  /** Ver {@link RegisterData.client}. */
  readonly client?: ClientBuild;
  /** Username ou e-mail da conta. */
  readonly login: string;
}

/** Payload de `password_reset_confirm` ([INFRA-13]). */
export interface PasswordResetConfirmData {
  readonly version: number;
  /** Ver {@link RegisterData.client}. */
  readonly client?: ClientBuild;
  /** O mesmo username ou e-mail do pedido. */
  readonly login: string;
  /** Código de 6 dígitos do e-mail. */
  readonly code: string;
  /** Senha nova (regras de `credentials.ts`). */
  readonly password: string;
}

/** Payload de `resume`. */
export interface ResumeData {
  readonly version: number;
  /** Ver {@link RegisterData.client}. */
  readonly client?: ClientBuild;
  /** Token recebido no último `auth_ok`. */
  readonly sessionToken: string;
}

/**
 * Corpos de personagem que existem. ATENÇÃO: espelho em mmo-client/scripts/network/protocol.gd (BODY_*) e nos modelos
 * de mmo-client/scripts/player/character_bodies.gd.
 */
export const BODY_TYPES = ["male", "female"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/**
 * Corpos que um NPC pode ter: os dos jogadores e os de monstro (que jogador nenhum escolhe, por isso fora de
 * {@link BODY_TYPES}). `zombie` = modelo do zumbi ([JOGO-13]). ATENÇÃO: espelho em mmo-client/scripts/network/protocol.gd
 * (BODY_ZOMBIE) e character_bodies.gd.
 */
export const NPC_BODY_TYPES = [...BODY_TYPES, "zombie"] as const;
export type NpcBodyType = (typeof NPC_BODY_TYPES)[number];

/** Payload de `choose_body`. */
export interface ChooseBodyData {
  readonly body: BodyType;
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

/**
 * Aparência: o `itemId` vestido em cada slot (`null` = vazio). Vai no `PlayerInfo` e no evento `look`, para todos
 * verem o equipamento de todos ([ART-02]). ATENÇÃO: lido por mmo-client/scripts/network/player_state.gd.
 */
export type Look = Readonly<Record<EquipSlotName, string | null>>;

/**
 * Nível de melhoria de cada peça vestida ([JOGO-16]), para todos verem o brilho da peça ([JOGO-17]). Só os slots
 * com nível > 0. ATENÇÃO: lido por mmo-client/scripts/network/player_state.gd (`look_levels`).
 */
export type LookLevels = Readonly<Partial<Record<EquipSlotName, number>>>;

/** Payload de `equip`. */
export interface EquipData {
  /** `uid` do item na mochila. */
  readonly uid: string;
}

/** Payload de `unequip`. */
export interface UnequipData {
  readonly slot: EquipSlotName;
  /** Vaga da mochila onde o item foi solto (arrastar, [CLI-10]); `null`/ausente = no fim. */
  readonly index: number | null;
}

/** Payload de `upgrade`: o item (vestido ou na mochila) e o atributo escolhido ([JOGO-16]). */
/** Uma peça vestida na hora da morte (o que a roleta mostra). */
export interface DeathItemView {
  readonly slot: EquipSlotName;
  readonly item: ItemView;
}

/**
 * Payload de `death_report` ([JOGO-21]): quem matou, moedas e XP perdidas, as peças vestidas (a roleta), qual foi
 * sorteada (`null` = nada vestido) e se quebrou (sumiu), e em quantos segundos renasce sozinho.
 * ATENÇÃO: lido em mmo-client/scripts/network/network.gd (DeathReport).
 */
export interface DeathReportData {
  readonly killer: string;
  readonly goldLost: number;
  readonly xpLost: number;
  /** Níveis perdidos (morte para jogador, [JOGO-22]). */
  readonly levelsLost: number;
  readonly equipped: readonly DeathItemView[];
  readonly pickedSlot: EquipSlotName | null;
  readonly broken: boolean;
  readonly autoRespawnSeconds: number;
}

/** Payload de `fuse` ([JOGO-20]): o item que sobe e o item igual que é sacrificado (da mochila). */
export interface FuseData {
  readonly targetUid: string;
  readonly materialUid: string;
}

/** Payload de `fuse_result`: o item que subiu, quantos níveis ganhou, experiência recebida e onde ficou. */
export interface FuseResultData {
  readonly uid: string;
  readonly levelsGained: number;
  readonly xpGained: number;
  readonly level: number;
  readonly xp: number;
  readonly xpNext: number;
}

/** Payload de `chest_open` ([JOGO-19]). */
export interface ChestRequestData {
  readonly chestId: string;
}

/** Payload de `chest_take`: o baú e o `lootId` do que pegar. */
export interface ChestTakeData {
  readonly chestId: string;
  readonly lootId: string;
}

/**
 * Baú de acampamento como vai no `welcome` ([JOGO-19]): onde fica (no chão, m), nível, se o acampamento tem chefe e se
 * está aberto agora. Depois muda pelo evento `chest`. ATENÇÃO: lido em mmo-client/scripts/network/network.gd.
 */
export interface ChestView {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly level: number;
  readonly boss: boolean;
  readonly open: boolean;
  /**
   * Segundos até o acampamento voltar inteiro ([JOGO-19]; 0 = nenhum relógio): baú aberto, ou acampamento pela metade
   * parado sem combate. O cliente conta sozinho e mostra no mapa ([CLI-11]); o evento `chest` atualiza.
   */
  readonly resetIn: number;
}

/** Uma coisa do seu baú: item (com a ficha completa, nível e atributos) ou moedas. */
export type LootView =
  | { readonly lootId: string; readonly kind: "item"; readonly item: ItemView }
  | { readonly lootId: string; readonly kind: "gold"; readonly amount: number };

/** Payload de `chest_loot`: o que sobrou para quem pediu (vazio = nada para você neste baú). */
export interface ChestLootData {
  readonly chestId: string;
  readonly entries: readonly LootView[];
}

export interface UpgradeData {
  readonly uid: string;
  readonly attribute: AttributeId;
}

/** Payload de `upgrade_result` ([JOGO-16]). */
export interface UpgradeResultData {
  readonly uid: string;
  /** `true` = subiu de nível; `false` = falhou (perdeu só as moedas). */
  readonly success: boolean;
  /** Moedas pagas. */
  readonly cost: number;
  readonly attribute: AttributeId;
  /** Nível do item depois da tentativa. */
  readonly level: number;
  /** Pontos que o atributo ganhou (0 se falhou; 1 = novo; 2 = reforço). */
  readonly points: number;
}

/** Payload de `shop_buy` ([JOGO-23]): a peça do catálogo a comprar (+0). */
export interface ShopBuyData {
  readonly itemId: string;
}

/** Payload de `shop_sell` ([JOGO-23]): o item da mochila a vender. */
export interface ShopSellData {
  readonly uid: string;
}

/** Uma peça à venda: a ficha (+0) e o preço em moedas. */
export interface ShopOfferView {
  readonly item: ItemView;
  readonly price: number;
}

/** Payload de `shop`. ATENÇÃO: lido em mmo-client/scripts/network/network.gd (shop_received). */
export interface ShopData {
  readonly offers: readonly ShopOfferView[];
}

/** Payload de `shop_result`: o que foi comprado/vendido e por quanto (moedas). */
export interface ShopResultData {
  readonly action: "buy" | "sell";
  readonly itemId: string;
  readonly gold: number;
}

/** Payload de `item_destroy`: o item (vestido ou na mochila) a destruir ([JOGO-24]). */
export interface ItemDestroyData {
  readonly uid: string;
}

/** Payload de `bag_move`: posições (0 = primeira vaga) na mochila. */
export interface BagMoveData {
  readonly from: number;
  readonly to: number;
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
  /**
   * Habilidades de movimento (Investida, Disparada): número na MESMA sequência dos `input` ([JOGO-07]).
   * O servidor processa o comando na fila, na ordem em que o cliente previu. `null` nas outras.
   */
  readonly seq: number | null;
}

/** Payload de `attack`. */
export interface AttackData {
  /** Id do jogador ou boneco a atacar; `null` para parar de atacar. */
  readonly targetId: string | null;
}

/** Payload de `inspect`. */
export interface InspectData {
  /** Id do jogador cujos atributos se quer ver (pode ser você mesmo). */
  readonly playerId: string;
}

/** Payload de `group_invite` e `group_kick`: o jogador convidado/expulso. */
export interface GroupTargetData {
  readonly playerId: string;
}

/** Payload de `group_answer`. */
export interface GroupAnswerData {
  /** Quem convidou (o `fromId` do {@link GroupInvitedData}). */
  readonly fromId: string;
  /** `true` = aceitar, `false` = recusar. */
  readonly accept: boolean;
}

/** Payload de `friend_request` e `friend_remove`: o outro jogador. */
export interface FriendTargetData {
  readonly playerId: string;
}

/** Payload de `friend_answer`. */
export interface FriendAnswerData {
  /** Quem pediu (o `fromId` do {@link FriendRequestedData}). */
  readonly fromId: string;
  /** `true` = aceitar, `false` = recusar. */
  readonly accept: boolean;
}

/**
 * Opção da Configuração social: `always` = mostra os pedidos/convites; `hide` = recusa sozinho, sem mostrar nada (quem
 * pediu vê "X recusou"). ATENÇÃO: mmo-client/scripts/network/protocol.gd (SOCIAL_*).
 */
export const SOCIAL_VISIBILITIES = ["always", "hide"] as const;
export type SocialVisibility = (typeof SOCIAL_VISIBILITIES)[number];

/**
 * Quem vê o seu perfil (tela de Atributos, [SOC-08]): todos, só os amigos ou ninguém (você mesmo sempre vê).
 * ATENÇÃO: mmo-client/scripts/network/protocol.gd (PROFILE_*).
 */
export const PROFILE_VISIBILITIES = ["public", "friends", "nobody"] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/** Configuração social da conta (mmo-docs [SOC-04], [INFRA-07]). Vai no `auth_ok` e no `social_settings`. */
export interface SocialSettings {
  /** "Solicitações de amizade: Sempre / Ocultar". */
  readonly friendRequests: SocialVisibility;
  /** "Convites de grupo: Sempre / Ocultar" ([SOC-03]). */
  readonly groupInvites: SocialVisibility;
  /** "Convites de guilda: Sempre / Ocultar" ([SOC-06]). */
  readonly guildInvites: SocialVisibility;
  /** "Perfil: Público / Só amigos / Ninguém" ([SOC-08]). */
  readonly profile: ProfileVisibility;
  /** "Pedidos de troca: Sempre / Ocultar" ([SOC-05]). */
  readonly tradeRequests: SocialVisibility;
}

/** Configuração de conta nova (e de conta antiga, sem o campo): mostra tudo. */
export const DEFAULT_SOCIAL_SETTINGS: SocialSettings = {
  friendRequests: "always",
  groupInvites: "always",
  guildInvites: "always",
  profile: "public",
  tradeRequests: "always",
};

/** Mensagem cliente → servidor já validada (formato; as regras de conta são checadas depois). */
export type ClientMessage =
  | { readonly type: typeof ClientMessageType.Register; readonly data: RegisterData }
  | { readonly type: typeof ClientMessageType.Login; readonly data: LoginData }
  | { readonly type: typeof ClientMessageType.Resume; readonly data: ResumeData }
  | { readonly type: typeof ClientMessageType.Logout; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.PasswordResetRequest; readonly data: PasswordResetRequestData }
  | { readonly type: typeof ClientMessageType.PasswordResetConfirm; readonly data: PasswordResetConfirmData }
  | { readonly type: typeof ClientMessageType.KeepAlive; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.ChooseBody; readonly data: ChooseBodyData }
  | { readonly type: typeof ClientMessageType.Join; readonly data: JoinData }
  | { readonly type: typeof ClientMessageType.Input; readonly data: InputData }
  | { readonly type: typeof ClientMessageType.Equip; readonly data: EquipData }
  | { readonly type: typeof ClientMessageType.Unequip; readonly data: UnequipData }
  | { readonly type: typeof ClientMessageType.BagMove; readonly data: BagMoveData }
  | { readonly type: typeof ClientMessageType.ItemDestroy; readonly data: ItemDestroyData }
  | { readonly type: typeof ClientMessageType.ShopOpen; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.ShopBuy; readonly data: ShopBuyData }
  | { readonly type: typeof ClientMessageType.ShopSell; readonly data: ShopSellData }
  | { readonly type: typeof ClientMessageType.Upgrade; readonly data: UpgradeData }
  | { readonly type: typeof ClientMessageType.ChestOpen; readonly data: ChestRequestData }
  | { readonly type: typeof ClientMessageType.Fuse; readonly data: FuseData }
  | { readonly type: typeof ClientMessageType.Respawn; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.ChestTake; readonly data: ChestTakeData }
  | { readonly type: typeof ClientMessageType.Attack; readonly data: AttackData }
  | { readonly type: typeof ClientMessageType.Cast; readonly data: CastData }
  | { readonly type: typeof ClientMessageType.Inspect; readonly data: InspectData }
  | { readonly type: typeof ClientMessageType.GroupInvite; readonly data: GroupTargetData }
  | { readonly type: typeof ClientMessageType.GroupAnswer; readonly data: GroupAnswerData }
  | { readonly type: typeof ClientMessageType.GroupKick; readonly data: GroupTargetData }
  | { readonly type: typeof ClientMessageType.GroupLeave; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.FriendRequest; readonly data: FriendTargetData }
  | { readonly type: typeof ClientMessageType.FriendAnswer; readonly data: FriendAnswerData }
  | { readonly type: typeof ClientMessageType.FriendRemove; readonly data: FriendTargetData }
  | { readonly type: typeof ClientMessageType.SocialSettings; readonly data: SocialSettings }
  | { readonly type: typeof ClientMessageType.GuildCreate; readonly data: GuildCreateData }
  | { readonly type: typeof ClientMessageType.GuildInvite; readonly data: GuildTargetData }
  | { readonly type: typeof ClientMessageType.GuildAnswer; readonly data: GuildAnswerData }
  | { readonly type: typeof ClientMessageType.GuildLeave; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.GuildKick; readonly data: GuildTargetData }
  | { readonly type: typeof ClientMessageType.GuildRole; readonly data: GuildRoleData }
  | { readonly type: typeof ClientMessageType.RankingRequest; readonly data: RankingRequestData }
  | { readonly type: typeof ClientMessageType.TradeRequest; readonly data: TradeTargetData }
  | { readonly type: typeof ClientMessageType.TradeAnswer; readonly data: TradeAnswerData }
  | { readonly type: typeof ClientMessageType.TradeOffer; readonly data: TradeOfferData }
  | { readonly type: typeof ClientMessageType.TradeConfirm; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.TradeCancel; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.GuildList; readonly data: GuildListRequestData }
  | { readonly type: typeof ClientMessageType.GuildInfo; readonly data: GuildIdData }
  | { readonly type: typeof ClientMessageType.GuildRequest; readonly data: GuildIdData }
  | { readonly type: typeof ClientMessageType.GuildRequestAnswer; readonly data: GuildRequestAnswerData }
  | { readonly type: typeof ClientMessageType.GuildDescription; readonly data: GuildDescriptionData };

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
  /**
   * Nível ([JOGO-12]): jogadores (o da conta) e NPCs. Público — os outros veem o nível, mas a XP só vai no `me`.
   * ATENÇÃO: lido em mmo-client/scripts/network/player_state.gd (apply_snapshot).
   */
  readonly level: number;
  /** Morto (esperando renascer). */
  readonly dead: boolean;
  /** Escudo ativo (dano que ainda absorve; 0 = sem escudo). */
  readonly shield: number;
  /** Redução de dano ativa (0..1; 0 = nenhuma), [JOGO-09]. O cliente mostra um brilho dourado. */
  readonly guard: number;
  /** Disparada ativa (multiplicador de velocidade; 1 = normal). */
  readonly speed: number;
  /**
   * Mana atual e máxima (arredondada a 0,1). Só jogadores (bonecos/NPCs não têm): o cliente mostra a barra de
   * mana embaixo da de vida, acima da cabeça ([CLI-04]). Campo opcional: cliente antigo ignora.
   */
  readonly mana?: number;
  readonly maxMana?: number;
}

/**
 * Boneco de treino / NPC: mesmos campos do jogador + nome. Vai em `welcome.npcs` e `snapshot.npcs`.
 * Campos opcionais dos NPCs de teste ([JOGO-11]); cliente antigo ignora.
 * ATENÇÃO: lidos em mmo-client/scripts/network/player_state.gd (from_snapshot) e scripts/world/zone.gd.
 */
export interface NpcSnapshot extends PlayerSnapshot {
  readonly name: string;
  /** Corpo: desenhar um personagem com esse corpo (em vez do boneco de palha), vestindo `look`. Pode ser de monstro. */
  readonly body?: NpcBodyType;
  readonly look?: Look;
  /** Aliado: jogadores podem curar/proteger (saco de pancadas). */
  readonly ally?: boolean;
  /** `false`: não serve de alvo de ataque dos jogadores (atirador invulnerável, aliado). Sem campo = serve. */
  readonly targetable?: boolean;
  /** Monstro (zumbi, [JOGO-13]): o cliente mostra só vida, nível e barra de lançamento, sem nome. */
  readonly monster?: boolean;
  /**
   * Tamanho do corpo (vezes o normal; ausente = 1): o chefe é um zumbi maior ([JOGO-18]). O cliente escala o modelo e
   * sobe as barras. ATENÇÃO: PlayerState.scale em mmo-client/scripts/network/player_state.gd.
   */
  readonly scale?: number;
  /** Chefe ([JOGO-18]): o cliente mostra o nome em dourado acima dele e o mapa marca diferente. Ausente = não é. */
  readonly boss?: boolean;
  /** Serviço do NPC: `"blacksmith"` = ferreiro (tocar nele abre a tela de melhoria, [JOGO-16]). Ausente = nenhum. */
  readonly service?: "blacksmith";
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
      /** Golpe crítico (atributo Crítico, [JOGO-16]): o cliente mostra o número maior. Ausente = normal. */
      readonly crit?: true;
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
      /** Raio da área (ou meia-largura da linha), em m: o cliente desenha o aviso no chão para todos. */
      readonly radius?: number;
      /** Tipo de mira da habilidade (só cartas): "direction" = aviso em faixa, "area" = círculo. */
      readonly aim?: string;
      /**
       * Segundos antes do fim em que o tiro sai da mão (ataque do cajado, Raio; [JOGO-08]): o cliente lança o
       * projétil visual nesse instante; depois dele andar não cancela. Ausente = sem soltura antecipada.
       */
      readonly release?: number;
    }
  | {
      /** Projétil saiu ([JOGO-08]): voa em linha reta de (x, z) na direção (dirX, dirZ) a `speed` m/s até `range` m. */
      readonly type: "projectile";
      readonly id: number;
      readonly source: string;
      readonly ability: string;
      readonly x: number;
      readonly z: number;
      readonly dirX: number;
      readonly dirZ: number;
      readonly speed: number;
      readonly range: number;
      readonly radius: number;
    }
  /** Projétil `id` acabou em (x, z): acertou alguém (vem junto um `damage`) ou chegou ao alcance (vem um `miss`). */
  | { readonly type: "projectile_end"; readonly id: number; readonly x: number; readonly z: number }
  | { readonly type: "heal"; readonly source: string; readonly target: string; readonly amount: number; readonly ability: string }
  | { readonly type: "impact"; readonly source: string; readonly ability: string; readonly x: number; readonly z: number; readonly radius: number }
  | { readonly type: "miss"; readonly source: string; readonly target: string; readonly ability: string }
  /**
   * Lançamento de `source` cancelado porque ele andou ([JOGO-05]/[JOGO-06]): sem efeito. Habilidade: mana devolvida
   * e recarga zerada. Golpe do ataque simples: sem dano; recomeça quando ele parar no alcance. O cliente para a
   * animação/aviso no chão e libera a carta/o botão Atacar.
   */
  | { readonly type: "cast_cancel"; readonly source: string; readonly ability: string }
  | { readonly type: "death"; readonly id: string; readonly killer: string }
  | { readonly type: "respawn"; readonly id: string }
  /** O jogador `id` subiu para o nível `level` ([JOGO-12]): vida/mana máximas novas já vêm no snapshot. */
  | { readonly type: "level_up"; readonly id: string; readonly level: number }
  /** O jogador `id` trocou o que veste (aparência nova). */
  | { readonly type: "look"; readonly id: string; readonly look: Look; readonly levels?: LookLevels }
  /**
   * Baú de acampamento abriu (acampamento morto) ou fechou (reset), ou o relógio da volta começou/mudou/parou
   * (`resetIn` como em {@link ChestView}), [JOGO-19]. Vai para todos da zona.
   */
  | { readonly type: "chest"; readonly id: string; readonly open: boolean; readonly x: number; readonly z: number; readonly resetIn: number };

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
  /**
   * Nível do personagem, XP juntada dentro dele e XP que o nível pede para subir (nunca 0: o jogo não tem nível máximo), [JOGO-12].
   * O cliente desenha a linha de XP embaixo da vida/mana e o quadrado do nível ([CLI-08]); não calcula nada.
   * ATENÇÃO: lido em mmo-client/scripts/network/network.gd (snapshot → me) e scripts/world/zone.gd.
   */
  readonly level: number;
  readonly xp: number;
  readonly xpNext: number;
  /** Moedas do personagem ([JOGO-15]); o cliente mostra no Inventário. ATENÇÃO: lido em network.gd (`me.gold`). */
  readonly gold: number;
}

/** Jogador completo, como vai no `welcome` e no `player_joined`: posição + nome exibido + aparência. */
export interface PlayerInfo extends PlayerSnapshot {
  /** Username exatamente como foi cadastrado. */
  readonly name: string;
  /** O que está vestindo (muda depois pelo evento `look`). */
  readonly look: Look;
  /** Nível de melhoria das peças vestidas (brilho, [JOGO-17]); ausente = nenhuma melhorada. */
  readonly levels?: LookLevels;
  /** Corpo do personagem (qual modelo desenhar). */
  readonly body: BodyType;
  /** Guilda ([SOC-06]): id (cor de guildeiro) e tag (`[TAG][nível] nome`). Ausentes = sem guilda. Muda por `player_guild`. */
  readonly guildId?: string;
  readonly guildTag?: string;
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

/** Habilidade como o cliente vê: nome, mira e os números para exibir (quem aplica é o servidor). Metros, segundos. */
export interface AbilityView {
  readonly id: string;
  readonly title: string;
  /** Frase curta para a ficha do item no inventário. */
  readonly description: string;
  /** "target" | "direction" | "area" | "area_self" | "self" | "ally" ([JOGO-09]). */
  readonly aim: string;
  readonly range: number;
  readonly radius: number;
  /** Tempo de recarga em segundos (o cliente mostra o "relógio" na carta; o servidor é quem recusa antes da hora). */
  readonly cooldown: number;
  /** Tempo de lançamento em segundos (o personagem fica virado para o alvo/direção durante ele). */
  readonly castTime: number;
  /** Mana gasta (o cliente confere antes de prever Investida/Disparada). */
  readonly manaCost: number;
  /** Investida: metros percorridos e em quantos segundos (passos = round(s × tick)); Disparada: multiplicador,
   * segundos e passos. 0 nas outras. */
  readonly dashDistance: number;
  readonly dashSeconds: number;
  readonly speedMultiplier: number;
  readonly speedSeconds: number;
  /**
   * Só para MOSTRAR na ficha do item (quem aplica é o servidor): dano por alvo, cura, escudo (absorve) e por quantos
   * segundos, velocidade do projétil (m/s; 0 = acerta na hora). 0 = não tem.
   */
  readonly damage: number;
  readonly heal: number;
  readonly shield: number;
  readonly shieldSeconds: number;
  readonly projectileSpeed: number;
  /** Redução de dano (0..1) e por quantos segundos ([JOGO-09]). 0 = não tem. */
  readonly damageReduction: number;
  readonly reductionSeconds: number;
  /** Provocar (Desafio, [JOGO-14]): por quantos segundos os monstros em volta ficam presos em quem lançou. 0 = não tem (v18). */
  readonly tauntSeconds: number;
}

/** Perfil do conjunto: cada atributo em "zero" | "low" | "medium" | "high" ([JOGO-09]). Só exibição. */
export interface SetProfileView {
  readonly damage: string;
  readonly health: string;
  readonly healing: string;
  readonly cooldown: string;
}

/** Item como o cliente vê. */
export interface ItemView {
  readonly uid: string;
  readonly itemId: string;
  readonly name: string;
  /** Frase curta e conjunto ("Treino", "Mago", "Cavaleiro") para a ficha do item. */
  readonly description: string;
  readonly set: string;
  readonly slot: EquipSlotName;
  /** Vida máxima extra enquanto vestido ([JOGO-09]). */
  readonly bonusHp: number;
  /** Perfil do conjunto do item em baixo/médio/alto (`null` se o conjunto não tem perfil). */
  readonly profile: SetProfileView | null;
  /** Ataque simples (só armas). */
  readonly basicAttack: AbilityView | null;
  readonly abilities: readonly AbilityView[];
  /** Nível de melhoria ([JOGO-16]): 0 = +0; sem teto. */
  readonly level: number;
  /** Pontos de cada atributo ganhos no ferreiro (só os que têm pontos). */
  readonly attrs: Readonly<Partial<Record<AttributeId, number>>>;
  /** Atributos que o ferreiro aceita para este item (do conjunto), na ordem da tela. */
  readonly upgradeAttributes: readonly AttributeId[];
  /** Preço (moedas) e chance (0 a 1) da próxima melhoria. O cliente não calcula. */
  readonly upgradeCost: number;
  readonly upgradeChance: number;
  /**
   * Fusão ([JOGO-20]): experiência juntada rumo ao próximo nível, quanto o próximo nível pede e quanto este item vale
   * se for fundido em outro igual. ATENÇÃO: lido em mmo-client/scripts/items/inventory_state.gd.
   */
  readonly xp: number;
  readonly xpNext: number;
  readonly fusionXp: number;
  /** Quanto a Loja do Ferreiro paga por este item ([JOGO-23], `sellPrice`). ATENÇÃO: lido em inventory_state.gd. */
  readonly sellPrice: number;
}

/** Payload de `inventory`. */
export interface InventoryView {
  readonly equipped: Readonly<Record<EquipSlotName, ItemView | null>>;
  readonly bag: readonly ItemView[];
  readonly bagCapacity: number;
  /** Ataque simples quando não há arma na mão. */
  readonly unarmedAttack: AbilityView;
}

/** Item vestido como aparece nos Atributos de um jogador: só o que se mostra (sem uid nem habilidades). */
export interface EquippedItemSummary {
  readonly itemId: string;
  readonly name: string;
  /** Conjunto ("Treino", "Mago"...): cor da moldura do ícone no cliente. */
  readonly set: string;
}

/**
 * Força do jogador pelo nível ([JOGO-12]): multiplicadores (1 = nível 0) do dano, da cura e do escudo que ele dá.
 * Hoje os três são iguais (1 + 1% por nível); separados para poderem divergir sem mudar o protocolo.
 */
export interface PowerView {
  readonly damage: number;
  readonly healing: number;
  readonly shield: number;
}

/**
 * Payload de `attributes` (resposta ao `inspect`, mmo-docs [SOC-02]): o que a tela de Atributos mostra.
 * ATENÇÃO: lido em mmo-client/scripts/ui/attributes_panel.gd (AttributesPanel.show_attributes).
 */
export interface AttributesView {
  /** Id do jogador. */
  readonly id: string;
  readonly name: string;
  readonly level: number;
  /** Vida e mana máximas (com a vida extra dos itens e o nível; 1 casa decimal). */
  readonly maxHp: number;
  readonly maxMana: number;
  readonly power: PowerView;
  /** O que veste em cada slot (`null` = vazio). */
  readonly equipped: Readonly<Record<EquipSlotName, EquippedItemSummary | null>>;
  /** Contadores do perfil ([SOC-08]). */
  readonly stats: StatsView;
}

/** Contadores do perfil na tela de Atributos ([SOC-08]); começaram do zero em 2026-11-17. */
export interface StatsView {
  /** XP ganha matando monstros (vida inteira, 1 casa). */
  readonly monsterXp: number;
  /** Jogadores mortos (PvP). */
  readonly kills: number;
  /** Mortes (para monstro e jogador). */
  readonly deaths: number;
}

/**
 * `attributes` de um perfil fechado para quem pediu (Configuração → Perfil: Só amigos / Ninguém, [SOC-08]): só quem é,
 * nada dos atributos. O cliente mostra "Perfil privado".
 */
export interface HiddenAttributesView {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly hidden: true;
}

/** Payload de `attributes`: o perfil inteiro, ou fechado ({@link HiddenAttributesView}). */
export type AttributesData = AttributesView | HiddenAttributesView;

/** Máximo de jogadores num grupo (mmo-docs [SOC-03]). ATENÇÃO: mmo-client/scripts/network/group_state.gd (MAX_MEMBERS). */
export const GROUP_MAX_MEMBERS = 5;

/** Segundos que um convite de grupo espera resposta; depois expira (quem convidou recebe o aviso `expired`). */
export const GROUP_INVITE_SECONDS = 30;

/** Um membro do grupo como vai na mensagem `group`. */
export interface GroupMemberView {
  readonly id: string;
  readonly name: string;
  readonly level: number;
}

/**
 * Grupo de quem recebe ([SOC-03]): o líder e os membros na ordem em que entraram (o líder é o primeiro; se ele sai,
 * o seguinte vira líder). ATENÇÃO: lido em mmo-client/scripts/network/group_state.gd (GroupState.from_dict).
 */
export interface GroupView {
  readonly leaderId: string;
  readonly members: readonly GroupMemberView[];
}

/** Payload de `group`: o seu grupo, ou `null` = sem grupo. */
export interface GroupData {
  readonly group: GroupView | null;
}

/** Payload de `group_invited`. */
export interface GroupInvitedData {
  /** Quem convidou (responder com `group_answer { fromId }`). */
  readonly fromId: string;
  readonly fromName: string;
  /** Segundos até o convite expirar ({@link GROUP_INVITE_SECONDS}). */
  readonly expiresIn: number;
}

/**
 * Tipos de aviso de grupo (`group_notice.code`): `accepted`/`rejected`/`expired`/`in_group` = resposta ao SEU convite
 * (o convidado aceitou, recusou, não respondeu a tempo, já tem grupo); `joined` = alguém entrou (ou você entrou);
 * `left` = alguém saiu; `kicked` = alguém foi expulso (ou você); `leader` = líder novo; `disbanded` = o grupo acabou.
 */
export type GroupNoticeCode = "accepted" | "rejected" | "expired" | "in_group" | "joined" | "left" | "kicked" | "leader" | "disbanded";

/** Payload de `group_notice`: o aviso pronto para mostrar (`message`, em português) e de quem se trata. */
export interface GroupNoticeData {
  readonly code: GroupNoticeCode;
  /** Nome do jogador de quem o aviso fala (pode ser você). */
  readonly name: string;
  readonly message: string;
}

/** Moedas para criar uma guilda ([SOC-06]; manter não custa nada). ATENÇÃO: espelho em mmo-client/scripts/network/protocol.gd (GUILD_CREATE_COST). */
export const GUILD_CREATE_COST = 1000;
/** Máximo de membros de uma guilda ([SOC-06]). */
export const GUILD_MAX_MEMBERS = 50;
/** Segundos que um convite de guilda espera resposta (como o de grupo). */
export const GUILD_INVITE_SECONDS = 30;
/** Segundos sem poder aceitar convite de guilda depois de sair por vontade própria (1 h; expulso não pega). */
export const GUILD_LEAVE_COOLDOWN_SECONDS = 3600;

/** Cargo na guilda: líder (um só), oficial ou membro. ATENÇÃO: mmo-client/scripts/network/guild_state.gd (ROLE_*). */
export type GuildRole = "leader" | "officer" | "member";

/** Payload de `guild_create`. */
export interface GuildCreateData {
  /** Nome da guilda (3 a 20: letras, números e espaços; único). */
  readonly name: string;
  /** Tag de 3 letras/números (única; guardada em maiúsculas). */
  readonly tag: string;
  /** Descrição breve (até {@link GUILD_DESCRIPTION_MAX} caracteres; pode ser vazia). */
  readonly description: string;
}

/** Tamanho máximo da descrição da guilda (caracteres). ATENÇÃO: mmo-client/scripts/network/guild_state.gd. */
export const GUILD_DESCRIPTION_MAX = 120;
/** Dias que um pedido para entrar espera resposta. */
export const GUILD_REQUEST_DAYS = 7;
/** Máximo de guildas no Procurar guilda. */
export const GUILD_LIST_MAX = 50;

/** Payload de `guild_list`: o texto da busca (vazio = lista normal). */
export interface GuildListRequestData {
  readonly query: string;
}

/** Payload de `guild_info` e `guild_request`: a guilda. */
export interface GuildIdData {
  readonly guildId: string;
}

/** Payload de `guild_request_answer`. */
export interface GuildRequestAnswerData {
  /** Quem pediu para entrar. */
  readonly playerId: string;
  readonly accept: boolean;
}

/** Payload de `guild_description`. */
export interface GuildDescriptionData {
  readonly description: string;
}

/** Um pedido para entrar, como líder/oficial vê. */
export interface GuildRequestView {
  readonly id: string;
  readonly name: string;
  /** Quando pediu (ms desde 1970). */
  readonly at: number;
}

/** Uma guilda na lista do Procurar guilda. */
export interface GuildSummaryView {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly members: number;
}

/** Payload de `guild_list` (resposta). */
export interface GuildListData {
  /** O texto buscado (igual ao do pedido; vazio = lista normal). */
  readonly query: string;
  readonly guilds: readonly GuildSummaryView[];
}

/** Payload de `guild_info`: a ficha da guilda. */
export interface GuildInfoView {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly description: string;
  readonly leaderName: string;
  readonly members: number;
  /** Quando foi criada (ms desde 1970). */
  readonly createdAt: number;
  /** Soma da XP de monstros e dos jogadores mortos dos membros (global, do ranking, [SOC-07]). */
  readonly monsterXp: number;
  readonly kills: number;
  /** `true` = você já pediu para entrar (esperando resposta). */
  readonly requested: boolean;
}

/** Payload de `guild_invite` e `guild_kick`: o outro jogador. */
export interface GuildTargetData {
  readonly playerId: string;
}

/** Payload de `guild_answer`. */
export interface GuildAnswerData {
  /** Quem convidou (o `fromId` do {@link GuildInvitedData}). */
  readonly fromId: string;
  readonly accept: boolean;
}

/** Payload de `guild_role`: o novo cargo de um membro (o líder não muda por aqui). */
export interface GuildRoleData {
  readonly playerId: string;
  readonly role: "officer" | "member";
}

/** Um membro na lista da guilda. */
export interface GuildMemberView {
  readonly id: string;
  readonly name: string;
  readonly role: GuildRole;
  readonly online: boolean;
  /** Nível de quem está online numa zona; `null` = offline/desconhecido. */
  readonly level: number | null;
}

/** A guilda como o cliente vê (Menu → Guilda). */
export interface GuildView {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly description: string;
  /** Pedidos para entrar (só para líder e oficiais; os outros recebem lista vazia). */
  readonly requests: readonly GuildRequestView[];
  /** Membros: líder, oficiais e membros, cada grupo do mais antigo ao mais novo. */
  readonly members: readonly GuildMemberView[];
}

/** Payload de `guild`. */
export interface GuildData {
  readonly guild: GuildView | null;
}

/** Payload de `guild_invited`. */
export interface GuildInvitedData {
  readonly fromId: string;
  readonly fromName: string;
  readonly guildName: string;
  readonly guildTag: string;
  /** Segundos até o convite expirar ({@link GUILD_INVITE_SECONDS}). */
  readonly expiresIn: number;
}

/**
 * Tipos de aviso de guilda (`guild_notice.code`): `accepted`/`rejected`/`expired` = resposta ao SEU convite;
 * `joined`/`left`/`kicked` = alguém entrou/saiu/foi expulso (ou você); `leader` = líder novo; `role` = cargo mudou;
 * `created` = você criou a guilda; `disbanded` = a guilda acabou (saiu o último); `request` = alguém pediu para entrar
 * (líder/oficiais); `request_sent` = seu pedido foi enviado; `description` = a descrição mudou.
 */
export type GuildNoticeCode =
  | "accepted"
  | "rejected"
  | "expired"
  | "joined"
  | "left"
  | "kicked"
  | "leader"
  | "role"
  | "created"
  | "disbanded"
  | "request"
  | "request_sent"
  | "description";

/** Payload de `guild_notice`: o aviso pronto para mostrar. */
export interface GuildNoticeData {
  readonly code: GuildNoticeCode;
  readonly message: string;
}

/** Distância máxima (m) entre os dois para pedir, aceitar e manter uma troca ([SOC-05]). ATENÇÃO: = TRADE_RANGE em mmo-client/scripts/network/protocol.gd. */
export const TRADE_RANGE = 10;
/** Segundos que um pedido de troca espera resposta (como o convite de grupo). */
export const TRADE_REQUEST_SECONDS = 30;
/** Segundos depois da última mudança (de qualquer oferta) até "Confirmar" valer ([SOC-05]). */
export const TRADE_CONFIRM_DELAY_SECONDS = 2;
/** Segundos da contagem (5, 4, 3, 2, 1) depois que os dois confirmaram, até a troca acontecer. */
export const TRADE_COUNTDOWN_SECONDS = 5;
/** Máximo de itens numa oferta (o tamanho da mochila). */
export const TRADE_MAX_ITEMS = 30;

/** Payload de `trade_request`: com quem trocar. */
export interface TradeTargetData {
  readonly playerId: string;
}

/** Payload de `trade_answer`. */
export interface TradeAnswerData {
  /** Quem pediu (o `fromId` do {@link TradeRequestedData}). */
  readonly fromId: string;
  readonly accept: boolean;
}

/** Payload de `trade_offer`: a oferta inteira (substitui a anterior). */
export interface TradeOfferData {
  /** `uid` dos itens da MOCHILA oferecidos (vestido não entra), sem repetir; até {@link TRADE_MAX_ITEMS}. */
  readonly uids: readonly string[];
  /** Moedas oferecidas (inteiro ≥ 0, até o que você tem). */
  readonly gold: number;
}

/** Payload de `trade_requested`. */
export interface TradeRequestedData {
  readonly fromId: string;
  readonly fromName: string;
  /** Segundos até expirar ({@link TRADE_REQUEST_SECONDS}). */
  readonly expiresIn: number;
}

/** Uma oferta como aparece na janela: os itens (ficha completa, para a ficha do item) e as moedas. */
export interface TradeOfferView {
  readonly items: readonly ItemView[];
  readonly gold: number;
}

/**
 * Payload de `trade_state`: a troca do ponto de vista de quem recebe. ATENÇÃO: lido em
 * mmo-client/scripts/network/trade_state.gd (TradeState.from_dict).
 */
export interface TradeStateData {
  readonly partnerId: string;
  readonly partnerName: string;
  /** O que VOCÊ oferece / o que o outro oferece. */
  readonly mine: TradeOfferView;
  readonly theirs: TradeOfferView;
  readonly myConfirmed: boolean;
  readonly theirConfirmed: boolean;
  /** Segundos até "Confirmar" valer (0 = já vale; o cliente conta sozinho a partir daqui). */
  readonly confirmIn: number;
  /** Segundos que faltam na contagem final (os dois confirmaram), ou `null` sem contagem. */
  readonly countdown: number | null;
  /** Por que não dá para confirmar agora (ex.: "A mochila de X não tem espaço."), ou `null`. */
  readonly problem: string | null;
}

/** Payload de `trade_done`. */
export interface TradeDoneData {
  readonly partnerName: string;
}

/**
 * Tipos de aviso de troca (`trade_notice.code`): `rejected`/`expired`/`busy` = resposta ao SEU pedido (recusou, não
 * respondeu, já está trocando); `cancelled` = alguém fechou a janela; `too_far` = passaram de {@link TRADE_RANGE} m;
 * `damaged` = alguém levou dano; `left` = alguém saiu da zona; `failed` = no fim algo não batia mais (item sumiu, moedas).
 */
export type TradeNoticeCode = "rejected" | "expired" | "busy" | "cancelled" | "too_far" | "damaged" | "left" | "failed";

/** Payload de `trade_notice`: o aviso pronto para mostrar. */
export interface TradeNoticeData {
  readonly code: TradeNoticeCode;
  /** Nome do outro jogador. */
  readonly name: string;
  readonly message: string;
}

/** Payload de `ranking_request`. */
export interface RankingRequestData {
  readonly category: RankingCategory;
  readonly period: RankingPeriod;
}

/** Uma linha de ranking: posição, id (jogador ou guilda), nome (ou "[TAG] Nome") e valor (XP ou jogadores mortos). */
export interface RankingRowView {
  readonly rank: number;
  readonly id: string;
  readonly name: string;
  readonly value: number;
}

/** Payload de `ranking` ([SOC-07]). */
export interface RankingData {
  readonly category: RankingCategory;
  readonly period: RankingPeriod;
  /** Top 100. */
  readonly rows: readonly RankingRowView[];
  /** A SUA linha (ou a da sua guilda nos rankings de guilda); `null` = ainda não pontuou / sem guilda. */
  readonly me: RankingRowView | null;
  /** Segundos até o período virar (0 = global, não vira). */
  readonly resetsIn: number;
  /** Há quantos segundos a tabela foi calculada (atualiza a cada {@link RANKING_REFRESH_SECONDS} s). */
  readonly age: number;
}

/** De quanto em quanto tempo (s) o servidor recalcula as tabelas de ranking (no máximo). */
export const RANKING_REFRESH_SECONDS = 60;

/** Payload de `player_guild`: a guilda nova de um jogador da zona (`null` = saiu/sem guilda). */
export interface PlayerGuildData {
  readonly id: string;
  readonly guildId: string | null;
  readonly guildTag: string | null;
}

/**
 * Frequência (Hz) da mensagem `group_positions`. Baixa de propósito: é só para o mapa (1 pixel = 2 m, [CLI-11]);
 * andando a 5 m/s o membro anda ~2,5 m (pouco mais de 1 pixel) entre duas. O snapshot (20 Hz) fica intacto.
 * ATENÇÃO: mmo-client/scripts/network/protocol.gd (`GROUP_POSITIONS_HZ`; `Network.GROUP_POSITIONS_STALE_SECONDS` conta com ela).
 */
export const GROUP_POSITIONS_HZ = 2;

/** Posição de um membro do grupo no chão (m, 1 casa decimal; o mapa não precisa de altura nem de rotação). */
export interface GroupPositionView {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

/**
 * Payload de `group_positions`: os membros do seu grupo (na mesma zona) que NÃO estão no seu snapshot — longe da sua
 * área de interesse. Você mesmo e quem está perto não vêm. ATENÇÃO: lido em mmo-client/scripts/network/network.gd.
 */
export interface GroupPositionsData {
  readonly members: readonly GroupPositionView[];
}

/** Máximo de amigos por conta (proteção; mmo-docs [SOC-04]). */
export const MAX_FRIENDS = 100;

/** Segundos que um pedido de amizade espera resposta (como o convite de grupo); depois expira (aviso `expired`). */
export const FRIEND_REQUEST_SECONDS = 30;

/** Um amigo como vai na mensagem `friends`. ATENÇÃO: lido em mmo-client/scripts/network/network.gd (friends). */
export interface FriendView {
  readonly id: string;
  readonly name: string;
  /** Conectado no servidor agora (qualquer zona). Jogador fake de teste: sempre `true`. */
  readonly online: boolean;
}

/** Payload de `friends`: todos os seus amigos (online primeiro, depois por nome). */
export interface FriendsData {
  readonly friends: readonly FriendView[];
}

/** Payload de `friend_requested`. */
export interface FriendRequestedData {
  /** Quem pediu (responder com `friend_answer { fromId }`). */
  readonly fromId: string;
  readonly fromName: string;
  /** Segundos até o pedido expirar ({@link FRIEND_REQUEST_SECONDS}). */
  readonly expiresIn: number;
}

/**
 * Tipos de aviso de amizade (`friend_notice.code`): `accepted`/`rejected`/`expired` = resposta ao SEU pedido (o outro
 * aceitou, recusou ou não respondeu a tempo); `added` = você aceitou e agora são amigos; `removed` = você removeu
 * alguém dos amigos.
 */
export type FriendNoticeCode = "accepted" | "rejected" | "expired" | "added" | "removed";

/** Payload de `friend_notice`: o aviso pronto para mostrar (`message`, em português) e de quem se trata. */
export interface FriendNoticeData {
  readonly code: FriendNoticeCode;
  readonly name: string;
  readonly message: string;
}

/**
 * Entrada de uma entidade no snapshot (versão 22, [INFRA-11]): `id` + **só os campos que mudaram** desde o último
 * snapshot que QUEM RECEBE ganhou (todos, quando ela acabou de entrar na vista). Nome, corpo e roupa não vêm aqui:
 * vão no `welcome`/`player_joined` e no evento `look`.
 * ATENÇÃO: o cliente junta os campos aos que já conhece (mmo-client/scripts/network/network.gd, `_apply_snapshot`).
 */
export type SnapshotEntry = Pick<PlayerSnapshot, "id"> & Partial<Omit<PlayerSnapshot, "id">>;

/** Payload de `snapshot` (versão 22: por diferença, [INFRA-11]). */
export interface SnapshotData {
  /** Número do tick do servidor que gerou este estado. */
  readonly tick: number;
  /** Último `input.seq` de QUEM RECEBE que já foi aplicado (0 = nenhum). Base da reconciliação. */
  readonly ack: number;
  /**
   * Jogadores da vista de quem recebe (até `VIEW_RADIUS` m, no máximo `MAX_VIEW_PLAYERS`, `Zone.ts`; ele mesmo e o
   * alvo sempre) que **mudaram** neste tick. Quem está na vista e não veio está igual ao último envio.
   */
  readonly players: readonly SnapshotEntry[];
  /** Bonecos/monstros da vista que mudaram (mesma regra; no máximo `MAX_VIEW_NPCS`). */
  readonly npcs: readonly SnapshotEntry[];
  /** Ids que saíram da vista neste tick (longe, limite da multidão ou saíram da zona): o cliente esconde e congela. */
  readonly gone: readonly string[];
  /** O que aconteceu neste tick perto de quem recebe (dano, mortes, projéteis…); `look` vai para todos. */
  readonly events: readonly CombatEvent[];
  /** Dados só de quem recebe: só os campos que mudaram (objeto vazio = nada mudou). */
  readonly me: Partial<OwnStatus>;
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
        /** Corpo escolhido; `null` = ainda não escolheu (o cliente mostra a tela de escolha antes do `join`). */
        readonly body: BodyType | null;
        /** Configuração social salva na conta (a tela de Configuração mostra; v15, [SOC-04]). */
        readonly social: SocialSettings;
      };
    }
  | { readonly type: typeof ServerMessageType.BodyChosen; readonly data: { readonly body: BodyType } }
  | { readonly type: typeof ServerMessageType.PasswordResetSent; readonly data: Record<string, never> }
  | { readonly type: typeof ServerMessageType.PasswordResetDone; readonly data: Record<string, never> }
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
        /** Baús dos acampamentos ([JOGO-19]). */
        readonly chests: readonly ChestView[];
      };
    }
  | { readonly type: typeof ServerMessageType.PlayerJoined; readonly data: { readonly player: PlayerInfo } }
  | { readonly type: typeof ServerMessageType.PlayerLeft; readonly data: { readonly id: string } }
  | { readonly type: typeof ServerMessageType.Snapshot; readonly data: SnapshotData }
  | { readonly type: typeof ServerMessageType.Inventory; readonly data: InventoryView }
  | { readonly type: typeof ServerMessageType.UpgradeResult; readonly data: UpgradeResultData }
  | { readonly type: typeof ServerMessageType.ChestLoot; readonly data: ChestLootData }
  | { readonly type: typeof ServerMessageType.FuseResult; readonly data: FuseResultData }
  | { readonly type: typeof ServerMessageType.Shop; readonly data: ShopData }
  | { readonly type: typeof ServerMessageType.ShopResult; readonly data: ShopResultData }
  | { readonly type: typeof ServerMessageType.DeathReport; readonly data: DeathReportData }
  | { readonly type: typeof ServerMessageType.Attributes; readonly data: AttributesData }
  | { readonly type: typeof ServerMessageType.Group; readonly data: GroupData }
  | { readonly type: typeof ServerMessageType.GroupInvited; readonly data: GroupInvitedData }
  | { readonly type: typeof ServerMessageType.GroupNotice; readonly data: GroupNoticeData }
  | { readonly type: typeof ServerMessageType.GroupPositions; readonly data: GroupPositionsData }
  | { readonly type: typeof ServerMessageType.Friends; readonly data: FriendsData }
  | { readonly type: typeof ServerMessageType.FriendRequested; readonly data: FriendRequestedData }
  | { readonly type: typeof ServerMessageType.FriendNotice; readonly data: FriendNoticeData }
  | { readonly type: typeof ServerMessageType.SocialSettings; readonly data: SocialSettings }
  | { readonly type: typeof ServerMessageType.Guild; readonly data: GuildData }
  | { readonly type: typeof ServerMessageType.GuildInvited; readonly data: GuildInvitedData }
  | { readonly type: typeof ServerMessageType.GuildNotice; readonly data: GuildNoticeData }
  | { readonly type: typeof ServerMessageType.PlayerGuild; readonly data: PlayerGuildData }
  | { readonly type: typeof ServerMessageType.Ranking; readonly data: RankingData }
  | { readonly type: typeof ServerMessageType.GuildList; readonly data: GuildListData }
  | { readonly type: typeof ServerMessageType.GuildInfo; readonly data: GuildInfoView }
  | { readonly type: typeof ServerMessageType.TradeRequested; readonly data: TradeRequestedData }
  | { readonly type: typeof ServerMessageType.TradeState; readonly data: TradeStateData }
  | { readonly type: typeof ServerMessageType.TradeDone; readonly data: TradeDoneData }
  | { readonly type: typeof ServerMessageType.TradeNotice; readonly data: TradeNoticeData }
  | { readonly type: typeof ServerMessageType.UpdateRequired; readonly data: UpdateRequiredData }
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

/** Nome de plataforma aceito em {@link ClientBuild.platform} (o mesmo das pastas de `updates/`). */
const CLIENT_PLATFORM = /^[a-z]{1,16}$/;

/**
 * Lê o `client` opcional da autenticação: `undefined` sem o campo (cliente antigo/dev), `null` se vier fora do formato,
 * senão o {@link ClientBuild}.
 */
export function parseClientBuild(value: unknown): ClientBuild | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { platform, pack } = value;
  if (typeof platform !== "string" || !CLIENT_PLATFORM.test(platform)) return null;
  if (!isVersion(pack) || pack < 0) return null;
  return { platform, pack };
}

/** Valida o formato de `register`. */
export function parseRegisterData(data: unknown): RegisterData | null {
  if (!isRecord(data)) return null;
  const { version, username, email, password } = data;
  const client: ClientBuild | null | undefined = parseClientBuild(data["client"]);
  if (!isVersion(version) || client === null) return null;
  if (!isStringUpTo(username, MAX_AUTH_FIELD) || !isStringUpTo(email, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, username, email, password, ...(client === undefined ? {} : { client }) };
}

/** Valida o formato de `login`. */
export function parseLoginData(data: unknown): LoginData | null {
  if (!isRecord(data)) return null;
  const { version, login, password } = data;
  const client: ClientBuild | null | undefined = parseClientBuild(data["client"]);
  if (!isVersion(version) || client === null || !isStringUpTo(login, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, login, password, ...(client === undefined ? {} : { client }) };
}

/** Valida o formato de `password_reset_request`. */
export function parsePasswordResetRequestData(data: unknown): PasswordResetRequestData | null {
  if (!isRecord(data)) return null;
  const { version, login } = data;
  const client: ClientBuild | null | undefined = parseClientBuild(data["client"]);
  if (!isVersion(version) || client === null || !isStringUpTo(login, MAX_AUTH_FIELD)) return null;
  return { version, login, ...(client === undefined ? {} : { client }) };
}

/** Valida o formato de `password_reset_confirm` (código: até 16 caracteres; o conteúdo quem confere é o servidor). */
export function parsePasswordResetConfirmData(data: unknown): PasswordResetConfirmData | null {
  if (!isRecord(data)) return null;
  const { version, login, code, password } = data;
  const client: ClientBuild | null | undefined = parseClientBuild(data["client"]);
  if (!isVersion(version) || client === null || !isStringUpTo(login, MAX_AUTH_FIELD) || !isStringUpTo(code, 16) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, login, code, password, ...(client === undefined ? {} : { client }) };
}

/** Valida o formato de `resume`. */
export function parseResumeData(data: unknown): ResumeData | null {
  if (!isRecord(data)) return null;
  const { version, sessionToken } = data;
  const client: ClientBuild | null | undefined = parseClientBuild(data["client"]);
  if (!isVersion(version) || client === null || !isStringUpTo(sessionToken, 128) || sessionToken.length === 0) return null;
  return { version, sessionToken, ...(client === undefined ? {} : { client }) };
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
/** `true` se `value` é um dos {@link BODY_TYPES}. */
export function isBodyType(value: unknown): value is BodyType {
  return typeof value === "string" && (BODY_TYPES as readonly string[]).includes(value);
}

export function parseChooseBodyData(data: unknown): ChooseBodyData | null {
  if (!isRecord(data)) return null;
  const { body } = data;
  return isBodyType(body) ? { body } : null;
}

export function parseUnequipData(data: unknown): UnequipData | null {
  if (!isRecord(data)) return null;
  const { slot, index } = data;
  if (!isSlotName(slot)) return null;
  if (index === undefined || index === null) return { slot, index: null };
  return isBagIndex(index) ? { slot, index } : null;
}

/** Posição de vaga da mochila aceitável na rede (inteiro de 0 a 999; a regra do inventário confere o resto). */
const isBagIndex = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value < 1000;

/** Valida o payload de `upgrade`. */
/** Id curto e não vazio (baú, item do baú). */
function isShortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/** Valida o payload de `fuse`. */
export function parseFuseData(data: unknown): FuseData | null {
  if (!isRecord(data) || !isShortId(data["targetUid"]) || !isShortId(data["materialUid"])) return null;
  return { targetUid: data["targetUid"], materialUid: data["materialUid"] };
}

/** Valida o payload de `chest_open`. */
export function parseChestRequestData(data: unknown): ChestRequestData | null {
  if (!isRecord(data) || !isShortId(data["chestId"])) return null;
  return { chestId: data["chestId"] };
}

/** Valida o payload de `chest_take`. */
export function parseChestTakeData(data: unknown): ChestTakeData | null {
  if (!isRecord(data) || !isShortId(data["chestId"]) || !isShortId(data["lootId"])) return null;
  return { chestId: data["chestId"], lootId: data["lootId"] };
}

export function parseUpgradeData(data: unknown): UpgradeData | null {
  if (!isRecord(data)) return null;
  const { uid, attribute } = data;
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 64 || !isAttributeId(attribute)) return null;
  return { uid, attribute };
}

/** Valida o payload de `item_destroy`. */
export function parseItemDestroyData(data: unknown): ItemDestroyData | null {
  if (!isRecord(data)) return null;
  const { uid } = data;
  return typeof uid === "string" && uid.length > 0 && uid.length <= 64 ? { uid } : null;
}

/** Valida o payload de `bag_move`. */
export function parseBagMoveData(data: unknown): BagMoveData | null {
  if (!isRecord(data)) return null;
  const { from, to } = data;
  return isBagIndex(from) && isBagIndex(to) ? { from, to } : null;
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
  const seq: number | null | undefined = optionalNumber(data["seq"]);
  if (x === undefined || z === undefined || seq === undefined) return null;
  if (seq !== null && (!Number.isInteger(seq) || seq < 1 || seq > MAX_INPUT_SEQ)) return null;
  return { abilityId, targetId: target, x, z, seq };
}

/** Valida o payload de `attack`. */
export function parseAttackData(data: unknown): AttackData | null {
  if (!isRecord(data)) return null;
  const { targetId } = data;
  if (targetId === null || targetId === undefined) return { targetId: null };
  if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 64) return null;
  return { targetId };
}

/** Valida o payload de `inspect`. */
export function parseInspectData(data: unknown): InspectData | null {
  if (!isRecord(data)) return null;
  const { playerId } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
  return { playerId };
}

/** Valida o payload de `group_invite`/`group_kick`. */
export function parseGroupTargetData(data: unknown): GroupTargetData | null {
  if (!isRecord(data)) return null;
  const { playerId } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
  return { playerId };
}

/** Valida o payload de `group_answer`. */
export function parseGroupAnswerData(data: unknown): GroupAnswerData | null {
  if (!isRecord(data)) return null;
  const { fromId, accept } = data;
  if (typeof fromId !== "string" || fromId.length === 0 || fromId.length > 64 || typeof accept !== "boolean") return null;
  return { fromId, accept };
}

/** Valida o payload de `friend_request`/`friend_remove`. */
export function parseFriendTargetData(data: unknown): FriendTargetData | null {
  if (!isRecord(data)) return null;
  const { playerId } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
  return { playerId };
}

/** Valida o payload de `friend_answer`. */
export function parseFriendAnswerData(data: unknown): FriendAnswerData | null {
  if (!isRecord(data)) return null;
  const { fromId, accept } = data;
  if (typeof fromId !== "string" || fromId.length === 0 || fromId.length > 64 || typeof accept !== "boolean") return null;
  return { fromId, accept };
}

/** `true` se `value` é uma opção da Configuração social (`always`/`hide`). */
export function isSocialVisibility(value: unknown): value is SocialVisibility {
  return SOCIAL_VISIBILITIES.some((v) => v === value);
}

/** `true` se `value` é uma opção de quem vê o perfil (`public`/`friends`/`nobody`). */
export function isProfileVisibility(value: unknown): value is ProfileVisibility {
  return PROFILE_VISIBILITIES.some((v) => v === value);
}

/** Valida o payload de `social_settings` (as cinco opções são obrigatórias). */
export function parseSocialSettings(data: unknown): SocialSettings | null {
  if (!isRecord(data)) return null;
  const { friendRequests, groupInvites, guildInvites, profile, tradeRequests } = data;
  if (!isSocialVisibility(friendRequests) || !isSocialVisibility(groupInvites) || !isSocialVisibility(guildInvites)) return null;
  if (!isProfileVisibility(profile) || !isSocialVisibility(tradeRequests)) return null;
  return { friendRequests, groupInvites, guildInvites, profile, tradeRequests };
}

/** Valida o payload de `guild_create` (formato; as regras do nome e da tag são de `src/social/guilds.ts`). */
export function parseGuildCreateData(data: unknown): GuildCreateData | null {
  if (!isRecord(data)) return null;
  const { name, tag, description } = data;
  if (typeof name !== "string" || name.length > 64 || typeof tag !== "string" || tag.length > 16) return null;
  if (description !== undefined && (typeof description !== "string" || description.length > 400)) return null;
  return { name, tag, description: typeof description === "string" ? description : "" };
}

/** Valida o payload de `guild_info` e `guild_request`. */
export function parseGuildIdData(data: unknown): GuildIdData | null {
  if (!isRecord(data)) return null;
  const { guildId } = data;
  if (typeof guildId !== "string" || guildId.length === 0 || guildId.length > 64) return null;
  return { guildId };
}

/** Valida o payload de `guild_request_answer`. */
export function parseGuildRequestAnswerData(data: unknown): GuildRequestAnswerData | null {
  if (!isRecord(data)) return null;
  const { playerId, accept } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64 || typeof accept !== "boolean") return null;
  return { playerId, accept };
}

/** Valida o payload de `guild_description` (o tamanho final é conferido em `src/social/guilds.ts`). */
export function parseGuildDescriptionData(data: unknown): GuildDescriptionData | null {
  if (!isRecord(data)) return null;
  const { description } = data;
  if (typeof description !== "string" || description.length > 400) return null;
  return { description };
}

/** Valida o payload de `trade_request`. */
export function parseTradeTargetData(data: unknown): TradeTargetData | null {
  if (!isRecord(data)) return null;
  const { playerId } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
  return { playerId };
}

/** Valida o payload de `trade_answer`. */
export function parseTradeAnswerData(data: unknown): TradeAnswerData | null {
  if (!isRecord(data)) return null;
  const { fromId, accept } = data;
  if (typeof fromId !== "string" || fromId.length === 0 || fromId.length > 64 || typeof accept !== "boolean") return null;
  return { fromId, accept };
}

/** Valida o payload de `trade_offer` (formato; se os itens/moedas são seus é a troca que confere). */
export function parseTradeOfferData(data: unknown): TradeOfferData | null {
  if (!isRecord(data)) return null;
  const { uids, gold } = data;
  if (!Array.isArray(uids) || uids.length > TRADE_MAX_ITEMS) return null;
  const list: string[] = [];
  for (const uid of uids) {
    if (typeof uid !== "string" || uid.length === 0 || uid.length > 64 || list.includes(uid)) return null;
    list.push(uid);
  }
  if (typeof gold !== "number" || !Number.isSafeInteger(gold) || gold < 0) return null;
  return { uids: list, gold };
}

/** Valida o payload de `ranking_request`. */
export function parseRankingRequestData(data: unknown): RankingRequestData | null {
  if (!isRecord(data)) return null;
  const { category, period } = data;
  const validCategory: RankingCategory | undefined = RANKING_CATEGORIES.find((c) => c === category);
  const validPeriod: RankingPeriod | undefined = RANKING_PERIODS.find((p) => p === period);
  if (validCategory === undefined || validPeriod === undefined) return null;
  return { category: validCategory, period: validPeriod };
}

/** Valida o payload de `guild_role`. */
export function parseGuildRoleData(data: unknown): GuildRoleData | null {
  if (!isRecord(data)) return null;
  const { playerId, role } = data;
  if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
  if (role !== "officer" && role !== "member") return null;
  return { playerId, role };
}

/**
 * Lê a Configuração social guardada no banco: ausente (conta antiga) ou estragada vira {@link DEFAULT_SOCIAL_SETTINGS}
 * (campo a campo).
 */
export function readSocialSettings(raw: unknown): SocialSettings {
  if (!isRecord(raw)) return DEFAULT_SOCIAL_SETTINGS;
  const { friendRequests, groupInvites, guildInvites, profile, tradeRequests } = raw;
  return {
    friendRequests: isSocialVisibility(friendRequests) ? friendRequests : DEFAULT_SOCIAL_SETTINGS.friendRequests,
    groupInvites: isSocialVisibility(groupInvites) ? groupInvites : DEFAULT_SOCIAL_SETTINGS.groupInvites,
    guildInvites: isSocialVisibility(guildInvites) ? guildInvites : DEFAULT_SOCIAL_SETTINGS.guildInvites,
    profile: isProfileVisibility(profile) ? profile : DEFAULT_SOCIAL_SETTINGS.profile,
    tradeRequests: isSocialVisibility(tradeRequests) ? tradeRequests : DEFAULT_SOCIAL_SETTINGS.tradeRequests,
  };
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
    case ClientMessageType.PasswordResetRequest: {
      const data = parsePasswordResetRequestData(raw);
      return data === null ? null : { type: ClientMessageType.PasswordResetRequest, data };
    }
    case ClientMessageType.PasswordResetConfirm: {
      const data = parsePasswordResetConfirmData(raw);
      return data === null ? null : { type: ClientMessageType.PasswordResetConfirm, data };
    }
    case ClientMessageType.KeepAlive:
      return { type: ClientMessageType.KeepAlive, data: {} };
    case ClientMessageType.ChooseBody: {
      const data = parseChooseBodyData(raw);
      return data === null ? null : { type: ClientMessageType.ChooseBody, data };
    }
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
    case ClientMessageType.BagMove: {
      const data = parseBagMoveData(raw);
      return data === null ? null : { type: ClientMessageType.BagMove, data };
    }
    case ClientMessageType.ItemDestroy: {
      const data = parseItemDestroyData(raw);
      return data === null ? null : { type: ClientMessageType.ItemDestroy, data };
    }
    case ClientMessageType.ShopOpen:
      return { type: ClientMessageType.ShopOpen, data: {} };
    case ClientMessageType.ShopBuy: {
      if (!isRecord(raw)) return null;
      const { itemId } = raw;
      return typeof itemId === "string" && itemId.length > 0 && itemId.length <= 64 ? { type: ClientMessageType.ShopBuy, data: { itemId } } : null;
    }
    case ClientMessageType.ShopSell: {
      const data = parseItemDestroyData(raw);
      return data === null ? null : { type: ClientMessageType.ShopSell, data };
    }
    case ClientMessageType.Upgrade: {
      const data = parseUpgradeData(raw);
      return data === null ? null : { type: ClientMessageType.Upgrade, data };
    }
    case ClientMessageType.Respawn:
      return { type: ClientMessageType.Respawn, data: {} };
    case ClientMessageType.Fuse: {
      const data = parseFuseData(raw);
      return data === null ? null : { type: ClientMessageType.Fuse, data };
    }
    case ClientMessageType.ChestOpen: {
      const data = parseChestRequestData(raw);
      return data === null ? null : { type: ClientMessageType.ChestOpen, data };
    }
    case ClientMessageType.ChestTake: {
      const data = parseChestTakeData(raw);
      return data === null ? null : { type: ClientMessageType.ChestTake, data };
    }
    case ClientMessageType.Attack: {
      const data = parseAttackData(raw);
      return data === null ? null : { type: ClientMessageType.Attack, data };
    }
    case ClientMessageType.Cast: {
      const data = parseCastData(raw);
      return data === null ? null : { type: ClientMessageType.Cast, data };
    }
    case ClientMessageType.Inspect: {
      const data = parseInspectData(raw);
      return data === null ? null : { type: ClientMessageType.Inspect, data };
    }
    case ClientMessageType.GroupInvite: {
      const data = parseGroupTargetData(raw);
      return data === null ? null : { type: ClientMessageType.GroupInvite, data };
    }
    case ClientMessageType.GroupAnswer: {
      const data = parseGroupAnswerData(raw);
      return data === null ? null : { type: ClientMessageType.GroupAnswer, data };
    }
    case ClientMessageType.GroupKick: {
      const data = parseGroupTargetData(raw);
      return data === null ? null : { type: ClientMessageType.GroupKick, data };
    }
    case ClientMessageType.GroupLeave:
      return { type: ClientMessageType.GroupLeave, data: {} };
    case ClientMessageType.FriendRequest: {
      const data = parseFriendTargetData(raw);
      return data === null ? null : { type: ClientMessageType.FriendRequest, data };
    }
    case ClientMessageType.FriendAnswer: {
      const data = parseFriendAnswerData(raw);
      return data === null ? null : { type: ClientMessageType.FriendAnswer, data };
    }
    case ClientMessageType.FriendRemove: {
      const data = parseFriendTargetData(raw);
      return data === null ? null : { type: ClientMessageType.FriendRemove, data };
    }
    case ClientMessageType.SocialSettings: {
      const data = parseSocialSettings(raw);
      return data === null ? null : { type: ClientMessageType.SocialSettings, data };
    }
    case ClientMessageType.GuildCreate: {
      const data = parseGuildCreateData(raw);
      return data === null ? null : { type: ClientMessageType.GuildCreate, data };
    }
    case ClientMessageType.GuildInvite: {
      const data = parseGroupTargetData(raw);
      return data === null ? null : { type: ClientMessageType.GuildInvite, data };
    }
    case ClientMessageType.GuildAnswer: {
      const data = parseFriendAnswerData(raw);
      return data === null ? null : { type: ClientMessageType.GuildAnswer, data };
    }
    case ClientMessageType.GuildLeave:
      return { type: ClientMessageType.GuildLeave, data: {} };
    case ClientMessageType.GuildKick: {
      const data = parseGroupTargetData(raw);
      return data === null ? null : { type: ClientMessageType.GuildKick, data };
    }
    case ClientMessageType.GuildRole: {
      const data = parseGuildRoleData(raw);
      return data === null ? null : { type: ClientMessageType.GuildRole, data };
    }
    case ClientMessageType.GuildList: {
      // Cliente antigo manda `{}`: vira busca vazia.
      const query: unknown = isRecord(raw) ? raw["query"] : undefined;
      if (query !== undefined && (typeof query !== "string" || query.length > 40)) return null;
      return { type: ClientMessageType.GuildList, data: { query: typeof query === "string" ? query : "" } };
    }
    case ClientMessageType.GuildInfo: {
      const data = parseGuildIdData(raw);
      return data === null ? null : { type: ClientMessageType.GuildInfo, data };
    }
    case ClientMessageType.GuildRequest: {
      const data = parseGuildIdData(raw);
      return data === null ? null : { type: ClientMessageType.GuildRequest, data };
    }
    case ClientMessageType.GuildRequestAnswer: {
      const data = parseGuildRequestAnswerData(raw);
      return data === null ? null : { type: ClientMessageType.GuildRequestAnswer, data };
    }
    case ClientMessageType.GuildDescription: {
      const data = parseGuildDescriptionData(raw);
      return data === null ? null : { type: ClientMessageType.GuildDescription, data };
    }
    case ClientMessageType.RankingRequest: {
      const data = parseRankingRequestData(raw);
      return data === null ? null : { type: ClientMessageType.RankingRequest, data };
    }
    case ClientMessageType.TradeRequest: {
      const data = parseTradeTargetData(raw);
      return data === null ? null : { type: ClientMessageType.TradeRequest, data };
    }
    case ClientMessageType.TradeAnswer: {
      const data = parseTradeAnswerData(raw);
      return data === null ? null : { type: ClientMessageType.TradeAnswer, data };
    }
    case ClientMessageType.TradeOffer: {
      const data = parseTradeOfferData(raw);
      return data === null ? null : { type: ClientMessageType.TradeOffer, data };
    }
    case ClientMessageType.TradeConfirm:
      return { type: ClientMessageType.TradeConfirm, data: {} };
    case ClientMessageType.TradeCancel:
      return { type: ClientMessageType.TradeCancel, data: {} };
    default:
      return null;
  }
}
