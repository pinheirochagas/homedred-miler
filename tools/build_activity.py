#!/usr/bin/env python3
"""Convert the race FIT file into a compact browser-ready activity track."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

try:
    import fitdecode
except ImportError as error:
    raise SystemExit("Install fitdecode first: python3 -m pip install fitdecode") from error


SEMICIRCLE_TO_DEGREES = 180 / 2**31
TRACK_COLUMNS = [
    "lon",
    "lat",
    "altitudeM",
    "distanceM",
    "elapsedS",
    "speedMps",
    "heartRateBpm",
    "powerW",
    "cadenceSpm",
    "temperatureC",
    "verticalOscillationMm",
    "groundContactMs",
    "verticalRatioPct",
    "strideLengthMm",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iso_utc(value: dt.datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def utc(value: dt.datetime | None) -> dt.datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def rounded(value, digits: int = 0):
    if value is None:
        return None
    return round(value, digits)


def fit_value(frame, field):
    try:
        return frame.get_value(field)
    except KeyError:
        return None


def movement_mode(record: dict) -> str:
    speed = record["speed"] or 0
    cadence = record["cadence"] or 0
    if speed < 0.25:
        return "stand"
    if cadence >= 130 or speed >= 1.7:
        return "run"
    return "walk"


def derive_movement(sampled: list[dict], start: dt.datetime, finish: dt.datetime) -> list[list]:
    raw_modes = [movement_mode(record) for record in sampled]
    modes = []
    priority = ("run", "walk", "stand")
    for index, current in enumerate(raw_modes):
        window = raw_modes[max(0, index - 2):min(len(raw_modes), index + 3)]
        counts = {mode: window.count(mode) for mode in priority}
        most_common = max(counts.values())
        modes.append(
            current
            if counts[current] == most_common
            else next(mode for mode in priority if counts[mode] == most_common)
        )

    movement = []
    segment_mode = modes[0]
    segment_start = 0
    for index in range(1, len(sampled)):
        if modes[index] == segment_mode:
            continue
        segment_end = round((sampled[index]["time"] - start).total_seconds())
        if segment_end > segment_start:
            movement.append([segment_start, segment_end, segment_mode])
        segment_start = segment_end
        segment_mode = modes[index]
    finish_elapsed = round((finish - start).total_seconds())
    if finish_elapsed > segment_start:
        movement.append([segment_start, finish_elapsed, segment_mode])
    return movement


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fit", type=Path, default=Path("activity/Homedred_Miler.fit"))
    parser.add_argument(
        "--output", type=Path, default=Path("app/src/data/activity.json")
    )
    parser.add_argument("--sample-seconds", type=float, default=5)
    args = parser.parse_args()

    records = []
    session = None
    zones = None
    pending_climb = None
    climbs = []
    off_course_starts = []
    off_course_messages = []
    with fitdecode.FitReader(str(args.fit)) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name == "session":
                session = frame
                continue
            if frame.name == "time_in_zone" and fit_value(frame, "reference_mesg") == "session":
                zones = {
                    "heartRateHighBpm": list(fit_value(frame, "hr_zone_high_boundary") or ()),
                    "heartRateSeconds": list(fit_value(frame, "time_in_hr_zone") or ()),
                    "powerHighW": list(fit_value(frame, "power_zone_high_boundary") or ()),
                    "powerSeconds": list(fit_value(frame, "time_in_power_zone") or ()),
                    "maxHeartRateBpm": fit_value(frame, "max_heart_rate"),
                    "restingHeartRateBpm": fit_value(frame, "resting_heart_rate"),
                    "thresholdHeartRateBpm": fit_value(frame, "threshold_heart_rate"),
                    "functionalThresholdPowerW": fit_value(frame, "functional_threshold_power"),
                }
                continue
            if frame.name == "climb_pro":
                number = fit_value(frame, "climb_number")
                event = fit_value(frame, "climb_pro_event")
                distance = fit_value(frame, "current_dist")
                if number is None or distance is None:
                    continue
                climb = {
                    "distanceM": distance,
                    "category": fit_value(frame, "climb_category") or 0,
                }
                if event == "start":
                    pending_climb = climb
                elif event == "complete" and pending_climb:
                    climbs.append(
                        [
                            rounded(pending_climb["distanceM"], 1),
                            rounded(distance, 1),
                            max(pending_climb["category"], climb["category"]),
                        ]
                    )
                    pending_climb = None
                continue
            if frame.name == "event" and fit_value(frame, "event") == "off_course":
                timestamp = utc(fit_value(frame, "timestamp"))
                event_type = fit_value(frame, "event_type")
                if timestamp is None:
                    continue
                if event_type == "start":
                    off_course_starts.append(timestamp)
                elif event_type == "stop" and off_course_starts:
                    off_course_messages.append((off_course_starts.pop(), timestamp))
                continue
            if frame.name != "record":
                continue
            timestamp = utc(frame.get_value("timestamp"))
            lat = frame.get_value("position_lat")
            lon = frame.get_value("position_long")
            altitude = frame.get_value("enhanced_altitude")
            distance = frame.get_value("distance")
            if None in (timestamp, lat, lon, altitude, distance):
                continue
            cadence = fit_value(frame, "cadence")
            fractional_cadence = fit_value(frame, "fractional_cadence") or 0
            records.append(
                {
                    "time": timestamp,
                    "lat": lat * SEMICIRCLE_TO_DEGREES,
                    "lon": lon * SEMICIRCLE_TO_DEGREES,
                    "altitude": altitude,
                    "distance": distance,
                    "speed": fit_value(frame, "enhanced_speed"),
                    "heart_rate": fit_value(frame, "heart_rate"),
                    "power": fit_value(frame, "power"),
                    "cadence": (
                        (cadence + fractional_cadence) * 2
                        if cadence is not None
                        else None
                    ),
                    "temperature": fit_value(frame, "temperature"),
                    "vertical_oscillation": fit_value(frame, "vertical_oscillation"),
                    "ground_contact": fit_value(frame, "stance_time"),
                    "vertical_ratio": fit_value(frame, "vertical_ratio"),
                    "stride_length": fit_value(frame, "step_length"),
                }
            )

    if not records or session is None:
        raise SystemExit("FIT file has no usable session and track records")

    sampled = [records[0]]
    last_elapsed = 0.0
    start = records[0]["time"]
    for record in records[1:-1]:
        elapsed = (record["time"] - start).total_seconds()
        if elapsed - last_elapsed < args.sample_seconds:
            continue
        sampled.append(record)
        last_elapsed = elapsed
    sampled.append(records[-1])

    finish = records[-1]["time"]
    movement = derive_movement(sampled, start, finish)

    off_course = []
    for event_start, event_end in off_course_messages:
        start_elapsed = max(0, (event_start - start).total_seconds())
        end_elapsed = min((finish - start).total_seconds(), (event_end - start).total_seconds())
        if end_elapsed > start_elapsed:
            off_course.append([round(start_elapsed), round(end_elapsed)])

    fractional_ascent = session.get_value("total_fractional_ascent") or 0
    fractional_descent = session.get_value("total_fractional_descent") or 0
    fractional_cadence = session.get_value("avg_fractional_cadence") or 0
    cadence = session.get_value("avg_running_cadence")
    summary = {
        "name": "Homedred Miler",
        "sport": session.get_value("sport_profile_name") or "Trail Run",
        "startAt": iso_utc(records[0]["time"]),
        "finishAt": iso_utc(records[-1]["time"]),
        "distanceM": round(session.get_value("total_distance"), 1),
        "elapsedS": round(session.get_value("total_elapsed_time"), 3),
        "movingS": round(session.get_value("total_timer_time"), 3),
        "elevationGainM": round(
            (session.get_value("total_ascent") or 0) + fractional_ascent, 2
        ),
        "elevationLossM": round(
            (session.get_value("total_descent") or 0) + fractional_descent, 2
        ),
        "calories": session.get_value("total_calories"),
        "avgHeartRate": session.get_value("avg_heart_rate"),
        "maxHeartRate": session.get_value("max_heart_rate"),
        "avgPower": session.get_value("avg_power"),
        "maxPower": session.get_value("max_power"),
        "avgCadenceSpm": (
            round((cadence + fractional_cadence) * 2, 1)
            if cadence is not None
            else None
        ),
        "avgSpeedMps": session.get_value("enhanced_avg_speed"),
        "maxSpeedMps": session.get_value("enhanced_max_speed"),
        "avgTemperatureC": session.get_value("avg_temperature"),
        "minTemperatureC": session.get_value("min_temperature"),
        "maxTemperatureC": session.get_value("max_temperature"),
        "normalizedPower": session.get_value("normalized_power"),
        "trainingEffect": session.get_value("total_training_effect"),
        "anaerobicTrainingEffect": session.get_value("total_anaerobic_training_effect"),
        "totalWorkJ": session.get_value("total_work"),
        "totalStrides": session.get_value("total_strides"),
        "avgVerticalOscillationMm": session.get_value("avg_vertical_oscillation"),
        "avgGroundContactMs": session.get_value("avg_stance_time"),
        "avgVerticalRatioPct": session.get_value("avg_vertical_ratio"),
        "avgStrideLengthMm": session.get_value("avg_step_length"),
        "minAltitudeM": round(min(record["altitude"] for record in records), 1),
        "maxAltitudeM": round(max(record["altitude"] for record in records), 1),
    }
    track = [
        [
            round(record["lon"], 6),
            round(record["lat"], 6),
            round(record["altitude"], 1),
            round(record["distance"], 1),
            round((record["time"] - start).total_seconds()),
            rounded(record["speed"], 3),
            rounded(record["heart_rate"]),
            rounded(record["power"]),
            rounded(record["cadence"], 1),
            rounded(record["temperature"]),
            rounded(record["vertical_oscillation"], 1),
            rounded(record["ground_contact"], 1),
            rounded(record["vertical_ratio"], 2),
            rounded(record["stride_length"], 1),
        ]
        for record in sampled
    ]
    payload = {
        "source": str(args.fit),
        "sourceHash": sha256(args.fit),
        "sampleIntervalS": args.sample_seconds,
        "sourceRecordCount": len(records),
        "trackColumns": TRACK_COLUMNS,
        "summary": summary,
        "track": track,
        "zones": zones or {},
        "events": {
            "climbs": sorted(climbs, key=lambda item: item[0]),
            "movement": movement,
            "offCourse": off_course,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(
        f"wrote {args.output}: {len(track)} of {len(records)} track points, "
        f"{summary['distanceM'] / 1609.344:.2f} mi"
    )


if __name__ == "__main__":
    main()
