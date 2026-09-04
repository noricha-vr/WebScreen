import { StartRun } from './session';

/** 競合する開始・停止操作の世代と capture 所有権を管理する。 */
export class StartCoordinator {
  private stopping = false;
  private generation = 0;
  private reservation: number | null = null;
  private active: StartRun | null = null;

  get current(): StartRun | null { return this.active; }
  get isStopping(): boolean { return this.stopping; }

  reserve(blocked: boolean): number | null {
    if (this.reservation !== null || this.active || blocked) return null;
    this.stopping = false;
    const generation = ++this.generation;
    this.reservation = generation;
    return generation;
  }

  register(media: MediaStream, generation: number, token: string, blocked: boolean): StartRun | null {
    const run = new StartRun(generation, token, media);
    if (this.reservation !== generation || !this.isGenerationActive(generation) ||
        this.active || blocked) {
      run.cancel();
      return null;
    }
    this.active = run;
    return run;
  }

  cancel(run: StartRun): void {
    run.cancel();
    if (this.active === run) this.active = null;
  }

  finish(run: StartRun): void {
    if (this.active === run) this.active = null;
  }

  release(generation: number): void {
    if (this.reservation === generation) this.reservation = null;
  }

  isGenerationActive(generation: number): boolean {
    return !this.stopping && this.generation === generation;
  }

  isRunActive(run: StartRun): boolean {
    return this.active === run && this.isGenerationActive(run.generation) &&
      !run.abortController.signal.aborted;
  }

  beginStop(): StartRun | null | undefined {
    if (this.stopping) return undefined;
    this.stopping = true;
    this.generation += 1;
    const run = this.active;
    this.active = null;
    run?.abortController.abort();
    return run;
  }
}
