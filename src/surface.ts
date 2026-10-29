import type {
	CardGenerator,
	SurfaceContext,
	SurfaceDrawProps,
	SurfaceInstance,
	SurfaceSchemaLayoutDefinition,
} from '@companion-surface/base'
import type { CartridgeConnection, Logger } from './connection.js'
import {
	BLACK,
	COLUMNS,
	LINES,
	controlId,
	keyIndex,
	parseColor,
	parseControlId,
	scaleColor,
	type Rgb,
} from './ramiv3.js'

/** 8 lines x 4 columns, colours only (no bitmap, no text). Control ids are "line/column". */
export function buildLayout(): SurfaceSchemaLayoutDefinition {
	const controls: SurfaceSchemaLayoutDefinition['controls'] = {}
	for (let line = 0; line < LINES; line++) {
		for (let column = 0; column < COLUMNS; column++) {
			controls[controlId(column, line)] = { row: line, column }
		}
	}
	return { stylePresets: { default: { colors: 'hex' } }, controls }
}

export class CartridgeSurface implements SurfaceInstance {
	readonly surfaceId: string
	readonly productName = 'Cartridge'

	readonly #connection: CartridgeConnection
	readonly #context: SurfaceContext
	readonly #log: Logger

	/** Colours as drawn by Companion, before brightness */
	readonly #drawn = new Map<number, Rgb>()
	#brightness = 100
	#closing = false

	constructor(surfaceId: string, connection: CartridgeConnection, context: SurfaceContext, log: Logger) {
		this.surfaceId = surfaceId
		this.#connection = connection
		this.#context = context
		this.#log = log
	}

	async init(): Promise<void> {
		this.#connection.on('key', (column, line, pressed) => {
			const id = controlId(column, line)
			if (pressed) this.#context.keyDownById(id)
			else this.#context.keyUpById(id)
		})
		this.#connection.on('closed', (error) => {
			if (this.#closing) return
			this.#context.disconnect(error ?? new Error('Cartridge disconnected'))
		})
	}

	async close(): Promise<void> {
		this.#closing = true
		this.#connection.close()
	}

	async ready(): Promise<void> {
		// A unit that rebooted or played its animation shows its own colours: start from a clean state
		this.#connection.resendAll()
	}

	async setBrightness(percent: number): Promise<void> {
		this.#brightness = percent
		for (const [idx, color] of this.#drawn) this.#show(idx, color)
	}

	async blank(): Promise<void> {
		for (let idx = 0; idx < COLUMNS * LINES; idx++) {
			this.#drawn.set(idx, BLACK)
			this.#show(idx, BLACK)
		}
	}

	async draw(_signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void> {
		const position = parseControlId(drawProps.controlId)
		if (!position) {
			this.#log.debug(`Ignoring draw for unknown control ${drawProps.controlId}`)
			return
		}
		const idx = keyIndex(position.column, position.line)
		const color = parseColor(drawProps.color)
		this.#drawn.set(idx, color)
		this.#show(idx, color)
	}

	async showStatus(_signal: AbortSignal, _cardGenerator: CardGenerator, _statusMessage: string): Promise<void> {
		await this.blank()
	}

	#show(idx: number, color: Rgb): void {
		this.#connection.setColor(idx % COLUMNS, Math.floor(idx / COLUMNS), scaleColor(color, this.#brightness))
	}
}
