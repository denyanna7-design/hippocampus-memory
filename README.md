# Amazon Developer Hackathon: Alexa+ track starter

Deadline: Oct 23, 2026 12:00 PT (Oct 24 03:00 Asia/Shanghai).

## What's here
- `src/server.ts`: an MCP server (spec **2025-11-25**, **Streamable HTTP**, stateless) at `POST /mcp`. It has one tool, `hello`.
- `src/client-test.ts`: a smoke test that connects, lists the tools, and calls `hello`.
- `.venv`: Python with boto3, strands-agents, and mcp, for the AWS Builder mini challenge (Bedrock/Strands).
- `.tools/bin/aws`: AWS CLI v2. Add it to your PATH with `export PATH=$PWD/.tools/bin:$PATH`.

## Run
    npm install
    npm start          # http://localhost:3000/mcp
    npm test           # in a second terminal
    npm run typecheck
For an interactive check, use `npx @modelcontextprotocol/inspector`, pick Streamable HTTP, and enter http://localhost:3000/mcp.

## Next steps
1. Pick an idea. Judges look for stateful, multi-step, agentic workflows, plus cards/media, MCP Apps, or Agent Skills.
2. Add your real tools, resources, and prompts in `buildServer()`. Persist state across sessions, for example in DynamoDB or SQLite.
3. Optional AWS Builder: call Bedrock via a Strands agent, and document it in the README and the feedback.
4. Deploy publicly (self-hosted), e.g. Lambda + Function URL or App Runner. Alternatively, add a web "simulated Alexa+" UI.
5. Submission: a GitHub repo (public + LICENSE, or private + collaborators), a demo video under 3 minutes in English (YouTube/Vimeo), product feedback, and a friction log (up to +10%).
6. Optional Open Source: open a PR to an MCP SDK or a sample repo.
