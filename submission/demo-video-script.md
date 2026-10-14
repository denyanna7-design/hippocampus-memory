# Demo video script: "Hippocampus: a memory that sleeps" (target 2:50, hard limit < 3:00)

**Format:** screen recording at 1920×1080. Left 60%: browser at `http://localhost:3000/` (brain view). Right 40%: terminal. English voice-over, no music (or royalty-free only), no third-party logos except a plain "Alexa+" mention in narration and title text.

## Pre-flight (off camera)
```bash
cd amazon-hackathon && export PATH=$HOME/.local/node22/bin:$PATH   # Node ≥ 22.15
rm -rf data/memory
npm start                                   # terminal A (keep hidden, or a small window)
# Browser: open http://localhost:3000/ and zoom to 110%
# Terminal B (visible): font 16pt, cleared
```
Rehearse once with `DEMO_PACE=0 npm run alexa:demo:video` to warm caches. Then run `rm -rf data/memory` and restart `npm start` before the real take.

## Shot list

| # | Time | Screen / action | Narration |
|---|---|---|---|
| 1 | 0:00–0:12 | Title card: **Hippocampus: long-term memory for Alexa+ that sleeps, forgets gracefully, and never loses you.** Then cut to the empty brain view. | "Assistants forget everything between conversations, or they stuff whole transcripts back into the context window. Brains do neither. So I built Alexa+ a hippocampus." |
| 2 | 0:12–0:25 | Terminal B: `npm run alexa:demo:video`. Two weeks of everyday memories (52 after the script) streams in; nodes appear and edges form in the browser. | "This is a self-hosted MCP server, spec 2025-11-25 over Streamable HTTP. A simulated Alexa+ client feeds it a month of ordinary life: standups, commutes, lunches, journals." |
| 3 | 0:25–0:50 | Session 1 banner. Point at the 🔧 `remember` lines. When "Important: Grandpa's hospital checkup…" appears, highlight `salience=0.9`. Then "Good night" prints a `sleep()` report. | "Every turn opens a brand-new MCP session, just like a new Alexa conversation. Memories are written as files, not context. Emotional or important things get high salience, and those are protected forever: always stored byte-exact. When the user says good night, the agent sleeps." |
| 4 | 0:50–1:15 | Session 2 ("Thursday"). The browser flashes yellow on recall: the cue nodes light up, then their neighbours. Terminal shows `recall → … (cue, a=1) … (spread …)`. | "Days later, in a fresh session: 'What does Mia love?' Recall is spreading activation. The cue lights up matching memories, activation flows along association edges, and only what crosses a threshold comes back. Memories recalled together wire together: Hebbian learning. And each recall makes a memory stronger: the spacing effect." |
| 5 | 1:15–1:40 | Terminal scrolls to the session-1/2 `sleep()` report (tier table). Zoom on the hot/warm/cool/cold rows: target, expected, after, ROUGE-L, algorithms. | "During sleep, similar episodes are consolidated into schemas, prototype memories, like the neocortex does. Then every memory is placed in a tier by how well it's remembered. Hot and warm are lossless: zstd with a dictionary trained on your own memories, delta encoding, dedup. Every pass prints a report: the target ratio, what we expected, what we got, and the measured fidelity." |
| 6 | 1:40–2:10 | Session 3 ("two months later"). Highlight "If I remember right (details may have faded)" and `fidelity 0.93`. Then highlight Grandpa's answer, which is word for word. | "Two months later, routine lunches have faded into the cool tier: stored as the lunch schema plus only the important differences. Recall is a reconstruction, at least 90% faithful, and Alexa says so honestly. Notice it can even blend details, just like a real memory. But Grandpa's checkup, high salience, comes back exactly: November 3rd, 9am, ward 7B." |
| 7 | 2:10–2:25 | Browser: click **🔍 preview pass** (dry-run report in the side panel), then **⏩ +7 days** three times. Nodes turn grey (cold) and the stats panel ratio climbs. | "I can preview the next compression pass before anything is written. Skip ahead and memories drift to the cold tier: a shared archive of schemas plus key residuals. Across a year of simulated life the store shrinks about nine times, and nothing is deleted." |
| 8 | 2:25–2:40 | Terminal A: Ctrl-C, then `MEMORY_BUDGET_BYTES=5000 npm start`. Terminal B: `npm run alexa:demo -- --chat`, type `I parked on level 3, spot B12`. The ⚠️ MEMORY BUDGET ALERT line prints and the stats panel turns red. | "And when storage runs out? It never silently deletes. It pushes memories to their deepest allowed tier, and if that's still not enough, Alexa asks you what to do." |
| 9 | 2:40–2:52 | Final card: architecture diagram (README) and bullets: *stateful across sessions · agentic memory tools · activation recall · sleep consolidation · graded compression with reports · never unrecoverable*. Repo URL. | "Hippocampus: memory that sleeps, forgets gracefully, and never loses you. Open source, MIT. Thanks for watching." |

## Exact demo-page controls (right-hand panel)
- **remember…** text box + salience number box → **remember** button (calls `POST /api/remember`, which uses the same engine as the MCP tool)
- **recall cue…** text box → **recall** button (the graph flashes yellow; winners get a white border)
- **😴 sleep** → full consolidation pass; the report JSON appears in the panel
- **🔍 preview pass** → dry-run report text, nothing written
- **⏩ +7 days** → moves the demo clock forward 7 days and runs a compression pass
- Node colours: blue = hot, purple = warm, pink = cool, grey = cold; ◆ = schema. Labels appear only on recalled memories, schemas and salient memories; hover over a dot to see its keywords, storage algorithm, retention and salience. The stats panel turns red when over budget.

## Criteria callouts (put as lower-third captions)
- 0:25 "Stateful across sessions: every turn is a new MCP session"
- 0:50 "Mammal-like recall: spreading activation + Hebbian + spacing"
- 1:15 "Sleep consolidation: schemas + graded compression"
- 1:30 "Per-pass compression report: target vs expected vs actual"
- 1:55 "Lossy only within measured fidelity floors; salient = byte-exact"
- 2:25 "Never deletes, never unrecoverable: budget alert asks the user"

## Recording tips
- If timing runs long, cut shot 7 down to a single +7 days click. Shot 8 can be pre-recorded.
- Set `DEMO_PACE=1.5` to slow the simulator for narration, or `DEMO_PACE=0` for B-roll.
- Upload to YouTube or Vimeo as **public**; title it "Hippocampus – Alexa+ memory MCP server (Amazon Developer Hackathon)".


## Rendered draft
`submission/video/demo-v2.mp4` (2:23, 1280×720) is rendered from `narration-v2.txt` with the `en-US-AndrewNeural` voice, using `video/work2/record.py` and `build.sh`. The MP4 is gitignored. Changes from the table above: in shot 4 the question is "What does my daughter love?", the weekly-sync question is skipped in curated mode, and shot 8 ends on the stats panel turning red (content 1.2 KB + dictionary 1.0 KB + index 3.6 KB = 5.8 KB, over the 4.9 KB budget).
