import threading
import time
import random
import datetime
import logging
import json
import config
import os
from typing import Optional
try:
    import tm1637
except Exception:
    # Allow simulate-mode to run on non-Raspberry Pi machines where the LCD
    # library (and its GPIO deps) may not be available.
    tm1637 = None

log = logging.getLogger(__name__)


try:
    from kiln_db import create_session as _sqlite_create_session
    from kiln_db import stop_session as _sqlite_stop_session
    from kiln_db import add_session_sample as _sqlite_add_session_sample
except Exception:
    _sqlite_create_session = None
    _sqlite_stop_session = None
    _sqlite_add_session_sample = None


def get_thermocouple_offset(raw_temp):
    '''Compute temperature-dependent offset by interpolating the correction table.
    Falls back to flat thermocouple_offset if no table is defined.'''
    table = getattr(config, 'thermocouple_correction_table', None)
    if not table:
        return getattr(config, 'thermocouple_offset', 0)
    if raw_temp <= table[0][0]:
        return table[0][1]
    if raw_temp >= table[-1][0]:
        return table[-1][1]
    for i in range(1, len(table)):
        if raw_temp <= table[i][0]:
            t0, o0 = table[i-1]
            t1, o1 = table[i]
            return o0 + (o1 - o0) * (raw_temp - t0) / (t1 - t0)
    return table[-1][1]

class DupFilter(object):
    def __init__(self):
        self.msgs = set()

    def filter(self, record):
        rv = record.msg not in self.msgs
        self.msgs.add(record.msg)
        return rv

class Duplogger():
    def __init__(self):
        self.log = logging.getLogger("%s.dupfree" % (__name__))
        dup_filter = DupFilter()
        self.log.addFilter(dup_filter)
    def logref(self):
        return self.log

duplog = Duplogger().logref()


class Output(object):
    def __init__(self):
        self.active = False
        self.load_libs()

    def load_libs(self):
        try:
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM)
            GPIO.setwarnings(False)
            GPIO.setup(config.gpio_heat, GPIO.OUT)
            self.active = True
            self.GPIO = GPIO
        except:
            msg = "Could not initialize GPIOs, oven operation will only be simulated!"
            log.warning(msg)
            self.active = False

    def heat(self,sleepfor):
        self.GPIO.output(config.gpio_heat, self.GPIO.HIGH)
        time.sleep(sleepfor)

    def cool(self,sleepfor):
        '''no active cooling, so sleep'''
        self.GPIO.output(config.gpio_heat, self.GPIO.LOW)
        time.sleep(sleepfor)

# FIX - Board class needs to be completely removed
class Board(object):
    def __init__(self):
        self.name = None
        self.active = False
        self.temp_sensor = None
        self.gpio_active = False
        self.load_libs()
        self.create_temp_sensor()
        self.temp_sensor.start()

    def load_libs(self):
        if config.max31855:
            try:
                #from max31855 import MAX31855, MAX31855Error
                self.name='MAX31855'
                self.active = True
                log.info("import %s " % (self.name))
            except ImportError:
                msg = "max31855 config set, but import failed"
                log.warning(msg)

        if config.max31856:
            try:
                #from max31856 import MAX31856, MAX31856Error
                self.name='MAX31856'
                self.active = True
                log.info("import %s " % (self.name))
            except ImportError:
                msg = "max31856 config set, but import failed"
                log.warning(msg)

    def create_temp_sensor(self):
        if config.simulate == True:
            self.temp_sensor = TempSensorSimulate()
        else:
            self.temp_sensor = TempSensorReal()

class BoardSimulated(object):
    def __init__(self):
        self.temp_sensor = TempSensorSimulated()

class TempSensor(threading.Thread):
    def __init__(self):
        threading.Thread.__init__(self)
        self.daemon = True
        self.temperature = 0
        self.bad_percent = 0
        self.time_step = config.sensor_time_wait
        self.noConnection = self.shortToGround = self.shortToVCC = self.unknownError = False

