/**
 * Opt-in energy/carbon estimate for a task's API cost, from the CLEER dashboard
 * (https://cleerdash.sustainableaigroup.com/, CC BY-NC 4.0). The data is never
 * bundled: the user points a setting at their own copy of the dashboard CSV.
 *
 * Wh = task cost (USD) x energy_wh_per_usd of the model's Agentic/Typical row;
 * the range is +/- that row's energy SD/mean; gCO2e scales with the row's
 * carbon/energy ratio, or with a user-supplied grid intensity. Valid for agentic
 * use only (CLEER's Chat Wh/USD is about 2.7x higher), and decode energy ignores
 * context length, so long-context tasks may run higher.
 */

export interface EnergyRow {
	/** Normalized model name, see {@link normalizeModelName}. */
	key: string
	whPerUsd: number
	sdRatio: number
	gPerWh: number
}

export interface EnergyEstimate {
	wh: number
	lo: number
	hi: number
	gco2e: number
	/** True when the row is a nearby Claude version, not the model itself. */
	proxy: boolean
}

export interface EnergyFormatOptions {
	/** Grid intensity in gCO2e/kWh; replaces CLEER's own carbon/energy ratio. */
	gridGPerKwh?: number
	/** Show energy only. */
	energyOnly?: boolean
}

const REQUIRED_COLUMNS = [
	"model_name",
	"use_case",
	"tier",
	"energy_wh_mean",
	"energy_wh_sd",
	"carbon_gco2e_mean",
	"energy_wh_per_usd",
]
const CLAUDE_VERSION = /(opus|sonnet|haiku|fable) (\d+)(?:\.(\d))?/

/** Quote-aware CSV line split (CLEER descriptions contain commas). */
function splitCsvLine(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let quoted = false
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"'
				i++
			} else if (ch === '"') {
				quoted = false
			} else {
				cur += ch
			}
		} else if (ch === '"') {
			quoted = true
		} else if (ch === ",") {
			out.push(cur)
			cur = ""
		} else {
			cur += ch
		}
	}
	out.push(cur)
	return out
}

/** "anthropic/claude-opus-4-5-20251101", "claude-opus-4-8[1m]", "GPT-5.4 mini", "x/gpt-5.4-mini:free" -> "opus 4.5", "opus 4.8", "gpt 5.4 mini", "gpt 5.4 mini". */
export function normalizeModelName(name: string | undefined): string {
	return String(name ?? "")
		.toLowerCase()
		.replace(/^.*\//, "")
		.replace(/:.*$/, "")
		.replace(/\[[^\]]*\]/g, "")
		.replace(/-\d{8}\b/g, "")
		.replace(/(\d)-(\d)(?!\d)/g, "$1.$2")
		.replace(/[^a-z0-9.]+/g, " ")
		.replace(/^claude /, "")
		.trim()
}

/** Agentic/Typical rows of a CLEER dashboard CSV. Throws if a required column is missing. */
export function parseCleerCsv(text: string): EnergyRow[] {
	const lines = text.split(/\r?\n/).filter(Boolean)
	const col: Record<string, number> = {}
	splitCsvLine(lines[0] ?? "").forEach((h, i) => {
		col[h.trim()] = i
	})
	for (const k of REQUIRED_COLUMNS) {
		if (!(k in col)) {
			throw new Error(`CLEER CSV missing column: ${k}`)
		}
	}
	const rows: EnergyRow[] = []
	for (const line of lines.slice(1)) {
		const r = splitCsvLine(line)
		if (r[col.use_case] !== "Agentic" || r[col.tier] !== "Typical") {
			continue
		}
		const mean = Number(r[col.energy_wh_mean])
		const whPerUsd = Number(r[col.energy_wh_per_usd])
		if (!(mean > 0) || !(whPerUsd > 0)) {
			continue
		}
		rows.push({
			key: normalizeModelName(r[col.model_name]),
			whPerUsd,
			sdRatio: Number(r[col.energy_wh_sd]) / mean || 0,
			gPerWh: Number(r[col.carbon_gco2e_mean]) / mean,
		})
	}
	return rows
}

function claudeVersion(key: string): { family: string; version: number } | undefined {
	const m = CLAUDE_VERSION.exec(key)
	return m ? { family: m[1], version: Number(`${m[2]}.${m[3] ?? "0"}`) } : undefined
}

/** Exact name first; for Claude, else the newest lower same-family version, else the newest of the family. */
export function matchEnergyRow(rows: EnergyRow[], model: string | undefined): { row: EnergyRow; proxy: boolean } | undefined {
	const key = normalizeModelName(model)
	const exact = rows.find((r) => r.key === key)
	if (exact) {
		return { row: exact, proxy: false }
	}
	const want = claudeVersion(key)
	if (!want) {
		return undefined
	}
	const family = rows
		.map((row) => ({ row, v: claudeVersion(row.key) }))
		.filter((c): c is { row: EnergyRow; v: { family: string; version: number } } => c.v?.family === want.family)
		.sort((a, b) => b.v.version - a.v.version)
	const near = family.find((c) => c.v.version < want.version) ?? family[0]
	return near ? { row: near.row, proxy: true } : undefined
}

export function estimateEnergy(rows: EnergyRow[], model: string | undefined, costUsd: number): EnergyEstimate | undefined {
	const m = matchEnergyRow(rows, model)
	if (!m || !(costUsd > 0)) {
		return undefined
	}
	const wh = costUsd * m.row.whPerUsd
	return {
		wh,
		lo: wh * Math.max(0, 1 - m.row.sdRatio),
		hi: wh * (1 + m.row.sdRatio),
		gco2e: wh * m.row.gPerWh,
		proxy: m.proxy,
	}
}

/** >=10 integer, <10 one decimal, anything that would show "0.0" shows "0". */
export function formatSmall(x: number): string {
	const s = x >= 9.95 ? String(Math.round(x)) : x.toFixed(1)
	return s === "0.0" ? "0" : s
}

/** "lo-hi", once when both ends display alike, "<0.1" when a nonzero high end would display as 0.0. */
export function formatRange(lo: number, hi: number): string {
	const [a, b] = [formatSmall(lo), formatSmall(hi)]
	return hi > 0 && b === "0" ? "<0.1" : a === b ? a : `${a}-${b}`
}

/** "⚡ ~44-66 Wh · 30-45 gCO₂e"; "~" marks a proxied Claude version, kWh from 1000 Wh up. */
export function formatEnergy(e: EnergyEstimate, opts: EnergyFormatOptions = {}): string {
	const k = e.hi >= 1000 ? 1000 : 1
	const label = `⚡ ${e.proxy ? "~" : ""}${formatRange(e.lo / k, e.hi / k)} ${k > 1 ? "kWh" : "Wh"}`
	if (opts.energyOnly) {
		return label
	}
	const g = opts.gridGPerKwh && opts.gridGPerKwh > 0 ? opts.gridGPerKwh / 1000 : e.gco2e / e.wh
	return `${label} · ${formatRange(e.lo * g, e.hi * g)} gCO₂e`
}
