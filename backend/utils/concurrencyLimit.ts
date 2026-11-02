/**
 * Run async work at most `max` at a time, first come first served.
 *
 * `run(task)` starts `task` when a slot is free and settles with its result.
 * A task that throws synchronously rejects like one that rejects, and either
 * way its slot is freed. The task's result is adopted once, so a Mongoose
 * Query (which runs again on every then()) runs once.
 *
 * A task must not wait on another task run through the same limiter, or the
 * two can hold every slot and wait on each other forever.
 */
export const limitConcurrency = (max: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return <T>(task: () => T | PromiseLike<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const start = () => {
      active += 1;
      new Promise<T>((settle) => { settle(task()); }).then(
        (value) => { release(); resolve(value); },
        (error) => { release(); reject(error); },
      );
    };
    if (active < max) start();
    else waiting.push(start);
  });
};
