# Roadmap — Def Commerce

Legenda: ✅ concluído e testado · 🟡 parcial · ⬜ não iniciado · ⛔ bloqueado (depende do proprietário)

## Fase 1 — Auditoria e recuperação ✅

- ✅ Análise de todo o código, do Worker publicado e do banco de produção (`docs/AUDITORIA.md`)
- ✅ Sincronização GitHub × Cloudflare verificada (idênticos em 27/11/2026)
- ✅ Esquema real do D1 verificado; banco vazio, sem dados em risco
- ✅ Vitrine quebrada em produção corrigida (erro de sintaxe)
- ✅ Código modularizado (`src/`, `public/`), `wrangler.toml`, `package.json`
- ✅ 107 testes de API/integração + 28 verificações E2E em navegador
- ✅ Fluxo de publicação com backup, migração e verificação de saúde; rollback documentado
- ⛔ Publicação desta versão (ver Pendências)

## Fase 2 — Imagens e catálogo 🟡

- ✅ Upload de fotos (até 8 por produto) e de logotipo/banner, com compressão no navegador
- ✅ Validação de formato real e tamanho; exclusão segura; isolamento por loja
- ✅ SKU, preço promocional, destaque, visibilidade, descrição, categorias livres
- ✅ Identidade visual por loja (cor, logotipo, banner, descrição)
- ✅ Compartilhamento da vitrine e de produtos (link direto `#p-<id>`)
- ✅ Bucket R2 `def-commerce-images` criado e ligado ao Worker (binding `IMAGES`)
- ✅ Variações (tamanho/cor/modelo) com SKU, preço e estoque próprios; gerador de combinações; estoque do produto = soma das variações; gatilhos de pedido atualizados
- ✅ Ordem manual dos produtos na vitrine (destaques sempre no topo)
- ✅ Reordenar fotos (escolher a capa)
- ✅ Ordem das categorias na vitrine e no catálogo
- ✅ Catálogo para imprimir ou salvar em PDF (`/loja/<loja>/catalogo`), agrupado por categoria

## Fase 3 — Painel profissional 🟡

- ✅ Dashboard com 8 indicadores, primeiros passos (onboarding), pedidos recentes e alertas de estoque
- ✅ Gestão de produtos, pedidos (filtros e ações por status), clientes, estoque (histórico) e loja
- ✅ Exportação CSV de pedidos e clientes; registro de atividades
- ✅ Layout mobile first (navegação inferior no celular, lateral no desktop)
- ✅ Painel instalável no celular (PWA): manifesto, ícones, atalhos e abertura sem internet com aviso
- ✅ Equipe: funcionários com permissões individuais (produtos, pedidos, clientes, indicadores), senha provisória com troca obrigatória no 1º acesso, remoção com encerramento imediato das sessões
- ✅ Troca de senha pelo próprio usuário (encerra as outras sessões)
- ⛔ Recuperação de senha por e-mail (precisa de provedor de e-mail)
- ✅ Aviso de novos pedidos no painel (consulta a cada 30 s, contador no título da aba e alerta opcional do navegador)
- ⛔ Aviso por e-mail ou push com o painel fechado (depende de provedor de e-mail / push)
- ✅ Relatórios por período (7/30/90 dias): vendas por dia em gráfico com dica (mouse, toque e teclado) e tabela, comparação com o período anterior, mais vendidos

## Fase 4 — Inteligência artificial 🟡 (Cloudflare Workers AI)

- ✅ Cadastro de produto por mensagem natural (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, saída em JSON schema)
- ✅ Cadastro de produto a partir de foto (`@cf/meta/llama-4-scout-17b-16e-instruct`, visão); preço nunca é deduzido da foto
- ✅ Títulos e descrições comerciais, sugestão de categoria e de opções (tamanhos, cores)
- ✅ Assistente de divulgação: mensagem para WhatsApp, legenda para Instagram e ideias, usando só produtos e preços reais da loja
- ✅ Tudo é sugestão: preenche o formulário, destaca os campos e exige revisão; nada é salvo automaticamente
- ✅ Limite diário de uso por loja (`AI_DAILY_LIMIT`, padrão 30) e consumo visível na administração
- ✅ Limites de IA por plano de assinatura
- ⛔ Remoção de fundo e melhoria de fotos: não há modelo para isso no Workers AI; exigiria Cloudflare Images (pago) ou outro provedor
- ⬜ Validar a qualidade das respostas com o modelo real após a publicação (os testes usam um modelo simulado)

