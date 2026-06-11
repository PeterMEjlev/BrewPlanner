import { deviceTypeSchema } from '@checklist/shared';
import { runMigrations } from '../db/index.js';
import {
  createDevice,
  deleteDeviceByName,
  listDevices,
  rotateKeyByName,
} from './repo.js';

/**
 * Manage telemetry devices (the satellites that push to /api/ingest):
 *   npm run device -- add <name> [type]   register a device, print its key once
 *   npm run device -- rotate <name>        issue a new key (old one stops working)
 *   npm run device -- delete <name>        remove a device and its readings
 *   npm run device -- list                 list devices
 *
 * type is one of: pressure_sensor | brew_controller | power_meter |
 *                 water_meter | hydrometer | other (default: other)
 */
const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run device -- add <name> [type]   register a device, print its key once\n' +
      '  npm run device -- rotate <name>        issue a new key\n' +
      '  npm run device -- delete <name>        remove a device and its readings\n' +
      '  npm run device -- list                 list devices\n' +
      '\n  type: pressure_sensor | brew_controller | power_meter | water_meter |' +
      '\n        hydrometer | other (default: other)',
  );
  process.exit(1);
}

function printKey(name: string, key: string): void {
  console.log(
    `\nDevice "${name}" key (store it now — it is not shown again):\n\n  ${key}\n\n` +
      'Configure the satellite agent with:\n' +
      `  DEVICE_KEY=${key}\n`,
  );
}

runMigrations();

if (cmd === 'list') {
  const all = listDevices();
  if (all.length === 0) {
    console.log('(no devices)');
  } else {
    for (const d of all) {
      console.log(`${d.id}\t${d.type}\t${d.name}\tlast seen: ${d.lastSeenAt ?? 'never'}`);
    }
  }
} else if (cmd === 'delete') {
  const [name] = rest;
  if (!name) usage();
  console.log(
    deleteDeviceByName(name) ? `Deleted device "${name}".` : `No device named "${name}".`,
  );
} else if (cmd === 'rotate') {
  const [name] = rest;
  if (!name) usage();
  const key = rotateKeyByName(name);
  if (!key) {
    console.error(`No device named "${name}".`);
    process.exit(1);
  }
  printKey(name, key);
} else if (cmd === 'add') {
  const [name, typeArg] = rest;
  if (!name) usage();
  const parsedType = deviceTypeSchema.safeParse(typeArg ?? 'other');
  if (!parsedType.success) {
    console.error(
      `Invalid type "${typeArg}". Use pressure_sensor, brew_controller, ` +
        'power_meter, water_meter, hydrometer, or other.',
    );
    process.exit(1);
  }
  const { device, key } = createDevice(name, parsedType.data);
  console.log(`Registered device "${device.name}" (id ${device.id}, type ${device.type}).`);
  printKey(device.name, key);
} else {
  usage();
}
