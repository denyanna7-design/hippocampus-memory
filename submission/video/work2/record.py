import asyncio, json, html, subprocess, os, re
from playwright.async_api import async_playwright
import sys
W='/workspace/amazon-hackathon/submission/video/work2'
PHASE=sys.argv[1]
ONLY=sys.argv[2] if len(sys.argv)>2 else None
dur={}
for i in range(1,10):
    d=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'{W}/audio/{i}.mp3']))
    dur[i]=round(d+0.8,2)
full=open(f'{W}/full.txt').read().splitlines()
chat=open(f'{W}/chat.txt').read().splitlines()
def L(a,b): return full[a-1:b]
def tbl(lines):
    out=[]
    for l in lines:
        p=l.split('|')
        out.append('|'.join([p[0],p[1],p[4],p[5]]) if len(p)==6 else l)
    return out
def trim(l,n=150): return l if len(l)<=n else l[:n]+'…'
def idx(pfx,after=0):
    return next(i for i,l in enumerate(full) if i>=after and l.startswith(pfx))
s1=idx('━━━━━━━━ Session 1'); gn=idx('👤 Good night'); s2=idx('━━━━━━━━ Session 2'); s3=idx('━━━━━━━━ Session 3')
prev=open(f'{W}/preview.txt').read().splitlines() if os.path.exists(f'{W}/preview.txt') else []
lunch=[l for l in full if 'Lunch:' in l and 'Alexa' in l][0].split(' — that also')[0]
term={
 2:['$ npm run alexa:demo:video']+full[0:s1+5],
 3:full[s1:s1+4]+full[idx('👤 Lunch was'):gn+3]+full[gn+3:gn+4],
 5:['$ curl localhost:3000/api/preview   # sleep report (dry run)','']+['      '+l for l in prev[:9]],
 6:full[s3:s3+3]+['   '+trim(full[s3+3].strip(),130), lunch,'']+full[idx('👤 When is Grandpa',s3):idx('👤 When is Grandpa',s3)+3]+['',full[-1]],
 8:['$ MEMORY_BUDGET_BYTES=5000 npm start   # terminal A','$ npm run alexa:demo -- --chat']+[l for l in chat if l.strip() and not l.startswith('you> ') or l.startswith('you> I')][:5],
}
term[5]=tbl(term[5]); term[8]=[trim(l,330) for l in term[8]]
term[3]=[l for l in term[3] if not l.strip().startswith(('hot','warm','cool','cold','tier','moves','total'))] if False else term[3]
def color(l):
    e=html.escape(l)
    if 'ALERT' in l: return f'<span style="color:#f87171">{e}</span>'
    if 'salience=0.9' in l or 'word-for-word' in l or 'Grandpa' in l: return f'<span style="color:#fde047">{e}</span>'
    if 'fidelity' in l or 'may have faded' in l: return f'<span style="color:#f9a8d4">{e}</span>'
    if l.startswith('━'): return f'<span style="color:#60a5fa;font-weight:bold">{e}</span>'
    if '🔧' in l or l.strip().startswith(('tier','hot','warm','cool','cold','===','moves','total')): return f'<span style="color:#9ca3af">{e}</span>'
    return e
