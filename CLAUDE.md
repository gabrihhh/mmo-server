# mmo-server — Servidor multiplayer (Node.js + TypeScript + ws, servidor próprio)

Parte do MMO isométrico 3D low poly para **Android/iOS**. Repositórios irmãos em `../`:
`mmo-client` (Godot), `mmo-docs` (documentação central).

## Documentação central (ler antes de decidir algo)

Toda decisão de design/arquitetura vive em `../mmo-docs`. Siga o protocolo de busca de lá:
leia `../mmo-docs/INDICE.md` e depois `../mmo-docs/tools/secao.sh <ID>`. Não abra os arquivos de `docs/` inteiros.
Seções-chave deste repo: [INFRA-02] servidor, [INFRA-03] banco, [INFRA-04] protocolo de rede, [INFRA-05] estrutura do servidor,
[INFRA-07] contas (username/e-mail/senha), [INFRA-09] modelo autoritativo (predição/reconciliação).

## Regras OBRIGATÓRIAS

### 1. Tipagem forte
- `tsconfig.json` é estrito (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). **Nunca afrouxar flags.**
- Proibido `any`, `@ts-ignore`, `@ts-expect-error` e `as` para silenciar o compilador.
- Dado vindo da rede é `unknown` e passa por um parser/validador tipado (ver `parseClientMessage` em `src/net/protocol.ts`).
- Todo export tem tipo explícito de retorno e de parâmetros.

### 2. Documentação no código
- Todo export (classe, função, constante, tipo, campo de schema) tem comentário TSDoc `/** ... */` dizendo **o quê** e, quando não óbvio, **por quê**.
- Unidades sempre explícitas (metros, radianos, Hz).
- Contratos compartilhados com o cliente levam um aviso `ATENÇÃO:` apontando o arquivo espelho no `mmo-client`.

### 3. Toda alteração atualiza a documentação
- Mudou comportamento → atualize o TSDoc **e** a seção correspondente no `mmo-docs`.
- Não existe seção → crie uma (seguindo `../mmo-docs/CLAUDE.md`) e registre no `INDICE.md`.
- Removeu algo → remova/atualize a doc no código e no `mmo-docs` no mesmo passo. Documentação desatualizada é bug.
- Mudou o protocolo (`src/net/protocol.ts`) ou as zonas (`src/zones/zones.ts`) → atualize também
  `mmo-client/scripts/network/protocol.gd` / `network.gd` / `network_config.gd` e [INFRA-04].
- Mudou a simulação (`src/sim/movement.ts`) → mude `mmo-client/scripts/sim/movement.gd` com a MESMA conta e ordem,
  ajuste `test/movement.test.ts` e [INFRA-09].
- Itens/habilidades vivem em `src/items/catalog.ts` (fonte da verdade, [JOGO-03]). Slot ou tipo de mira novo →
  espelhe em `mmo-client/scripts/items/inventory_state.gd` / `scripts/combat/ability_view.gd` e [JOGO-04].

### 4. Servidor é a autoridade ([INFRA-09])
- O cliente manda intenção (`input`), nunca resultado (posição, dano, item). Toda regra de jogo roda aqui.

### 5. Verificação antes de concluir
`npm run typecheck && npm test` precisam passar. Código novo de zona/mensagem vem com teste em `test/`.

## Comandos

```bash
nvm use            # Node 22 (.nvmrc)
npm install
npm run db:up      # MongoDB local via Docker (o servidor não sobe sem ele) — ver [INFRA-03]
npm start          # dev com hot reload em ws://localhost:2567 (health em http://localhost:2567/health)
npm run typecheck
npm test
```

Código e identificadores em inglês; comentários e docs em português.