class TempSensorSimulated(TempSensor):
    '''not much here, just need to be able to set the temperature'''
    def __init__(self):
        TempSensor.__init__(self)

class TempSensorReal(TempSensor):
    '''real temperature sensor thread that takes N measurements
       during the time_step'''
    def __init__(self):
        TempSensor.__init__(self)
        self.sleeptime = self.time_step / float(config.temperature_average_samples)
        self.bad_count = 0
        self.ok_count = 0
        self.bad_stamp = 0

        if config.max31855:
            log.info("init MAX31855")
            from max31855 import MAX31855, MAX31855Error
            self.thermocouple = MAX31855(config.gpio_sensor_cs,
                                     config.gpio_sensor_clock,
                                     config.gpio_sensor_data,
                                     config.temp_scale)

        if config.max31856:
            log.info("init MAX31856")
            from max31856 import MAX31856
            software_spi = { 'cs': config.gpio_sensor_cs,
                             'clk': config.gpio_sensor_clock,
                             'do': config.gpio_sensor_data,
                             'di': config.gpio_sensor_di }
            self.thermocouple = MAX31856(tc_type=config.thermocouple_type,
                                         software_spi = software_spi,
                                         units = config.temp_scale,
                                         ac_freq_50hz = config.ac_freq_50hz,
                                         )

    def run(self):
        '''use a moving average of config.temperature_average_samples across the time_step'''
        temps = []
        while True:
            # reset error counter if time is up
            if (time.time() - self.bad_stamp) > (self.time_step * 2):
                if self.bad_count + self.ok_count:
                    self.bad_percent = (self.bad_count / (self.bad_count + self.ok_count)) * 100
                else:
                    self.bad_percent = 0
                self.bad_count = 0
                self.ok_count = 0
                self.bad_stamp = time.time()

            temp = self.thermocouple.get()
            self.noConnection = self.thermocouple.noConnection
            self.shortToGround = self.thermocouple.shortToGround
            self.shortToVCC = self.thermocouple.shortToVCC
            self.unknownError = self.thermocouple.unknownError

            is_bad_value = self.noConnection | self.unknownError
            if not config.ignore_tc_short_errors:
                is_bad_value |= self.shortToGround | self.shortToVCC

            if not is_bad_value:
                temps.append(temp)
                if len(temps) > config.temperature_average_samples:
                    del temps[0]
                self.ok_count += 1

            else:
                log.error("Problem reading temp N/C:%s GND:%s VCC:%s ???:%s" % (self.noConnection,self.shortToGround,self.shortToVCC,self.unknownError))
                self.bad_count += 1

            if len(temps):
                self.temperature = self.get_avg_temp(temps)
            time.sleep(self.sleeptime)

    def get_avg_temp(self, temps, chop=25):
        '''
        strip off chop percent from the beginning and end of the sorted temps
        then return the average of what is left
        '''
        chop = chop / 100
        temps = sorted(temps)
        total = len(temps)
        items = int(total*chop)
        temps = temps[items:total-items]
        return sum(temps) / len(temps)

