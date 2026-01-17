# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Raspberry Pi-based kiln controller for ceramic kilns. It provides web-based temperature scheduling, real-time monitoring via WebSockets, and PID control for accurate firing profiles.

## Commands

### Running the Server
```bash
source venv/bin/activate && ./kiln-controller.py
```
Web interface available at `http://<pi-ip>:80` (port configured in `config.py`).

### Installation (Raspberry Pi)
```bash
virtualenv -p python3 venv
source venv/bin/activate
export CFLAGS=-fcommon
pip3 install -r requirements.txt
```

### Enable Autostart on Boot
```bash
/home/pi/kiln-controller/start-on-boot
```

### PID Tuning (Auto)
```bash
# Record temperature profile
./kiln-tuner.py recordprofile output.csv --targettemp 400

# Calculate Ziegler-Nichols parameters
./kiln-tuner.py zn output.csv --showplot
```

### Running the Watcher (Alert System)
Edit `watcher.py` with your kiln URL and Slack webhook, then:
```bash
./watcher.py
```

## Architecture

### Core Components

- **`kiln-controller.py`**: Main entry point. Bottle web server with WebSocket endpoints for real-time communication. Routes:
  - `/control` - WebSocket for RUN/STOP commands
  - `/status` - WebSocket for live temperature updates
  - `/storage` - WebSocket for profile CRUD
  - `/config` - WebSocket for settings
  - `/api` - REST endpoint for run/stop commands

- **`lib/oven.py`**: Core kiln control logic containing:
  - `Oven` - Base class with PID control, automatic restart, emergency shutoff
  - `RealOven` - GPIO control via `Output` class
  - `SimulatedOven` - Physics-based simulation for testing
  - `Profile` - Firing schedule with time/temperature interpolation
  - `PID` - PID controller with configurable window
  - `TempSensorReal` - Threaded temperature sampling with averaging

- **`lib/ovenWatcher.py`**: `OvenWatcher` class broadcasts oven state to WebSocket clients

- **`config.py`**: All configuration including GPIO pins, PID parameters, thermocouple settings, simulation parameters

### Hardware Abstraction

- **Thermocouple boards**: `lib/max31855.py`, `lib/max31856.py` - SPI bit-bang interfaces
- **LCD displays**: TM1637 4-digit displays showing current and target temperature
- **SSR control**: GPIO pin drives solid-state relay for heater switching

### Frontend

- **`public/`**: Static web interface using jQuery, Flot (graphing), Bootstrap
- **`public/assets/js/picoreflow.js`**: Main client logic - WebSocket handlers, profile editing, real-time graph updates

### Data

- **`storage/profiles/`**: JSON firing schedules with `name` and `data` (array of [time_seconds, temperature] points)

## Key Configuration (config.py)

- `simulate = True/False` - Toggle hardware simulation
- `pid_kp`, `pid_ki`, `pid_kd` - PID tuning parameters
- `pid_control_window` - Degrees outside which PID goes 100% on/off
- `sensor_time_wait` - Control loop cycle time in seconds
- `emergency_shutoff_temp` - Safety cutoff temperature
- `kiln_must_catch_up` - Pause schedule if kiln can't keep up
- `automatic_restarts` - Resume after power outage

## Important Behaviors

- The PID controller operates within a configurable window; outside this window the heater is full-on or full-off
- Temperature readings are averaged over multiple samples to filter noise
- State is saved to `state.json` for automatic restart after power loss
- The `kiln_must_catch_up` feature shifts the schedule forward when temperature deviates too far from target
