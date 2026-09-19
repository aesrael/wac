import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  selectAssistantMessage,
  assistantResult,
  isInstantEmpty,
  hasTextPart,
  pollContinues,
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
  const textMsg = (over = {}) => msg({ ...over, content: [{ type: "text", text: "hello" }] })
  const toolMsg = (over = {}) => msg({ ...over, content: [{ type: "tool" }] })

  it("prefers the turn matching since within the 60s window", () => {
    const fresh = textMsg({ id: "fresh", time: { created: NOW } })
    const old = textMsg({ id: "old", time: { created: NOW - 3600_000 } })
    const { message, timeMatched } = selectAssistantMessage([fresh, old], NOW)
    assert.equal(message.id, "fresh")
    assert.equal(timeMatched, true)
  })

  it("skips mid-turn tool-only rows and picks the text-bearing one", () => {
    const tool = toolMsg({ id: "tool", time: { created: NOW } })
    const text = textMsg({ id: "text", time: { created: NOW - 2000 } })
    const { message, timeMatched } = selectAssistantMessage([tool, text], NOW)
    assert.equal(message.id, "text")
    assert.equal(timeMatched, true)
  })

  it("falls back to latest text-bearing instead of empty on clock skew", () => {
    const skewed = textMsg({ id: "skewed", time: { created: NOW - 3600_000 } })
    const { message, timeMatched } = selectAssistantMessage([skewed], NOW)
    assert.equal(message.id, "skewed")
    assert.equal(timeMatched, false)
  })

  it("returns the newest row when nothing has text (tool-only turn)", () => {
    const tool = toolMsg({ id: "toolonly", time: { created: NOW } })
    const { message } = selectAssistantMessage([tool], NOW)
    assert.equal(message.id, "toolonly")
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

describe("isInstantEmpty", () => {
  it("true for instant empty with the known error", () => {
    assert.equal(isInstantEmpty(120, "no assistant reply recorded (no assistant messages)"), true)
  })

  it("false for slow failures", () => {
    assert.equal(isInstantEmpty(90000, "no assistant reply recorded (no assistant messages)"), false)
  })

  it("false for other errors even when instant", () => {
    assert.equal(isInstantEmpty(100, "model error (boom)"), false)
    assert.equal(isInstantEmpty(100, null), false)
  })
})

describe("hasTextPart", () => {
  it("true only for non-empty text parts", () => {
    assert.equal(hasTextPart([{ type: "text", text: "hi" }]), true)
    assert.equal(hasTextPart([{ type: "text", text: "" }]), false)
    assert.equal(hasTextPart([{ type: "tool", text: "x" }]), false)
    assert.equal(hasTextPart([]), false)
  })
})

describe("pollContinues", () => {
  it("waits while the shared idle clock advances", () => {
    assert.equal(pollContinues(1000, 1000 + 30_000), true)
  })

  it("exits on frozen idle or unknown", () => {
    assert.equal(pollContinues(1000, 1000 + 61_000), false)
    assert.equal(pollContinues(undefined, Date.now()), false)
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