class Oven(threading.Thread):
    '''parent oven class. this has all the common code
       for either a real or simulated oven'''
    def __init__(self):
        threading.Thread.__init__(self)
        self.daemon = True
        self.time_step = config.sensor_time_wait

        if tm1637 is None:
            class _NoopLCD:
                def __init__(self, *args, **kwargs):
                    pass

                def write(self, *args, **kwargs):
                    pass

                def number(self, *args, **kwargs):
                    pass

            self.lcd = _NoopLCD()
            self.lcd2 = _NoopLCD()
        else:
            self.lcd = tm1637.TM1637(clk=config.gpio_lcd_clk, dio=config.gpio_lcd_dio)
            self.lcd2 = tm1637.TM1637(clk=config.gpio_lcd2_clk, dio=config.gpio_lcd2_dio)
            self.lcd.write([0,0,0,0])
            self.lcd2.write([0,0,0,0])

        self._active_session_id: Optional[str] = None

        # Wall-clock timing for UI/analytics.
        # `runtime` is schedule time and can be paused/shifted by catch-up logic.
        # `elapsed` is real time since the user started the run.
        self._wall_start_ts: Optional[float] = None
        self.reset()

    def reset(self):
        self.cost = 0
        self.state = "IDLE"
        self.profile = None
        self.start_time = 0
        self.runtime = 0
        self.totaltime = 0
        self.target = 0
        self.heat = 0
        self.pid = PID(ki=config.pid_ki, kd=config.pid_kd, kp=config.pid_kp)
        self._wall_start_ts = None

    def _sqlite_db_path(self) -> Optional[str]:
        return getattr(config, "sqlite_db_path", None)

    def _start_session_if_possible(self) -> None:
        if not self.profile:
            return
        if self._active_session_id:
            return
        if _sqlite_create_session is None:
            return
        db_path = self._sqlite_db_path()
        if not db_path:
            return

        try:
            self._active_session_id = _sqlite_create_session(
                db_path,
                profile_name=self.profile.name,
                outcome="RUNNING",
            )
            log.info("SQLite session started: %s" % self._active_session_id)
        except Exception:
            log.exception("SQLite session start failed")

    def _stop_session_if_possible(self, *, outcome: str) -> None:
        if not self._active_session_id:
            return
        if _sqlite_stop_session is None:
            self._active_session_id = None
            return
        db_path = self._sqlite_db_path()
        if not db_path:
            self._active_session_id = None
            return

        sid = self._active_session_id
        try:
            _sqlite_stop_session(db_path, session_id=sid, outcome=outcome)
            log.info("SQLite session ended: %s (outcome=%s)" % (sid, outcome))
        except Exception:
            log.exception("SQLite session stop failed (id=%s)" % sid)
        finally:
            self._active_session_id = None

    def _persist_sample_if_possible(self) -> None:
        if not self._active_session_id:
            return
        if _sqlite_add_session_sample is None:
            return
        db_path = self._sqlite_db_path()
        if not db_path:
            return

        sid = self._active_session_id
        try:
            _sqlite_add_session_sample(db_path, session_id=sid, state=self.get_state())
        except Exception:
            # Best-effort: DB failures should never stop kiln control.
            log.exception("SQLite sample persist failed (id=%s)" % sid)
            return

    def run_profile(self, profile, startat=0):
        # If a new run is started while another is active, treat the prior one as aborted.
        self._stop_session_if_possible(outcome="ABORTED")
        self.reset()

        if self.board.temp_sensor.noConnection:
            log.info("Refusing to start profile - thermocouple not connected")
            return
        if self.board.temp_sensor.shortToGround:
            log.info("Refusing to start profile - thermocouple short to ground")
            return
        if self.board.temp_sensor.shortToVCC:
            log.info("Refusing to start profile - thermocouple short to VCC")
            return
        if self.board.temp_sensor.unknownError:
            log.info("Refusing to start profile - thermocouple unknown error")
            return

        self.startat = startat * 60
        self.runtime = self.startat
        self.start_time = datetime.datetime.now() - datetime.timedelta(seconds=self.startat)
        self._wall_start_ts = time.time()
        self.profile = profile
        self.totaltime = profile.get_duration()
        self.state = "RUNNING"
        log.info("Running schedule %s starting at %d minutes" % (profile.name,startat))
        log.info("Starting")

        self._start_session_if_possible()

    def abort_run(self, *, outcome: str = "ABORTED"):
        self._stop_session_if_possible(outcome=outcome)
        self.reset()
        self.save_automatic_restart_state()

    def kiln_must_catch_up(self):
        '''shift the whole schedule forward in time by one time_step
        to wait for the kiln to catch up'''
        if config.kiln_must_catch_up == True:
            temp = self.board.temp_sensor.temperature + \
                get_thermocouple_offset(self.board.temp_sensor.temperature)
            # kiln too cold, wait for it to heat up
            if self.target - temp > config.pid_control_window:
                log.info("kiln must catch up, too cold, shifting schedule")
                self.start_time = datetime.datetime.now() - datetime.timedelta(milliseconds = self.runtime * 1000)
            # kiln too hot, wait for it to cool down
            if temp - self.target > config.pid_control_window:
                # Check for warmup skip: if both temps are below threshold,
                # skip ahead in schedule instead of waiting to cool down
                if (hasattr(config, 'warmup_skip_threshold') and
                    config.warmup_skip_threshold > 0 and
                    temp < config.warmup_skip_threshold and
                    self.target < config.warmup_skip_threshold):
                    skip_to_time = self.profile.find_time_for_temperature(temp, self.runtime)
                    if skip_to_time is not None and skip_to_time > self.runtime:
                        log.info("warmup skip: jumping from %.1fs to %.1fs (temp=%.1f, old_target=%.1f)" %
                                 (self.runtime, skip_to_time, temp, self.target))
                        self.start_time = datetime.datetime.now() - datetime.timedelta(seconds=skip_to_time)
                        # Reset PID state to avoid integral windup from the skipped phase
                        self.pid.iterm = 0
                        self.pid.lastErr = 0
                        return

                log.info("kiln must catch up, too hot, shifting schedule")
                self.start_time = datetime.datetime.now() - datetime.timedelta(milliseconds = self.runtime * 1000)

    def update_runtime(self):

        runtime_delta = datetime.datetime.now() - self.start_time
        if runtime_delta.total_seconds() < 0:
            runtime_delta = datetime.timedelta(0)

        self.runtime = runtime_delta.total_seconds()

    def update_target_temp(self):
        self.target = self.profile.get_target_temperature(self.runtime)

    def reset_if_emergency(self):
        '''reset if the temperature is way TOO HOT, or other critical errors detected'''
        if (self.board.temp_sensor.temperature + get_thermocouple_offset(self.board.temp_sensor.temperature) >=
            config.emergency_shutoff_temp):
            log.info("emergency!!! temperature too high")
            if config.ignore_temp_too_high == False:
                self.abort_run(outcome="ERROR")

        if self.board.temp_sensor.noConnection:
            log.info("emergency!!! lost connection to thermocouple")
            if config.ignore_lost_connection_tc == False:
                self.abort_run(outcome="ERROR")

        if self.board.temp_sensor.unknownError:
            log.info("emergency!!! unknown thermocouple error")
            if config.ignore_unknown_tc_error == False:
                self.abort_run(outcome="ERROR")

        if self.board.temp_sensor.bad_percent > 30:
            log.info("emergency!!! too many errors in a short period")
            if config.ignore_too_many_tc_errors == False:
                self.abort_run(outcome="ERROR")

    def reset_if_schedule_ended(self):
        if self.runtime > self.totaltime:
            log.info("schedule ended, shutting down")
            log.info("total cost = %s%.2f" % (config.currency_type,self.cost))
            self.abort_run(outcome="COMPLETED")

    def update_cost(self):
        if self.heat:
            cost = (config.kwh_rate * config.kw_elements) * ((self.heat)/3600)
        else:
            cost = 0
        self.cost = self.cost + cost

    def update_lcd(self):
        temp = 0
        try:
            temp = self.board.temp_sensor.temperature + get_thermocouple_offset(self.board.temp_sensor.temperature)
            self.lcd.number(int(temp + 0.5))
        except AttributeError as error:
            # this happens at start-up with a simulated oven
            self.lcd.write([0,0,0,0])
        self.lcd2.number(int(self.target))
        

    def get_state(self):
        temp = 0
        try:
            temp = self.board.temp_sensor.temperature + get_thermocouple_offset(self.board.temp_sensor.temperature)
        except AttributeError as error:
            # this happens at start-up with a simulated oven
            temp = 0
            pass

        now_ts = time.time()
        elapsed = 0.0
        if self._wall_start_ts is not None:
            elapsed = max(0.0, now_ts - float(self._wall_start_ts))

        state = {
            'cost': self.cost,
            'runtime': self.runtime,
            'elapsed': elapsed,
            'temperature': temp,
            'target': self.target,
            'state': self.state,
            'heat': self.heat,
            'totaltime': self.totaltime,
            'kwh_rate': config.kwh_rate,
            'currency_type': config.currency_type,
            'profile': self.profile.name if self.profile else None,
            'pidstats': self.pid.pidstats,
        }
        return state

    def save_state(self):
        with open(config.automatic_restart_state_file, 'w', encoding='utf-8') as f:
            json.dump(self.get_state(), f, ensure_ascii=False, indent=4)

    def state_file_is_old(self):
        '''returns True is state files is older than 15 mins default
                   False if younger
                   True if state file cannot be opened or does not exist
        '''
        if os.path.isfile(config.automatic_restart_state_file):
            state_age = os.path.getmtime(config.automatic_restart_state_file)
            now = time.time()
            minutes = (now - state_age)/60
            if(minutes <= config.automatic_restart_window):
                return False
        return True

    def save_automatic_restart_state(self):
        # only save state if the feature is enabled
        if not config.automatic_restarts == True:
            return False
        self.save_state()

    def should_i_automatic_restart(self):
        # only automatic restart if the feature is enabled
        if not config.automatic_restarts == True:
            return False
        if self.state_file_is_old():
            duplog.info("automatic restart not possible. state file does not exist or is too old.")
            return False

        with open(config.automatic_restart_state_file) as infile:
            d = json.load(infile)
        if d["state"] != "RUNNING":
            duplog.info("automatic restart not possible. state = %s" % (d["state"]))
            return False
        return True

    def automatic_restart(self):
        with open(config.automatic_restart_state_file) as infile: d = json.load(infile)
        startat = d["runtime"]/60
        filename = "%s.json" % (d["profile"])
        profile_path = os.path.abspath(os.path.join(os.path.dirname( __file__ ), '..', 'storage','profiles',filename))

        log.info("automatically restarting profile = %s at minute = %d" % (profile_path,startat))
        with open(profile_path) as infile:
            profile_json = json.dumps(json.load(infile))
        profile = Profile(profile_json)
        self.run_profile(profile,startat=startat)
        self.cost = d["cost"]
        time.sleep(1)
        self.ovenwatcher.record(profile)

    def set_ovenwatcher(self,watcher):
        log.info("ovenwatcher set in oven class")
        self.ovenwatcher = watcher

    def run(self):
        while True:
            self.update_lcd()
            if self.state == "IDLE":
                if self.should_i_automatic_restart() == True:
                    self.automatic_restart()
                time.sleep(1)
                continue
            if self.state == "RUNNING":
                self.update_cost()
                self.save_automatic_restart_state()
                self.kiln_must_catch_up()
                self.update_runtime()
                self.update_target_temp()
                self.heat_then_cool()

                # Persist exactly one sample per control loop cycle.
                self._persist_sample_if_possible()

                self.reset_if_emergency()
                self.reset_if_schedule_ended()