## Fase 5 — WhatsApp e automações 🟡

- ✅ Checkout pelo WhatsApp com resumo e código do pedido
- ✅ Entrega ou retirada no checkout: taxa de entrega, frete grátis a partir de um valor (já com desconto) e endereço no pedido
- ✅ Impressão do pedido pelo painel
- ✅ Atalho de WhatsApp para o cliente em cada pedido e no CRM
- ✅ Compartilhamento do catálogo pelo WhatsApp
- ⛔ Notificações automáticas e atendimento automatizado (exigem WhatsApp Business Cloud API)
- ✅ Recuperação de carrinho abandonado com consentimento (contato manual pelo WhatsApp; envio automático depende da API oficial)

## Fase 6 — Super administrador 🟡

- ✅ Super administrador separado dos lojistas: tabela `platform_admins`, rotas `/api/admin/*` e página `/admin` isoladas; um administrador não acessa o painel de lojas e vice-versa
- ✅ Visão geral da plataforma (lojas, usuários, produtos, pedidos, GMV, armazenamento de imagens)
- ✅ Lista de lojas com busca, indicadores por loja, suspensão (com motivo obrigatório) e reativação
- ✅ Registro de operações de toda a plataforma
- ✅ Script `scripts/create-admin.js` para criar o primeiro administrador
- ✅ Monitoramento de erros do servidor na administração (últimas 24 h/7 dias, agrupados por rota e mensagem, sem dados pessoais)
- ✅ Verificação em duas etapas (TOTP) para lojistas, equipe e administradores, com códigos de recuperação
- ⬜ Planos, assinaturas e uso de IA (dependem das Fases 4 e 7)
- ⬜ Alertas de erro por e-mail (depende de provedor)

## Fase 7 — Monetização 🟡

Provedor: Mercado Pago. Preços e ativação da cobrança dependem do proprietário.
- ✅ Cupons de desconto das lojas para seus clientes (percentual ou valor fixo, pedido mínimo, validade, limite de usos atômico)
- ✅ Planos com período de teste e limites (produtos, equipe, IA por dia), aplicados no servidor; gestão na administração
- ✅ Assinatura recorrente no cartão e pagamento mensal por Pix ou cartão (Mercado Pago), com webhook autenticado e idempotente, carência de 7 dias
- ✅ Indicadores de receita (MRR, pagantes, em teste, inadimplentes) e plano manual por loja
- ⛔ Ativar a cobrança real: credenciais do Mercado Pago, preços dos planos e autorização do proprietário
- ⬜ Validar os campos das notificações no ambiente de testes (sandbox) do Mercado Pago
- ⬜ Cupons de assinatura

## Fase 8 — Segurança e qualidade 🟡

- ✅ Ver `SECURITY.md` (isolamento, senhas, sessões, CSRF, XSS, SQLi, uploads, rate limit, auditoria)
- ✅ Testes unitários, de integração, E2E, responsividade (375 px e 1366 px) e isolamento entre lojas
- ✅ CI no GitHub Actions
- ✅ Política de Privacidade e Termos de Uso publicados (`/privacidade`, `/termos`) — ⛔ revisão jurídica e dados do controlador/encarregado pendentes
- ✅ LGPD: exportação de todos os dados da loja (JSON), exclusão definitiva da loja (com imagens e equipe) e anonimização de compradores
- ✅ Verificação em duas etapas (TOTP, RFC 6238) com proteção contra reutilização de código e códigos de recuperação
- ⬜ Alertas de erro por e-mail

