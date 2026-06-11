# power-agent — electricity (power + energy) → hub

Reads the brewery's mains usage and pushes it to the BrewPlanner hub. Two
metrics show up on the device's tile and charts:

| Metric       | Meaning                          | Unit |
| ------------ | -------------------------------- | ---- |
| `power_w`    | instantaneous draw               | W    |
| `energy_kwh` | cumulative energy (meter total)  | kWh  |

Like the other agents it ships with a **simulate** mode so you can stand up the
whole pipeline before any meter is wired in.

## Steps

1. **Register the device on the hub** and copy the printed key:
   ```bash
   npm run device -- add "Brewery Power" power_meter
   ```
2. **Copy this repo to the satellite Pi** so the agent lives at
   `…/deploy/agents/power-agent/`.
3. **Configure it**: create `/etc/power-agent.env` (chmod 600) from
   `power-agent.env.example`; set `HUB_URL` and `DEVICE_KEY`. Leave
   `BP_SIMULATE=1` for now.
4. **Smoke-test by hand** — run `python3 agent.py`; a "Brewery Power" tile should
   appear on the dashboard, go Online, and show a wattage that drifts every 30s
   plus a slowly climbing kWh total.
5. **Run it as a service**: copy `power-agent.service` to
   `/etc/systemd/system/`, then `systemctl enable --now power-agent`.
6. **Wire the real meter**: implement `read_power()` in `agent.py` for your
   hardware (there are worked Tuya / Shelly / CT-clamp examples in the
   docstring), then set `BP_SIMULATE=0` and restart the service.

> No physical meter yet? Leave `BP_SIMULATE=1` to demo the whole pipeline
> end-to-end first.

See [../../../SENSORS.md](../../../SENSORS.md) for the big picture and the
shared verifying/troubleshooting notes.
