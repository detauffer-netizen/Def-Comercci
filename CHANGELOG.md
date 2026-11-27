# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [1.10.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 7: Divulgação

### Adicionado
- **Menu Divulgação** no painel (permissão de produtos), reunindo arte de oferta, QR Codes e o assistente de textos com IA (que saiu de "Minha loja").
- **Arte de oferta** gerada no próprio navegador (sem custo): escolha o produto, o formato — **Feed 4:5 (1080 × 1350)**, **Status 9:16 (1080 × 1920)** ou **Quadrado (1080 × 1080)** — e o estilo (Oferta, Novidade, Minimalista). Usa a foto, o nome, o preço e a cor da loja; "de/por" e o selo de desconto só aparecem quando há promoção cadastrada. Chamada e texto do botão editáveis, QR Code do produto opcional. Baixar em PNG ou compartilhar direto (celulares compatíveis).
- **QR Codes** da vitrine, de um produto ou de uma categoria: prévia, download em PNG (1024 px) e **cartaz para imprimir** ("Aponte a câmera do celular...").
- A vitrine abre direto numa categoria com `?categoria=` (links de QR Code e campanhas).

### Corrigido
- O editor de horário em "Minha loja" já aparece antes de a tela carregar, evitando que a página "pule" enquanto o lojista usa o formulário.

### Técnico
- `public/js/qrcode.js`: gerador de QR Code (ISO/IEC 18004, modo byte, correção M, versões 1–20) sem dependências, validado nos testes por um decodificador independente (`jsqr`, só em desenvolvimento). Cache do painel `def-painel-v4`.
- 2 testes novos (162 no total) e 1 fluxo E2E novo (36 verificações; a checagem de 320 px inclui Divulgação).

## [1.9.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 6: vitrine premium

### Adicionado
- **Modelos de vitrine por segmento** (Minha loja → Aparência): Comércio geral, Roupas e moda, Cosméticos e beleza, Eletrônicos, Utilidades e casa, Ferramentas e materiais, Móveis e decoração. Mesma estrutura, apresentação diferente (proporção e enquadramento das fotos, cantos, tipografia, colunas). Botão **Ver prévia** abre a vitrine com o modelo escolhido antes de salvar.
- **Aviso no topo da vitrine** (ex.: "Frete grátis acima de R$ 150").
- **Horário de funcionamento** por dia da semana: a vitrine mostra "Aberto agora · fecha às 18:00" ou quando a loja abre (horário de Brasília).
- **Filtros e ordenação na vitrine**: Ofertas, Novidades (cadastrados nos últimos 30 dias, com selo "Novo"), Favoritos, faixa de preço e ordenar por menor/maior preço, novidades ou nome. Esgotados vão para o fim.
- **Favoritos** (coração nos produtos), guardados só no aparelho do cliente.
- **Você também pode gostar**: produtos relacionados (mesma categoria ou destaques) na página do produto.
- **Acompanhamento do pedido** (`/pedido/<código secreto>`): o link vai na mensagem do WhatsApp; mostra status, itens e total, com o primeiro nome apenas — nunca telefone, endereço ou observações. Página não indexada e sem repassar o endereço (`Referrer-Policy: no-referrer`).

### Corrigido
- Em "Minha loja", o carregamento da tela podia sobrescrever o que o lojista começava a digitar antes de terminar de carregar.

### Técnico
- Migração 0021 (`stores.template`, `hours_json`, `announcement`; `orders.public_token` com índice único). Rota pública `GET /api/order-status/:token` com limite por IP.
- 3 testes de API novos (160 no total) e 1 fluxo E2E novo (35 verificações).

## [1.8.0-beta] — 2026-11-27 — Pendências: etiquetas, várias fotos e telas estreitas

### Adicionado
- **Etiquetas com código de barras** (Produtos → Editar vários → Imprimir etiquetas): nome, preço e código de barras (Code 128, lido por leitores comuns) a partir do código de barras ou do SKU; quantidade por item ou uma por unidade em estoque; variações com SKU próprio. Folha A4 com 3 colunas (63,5 × 38,1 mm, 21 por folha, padrão das etiquetas adesivas mais comuns).
- **Cadastro por várias fotos** (até 10 de uma vez, dentro do limite diário de IA): cada foto vira um rascunho com nome, descrição e categoria sugeridos; o lojista informa preço e estoque e salva todos de uma vez, com a foto já no produto. Sem preço, nada é salvo.

### Corrigido
- Vitrine e painel sem rolagem lateral até 280 px de largura (busca da vitrine e itens da lista de produtos podiam passar da tela em celulares muito estreitos).

### Técnico
- `public/js/barcode.js` (gerador Code 128 em SVG, sem dependências) com testes de decodificação e dígito verificador; cache do painel `def-painel-v3`.
- 3 testes de API novos (157 no total) e 1 fluxo E2E novo (34 verificações).

## [1.7.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 5: cadastro inteligente

### Adicionado
- **Exportar planilha** de produtos (CSV com ";" para Excel/Planilhas, cabeçalho em português) e **Importar planilha**: prévia antes de gravar ("X novos, Y atualizados"), atualização pelo SKU, estoque em branco mantém o atual, erros apontados por linha e nada gravado se houver erro. Modelo para baixar. Até 500 produtos por vez, respeitando o limite do plano.
- **Editar vários**: seleção de produtos na lista para mudar categoria, definir fornecedor, ocultar/mostrar na vitrine ou **reajustar preços em %** (inclui variações com preço próprio e promoções).
- **Duplicar produto**: abre um novo cadastro com os dados do produto (sem SKU, código de barras, fotos e estoque).
- **Ler código de barras pela câmera** no PDV e no campo "Código de barras" (navegadores com leitor nativo, como o Chrome no Android). O site passa a permitir a câmera somente para si mesmo (`Permissions-Policy: camera=(self)`).
- **IA entende custo e quantidade**: "Comprei 20 garrafas por R$ 25 cada. Quero vender por R$ 49,90." preenche preço, custo, estoque e mostra a margem para revisão. Pela foto, preço, custo e quantidade nunca são deduzidos.

