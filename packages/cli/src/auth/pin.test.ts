import { getRandomBytes, wrapWithPin } from "@falcon/crypto";
import { describe, expect, it, vi } from "vitest";
import { promptAndUnwrapWithPin } from "./pin.js";

function scriptedPrompt(answers: string[]): (question: string) => Promise<string> {
  let i = 0;
  return async () => {
    const answer = answers[i];
    i += 1;
    return answer ?? "";
  };
}

describe("promptAndUnwrapWithPin", () => {
  it("unwraps with the correct PIN on the first try", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWithPin(secret, "123456");

    const result = await promptAndUnwrapWithPin(wrapped, { prompt: scriptedPrompt(["123456"]) });
    expect(result).toEqual(secret);
  });

  it("retries on a wrong PIN, up to the attempt limit, then gives up with null", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWithPin(secret, "123456");
    const write = vi.fn();

    const result = await promptAndUnwrapWithPin(wrapped, {
      prompt: scriptedPrompt(["000000", "111111", "222222"]),
      write,
    });
    expect(result).toBeNull();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Wrong PIN"));
  });

  it("succeeds on a later attempt within the retry budget", async () => {
    const secret = getRandomBytes(32);
    const wrapped = await wrapWithPin(secret, "123456");

    const result = await promptAndUnwrapWithPin(wrapped, {
      prompt: scriptedPrompt(["000000", "123456"]),
    });
    expect(result).toEqual(secret);
  });
});
