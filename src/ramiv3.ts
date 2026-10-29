/**
 * RAMIv3 protocol helpers (text, CRLF framed) spoken by the Cartridge over Telnet (TCP 23).
 * Pure functions only, so they can be unit tested without any socket.
 *
 * Reference: Protocole_RAmiv3.docx (version 1.2, protocol v3.2). Frames observed on a real unit
 * (firmware v1.3, protocol v3.1):
 *   EVENT ID|35.BUT:[0-0].KEY=DOWN;
 *   INFO ID|35 IP=192.168.1.64;COLUMN_MAX=3;LINE_MAX=7;DEVICE_VERSION=v1.3;PROTOCOL_VERSION=v3.1;INTERFACE_TELNET=3;...
 */

export const COLUMNS = 4
export const LINES = 8

export interface Rgb {
	r: number
	g: number
	b: number
}

export interface RamiInfo {
	deviceId: number
	ip: string | null
	columnMax: number
	lineMax: number
	deviceVersion: string | null
	protocolVersion: string | null
	/** Telnet status: bit 0 = RX on, bit 1 = TX on (3 = both) */
	telnet: number | null
}

export type RamiMessage =
	| { kind: 'event'; deviceId: number; column: number; line: number; pressed: boolean }
	| { kind: 'info'; info: RamiInfo }
	| { kind: 'indic'; deviceId: number; column: number; line: number; action: string; value: string }
	| { kind: 'ack'; deviceId: number; column: number; line: number }
	| { kind: 'error'; code: number; deviceId: number | null; message: string }
	| { kind: 'unknown'; raw: string }

/** Ask the device on this connection for its identity (any device id answers an "ALL" request) */
export const INFO_REQUEST = 'INFO ALL| ALL;\r\n'

const EVENT_RE = /^EVENT ID\|(\d+)\.BUT:\[(\d+)-(\d+)\]\.KEY=(DOWN|UP);?$/
const INFO_RE = /^INFO ID\|(\d+) (.*)$/
const INDIC_RE = /^INDIC ID\|(\d+)\.BUT:\[(\d+)-(\d+)\]\.([A-Z_]+)=([^;]*);?$/
/** SET acknowledgement, protocol v3.2 and later */
const ACK_RE = /^ACK ID\|(\d+)\.BUT:\[(\d+)-(\d+)\];?$/
/** "ERROR|2 ID|35 : UNKNOWN ACTION" since protocol v3.2, "ERROR|2 : UNKNOW ACTION COMMAND " before */
const ERROR_RE = /^ERROR\|(\d+)(?: ID\|(\d+))? : (.*?)\s*$/

export function parseLine(raw: string): RamiMessage {
	const line = raw.trim()

	let m = EVENT_RE.exec(line)
	if (m) {
		return {
			kind: 'event',
			deviceId: Number(m[1]),
			column: Number(m[2]),
			line: Number(m[3]),
			pressed: m[4] === 'DOWN',
		}
	}

	m = INFO_RE.exec(line)
	if (m) {
		const fields = new Map<string, string>()
		for (const part of m[2].split(';')) {
			const eq = part.indexOf('=')
			if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
		}
		const num = (key: string): number | null => {
			const v = fields.get(key)
			return v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v)
		}
		return {
			kind: 'info',
			info: {
				deviceId: Number(m[1]),
				ip: fields.get('IP') ?? null,
				columnMax: num('COLUMN_MAX') ?? COLUMNS - 1,
				lineMax: num('LINE_MAX') ?? LINES - 1,
				deviceVersion: fields.get('DEVICE_VERSION') ?? null,
				protocolVersion: fields.get('PROTOCOL_VERSION') ?? null,
				telnet: num('INTERFACE_TELNET'),
			},
		}
	}

	m = INDIC_RE.exec(line)
	if (m) {
		return {
			kind: 'indic',
			deviceId: Number(m[1]),
			column: Number(m[2]),
			line: Number(m[3]),
			action: m[4],
			value: m[5],
		}
	}

	m = ACK_RE.exec(line)
	if (m) return { kind: 'ack', deviceId: Number(m[1]), column: Number(m[2]), line: Number(m[3]) }

	m = ERROR_RE.exec(line)
	if (m) return { kind: 'error', code: Number(m[1]), deviceId: m[2] === undefined ? null : Number(m[2]), message: m[3] }

	return { kind: 'unknown', raw: line }
}

/**
 * Splits a byte stream into lines. The device may glue several frames in one TCP segment
 * (observed: DOWN and UP of the same key in one read) or cut one in two.
 */
export class LineSplitter {
	#buffer = ''

	push(chunk: Buffer | string): string[] {
		this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1')
		const out: string[] = []
		let index: number
		while ((index = this.#buffer.indexOf('\n')) >= 0) {
			const line = this.#buffer.slice(0, index).replace(/\r$/, '')
			this.#buffer = this.#buffer.slice(index + 1)
			if (line.length > 0) out.push(line)
		}
		// A device that never sends a terminator must not make us grow without bound
		if (this.#buffer.length > 4096) this.#buffer = ''
		return out
	}
}

/**
 * Set the steady colour of one key. Only COLORON is sent: the document reserves COLOROFF to the
 * blinking, and BLINK=0 makes sure a blink left by another host is stopped.
 */
export function formatSetColor(deviceId: number, column: number, line: number, color: Rgb): string {
	return `SET ID|${deviceId}.BUT:[${column}-${line}] COLORON=${toHex(color)};BLINK=0\r\n`
}

export function formatGetKey(deviceId: number, column: number, line: number): string {
	return `GET ID|${deviceId}.BUT:[${column}-${line}] COLORON;COLOROFF;BLINK\r\n`
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

export function toHex(color: Rgb): string {
	const h = (v: number): string => clamp(v).toString(16).padStart(2, '0')
	return `#${h(color.r)}${h(color.g)}${h(color.b)}`.toUpperCase()
}

export const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** Accepts "#rrggbb", "rrggbb", "#rgb" and "rgb(r,g,b)" (Companion `colors: 'hex' | 'rgb'`) */
export function parseColor(input: string | undefined | null): Rgb {
	if (!input) return BLACK
	const s = input.trim()

	let m = /^#?([0-9a-f]{6})$/i.exec(s)
	if (m) {
		const n = parseInt(m[1], 16)
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
	}
	m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s)
	if (m) return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16) }
	m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s)
	if (m) return { r: clamp(Number(m[1])), g: clamp(Number(m[2])), b: clamp(Number(m[3])) }
	return BLACK
}

/** Companion brightness (0..100). The Cartridge cannot change its brightness over RAMIv3. */
export function scaleColor(color: Rgb, percent: number): Rgb {
	const f = Math.max(0, Math.min(100, percent)) / 100
	return { r: clamp(color.r * f), g: clamp(color.g * f), b: clamp(color.b * f) }
}

/** Companion control id <-> Cartridge position. Control ids are "line/column", both 0-based. */
export function controlId(column: number, line: number): string {
	return `${line}/${column}`
}

export function parseControlId(id: string): { column: number; line: number } | null {
	const m = /^(\d+)\/(\d+)$/.exec(id)
	if (!m) return null
	const line = Number(m[1])
	const column = Number(m[2])
	return line < LINES && column < COLUMNS ? { column, line } : null
}

export function keyIndex(column: number, line: number): number {
	return line * COLUMNS + column
}
