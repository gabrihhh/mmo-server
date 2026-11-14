/**
 * Ameaça (aggro) dos monstros: quem o monstro ataca ([JOGO-14]).
 *
 * Cada monstro guarda uma {@link ThreatTable} (jogador → ameaça). Bater gera ameaça para quem bateu; curar ou proteger
 * (escudo) quem está na tabela gera ameaça para quem curou; chegar perto (percepção) dá uma ameaça inicial pequena. O
 * monstro ataca o de maior ameaça, mas só troca de alvo quando alguém passa do alvo atual com folga
 * ({@link chooseThreatTarget}). A habilidade "Desafio" do cavaleiro provoca: prende o monstro nele por um tempo.
 *
 * Separado dos `contributors` (quem ganha XP, [JOGO-12]) de propósito: a XP conta quem participou (até curar 0 conta),
 * a ameaça conta quanto; as regras de XP não mudam.
 *
 * Só servidor (sem espelho no cliente; não há UI de ameaça).
 */

/** Ameaça por ponto de dano causado no monstro (vida + escudo dele que o golpe gastou). */
export const THREAT_PER_DAMAGE = 1;

/**
 * Ameaça por ponto de cura EFETIVA (sem o que passou da vida máxima) num aliado que está na tabela do monstro, para quem
 * curou. Vale igual para o escudo aplicado (valor inteiro do escudo dado). Efetiva para não punir a cura que sobrou.
 */
export const THREAT_PER_HEAL = 0.5;

/** Ameaça inicial de quem entra na percepção do monstro (`aggroRadius` m da casa): só para ele começar a vir. */
export const THREAT_INITIAL = 1;

/**
 * Troca de alvo: um candidato no corpo a corpo (dentro do alcance do ataque simples do monstro + folga) precisa passar
 * de 110% da ameaça do alvo atual.
 */
export const THREAT_SWITCH_MELEE = 1.1;

/** Troca de alvo: um candidato longe precisa passar de 130% da ameaça do alvo atual. */
export const THREAT_SWITCH_RANGED = 1.3;

/**
 * Provocar (Desafio): a ameaça de quem provocou vira 110% da maior ameaça dos OUTROS na tabela (se já for maior,
 * mantém). Igual a {@link THREAT_SWITCH_MELEE}: quando a provocação acaba, ninguém passa dele sem gerar mais ameaça.
 */
export const TAUNT_THREAT_MULTIPLIER = 1.1;

/** Tabela de ameaça de um monstro: id do jogador → ameaça acumulada (pontos, sem teto). */
export class ThreatTable {
  private readonly values: Map<string, number> = new Map();

  /** Quantos jogadores estão na tabela. */
  get size(): number {
    return this.values.size;
  }

  /** `true` se `id` está na tabela (está lutando com o monstro). */
  has(id: string): boolean {
    return this.values.has(id);
  }

  /** Ameaça de `id` (0 se não está na tabela). */
  get(id: string): number {
    return this.values.get(id) ?? 0;
  }

  /** Soma `amount` (> 0) à ameaça de `id`, pondo ele na tabela. Valores ≤ 0 são ignorados. */
  add(id: string, amount: number): void {
    if (!(amount > 0)) return;
    this.values.set(id, this.get(id) + amount);
  }

  /** Põe `id` na tabela com `initial` se ainda não estiver (não mexe em quem já está). */
  ensure(id: string, initial: number): void {
    if (!this.values.has(id)) this.values.set(id, initial);
  }

  /** Sobe a ameaça de `id` para `value` se for maior que a atual (põe na tabela). */
  raiseTo(id: string, value: number): void {
    this.values.set(id, Math.max(value, this.get(id)));
  }

  /** Maior ameaça na tabela sem contar `exceptId` (0 se não há outros). */
  maxExcept(exceptId: string): number {
    let max: number = 0;
    for (const [id, value] of this.values) if (id !== exceptId && value > max) max = value;
    return max;
  }

  /** Tira `id` da tabela (morreu, saiu da zona). */
  remove(id: string): void {
    this.values.delete(id);
  }

  /** Esvazia (monstro desistiu e voltou para casa, morreu ou reapareceu). */
  clear(): void {
    this.values.clear();
  }

  /** Ids e ameaças, na ordem em que entraram. */
  entries(): IterableIterator<[string, number]> {
    return this.values.entries();
  }

  /** Cópia só de leitura (testes/depuração). */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.values);
  }
}

/** Candidato a alvo do monstro: um jogador da tabela que ele pode atacar. */
export interface ThreatCandidate {
  readonly id: string;
  /** Ameaça na tabela do monstro. */
  readonly threat: number;
  /** No corpo a corpo: a até o alcance do ataque simples do monstro + folga (m). */
  readonly melee: boolean;
  /** Distância até o monstro (m): desempate entre ameaças iguais (o mais perto). */
  readonly distance: number;
}

/**
 * Escolhe o alvo do monstro pela ameaça ([JOGO-14]):
 * - sem alvo atual válido (`currentId` não está nos candidatos) → o de maior ameaça (empate: o mais perto);
 * - com alvo → só troca para quem passar de {@link THREAT_SWITCH_MELEE} × a ameaça do atual estando no corpo a corpo,
 *   ou de {@link THREAT_SWITCH_RANGED} × estando longe; entre os que passam, o de maior ameaça.
 * `null` se não há candidatos. Puro (sem estado), testado em `test/threat.test.ts`.
 */
export function chooseThreatTarget(candidates: readonly ThreatCandidate[], currentId: string | null): string | null {
  const current: ThreatCandidate | undefined = candidates.find((c) => c.id === currentId);
  let best: ThreatCandidate | null = null;
  for (const candidate of candidates) {
    if (current !== undefined && candidate.id !== current.id) {
      const ratio: number = candidate.melee ? THREAT_SWITCH_MELEE : THREAT_SWITCH_RANGED;
      if (!(candidate.threat > current.threat * ratio)) continue;
    } else if (current !== undefined) {
      continue;
    }
    if (best === null || candidate.threat > best.threat || (candidate.threat === best.threat && candidate.distance < best.distance)) {
      best = candidate;
    }
  }
  if (best !== null) return best.id;
  return current?.id ?? null;
}
