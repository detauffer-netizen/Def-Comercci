# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.2.0] — 2026-11-27 — Fase 1: auditoria e recuperação

### Corrigido
- **Vitrine pública quebrada em produção:** erro de sintaxe no script impedia carregar produtos e fazer pedidos.
- Erros internos eram mascarados como 400; agora respondem 500 e são registrados nos logs.
- Exportação CSV vulnerável a injeção de fórmulas.
- Mensagem “Pedido copiado” da demonstração da landing nunca aparecia.
- Papel `staff` não conseguia acessar o painel.

### Segurança
- Content-Security-Policy estrita, `X-Frame-Options`, HSTS, `Referrer-Policy`, `Permissions-Policy`.
- Cookie de sessão com prefixo `__Host-`; sessões de 7 dias com limpeza das expiradas.
- Limite de tentativas de login também por conta.
- Corpo das requisições limitado a 64 KB e obrigatoriamente JSON.
- Formato de hash de senha versionado, com migração automática do formato anterior.
- Trilha de auditoria (`audit_log`) e histórico de estoque por gatilho (`stock_movements`).

### Adicionado
- Upload de fotos de produtos (até 8), logotipo e banner no Cloudflare R2, com compressão no navegador e validação no servidor.
- Produtos com descrição, SKU único por loja, preço promocional, destaque e visibilidade.
- Loja com descrição, logotipo, banner e status (ativa/suspensa).
- Pedidos com observações do comprador e código curto.
- Painel redesenhado: início com indicadores e primeiros passos, produtos, pedidos com filtros e ações, clientes com WhatsApp, configurações da loja, histórico de estoque e registro de atividades.
- Vitrine redesenhada: banner e logotipo, categorias, destaques, galeria de fotos, carrinho persistente, checkout com observações, compartilhamento.
- Cadastro já autentica o lojista; sugestão automática do endereço da loja.
- Testes: 31 de API/integração (`npm test`), verificação de CSP (`npm run check`) e 11 verificações E2E em navegador (`npm run test:e2e`).
- `wrangler.toml`, `package.json`, CI e workflow de publicação com backup do D1, migrações e verificação de saúde.
- Documentação: README, CLAUDE.md, ROADMAP.md, SECURITY.md, docs/AUDITORIA.md, .env.example.

### Alterado
- Código dividido em módulos (`src/`) e páginas estáticas (`public/`), substituindo o `worker.js` único.
- Migrações 0007 e 0008 (somente aditivas).

## [0.1.0] — até 27/11/2026
- Versão inicial em um único `worker.js`: cadastro, login, produtos, vitrine, carrinho, pedidos pelo WhatsApp, estoque por gatilhos, clientes, métricas, CSV, limite de requisições e landing com demonstrações.