def termpage(lines,d):
    body=json.dumps([color(l) for l in lines])
    step=max(0.15,(d*0.7)/max(1,len(lines)))
    return f'''<html><body style="margin:0;background:#0b1020;color:#e5e7eb;font:15px/1.45 'DejaVu Sans Mono',monospace">
<div style="height:30px;background:#1f2937;color:#9ca3af;padding:6px 14px;box-sizing:border-box;font-size:13px">● ● ●  terminal — hippocampus-memory</div>
<pre id=o style="margin:0;padding:14px 18px;white-space:pre-wrap;word-break:break-all;height:650px;overflow:hidden"></pre>
<script>const L={body};let i=0;function t(){{if(i<L.length){{o.innerHTML+=L[i++]+"\\n";o.scrollTop=o.scrollHeight;setTimeout(t,{int(step*1000)})}}}}setTimeout(t,300)</script></body></html>'''
card1=r'''<html><body style="margin:0;width:1280px;height:720px;background:radial-gradient(#1e1b4b,#030712);color:#fff;font-family:DejaVu Sans,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
<div style="font-size:84px">🧠</div><div style="font-size:64px;font-weight:bold">Hippocampus</div>
<div style="font-size:28px;margin-top:18px;color:#c7d2fe;max-width:1000px">Long-term memory for Alexa+ that sleeps, forgets gracefully,<br>and never loses you.</div>
<div style="font-size:18px;margin-top:30px;color:#94a3b8">MCP server · activation recall · sleep consolidation · graded compression</div></body></html>'''
card9=r'''<html><body style="margin:0;width:1280px;height:720px;background:radial-gradient(#1e1b4b,#030712);color:#fff;font-family:DejaVu Sans,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center">
<div style="font-size:52px;font-weight:bold">🧠 Hippocampus</div>
<ul style="font-size:26px;line-height:1.7;color:#e0e7ff;margin-top:24px">
<li>Stateful across sessions</li><li>Agentic memory tools over MCP (2025-11-25)</li><li>Spreading-activation recall</li><li>Sleep consolidation into schemas</li><li>Graded compression with per-pass reports</li><li>Never deletes · never unrecoverable</li><li>Compact index: ~65 B per memory, zstd-compressed</li></ul>
<div style="font-size:26px;margin-top:20px;color:#fde047">github.com/denyanna7-design/hippocampus-memory</div>
<div style="font-size:18px;color:#94a3b8;margin-top:8px">Open source · MIT</div></body></html>'''
async def rec(b,i,fn):
    ctx=await b.new_context(viewport={'width':1280,'height':720},record_video_dir=f'{W}/raw{i}',record_video_size={'width':1280,'height':720})
    p=await ctx.new_page(); await fn(p); await ctx.close()
    f=os.listdir(f'{W}/raw{i}')[0]; os.replace(f'{W}/raw{i}/{f}',f'{W}/v{i}.webm')
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch()
        if PHASE=='budget':
            async def s8(p):
                await p.goto('http://localhost:3000/'); await p.wait_for_timeout(int(dur[8]*0.45*1000)+1500)
            await rec(b,'8b',s8)
        elif PHASE=='browser':
            async def s4(p):
                await p.goto('http://localhost:3000/'); await p.wait_for_timeout(3000)
                await p.fill('#c','What does my daughter love?'); await p.wait_for_timeout(1200)
                await p.click('button:text-is("recall")'); await p.wait_for_timeout(6000)
                await p.fill('#c','When does Mia swim?'); await p.wait_for_timeout(1000)
                await p.click('button:text-is("recall")'); await p.wait_for_timeout(int(dur[4]*1000)-10000)
            await rec(b,4,s4)
            async def s7(p):
                await p.goto('http://localhost:3000/'); await p.wait_for_timeout(2500)
                await p.click('text=preview pass'); await p.wait_for_timeout(3500)
                for _ in range(2):
                    await p.click('text=+7 days'); await p.wait_for_timeout(2500)
                await p.wait_for_timeout(int(dur[7]*1000)-10500)
            await rec(b,7,s7)
        else:
            pg=await b.new_page(viewport={'width':1280,'height':720})
            await pg.set_content(card1); await pg.screenshot(path=f'{W}/v1.png')
            await pg.set_content(card9); await pg.screenshot(path=f'{W}/v9.png')
            for i,lines in term.items():
                if ONLY and str(i)!=ONLY: continue
                d=dur[i]*(0.55 if i==8 else 1)
                async def f(p,lines=lines,d=d):
                    await p.set_content(termpage(lines,d)); await p.wait_for_timeout(int(d*1000)+500)
                await rec(b,i,f)
        await b.close()
    json.dump(dur,open(f'{W}/dur.json','w'))
asyncio.run(main())
