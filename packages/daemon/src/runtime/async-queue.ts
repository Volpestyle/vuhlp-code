export class AsyncQueue<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: Array<(value: T) => void> = [];

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(value);
      return;
    }
    this.queue.push(value);
  }

  async next(): Promise<T> {
    const value = this.queue.shift();
    if (value !== undefined) {
      return value;
    }
    return new Promise<T>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  clear(): void {
    this.queue.length = 0;
  }
}
