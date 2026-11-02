import assert from "assert";

import { ClientMessageType, parseClientMessage } from "../src/net/protocol.js";

describe("parseClientMessage", () => {
  it("aceita join e input válidos", () => {
    assert.deepStrictEqual(parseClientMessage('{"type":"join","data":{"zone":"zone_1","version":3}}'), {
      type: ClientMessageType.Join,
      data: { zone: "zone_1", version: 3, guestToken: null },
    });
    assert.deepStrictEqual(
      parseClientMessage('{"type":"join","data":{"zone":"zone_1","version":3,"guestToken":"abc"}}'),
      { type: ClientMessageType.Join, data: { zone: "zone_1", version: 3, guestToken: "abc" } },
    );
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
      '{"type":"join","data":{"zone":"","version":1}}',
      '{"type":"join","data":{"zone":"zone_1","version":1.5}}',
      '{"type":"join","data":{"zone":"zone_1","version":2,"guestToken":42}}',
      '{"type":"join","data":{"zone":"zone_1","version":2,"guestToken":""}}',
    ];
    for (const text of bad) assert.strictEqual(parseClientMessage(text), null, text);
  });
});
