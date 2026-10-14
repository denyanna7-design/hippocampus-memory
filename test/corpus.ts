// Realistic-ish personal-assistant memory corpus (seeded, deterministic): routines that repeat with
// variations (the stuff brains schematise), plus one-off events, Chinese notes and high-salience moments.
export interface Mem { day: number; text: string; salience: number }
export function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
export function corpus(days = 60, seed = 7): Mem[] {
  const r = rng(seed); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const people = ["Chen Wei", "Priya", "Marcus", "Dr. Lim", "Sofia", "Tom"];
  const tasks = ["the billing service retry bug", "the Alexa+ memory server", "the onboarding flow", "flaky CI tests", "the GraphQL schema migration", "the Redis cache eviction issue", "the hackathon demo video"];
  const foods = ["beef noodles", "a chicken rice bowl", "dumplings", "a tuna sandwich", "laksa", "salad and soup", "mapo tofu"];
  const weather = ["cloudy, 18C", "light rain, 16C", "sunny, 24C", "humid, 29C", "windy, 14C"];
  const moods = ["focused", "tired", "a bit stressed", "energetic", "calm"];
  const out: Mem[] = [];
  for (let d = 0; d < days; d++) {
    const wk = d % 7 < 5;
    if (wk) out.push({ day: d, salience: 0.2, text: `Standup, day ${d + 1}. Yesterday I worked on ${pick(tasks)}. Today I plan to work on ${pick(tasks)} and review ${pick(people)}'s pull request. Blockers: ${pick(["none", "waiting on API keys", "staging is down", "none"])}. Mood: ${pick(moods)}.` });
    if (wk) out.push({ day: d, salience: 0.1, text: `Commute: took metro line ${pick(["2", "3", "4"])} at ${pick(["8:05", "8:20", "8:35"])}, ${pick(["packed", "quiet", "delayed 10 minutes", "normal"])}. Weather in Nanjing: ${pick(weather)}. Listened to ${pick(["a podcast about databases", "lo-fi music", "an audiobook", "the news"])}.` });
    out.push({ day: d, salience: 0.1, text: `Lunch: ${pick(foods)} at ${pick(["the canteen", "the noodle place downstairs", "my desk", "the food court"])}, cost ${18 + Math.floor(r() * 30)} yuan. ${pick(["Ate with " + pick(people) + ".", "Ate alone.", "Ate quickly before a meeting."])}` });
    if (r() < 0.5) out.push({ day: d, salience: 0.15, text: `Gym: ${pick(["ran", "cycled", "rowed"])} ${(3 + r() * 5).toFixed(1)} km in ${20 + Math.floor(r() * 20)} minutes, then ${pick(["stretching", "core work", "light weights"])}. Heart rate avg ${130 + Math.floor(r() * 30)}. Felt ${pick(moods)}.` });
    if (r() < 0.3) out.push({ day: d, salience: 0.3, text: `Meeting with ${pick(people)} about ${pick(tasks)}. Decided to ${pick(["ship behind a feature flag", "add more logging first", "split it into two PRs", "postpone to next sprint"])}. Follow-up on ${pick(["Monday", "Wednesday", "Friday"])}.` });
    if (r() < 0.25) out.push({ day: d, salience: 0.2, text: `今天${pick(["去超市买了", "网上订了"])}${pick(["牛奶和鸡蛋", "水果和面包", "洗衣液和纸巾", "大米和蔬菜"])}，花了${30 + Math.floor(r() * 120)}元。${pick(["晚上给妈妈打了电话。", "晚上在家看书。", "晚上加班到十点。"])}` });
    out.push({ day: d, salience: 0.25, text: `Evening journal, day ${d + 1}. Today was ${pick(["productive", "long", "quiet", "chaotic", "pretty good", "exhausting"])}. In the morning I ${pick(["went for a short run along the river", "overslept and skipped breakfast", "read two chapters of my book", "cleaned the flat"])}. At work I spent most of the time on ${pick(tasks)}${pick([", and finally found the root cause", ", but progress was slow", " together with " + pick(people), ", and wrote a design doc"])}. ${pick(["Had a good chat with " + pick(people) + " about career plans.", "Felt a bit lonely in the afternoon.", "Got positive feedback in code review.", "The team lunch was fun."])} For dinner I had ${pick(foods)} ${pick(["at home", "with friends", "from delivery", "at the night market"])}. ${pick(["I should sleep earlier.", "I want to spend less time on my phone.", "Grateful for my family.", "Need to start preparing the exchange paperwork."])} Tomorrow I want to ${pick(["finish the PR", "call grandma", "go to the gym", "study for the exam", "plan the trip to Singapore"])}. Sleep target: ${pick(["23:00", "23:30", "00:00"])}.` });
    if (d % 7 === 4) out.push({ day: d, salience: 0.3, text: `Weekly sync notes, week ${Math.floor(d / 7) + 1}. Attendees: ${[pick(people), pick(people), pick(people)].join(", ")}. 1) Status: ${pick(tasks)} is ${pick(["on track", "slightly behind", "blocked", "done"])}; ${pick(tasks)} is ${pick(["on track", "slightly behind", "in review"])}. 2) Risks: ${pick(["staging capacity", "unclear requirements from product", "a dependency upgrade", "holiday absences"])}. 3) Decisions: we will ${pick(["freeze features on Friday", "move the release by one week", "add an on-call rotation", "drop the legacy endpoint"])}. 4) Action items: ${pick(people)} will ${pick(["update the runbook", "write the migration script", "contact the vendor"])} by ${pick(["Monday", "Wednesday", "Friday"])}; I will ${pick(["fix the flaky tests", "prepare the demo", "review the dashboards"])}.` });
    if (d % 9 === 4) out.push({ day: d, salience: 0.9, text: pick([
      "Got the email: I'm accepted to the NUS exchange programme starting January. Mum cried on the phone. I need to apply for the student pass before Nov 30.",
      "Dr. Chen from NUS invited me to co-author a paper on neuromorphic memory chips. Deadline for the draft is March 15. This could change my career.",
      "Grandpa was hospitalised in Nanjing with pneumonia. Flew back Friday night, ward 7B, room 12. He is stable now and asked about my studies.",
      "Won second place at the campus AI hackathon with the memory agent prototype. Prize: 5000 yuan and an interview with a robotics startup.",
      "Signed the lease for the Singapore flat: Clementi Ave 3, block 412, unit 08-17, 1100 SGD per month, move-in Jan 5.",
      "Lost my wallet on metro line 2; ID card, bank card and student card were inside. Reported to police, case number NJ-2026-118873.",
    ]) });
    if (r() < 0.15) out.push({ day: d, salience: 0.4, text: pick([
      "Read an interesting paper on complementary learning systems: the hippocampus learns fast and the neocortex learns slowly through replay during sleep.",
      "Tried a new hotpot place near Xinjiekou with Sofia. Way too spicy, but the mushroom broth was great. Would go again.",
      "Fixed my bike's flat tyre myself for the first time. Took 40 minutes and one YouTube video.",
      "Watched the Tianwen probe launch replay. Thought about how much compute flight software actually needs.",
    ]) });
  }
  return out;
}