class SimulatedOven(Oven):

    def __init__(self):
        self.board = BoardSimulated()
        self.t_env = config.sim_t_env
        self.c_heat = config.sim_c_heat
        self.c_oven = config.sim_c_oven
        self.p_heat = config.sim_p_heat
        self.R_o_nocool = config.sim_R_o_nocool
        self.R_ho_noair = config.sim_R_ho_noair
        self.R_ho = self.R_ho_noair

        # set temps to the temp of the surrounding environment
        self.t = self.t_env # deg C temp of oven
        self.t_h = self.t_env #deg C temp of heating element

        super().__init__()

        # start thread
        self.start()
        log.info("SimulatedOven started")

    def heating_energy(self,pid):
        # using pid here simulates the element being on for
        # only part of the time_step
        self.Q_h = self.p_heat * self.time_step * pid

    def temp_changes(self):
        #temperature change of heat element by heating
        self.t_h += self.Q_h / self.c_heat

        #energy flux heat_el -> oven
        self.p_ho = (self.t_h - self.t) / self.R_ho

        #temperature change of oven and heating element
        self.t += self.p_ho * self.time_step / self.c_oven
        self.t_h -= self.p_ho * self.time_step / self.c_heat

        #temperature change of oven by cooling to environment
        self.p_env = (self.t - self.t_env) / self.R_o_nocool
        self.t -= self.p_env * self.time_step / self.c_oven
        self.temperature = self.t
        self.board.temp_sensor.temperature = self.t

    def heat_then_cool(self):
        pid = self.pid.compute(self.target,
                               self.board.temp_sensor.temperature +
                               get_thermocouple_offset(self.board.temp_sensor.temperature))
        heat_on = float(self.time_step * pid)
        heat_off = float(self.time_step * (1 - pid))

        self.heating_energy(pid)
        self.temp_changes()

        # self.heat is for the front end to display if the heat is on
        self.heat = 0.0
        if heat_on > 0:
            self.heat = heat_on

        log.info("simulation: -> %dW heater: %.0f -> %dW oven: %.0f -> %dW env"            % (int(self.p_heat * pid),
            self.t_h,
            int(self.p_ho),
            self.t,
            int(self.p_env)))

        time_left = self.totaltime - self.runtime

        try:
            log.info("temp=%.2f, target=%.2f, error=%.2f, pid=%.2f, p=%.2f, i=%.2f, d=%.2f, heat_on=%.2f, heat_off=%.2f, run_time=%d, total_time=%d, time_left=%d" %
                (self.pid.pidstats['ispoint'],
                self.pid.pidstats['setpoint'],
                self.pid.pidstats['err'],
                self.pid.pidstats['pid'],
                self.pid.pidstats['p'],
                self.pid.pidstats['i'],
                self.pid.pidstats['d'],
                heat_on,
                heat_off,
                self.runtime,
                self.totaltime,
                time_left))
        except KeyError:
            pass

        # we don't actually spend time heating & cooling during
        # a simulation, so sleep.
        time.sleep(self.time_step)


