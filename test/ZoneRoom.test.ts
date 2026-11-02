import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import type { ZoneState, Player } from "../src/rooms/schema/ZoneState.js";
import { ZONE_HALF_SIZE } from "../src/rooms/ZoneRoom.js";
import { MessageType, parseMoveMessage } from "../src/rooms/messages.js";

/** Busca o jogador de uma sessão, falhando o teste se não existir. */
function getPlayer(state: ZoneState, sessionId: string): Player {
  const player: Player | undefined = state.players.get(sessionId);
  assert.ok(player, `jogador ${sessionId} deveria existir`);
  return player;
}

describe("parseMoveMessage", () => {
  it("aceita payload válido", () => {
    assert.deepStrictEqual(parseMoveMessage({ x: 1, y: 2, z: 3, rotY: 0.5 }), { x: 1, y: 2, z: 3, rotY: 0.5 });
  });

  it("rejeita payloads inválidos", () => {
    for (const bad of [null, 42, "move", {}, { x: "1", y: 0, z: 0, rotY: 0 }, { x: NaN, y: 0, z: 0, rotY: 0 }]) {
      assert.strictEqual(parseMoveMessage(bad), null);
    }
  });
});

describe("ZoneRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => colyseus.cleanup());

  it("cria um jogador ao entrar e remove ao sair", async () => {
    const room = await colyseus.createRoom<ZoneState>("zone", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    assert.strictEqual(room.state.players.size, 2);

    await c2.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.size, 1);
    assert.ok(room.state.players.has(c1.sessionId));
  });

  it("aplica a posição enviada pelo cliente", async () => {
    const room = await colyseus.createRoom<ZoneState>("zone", {});
    const c1 = await colyseus.connectTo(room);

    c1.send(MessageType.Move, { x: 10, y: 0, z: -20, rotY: 1.5 });
    await room.waitForMessage(MessageType.Move);

    const p = getPlayer(room.state, c1.sessionId);
    assert.deepStrictEqual([p.x, p.y, p.z, p.rotY], [10, 0, -20, 1.5]);
  });

  it("limita a posição às bordas da zona e ignora valores inválidos", async () => {
    const room = await colyseus.createRoom<ZoneState>("zone", {});
    const c1 = await colyseus.connectTo(room);

    c1.send(MessageType.Move, { x: 9999, y: 0, z: -9999, rotY: 0 });
    await room.waitForMessage(MessageType.Move);
    const p = getPlayer(room.state, c1.sessionId);
    assert.strictEqual(p.x, ZONE_HALF_SIZE);
    assert.strictEqual(p.z, -ZONE_HALF_SIZE);

    c1.send(MessageType.Move, { x: "abc", y: 0, z: 0, rotY: 0 });
    await room.waitForMessage(MessageType.Move);
    assert.strictEqual(p.x, ZONE_HALF_SIZE);
  });
});
