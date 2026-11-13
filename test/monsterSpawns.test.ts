import assert from "assert";

import { parseMonsterSpawns } from "../src/zones/monsterSpawns.js";
import { ZONE_CONFIGS } from "../src/zones/zones.js";

/** Monstros postos no editor do Godot ([MUN-05]): o arquivo é validado e o nível chega ao NPC. */
describe("monstros da zona (monsters/*.json)", () => {
  it("aceita uma lista válida", () => {
    const spawns = parseMonsterSpawns([{ id: "a", kind: "fighter", level: 3, x: 10, z: -5 }], 150);
    assert.deepStrictEqual(spawns, [{ id: "a", kind: "fighter", level: 3, x: 10, z: -5 }]);
  });

  it("recusa id repetido, tipo desconhecido, nível inválido e posição fora do mapa", () => {
    const ok = { id: "a", kind: "fighter", level: 0, x: 0, z: 0 };
    assert.throws(() => parseMonsterSpawns({}, 150), /lista/);
    assert.throws(() => parseMonsterSpawns([ok, ok], 150), /repetido/);
    assert.throws(() => parseMonsterSpawns([{ ...ok, kind: "dragon" }], 150), /tipo/);
    assert.throws(() => parseMonsterSpawns([{ ...ok, level: 1.5 }], 150), /nível/);
    assert.throws(() => parseMonsterSpawns([{ ...ok, level: -1 }], 150), /nível/);
    assert.strictEqual(parseMonsterSpawns([{ ...ok, level: 500 }], 150)[0]?.level, 500); // sem nível máximo
    assert.throws(() => parseMonsterSpawns([{ ...ok, x: 151 }], 150), /fora do mapa/);
    assert.throws(() => parseMonsterSpawns([{ ...ok, z: "1" }], 150), /fora do mapa/);
  });

  it("a Zone 1 tem os zumbis do arquivo, cada um no nível escolhido", () => {
    const zombies = (ZONE_CONFIGS[0]?.dummies ?? []).filter((d) => d.behavior?.kind === "zombie");
    assert.ok(zombies.length > 0, "zumbis na Zone 1");
    for (const z of zombies) {
      assert.ok(typeof z.level === "number" && Number.isInteger(z.level) && z.level >= 0, `nível de ${z.id}`);
    }
  });
});
