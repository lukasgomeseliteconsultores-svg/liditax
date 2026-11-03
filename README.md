# MIX Fiscal — ELITE

Ferramenta interna de preenchimento e correção de cadastro fiscal de produtos
(NCM, CST/CSOSN, CFOP de entrada e saída, cClassTrib de IBS e CBS).

## Como funciona

- **Front-end**: página estática (HTML, CSS e JavaScript), sem etapa de build.
  O Netlify publica a raiz do repositório a cada push na `main`.
- **Banco**: Supabase (projeto `mix-fiscal-elite`, região sa-east-1), com
  segurança por linha restrita ao domínio corporativo.
- **Acesso**: login pela conta Google do escritório ou e-mail e senha.

## Telas

| Tela | O que faz |
|---|---|
| Preencher cadastro | sobe a planilha do cliente, mapeia colunas, preenche e marca o que precisa de revisão |
| Clientes | consulta pública de CNPJ e define o regime, que comanda CSOSN × CST |
| Atualizações | fila de atos normativos detectados pelas rotinas automáticas |
| Base e memória | tabelas de referência, carga da TIPI e histórico de correções da equipe |

## Alimentação automática da base

| Rotina | Onde roda | Quando | O que faz |
|---|---|---|---|
| `sync-ncm` | Edge Function do Supabase, agendada por pg_cron | segundas, 04h10 | lê a nomenclatura NCM oficial do Portal Único Siscomex, inclui novos e marca extintos |
| Vigilância legislativa | tarefa agendada na nuvem | dias úteis, 06h31 | localiza ADE, decretos e convênios e registra em `atualizacao_legislativa` |

A aplicação de mudanças de tratamento tributário é aprovada por uma pessoa na
tela de Atualizações — a automação detecta e registra, não reclassifica sozinha.

## Arquivos

- `index.html` — estrutura das telas
- `app.css` — estilos, com tema claro e escuro
- `app.js` — autenticação, motor de classificação, exportação e integração com o banco
- `netlify.toml` — configuração de publicação
