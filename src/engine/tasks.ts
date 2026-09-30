// Cooperative coroutines driven by the fixed-step clock. Choreography is written as
// generators that yield what they are waiting for:
//   yield 1.5            -> sleep 1.5 seconds of show time
//   yield () => cond     -> wait until cond() is true (checked every tick)
//   yield [taskA, taskB] -> wait until all those tasks finish
// Tasks are stepped synchronously in spawn order, so runs are fully deterministic
// regardless of frame rate (unlike promises, whose continuations run on the microtask queue).

export type Wait = number | (() => boolean) | Task[];
export type Co = Generator<Wait, void, void>;

export class Task {
  done = false;
  constructor(readonly gen: Co) {}
}

interface Entry {
  task: Task;
  wakeAt: number;
  until: (() => boolean) | null;
  waitAll: Task[] | null;
}

const MAX_STEPS_PER_TICK = 1000;

export class Scheduler {
  time = 0;
  private entries: Entry[] = [];

  spawn(gen: Co): Task {
    const task = new Task(gen);
    this.entries.push({ task, wakeAt: this.time, until: null, waitAll: null });
    return task;
  }

  get idle(): boolean {
    return this.entries.length === 0;
  }

  tick(dt: number): void {
    this.time += dt;
    // Index loop so tasks spawned during this tick also get their first step now.
    for (let i = 0; i < this.entries.length; i++) this.run(this.entries[i]);
    this.entries = this.entries.filter((e) => !e.task.done);
  }

  private ready(e: Entry): boolean {
    if (e.wakeAt > this.time + 1e-9) return false;
    if (e.until && !e.until()) return false;
    if (e.waitAll && !e.waitAll.every((t) => t.done)) return false;
    return true;
  }

  private run(e: Entry): void {
    for (let steps = 0; !e.task.done && this.ready(e); steps++) {
      if (steps > MAX_STEPS_PER_TICK) throw new Error('coroutine yielded too many times in one tick');
      const r = e.task.gen.next();
      e.until = null;
      e.waitAll = null;
      if (r.done) {
        e.task.done = true;
        return;
      }
      const w = r.value;
      if (typeof w === 'number') e.wakeAt = this.time + w;
      else if (typeof w === 'function') e.until = w;
      else e.waitAll = w;
      // A zero-length wait keeps stepping this tick; anything else resumes on a later tick.
      if (typeof w === 'number' && w > 0) return;
    }
  }
}
