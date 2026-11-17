/**
 * Benchmark da zona (mmo-docs [INFRA-11]): a zone_1 real (monstros do mapa do Blender) com N jogadores de mentira
 * andando ao acaso, sem rede nem banco. Mede o tempo de cada tick (média, p99, pior) e de cada fase dele, e os bytes
 * de snapshot por jogador. É o que usamos para decidir e conferir cada otimização do servidor.
 *
 * Uso: `npm run bench` (todos os cenários) ou `npm run bench -- 400 spread` (N jogadores, `spread` ou `crowd`).
 * Ticks medidos: {@link MEASURED_TICKS} (depois de {@link WARMUP_TICKS} de aquecimento).
 * Não roda nos testes; o tempo depende da máquina (comparar antes/depois na MESMA máquina).
 */
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import { Zone, type ZoneConfig, type ZoneMember } from "../src/zones/Zone.js";
import { ZONE_CONFIGS } from "../src/zones/zones.js";

/** Ticks de aquecimento (JIT do V8, monstros acordando) antes de medir. */
const WARMUP_TICKS = 150;
/** Ticks medidos por cenário (~20 s de jogo a 30 Hz). */
const MEASURED_TICKS = 600;
/** Fases do tick medidas separadamente (métodos privados da `Zone`, embrulhados só aqui). */
const PHASES = ["respawnDue", "applyMovement", "moveProjectiles", "npcThink", "applyCasts", "regenerate", "sendSnapshots"] as const;
/** Lado do quadrado onde a multidão (`crowd`) nasce, em metros. */
const CROWD_SIDE_M = 30;
/** A cada quantos ticks, em média, um jogador muda de direção (~2 s). */
const TURN_EVERY_TICKS = 60;

type Scenario = "spread" | "crowd";

/** Gerador pseudoaleatório com semente fixa (mulberry32): mesmo cenário em toda execução. */
function rng(seed: number): () => number {
  let a: number = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t: number = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tempo acumulado de cada fase no cenário atual (ms). */
const phaseMs: Map<string, number> = new Map();

/** Embrulha as fases da `Zone` uma vez para somar o tempo de cada uma em {@link phaseMs}. */
function instrumentPhases(): void {
  const proto: object = Zone.prototype;
  for (const name of PHASES) {
    const original: unknown = Reflect.get(proto, name);
    if (typeof original !== "function") throw new Error(`fase ${name} não existe mais na Zone (atualize o benchmark)`);
    Reflect.set(proto, name, function (this: unknown, ...args: unknown[]): unknown {
      const started: number = performance.now();
      const result: unknown = Reflect.apply(original, this, args);
      phaseMs.set(name, (phaseMs.get(name) ?? 0) + performance.now() - started);
      return result;
    });
  }
}

/** Percentil `p` (0..1) de valores já ordenados. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/** Roda um cenário e imprime uma linha com o resultado. */
function run(players: number, scenario: Scenario): void {
  const base: ZoneConfig | undefined = ZONE_CONFIGS[0];
  if (base === undefined) throw new Error("sem zona");
  const zone: Zone = new Zone({ ...base, maxPlayers: players + 1 });
  const random: () => number = rng(players * 7 + (scenario === "crowd" ? 1 : 0));
  const limit: number = base.halfSize - 5;
  let bytes: number = 0;
  const walkers: Array<{ id: string; seq: number; dirX: number; dirZ: number }> = [];
  for (let i = 0; i < players; i++) {
    const id: string = `bench_${i}`;
    const member: ZoneMember = { id, name: id, send: (text: string): void => void (bytes += text.length) };
    const x: number = scenario === "crowd" ? (random() - 0.5) * CROWD_SIDE_M : (random() * 2 - 1) * limit;
    const z: number = scenario === "crowd" ? (random() - 0.5) * CROWD_SIDE_M : (random() * 2 - 1) * limit;
    zone.join(member, { x, y: 0, z, rotY: 0 });
    walkers.push({ id, seq: 0, dirX: 0, dirZ: 0 });
  }
  const tickMs: number[] = [];
  for (let t = 0; t < WARMUP_TICKS + MEASURED_TICKS; t++) {
    if (t === WARMUP_TICKS) {
      phaseMs.clear();
      bytes = 0;
    }
    for (const walker of walkers) {
      if (walker.seq === 0 || random() < 1 / TURN_EVERY_TICKS) {
        // 1 em 4 fica parado um tempo (jogador real não anda o tempo todo).
        const angle: number = random() * Math.PI * 2;
        const moving: boolean = random() > 0.25;
        walker.dirX = moving ? Math.cos(angle) : 0;
        walker.dirZ = moving ? Math.sin(angle) : 0;
      }
      walker.seq++;
      zone.queueInput(walker.id, { seq: walker.seq, x: walker.dirX, z: walker.dirZ });
    }
    const started: number = performance.now();
    zone.tick();
    if (t >= WARMUP_TICKS) tickMs.push(performance.now() - started);
  }
  const sorted: number[] = [...tickMs].sort((a, b) => a - b);
  const mean: number = tickMs.reduce((sum, value) => sum + value, 0) / tickMs.length;
  const seconds: number = MEASURED_TICKS / TICK_RATE_HZ;
  const phases: string = PHASES.map((name) => `${name} ${((phaseMs.get(name) ?? 0) / MEASURED_TICKS).toFixed(2)}`).join(" · ");
  console.log(
    `${String(players).padStart(4)} ${scenario.padEnd(6)} | tick média ${mean.toFixed(2)} ms · p99 ${percentile(sorted, 0.99).toFixed(2)} · pior ${(sorted[sorted.length - 1] ?? 0).toFixed(2)} ` +
      `(de ${(1000 / TICK_RATE_HZ).toFixed(1)}) | ${(bytes / players / seconds / 1024).toFixed(1)} KB/s por jogador`,
  );
  console.log(`              fases (ms/tick): ${phases}`);
}

instrumentPhases();
const argPlayers: number = Number(process.argv[2]);
const argScenario: string | undefined = process.argv[3];
if (Number.isFinite(argPlayers) && argPlayers > 0) {
  run(argPlayers, argScenario === "crowd" ? "crowd" : "spread");
} else {
  for (const [players, scenario] of [[1, "spread"], [100, "spread"], [400, "spread"], [100, "crowd"], [200, "crowd"]] as const) {
    run(players, scenario);
  }
}
