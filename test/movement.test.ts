import assert from "assert";

import { dashMovement, stepMovement, type MoveState, quantize } from "../src/sim/movement.js";

/**
 * Valores de referência da simulação. O cliente (mmo-client/scripts/sim/movement.gd) tem que
 * chegar nos MESMOS números; se mudar a fórmula, atualize os dois lados e estes casos.
 */
describe("stepMovement (simulação compartilhada)", () => {
  const params = { speed: 5, halfSize: 150 };
  const origin: MoveState = { x: 0, y: 0, z: 0, rotY: 0 };

  it("anda speed*dt na direção e vira para ela", () => {
    const s: MoveState = stepMovement(origin, { x: 0, z: -1 }, 0.05, params);
    assert.deepStrictEqual(s, { x: 0, y: 0, z: -0.25, rotY: Math.atan2(-0, 1) });
  });

  it("diagonal com comprimento > 1 é normalizada (e arredondada ao centímetro)", () => {
    const s: MoveState = stepMovement(origin, { x: 1, z: 1 }, 0.05, params);
    // 0,25 / √2 = 0,1768 m → 0,18 m.
    assert.deepStrictEqual([s.x, s.z], [0.18, 0.18]);
  });

  it("quantize: centímetro com a conta floor(v × 100 + 0,5) (igual no GDScript), também nos negativos", () => {
    assert.deepStrictEqual([quantize(0.125), quantize(-0.125), quantize(-0.124), quantize(1.004), quantize(-2.5)], [0.13, -0.12, -0.12, 1, -2.5]);
    // Andar muitos passos não acumula erro além do centímetro: cada passo cai na grade.
    let s: MoveState = origin;
    for (let i = 0; i < 1000; i++) s = stepMovement(s, { x: 0.3, z: -0.7 }, 0.05, params);
    assert.strictEqual(quantize(s.x), s.x);
    assert.strictEqual(quantize(s.z), s.z);
  });

  it("input quase zero não move nem gira", () => {
    const start: MoveState = { x: 1, y: 0, z: 2, rotY: 0.7 };
    assert.strictEqual(stepMovement(start, { x: 0.001, z: 0 }, 0.05, params), start);
  });

  it("limita às bordas", () => {
    const s: MoveState = stepMovement({ x: 149.9, y: 0, z: -149.9, rotY: 0 }, { x: 1, z: -1 }, 1, params);
    assert.strictEqual(s.x, 150);
    assert.strictEqual(s.z, -150);
  });

  it("dashMovement: desloca a distância na direção normalizada, vira e respeita a borda", () => {
    const s: MoveState = dashMovement(origin, 3, 4, 10, 150);
    assert.ok(Math.abs(s.x - 6) < 1e-12 && Math.abs(s.z - 8) < 1e-12);
    assert.strictEqual(s.rotY, Math.atan2(-0.6, -0.8));
    assert.strictEqual(dashMovement({ x: 149, y: 0, z: 0, rotY: 0 }, 1, 0, 6, 150).x, 150);
    assert.strictEqual(dashMovement(origin, 0, 0, 6, 150), origin);
  });
});

