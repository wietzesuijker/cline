import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadEnergyRows } from "./loadEnergyRows"

// Synthetic values only: the real CLEER data is CC BY-NC 4.0 and must not be committed.
const HEADER = "model_name,use_case,tier,energy_wh_mean,energy_wh_sd,carbon_gco2e_mean,energy_wh_per_usd"

describe("loadEnergyRows", () => {
	it("returns undefined for an unset, missing or non-CLEER path", () => {
		const dir = mkdtempSync(join(tmpdir(), "energy-"))
		try {
			const bad = join(dir, "bad.csv")
			writeFileSync(bad, "a,b\n1,2")
			assert.equal(loadEnergyRows(undefined), undefined)
			assert.equal(loadEnergyRows(""), undefined)
			assert.equal(loadEnergyRows(join(dir, "missing.csv")), undefined)
			assert.equal(loadEnergyRows(bad), undefined)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	it("parses the file and reloads when it changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "energy-"))
		try {
			const csv = join(dir, "cleer.csv")
			writeFileSync(csv, `${HEADER}\nClaude Opus 4.5,Agentic,Typical,100,25,60,10`)
			assert.equal(loadEnergyRows(csv)?.[0].whPerUsd, 10)
			assert.equal(loadEnergyRows(csv), loadEnergyRows(csv))
			writeFileSync(csv, `${HEADER}\nClaude Opus 4.5,Agentic,Typical,100,25,60,20`)
			const future = new Date(Date.now() + 5000)
			utimesSync(csv, future, future)
			assert.equal(loadEnergyRows(csv)?.[0].whPerUsd, 20)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})
