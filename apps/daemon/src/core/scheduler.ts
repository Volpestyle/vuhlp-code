export class Semaphore {
  private max: number;
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return () => this.release();
    }
    return await new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}
