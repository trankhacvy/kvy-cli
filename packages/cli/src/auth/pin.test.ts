import { getRandomBytes } from "@falcon/crypto";
import { describe, expect, it, vi } from "vitest";
import { promptAndUnwrapWithPin, promptAndWrapWithPin } from "./pin.js";

function scriptedPrompt(answers: string[]): (question: string) => Promise<string> {
  let i = 0;
  return async () => {
    const answer = answers[i];
    i += 1;
    return answer ?? "";
  };
}

describe("promptAndWrapWithPin", () => {
  it("wraps the secret once a valid PIN is entered and confirmed", async () => {
    const secret = getRandomBytes(32);
    const write = vi.fn();
    const { pin, wrapped } = await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123456", "123456"]),
      write,
    });
    expect(pin).toBe("123456");
    expect(wrapped.v).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("re-prompts on a too-short PIN", async () => {
    const secret = getRandomBytes(32);
    const write = vi.fn();
    await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123", "123456", "123456"]),
      write,
    });
    expect(write).toHaveBeenCalledWith(expect.stringContaining("at least"));
  });

  it("re-prompts on a confirmation mismatch", async () => {
    const secret = getRandomBytes(32);
    const write = vi.fn();
    await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123456", "000000", "123456", "123456"]),
      write,
    });
    expect(write).toHaveBeenCalledWith(expect.stringContaining("didn't match"));
  });
});

describe("promptAndUnwrapWithPin", () => {
  it("unwraps with the correct PIN on the first try", async () => {
    const secret = getRandomBytes(32);
    const { wrapped } = await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123456", "123456"]),
    });

    const result = await promptAndUnwrapWithPin(wrapped, { prompt: scriptedPrompt(["123456"]) });
    expect(result).toEqual(secret);
  });

  it("retries on a wrong PIN, up to the attempt limit, then gives up with null", async () => {
    const secret = getRandomBytes(32);
    const { wrapped } = await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123456", "123456"]),
    });
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
    const { wrapped } = await promptAndWrapWithPin(secret, {
      prompt: scriptedPrompt(["123456", "123456"]),
    });

    const result = await promptAndUnwrapWithPin(wrapped, {
      prompt: scriptedPrompt(["000000", "123456"]),
    });
    expect(result).toEqual(secret);
  });
});
