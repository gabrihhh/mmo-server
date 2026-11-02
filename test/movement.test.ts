import assert from "assert";

import { stepMovement, type MoveState } from "../src/sim/movement.js";

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

  it("diagonal com comprimento > 1 é normalizada", () => {
    const s: MoveState = stepMovement(origin, { x: 1, z: 1 }, 0.05, params);
    const expected: number = 0.25 / Math.SQRT2;
    assert.ok(Math.abs(s.x - expected) < 1e-12 && Math.abs(s.z - expected) < 1e-12);
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
});
