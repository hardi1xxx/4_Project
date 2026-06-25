import csv, io, urllib.request
url='https://docs.google.com/spreadsheets/d/1MqKFY3mn7-Qa2xn9kslKPKYCF15ONWPf71_dZuIF458/gviz/tq?tqx=out:csv&sheet=MBB'
with urllib.request.urlopen(url) as r:
    data=r.read().decode('utf-8','replace')
rows=list(csv.reader(io.StringIO(data)))
header=rows[0]
cols=['Status Tsel','Status Recti','Status Pekerjaan','Status Pekerjaan_1']
for col in cols:
    if col in header:
        idx=header.index(col)
        values={}
        for r in rows[1:501]:
            if idx < len(r):
                v=r[idx].strip()
                values[v]=values.get(v,0)+1
        print('col',col,'idx',idx,'unique',len(values))
        for v,c in sorted(values.items(), key=lambda x:(-x[1], x[0]))[:20]:
            print(' ',c,repr(v))
        print()
    else:
        print('missing',col)
