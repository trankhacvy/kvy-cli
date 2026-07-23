import { describe, expect, it } from "vitest";
import { buildShellInvocation } from "./shellCommand.js";

describe("buildShellInvocation", () => {
  it("wraps the script in /bin/sh -c on POSIX platforms", () => {
    expect(buildShellInvocation("npm install", "linux")).toEqual({
      command: "/bin/sh",
      args: ["-c", "npm install"],
    });
    expect(buildShellInvocation("npm run dev", "darwin")).toEqual({
      command: "/bin/sh",
      args: ["-c", "npm run dev"],
    });
  });

  it("wraps the script in cmd.exe /c on win32", () => {
    expect(buildShellInvocation("npm install", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "npm install"],
    });
  });

  it("defaults to the real process.platform when not given", () => {
    const result = buildShellInvocation("echo hi");
    expect(result.args[result.args.length - 1]).toBe("echo hi");
  });

  it("passes a script containing shell operators through untouched (the shell itself parses them)", () => {
    const script = "npm install && npm run build || echo failed";
    expect(buildShellInvocation(script, "linux").args).toEqual(["-c", script]);
  });
});
