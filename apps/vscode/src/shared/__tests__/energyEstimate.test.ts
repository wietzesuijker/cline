import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import {
	estimateEnergy,
	formatEnergy,
	formatRange,
	formatSmall,
	matchEnergyRow,
	normalizeModelName,
	parseCleerCsv,
} from "../energyEstimate"

// Synthetic values only: the real CLEER data is CC BY-NC 4.0 and must not be committed.
const CSV = [
	"model_name,use_case,tier,energy_wh_mean,energy_wh_sd,carbon_gco2e_mean,energy_wh_per_usd,description",
	'Claude Opus 4.5,Agentic,Typical,100,25,60,10,"synthetic, with comma"',
	"Claude Opus 4.5,Chat,Typical,100,25,60,27,",
	"Claude Opus 4.5,Agentic,Heavy,100,25,60,99,",
	"Claude Sonnet 4.0,Agentic,Typical,50,5,20,4,",
	"Claude Sonnet 4.5,Agentic,Typical,50,5,20,5,",
	"GPT-5.4 mini,Agentic,Typical,10,1,4,2,",
	"Broken,Agentic,Typical,0,0,0,0,",
].join("\n")

describe("energyEstimate", () => {
	const rows = parseCleerCsv(CSV)

	it("keeps only valid Agentic/Typical rows", () => {
		assert.deepEqual(
			rows.map((r) => r.key),
			["opus 4.5", "sonnet 4.0", "sonnet 4.5", "gpt 5.4 mini"],
		)
		assert.equal(rows[0].whPerUsd, 10)
	})

	it("rejects a CSV missing a required column", () => {
		assert.throws(() => parseCleerCsv("model_name,use_case\nx,y"), /missing column: tier/)
		assert.throws(() => parseCleerCsv(""), /missing column/)
	})

	it("normalizes model names", () => {
		assert.equal(normalizeModelName("anthropic/claude-opus-4-5-20251101"), "opus 4.5")
		assert.equal(normalizeModelName("claude-opus-4-8[1m]"), "opus 4.8")
		assert.equal(normalizeModelName("openai/GPT-5.4 mini"), "gpt 5.4 mini")
		assert.equal(normalizeModelName(undefined), "")
		assert.equal(normalizeModelName("anthropic/claude-sonnet-4.5:beta"), "sonnet 4.5")
		assert.equal(normalizeModelName("anthropic/claude-3.7-sonnet:thinking"), "3.7 sonnet")
		assert.equal(normalizeModelName("openai/gpt-5.4-mini:free"), "gpt 5.4 mini")
	})

	it("matches exact first, then proxies Claude versions", () => {
		assert.deepEqual(
			[matchEnergyRow(rows, "claude-sonnet-4-5-20250929")?.row.whPerUsd, matchEnergyRow(rows, "claude-sonnet-4-5")?.proxy],
			[5, false],
		)
		// Newer than anything listed: newest lower version, marked as a proxy.
		assert.deepEqual(matchEnergyRow(rows, "claude-sonnet-4-8"), { row: rows[2], proxy: true })
		// Older than anything listed: newest of the family.
		assert.deepEqual(matchEnergyRow(rows, "claude-sonnet-3-7"), { row: rows[2], proxy: true })
		assert.equal(matchEnergyRow(rows, "openai/gpt-5.4-mini")?.proxy, false)
		assert.equal(matchEnergyRow(rows, "openai/gpt-5.4-mini:free")?.proxy, false)
		assert.deepEqual(matchEnergyRow(rows, "anthropic/claude-sonnet-4-5:beta"), { row: rows[2], proxy: false })
		assert.equal(matchEnergyRow(rows, "gpt-9"), undefined)
		assert.equal(matchEnergyRow(rows, "claude-haiku-4-5"), undefined)
		assert.equal(matchEnergyRow(rows, undefined), undefined)
	})

	it("estimates Wh, range and carbon from cost", () => {
		const e = estimateEnergy(rows, "claude-opus-4-5", 4.4)
		assert.ok(e)
		assert.equal(e.wh, 44)
		assert.equal(e.lo, 33)
		assert.equal(e.hi, 55)
		assert.equal(e.gco2e, 26.4)
		assert.equal(estimateEnergy(rows, "claude-opus-4-5", 0), undefined)
		assert.equal(estimateEnergy(rows, "gpt-9", 1), undefined)
	})

	it("clamps the low end at zero", () => {
		const e = estimateEnergy(parseCleerCsv(CSV.replace("100,25,60,10", "100,150,60,10")), "opus 4.5", 1)
		assert.equal(e?.lo, 0)
	})

	it("formats energy and carbon, marking proxies", () => {
		const e = estimateEnergy(rows, "claude-opus-4-5", 4.4)
		assert.ok(e)
		assert.equal(formatEnergy(e), "⚡ 33-55 Wh · 20-33 gCO₂e")
		assert.equal(formatEnergy(e, { energyOnly: true }), "⚡ 33-55 Wh")
		assert.equal(formatEnergy(e, { gridGPerKwh: 500 }), "⚡ 33-55 Wh · 17-28 gCO₂e")
		assert.equal(formatEnergy({ ...e, proxy: true }, { energyOnly: true }), "⚡ ~33-55 Wh")
	})

	it("switches to kWh from 1000 Wh and collapses an empty range", () => {
		const big = estimateEnergy(rows, "claude-opus-4-5", 100)
		assert.ok(big)
		assert.equal(formatEnergy(big, { energyOnly: true }), "⚡ 0.8-1.3 kWh")
		const flat = estimateEnergy(rows, "gpt-5.4-mini", 1)
		assert.ok(flat)
		assert.equal(formatEnergy({ ...flat, lo: 2, hi: 2, wh: 2 }, { energyOnly: true }), "⚡ 2.0 Wh")
	})

	it("rounds small values per the shared spec", () => {
		assert.deepEqual([0, 0.04, 0.05, 1.23, 9.94, 9.96, 10, 123.4].map(formatSmall), [
			"0",
			"0",
			"0.1",
			"1.2",
			"9.9",
			"10",
			"10",
			"123",
		])
		assert.equal(formatRange(0, 0.04), "<0.1")
		assert.equal(formatRange(0.01, 0.2), "0-0.2")
		assert.equal(formatRange(0.04, 0.06), "0-0.1")
		assert.equal(formatRange(0, 0), "0")
		assert.equal(formatRange(0, 3), "0-3.0")
		assert.equal(formatRange(1.21, 1.24), "1.2")
		assert.equal(formatRange(12.2, 12.4), "12")
		const tiny = estimateEnergy(rows, "gpt-5.4-mini", 0.001)
		assert.ok(tiny)
		assert.equal(formatEnergy(tiny), "⚡ <0.1 Wh · <0.1 gCO₂e")
	})
})
