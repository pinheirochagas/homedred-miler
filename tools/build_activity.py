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
    with fitdecode.FitReader(str(args.fit)) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name == "session":
                session = frame
                continue
            if frame.name != "record":
                continue
            timestamp = frame.get_value("timestamp")
            lat = frame.get_value("position_lat")
            lon = frame.get_value("position_long")
            altitude = frame.get_value("enhanced_altitude")
            distance = frame.get_value("distance")
            if None in (timestamp, lat, lon, altitude, distance):
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=dt.timezone.utc)
            records.append(
                {
                    "time": timestamp,
                    "lat": lat * SEMICIRCLE_TO_DEGREES,
                    "lon": lon * SEMICIRCLE_TO_DEGREES,
                    "altitude": altitude,
                    "distance": distance,
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
        ]
        for record in sampled
    ]
    payload = {
        "source": str(args.fit),
        "sourceHash": sha256(args.fit),
        "sampleIntervalS": args.sample_seconds,
        "sourceRecordCount": len(records),
        "summary": summary,
        "track": track,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(
        f"wrote {args.output}: {len(track)} of {len(records)} track points, "
        f"{summary['distanceM'] / 1609.344:.2f} mi"
    )


if __name__ == "__main__":
    main()
