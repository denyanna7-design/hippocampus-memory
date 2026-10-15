import asyncio, json, html, subprocess, os, re
from playwright.async_api import async_playwright
import sys
W='/workspace/amazon-hackathon/submission/video/work5'
PHASE=sys.argv[1]
ONLY=sys.argv[2] if len(sys.argv)>2 else None
dur={}
for i in range(1,10):
    d=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f'{W}/audio/{i}.mp3']))
    dur[i]=round(d+1.3,2)
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
 6:full[s3:s3+3]+['   '+trim(full[s3+3].strip(),130), lunch,'']+full[idx('👤 When is Grandpa',s3):idx('👤 When is Grandpa',s3)+3]+['',full[-1]],
 8:['$ MEMORY_BUDGET_BYTES=5000 npm start   # terminal A','$ npm run alexa:demo -- --chat']+[l for l in chat if l.strip() and not l.startswith('you> ') or l.startswith('you> I')][:5],
}
term[8]=[trim(l,330) for l in term[8]]
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
    return f'''<html><body style="margin:0;background:#0b1020;color:#e5e7eb;font:18px/1.5 'DejaVu Sans Mono',monospace">
<div style="height:30px;background:#1f2937;color:#9ca3af;padding:6px 14px;box-sizing:border-box;font-size:13px">● ● ●  terminal — hippocampus-memory</div>
<pre id=o style="margin:0;padding:14px 18px;white-space:pre-wrap;word-break:break-all;height:650px;overflow:hidden"></pre>
<script>const L={body};let i=0;function t(){{if(i<L.length){{o.innerHTML+=L[i++]+"\\n";o.scrollTop=o.scrollHeight;setTimeout(t,{int(step*1000)})}}}}setTimeout(t,300)</script></body></html>'''