class RealOven(Oven):

    def __init__(self):
        self.board = Board()
        self.output = Output()
        self.reset()

        # call parent init
        Oven.__init__(self)

        # start thread
        self.start()

    def reset(self):
        super().reset()
        self.output.cool(0)

    def heat_then_cool(self):
        pid = self.pid.compute(self.target,
                               self.board.temp_sensor.temperature +
                               get_thermocouple_offset(self.board.temp_sensor.temperature))
        heat_on = float(self.time_step * pid)
        heat_off = float(self.time_step * (1 - pid))

        # self.heat is for the front end to display if the heat is on
        self.heat = 0.0
        if heat_on > 0:
            self.heat = 1.0

        if heat_on:
            self.output.heat(heat_on)
        if heat_off:
            self.output.cool(heat_off)
        time_left = self.totaltime - self.runtime
        try:
            log.info("temp=%.2f, target=%.2f, error=%.2f, pid=%.2f, p=%.2f, i=%.2f, d=%.2f, heat_on=%.2f, heat_off=%.2f, run_time=%d, total_time=%d, time_left=%d" %
                (self.pid.pidstats['ispoint'],
                self.pid.pidstats['setpoint'],
                self.pid.pidstats['err'],
                self.pid.pidstats['pid'],
                self.pid.pidstats['p'],
                self.pid.pidstats['i'],
                self.pid.pidstats['d'],
                heat_on,
                heat_off,
                self.runtime,
                self.totaltime,
                time_left))
        except KeyError:
            pass

