# RAmi Audio Cartridge

Use a **RAmi Audio Cartridge** (32 RGB backlit keys, 4 columns x 8 lines, Ethernet) as a Companion surface.
Pressing a key presses the matching Companion button, and the key lights up with the colour of that button.

## Requirements

- The Cartridge must be reachable from the computer running Companion (same network, or routed).
- In the Cartridge web page (Settings > Protocol), the active protocol must be **RAMIv3** and the **Telnet** interface must be enabled for both reception and transmission.
- Cartridge firmware **v1.4 or later** (the version is shown on the Cartridge web page). With older firmware the keys work, but the LEDs stay on their idle colour.

The Cartridge accepts up to 4 simultaneous Telnet sessions. The other Cartridge interfaces (TCP, serial, USB MIDI) keep working in parallel.

## Adding a Cartridge

1. In Companion, open the **Surfaces** tab.
2. Cartridges found on the local network are suggested. Otherwise add a remote connection of type **RAmi Audio Cartridge** by hand.
3. Fill in:
   - **IP address or host name** of the Cartridge.
   - **Telnet port** (23 unless you changed it).
4. The surface appears in the Surfaces list. Assign it to a page like any other surface.

The device id of the Cartridge (0 to 253 in its settings) is read from the unit itself, there is nothing to configure.

## Layout

Keys are numbered in reading order, key 1 at the top left and key 32 at the bottom right.
Companion row = line of the Cartridge, Companion column = column of the Cartridge.

|        | col 0 | col 1 | col 2 | col 3 |
| ------ | ----- | ----- | ----- | ----- |
| line 0 | 1     | 2     | 3     | 4     |
| line 1 | 5     | 6     | 7     | 8     |
| ...    |       |       |       |       |
| line 7 | 29    | 30    | 31    | 32    |

## Colours and brightness

- The Cartridge has no display: only the **background colour** of each button is shown, button text is not.
- The LEDs have 16 levels per colour channel. A channel below 16 (out of 255) is shown as off, so very dark colours look black.
- Companion's brightness setting for the surface is applied by this module. The brightness set on the Cartridge web page still acts as a global maximum.

## Troubleshooting

| Symptom                                      | Cause                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "No answer to INFO" in the log               | The protocol is not RAMIv3, or Telnet RX/TX is disabled, or another device answers on that address. |
| Connection refused or timeout                | Wrong address or port, network or firewall.                                                         |
| Keys work but LEDs stay on their idle colour | Firmware older than v1.4: update the Cartridge.                                                     |
| All 4 Telnet sessions used                   | Close a session (a terminal, another Companion) and wait a few seconds: the module retries.         |
| After a power cycle of the Cartridge         | The module reconnects by itself and sends the whole page again.                                     |
