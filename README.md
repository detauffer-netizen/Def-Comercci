# Def Commerce

Plataforma SaaS multiempresa para lojistas criarem um catálogo digital, receberem
pedidos pelo WhatsApp e controlarem estoque, clientes e vendas em um painel.

- Site: https://def-commerce.detauffer.workers.dev
- Painel do lojista: https://def-commerce.detauffer.workers.dev/painel
- Vitrine de uma loja: `https://def-commerce.detauffer.workers.dev/loja/<endereco-da-loja>`

## Arquitetura

| Camada | Tecnologia |
| --- | --- |
| Backend e roteamento | Cloudflare Worker `def-commerce` (`src/`), JavaScript sem dependências em tempo de execução |
| Banco de dados | Cloudflare D1 `def-commerce-db` (SQLite), migrações em `migrations/` |
| Imagens | Cloudflare R2, binding `IMAGES` (opcional; sem ele o upload responde 503) |
| Páginas | Arquivos estáticos em `public/` servidos pelo binding `ASSETS` |

```
src/
  index.js            roteamento, cabeçalhos de segurança, páginas
  lib/                http, criptografia, sessão/limites/auditoria, validação, imagens
  routes/             auth.js (cadastro/login), public.js (vitrine/pedidos), panel.js (painel),
                      team.js (equipe e senha), admin.js (super administrador),
                      privacy.js (LGPD), reports.js (relatórios)
public/
  index.html          landing page
  painel.html         painel do lojista (SPA leve, sem framework)
  vitrine.html        vitrine pública de cada loja
  admin.html          super administrador da plataforma
  privacidade.html    Política de Privacidade · termos.html  Termos de Uso
  css/ js/            estilos e scripts (sem scripts inline: CSP estrita)
migrations/           esquema do D1, em ordem
test/                 testes de API (node:test + SQLite nativo) e E2E (Playwright)
docs/AUDITORIA.md     auditoria da Fase 1
```

Isolamento multiempresa: toda rota do painel usa o `store_id` obtido da sessão no
banco. O navegador nunca escolhe a loja. Arquivos no R2 ficam em
`stores/<store_id>/...`.

## Desenvolvimento

Requisitos: Node.js 22.5 ou mais recente.

```bash
npm test             # testes de API e integração (65 testes, D1 simulado com SQLite real)
npm run check        # sintaxe dos scripts e conformidade com a CSP
npm run test:e2e     # navegador real: cadastro → produto → vitrine → pedido → confirmação
node test/e2e/server.js   # sobe o sistema localmente em http://localhost:8787
```

Os testes não usam rede nem a conta Cloudflare. O E2E precisa do pacote
`playwright` com Chromium instalado.

## Publicação

Pré-requisito único (primeira publicação a partir deste repositório): registrar no
D1 de produção as migrações 0001–0006, que foram aplicadas manualmente:

```bash
npx wrangler d1 execute def-commerce-db --remote --file=scripts/bootstrap-d1-migrations.sql
```

Publicação manual:

```bash
npm run db:backup            # exporta o D1 para backups/
npm run db:migrate:remote    # aplica migrações pendentes
npm run deploy               # roda os testes e publica
```

Ou pelo GitHub Actions: workflow **Deploy** (manual), que testa, faz backup do D1,
migra, publica e verifica `/api/health`. Requer os segredos `CLOUDFLARE_API_TOKEN` e
`CLOUDFLARE_ACCOUNT_ID` no repositório.

Imagens: bucket R2 `def-commerce-images` (binding `IMAGES`, já configurado no
`wrangler.toml`).

## Super administrador

Página `/admin`. O administrador não pertence a nenhuma loja. Para criar o primeiro:

```bash
node scripts/create-admin.js voce@exemplo.com > /tmp/admin.sql   # pede a senha sem exibi-la
npx wrangler d1 execute def-commerce-db --remote --file=/tmp/admin.sql
rm /tmp/admin.sql
```

## Rollback

| O que voltar | Como |
| --- | --- |
| Código do Worker | `npx wrangler rollback` (volta à versão anterior) ou `npx wrangler versions list` + `npx wrangler rollback <versão>` |
| Banco D1 | Time Travel (até 30 dias): `npx wrangler d1 time-travel restore def-commerce-db --timestamp=<ISO>`; ou importar o backup `.sql` gerado antes do deploy |
| Código no GitHub | `git revert <commit>` |

As migrações são aditivas (só acrescentam colunas e tabelas), então o código
anterior continua funcionando com o esquema novo: é seguro voltar só o Worker.
Exceção: depois da 0009, se o Worker voltar para a versão 0.2, produtos que já
tiverem variações não poderão ser pedidos até a volta da versão nova.

## Documentação

- `CLAUDE.md` — contexto e regras para desenvolvimento assistido por IA
- `ROADMAP.md` — fases, estado e pendências
- `CHANGELOG.md` — histórico de mudanças
- `SECURITY.md` — modelo de segurança e como relatar vulnerabilidades
- `docs/AUDITORIA.md` — auditoria técnica da Fase 1
