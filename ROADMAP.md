# Roadmap — Def Commerce

Legenda: ✅ concluído e testado · 🟡 parcial · ⬜ não iniciado · ⛔ bloqueado (depende do proprietário)

## Fase 1 — Auditoria e recuperação ✅

- ✅ Análise de todo o código, do Worker publicado e do banco de produção (`docs/AUDITORIA.md`)
- ✅ Sincronização GitHub × Cloudflare verificada (idênticos em 27/11/2026)
- ✅ Esquema real do D1 verificado; banco vazio, sem dados em risco
- ✅ Vitrine quebrada em produção corrigida (erro de sintaxe)
- ✅ Código modularizado (`src/`, `public/`), `wrangler.toml`, `package.json`
- ✅ 31 testes de API/integração + 12 verificações E2E em navegador
- ✅ Fluxo de publicação com backup, migração e verificação de saúde; rollback documentado
- ⛔ Publicação desta versão (ver Pendências)

## Fase 2 — Imagens e catálogo 🟡

- ✅ Upload de fotos (até 8 por produto) e de logotipo/banner, com compressão no navegador
- ✅ Validação de formato real e tamanho; exclusão segura; isolamento por loja
- ✅ SKU, preço promocional, destaque, visibilidade, descrição, categorias livres
- ✅ Identidade visual por loja (cor, logotipo, banner, descrição)
- ✅ Compartilhamento da vitrine e de produtos (link direto `#p-<id>`)
- ⛔ Bucket R2 `def-commerce-images` (criar e ativar no `wrangler.toml`)
- ⬜ Variações (tamanho/cor/modelo) com SKU e estoque próprios — exige nova tabela e ajuste dos gatilhos de estoque
- ⬜ Reordenar fotos; categorias gerenciadas com ordem e imagem
- ⬜ Catálogo em PDF / página de catálogo para impressão

## Fase 3 — Painel profissional 🟡

- ✅ Dashboard com 8 indicadores, primeiros passos (onboarding), pedidos recentes e alertas de estoque
- ✅ Gestão de produtos, pedidos (filtros e ações por status), clientes, estoque (histórico) e loja
- ✅ Exportação CSV de pedidos e clientes; registro de atividades
- ✅ Layout mobile first (navegação inferior no celular, lateral no desktop)
- ⬜ Funcionários e permissões individuais (o papel `staff` já existe no banco e na API)
- ⛔ Recuperação de senha por e-mail (precisa de provedor de e-mail)
- ⬜ Notificações de novos pedidos (no painel e por e-mail/push)
- ⬜ Relatórios por período e gráficos

## Fase 4 — Inteligência artificial ⛔

Depende da escolha do provedor e de chave de API. Sugestão: Workers AI (já na conta
Cloudflare, sem chave extra) para texto e visão, ou a API da Anthropic.
- ⬜ Cadastro por mensagem e por foto (com confirmação obrigatória do lojista)
- ⬜ Títulos, descrições e categorias sugeridas
- ⬜ Remoção de fundo e melhoria de fotos
- ⬜ Controle de consumo por empresa e limite por plano

## Fase 5 — WhatsApp e automações 🟡

- ✅ Checkout pelo WhatsApp com resumo e código do pedido
- ✅ Atalho de WhatsApp para o cliente em cada pedido e no CRM
- ✅ Compartilhamento do catálogo pelo WhatsApp
- ⛔ Notificações automáticas e atendimento automatizado (exigem WhatsApp Business Cloud API)
- ⬜ Recuperação de carrinho abandonado com consentimento

## Fase 6 — Super administrador ⬜

- ✅ Base: coluna `stores.status` (`active`/`suspended`) já bloqueia vitrine e painel de lojas suspensas
- ⬜ Papel de super administrador separado dos lojistas (tabela própria, 2FA, rota isolada)
- ⬜ Gestão de lojistas, planos, assinaturas, uso de IA e armazenamento, logs e erros

## Fase 7 — Monetização ⛔

Preços e provedor de pagamento dependem do proprietário.
- ⬜ Planos, período de teste, limites por plano, cupons
- ⬜ Cobrança recorrente (Pix e cartão) com webhooks autenticados e idempotentes

## Fase 8 — Segurança e qualidade 🟡

- ✅ Ver `SECURITY.md` (isolamento, senhas, sessões, CSRF, XSS, SQLi, uploads, rate limit, auditoria)
- ✅ Testes unitários, de integração, E2E, responsividade (375 px e 1366 px) e isolamento entre lojas
- ✅ CI no GitHub Actions
- ⬜ Política de privacidade, termos de uso, exportação/exclusão de dados (LGPD)
- ⬜ 2FA; monitoramento de erros com alertas

## Fase 9 — Design e experiência 🟡

- ✅ Design system (tokens, botões, formulários, ícones vetoriais), painel e vitrine redesenhados
- ✅ Estados de carregamento, vazio e erro; mensagens claras em português; acessibilidade básica (rótulos, foco, contraste, `prefers-reduced-motion`)
- ⬜ Nova landing page orientada à conversão (a atual foi mantida, com CTA para o cadastro real)
- ⬜ SEO técnico da vitrine (renderização no servidor, Open Graph por loja e produto, sitemap)

## Pendências reais (dependem do proprietário)

1. **Acesso de escrita ao GitHub** para esta automação: instalar o Claude GitHub App no repositório.
2. **Publicação na Cloudflare:** um token de API (Workers + D1 + R2, somente esta conta) como segredo `CLOUDFLARE_API_TOKEN` do GitHub, ou publicar localmente com `npm run deploy`.
3. **Autorizar a criação do bucket R2** `def-commerce-images` (camada gratuita de 10 GB).
4. **Provedor de e-mail** para recuperação de senha e notificações.
5. **Provedor de IA** (Workers AI ou Anthropic) e orçamento de uso.
6. **WhatsApp Business Cloud API** (conta Meta verificada) para automações.
7. **Provedor de pagamentos e preços dos planos.**
