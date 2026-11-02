import assert from "assert";

import { ClientMessageType, parseClientMessage } from "../src/net/protocol.js";

describe("parseClientMessage", () => {
  it("aceita join e move válidos", () => {
    assert.deepStrictEqual(parseClientMessage('{"type":"join","data":{"zone":"zone_1","version":1}}'), {
      type: ClientMessageType.Join,
      data: { zone: "zone_1", version: 1 },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"move","data":{"x":1,"y":2,"z":3,"rotY":0.5}}'), {
      type: ClientMessageType.Move,
      data: { x: 1, y: 2, z: 3, rotY: 0.5 },
    });
  });

  it("rejeita JSON inválido, tipo desconhecido e payload fora do formato", () => {
    const bad: string[] = [
      "não é json",
      "42",
      "[]",
      '{"type":"teleport","data":{}}',
      '{"type":"move"}',
      '{"type":"move","data":{"x":"1","y":0,"z":0,"rotY":0}}',
      '{"type":"move","data":{"x":1e999,"y":0,"z":0,"rotY":0}}',
      '{"type":"join","data":{"zone":"","version":1}}',
      '{"type":"join","data":{"zone":"zone_1","version":1.5}}',
    ];
    for (const text of bad) assert.strictEqual(parseClientMessage(text), null, text);
  });
});
