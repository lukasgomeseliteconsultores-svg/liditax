import json, re
from collections import defaultdict
d = json.load(open('/home/claude/rn/parser/anexo07_2026.json'))
MARCA = re.compile(r'(Reda[çc][ãa]o dada|Inclu[íi]do|Revogado|Acrescentado)\s+pel[oa]s?\s+Decretos?\s*n[ºo°]?\s*([\d\.]+)', re.I)
VIG   = re.compile(r'vig[êe]ncia a partir de\s*([^)]+?)\s*\)', re.I)
for r in d:
    m = MARCA.search(r['bruto']); v = VIG.search(r['bruto'])
    r['marca']    = m.group(1).lower() if m else None
    r['decreto']  = m.group(2) if m else None
    r['vigencia'] = v.group(1).strip() if v else None
print('linhas com marca de alteração:', sum(1 for r in d if r['marca']))
print('  revogadas                  :', sum(1 for r in d if r['marca'] == 'revogado'))

por = defaultdict(list)
for i, r in enumerate(d): r['ordem'] = i; por[r['cest']].append(r)

vig, hist = [], []
for cest, rows in por.items():
    for r in rows: r['_peso'] = (1 if r['marca'] in ('redação dada','incluído','acrescentado') else 0, r['ordem'])
    rows_ok = [r for r in rows if r['marca'] != 'revogado'] or rows
    atual = max(rows_ok, key=lambda r: r['_peso'])
    for r in rows:
        (vig if r is atual else hist).append(r)
print(f'\nCEST distintos        : {len(por)}')
print(f'  linhas vigentes     : {len(vig)}')
print(f'  linhas superadas    : {len(hist)}')
json.dump({'vigente': vig, 'historico': hist}, open('/home/claude/rn/parser/anexo07_resolvido.json','w'), ensure_ascii=False, indent=1)
