import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * Estado sincronizado automaticamente com todos os clientes da room.
 * Só o que muda é enviado (patches), ~20x por segundo por padrão.
 *
 * ATENÇÃO: nomes e tipos dos campos precisam bater com as classes de schema
 * do cliente (mmo-client/scripts/network/zone_schema.gd). Ver mmo-docs [INFRA-04].
 */

/** Um jogador conectado na zona. Posição em metros, `rotY` em radianos. */
export const Player = schema({
  x: t.number().default(0),
  y: t.number().default(0),
  z: t.number().default(0),
  rotY: t.number().default(0),
});
export type Player = SchemaType<typeof Player>;

/** Estado raiz da {@link ZoneRoom}. */
export const ZoneState = schema({
  /** Jogadores na zona, indexados pelo `sessionId` do cliente. */
  players: t.map(Player),
});
export type ZoneState = SchemaType<typeof ZoneState>;
