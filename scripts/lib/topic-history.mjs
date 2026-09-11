// Persistent "least recently used" topic picker. The history file this
// writes to (state/topic-history-long.json or state/topic-history-short.json)
// is committed back to the repo by the workflow after a real run — see the
// "Save topic history" step in .github/workflows/generate-*.yml — so topic
// selection survives across separate GitHub Actions runs, each of which
// starts from a completely fresh checkout with no memory of prior runs
// otherwise.
//
// This replaces an earlier clock-hour-based rotation (see the comment in
// script-gen.mjs) that had a real gap: two runs landing in the same UTC
// hour — a manual test run alongside a scheduled one, say — would compute
// the same hour bucket and pick the identical topic. Reading the actual
// last-used timestamp instead of deriving a pick from the clock fixes that.

import fs from "node:fs/promises";
import path from "node:path";

async function readHistory(historyPath) {
  try {
    return JSON.parse(await fs.readFile(historyPath, "utf-8"));
  } catch {
    return {}; // first run, or file unreadable — every topic looks "never used"
  }
}

async function writeHistory(historyPath, history) {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

/**
 * Picks the least-recently-used topic from `pool` (a topic never seen
 * before always wins — every topic in the pool gets used once before
 * anything repeats), records the pick with the current timestamp, and
 * writes the updated history back to `historyPath`.
 *
 * The CALLER is responsible for committing that file back to the repo
 * (only for real/uploaded runs, per the workflow's existing upload gate) —
 * without that commit the next run starts from a stale history again and
 * this degrades back to "pick the first/oldest-looking topic every time".
 *
 * @param {string[]} pool
 * @param {string} historyPath
 * @returns {Promise<string>} the chosen topic
 */
export async function pickAndRecordTopic(pool, historyPath) {
  const history = await readHistory(historyPath);

  // Find the oldest last-used timestamp in the pool (never-used topics sort
  // as -Infinity, so they always win first), then pick RANDOMLY among every
  // topic tied for that oldest timestamp. A newly-added batch of topics is
  // usually all tied at "never used" — picking randomly among the tie
  // spreads a new wave out across runs instead of always landing on
  // whichever one happens to be first in the array (the old behavior, which
  // made array order silently double as pick priority).
  let oldest = Infinity;
  for (const topic of pool) {
    const lastUsed = history[topic] ? Date.parse(history[topic]) : -Infinity;
    if (lastUsed < oldest) oldest = lastUsed;
  }
  const candidates = pool.filter((topic) => {
    const lastUsed = history[topic] ? Date.parse(history[topic]) : -Infinity;
    return lastUsed === oldest;
  });
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];

  history[chosen] = new Date().toISOString();
  // drop any recorded topics no longer in the pool, so editing the pool
  // list later doesn't leave the history file accumulating dead entries
  for (const key of Object.keys(history)) {
    if (!pool.includes(key)) delete history[key];
  }

  await writeHistory(historyPath, history);
  return chosen;
}
