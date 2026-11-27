# CLAUDE.md — Def Commerce

Memória persistente do projeto para sessões de desenvolvimento assistido.
Leia este arquivo e o `ROADMAP.md` antes de reanalisar o código.

## Produto

SaaS multiempresa para lojistas brasileiros: catálogo digital, pedidos pelo
WhatsApp, estoque, clientes e indicadores. Interface e mensagens em português do
Brasil. Identidade: azul (`#2563eb`, navy `#0b1f3a`) e laranja (`#ff7a00`).

## Infraestrutura

- Conta Cloudflare: a que hospeda `def-commerce.detauffer.workers.dev`. A conta tem outros
  projetos (ex.: buckets `app-social-resumo-arquivos`, `social-em-resumo-teste-pdfs`): **não altere nada fora do Def Commerce.**
- Worker `def-commerce` · D1 `def-commerce-db` (`0c35664f-97c3-4687-9861-0f1a7115207f`) · R2 `def-commerce-images` (binding `IMAGES`).
- Repositório: `detauffer-netizen/Def-Comercci`.

## Comandos

```bash
npm test            # API + integração (node:test, D1 simulado com node:sqlite)
npm run check       # sintaxe JS e ausência de scripts inline (CSP)
npm run test:e2e    # Playwright: fluxo completo em celular e desktop
```

Rode os três antes de cada commit que toque código.

## Regras de arquitetura

1. **Isolamento:** toda consulta do painel filtra por `session.store.id`. Nunca aceite `store_id` do cliente.
2. **Preços e totais** sempre calculados no servidor a partir do banco.
3. **Estoque** só muda por `PATCH /api/products/:id` ou pelos gatilhos de pedidos (`migrations/0005_stock.sql`). Os gatilhos garantem atomicidade, impedem estoque negativo e baixa duplicada.
4. **Validação** de toda entrada em `src/lib/validate.js`. SQL apenas com `prepare().bind()`.
5. **Frontend sem `innerHTML` com dados**: use `h()` de `public/js/common.js` (texto via `textContent`).
6. **CSP estrita**: nada de `<script>` inline nem `onclick=` no HTML.
7. **Migrações** apenas aditivas e numeradas (`0009_...sql`). Código antigo deve continuar funcionando com o esquema novo (rollback seguro).
8. **Acesso por rota** é declarado em `ROUTES` (`src/index.js`): `public`, `session`, uma permissão (`products`, `orders`, `customers`, `reports`), `owner` ou `admin`. Toda rota nova precisa declarar o seu.
9. **Variações:** o estoque de um produto com variações é a soma delas (gatilhos `variant_stock_sync_*`); nunca grave `products.stock` diretamente nesse caso. Itens de pedido podem ter `variant_id`.
10. **Super administrador** só via `platform_admins` + rotas `/api/admin/*`; nunca misture com `memberships`.
11. Erros esperados: `throw new HttpError(status, "mensagem em português")`. Erros inesperados viram 500 genérico + `console.error`.
12. Não exponha segredos; eles vão em `wrangler secret put`, nunca no repositório.
13. Não ative cobrança, serviços pagos ou preços definitivos sem autorização do proprietário.

## Estado atual (resumo)

Fase 1 concluída. Fases 2, 3, 5, 6, 8 e 9 parciais (variações, equipe e super
administrador entregues na versão 0.3.0). Detalhes e
próximos passos em `ROADMAP.md`. Defeitos encontrados em `docs/AUDITORIA.md`.

## Particularidades

- As migrações 0001–0006 foram aplicadas manualmente em produção. Antes do primeiro
  `wrangler d1 migrations apply --remote`, execute `scripts/bootstrap-d1-migrations.sql`.
- Imagens: o navegador comprime para WebP (máx. 1600 px) antes do upload; o servidor
  valida os bytes iniciais (JPEG/PNG/WebP), limita a 2 MB e grava em `stores/<store_id>/...`.
- `test/helpers/env.js` implementa o subconjunto da API do D1 usado pelo código. Se
  passar a usar outro método do D1, implemente-o lá também.
