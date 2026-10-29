import { EventEmitter } from 'node:events'
import net from 'node:net'
import {
	COLUMNS,
	INFO_REQUEST,
	LINES,
	LineSplitter,
	formatSetColor,
	parseLine,
	toHex,
	type RamiInfo,
	type RamiMessage,
	type Rgb,
} from './ramiv3.js'

export interface Logger {
	debug: (message: string) => void
	info: (message: string) => void
	warn: (message: string) => void
	error: (message: string) => void
}

export const NO_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

export interface ConnectionEvents {
	key: [column: number, line: number, pressed: boolean]
	/** Every parsed frame received from the device (used by tools and tests) */
	message: [message: RamiMessage]
	/** Emitted once, when the link is lost or closed. `null` = closed on purpose. */
	closed: [error: Error | null]
}

const CONNECT_TIMEOUT_MS = 4000
const HANDSHAKE_TIMEOUT_MS = 3000
const HEARTBEAT_INTERVAL_MS = 5000
const HEARTBEAT_TIMEOUT_MS = 3000
/** The Telnet task of the firmware reads a few frames per main-loop pass: send in small paced bursts */
const FLUSH_INTERVAL_MS = 25
const LINES_PER_FLUSH = 6
const MAX_SOCKET_BACKLOG = 4096

/**
 * One Telnet session with one Cartridge (RAMIv3). Single use: after `closed` a new instance is needed.
 *
 * Colour writes are coalesced per key (the latest colour wins), de-duplicated against what the
 * device already shows, and sent in paced bursts.
 */
export class CartridgeConnection extends EventEmitter<ConnectionEvents> {
	readonly #socket: net.Socket
	readonly #log: Logger
	readonly #splitter = new LineSplitter()
	#info: RamiInfo | null = null

	readonly #desired = new Map<number, Rgb>()
	readonly #sent = new Map<number, string>()
	readonly #dirty = new Set<number>()

	#flushTimer: NodeJS.Timeout | null = null
	#heartbeatTimer: NodeJS.Timeout | null = null
	#heartbeatDeadline: NodeJS.Timeout | null = null
	#handshake: ((info: RamiInfo) => void) | null = null
	#closed = false

	private constructor(socket: net.Socket, log: Logger) {
		super()
		this.#socket = socket
		this.#log = log
		socket.on('data', (chunk) => this.#onData(chunk))
		socket.on('error', (err) => this.#shutdown(err))
		socket.on('close', () => this.#shutdown(new Error('Connection closed by the device')))
	}

	static async open(address: string, port: number, log: Logger = NO_LOGGER): Promise<CartridgeConnection> {
		const socket = await connectSocket(address, port)
		const conn = new CartridgeConnection(socket, log)
		try {
			conn.#info = await conn.#doHandshake()
		} catch (e) {
			conn.#shutdown(null)
			throw e
		}
		conn.#heartbeatTimer = setInterval(() => conn.#heartbeat(), HEARTBEAT_INTERVAL_MS)
		log.info(
			`Connected to ${address}:${port}, device id ${conn.#info.deviceId}, firmware ${conn.#info.deviceVersion ?? '?'}, protocol ${conn.#info.protocolVersion ?? '?'}`,
		)
		return conn
	}

	get info(): RamiInfo {
		if (!this.#info) throw new Error('Connection not ready')
		return this.#info
	}

	get isClosed(): boolean {
		return this.#closed
	}

	/** Wanted colour of a key (already scaled by brightness). Sent at the next flush if it differs from the device. */
	setColor(column: number, line: number, color: Rgb): void {
		if (column < 0 || column >= COLUMNS || line < 0 || line >= LINES) return
		const idx = line * COLUMNS + column
		this.#desired.set(idx, color)
		if (this.#sent.get(idx) === toHex(color)) this.#dirty.delete(idx)
		else this.#dirty.add(idx)
		this.#scheduleFlush()
	}

	/** Forget what the device shows and send everything again (reconnection, device animation reset...) */
	resendAll(): void {
		this.#sent.clear()
		for (const idx of this.#desired.keys()) this.#dirty.add(idx)
		this.#scheduleFlush()
	}

	/** Send a raw frame (CRLF added). For tools and tests. */
	sendRaw(frame: string): void {
		this.#write(frame + '\r\n')
	}

	close(): void {
		this.#shutdown(null)
	}

	async #doHandshake(): Promise<RamiInfo> {
		return new Promise<RamiInfo>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#handshake = null
				reject(
					new Error(
						'No answer to INFO: check that the Cartridge protocol is RAMIv3 and that Telnet is enabled (RX and TX)',
					),
				)
			}, HANDSHAKE_TIMEOUT_MS)
			this.#handshake = (info) => {
				clearTimeout(timer)
				this.#handshake = null
				resolve(info)
			}
			this.#write(INFO_REQUEST)
		})
	}

