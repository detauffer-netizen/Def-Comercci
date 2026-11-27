# Segurança — Def Commerce

## Como relatar uma vulnerabilidade

Não abra issue pública. Envie os detalhes ao proprietário do projeto pelo canal
privado de suporte. Responderemos e corrigiremos com prioridade.

## Controles implementados (todos cobertos por testes automatizados)

| Ameaça | Controle |
| --- | --- |
| Controle de acesso | Cada rota declara seu nível: público, membro da loja, permissão específica, proprietário ou super administrador; funcionários com senha provisória só podem trocá-la |
| Super administrador | Tabela própria (`platform_admins`) e rotas `/api/admin/*` isoladas; administradores não acessam lojas e lojistas não acessam a administração; suspensões exigem motivo e ficam auditadas |
| Acesso a dados de outra loja | `store_id` sempre vem da sessão no servidor; testes de isolamento para produtos, pedidos, clientes, métricas e imagens |
| Senhas | PBKDF2-SHA256, 100.000 iterações (máximo do runtime), salt aleatório de 128 bits por usuário; formato versionado com migração automática do formato antigo; comparação em tempo constante; derivação executada mesmo para e-mail inexistente |
| Sessões | Token aleatório de 256 bits; só o hash SHA-256 fica no banco; cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`; expiração de 7 dias; logout invalida no servidor; limpeza periódica |
| CSRF | Escritas exigem cabeçalho `Origin` igual ao do site e corpo `application/json` (ou imagem), que formulários de outros sites não conseguem enviar; cookie `SameSite=Strict` |
| Força bruta e abuso | Limites por IP (cadastro 5/10 min, login 20/10 min, pedidos 20/10 min) e por conta (login 10/10 min); chaves guardadas como hash |
| SQL injection | Somente consultas parametrizadas (`prepare().bind()`) |
| XSS | Frontend monta o DOM com `textContent`; Content-Security-Policy sem scripts inline; `frame-ancestors 'none'` |
| Uploads | Tipo real verificado pelos bytes (JPEG/PNG/WebP; SVG recusado), limite de 2 MB, chaves isoladas por loja, até 8 imagens por produto, servidas com `nosniff` e CSP `sandbox` |
| Manipulação de preço | Totais calculados no servidor; preço e nome dos itens lidos do banco |
| Estoque | Gatilhos SQL atômicos: sem estoque negativo, sem baixa duplicada, reposição ao cancelar, transições de status restritas |
| Vazamento de erros | Erros internos respondem 500 genérico; detalhes só nos logs do Worker |
| CSV | Proteção contra injeção de fórmulas |
| Auditoria | `audit_log` por loja (cadastro, login, produtos, pedidos, configurações) e histórico de estoque por gatilho |
| Transporte | HSTS, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options` |

## LGPD

- Dados pessoais tratados: e-mail do lojista; nome, telefone e observações do comprador (informados por ele no pedido, com aviso de finalidade na tela).
- O lojista concorda com o tratamento ao criar a loja.
- IPs não são armazenados em texto claro (apenas hashes temporários para limitação de abuso, apagados em até 20 minutos).
- Política de Privacidade (`/privacidade`) e Termos de Uso (`/termos`) publicados; o cadastro do lojista exige o aceite.
- Direitos do titular: o lojista exporta todos os dados da loja e pode excluí-la definitivamente (exige senha e o endereço da loja); o lojista anonimiza compradores a pedido deles.
- Pendentes: identificação do controlador e canal do encarregado (DPO), revisão jurídica dos textos e prazo de retenção de pedidos.

## Segredos

Nenhum segredo é armazenado no repositório. Use `npx wrangler secret put` para
segredos do Worker e segredos do GitHub Actions para a publicação. Veja `.env.example`.

## Pendências de segurança conhecidas

- Recuperação de senha por e-mail (depende de provedor de e-mail).
- Autenticação em dois fatores para o painel e para o super administrador.
- Webhooks de pagamento autenticados e idempotentes (Fase 7).
