# water-agent — water usage → hub

Reads a water-flow sensor and pushes it to the BrewPlanner hub. Two metrics show
up on the device's tile and charts:

| Metric     | Meaning                          | Unit  |
| ---------- | -------------------------------- | ----- |
| `flow_lpm` | instantaneous flow rate          | L/min |
| `water_l`  | cumulative volume (meter total)  | L     |

Like the other agents it ships with a **simulate** mode so you can stand up the
whole pipeline before any sensor is wired in.

## Steps

1. **Register the device on the hub** and copy the printed key:
   ```bash
   npm run device -- add "Brewery Water" water_meter
   ```
2. **Copy this repo to the satellite Pi** so the agent lives at
   `…/deploy/agents/water-agent/`.
3. **Configure it**: create `/etc/water-agent.env` (chmod 600) from
   `water-agent.env.example`; set `HUB_URL` and `DEVICE_KEY`. Leave
   `BP_SIMULATE=1` for now.
4. **Smoke-test by hand** — run `python3 agent.py`; a "Brewery Water" tile should
   appear on the dashboard, go Online, and show a flow that pulses every 30s plus
   a slowly climbing litre total.
5. **Run it as a service**: copy `water-agent.service` to
   `/etc/systemd/system/`, then `systemctl enable --now water-agent`.
6. **Wire the real sensor**: implement `read_water()` in `agent.py` for your
   hardware (there's a worked hall-effect flow-sensor example in the docstring —
   remember to persist the running total across restarts), then set
   `BP_SIMULATE=0` and restart the service.

> No physical sensor yet? Leave `BP_SIMULATE=1` to demo the whole pipeline
> end-to-end first.

See [../../../SENSORS.md](../../../SENSORS.md) for the big picture and the
shared verifying/troubleshooting notes.
