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

async function readPriorityQueue(priorityPath) {
  try {
    return JSON.parse(await fs.readFile(priorityPath, "utf-8"));
  } catch {
    return {}; // no queue file yet, or nothing queued — every key reads as unset
  }
}

async function writePriorityQueue(priorityPath, queue) {
  await fs.mkdir(path.dirname(priorityPath), { recursive: true });
  await fs.writeFile(priorityPath, JSON.stringify(queue, null, 2) + "\n", "utf-8");
}

// Sept 15 2026: added so a genuinely trending topic/country (spotted via
// vidIQ, checked on request) can jump straight to the front of the queue
// instead of waiting its turn in the normal least-recently-used rotation —
// Robert asked for exactly this ("if there is a trending thing let it come
// be posted first"). This is intentionally a manual, human-in-the-loop
// queue rather than a live trend-API call from inside the pipeline: no new
// dependency or API credential to keep working unattended, and a person
// (or Claude, when asked) is the one deciding something is actually worth
// jumping the line for, not an unsupervised heuristic.
//
// Sept 15 2026 (later same day): upgraded each key to hold either a single
// string (one queued pick, as before) OR an array of strings (several
// queued picks, used first-in-first-out, one per run) — Robert asked to
// queue a second trending pick before the first had even been used yet, so
// a single overwritable slot per key wasn't enough.
//
/**
 * Same contract as pickAndRecordTopic, but first checks `priorityPath` for a
 * manually-queued "post this next" value under `priorityKey`. That value can
 * be a single string, or an array of strings for several queued picks (used
 * oldest-first, one per run). Whichever one comes off the front is used
 * immediately, removed from the queue file, and — if it's also a real
 * member of `pool` — recorded into the normal LRU history too, so the
 * regular rotation stays correct afterward and this pick doesn't look
 * "never used" and get immediately re-picked. If the queue for this key is
 * empty or unset, this behaves exactly like pickAndRecordTopic.
 *
 * Queue files are plain JSON, e.g. `{ "topic": ["Trending pick A",
 * "Trending pick B"] }` (or just `{ "topic": "Trending pick A" }` for a
 * single one) — see state/priority-queue-short.json and
 * state/priority-queue-long.json, and the "Post something trending first"
 * section of the pipeline README for how these get set.
 *
 * @param {string[]} pool
 * @param {string} historyPath
 * @param {string} priorityPath
 * @param {string} priorityKey
 * @returns {Promise<string>} the chosen topic
 */
export async function pickWithPriority(pool, historyPath, priorityPath, priorityKey) {
  const queue = await readPriorityQueue(priorityPath);
  const queued = queue[priorityKey];

  // Normalize to an array so a single-string queue and a multi-item queue
  // both fall through the same logic below.
  const pending = Array.isArray(queued) ? queued : queued ? [queued] : [];
  const [next, ...rest] = pending;

  if (typeof next === "string" && next.trim()) {
    const chosen = next.trim();
    console.log(`[topic] using queued priority pick for "${priorityKey}": ${chosen}` + (rest.length ? ` (${rest.length} more still queued)` : ""));

    queue[priorityKey] = rest.length ? rest : null;
    await writePriorityQueue(priorityPath, queue);

    if (pool.includes(chosen)) {
      const history = await readHistory(historyPath);
      history[chosen] = new Date().toISOString();
      for (const key of Object.keys(history)) {
        if (!pool.includes(key)) delete history[key];
      }
      await writeHistory(historyPath, history);
    }

    return chosen;
  }

  return pickAndRecordTopic(pool, historyPath);
}
