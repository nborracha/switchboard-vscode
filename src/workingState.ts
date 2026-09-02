export interface WorkingTransitions {
  nowWorking: Set<string>;
  justFinished: string[];
  changed: boolean;
}

/**
 * Pure transition-detection: given each file's last-write time and the set of files considered
 * "working" as of the previous tick, decides which files are working now and which just finished
 * (were working, aren't anymore). `changed` is true only when something actually flipped — a file
 * that stays working (or stays idle) across a tick produces no change, which is what keeps a
 * continuously-active session from causing a refresh on every tick.
 */
export function computeWorkingTransitions(
  fileActivity: ReadonlyMap<string, number>,
  workingAsOfLastTick: ReadonlySet<string>,
  now: number,
  idleMs: number,
): WorkingTransitions {
  const nowWorking = new Set<string>();
  const justFinished: string[] = [];
  let changed = false;

  for (const [filePath, lastChange] of fileActivity) {
    const isWorking = now - lastChange < idleMs;
    const wasWorking = workingAsOfLastTick.has(filePath);

    if (isWorking) {
      nowWorking.add(filePath);
      if (!wasWorking) {
        changed = true;
      }
    } else if (wasWorking) {
      justFinished.push(filePath);
      changed = true;
    }
  }

  return { nowWorking, justFinished, changed };
}