class Profile():
    def __init__(self, json_data):
        obj = json.loads(json_data)
        self.name = obj["name"]
        self.data = sorted(obj["data"])

    def get_duration(self):
        return max([t for (t, x) in self.data])

    def get_surrounding_points(self, time):
        if time > self.get_duration():
            return (None, None)

        prev_point = None
        next_point = None

        for i in range(len(self.data)):
            if time < self.data[i][0]:
                prev_point = self.data[i-1]
                next_point = self.data[i]
                break

        return (prev_point, next_point)

    def get_target_temperature(self, time):
        if time > self.get_duration():
            return 0

        (prev_point, next_point) = self.get_surrounding_points(time)

        incl = float(next_point[1] - prev_point[1]) / float(next_point[0] - prev_point[0])
        temp = prev_point[1] + (time - prev_point[0]) * incl
        return temp

    def find_time_for_temperature(self, target_temp, from_time=0):
        '''
        Find the earliest time >= from_time where the schedule reaches target_temp.
        Used for warmup skip: when kiln overshoots early in schedule, find where
        to jump ahead so the schedule target matches the current kiln temperature.
        Returns the time in seconds, or None if target_temp is never reached.
        '''
        if from_time >= self.get_duration():
            return None

        # Check if we're already at or above target at from_time
        current = self.get_target_temperature(from_time)
        if current >= target_temp:
            return from_time

        # Search through schedule segments starting from from_time
        for i in range(1, len(self.data)):
            seg_start_time, seg_start_temp = self.data[i-1]
            seg_end_time, seg_end_temp = self.data[i]

            # Skip segments that end before from_time
            if seg_end_time <= from_time:
                continue

            # For segments we're in the middle of, adjust the effective start
            if from_time > seg_start_time:
                seg_start_time = from_time
                seg_start_temp = self.get_target_temperature(from_time)

            # Check if target_temp is reached within this segment
            if seg_end_temp >= target_temp:
                # If we're already at or above target at segment start
                if seg_start_temp >= target_temp:
                    return seg_start_time

                # Interpolate to find exact crossing time
                temp_span = seg_end_temp - seg_start_temp
                if temp_span <= 0:
                    continue  # Flat or cooling segment, can't reach higher temp

                time_span = seg_end_time - seg_start_time
                temp_needed = target_temp - seg_start_temp
                return seg_start_time + (temp_needed / temp_span) * time_span

        return None


