import json, subprocess, os
F='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; X=0.6
CAP={3:"Stateful across sessions: every turn is a new MCP session",4:"Mammal-like recall: spreading activation + Hebbian + spacing",
 5:"Sleep consolidation: schemas + graded compression",6:"Lossy only within measured fidelity floors · salient = byte-exact",
 7:"Preview · sleep consolidation · decay to cold · nothing deleted",8:"Never deletes, never unrecoverable: budget alert asks the user"}
dur={int(k):v for k,v in json.load(open('dur.json')).items()}
run=lambda *a: subprocess.run(a,check=True)
for i in range(1,10):
    src=f'v{i}.webm'
    if i==8:
        run('ffmpeg','-y','-v','error','-i','v8.webm','-i','v8b.webm','-filter_complex','[0:v]scale=1280:720,fps=30,setsar=1[a];[1:v]scale=1280:720,fps=30,setsar=1[b];[a][b]concat=n=2:v=1[v]','-map','[v]','-c:v','libx264','-crf','18','v8.mp4'); src='v8.mp4'
    vf=f"scale=1280:720,fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=10,trim=duration={dur[i]}"
    if False:
        open(f'cap{i}.txt','w').write(CAP[i])
        # caption slides/fades in after 0.8s
        vf+=(f",drawbox=y=640:w=iw:h=56:color=black@0.7:t=fill:enable='gte(t,0.8)'"
             f",drawtext=fontfile={F}:textfile=cap{i}.txt:fontcolor=white:fontsize=24:x=(w-tw)/2:y=656+max(0\\,(1.3-t)*60):alpha='min(1,max(0,(t-0.8)/0.5))'")
    run('ffmpeg','-y','-v','error','-i',src,'-vf',vf+',format=yuv420p','-an','-c:v','libx264','-crf','19','-preset','medium',f's{i}.mp4')
# xfade chain
ins=[]; [ins.extend(['-i',f's{i}.mp4']) for i in range(1,10)]
trans=['fadewhite','smoothleft','circleopen','zoomin','smoothup','fade','radial','fadeblack']
fc=[]; prev='[0:v]'; off=0
for k in range(1,9):
    off+=dur[k]-X; out=f'[x{k}]'
    fc.append(f'{prev}[{k}:v]xfade=transition={trans[k-1]}:duration={X}:offset={off:.3f}{out}'); prev=out
starts=[0]; 
for k in range(1,9): starts.append(starts[-1]+dur[k]-X)
for k in range(9):
    ins.extend(['-i',f'audio/{k+1}.mp3'])
    fc.append(f'[{9+k}:a]aresample=44100,adelay={int((starts[k]+0.35)*1000)}:all=1[a{k}]')
fc.append(''.join(f'[a{k}]' for k in range(9))+'amix=inputs=9:normalize=0,apad[a]')
run('ffmpeg','-y','-v','error',*ins,'-filter_complex',';'.join(fc),'-map',prev,'-map','[a]','-c:v','libx264','-crf','20','-c:a','aac','-b:a','160k','-t',f'{starts[-1]+dur[9]:.2f}','../demo-v4.mp4')
json.dump({'starts':starts},open('starts.json','w'))
