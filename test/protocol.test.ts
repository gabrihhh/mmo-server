import assert from "assert";

import { ClientMessageType, parseClientMessage } from "../src/net/protocol.js";

describe("parseClientMessage", () => {
  it("aceita mensagens válidas", () => {
    assert.deepStrictEqual(parseClientMessage('{"type":"join","data":{"zone":"zone_1"}}'), {
      type: ClientMessageType.Join,
      data: { zone: "zone_1" },
    });
    assert.deepStrictEqual(
      parseClientMessage('{"type":"register","data":{"version":4,"username":"Ana_1","email":"a@b.com","password":"12345678"}}'),
      { type: ClientMessageType.Register, data: { version: 4, username: "Ana_1", email: "a@b.com", password: "12345678" } },
    );
    assert.deepStrictEqual(parseClientMessage('{"type":"login","data":{"version":4,"login":"ana_1","password":"x"}}'), {
      type: ClientMessageType.Login,
      data: { version: 4, login: "ana_1", password: "x" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"resume","data":{"version":4,"sessionToken":"tok"}}'), {
      type: ClientMessageType.Resume,
      data: { version: 4, sessionToken: "tok" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"logout","data":{}}'), { type: ClientMessageType.Logout, data: {} });
    assert.deepStrictEqual(parseClientMessage('{"type":"equip","data":{"uid":"abc"}}'), { type: ClientMessageType.Equip, data: { uid: "abc" } });
    assert.deepStrictEqual(parseClientMessage('{"type":"unequip","data":{"slot":"feet"}}'), {
      type: ClientMessageType.Unequip,
      data: { slot: "feet" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"input","data":{"seq":7,"x":0.5,"z":-1}}'), {
      type: ClientMessageType.Input,
      data: { seq: 7, x: 0.5, z: -1 },
    });
  });

  it("rejeita JSON inválido, tipo desconhecido e payload fora do formato", () => {
    const bad: string[] = [
      "não é json",
      "42",
      "[]",
      '{"type":"teleport","data":{}}',
      '{"type":"move","data":{"x":1,"y":0,"z":0,"rotY":0}}',
      '{"type":"input"}',
      '{"type":"input","data":{"seq":0,"x":1,"z":0}}',
      '{"type":"input","data":{"seq":1.5,"x":1,"z":0}}',
      '{"type":"input","data":{"seq":1,"x":"1","z":0}}',
      '{"type":"input","data":{"seq":1,"x":1e999,"z":0}}',
      '{"type":"join","data":{"zone":""}}',
      '{"type":"register","data":{"version":4,"username":"a","email":"b"}}',
      '{"type":"register","data":{"version":4.5,"username":"a","email":"b","password":"c"}}',
      '{"type":"login","data":{"version":4,"login":42,"password":"x"}}',
      '{"type":"resume","data":{"version":4,"sessionToken":""}}',
      '{"type":"equip","data":{"uid":""}}',
      '{"type":"unequip","data":{"slot":"mochila"}}',
    ];
    for (const text of bad) assert.strictEqual(parseClientMessage(text), null, text);
  });
});