## Fase 9 — Design e experiência 🟡

- ✅ Design system (tokens, botões, formulários, ícones vetoriais), painel e vitrine redesenhados
- ✅ Estados de carregamento, vazio e erro; mensagens claras em português; acessibilidade básica (rótulos, foco, contraste, `prefers-reduced-motion`)
- ✅ Nova landing page orientada à conversão, sem demonstrações simuladas nem números inventados
- ✅ SEO da vitrine: título, descrição, Open Graph, canonical e dados estruturados por loja gerados no servidor; 404 real para lojas inexistentes; `sitemap.xml` e `robots.txt` dinâmicos
- ✅ Página própria por produto (`/loja/<loja>/p/<id>`) com título, preço, imagem, Open Graph e dados estruturados `Product`; incluída no sitemap

## Def Commerce 2.0 (prompt mestre de evolução)

Ordem de execução e situação real:

1. 🟡 Auditoria e integração: carrinho abandonado (PR #12) e lucro/resumo (bloco 1) prontos; publicação pendente (token da Cloudflare)
2. 🟡 Redesign do painel e navegação mobile: ✅ "Pedidos" virou Vendas, ✅ botão de ação rápida no celular; ⬜ separar Divulgação e Configurações de "Minha loja"
3. ✅ Cadastro inteligente: mensagem (com custo, quantidade e margem), foto e várias fotos de uma vez com IA; custo/código de barras/fornecedor/localização; leitura de código pela câmera; importação/exportação CSV; duplicar e editar em massa; etiquetas com código de barras
4. ✅ Estoque: histórico por gatilho, alerta de reposição, valor do estoque, entradas com custo médio, perdas, inventário, devoluções, quantidade reservada, fornecedores e "Preciso repor" com lista de compras por fornecedor (⬜ etiquetas e códigos de barras impressos ficam para a fase 3)
5. ✅ PDV e financeiro: venda presencial idempotente (Pix, dinheiro, cartões, misto, a prazo), comprovante, baixa pelos gatilhos; custo histórico, lucro bruto, resultado estimado, despesas, contas a receber, devoluções com reposição e calculadora de preço (⬜ leitura de código pela câmera fica na fase 3)
6. 🟡 Catálogo premium e checkout: ✅ busca, categorias, destaques, variações, carrinho persistente, entrega/retirada, SEO por produto; ⬜ filtros de preço, favoritos, relacionados, horário, banners, modelos por segmento, reserva com expiração, página de acompanhamento do pedido
7. 🟡 Marketing: ✅ textos com IA; ⬜ artes no navegador (Canvas) e QR Codes
8. 🟡 CRM e assistente: ✅ clientes a partir dos pedidos; ⬜ segmentos, observações, assistente de perguntas sobre a loja
9. 🟡 Onboarding e comercial: ✅ primeiros passos, planos com limites; ⬜ segmento no cadastro, loja demonstrativa, planos Essencial/Profissional/Premium por recurso
10. 🟡 Segurança e desempenho: ✅ ver `SECURITY.md`; ⬜ consumo por loja, paginação, cache público

## Pendências reais (dependem do proprietário)

1. **Acesso de escrita ao GitHub** para esta automação: instalar o Claude GitHub App no repositório.
2. **Publicação na Cloudflare:** um token de API (Workers + D1 + R2, somente esta conta) como segredo `CLOUDFLARE_API_TOKEN` do GitHub, ou publicar localmente com `npm run deploy`.
3. ~~Bucket R2~~ — criado em 27/11/2026.
4. **Provedor de e-mail** para recuperação de senha e notificações.
5. ~~Provedor de IA~~ — Workers AI escolhido; ajustar `AI_DAILY_LIMIT` conforme o orçamento.
6. **WhatsApp Business Cloud API** (conta Meta verificada) para automações.
7. **Provedor de pagamentos e preços dos planos.**
8. **Dados jurídicos:** razão social/CNPJ, e-mail do encarregado (DPO) e revisão das páginas de Privacidade e Termos por um advogado.
