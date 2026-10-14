# Submission package: Amazon Developer Hackathon (Alexa+ track)

Deadline: **Oct 23, 2026 12:00 PT = Oct 24, 2026 03:00 Asia/Shanghai**.

| File | Use it for |
|---|---|
| `demo-video-script.md` | Shot list, timings, narration, exact commands and clicks (< 3:00) |
| `devpost-description.md` | Paste into the Devpost project story fields |
| `product-feedback.md` | The required "Product Feedback" field (each tool: used for / worked well / needs work / onboarding / again?) plus feature requests |
| `friction-log.md` | The optional friction log (up to a 10% judging bonus): task, steps, expected vs actual, severity, workaround, suggestion |
| `aws-deployment-plan.md` | Optional hosting on AWS: exact steps needing your login, plus cost |

## Checklist
- [ ] Create a GitHub repo and push this project (⚠️ your GitHub login). Make it **public** with the MIT `LICENSE` showing in the About section, or private and shared with the Amazon reviewers listed in the rules.
- [ ] Record the video following `demo-video-script.md`, then upload it to YouTube or Vimeo as **public** (⚠️ your login).
- [ ] Devpost → "Enter a Submission" (⚠️ your login): track **Alexa+**, repo URL, video URL, description, product feedback, friction log. Mini challenges: none, unless the Bedrock or open-source extras get done.
- [ ] Optional: deploy per `aws-deployment-plan.md` and add the live URL.

## Rule compliance notes
- Self-hosted MCP server, spec **2025-11-25**, over **Streamable HTTP**: `src/server.ts` (verified by `npm run smoke`, which prints `protocol: 2025-11-25`).
- The MCP SDK is imported and called at runtime: `src/server.ts` (server) and `src/alexa-sim.ts` / `src/client-test.ts` (client).
- Setup and run instructions are in the root `README.md`. License: MIT (`LICENSE`).
- The simulated Alexa+ experience (allowed by the rules) is in `src/alexa-sim.ts`, and its source is included.
