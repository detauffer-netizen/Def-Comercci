# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [1.3.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 1: lucro e resumo inteligente

### Adicionado
- **Custo e dados de compra no produto** (opcionais, recolhidos em "Custo, alerta de reposição e mais detalhes"): preço de custo, alerta de reposição (estoque mínimo, padrão 3), código de barras, fornecedor e localização na loja. Cálculo ao vivo de lucro por unidade, **margem** (sobre a venda) e **markup** (sobre o custo).
- **Custo histórico:** cada item de pedido guarda o custo do momento da venda; mudar o custo depois não altera relatórios antigos. O custo nunca é enviado ao comprador nem aparece na lista de pedidos.
- **Resumo da loja** na tela inicial (`GET /api/dashboard`, permissão de indicadores): faturamento, lucro bruto estimado (só sobre itens com custo, com a cobertura indicada), vendas, ticket médio, pedidos pendentes, estoque baixo, valor investido em estoque e valor de venda do estoque, com comparação com o período anterior. Períodos: hoje, ontem, 7 dias, 30 dias e datas escolhidas (até 1 ano).
- **"O que fazer agora":** recomendações calculadas no banco (sem IA) e clicáveis: pedidos aguardando, itens para repor (filtro "Preciso repor"), produto que concentra as vendas, produtos sem vendas em 30 dias, produtos sem custo e carrinhos abandonados.
- Edições feitas por versões antigas do painel não apagam os campos novos.
- Migração 0017; 7 testes de API novos (134 no total) e E2E ampliado (29 verificações).

## [1.2.0-beta] — 2026-11-27 — Recuperação de carrinho abandonado

### Adicionado
- **Autorização no carrinho** (desmarcada por padrão): "Se eu não finalizar, a loja pode me chamar no WhatsApp sobre este carrinho". Sem ela, nada é enviado ao servidor.
- Com a autorização, o carrinho (nome, telefone e itens com preços do banco) é guardado e atualizado enquanto o comprador monta o pedido; desmarcar apaga na hora.
- **Pedidos → Carrinhos abandonados** (permissão de pedidos): carrinhos parados há mais de 30 minutos, com botão "Chamar no WhatsApp" (mensagem pronta com os itens e o total) e "Descartar" (apaga os dados).
- Ao finalizar o pedido, o carrinho é apagado; se a loja já tinha chamado o comprador, fica só a contagem de "recuperados", sem dados pessoais.
- Retenção de 7 dias; incluído na exportação de dados, na exclusão da loja e na anonimização do cliente. Política de Privacidade atualizada (base legal: consentimento).
- Migração 0016; 7 testes de API novos (127 no total) e 1 verificação E2E nova (29 no total).

## [1.1.0-beta] — 2026-11-27 — Planos e pagamentos com Mercado Pago

### Adicionado
- **Planos** (migração 0015) com preço, dias de teste grátis e limites de produtos, equipe e usos de IA por dia. O plano padrão "Beta gratuito" (sem limites) continua valendo para todas as lojas. Nenhum preço comercial foi definido.
- **Assinatura no cartão** (assinatura recorrente do Mercado Pago) e **pagamento de 1 mês por Pix ou cartão** (Checkout Pro), com redirecionamento para o Mercado Pago.
- **Webhook** `/api/billing/webhook/mercadopago`: assinatura `x-signature` validada (HMAC-SHA256, janela de 24 h), idempotente por `x-request-id` e consulta do recurso na API antes de agir; o valor pago é conferido com o preço do plano.
- **Carência de 7 dias** após o vencimento; depois a loja volta ao plano gratuito (nenhum dado é apagado).
- **Limites aplicados no servidor** (402) ao criar produtos, adicionar pessoas na equipe e usar a IA.
- Painel: card "Plano e assinatura" em Minha loja (plano atual, uso, opções, cancelamento da renovação e histórico).
- Administração: receita recorrente, pagantes, em teste, recebido em 30 dias, inadimplentes, cadastro e edição de planos e definição manual do plano de uma loja (cortesia, sem cobrança).
- A exclusão da loja cancela a assinatura no Mercado Pago.
- 13 testes de API novos (120 no total, com Mercado Pago simulado) e 1 verificação E2E nova.

### Segurança
- A cobrança fica **desligada** (`BILLING_ENABLED="false"`) até o proprietário configurar `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` e autorizar a ativação.

## [1.0.0-beta] — 2026-11-27 — Inteligência artificial com Workers AI

