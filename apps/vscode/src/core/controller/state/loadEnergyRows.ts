import { type EnergyRow, parseCleerCsv } from "@shared/energyEstimate"
import { readFileSync, statSync } from "fs"
import { Logger } from "@/shared/services/Logger"

let warnedPath: string | undefined
let cache: { path: string; mtimeMs: number; rows: EnergyRow[] } | undefined

/**
 * CLEER rows from the user-supplied CSV path, or undefined when the path is unset, unreadable or not a CLEER CSV.
 * Cached by path and mtime because the state is rebuilt on every post to the webview.
 */
export function loadEnergyRows(csvPath: string | undefined): EnergyRow[] | undefined {
	if (!csvPath) {
		return undefined
	}
	try {
		const mtimeMs = statSync(csvPath).mtimeMs
		if (cache?.path === csvPath && cache.mtimeMs === mtimeMs) {
			return cache.rows
		}
		const rows = parseCleerCsv(readFileSync(csvPath, "utf8"))
		cache = { path: csvPath, mtimeMs, rows }
		return rows
	} catch (error) {
		if (warnedPath !== csvPath) {
			warnedPath = csvPath
			Logger.warn(`[energy-estimate] cannot read ${csvPath}: ${error instanceof Error ? error.message : String(error)}`)
		}
		return undefined
	}
}
