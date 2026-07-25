import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { createNetworkResume, stoppedForNetwork } from "./index";

function agentEnd(errorMessage: string, stopReason = "error") {
  return {
    messages: [{ role: "assistant", stopReason, errorMessage }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createNetworkContext(overrides: Record<string, unknown> = {}) {
  return createMockContext({ isIdle: vi.fn(() => true), ...overrides });
}

describe("network resume extension", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recognizes transport failures but not provider limits", () => {
    expect(stoppedForNetwork(agentEnd("WebSocket closed while receiving output"))).toBe(true);
    expect(stoppedForNetwork(agentEnd("HTTP/2 request stream closed"))).toBe(true);
    expect(stoppedForNetwork(agentEnd("429 rate limit exceeded"))).toBe(false);
    expect(stoppedForNetwork(agentEnd("done", "stop"))).toBe(false);
  });

  it("resumes after NetworkManager reports an offline-to-online transition", async () => {
    vi.useFakeTimers();
    const checkOnline = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000 })(pi);
    const ctx = createNetworkContext();

    await pi.events.get("agent_end")?.[0](agentEnd("fetch failed: network error"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("network-resume", "offline; auto-resume armed");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "network-resume", display: false }), {
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  it("keeps the worker armed when the OS probe fails", async () => {
    const checkOnline = vi.fn().mockRejectedValue(new Error("nmcli unavailable"));
    const pi = createMockPi();
    createNetworkResume({ checkOnline })(pi);
    const ctx = createNetworkContext();

    await pi.events.get("agent_end")?.[0](agentEnd("fetch failed"), ctx);
    await expect(pi.events.get("agent_settled")?.[0]({}, ctx)).resolves.toBeUndefined();

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("network-resume", "network status unavailable; retry armed");
    await pi.events.get("session_shutdown")?.[0]({}, ctx);
  });

  it("uses the bounded retry when OS connectivity is unavailable", async () => {
    vi.useFakeTimers();
    const checkConnectivity = vi.fn().mockResolvedValue("unknown" as const);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkConnectivity, pollMs: 10, fallbackRetryMs: 100 })(pi);
    const ctx = createNetworkContext();

    await pi.events.get("agent_end")?.[0](agentEnd("fetch failed"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("network-resume", "network status unavailable; retry armed");

    await vi.advanceTimersByTimeAsync(100);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("restores an armed worker after Pi restarts", async () => {
    const checkOnline = vi.fn().mockResolvedValue(false);
    const firstPi = createMockPi();
    createNetworkResume({ checkOnline })(firstPi);
    const firstContext = createNetworkContext();

    await firstPi.events.get("agent_end")?.[0](agentEnd("fetch failed"), firstContext);
    await firstPi.events.get("agent_settled")?.[0]({}, firstContext);
    await firstPi.events.get("session_shutdown")?.[0]({}, firstContext);
    expect(firstPi.entries.at(-1)).toEqual({ customType: "network-resume-state", data: { version: 1, armed: true } });

    const secondPi = createMockPi();
    createNetworkResume({ checkOnline })(secondPi);
    const secondContext = createNetworkContext();
    secondContext.sessionManager.getBranch.mockReturnValue([
      { type: "custom", customType: "network-resume-state", data: { version: 1, armed: true } },
    ]);
    await secondPi.events.get("session_start")?.[0]({}, secondContext);
    await vi.waitFor(() => expect(secondContext.ui.setStatus).toHaveBeenLastCalledWith("network-resume", "offline; auto-resume armed"));

    await secondPi.events.get("agent_start")?.[0]({}, secondContext);
    expect(secondPi.entries.at(-1)).toEqual({ customType: "network-resume-state", data: { version: 1, armed: false } });
  });

  it("falls back to a bounded retry when NetworkManager remains online", async () => {
    vi.useFakeTimers();
    const checkOnline = vi.fn().mockResolvedValue(true);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000, fallbackRetryMs: 30_000 })(pi);
    const ctx = createNetworkContext();

    await pi.events.get("agent_end")?.[0](agentEnd("socket connection was closed"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("caps retries while connectivity stays online but still reacts to a later network transition", async () => {
    vi.useFakeTimers();
    let online = true;
    const checkOnline = vi.fn(async () => online);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000, fallbackRetryMs: 30_000, maxOnlineFallbackAttempts: 1 })(pi);
    const ctx = createNetworkContext();
    const agentEndHandler = pi.events.get("agent_end")?.[0];
    const settledHandler = pi.events.get("agent_settled")?.[0];

    await agentEndHandler?.(agentEnd("connection timeout"), ctx);
    await settledHandler?.({}, ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await agentEndHandler?.(agentEnd("connection timeout"), ctx);
    await settledHandler?.({}, ctx);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    online = false;
    await vi.advanceTimersByTimeAsync(2_000);
    online = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale connectivity probe after waiting is cancelled and re-armed", async () => {
    vi.useFakeTimers();
    const oldProbe = deferred<boolean>();
    const currentProbe = deferred<boolean>();
    const checkOnline = vi.fn().mockReturnValueOnce(oldProbe.promise).mockReturnValueOnce(currentProbe.promise);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000 })(pi);
    const ctx = createNetworkContext();
    const agentEndHandler = pi.events.get("agent_end")?.[0];
    const settledHandler = pi.events.get("agent_settled")?.[0];

    await agentEndHandler?.(agentEnd("fetch failed"), ctx);
    const oldWait = settledHandler?.({}, ctx);
    await pi.events.get("agent_start")?.[0]({}, ctx);
    await agentEndHandler?.(agentEnd("fetch failed"), ctx);
    const currentWait = settledHandler?.({}, ctx);

    oldProbe.resolve(false);
    await oldWait;
    currentProbe.resolve(true);
    await currentWait;

    expect(pi.sendMessage).not.toHaveBeenCalled();
    await pi.events.get("session_shutdown")?.[0]({}, ctx);
  });

  it("does not keep non-interactive runs alive", async () => {
    vi.useFakeTimers();
    const checkOnline = vi.fn().mockResolvedValue(false);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000 })(pi);
    const ctx = createNetworkContext({ mode: "print" });

    await pi.events.get("agent_end")?.[0](agentEnd("network connection lost"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checkOnline).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not arm when another extension started a run during settlement", async () => {
    vi.useFakeTimers();
    const checkOnline = vi.fn().mockResolvedValue(false);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000 })(pi);
    const ctx = createNetworkContext({ isIdle: vi.fn(() => false) });

    await pi.events.get("agent_end")?.[0](agentEnd("connection lost"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checkOnline).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not arm for a non-network error", async () => {
    vi.useFakeTimers();
    const checkOnline = vi.fn().mockResolvedValue(false);
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    createNetworkResume({ checkOnline, pollMs: 2_000 })(pi);
    const ctx = createNetworkContext();

    await pi.events.get("agent_end")?.[0](agentEnd("429 rate limit exceeded"), ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checkOnline).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