BG="margin:0;width:1280px;height:720px;overflow:hidden;background:radial-gradient(circle at 50% 45%,#1e1b4b,#030712 70%);color:#fff;font-family:DejaVu Sans,sans-serif"
NEURONS="""<canvas id=cv width=1280 height=720 style="position:absolute;inset:0"></canvas><script>
const cv=document.getElementById('cv'),x=cv.getContext('2d');const N=70,P=[...Array(N)].map((_,i)=>({x:Math.random()*1280,y:Math.random()*720,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6}));
let sp=[];setInterval(()=>{const a=P[Math.floor(Math.random()*N)];const b=P.reduce((m,p)=>p!==a&&Math.hypot(p.x-a.x,p.y-a.y)<Math.hypot(m.x-a.x,m.y-a.y)&&p!==a?p:m,P[(P.indexOf(a)+1)%N]);sp.push({a,b,t:0})},180);
(function f(){x.clearRect(0,0,1280,720);for(const p of P){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>1280)p.vx*=-1;if(p.y<0||p.y>720)p.vy*=-1}
for(let i=0;i<N;i++)for(let j=i+1;j<N;j++){const d=Math.hypot(P[i].x-P[j].x,P[i].y-P[j].y);if(d<150){x.strokeStyle=`rgba(167,139,250,${.18*(1-d/150)})`;x.beginPath();x.moveTo(P[i].x,P[i].y);x.lineTo(P[j].x,P[j].y);x.stroke()}}
for(const p of P){x.fillStyle='rgba(196,181,253,.55)';x.beginPath();x.arc(p.x,p.y,2.2,0,7);x.fill()}
for(const s of sp){s.t+=.03;const px=s.a.x+(s.b.x-s.a.x)*s.t,py=s.a.y+(s.b.y-s.a.y)*s.t;const g=x.createRadialGradient(px,py,0,px,py,14);g.addColorStop(0,'rgba(255,250,200,1)');g.addColorStop(1,'rgba(253,224,71,0)');x.fillStyle=g;x.beginPath();x.arc(px,py,14,0,7);x.fill()}
sp=sp.filter(s=>s.t<1);requestAnimationFrame(f)})();</script>"""
ANIM="<style>@keyframes up{from{opacity:0;transform:translateY(24px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}.a{opacity:0;animation:up .9s cubic-bezier(.2,.8,.2,1) forwards}@keyframes glow{50%{text-shadow:0 0 30px #a78bfa,0 0 60px #6366f1}}</style>"
card1=f"""<html><head>{ANIM}</head><body style="{BG}">{NEURONS}<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
<div class=a style="font-size:90px;animation-delay:.2s">🧠</div><div class=a style="font-size:68px;font-weight:bold;animation:up .9s .6s forwards,glow 2.4s 1.5s infinite">Hippocampus</div>
<div class=a style="font-size:28px;margin-top:18px;color:#c7d2fe;animation-delay:1.3s">Long-term memory for Alexa+ that sleeps, forgets gracefully,<br>and never loses you.</div>
<div class=a style="font-size:18px;margin-top:30px;color:#94a3b8;animation-delay:2.1s">MCP server · activation recall · sleep consolidation · graded compression</div></div></body></html>"""
items=["Stateful across sessions","Agentic memory tools over MCP (2025-11-25)","Spreading-activation recall","Sleep consolidation into schemas","Graded compression with per-pass reports","Never deletes · never unrecoverable"]
import qrcode, qrcode.image.svg, io
_q=qrcode.make("https://github.com/denyanna7-design/hippocampus-memory",image_factory=qrcode.image.svg.SvgPathImage,box_size=7,border=2);_b=io.BytesIO();_q.save(_b)
QR=f"""<style>@keyframes qr{{0%{{opacity:0;transform:scale(.3) rotate(-20deg);filter:blur(10px)}}100%{{opacity:1;transform:none}}}}@keyframes scan{{0%{{top:0}}100%{{top:100%}}}}</style>
<div style="position:absolute;right:70px;bottom:70px;width:170px;height:170px;background:#fff;border-radius:14px;padding:10px;box-shadow:0 0 40px #a78bfa88;opacity:0;animation:qr 1s 1.9s cubic-bezier(.2,.8,.2,1) forwards;overflow:hidden">
<div style="width:100%;height:100%">{_b.getvalue().decode().split('?>',1)[-1].replace('<svg ','<svg width="100%" height="100%" ')}</div><div style="position:absolute;left:0;right:0;height:3px;background:#a78bfa;box-shadow:0 0 12px #a78bfa;animation:scan 1.6s 2.8s ease-in-out 2 alternate"></div></div>
<div style="position:absolute;right:70px;bottom:40px;width:190px;text-align:center;color:#94a3b8;font-size:14px;opacity:0;animation:qr .6s 2.3s forwards">scan for the repo</div>"""
card9=f"""<html><head>{ANIM}</head><body style="{BG}">{NEURONS}<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center">
<div class=a style="font-size:52px;font-weight:bold;animation:up .8s .1s forwards,glow 2.4s 1s infinite">🧠 Hippocampus</div><ul style="font-size:26px;line-height:1.7;color:#e0e7ff;margin-top:20px">
{''.join(f'<li class=a style="animation-delay:{.3+i*.18:.2f}s">{t}</li>' for i,t in enumerate(items))}</ul>
<div class=a style="font-size:26px;margin-top:16px;color:#fde047;animation-delay:1.5s">github.com/denyanna7-design/hippocampus-memory</div>
<div class=a style="font-size:18px;color:#94a3b8;margin-top:8px;animation-delay:1.8s">Open source · MIT</div></div>{QR}</body></html>"""
TIERS=[("hot","1–2×","lossless",1,2,1.0,1.0,"#60a5fa"),("warm","2.5–4×","lossless",2.5,4,2.9,1.0,"#a78bfa"),("cool","5–8×","ROUGE-L ≥ 0.90",5,8,5.2,0.93,"#f472b6"),("cold","8–15×","ROUGE-L ≥ 0.65",8,15,8.9,0.75,"#9ca3af")]
bars=''.join(f"""<div style="display:flex;align-items:center;margin:20px 0"><div style="width:90px;font-size:26px;color:{c}">{n}</div>
<div style="position:relative;width:760px;height:46px;background:#0b1020;border-radius:8px;border:1px solid #1f2937">
<div style="position:absolute;left:{lo/16*760}px;width:{(hi-lo)/16*760}px;top:0;bottom:0;background:{c}22;border-left:2px dashed {c}88;border-right:2px dashed {c}88"></div>
<div class=bar data-r="{r}" style="position:absolute;left:0;top:8px;height:30px;width:0;background:linear-gradient(90deg,{c}55,{c});border-radius:6px;box-shadow:0 0 18px {c}88;transition:width 2.2s cubic-bezier(.2,.8,.2,1) {0.5+i*0.6}s"></div></div>
<div style="width:300px;padding-left:18px"><span class=num data-r="{r}" data-d="{0.5+i*0.6}" style="font:700 30px DejaVu Sans Mono,monospace">0.0×</span>
<div style="font-size:15px;color:#94a3b8">target {t} · {fl}{'' if f==1 else f' · mean fidelity {f}'}</div></div></div>""" for i,(n,t,fl,lo,hi,r,f,c) in enumerate(TIERS))
chart=f"""<html><head>{ANIM}</head><body style="{BG};background:#070a12"><div style="padding:40px 70px">
<div class=a style="font-size:34px;font-weight:bold">Graded compression per tier</div>
<div class=a style="font-size:18px;color:#94a3b8;margin-top:6px;animation-delay:.2s">best measured ratio per tier · test corpus: 290 memories, 60 days + 1 simulated year · dashed band = target</div>
<div style="margin-top:24px">{bars}</div>
<div class=a style="font-size:22px;margin-top:14px;animation-delay:3.4s">content <b style="color:#fde047" id=tot>47.9 KB</b> → <b style="color:#fde047">5.6 KB</b> &nbsp;(8.6×) · important memories byte-exact · 0 unrecoverable</div></div>
<script>setTimeout(()=>document.querySelectorAll('.bar').forEach(b=>b.style.width=(b.dataset.r/16*760)+'px'),100);
document.querySelectorAll('.num').forEach(el=>{{const r=+el.dataset.r,d=+el.dataset.d*1000+100;const t0=performance.now()+d;(function f(n){{const t=Math.max(0,Math.min(1,(n-t0)/2200));const e=1-Math.pow(1-t,3);el.textContent=(r*e).toFixed(1)+'×';if(t<1)requestAnimationFrame(f)}})(performance.now())}});</script></body></html>"""

