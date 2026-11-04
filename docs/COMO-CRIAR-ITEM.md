# Como criar um item

Guia prático. As regras do jogo ficam no mmo-docs: [JOGO-01] equipamento → habilidades, [JOGO-03] números do
kit de treino, [JOGO-04] inventário, [JOGO-06] habilidades no servidor.

## Ideia principal

**O item é a fonte das habilidades.** Cada item no catálogo carrega as próprias habilidades; o slot só diz onde
ele é vestido. Quem veste o Capuz ganha a carta "Cura"; tirou o Capuz, a carta some e o servidor recusa o `cast`.

Tudo mora em **um arquivo**: `src/items/catalog.ts` (fonte da verdade). O cliente **não precisa mudar** para um
item novo: nome, slot e habilidades chegam pela mensagem `inventory`.

## Passo a passo

### 1. Escolha o slot e quantas habilidades ele dá

| Slot | `slot` | Habilidades (`ABILITIES_PER_SLOT`) | Ataque simples |
|---|---|---|---|
| Mão (arma) | `"hand"` | 3 | sim (`basicAttack`) |
| Cabeça | `"head"` | 1 | não (`null`) |
| Peito | `"chest"` | 1 | não (`null`) |
| Pés | `"feet"` | 1 | não (`null`) |

O número de habilidades tem que bater com o slot; o `test/inventory.test.ts` confere.

### 2. Escolha a mira de cada habilidade (`aim`)

| `aim` | Como o jogador usa | Campos que importam |
|---|---|---|
| `"target"` | toca: usa no alvo fixo | `range` |
| `"direction"` | arrasta: linha na direção | `range`, `radius` (meia-largura da linha) |
| `"area"` | arrasta: círculo num ponto | `range`, `radius` |
| `"area_self"` | toca: círculo ao redor de si | `radius` |
| `"self"` | toca: em si mesmo (cura, escudo, velocidade) | — |

### 3. Escolha o efeito (campos de `AbilityDef`; o que não usar fica 0)

- `damage` — dano por alvo atingido.
- `heal` — vida recuperada (só `"self"`).
- `shield` + `shieldSeconds` — escudo que absorve dano.
- `dashDistance` — investida (desloca em metros, [JOGO-07]).
- `speedMultiplier` + `speedSeconds` — corrida (multiplica a velocidade, [JOGO-07]).
- Sempre: `cooldown` (s), `castTime` (s, 0 = instantânea), `manaCost`.
- `available: false` — a carta aparece, mas o servidor responde "disponível em breve" (útil para rascunho).

### 4. Escreva o item em `ITEMS`

```ts
iron_helmet: {
  id: "iron_helmet",            // igual à chave; nunca mude depois (fica salvo no banco)
  name: "Elmo de ferro",        // nome exibido
  description: "Elmo simples de ferro.",  // frase da ficha do item no inventário
  set: "Cavaleiro",             // conjunto: agrupa e dá a cor da moldura no cliente
  slot: "head",
  basicAttack: null,            // só armas têm
  abilities: [
    ability({ id: "iron_skin", title: "Pele de ferro", description: "Escudo curto.", aim: "self", cooldown: 20, castTime: 0.3, manaCost: 15, shield: 40, shieldSeconds: 5 }),
  ],
},
```

Arma (3 habilidades + ataque simples):

```ts
training_axe: {
  id: "training_axe",
  name: "Machado de treino",
  description: "Machado pesado de lenhador.",
  set: "Treino",
  slot: "hand",
  basicAttack: ability({ id: "axe_attack", title: "Ataque", aim: "target", range: 2.5, cooldown: 1.3, castTime: 1.3, damage: 13 }),
  abilities: [
    ability({ id: "cleave", title: "Talho", aim: "area_self", radius: 2.5, cooldown: 8, castTime: 0.5, manaCost: 15, damage: 18 }),
    ability({ id: "throw_axe", title: "Arremesso", aim: "direction", range: 9, radius: 0.5, cooldown: 6, castTime: 0.4, manaCost: 12, damage: 16 }),
    ability({ id: "execute", title: "Execução", aim: "target", range: 2.5, cooldown: 14, castTime: 0.8, manaCost: 25, damage: 35 }),
  ],
},
```

### Regras de nomes (importante)

- **`id` do item e `id` da habilidade são para sempre.** O banco guarda o `id` do item; se ele sumir do catálogo,
  o item some do inventário de quem tinha ([JOGO-04], `readInventory`).
- **`id` de habilidade é único no jogo inteiro.** O servidor indexa as habilidades vestidas por `id` e o cliente
  guarda a recarga por `id`: dois itens com a mesma habilidade compartilhariam a recarga.
- Identificadores em inglês, `snake_case`; `name`/`title` em português.

### 5. Coloque o item nas mãos de alguém (para testar)

Ainda **não existe** loja, drop nem comando de admin. Hoje o único jeito é o kit inicial:

- Adicione o `id` em `STARTER_BAG`: a conta nova nasce **pelada** e com tudo isso na mochila ([JOGO-04]).
- Para contas que **já existem** receberem também: crie um presente novo em `GRANTS` (ex.: `sets_v2: ["iron_helmet"]`).
  Cada conta recebe uma vez, no fim da mochila, o que ainda não tem. Nunca reaproveite nem mude um id de presente.

### 6. Atualize a documentação e verifique

- Números do item na tabela de [JOGO-03] (mmo-docs).
- **Ícones** (pixel art 48×48): `mmo-client/assets/icons/items/<itemId>.png` e
  `mmo-client/assets/icons/abilities/<abilityId>.png` — como gerar em [MESHY-07]. Sem ícone, o inventário e a carta
  mostram só a moldura e o nome.
- `npm run typecheck && npm test`.

## Quando precisa de mais do que o catálogo

| Quero... | Precisa mexer em |
|---|---|
| Efeito novo (veneno, atordoar, puxar...) | `src/zones/Zone.ts` (aplicar o efeito) + teste em `test/` + cliente (visual) + [JOGO-06] |
| Mira nova | `AimType` aqui + `mmo-client/scripts/combat/ability_view.gd` + prévia no cliente |
| Slot novo (ex.: anel) | `EQUIP_SLOTS` / `ABILITIES_PER_SLOT` + `mmo-client/scripts/items/inventory_state.gd` + HUD + [JOGO-01] |
| Ver o item no boneco | gere o modelo ([ART-02]) e ligue itemId → `.glb` em `mmo-client/scripts/items/item_models.gd` |