### Técnico
- Rotas `POST /api/products/import` e `POST /api/products/bulk` (permissão de produtos).
- `ApiError` no navegador passa a carregar o corpo da resposta (`error.data`).
- 3 testes de API novos e 1 atualizado (154 no total) e 1 fluxo E2E novo (33 verificações).

## [1.6.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 4: estoque avançado

### Adicionado
- **Movimentar estoque** (Produtos): **Entrada** de mercadoria (com custo por unidade e fornecedor; o custo do produto é atualizado pela média ponderada), **Perda** (avaria, vencimento, extravio) e **Inventário** (informe a quantidade contada; o sistema ajusta a diferença). Funciona com variações.
- **Preciso repor**: lista dos itens no alerta de reposição ou abaixo, já descontado o que está **reservado** em pedidos pendentes, agrupada por fornecedor, com quantidade sugerida editável, custo estimado e botões **Enviar ao fornecedor** (WhatsApp), Compartilhar e Copiar lista. Inclui produtos ocultos da vitrine (vendidos no balcão).
- **Fornecedores**: cadastro com WhatsApp; renomear atualiza os produtos ligados. A primeira entrada com fornecedor liga o produto a ele.
- Histórico de estoque mostra as entradas, perdas e inventários com observação.

### Técnico
- Migração 0020 (`suppliers`, `stock_adjustments` e os gatilhos `stock_adjustment_guard`/`stock_adjustment_apply`): o estoque muda na mesma instrução do registro; o CHECK de estoque ≥ 0 desfaz qualquer movimentação que deixaria o saldo negativo. O inventário calcula a diferença no próprio banco.
- Rotas (permissão de produtos): `GET/POST /api/stock-adjustments`, `GET /api/restock`, `GET/POST/PATCH/DELETE /api/suppliers`.
- 4 testes de API novos (150 no total) e 1 fluxo E2E novo (32 verificações).

## [1.5.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 3: financeiro

### Adicionado
- **Contas a receber** (Vendas → "A receber"): lista das vendas a prazo em aberto, baixa parcial ou total com a forma de pagamento e lembrete pronto pelo WhatsApp. A baixa é atômica: nunca passa do saldo, nem com dois cliques ao mesmo tempo.
- **Devoluções** de vendas concluídas (balcão ou catálogo), parciais ou totais: escolha das quantidades, opção de devolver ao estoque (ou não, se o item veio avariado) e motivo. O banco garante que nunca se devolve mais do que foi vendido. O desconto da venda é rateado; numa venda a prazo, a devolução abate primeiro o valor a receber.
- **Despesas** (Início): registro com descrição, categoria, valor e data; lista e total do período.
- **Resumo:** faturamento já descontadas as devoluções, lucro bruto descontando devoluções, **resultado estimado** (lucro bruto − despesas), **a receber** e valor do estoque a preço de venda.
- **Calculadora de preço de venda** no cadastro: custo, taxas, despesas variáveis e margem desejada → preço sugerido e markup equivalente; "Usar este preço" preenche o campo para revisão.
- Exportação de dados e exclusão da loja incluem devoluções, recebimentos e despesas.

### Técnico
- Migração 0019 (`receivable_payments`, `expenses`, `order_returns` e os gatilhos `order_return_guard`/`order_return_restock`). Rotas: `GET/POST /api/receivables`, `POST /api/orders/:id/returns` (pedidos) e `GET/POST/DELETE /api/expenses` (indicadores).
- 6 testes de API novos (146 no total) e 1 fluxo E2E novo (31 verificações).

## [1.4.0-beta] — 2026-11-27 — Def Commerce 2.0, bloco 2: PDV (venda no balcão)

### Adicionado
- **Nova venda** (Vendas → "Nova venda" ou botão laranja de ação rápida no celular): busca por nome, SKU ou código de barras (o Enter de um leitor USB/Bluetooth adiciona o item direto), quantidades limitadas ao estoque, desconto, formas de pagamento **Pix, Dinheiro (com troco), Crédito, Débito, Misto e A prazo** (com entrada opcional), cliente e observações opcionais.
- Vende também produtos ocultos da vitrine.
- **Sem venda duplicada:** cada venda tem um identificador gerado no aparelho; reenviar (conexão caiu, toque duplo) devolve a mesma venda.
- **Estoque pelos mesmos gatilhos dos pedidos:** a venda entra, é confirmada (baixa atômica, sem estoque negativo) e concluída na mesma transação. Vendas simultâneas do último item: só uma passa.
- **Comprovante** na tela, para imprimir (80 mm) ou enviar pelo WhatsApp, com o aviso "não é documento fiscal".
- **A prazo:** exige nome e telefone do cliente; o valor fica como "a receber" (aparece no pedido e na API do resumo).
- Menu "Pedidos" passa a se chamar **Vendas**, com o filtro "No balcão" e o selo "Balcão" nos registros; vendas no balcão não disparam aviso de pedido novo.
- Botão de ação rápida (celular): registrar venda ou cadastrar produto.

### Corrigido
- O texto "null" podia aparecer no card "Plano e assinatura" e no resultado da divulgação com IA.

### Técnico
- Migração 0018 (`orders.channel`, `payments_json`, `receivable_cents`, `created_by`); rota `POST /api/sales` (permissão de pedidos).
- 6 testes de API novos (140 no total) e 1 fluxo E2E novo (30 verificações).

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
