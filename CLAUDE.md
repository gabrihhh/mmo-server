# mmo-server — Servidor multiplayer (Node.js + TypeScript + Colyseus 0.18)

Parte do MMO isométrico 3D low poly para **Android/iOS**. Repositórios irmãos em `../`:
`mmo-client` (Godot), `mmo-docs` (documentação central).

## Documentação central (ler antes de decidir algo)

Toda decisão de design/arquitetura vive em `../mmo-docs`. Siga o protocolo de busca de lá:
leia `../mmo-docs/INDICE.md` e depois `../mmo-docs/tools/secao.sh <ID>`. Não abra os arquivos de `docs/` inteiros.
Seções-chave deste repo: [INFRA-02] servidor, [INFRA-04] protocolo de rede, [INFRA-05] estrutura do servidor.

## Regras OBRIGATÓRIAS

### 1. Tipagem forte
- `tsconfig.json` é estrito (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). **Nunca afrouxar flags.**
- Proibido `any`, `@ts-ignore`, `@ts-expect-error` e `as` para silenciar o compilador.
- Dado vindo da rede é `unknown` e passa por um parser/validador tipado (ver `src/rooms/messages.ts`).
- Todo export tem tipo explícito de retorno e de parâmetros.

### 2. Documentação no código
- Todo export (classe, função, constante, tipo, campo de schema) tem comentário TSDoc `/** ... */` dizendo **o quê** e, quando não óbvio, **por quê**.
- Unidades sempre explícitas (metros, radianos, Hz).
- Contratos compartilhados com o cliente levam um aviso `ATENÇÃO:` apontando o arquivo espelho no `mmo-client`.

### 3. Toda alteração atualiza a documentação
- Mudou comportamento → atualize o TSDoc **e** a seção correspondente no `mmo-docs`.
- Não existe seção → crie uma (seguindo `../mmo-docs/CLAUDE.md`) e registre no `INDICE.md`.
- Removeu algo → remova/atualize a doc no código e no `mmo-docs` no mesmo passo. Documentação desatualizada é bug.
- Mudou schema (`src/rooms/schema/`) ou mensagem (`src/rooms/messages.ts`) → atualize também
  `mmo-client/scripts/network/zone_schema.gd` / `network.gd` e [INFRA-04].

### 4. Verificação antes de concluir
`npm run typecheck && npm test` precisam passar. Código novo de room/mensagem vem com teste em `test/`.

## Comandos

```bash
nvm use            # Node 22 (.nvmrc) — Colyseus 0.18 exige Node >= 22
npm install
npm start          # dev com hot reload em ws://localhost:2567 (playground em http://localhost:2567)
npm run typecheck
npm test
```

Código e identificadores em inglês; comentários e docs em português.
