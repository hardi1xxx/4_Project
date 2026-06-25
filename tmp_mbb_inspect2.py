import csv
import io
import urllib.request

url = 'https://docs.google.com/spreadsheets/d/1MqKFY3mn7-Qa2xn9kslKPKYCF15ONWPf71_dZuIF458/gviz/tq?tqx=out:csv&sheet=MBB'
with urllib.request.urlopen(url) as r:
    data = r.read().decode('utf-8', errors='replace')
rows = list(csv.reader(io.StringIO(data)))
header = rows[0]
print('header count', len(header))
for i, h in enumerate(header):
    if any(term in (h or '').lower() for term in ['status', 'progress', 'approval', 'survey', 'matdev', 'instal']):
        print(i, repr(h))

search_terms = ['approval','survey','matdev','instal', 'finish', 'material', 'progress', 'drop', 'golive']
for term in search_terms:
    cols = set()
    for r in rows[1:]:
        for i, cell in enumerate(r):
            if term in (cell or '').lower():
                cols.add(i)
    if cols:
        print('term', term, 'cols', sorted(cols))
        for c in sorted(cols)[:10]:
            vals = []
            for r in rows[1:100]:
                if c < len(r) and term in (r[c] or '').lower():
                    vals.append(r[c])
                    if len(vals) >= 10:
                        break
            print('  col', c, 'header', repr(header[c]), 'sample', vals[:5])