### Adicionado
- **Cadastro por mensagem**: o lojista descreve o produto como falaria no WhatsApp e a IA preenche nome, descrição, categoria, preço (só se informado) e opções.
- **Cadastro por foto**: a IA analisa a foto e sugere nome, descrição e categoria; a foto também entra nas fotos do produto. O preço nunca é deduzido da imagem.
- **Melhorar título e descrição** de produtos existentes.
- **Assistente de divulgação**: textos para WhatsApp e Instagram e ideias, usando apenas produtos e preços reais da loja.
- Todas as sugestões preenchem o formulário com destaque e aviso para revisão; nada é salvo automaticamente.
- **Limite diário por loja** (`AI_DAILY_LIMIT`, padrão 30) e consumo de IA na administração (hoje e 30 dias).
- Binding `AI` no `wrangler.toml`; migração 0014; Política de Privacidade atualizada; pergunta frequente sobre IA na landing.
- 9 testes de API novos (107 no total, com modelo simulado) e 1 fluxo E2E novo (28 verificações).

### Removido
- Nada mais é simulado como IA na interface: as demonstrações antigas já haviam sido removidas.

## [0.9.0] — 2026-11-27 — Ordem das categorias e catálogo em PDF

### Adicionado
- **Ordem das categorias**: em Produtos, o lojista define a ordem das categorias exibidas na vitrine e no catálogo.
- **Catálogo para imprimir ou salvar em PDF** (`/loja/<loja>/catalogo`, sem indexação): folha A4 com logotipo, produtos por categoria, fotos, preços, opções, esgotados, WhatsApp e endereço da vitrine. Link em "Minha loja".
- Migração 0013; 2 testes de API novos (98 no total) e 1 verificação E2E nova (27 no total).

## [0.8.0] — 2026-11-27 — Verificação em duas etapas e capa das fotos

### Adicionado
- **Verificação em duas etapas (2FA)** para lojistas, equipe e super administradores, com aplicativo autenticador (TOTP, RFC 6238): ativação com senha e código, 8 códigos de recuperação de uso único, login em duas etapas (senha correta não cria sessão sem o código), desafio de login de 5 minutos com no máximo 5 tentativas, recusa de código já usado, e encerramento das outras sessões ao ativar.
- **Capa do produto**: botão "Usar como capa" nas fotos do produto.
- Migração 0012; 9 testes de API novos (96 no total) e 1 fluxo E2E novo (26 verificações).

### Segurança
- Campos do 2FA usam o rótulo visível como nome acessível.

## [0.7.0] — 2026-11-27 — Entrega e retirada, ordem da vitrine e impressão

### Adicionado
- **Entrega e retirada**: em "Minha loja", o lojista ativa a retirada na loja e/ou a entrega com taxa e frete grátis a partir de um valor. No carrinho, o cliente escolhe como quer receber; na entrega, o endereço é obrigatório. A taxa é calculada no servidor (o frete grátis considera o valor já com desconto) e aparece na mensagem do WhatsApp e no pedido. Sem opções ativas, tudo continua "a combinar", como antes.
- **Ordem dos produtos na vitrine**: campo "Ordem na vitrine" no produto; destaques continuam no topo.
- **Impressão do pedido**: botão "Imprimir" em cada pedido imprime só aquele pedido, com o nome da loja.
- Migração 0011; 7 testes de API novos (87 no total) e 1 fluxo E2E novo (25 verificações).

### Corrigido
- Mensagens de erro do checkout da vitrine apareciam sem destaque.

## [0.6.0] — 2026-11-27 — Cupons, painel instalável e monitoramento de erros

### Adicionado
- **Cupons de desconto**: o proprietário cria cupons em porcentagem (até 90%) ou valor fixo, com pedido mínimo, validade e limite de usos, e pode pausar ou excluir. Na vitrine, o cliente aplica o cupom no carrinho; o desconto é calculado no servidor, aparece na mensagem do WhatsApp e no pedido do painel. O limite de usos é respeitado mesmo com pedidos simultâneos.
- **Painel instalável (PWA)**: manifesto, ícones, atalhos para Pedidos e Produtos, botão "Instalar app" e service worker que abre o painel sem internet com aviso de conexão. Respostas da API nunca ficam em cache.
- **Monitoramento de erros**: erros inesperados do servidor são registrados (sem dados pessoais; números longos são mascarados) e aparecem agrupados no painel do administrador.
- Pedidos guardam subtotal, desconto e cupom; exportação CSV e de dados incluem essas informações.
- Migração 0010; 9 testes de API novos (80 no total) e 2 verificações E2E novas (24 no total).

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
