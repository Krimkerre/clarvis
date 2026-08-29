/**
 * The Bridge's lifetime: bind, register, keep the lease, and let go.
 *
 * `vscode`-free like the rest of `src/bridge/`, with the settings and the
 * storage passed in, because the parts most likely to be wrong here are the ones
 * about *time* — what happens when NERVIS is not running yet, what happens when
 * a lease is refused, whether a timer outlives the thing it was renewing — and
 * none of those can be checked by reading.
 *
 * **One timer, two jobs.** It heartbeats when registered and retries
 * registration when not, because those are the same question asked at the same
 * interval: is NERVIS still there, and does it still know about us. Two timers
 * would be two things to remember to stop.
 */

import { EventStream } from './events';
import { identityFor, loadIdentity, type HostFacts, type Identity, type Storage } from './identity';
import { API_VERSION, CAPABILITIES, PROTOCOL_VERSION, wireIdentifier } from './protocol';
import { deregister, heartbeat, heartbeatInterval, register, type Claim } from './registration';
import { BridgeServer } from './server';
import type { ActivityChange, ActivitySnapshot } from './activity';
import { publishActivity } from './publish';

export interface BridgeOptions {
  /** Where NERVIS is. Configuration, never assumed — §? of the runbook is explicit. */
  readonly nervisUrl: string;
  /** The `0600` file beside NERVIS's database. Its contents, already read. */
  readonly enrollmentSecret: string;
  readonly storage: Storage;
  readonly facts: HostFacts;
  /**
   * What Clarvis is doing — the store itself, because the Bridge needs both
   * halves of it: `snapshot()` answers `/v1/status`, and `observe()` is the only
   * way an edge can be published at all. A gate opened and answered between two
   * polls leaves the state exactly as it found it, and that edge is precisely
   * what §6.7 says NERVIS may be shown.
   *
   * Read-only from here in the way that matters: `Activity` has no method that
   * can make Clarvis do anything.
   */
  readonly activity: {
    snapshot(): ActivitySnapshot;
    observe(observer: (change: ActivityChange) => void): () => void;
  };
  readonly log: (message: string) => void;
  /**
   * The timer, injected so a test can drive it.
   *
   * The callback returns a promise deliberately: the work a wake-up starts is a
   * network round trip, and a test that could only fire the timer without
   * awaiting what it began would be asserting against whatever had happened by
   * then. `setTimeout` ignores the return value, so this costs nothing in
   * production and is the difference between a real test and a flaky one.
   */
  readonly setTimer?: (fn: () => Promise<void>, ms: number) => { unref?: () => void };
  readonly clearTimer?: (handle: any) => void;
  readonly now?: () => number;
}

/**
 * A running Bridge, or one trying to be.
 *
 * `start` resolves once the socket is up, not once registration has succeeded.
 * Those are genuinely different: the socket is this window's to control and
 * registration depends on another process being alive, so waiting for the second
 * would make activation depend on whether a dashboard happens to be running.
 */
export class Bridge {
  private server?: BridgeServer;
  private identity?: Identity;
  private token?: string;
  private timer?: any;
  private running = false;
  /** Detaches the activity observer, so a stopped Bridge stops collecting. */
  private unpublish?: () => void;
  /** Logged once rather than every retry: a dashboard that is off is not news. */
  private saidNotRegistered = false;

  readonly events: EventStream;

  private readonly setTimer: (fn: () => Promise<void>, ms: number) => any;
  private readonly clearTimer: (handle: any) => void;

