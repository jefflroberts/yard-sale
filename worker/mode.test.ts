import { describe, expect, it } from "vitest";
import { agentInstructions, buildAgentInputText, BUY_INSTRUCTIONS, SELL_INSTRUCTIONS } from "./agent";
import { parseScanMode } from "./mode";

describe("parseScanMode", () => {
  it("defaults missing values to buy mode", () => {
    expect(parseScanMode(null)).toBe("buy");
    expect(parseScanMode(undefined)).toBe("buy");
  });

  it("accepts buy and sell", () => {
    expect(parseScanMode("buy")).toBe("buy");
    expect(parseScanMode("sell")).toBe("sell");
  });

  it("rejects anything else", () => {
    for (const value of ["", "SELL", "trade", 1]) {
      expect(() => parseScanMode(value)).toThrow("Invalid scan mode");
    }
  });
});

describe("agentInstructions", () => {
  it("uses the seller prompt only in sell mode", () => {
    expect(agentInstructions("buy")).toBe(BUY_INSTRUCTIONS);
    expect(agentInstructions("sell")).toBe(SELL_INSTRUCTIONS);
    expect(SELL_INSTRUCTIONS).toContain("yardSalePriceCents");
    expect(SELL_INSTRUCTIONS).not.toContain("offered for sale, such as placement");
  });
});

describe("buildAgentInputText", () => {
  it("asks for the owner's items in sell mode and keeps find criteria in both modes", () => {
    expect(buildAgentInputText("", "buy")).toContain("offered for sale");
    expect(buildAgentInputText("", "sell")).toContain("owner");
    expect(buildAgentInputText("books only", "sell")).toContain("<find_criteria>\nbooks only\n</find_criteria>");
  });
});

describe("source and edition rules", () => {
  it("asks both modes for annotated sources and separate edition pricing", () => {
    for (const instructions of [BUY_INSTRUCTIONS, SELL_INSTRUCTIONS]) {
      expect(instructions).toContain("one-line note");
      expect(instructions).toContain("near substitute");
      expect(instructions).toContain("Never blend releases");
      expect(instructions).toContain("reissue");
      expect(instructions).toContain("editionKey");
    }
  });

  it("nulls sell-only edition fields in buy mode and titles each edition in sell mode", () => {
    expect(BUY_INSTRUCTIONS).toContain("on the item and on every edition");
    expect(SELL_INSTRUCTIONS).toContain("its own listingTitle naming the release");
  });
});

describe("colorway rules", () => {
  it("keeps price-relevant colorways in identity, research, and editions in both modes", () => {
    for (const instructions of [BUY_INSTRUCTIONS, SELL_INSTRUCTIONS]) {
      expect(instructions).toContain("Include the colorway or graphic in the fingerprint when it distinguishes");
      expect(instructions).toContain("different colorway");
      expect(instructions).toContain("When colorways of the same release sell for meaningfully different prices");
    }
  });
});

describe("edition price anchoring", () => {
  it("caps in-production releases at new retail unless sold evidence supports more, in both modes", () => {
    for (const instructions of [BUY_INSTRUCTIONS, SELL_INSTRUCTIONS]) {
      expect(instructions).toContain("Anchor each edition's prices to evidence for that edition");
      expect(instructions).toContain("never price it above its new retail price");
      expect(instructions).toContain("A colorway or graphic premium requires sold evidence");
    }
  });

  it("writes listing titles as plain statements", () => {
    expect(SELL_INSTRUCTIONS).toContain("State the title plainly");
  });
});
