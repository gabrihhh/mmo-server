import assert from "assert";

import { ClientMessageType, parseClientMessage, readSocialSettings } from "../src/net/protocol.js";

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
    assert.deepStrictEqual(parseClientMessage('{"type":"attack","data":{"targetId":"dummy_1"}}'), {
      type: ClientMessageType.Attack,
      data: { targetId: "dummy_1" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"cast","data":{"abilityId":"meteor","x":1.5,"z":-2}}'), {
      type: ClientMessageType.Cast,
      data: { abilityId: "meteor", targetId: null, x: 1.5, z: -2, seq: null },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"cast","data":{"abilityId":"bolt","targetId":"dummy_1"}}'), {
      type: ClientMessageType.Cast,
      data: { abilityId: "bolt", targetId: "dummy_1", x: null, z: null, seq: null },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"attack","data":{"targetId":null}}'), {
      type: ClientMessageType.Attack,
      data: { targetId: null },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"unequip","data":{"slot":"feet"}}'), {
      type: ClientMessageType.Unequip,
      data: { slot: "feet", index: null },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"unequip","data":{"slot":"feet","index":3}}'), {
      type: ClientMessageType.Unequip,
      data: { slot: "feet", index: 3 },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"upgrade","data":{"uid":"abc","attribute":"crit"}}'), {
      type: ClientMessageType.Upgrade,
      data: { uid: "abc", attribute: "crit" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"bag_move","data":{"from":0,"to":4}}'), {
      type: ClientMessageType.BagMove,
      data: { from: 0, to: 4 },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"input","data":{"seq":7,"x":0.5,"z":-1}}'), {
      type: ClientMessageType.Input,
      data: { seq: 7, x: 0.5, z: -1 },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"inspect","data":{"playerId":"fake_accept"}}'), {
      type: ClientMessageType.Inspect,
      data: { playerId: "fake_accept" },
    });
    // Grupo ([SOC-03]).
    assert.deepStrictEqual(parseClientMessage('{"type":"group_invite","data":{"playerId":"fake_accept"}}'), {
      type: ClientMessageType.GroupInvite,
      data: { playerId: "fake_accept" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"group_answer","data":{"fromId":"a","accept":false}}'), {
      type: ClientMessageType.GroupAnswer,
      data: { fromId: "a", accept: false },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"group_kick","data":{"playerId":"b"}}'), {
      type: ClientMessageType.GroupKick,
      data: { playerId: "b" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"group_leave","data":{}}'), { type: ClientMessageType.GroupLeave, data: {} });
    // Amizade e Configuração social ([SOC-04]).
    assert.deepStrictEqual(parseClientMessage('{"type":"friend_request","data":{"playerId":"fake_accept"}}'), {
      type: ClientMessageType.FriendRequest,
      data: { playerId: "fake_accept" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"friend_answer","data":{"fromId":"a","accept":true}}'), {
      type: ClientMessageType.FriendAnswer,
      data: { fromId: "a", accept: true },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"friend_remove","data":{"playerId":"b"}}'), {
      type: ClientMessageType.FriendRemove,
      data: { playerId: "b" },
    });
    assert.deepStrictEqual(parseClientMessage('{"type":"social_settings","data":{"friendRequests":"hide","groupInvites":"always"}}'), {
      type: ClientMessageType.SocialSettings,
      data: { friendRequests: "hide", groupInvites: "always" },
    });
  });

  it("readSocialSettings: conta antiga/estragada mostra tudo (campo a campo)", () => {
    assert.deepStrictEqual(readSocialSettings(undefined), { friendRequests: "always", groupInvites: "always" });
    assert.deepStrictEqual(readSocialSettings({ friendRequests: "hide", groupInvites: "talvez" }), {
      friendRequests: "hide",
      groupInvites: "always",
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
      '{"type":"unequip","data":{"slot":"feet","index":-1}}',
      '{"type":"bag_move","data":{"from":0}}',
      '{"type":"upgrade","data":{"uid":"abc","attribute":"voar"}}',
      '{"type":"upgrade","data":{"attribute":"crit"}}',
      '{"type":"bag_move","data":{"from":1.5,"to":2}}',
      '{"type":"cast","data":{"abilityId":""}}',
      '{"type":"cast","data":{"abilityId":"meteor","x":"1"}}',
      '{"type":"inspect","data":{}}',
      '{"type":"inspect","data":{"playerId":""}}',
      '{"type":"inspect","data":{"playerId":42}}',
      '{"type":"group_invite","data":{}}',
      '{"type":"group_kick","data":{"playerId":""}}',
      '{"type":"group_answer","data":{"fromId":"a"}}',
      '{"type":"group_answer","data":{"fromId":"a","accept":"sim"}}',
      '{"type":"friend_request","data":{}}',
      '{"type":"friend_remove","data":{"playerId":""}}',
      '{"type":"friend_answer","data":{"fromId":"a","accept":1}}',
      '{"type":"social_settings","data":{"friendRequests":"nunca","groupInvites":"always"}}',
      '{"type":"social_settings","data":{"groupInvites":"hide"}}',
    ];
    for (const text of bad) assert.strictEqual(parseClientMessage(text), null, text);
  });
});
