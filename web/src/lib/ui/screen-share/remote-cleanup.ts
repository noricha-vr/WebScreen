import { type LiveStreamSession, type StartRun } from './session';
import type { StreamApi } from './stream-api';

/** 画面共有終了時のサーバー・WHIP 資源解放を一元化する。 */
export class StreamRemoteCleanup {
  constructor(private readonly api: StreamApi) {}

  async stopAll(live: LiveStreamSession): Promise<void> {
    await Promise.all([this.stopLiveServer(live), this.deleteWhip(live)]);
  }

  async stopLiveServer(live: LiveStreamSession, beacon = false): Promise<void> {
    if (!live.claimServerStop()) return;
    await this.stopId(live.id, beacon);
  }

  async stopId(id: string, beacon = false): Promise<void> {
    try {
      await this.api.stop(id, beacon);
    } catch (error) {
      console.warn('Failed to stop stream session remotely', error);
    }
  }

  async cancelStart(run: StartRun, beacon = false): Promise<void> {
    if (run.cancellationRequested) return;
    run.cancellationRequested = true;
    try {
      await this.api.cancelStart(run.startToken, beacon);
    } catch (error) {
      console.warn('Failed to cancel stream start remotely', error);
    }
  }

  async deleteWhip(live: LiveStreamSession): Promise<void> {
    if (!live.claimWhipDelete()) return;
    await live.publisher.deleteResource().catch((error) => {
      console.warn('Failed to delete WHIP resource', error);
    });
  }
}