  constructor(private readonly options: BridgeOptions) {
    this.events = new EventStream(options.now ?? Date.now);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** The port this Bridge is listening on, or 0 when it is not. */
  get port(): number {
    return this.server?.listeningPort ?? 0;
  }

  /** Whether NERVIS has issued a token, and therefore whether the surface answers. */
  get registered(): boolean {
    return Boolean(this.token);
  }

  /** This host's published identity, once `start` has resolved. */
  get published(): Identity | undefined {
    return this.identity;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const stored = await loadIdentity(this.options.storage);
    this.identity = identityFor(stored, this.options.facts);

    // Attached before the socket, so an event fired during startup is buffered
    // rather than lost — the buffer is what a consumer replays on connect.
    this.unpublish = publishActivity(this.options.activity, this.events);

    const server = new BridgeServer({
      token: () => this.token,
      identity: () => this.identity as Identity,
      status: () => this.options.activity.snapshot(),
      events: this.events,
      buildVersion: this.options.facts.buildVersion,
      startedAt: (this.options.now ?? Date.now)(),
      log: this.options.log,
      now: this.options.now,
    });
    await server.start();
    this.server = server;

    await this.announce();
  }

  /**
   * Stop, saying so if there is still time.
   *
   * Ordered deliberately: the timer first, so nothing re-registers while we are
   * leaving; then the event, so a connected dashboard sees the reason before the
   * stream ends; then deregistration; then the socket. Disposing the socket
   * first would close the stream the `stopping` event was meant to travel down.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;

    this.events.emit('clarvis.lifecycle.stopping', {});

    // **Best-effort, and that is the design.** `deactivate()` returns `void` and
    // the host often kills the process before an in-flight request finishes, so
    // this rides on top of NERVIS's 45-second lease rather than replacing it. A
    // window that crashes has to disappear on its own anyway.
    if (this.token && this.identity) {
      const outcome = await deregister(
        this.options.nervisUrl, this.token, this.identity.instance_id);
      if (!outcome.ok) this.options.log(`bridge: deregistration was not acknowledged (${outcome.detail})`);
    }

    this.token = undefined;
    await this.server?.dispose();
    this.server = undefined;

    // Last, so the `stopping` event above still had somewhere to go.
    this.unpublish?.();
    this.unpublish = undefined;
  }

  /** Register, and schedule the next thing to do either way. */
  private async announce(): Promise<void> {
    if (!this.running || !this.identity || !this.server) return;

    const outcome = await register(
      this.options.nervisUrl, this.options.enrollmentSecret, this.claim());

    if (!outcome.ok) {
      if (!this.saidNotRegistered) {
        this.options.log(
          `bridge: not registered with NERVIS (${outcome.detail}); the surface is up and ` +
          'refusing every read until it is, and this will keep retrying quietly'
        );
        this.saidNotRegistered = true;
      }
      this.schedule(heartbeatInterval(0));
      return;
    }

    this.token = outcome.token;
    this.saidNotRegistered = false;
    this.options.log(
      `bridge: registered with NERVIS as ${this.identity.instance_id} on port ${this.port}`);
    // Published only now: before the token exists nothing can read the stream, so
    // an earlier `ready` would be an event with no possible audience that then
    // aged out of the buffer before anyone could connect.
    this.events.emit('clarvis.lifecycle.ready', { port: this.port });
    this.schedule(heartbeatInterval(outcome.leaseSeconds));
  }

  /**
   * Renew, or fall back to registering again.
   *
   * A refused heartbeat means NERVIS no longer knows this instance — it
   * restarted, or the lease expired while the laptop was asleep — and the
   * recovery is to register afresh rather than to keep renewing something that
   * is gone. The token is dropped first, so the surface refuses reads during the
   * gap instead of answering with a credential NERVIS has forgotten.
   */
  private async renew(): Promise<void> {
    if (!this.running || !this.token || !this.identity) return;

    const outcome = await heartbeat(
      this.options.nervisUrl, this.token, this.identity.instance_id);
    if (outcome.ok) {
      this.schedule(heartbeatInterval(outcome.leaseSeconds));
      return;
    }

    this.options.log(`bridge: the lease was not renewed (${outcome.detail}); registering again`);
    this.token = undefined;
    await this.announce();
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    const handle = this.setTimer(async () => {
      this.timer = undefined;
      await (this.token ? this.renew() : this.announce());
    }, ms);
    // So a pending renewal cannot hold the extension host's event loop open.
    handle?.unref?.();
    this.timer = handle;
  }

  /**
   * What this window claims about itself.
   *
   * Exactly NERVIS's allowlist, and nothing more: a field outside it is not
   * refused, it is logged and dropped — so an extra one looks like it worked.
   * Capabilities are flattened to `id -> version` because that is the only shape
   * NERVIS keeps, and the `@major` is stripped since §4.1 says it is never a
   * wire value.
   */
  private claim(): Claim {
    const identity = this.identity as Identity;
    return {
      service: 'clarvis',
      instance_id: identity.instance_id,
      machine_id: identity.machine_id,
      port: this.port,
      api_version: API_VERSION,
      protocol_version: PROTOCOL_VERSION,
      capabilities: Object.fromEntries(
        Object.entries(CAPABILITIES)
          .filter(([, capability]) => capability.state === 'available')
          .map(([id, capability]) => [wireIdentifier(id), capability.version])
      ),
    };
  }
}
