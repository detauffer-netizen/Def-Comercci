# Auditoria técnica — Fase 1 (27/11/2026)

Auditoria feita sobre o código do GitHub (`main`, commit `f0270aa`), o Worker
publicado `def-commerce` e o banco D1 `def-commerce-db`.

## Estado encontrado

| Item | Situação |
| --- | --- |
| Arquitetura | Um único arquivo `worker.js` (38 KB, 23 linhas), com API, painel, vitrine e landing em strings HTML dentro do JavaScript. |
| GitHub × Cloudflare | **Sincronizados.** O código publicado é idêntico ao `worker.js` do GitHub. |
| Configuração de publicação | **Ausente.** Não havia `wrangler.toml` nem `package.json`; a publicação era manual, sem rollback documentado. |
| Banco D1 | Esquema de produção confere com as migrações 0001–0006, mas elas foram aplicadas **manualmente** (sem tabela `d1_migrations`). |
| Dados | Banco **vazio**: 0 lojas, 0 usuários, 0 produtos, 0 pedidos. Nenhum dado em risco. |
| R2 | Disponível na conta (dois buckets de outros projetos). Nenhum bucket para o Def Commerce. |
| Testes | **Nenhum.** |
| Documentação | README com uma linha. |

## Defeitos encontrados

| Gravidade | Defeito | Situação |
| --- | --- | --- |
| **Crítica** | A vitrine pública (`/loja/<loja>`) não funcionava: o script tinha um erro de sintaxe (`'\nPedido '` virava uma quebra de linha real dentro de uma string JavaScript). Nenhum produto aparecia e nenhum pedido podia ser feito. | Corrigido. Vitrine reescrita, coberta por teste de ponta a ponta. |
| Alta | Sem cabeçalhos de segurança (CSP, proteção contra clickjacking, HSTS). | Corrigido. |
| Alta | Todo erro interno era respondido como 400 "Erro na solicitação", sem registro: falhas reais ficavam invisíveis. | Corrigido: 500 genérico ao cliente e `console.error` com rastreamento (Workers Logs). |
| Média | Exportação CSV vulnerável a injeção de fórmulas (=, +, -, @) ao abrir no Excel. | Corrigido. |
| Média | Login limitado só por IP; tentativas distribuídas contra uma mesma conta não eram barradas. | Corrigido: limite adicional por conta. |
| Média | Sessões expiradas nunca eram apagadas. | Corrigido: limpeza periódica. |
| Média | Painel exigia papel `owner`; o papel `staff` do banco era inutilizável. | Corrigido: `staff` acessa produtos e pedidos; configurações e auditoria só `owner`. |
| Média | Na landing, a mensagem "Pedido copiado" nunca aparecia (`status` referia-se a `window.status`). | Corrigido. |
| Baixa | Corpo JSON sem limite de tamanho e sem exigência de `Content-Type`. | Corrigido (64 KB; `application/json` obrigatório). |
| Baixa | Edição de produto pelo painel usava `prompt()`. | Substituído por formulário completo. |

## Verificação das funcionalidades declaradas

Legenda: ✅ funcionando e testado · 🟡 parcial · ❌ não existia / simulado

| Funcionalidade | Antes | Agora |
| --- | --- | --- |
| Site comercial responsivo | ✅ | ✅ (CTA para cadastro real, sem scripts inline) |
| Cadastro, login, logout, sessões | ✅ | ✅ testado |
| Multiempresa e isolamento | ✅ no código | ✅ testes de isolamento (produtos, pedidos, clientes, imagens, métricas) |
| Produtos: CRUD, categorias, preço, estoque | ✅ | ✅ + descrição, SKU, promoção, destaque, visibilidade |
| Vitrine pública, busca, carrinho | ❌ quebrada | ✅ testado em navegador |
| Personalização de cor e WhatsApp | ✅ | ✅ + nome, descrição, logotipo, banner |
| Checkout pelo WhatsApp e registro de pedidos | ❌ quebrado (dependia da vitrine) | ✅ testado em navegador |
| Status de pedidos, baixa e reposição de estoque | ✅ (gatilhos SQL) | ✅ testado, incluindo concorrência |
| Estoque nunca negativo / sem baixa duplicada | ✅ | ✅ testado |
| Indicadores financeiros e comerciais | 🟡 3 números | ✅ 8 indicadores |
| Exportação CSV | 🟡 só pedidos, vulnerável | ✅ pedidos e clientes, protegido |
| Clientes automáticos, histórico, CRM básico | ✅ | ✅ + atalho de WhatsApp |
| Limitação de requisições | ✅ | ✅ testado |
| IA e comparador de imagens | ❌ simulação local (sinalizada como tal) | ❌ continua demonstração na landing — Fase 4 |

## Itens que dependem do proprietário

Ver “Pendências reais” no `ROADMAP.md`.
