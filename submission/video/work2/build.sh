set -e
F=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
declare -A CAP=([3]="Stateful across sessions: every turn is a new MCP session" [4]="Mammal-like recall: spreading activation + Hebbian + spacing" [5]="Sleep consolidation: schemas + graded compression, per-pass report" [6]="Lossy only within measured fidelity floors · salient = byte-exact" [7]="Preview before writing · compact zstd index · nothing deleted" [8]="Never deletes, never unrecoverable: budget alert asks the user")
for i in 1 2 3 4 5 6 7 8 9; do
 d=$(python3 -c "import json;print(json.load(open('dur.json'))['$i'])")
 if [ -f v$i.png ]; then IN="-loop 1 -t $d -i v$i.png"; elif [ $i = 8 ]; then ffmpeg -y -v error -i v8.webm -i v8b.webm -filter_complex "[0:v]scale=1280:720,fps=30,setsar=1[a];[1:v]scale=1280:720,fps=30,setsar=1[b];[a][b]concat=n=2:v=1[v]" -map "[v]" -c:v libx264 -crf 18 v8.mp4; IN="-i v8.mp4"; else IN="-i v$i.webm"; fi
 VF="scale=1280:720,fps=30,tpad=stop_mode=clone:stop_duration=10,trim=duration=$d"
 if [ -n "${CAP[$i]}" ]; then
  echo -n "${CAP[$i]}" > cap$i.txt
  VF="$VF,drawbox=y=640:w=iw:h=56:color=black@0.7:t=fill,drawtext=fontfile=$F:textfile=cap$i.txt:fontcolor=white:fontsize=24:x=(w-tw)/2:y=656"
 fi
 ffmpeg -y -v error $IN -i audio/$i.mp3 -filter_complex "[0:v]$VF,format=yuv420p[v];[1:a]apad,atrim=duration=$d,aresample=44100[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k -ac 2 seg$i.mp4
 echo "file seg$i.mp4" >> list.tmp
done
mv list.tmp list.txt
ffmpeg -y -v error -f concat -safe 0 -i list.txt -c copy ../demo-v2.mp4
