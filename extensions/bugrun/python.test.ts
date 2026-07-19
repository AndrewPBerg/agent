import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatPythonDebugFullResult,
  formatPythonDebugPanel,
  formatPythonDebugResult,
  PythonDebugSession,
  parseBreakpointSpec,
  parseBugrunArgs,
  runPythonPytestDebug,
} from "./python";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "python-shop");

function hasUv(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("bugrun python helpers", () => {
  it("parses breakpoint specs relative to cwd", () => {
    expect(parseBreakpointSpec("src/shop/cart.py:9", fixture)).toEqual({ path: join(fixture, "src", "shop", "cart.py"), line: 9 });
  });

  it("parses /bugrun-style args", () => {
    const parsed = parseBugrunArgs("tests/test_cart.py::test_discount_total src/shop/cart.py:9", fixture);

    expect(parsed.test).toBe("tests/test_cart.py::test_discount_total");
    expect(parsed.breakpoints).toEqual([{ path: join(fixture, "src", "shop", "cart.py"), line: 9 }]);
  });

  it("keeps default LLM evidence compact and moves expanded details behind opt-in", () => {
    const huge = `{${"x".repeat(2_000)}}`;
    const result = {
      cwd: fixture,
      test: "tests/test_cart.py::test_discount_total",
      command: "python3",
      args: [],
      breakpoints: [parseBreakpointSpec("src/shop/cart.py:9", fixture)],
      hits: [
        {
          reason: "breakpoint",
          threadId: 1,
          frame: { id: 1, name: "price_after_discount", path: join(fixture, "src", "shop", "cart.py"), line: 9 },
          stack: [],
          locals: [
            { name: "ctx", value: huge, type: "RuntimeLifecycleContext" },
            { name: "payload", value: huge, type: "dict" },
            ...Array.from({ length: 13 }, (_, index) => ({ name: `extra_${index}`, value: String(index) })),
          ],
        },
      ],
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
    };

    const summary = formatPythonDebugResult(result);
    expect(summary).toContain("LLM context is compact by design");
    expect(summary).toContain("payload=");
    expect(summary).not.toContain("values capped at 500 chars");
    expect(summary.length).toBeLessThan(1_200);

    const full = formatPythonDebugFullResult(result);
    expect(full).toContain("values capped at 500 chars");
    expect(full).toContain("truncated");
    expect(full).toContain("more locals omitted");

    const panel = formatPythonDebugPanel(result);
    expect(panel).toContain("Traversal");
    expect(panel.length).toBeLessThan(1_000);
  });

  it("rejects interactive sessions with more than twelve breakpoints before spawning debugpy", async () => {
    await expect(
      PythonDebugSession.start("too-many", {
        cwd: fixture,
        test: "tests/test_cart.py::test_discount_total",
        breakpoints: Array.from({ length: 13 }, () => parseBreakpointSpec("src/shop/cart.py:9", fixture)),
        runner: "direct",
        python: "__should_not_spawn__",
      }),
    ).rejects.toThrow("at most 12 breakpoints");
  });

  it("reports debug process startup failures instead of waiting for DAP forever", async () => {
    await expect(
      runPythonPytestDebug({
        cwd: fixture,
        test: "tests/test_cart.py::test_discount_total",
        breakpoints: [parseBreakpointSpec("src/shop/cart.py:9", fixture)],
        runner: "direct",
        python: "__bugrun_missing_python__",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Failed to start debug process");
  });
});

const integration = process.env.BUGRUN_INTEGRATION === "1" ? describe : describe.skip;

integration("bugrun debugpy integration", () => {
  it("supports multi-shot start, stop, and continue", async () => {
    if (!hasUv()) throw new Error("BUGRUN_INTEGRATION=1 requires uv on PATH");

    const session = await PythonDebugSession.start("fixture-session", {
      cwd: fixture,
      test: "tests/test_cart.py::test_discount_total",
      breakpoints: [parseBreakpointSpec("src/shop/cart.py:9", fixture)],
      runner: "uv",
      uvPackages: ["pytest"],
      uvNoProject: true,
      pytestArgs: ["-q", "-p", "no:cacheprovider"],
      timeoutMs: 120_000,
    });

    const first = await session.continueToStop();
    expect(first.state).toBe("stopped");
    expect(first.currentHit?.frame.name).toBe("price_after_discount");
    expect(first.hits.length).toBe(1);

    const second = await session.continueToStop();
    expect(second.state).toBe("exited");
    expect(second.hits.length).toBe(1);

    await session.stop();
  }, 130_000);

  it("captures stack and locals from the broken Python fixture", async () => {
    if (!hasUv()) throw new Error("BUGRUN_INTEGRATION=1 requires uv on PATH");

    const result = await runPythonPytestDebug({
      cwd: fixture,
      test: "tests/test_cart.py::test_discount_total",
      breakpoints: [parseBreakpointSpec("src/shop/cart.py:9", fixture)],
      runner: "uv",
      uvPackages: ["pytest"],
      uvNoProject: true,
      pytestArgs: ["-q", "-p", "no:cacheprovider"],
      timeoutMs: 120_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].frame.name).toBe("price_after_discount");

    const locals = Object.fromEntries(result.hits[0].locals.map((variable) => [variable.name, variable.value]));
    expect(locals.subtotal).toContain("100");
    expect(locals.discount).toContain("20");
    expect(locals.total).toContain("20");

    const formatted = formatPythonDebugResult(result, "why is the discounted total wrong?");
    expect(formatted).toContain("total=20");
    expect(formatted).toContain("Process output summary");

    const full = formatPythonDebugFullResult(result, "why is the discounted total wrong?");
    expect(full).toContain("total = 20");
    expect(full).toContain("Pytest/debugpy output");
  }, 130_000);
});