	#onData(chunk: Buffer): void {
		for (const line of this.#splitter.push(chunk)) {
			const msg = parseLine(line)
			this.emit('message', msg)
			switch (msg.kind) {
				case 'event':
					if (msg.column < COLUMNS && msg.line < LINES) this.emit('key', msg.column, msg.line, msg.pressed)
					break
				case 'info':
					if (this.#heartbeatDeadline) {
						clearTimeout(this.#heartbeatDeadline)
						this.#heartbeatDeadline = null
					}
					this.#handshake?.(msg.info)
					break
				case 'error':
					this.#log.warn(`Device error ${msg.code}: ${msg.message}`)
					break
				case 'unknown':
					this.#log.debug(`Unexpected frame: ${msg.raw}`)
					break
				default:
					break
			}
		}
	}

	#heartbeat(): void {
		if (this.#closed || this.#heartbeatDeadline) return
		this.#write(INFO_REQUEST)
		this.#heartbeatDeadline = setTimeout(
			() => this.#shutdown(new Error('The Cartridge stopped answering')),
			HEARTBEAT_TIMEOUT_MS,
		)
	}

	#scheduleFlush(): void {
		if (this.#flushTimer || this.#closed || this.#dirty.size === 0) return
		this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_INTERVAL_MS)
	}

	#flush(): void {
		this.#flushTimer = null
		if (this.#closed) return
		if (this.#socket.writableLength > MAX_SOCKET_BACKLOG) {
			this.#scheduleFlush()
			return
		}
		let out = ''
		let count = 0
		for (const idx of this.#dirty) {
			if (count >= LINES_PER_FLUSH) break
			const color = this.#desired.get(idx)
			this.#dirty.delete(idx)
			if (!color) continue
			out += formatSetColor(this.info.deviceId, idx % COLUMNS, Math.floor(idx / COLUMNS), color)
			this.#sent.set(idx, toHex(color))
			count++
		}
		if (out) this.#write(out)
		this.#scheduleFlush()
	}

	#write(data: string): void {
		if (this.#closed) return
		this.#socket.write(data, 'latin1')
	}

	#shutdown(error: Error | null): void {
		if (this.#closed) return
		this.#closed = true
		if (this.#flushTimer) clearTimeout(this.#flushTimer)
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
		if (this.#heartbeatDeadline) clearTimeout(this.#heartbeatDeadline)
		this.#flushTimer = this.#heartbeatTimer = this.#heartbeatDeadline = null
		this.#socket.destroy()
		if (error) this.#log.warn(`Connection lost: ${error.message}`)
		this.emit('closed', error)
	}
}

async function connectSocket(address: string, port: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: address, port })
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`Timeout connecting to ${address}:${port}`))
		}, CONNECT_TIMEOUT_MS)
		socket.once('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
		socket.once('connect', () => {
			clearTimeout(timer)
			socket.removeAllListeners('error')
			socket.setNoDelay(true)
			socket.setKeepAlive(true, 5000)
			resolve(socket)
		})
	})
}
