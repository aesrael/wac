import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  selectAssistantMessage,
  assistantResult,
  isStallResult,
  partsToText,
  partsEmpty,
} from "../dist/serve-client.js"

const NOW = 1789839622892
const msg = (over = {}) => ({
  id: "msg_test",
  time: { created: NOW, ...over.time },
  finish: "stop",
  content: [{ type: "text", text: "hello" }],
  ...over,
})

describe("selectAssistantMessage", () => {
  it("prefers the turn matching since within the 60s window", () => {
    const fresh = msg({ id: "fresh", time: { created: NOW } })
    const old = msg({ id: "old", time: { created: NOW - 3600_000 } })
    const { message, timeMatched } = selectAssistantMessage([fresh, old], NOW)
    assert.equal(message.id, "fresh")
    assert.equal(timeMatched, true)
  })

  it("falls back to latest instead of empty on clock skew", () => {
    const skewed = msg({ id: "skewed", time: { created: NOW - 3600_000 } })
    const { message, timeMatched } = selectAssistantMessage([skewed], NOW)
    assert.equal(message.id, "skewed")
    assert.equal(timeMatched, false)
  })

  it("returns undefined when there are no assistant messages", () => {
    const { message, timeMatched } = selectAssistantMessage([], NOW)
    assert.equal(message, undefined)
    assert.equal(timeMatched, false)
  })
})

describe("assistantResult", () => {
  it("reports empty only when no message exists", () => {
    const r = assistantResult(undefined, false)
    assert.equal(r.isEmpty, true)
    assert.match(r.error, /no assistant reply recorded/)
  })

  it("is clean for a matched turn with text", () => {
    const r = assistantResult(msg(), true)
    assert.equal(r.text, "hello")
    assert.equal(r.isEmpty, false)
    assert.equal(r.error, null)
  })

  it("flags stale fallback instead of failing silently", () => {
    const r = assistantResult(msg(), false)
    assert.equal(r.text, "hello")
    assert.match(r.error, /showing latest/)
  })

  it("surfaces model finish=error", () => {
    const r = assistantResult(msg({ finish: "error", rawFinish: "boom" }), true)
    assert.match(r.error, /boom/)
  })
})

describe("isStallResult", () => {
  it("true for instant empty with the known error", () => {
    assert.equal(isStallResult(120, "no assistant reply recorded (no assistant messages)"), true)
  })

  it("false for slow failures", () => {
    assert.equal(isStallResult(90000, "no assistant reply recorded (no assistant messages)"), false)
  })

  it("false for other errors even when instant", () => {
    assert.equal(isStallResult(100, "model error (boom)"), false)
    assert.equal(isStallResult(100, null), false)
  })
})

describe("parts helpers (unchanged behavior)", () => {
  it("joins text parts", () => {
    assert.equal(partsToText([{ type: "text", text: "a" }, { type: "tool", text: "x" }, { type: "text", text: "b" }]), "ab")
  })

  it("tool-only turns are not empty", () => {
    assert.equal(partsEmpty([{ type: "tool" }]), false)
    assert.equal(partsEmpty([]), true)
  })
})
