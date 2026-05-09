export class Transition {
  private complete = true;
  private promise = Promise.resolve();

  public extend() {
    this.complete = false;
    const p = Promise.withResolvers<void>();
    this.promise = this.promise.then(() => p.promise).finally(() => (this.complete = true));
    return p.resolve;
  }

  public isComplete() {
    return this.complete;
  }

  public block() {
    return this.promise;
  }

  // If the task rejects, the transition will never complete
  public async new<R>(task: () => Promise<R>) {
    await this.block();
    const resolve = this.extend();
    const r = await task();
    resolve();
    return r;
  }
}
