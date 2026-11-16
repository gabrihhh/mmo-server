import assert from "assert";

import { parseZoneMap } from "../src/zones/zoneMap.js";
import { placeTestNpcs, ZONE_CONFIGS } from "../src/zones/zones.js";

/** Mapa exportado do Blender ([ART-10]): o arquivo é validado e nível/alcances chegam ao NPC. */
describe("mapa da zona (maps/*.json)", () => {
  const ok = { id: "a", kind: "fighter", level: 0, x: 0, z: 0, resetRange: 20, perception: 5 };

  it("aceita um mapa válido", () => {
    const map = parseZoneMap({ monsters: [{ ...ok, level: 3, x: 10, z: -5 }], npcs: [{ id: "test_bag", x: 1, z: 2 }] }, 150);
    // Sem escala/chefe/nome (mapa antigo): padrões.
    assert.deepStrictEqual(map.monsters, [{ ...ok, level: 3, x: 10, z: -5, scale: 1, boss: false, name: "", camp: "" }]);
    assert.deepStrictEqual(map.camps, [], "mapa sem acampamentos");
    assert.deepStrictEqual(map.npcs, [{ id: "test_bag", x: 1, z: 2 }]);
  });

  it("recusa formato errado, id repetido, tipo desconhecido, nível/alcance inválido e posição fora do mapa", () => {
    const map = (monster: object): unknown => ({ monsters: [monster], npcs: [] });
    assert.throws(() => parseZoneMap([], 150), /monsters e npcs/);
    assert.throws(() => parseZoneMap({ monsters: [ok, ok], npcs: [] }, 150), /repetido/);
    assert.throws(() => parseZoneMap(map({ ...ok, kind: "dragon" }), 150), /tipo/);
    assert.throws(() => parseZoneMap(map({ ...ok, level: 1.5 }), 150), /nível/);
    assert.throws(() => parseZoneMap(map({ ...ok, level: -1 }), 150), /nível/);
    assert.strictEqual(parseZoneMap(map({ ...ok, level: 500 }), 150).monsters[0]?.level, 500); // sem nível máximo
    assert.throws(() => parseZoneMap(map({ ...ok, resetRange: 0 }), 150), /resetRange/);
    assert.throws(() => parseZoneMap(map({ ...ok, perception: "5" }), 150), /perception/);
    assert.throws(() => parseZoneMap(map({ ...ok, x: 151 }), 150), /fora do mapa/);
    assert.throws(() => parseZoneMap({ monsters: [], npcs: [{ id: "b", x: 0, z: 999 }], camps: [] }, 150), /fora do mapa/);
    assert.throws(() => parseZoneMap(map({ ...ok, scale: 9 }), 150), /escala/);
    assert.throws(() => parseZoneMap(map({ ...ok, boss: 1 }), 150), /boss/);
    assert.throws(() => parseZoneMap(map({ ...ok, name: "x".repeat(41) }), 150), /nome/);
  });

  it("chefe: escala, nome e chefe chegam ao zumbi (maior, mais vida, golpes do chefe)", () => {
    const map = parseZoneMap({ monsters: [{ ...ok, scale: 2, boss: true, name: "Rei Podre" }], npcs: [] }, 150);
    assert.deepStrictEqual([map.monsters[0]?.scale, map.monsters[0]?.boss, map.monsters[0]?.name], [2, true, "Rei Podre"]);
  });

  it("NPC de teste vai para o lugar do mapa; id desconhecido é erro", () => {
    const [bag] = placeTestNpcs({ monsters: [], npcs: [{ id: "test_bag", x: -8, z: -1 }], camps: [] });
    assert.strictEqual(bag?.name, "Saco de pancadas");
    assert.deepStrictEqual([bag?.x, bag?.z], [-8, -1]);
    assert.throws(() => placeTestNpcs({ monsters: [], npcs: [{ id: "nada", x: 0, z: 0 }], camps: [] }), /não existe/);
  });

  it("a Zone 1 tem os zumbis do arquivo, cada um com nível, percepção e desistência dele", () => {
    const zombies = (ZONE_CONFIGS[0]?.dummies ?? []).filter((d) => d.behavior?.kind === "zombie");
    assert.ok(zombies.length > 0, "zumbis na Zone 1");
    for (const z of zombies) {
      assert.ok(typeof z.level === "number" && Number.isInteger(z.level) && z.level >= 0, `nível de ${z.id}`);
      assert.ok(z.behavior?.kind === "zombie" && z.behavior.aggroRadius > 0 && z.behavior.leashRadius > 0, `alcances de ${z.id}`);
      assert.strictEqual(z.look?.hand ?? null, null, `${z.id} sem arma (bate com a mão)`);
    }
  });
});