class PID():

    def __init__(self, ki=1, kp=1, kd=1):
        self.ki = ki
        self.kp = kp
        self.kd = kd
        self.lastNow = datetime.datetime.now()
        self.iterm = 0
        self.lastErr = 0
        self.pidstats = {}

    # FIX - this was using a really small window where the PID control
    # takes effect from -1 to 1. I changed this to various numbers and
    # settled on -50 to 50 and then divide by 50 at the end. This results
    # in a larger PID control window and much more accurate control...
    # instead of what used to be binary on/off control.
    def compute(self, setpoint, ispoint):
        now = datetime.datetime.now()
        timeDelta = (now - self.lastNow).total_seconds()

        window_size = 100

        error = float(setpoint - ispoint)

        # this removes the need for config.stop_integral_windup
        # it turns the controller into a binary on/off switch
        # any time it's outside the window defined by
        # config.pid_control_window
        icomp = 0
        output = 0
        out4logs = 0
        dErr = 0
        if error < (-1 * config.pid_control_window):
            log.info("kiln outside pid control window, max cooling")
            output = 0
            # it is possible to set self.iterm=0 here and also below
            # but I dont think its needed
        elif error > (1 * config.pid_control_window):
            log.info("kiln outside pid control window, max heating")
            output = 1
        else:
            icomp = (error * timeDelta * (1/self.ki))
            self.iterm += (error * timeDelta * (1/self.ki))
            dErr = (error - self.lastErr) / timeDelta
            output = self.kp * error + self.iterm + self.kd * dErr
            output = sorted([-1 * window_size, output, window_size])[1]
            out4logs = output
            output = float(output / window_size)
            
        self.lastErr = error
        self.lastNow = now

        # no active cooling
        if output < 0:
            output = 0

        self.pidstats = {
            'time': time.mktime(now.timetuple()),
            'timeDelta': timeDelta,
            'setpoint': setpoint,
            'ispoint': ispoint,
            'err': error,
            'errDelta': dErr,
            'p': self.kp * error,
            'i': self.iterm,
            'd': self.kd * dErr,
            'kp': self.kp,
            'ki': self.ki,
            'kd': self.kd,
            'pid': out4logs,
            'out': output,
        }

        return output
