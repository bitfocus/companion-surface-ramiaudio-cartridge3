import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	LineSplitter,
	controlId,
	formatGetKey,
	formatSetColor,
	keyIndex,
	parseColor,
	parseControlId,
	parseLine,
	scaleColor,
	toHex,
} from '../dist/ramiv3.js'
import { directedBroadcast, parseAnnounce } from '../dist/discovery.js'

test('parses the EVENT frames observed on a real unit', () => {
	assert.deepEqual(parseLine('EVENT ID|35.BUT:[0-0].KEY=DOWN;'), {
		kind: 'event',
		deviceId: 35,
		column: 0,
		line: 0,
		pressed: true,
	})
	assert.deepEqual(parseLine('EVENT ID|35.BUT:[3-7].KEY=UP;'), {
		kind: 'event',
		deviceId: 35,
		column: 3,
		line: 7,
		pressed: false,
	})
})

test('parses the INFO answer observed on a real unit', () => {
	const msg = parseLine(
		'INFO ID|35 IP=192.168.1.64;COLUMN_MAX=3;LINE_MAX=7;DEVICE_VERSION=v1.3;PROTOCOL_VERSION=v3.1;INTERFACE_TELNET=3;INTERFACE_TCP=0;INTERFACE_RS232=0;',
	)
	assert.equal(msg.kind, 'info')
	assert.deepEqual(msg.info, {
		deviceId: 35,
		ip: '192.168.1.64',
		columnMax: 3,
		lineMax: 7,
		deviceVersion: 'v1.3',
		protocolVersion: 'v3.1',
		telnet: 3,
	})
})

test('parses GET answers and errors', () => {
	assert.deepEqual(parseLine('INDIC ID|35.BUT:[0-0].COLORON=#00FF00;'), {
		kind: 'indic',
		deviceId: 35,
		column: 0,
		line: 0,
		action: 'COLORON',
		value: '#00FF00',
	})
	assert.deepEqual(parseLine('INDIC ID|35.BUT:[0-0].BLINK=0;'), {
		kind: 'indic',
		deviceId: 35,
		column: 0,
		line: 0,
		action: 'BLINK',
		value: '0',
	})
	assert.deepEqual(parseLine("ERROR|6 : BLINK VALUE ISN'T RECOGNIZE "), {
		kind: 'error',
		code: 6,
		deviceId: null,
		message: "BLINK VALUE ISN'T RECOGNIZE",
	})
	assert.deepEqual(parseLine('ERROR|6 ID|35 : BLINK VALUE NOT RECOGNIZED'), {
		kind: 'error',
		code: 6,
		deviceId: 35,
		message: 'BLINK VALUE NOT RECOGNIZED',
	})
	assert.deepEqual(parseLine('ACK ID|35.BUT:[2-5];'), { kind: 'ack', deviceId: 35, column: 2, line: 5 })
	assert.equal(parseLine('garbage').kind, 'unknown')
})

test('splits glued and cut frames', () => {
	const s = new LineSplitter()
	// DOWN and UP of the same key arrive in one segment on the real unit
	assert.deepEqual(s.push('EVENT ID|35.BUT:[0-0].KEY=DOWN;\r\nEVENT ID|35.BUT:[0-0].KEY=UP;\r\n'), [
		'EVENT ID|35.BUT:[0-0].KEY=DOWN;',
		'EVENT ID|35.BUT:[0-0].KEY=UP;',
	])
	assert.deepEqual(s.push('INFO ID|3'), [])
	assert.deepEqual(s.push('5 IP=1.2.3.4;\r\n'), ['INFO ID|35 IP=1.2.3.4;'])
})

test('formats SET with COLORON and BLINK=0 only, uppercase hex', () => {
	assert.equal(formatSetColor(35, 2, 5, { r: 0, g: 255, b: 16 }), 'SET ID|35.BUT:[2-5] COLORON=#00FF10;BLINK=0\r\n')
	assert.equal(formatGetKey(35, 0, 0), 'GET ID|35.BUT:[0-0] COLORON;COLOROFF;BLINK\r\n')
	assert.ok(!formatSetColor(0, 0, 0, { r: 1, g: 2, b: 3 }).includes('COLOROFF'))
})

test('parses the colour formats Companion can hand over', () => {
	assert.deepEqual(parseColor('#ff8000'), { r: 255, g: 128, b: 0 })
	assert.deepEqual(parseColor('FF8000'), { r: 255, g: 128, b: 0 })
	assert.deepEqual(parseColor('#f80'), { r: 255, g: 136, b: 0 })
	assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30 })
	assert.deepEqual(parseColor('rgb(300,0,0)'), { r: 255, g: 0, b: 0 })
	assert.deepEqual(parseColor(undefined), { r: 0, g: 0, b: 0 })
	assert.deepEqual(parseColor('not a colour'), { r: 0, g: 0, b: 0 })
	assert.equal(toHex({ r: 1, g: 171, b: 255 }), '#01ABFF')
})

test('scales by brightness', () => {
	assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 50), { r: 100, g: 50, b: 25 })
	assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 100), { r: 200, g: 100, b: 50 })
	assert.deepEqual(scaleColor({ r: 200, g: 100, b: 50 }, 0), { r: 0, g: 0, b: 0 })
})

test('control ids are line/column and round trip', () => {
	assert.equal(controlId(3, 7), '7/3')
	assert.deepEqual(parseControlId('7/3'), { column: 3, line: 7 })
	assert.equal(parseControlId('8/0'), null)
	assert.equal(parseControlId('0/4'), null)
	assert.equal(parseControlId('x'), null)
	assert.equal(keyIndex(0, 0), 0)
	assert.equal(keyIndex(3, 7), 31)
})

test('parses the Microchip announce answer observed on a real unit', () => {
	const found = parseAnnounce(Buffer.from('CARTRIDGE \r\nEC-D9-25-00-85-17\r\n80\r\n', 'latin1'), '192.168.1.64')
	assert.deepEqual(found, { address: '192.168.1.64', name: 'CARTRIDGE', mac: 'EC-D9-25-00-85-17' })
	assert.equal(parseAnnounce(Buffer.from('hello'), '1.2.3.4'), null)
	assert.equal(directedBroadcast('192.168.1.148', '255.255.255.0'), '192.168.1.255')
	assert.equal(directedBroadcast('10.1.2.3', '255.255.0.0'), '10.1.255.255')
})