CAP={3:"Stateful across sessions: every turn is a new MCP session",4:"Mammal-like recall: spreading activation + Hebbian + spacing",
 5:"Sleep consolidation: schemas + graded compression",6:"Lossy only within measured fidelity floors · salient = byte-exact",
 7:"Replay · consolidate · compress · decay to cold · nothing deleted",8:"Never deletes, never unrecoverable: budget alert asks the user"}
CAPJS=r"""(t)=>{const d=document.createElement('div');d.id='kcap';d.style.cssText='position:fixed;left:0;right:0;bottom:46px;display:flex;justify-content:center;z-index:99;pointer-events:none';
const pill=document.createElement('div');pill.style.cssText='padding:10px 26px;border-radius:999px;background:linear-gradient(90deg,#0b1020e6,#1e1b4be6);border:1px solid #a78bfa66;box-shadow:0 0 30px #6366f155;font:700 25px DejaVu Sans,system-ui,sans-serif;color:#fff;letter-spacing:.01em;opacity:0;transform:scaleX(.6);transition:all .35s cubic-bezier(.2,.8,.2,1)';
const st=document.createElement('style');st.textContent='@keyframes kw{0%{opacity:0;transform:translateY(18px);filter:blur(6px)}100%{opacity:1;transform:none;filter:none}}.kw{display:inline-block;opacity:0;animation:kw .55s cubic-bezier(.2,.8,.2,1) forwards;margin-right:.28em}.kw.h{color:#fde047;text-shadow:0 0 14px #fde04788}';document.head.appendChild(st);
t.split(' ').forEach((w,i)=>{const s=document.createElement('span');s.className='kw'+(/^(Stateful|recall:|Sleep|Lossy|byte-exact|Never|nothing|Replay|deleted|unrecoverable:)/.test(w)?' h':'');s.textContent=w;s.style.animationDelay=(.05+i*.07)+'s';pill.appendChild(s)});
d.appendChild(pill);document.body.appendChild(d);requestAnimationFrame(()=>{pill.style.opacity=1;pill.style.transform='none'})}"""
async def caption(p,i,delay=900):
    if i in CAP:
        await p.wait_for_timeout(delay); await p.evaluate(CAPJS, CAP[i])

async def rec(b,i,fn):
    ctx=await b.new_context(viewport={'width':1280,'height':720},record_video_dir=f'{W}/raw{i}',record_video_size={'width':1280,'height':720})
    p=await ctx.new_page(); await fn(p); await ctx.close()
    f=os.listdir(f'{W}/raw{i}')[0]; os.replace(f'{W}/raw{i}/{f}',f'{W}/v{i}.webm')
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch()
        if PHASE=='budget':
            async def s8(p):
                await p.goto('http://localhost:3000/'); await caption(p,8,300); await p.wait_for_timeout(int(dur[8]*0.45*1000)+1200)
            await rec(b,'8b',s8)
        elif PHASE=='browser':
            async def s4(p):
                await p.goto('http://localhost:3000/'); await caption(p,4); await p.wait_for_timeout(2100)
                await p.fill('#c','What does my daughter love?'); await p.wait_for_timeout(1200)
                await p.click('#rb'); await p.wait_for_timeout(7500)
                await p.fill('#c','When does Mia swim?'); await p.wait_for_timeout(1000)
                await p.click('#rb'); await p.wait_for_timeout(max(1000,int(dur[4]*1000)-11700))
            await rec(b,4,s4)
            async def s7(p):
                await p.goto('http://localhost:3000/'); await caption(p,7); await p.wait_for_timeout(1600)
                await p.click('text=preview pass'); await p.wait_for_timeout(2500)
                await p.click('#sb'); await p.wait_for_timeout(7600)
                await p.click('#kb'); await p.wait_for_timeout(max(1500,int(dur[7]*1000)-12600))
            await rec(b,7,s7)
        else:
            for i,html_ in ((1,card1),(9,card9),(5,chart)):
                if ONLY and str(i)!=ONLY: continue
                async def f(p,h=html_,d=dur[i],i=i):
                    await p.set_content(h); await caption(p,i); await p.wait_for_timeout(int(d*1000)-400)
                await rec(b,i,f)
            for i,lines in term.items():
                if ONLY and str(i)!=ONLY: continue
                d=dur[i]*(0.55 if i==8 else 1)
                async def f(p,lines=lines,d=d,i=i):
                    await p.set_content(termpage(lines,d)); await caption(p,i); await p.wait_for_timeout(int(d*1000)-400)
                await rec(b,i,f)
        await b.close()
    json.dump(dur,open(f'{W}/dur.json','w'))
asyncio.run(main())
