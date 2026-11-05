import pdfplumber, re, json

CESTRX = re.compile(r'^\s*(\d{2}\.\d{3}\.\d{2})\s*$')
NCMTK  = re.compile(r'\b\d{4}(?:\.\d{1,2}){1,3}\b|\b\d{4}\b')
MARCA  = re.compile(r'(Reda[çc][ãa]o dada|Inclu[íi]do|Revogado|Acrescentado)\s+pel[oa]s?\s+Decretos?\s*n[ºo°]?\s*([\d\.]+)', re.I)
VIGDT  = re.compile(r'vig[êe]ncia a partir de\s*([^)]+?)\s*\)', re.I)
META   = re.compile(r'\((?:Conv\.?|CV|Prot\.?|Protocolos?)[^)]*\)|'
                    r'\(\s*(?:Reda[çc][ãa]o dada|Inclu[íi]do|Revogado|Acrescentado)[^)]*\)', re.I)
PCT = re.compile(r'^\d{1,3}[,.]\d{1,2}\s*%?$|^\d{1,3}\s*%$')
lim = lambda s: re.sub(r'\s+', ' ', s or '').strip()

saida, mva_tabs = [], []
with pdfplumber.open('/home/claude/rn/orig/anexo07_2026.pdf') as pdf:
    for npg, pg in enumerate(pdf.pages, 1):
        for tab in pg.extract_tables():
            if not tab: continue
            for row in tab:
                if not row: continue
                cels = [lim(c) for c in row]
                j = next((k for k, c in enumerate(cels) if CESTRX.match(c)), None)
                if j is not None:
                    resto = [c for c in cels[j+1:] if c]
                    # linha de MVA: o que vem depois do CEST sao percentuais, nao NCM e descricao
                    pct = sum(1 for c in resto if PCT.match(c))
                    if resto and pct >= 2 and pct >= len(resto) - 1:
                        mva_tabs.append({'pagina': npg, 'cest': cels[j].replace('.', ''),
                                         'valores': resto})
                        continue
                if j is None:
                    # celula partida pela grade: o resto do texto volta para a linha anterior
                    resto = ' '.join(c for c in cels if c)
                    if saida and resto and not CESTRX.match(resto):
                        saida[-1]['bruto'] = lim(saida[-1]['bruto'] + ' ' + resto)
                    continue
                if len(cels) < j + 3: continue
                item = cels[j-1] if j > 0 else ''
                ncm_txt, desc = cels[j+1], ' '.join(c for c in cels[j+2:] if c)
                # tabelas de combustiveis juntam NCM e descricao na mesma celula
                if not NCMTK.search(ncm_txt) and desc:
                    m0 = re.match(r'^((?:\d{4}(?:\.\d{1,2}){0,3}[,;\s]*)+?)\s+([A-Za-zÀ-ÿ(].*)$', desc)
                    if m0: ncm_txt, desc = m0.group(1), m0.group(2)
                ncms = sorted({n.replace('.', '') for n in NCMTK.findall(ncm_txt)
                               if 4 <= len(n.replace('.', '')) <= 8})
                mk, dt = MARCA.search(desc), VIGDT.search(desc)
                saida.append({
                    'pagina': npg,
                    'item': item if re.fullmatch(r'\d{1,3}(?:\.\d{1,3})?', item) else '',
                    'cest': CESTRX.match(cels[j]).group(1).replace('.', ''),
                    'ncms': ncms,
                    'descricao': '',
                    'marca': (mk.group(1).lower() if mk else None),
                    'decreto': (mk.group(2) if mk else None),
                    'vigencia': (dt.group(1).strip() if dt else None),
                    'bruto': desc,
                })

EMB = re.compile(r'(?<!CEST )\b(\d{4}\.\d{2}\.\d{2})\b')
for r in saida:
    # NCM que vazou da coluna para dentro da descricao (celula partida pela grade)
    corpo = META.sub(' ', r['bruto'])
    # NCM citado depois de "exceto" e exclusao, nao inclusao: nao entra
    antes = re.split(r'\b(?:exceto|exclusive|salvo|ressalvad)', corpo, flags=re.I)[0]
    perdidos = [n for n in EMB.findall(antes) if n.replace('.', '') not in r['ncms']]
    if perdidos:
        r['ncms'] = sorted(set(r['ncms']) | {n.replace('.', '') for n in perdidos})
        r['ncm_na_descricao'] = True
        corpo = EMB.sub(' ', corpo)
    else:
        r['ncm_na_descricao'] = False
    r['descricao'] = lim(corpo).strip(' .,-')
    mk, dt = MARCA.search(r['bruto']), VIGDT.search(r['bruto'])
    r['porta_a_porta'] = r['cest'].startswith('28')
    r['marca']    = mk.group(1).lower() if mk else None
    r['decreto']  = mk.group(2) if mk else None
    r['vigencia'] = dt.group(1).strip() if dt else None

json.dump(mva_tabs, open('/home/claude/rn/parser/anexo07_mva.json','w'), ensure_ascii=False, indent=1)
print(f'linhas de MVA separadas: {len(mva_tabs)}')
json.dump(saida, open('/home/claude/rn/parser/anexo07_2026.json', 'w'), ensure_ascii=False, indent=1)
print(f'linhas de item   : {len(saida)}')
print(f'  com NCM        : {sum(1 for s in saida if s["ncms"])}')
print(f'  com descricao  : {sum(1 for s in saida if len(s["descricao"]) > 12)}')
print(f'  com marca de alteracao: {sum(1 for s in saida if s["marca"])}')
print(f'  CEST distintos : {len({s["cest"] for s in saida})}')
