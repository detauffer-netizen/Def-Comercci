# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.5.0] — 2026-11-27 — Página de produto, avisos de pedidos e nova landing

### Adicionado
- **Página própria para cada produto** (`/loja/<loja>/p/<id>`): título com preço, descrição, imagem do produto na prévia de compartilhamento e dados estruturados `Product` (preço, faixa de preço com variações, disponibilidade). O botão compartilhar da vitrine usa esse endereço, e o sitemap inclui os produtos ativos.
- **Aviso de pedidos novos no painel**: consulta a cada 30 segundos (e ao voltar para a aba), aviso na tela, contador de pendentes no título da aba e alerta opcional do navegador.
- **Nova landing page**: proposta clara, passo a passo, recursos, comparação, segurança e LGPD, preço do beta e dúvidas frequentes, com menu para celular.
- 6 testes de API novos (71 no total) e 2 verificações E2E novas (22 no total).

### Removido
- Demonstrações simuladas da landing antiga (painel local e "IA" simulada).

## [0.4.0] — 2026-11-27 — LGPD, SEO da vitrine e relatórios

### Adicionado
- **Relatórios por período** (7, 30 ou 90 dias) no início do painel: vendas por dia em gráfico com dica no mouse, no toque e no teclado, tabela equivalente, comparação com o período anterior e produtos mais vendidos.
- **LGPD:** páginas de Política de Privacidade e Termos de Uso; exportação de todos os dados da loja em JSON; exclusão definitiva da loja (produtos, fotos, pedidos, clientes, equipe e registros); anonimização de um comprador mantendo os valores nos relatórios. Links no cadastro, na landing e na vitrine.
- **SEO da vitrine:** título, descrição, cor do navegador, Open Graph, canonical e dados estruturados (schema.org Store) gerados no servidor para cada loja; `sitemap.xml` com as lojas ativas que têm produtos; `robots.txt` dinâmico.
- 10 testes de API novos (65 no total) e 5 verificações E2E novas (20 no total).

### Alterado
- Vitrine de loja inexistente ou suspensa responde com status 404 e `noindex`.

## [0.3.0] — 2026-11-27 — Variações, equipe e super administrador

### Adicionado
- **Variações de produto** (tamanho, cor, modelo) com SKU, preço e estoque próprios, gerador de combinações no painel e escolha da opção na vitrine. O estoque do produto passa a ser a soma das variações.
- **Equipe**: o proprietário adiciona funcionários com permissões por área (produtos e estoque, pedidos, clientes, indicadores). A senha provisória precisa ser trocada no primeiro acesso. Remover alguém encerra as sessões na hora.
- **Troca de senha** para todos os usuários, encerrando as outras sessões abertas.
- **Super administrador** (`/admin`): visão geral da plataforma, lojas com busca e indicadores, suspensão com motivo e reativação, registro de operações. Isolado do painel dos lojistas.
- Script `scripts/create-admin.js` para criar administradores sem expor a senha.
- Migração 0009: tabelas `product_variants` e `platform_admins`, colunas de equipe e gatilhos de estoque atualizados.
- 24 testes de API novos (55 no total) e 3 fluxos E2E novos (15 verificações).

### Corrigido
- Rodapés de diálogos podiam transbordar em celulares de 375 px.
- O painel de um funcionário com senha provisória tentava carregar dados antes da troca obrigatória.

### Segurança
- Controle de acesso por rota (público, membro, permissão, proprietário, administrador).

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
- Testes: 31 de API/integração (`npm test`), verificação de CSP (`npm run check`) e 12 verificações E2E em navegador (`npm run test:e2e`).
- `wrangler.toml`, `package.json`, CI e workflow de publicação com backup do D1, migrações e verificação de saúde.
- Documentação: README, CLAUDE.md, ROADMAP.md, SECURITY.md, docs/AUDITORIA.md, .env.example.

### Alterado
- Código dividido em módulos (`src/`) e páginas estáticas (`public/`), substituindo o `worker.js` único.
- Migrações 0007 e 0008 (somente aditivas).

## [0.1.0] — até 27/11/2026
- Versão inicial em um único `worker.js`: cadastro, login, produtos, vitrine, carrinho, pedidos pelo WhatsApp, estoque por gatilhos, clientes, métricas, CSV, limite de requisições e landing com demonstrações.
