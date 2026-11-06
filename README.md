# LidiTax — classificação tributária de produtos (uma solução Elite Consultoria Contábil)

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
| Famílias de produto | agrupa a planilha por NCM + nome principal, mostra divergências e aplica uma decisão à família inteira (com prévia) |
| Curadoria das regras (admin) | aprova, rejeita ou devolve a pendente cada regra dos trilhos estadual e federal, com o trecho do documento |

## Alimentação automática da base

| Rotina | Onde roda | Quando | O que faz |
|---|---|---|---|
| `sync-ncm` | Edge Function do Supabase, agendada por pg_cron | segundas, 04h10 | lê a nomenclatura NCM oficial do Portal Único Siscomex, inclui novos e marca extintos |
| Vigilância legislativa | tarefa agendada na nuvem | dias úteis, 06h31 | localiza ADE, decretos e convênios e registra em `atualizacao_legislativa` |
| `vigia-fontes` | Edge Function do Supabase, agendada por pg_cron | dias úteis, 05h20 | confere o hash das fontes oficiais (SEFAZ/RN, SPED, leis de PIS/COFINS) e avisa em `atualizacao_legislativa` quando mudam |

## Trilhos de regra

- **Estadual** (`est_documento` → `est_trecho` → `est_regra`): ICMS do RN — alíquota, redução, isenção e ST com MVA original.
- **Federal** (`fed_documento` → `fed_trecho` → `fed_regra`): PIS/COFINS por regime e, quando carregadas, as exceções por NCM das tabelas 4.3.10 a 4.3.17 da EFD-Contribuições.
- Os trilhos não se misturam. A extração é feita no chat a partir do documento oficial; a regra só vale depois de aprovada na Curadoria e dentro da vigência.
- PIS/COFINS só são preenchidos quando as exceções por NCM estão carregadas e deixam de ser preenchidos a partir de 01/01/2027 (EC 132/2023 — ADCT, art. 126, II).

A aplicação de mudanças de tratamento tributário é aprovada por uma pessoa na
tela de Atualizações — a automação detecta e registra, não reclassifica sozinha.

## Arquivos

- `index.html` — estrutura das telas
- `app.css` — estilos, com tema claro e escuro
- `app.js` — autenticação, motor de classificação, exportação e integração com o banco
- `netlify.toml` — configuração de publicação
