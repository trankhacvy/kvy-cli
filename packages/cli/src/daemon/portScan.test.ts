import { describe, expect, it, vi } from "vitest";
import { listListeningPorts, parseLsofOutput } from "./portScan.js";

describe("parseLsofOutput", () => {
  it("parses a realistic macOS `lsof -nP -iTCP -sTCP:LISTEN` transcript", () => {
    const fixture = [
      "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "launchd       1   root    3u  IPv4 0x1111111111111111      0t0  TCP *:7000 (LISTEN)",
      "node      54321    dev   23u  IPv6 0x2222222222222222      0t0  TCP *:3000 (LISTEN)",
      "node      54321    dev   24u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:3000 (LISTEN)",
      "postgres    234    dev    7u  IPv6 0x4444444444444444      0t0  TCP *:5432 (LISTEN)",
    ].join("\n");

    expect(parseLsofOutput(fixture)).toEqual([
      { port: 3000, address: "*", pid: 54321, processName: "node" },
      { port: 5432, address: "*", pid: 234, processName: "postgres" },
      { port: 7000, address: "*", pid: 1, processName: "launchd" },
    ]);
  });

  it("parses a realistic Linux `lsof -nP -iTCP -sTCP:LISTEN` transcript", () => {
    const fixture = [
      "COMMAND    PID USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "sshd         1 root    3u  IPv4 1000001      0t0  TCP *:22 (LISTEN)",
      "node      1234  dev   20u  IPv4 1000002      0t0  TCP 0.0.0.0:8080 (LISTEN)",
      "node      1234  dev   21u  IPv6 1000003      0t0  TCP [::]:8080 (LISTEN)",
    ].join("\n");

    expect(parseLsofOutput(fixture)).toEqual([
      { port: 22, address: "*", pid: 1, processName: "sshd" },
      { port: 8080, address: "0.0.0.0", pid: 1234, processName: "node" },
    ]);
  });

  it("returns an empty array for empty output", () => {
    expect(parseLsofOutput("")).toEqual([]);
  });

  it("skips the header row, blank lines, and malformed lines", () => {
    const fixture = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "",
      "   ",
      "not a real lsof line at all",
      "node 999 dev 3u IPv4 0x1 0t0 TCP :::garbage (LISTEN)",
      "node      999    dev   3u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:9229 (LISTEN)",
    ].join("\n");

    expect(parseLsofOutput(fixture)).toEqual([
      { port: 9229, address: "127.0.0.1", pid: 999, processName: "node" },
    ]);
  });

  it("dedupes a process listening on both IPv4 and IPv6 wildcards for the same port", () => {
    const fixture = [
      "node      555    dev   23u  IPv6 0x1      0t0  TCP *:4000 (LISTEN)",
      "node      555    dev   24u  IPv4 0x2      0t0  TCP *:4000 (LISTEN)",
    ].join("\n");

    expect(parseLsofOutput(fixture)).toEqual([
      { port: 4000, address: "*", pid: 555, processName: "node" },
    ]);
  });
});

describe("listListeningPorts", () => {
  it("parses stdout from the injected runLsof", async () => {
    const runLsof = vi.fn().mockResolvedValue("node 42 dev 3u IPv4 0x1 0t0 TCP *:3000 (LISTEN)\n");
    const result = await listListeningPorts({ runLsof });
    expect(result).toEqual([{ port: 3000, address: "*", pid: 42, processName: "node" }]);
    expect(runLsof).toHaveBeenCalledWith(["-nP", "-iTCP", "-sTCP:LISTEN"]);
  });

  it("returns an empty array when the injected runLsof resolves empty (lsof missing/failed)", async () => {
    const runLsof = vi.fn().mockResolvedValue("");
    await expect(listListeningPorts({ runLsof })).resolves.toEqual([]);
  });
});
